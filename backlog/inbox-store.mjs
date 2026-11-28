// The inbox store: a private git repo holding the inbox files (`<project>.md`), in the
// trunk inbox's format, so format.mjs's parsers and inbox-edit.mjs serve both. This
// module is the only code that knows the repo's clone and the only one that runs git
// in it; every other file asks it. It never touches a project's checkout.
//
// The clone is bare, one per repo URL, under ~/.risa/inbox-store/ (RISA_INBOX_STORE
// names another folder), made on first use. It reads and writes the remote's BRANCH
// through its remote-tracking ref: a read shows the file at that ref; a write builds
// a commit on the ref's tip from a temporary index, changing only its file, and
// pushes it without force. A refused push is fetched and rebuilt on the new tip,
// TRIES times in all; then it fails and nothing was written.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MACHINE_DIR } from "../loops/machine.mjs";

/** Pushes tried before a write gives up. */
export const TRIES = 5;
/** The store's one branch. */
export const BRANCH = "main";
const REMOTE = "origin";
const TRACKING = `refs/remotes/${REMOTE}/${BRANCH}`;
const GIT_TIMEOUT_MS = 120_000;

/** A store that can't be cloned, fetched for a write, or pushed to. */
export class StoreError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "StoreError";
  }
}

/**
 * The folder the clones are in: RISA_INBOX_STORE, else ~/.risa/inbox-store.
 * @param {Record<string, string | undefined>} [env]
 */
export const storeRoot = (env = process.env) =>
  env.RISA_INBOX_STORE || join(env.HOME || homedir(), MACHINE_DIR, "inbox-store");

/**
 * The clone's folder name for a repo URL: its host and path, one safe name
 * (git@github.com:me/ideas.git → github.com-me-ideas).
 * @param {string} repo
 */
export const cloneName = (repo) =>
  repo
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/\.git\/?$/, "")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "") || "store";

/**
 * The store for a git URL.
 * @param {string} repo the store repo's URL (a config's `inbox.repo`)
 * @param {{ env?: Record<string, string | undefined> }} [opts]
 */
export function storeFor(repo, { env = process.env } = {}) {
  const dir = join(storeRoot(env), cloneName(repo));
  /** git in the clone, its output untouched. */
  const run = (
    args,
    { input, extraEnv } = /** @type {{ input?: string, extraEnv?: Record<string, string> }} */ ({}),
  ) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      input,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    });
  const tryRun = (args) => {
    try {
      return run(args).trim();
    } catch {
      return null;
    }
  };

  /** Makes the clone when there is none: a bare repo with the URL as its remote. */
  const ensure = () => {
    if (existsSync(join(dir, "HEAD"))) return;
    mkdirSync(dir, { recursive: true });
    try {
      execFileSync("git", ["init", "-q", "--bare", dir], { stdio: "pipe" });
      run(["remote", "add", REMOTE, repo]);
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw new StoreError(
        `couldn't make the inbox store's clone at ${dir}: ${e instanceof Error ? e.message : e}`,
      );
    }
  };
  /** Fetches the branch; false when the remote can't be reached. An empty remote fetches fine. */
  const fetch = () => {
    if (tryRun(["fetch", "--quiet", REMOTE, `+refs/heads/${BRANCH}:${TRACKING}`]) !== null) return true;
    // An empty repo (no branch yet) is reachable: ls-remote answers.
    return tryRun(["ls-remote", "--quiet", REMOTE]) === "";
  };
  const tip = () => tryRun(["rev-parse", "--verify", "--quiet", TRACKING]) || null;
  /** The file at a commit, or null. */
  const show = (rev, file) => {
    if (!rev) return null;
    try {
      return run(["show", `${rev}:${file}`]);
    } catch {
      return null;
    }
  };

  return {
    repo,
    /** The clone's folder. */
    dir,
    /**
     * The file's text at the store's tip, or null when there is no such file. Fetches
     * first, best effort (offline: the last fetched copy); `fetch: false` reads that
     * copy with no network.
     * @param {string} file a store file (risa.md)
     * @param {{ fetch?: boolean }} [opts]
     * @returns {string | null}
     */
    read(file, { fetch: doFetch = true } = {}) {
      checkFile(file);
      if (!existsSync(join(dir, "HEAD"))) {
        if (!doFetch) return null;
        ensure();
      }
      if (doFetch) fetch();
      return show(tip(), file);
    },
    /**
     * Applies EDIT to the tip's copy of FILE (null: no file yet) and pushes the result
     * as one commit changing only that file. Returns the commit, or null when the edit
     * changed nothing. Throws a StoreError when the store can't be fetched or after
     * TRIES refused pushes; nothing was written then. A throw from EDIT stops it.
     * @param {string} file
     * @param {(text: string | null) => string | null} edit
     * @param {string} message the commit message
     * @param {{ log?: (line: string) => void }} [opts]
     * @returns {string | null}
     */
    write(file, edit, message, { log = (line) => console.error(line) } = {}) {
      checkFile(file);
      ensure();
      const tmpIndex = join(dir, `inbox-store-index-${process.pid}`);
      try {
        for (let tries = 1; tries <= TRIES; tries++) {
          if (!fetch()) throw new StoreError(`couldn't fetch the inbox store (${repo}); nothing was written`);
          const base = tip();
          const text = show(base, file);
          const next = edit(text);
          if (next === text || next === null) return null;
          const extraEnv = { GIT_INDEX_FILE: tmpIndex };
          rmSync(tmpIndex, { force: true });
          if (base) run(["read-tree", base], { extraEnv });
          const blob = run(["hash-object", "-w", "--stdin"], { input: next }).trim();
          run(["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], { extraEnv });
          const tree = run(["write-tree"], { extraEnv }).trim();
          const commit = run(["commit-tree", tree, ...(base ? ["-p", base] : []), "-F", "-"], {
            input: message.endsWith("\n") ? message : `${message}\n`,
          }).trim();
          if (tryRun(["push", "--quiet", REMOTE, `${commit}:refs/heads/${BRANCH}`]) !== null) {
            tryRun(["update-ref", TRACKING, commit]);
            return commit;
          }
          if (tries < TRIES) log(`the inbox store moved; building the edit on its new tip`);
        }
      } finally {
        rmSync(tmpIndex, { force: true });
      }
      throw new StoreError(
        `the inbox store (${repo}) refused ${TRIES} pushes (it kept moving, or the push fails); nothing was written`,
      );
    },
  };
}

/** A store file is a name at the store's root (risa.md), never a path. @param {string} file */
function checkFile(file) {
  if (!/^[\w][\w.-]*$/.test(file)) throw new StoreError(`${file}: not a store file (a name like risa.md)`);
}
