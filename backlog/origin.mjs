// The origin writer: an edit of plans/inbox.md as a commit built on
// origin/dev's tip and pushed there (`backlog inbox add|move|edit|remove`). It reads
// and writes no working tree, index or HEAD: blobs, a tree from a temporary
// index, commit-tree, a push without force, and the remote-tracking ref.
//
//   1. fetch origin/dev;
//   2. under the backlog lock, when local dev is ahead of origin/dev by backlog
//      commits only (one parent, the Backlog-Tool: trailer, only the backlog
//      files), push local dev first (a fast-forward), so the inbox commit sits
//      on top of them and the pickup is a fast-forward. A commit of the user's
//      own is never pushed: the inbox commit then goes on origin/dev's tip;
//   3. apply the edit to origin/dev's copy (the edit also sees local dev's
//      committed copy, to know what `ingest` filed but hasn't pushed), commit
//      it on that tip, changing only the inbox, and push it to dev. A rejected
//      push is fetched and rebuilt on the new tip, TRIES times in all; then it
//      fails and nothing was written.
//
// The pickup (`prd dev-sync`) is the caller's, after this returns.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import * as amend from "./amend.mjs";
import { BacklogError } from "./format.mjs";

/** Pushes tried before the writer gives up. */
export const TRIES = 5;
const GIT_TIMEOUT_MS = 120_000;

/**
 * @typedef {{
 *   main: string,                  the main checkout (its object store and refs)
 *   gitDir: string,                its git dir, for the temporary index
 *   name: string,                  the project's name, which the temporary index carries
 *   remote: string, trunk: string, rel: string,
 *   backlogFiles: string[],        what a backlog commit may change
 *   withLock: <T>(fn: () => T) => T,
 *   message: import("./amend.mjs").Write,
 *   edit: (originText: string, localText: string | null) => string,
 *   precheck?: () => void,         after the first fetch, before anything is pushed (a throw stops it)
 *   log?: (line: string) => void,
 * }} OriginWrite
 */

/**
 * Push one inbox edit to origin/dev. Returns the pushed commit, or null when
 * the edit changed nothing.
 * @param {OriginWrite} o
 * @returns {{ commit: string | null, tries: number }}
 */
export function pushInboxEdit(o) {
  const log = o.log ?? ((line) => console.error(line));
  const git = (...args) => run(o.main, args).trim();
  const tryGit = (...args) => {
    try {
      return git(...args);
    } catch {
      return null;
    }
  };
  const tracking = `refs/remotes/${o.remote}/${o.trunk}`;
  const local = `refs/heads/${o.trunk}`;
  const fetch = () => {
    if (tryGit("fetch", "--quiet", o.remote, o.trunk) === null)
      throw new BacklogError(`couldn't fetch ${o.remote}/${o.trunk}; nothing was written`);
    if (!tryGit("rev-parse", "--verify", "--quiet", tracking))
      throw new BacklogError(`${o.remote} has no ${o.trunk}; nothing was written`);
  };
  /** Push `sha` to the remote's trunk, never forced; the tracking ref follows. */
  const push = (sha) => {
    if (tryGit("push", "--quiet", o.remote, `${sha}:refs/heads/${o.trunk}`) === null) return false;
    tryGit("update-ref", tracking, sha);
    return true;
  };
  const isBacklogCommit = (sha) => {
    const parents = git("rev-list", "--parents", "-n", "1", sha).split(" ").length - 1;
    if (parents !== 1) return false;
    if (!amend.parseMessage(run(o.main, ["log", "-1", "--format=%B", sha])).backlog) return false;
    const files = git("diff-tree", "--no-commit-id", "--name-only", "-r", sha).split("\n").filter(Boolean);
    return files.length > 0 && files.every((f) => o.backlogFiles.includes(f));
  };

  fetch();
  o.precheck?.();
  o.withLock(() => {
    const here = git("rev-parse", local);
    const there = git("rev-parse", tracking);
    if (here === there || tryGit("merge-base", "--is-ancestor", there, here) === null) return;
    const own = git("rev-list", `${there}..${here}`).split("\n").filter(Boolean);
    if (!own.every(isBacklogCommit))
      return log(`${o.trunk} has a commit of your own that isn't pushed: it stays yours to push`);
    if (push(here)) log(`pushed ${own.length} backlog commit(s) of ${o.trunk} first`);
  });

  const tmpIndex = join(o.gitDir, `${o.name}-inbox-index-${process.pid}`);
  try {
    for (let tries = 1; tries <= TRIES; tries++) {
      if (tries > 1) fetch();
      const tip = git("rev-parse", tracking);
      const text = show(o.main, tip, o.rel);
      if (text === null)
        throw new BacklogError(`${o.remote}/${o.trunk} has no ${o.rel}; nothing was written`);
      let next;
      try {
        next = o.edit(text, show(o.main, local, o.rel));
      } catch (e) {
        if (e instanceof BacklogError) throw new BacklogError(`${e.message}; nothing was written`);
        throw e;
      }
      if (next === text) return { commit: null, tries };
      const env = { GIT_INDEX_FILE: tmpIndex };
      run(o.main, ["read-tree", tip], { env });
      const blob = run(o.main, ["hash-object", "-w", "--stdin"], { input: next }).trim();
      run(o.main, ["update-index", "--add", "--cacheinfo", `100644,${blob},${o.rel}`], { env });
      const tree = run(o.main, ["write-tree"], { env }).trim();
      const commit = run(o.main, ["commit-tree", tree, "-p", tip, "-F", "-"], {
        input: amend.writeMessage(o.message),
      }).trim();
      if (push(commit)) return { commit, tries };
      if (tries < TRIES) log(`${o.remote}/${o.trunk} moved; building the edit on its new tip`);
    }
  } finally {
    rmSync(tmpIndex, { force: true });
  }
  throw new BacklogError(
    `${o.remote}/${o.trunk} refused ${TRIES} pushes (it kept moving, or the push fails); nothing was written`,
  );
}

/** A file at a commit, or null. */
function show(cwd, rev, rel) {
  try {
    return run(cwd, ["show", `${rev}:${rel}`]);
  } catch {
    return null;
  }
}

/** git with the output untouched, optional stdin and env. */
function run(
  cwd,
  args,
  { input, env } = /** @type {{ input?: string, env?: Record<string, string> }} */ ({}),
) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    input,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  });
}
