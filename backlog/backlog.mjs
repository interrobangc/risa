#!/usr/bin/env node
// The live backlog, on dev in the main checkout (the paths, the trunk, the ids'
// prefix and the PRD table's heading are the project config's; this repo's below):
//   plans/inbox.md    the user's plain list: bullets under headings, no fields
//   plans/backlog.md  the tracker: ids, status, PRD, owner, commit, notes
//
//   plans/backlog-archive.md  finished items, moved out by `archive`
//
// Anyone (the user, orchestrators, PRD-writing and slice agents) runs this from
// any worktree. Every write takes a lock, edits the main checkout's copies, and
// commits onto dev (as "chore(backlog): …") only what it changed: backlog.md
// always; the inbox only for `ingest` (and `archive`, which commits just its
// own removals, never the user's uncommitted lines); the archive for `archive`.
// Every write also recomputes the derived statuses from local refs (no fetch).
// So the list is live for everyone without merges. Reads show the main
// checkout's copy too.
//
// One command is one locked write and one commit, however many ids it takes
// (set, note, claim, release and done take several; the subject names them,
// shortened past three: "B-1, B-2, B-3 +2: note"). `claim` is all-or-nothing:
// if any id is another branch's (without --force), nothing is claimed.
//
// Every backlog commit ends with the trailer `Backlog-Tool: <command>` (and
// `Backlog-Ids: …`). A write amends dev's HEAD instead of adding a commit only
// when HEAD carries that trailer, changes only the backlog's files, has one
// parent, wasn't rewritten by hand (author and committer times match), is
// under 10 minutes old, isn't contained by any other ref (a prd/ branch that
// merged dev, origin/dev, a tag, a stash) or detached worktree, isn't an item's
// commit, and is still the HEAD read at the start of the write. Otherwise it
// makes a new commit. The amended commit's parent is HEAD's parent, its
// subject lists every id, its body keeps each write's lines, and the ref
// update still compares against the HEAD it read (backlog/amend.mjs).
//
//   backlog ingest                      file new inbox bullets (status inbox), tag them (B-n);
//                                            runs the pickup (prd dev-sync) first, outside the lock
//   backlog inbox                       show inbox bullets not filed yet (origin/dev's copy
//                                            merged with the working copy)
//   backlog inbox add <type> <text…> [--details TEXT] [--anyway]
//                                            a bullet at the end of the type's section, on origin/dev;
//                                            a look-alike (items, unfiled lines) stops it (exit 3)
//   backlog inbox move <words…> <type>  an unfiled bullet (its words must find one) to another
//                                            heading, on origin/dev; a filed one names its `set` line
//   backlog inbox edit <words…> --to TEXT [--details TEXT]
//                                            reword an unfiled bullet in place (--details replaces its
//                                            detail lines, "" drops them); a filed one is refused
//   backlog inbox remove <words…>       an unfiled bullet and its details out, on origin/dev;
//                                            a filed one is refused
//
// The inbox commands write through the origin writer (backlog/origin.mjs):
// a commit built on origin/dev's tip, changing only the inbox, pushed without
// force (retried on a new tip, five tries), touching no working tree, index or
// HEAD; unpushed backlog commits of local dev go first. Then the pickup, best
// effort: a busy main checkout only prints why it skipped. BACKLOG_PICKUP=off
// skips the pickup (tests).
//   backlog list [--all] [--prd P] [--status S] [--type T] [--owner O] [--json]
//   backlog show B-n                    finds archived items too (list --all lists them)
//   backlog similar <text…>             open and archived items that look like it (read only)
//   backlog add <type> <title…> [--prd P] [--status S] [--note TEXT] [--anyway]
//                                            a look-alike prints it and files nothing (exit 3)
//                                            unless --anyway; ingest always files, and notes them
//   backlog set B-n… key=value… [--archived]   keys: status type title prd owner commit
//   backlog note B-n [B-n…] <text…> [--archived]   ids after the first need the B- prefix
//                                            --archived: change archived items in place (they stay archived)
//   backlog claim B-n… [--as OWNER] [--force]   owner defaults to your branch
//   backlog release B-n…
//   backlog done B-n… [--commit SHA]    work merged into its PRD branch (default: your HEAD)
//   backlog refresh [--no-fetch]        write the derived statuses (landed, staging, live)
//   backlog commit [message]            commit hand edits of the files (backlog.md normalised)
//   backlog doctor [--fix]              check the backlog; exit 1 on findings; --fix the safe ones
//   backlog archive [B-n…]              move landed, staging, live and dropped items to the archive
//                                            (with ids only those; one that isn't finished refuses all)
//   backlog path
//   backlog ci-file [--push]            prd ci's filing: JSON findings on stdin, one
//                                            commit with scripts/ci/quarantine.txt (ci/filing.mjs)
//
// The PRD registry (the "## PRDs" table; row order is the priority; backlog/registry.mjs):
//   backlog prd list [--json]           each topic with its worked-out state (not the archived ones)
//   backlog prd show <topic> [--json]   one topic's row, archived or not
//   backlog prd add <topic> [--first|--last|--before T|--after T] [flags=… after=… hot=… notes=…]
//   backlog prd set <topic> flags=… after=… hot=… notes=…   comma-separated; — clears
//   backlog prd set <topic> flags+=hold | flags-=hold   adds or removes flags, keeping the others
//   backlog prd set <topic> flags+=hold why="<reason>"   a hold with its reason and today's date
//                                            (list prints it under the row); clearing the hold clears it
//   backlog prd move <topic> --first|--last|--before T|--after T
//   backlog prd archive                 move done rows (but one with a prd/ worktree) to the archive's
//                                            PRD table; the rows left drop them from After
//
// Env: BACKLOG_BY (who's writing; default your branch, or git user.name on dev),
// BACKLOG_BRANCH (default the config's trunk), BACKLOG_REMOTE (default origin).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as amend from "./amend.mjs";
import * as fmt from "./format.mjs";
import * as edits from "./inbox-edit.mjs";
import { withLock as withLockAt } from "./lock.mjs";
import { mergeInbox } from "./inbox-merge.mjs";
import { pushInboxEdit } from "./origin.mjs";
import * as reg from "./registry.mjs";
import { loadConfigOrExit, toolCmd } from "../loops/config.mjs";

const { config, path: CONFIG_FILE } = loadConfigOrExit("backlog");
const TRUNK = process.env.BACKLOG_BRANCH ?? config.branches.trunk;
const REMOTE = process.env.BACKLOG_REMOTE ?? "origin";
const REL = config.paths.backlog;
const INBOX_REL = config.paths.inbox;
const ARCHIVE_REL = config.paths.archive;
/** CI's quarantine list, which `ci-file` commits with the backlog (null: the project has none). */
const QUARANTINE_REL = config.paths.quarantine ?? null;
const PREFIX = config.branches.prefixes;
/** The lock and temporary files in the git dir carry the project's name. */
const NAME = config.name;
// Loaded only for ci-file: every other command works without ci/.
const filing = process.argv[2] === "ci-file" ? await import("../ci/filing.mjs") : null;

// A git child that stalls (seen once: hash-object waiting on stdin under heavy
// load) fails the write after this long instead of hanging it; the ref update
// is atomic, so a killed write leaves dev as it was.
const GIT_TIMEOUT_MS = 120_000;
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  }).trim();
const tryGit = (cwd, ...args) => {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
};

const here = process.cwd();
const mainCheckout = git(here, "worktree", "list", "--porcelain")
  .split("\n")[0]
  .replace(/^worktree /, "");
const file = join(mainCheckout, REL);
const inboxFile = join(mainCheckout, INBOX_REL);
const archiveFile = join(mainCheckout, ARCHIVE_REL);
const gitDir = resolve(mainCheckout, git(mainCheckout, "rev-parse", "--git-dir"));
const lockDir = join(
  resolve(mainCheckout, git(mainCheckout, "rev-parse", "--git-common-dir")),
  `${NAME}-backlog.lock`,
);

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const myBranch = () => tryGit(here, "branch", "--show-current") || "";
const who = () => {
  if (process.env.BACKLOG_BY) return process.env.BACKLOG_BY;
  const b = myBranch();
  return b && b !== TRUNK ? b : tryGit(here, "config", "user.name") || "unknown";
};

// ---- arguments ------------------------------------------------------------

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const flag = [
        "all",
        "anyway",
        "archived",
        "force",
        "no-fetch",
        "json",
        "fix",
        "first",
        "last",
        "push",
      ].includes(key);
      opts[key] = flag ? true : argv[++i];
      if (!flag && opts[key] === undefined) throw new fmt.BacklogError(`${a} needs a value`);
    } else pos.push(a);
  }
  return { pos, opts };
}

// ---- reading and writing --------------------------------------------------

/** git with the output untouched (file contents), optional stdin and env. */
const gitRaw = (cwd, args, { input, env } = {}) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    input,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  });
const headText = (rel) => {
  try {
    return gitRaw(mainCheckout, ["show", `HEAD:${rel}`]);
  } catch {
    return null;
  }
};
const readText = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);

/** @param {{ lenient?: boolean }} [opts] */
const read = (opts) => {
  if (!existsSync(file)) throw new fmt.BacklogError(`${file} doesn't exist (is dev checked out there?)`);
  return fmt.parse(readFileSync(file, "utf8"), opts);
};
/** The archive, or null when there's none yet. @param {{ lenient?: boolean }} [opts] */
const readArchive = (opts) => {
  const text = readText(archiveFile);
  return text === null ? null : fmt.parse(text, opts);
};

/** Run `fn` under the backlog lock (lock.mjs: a stale one is taken over under its guard, as lib.sh does). */
const withLock = (fn) => withLockAt(lockDir, fn, { Error: fmt.BacklogError });

/** Every file a backlog write commits. */
const BACKLOG_FILES = [REL, INBOX_REL, ARCHIVE_REL];

/**
 * What shouldAmend needs to know about `head`. `readHead` is the HEAD read at
 * the start of the write; `commits` are the items' commit fields.
 * @returns {Partial<import("./amend.mjs").AmendFacts>}
 */
function amendFacts(head, readHead, headRaw, commits) {
  const trailer = amend.parseMessage(headRaw).backlog;
  // Most HEADs fail the cheap guards; ask git nothing more then (missing facts mean a new commit).
  if (!trailer || head !== readHead) return { trailer, moved: head !== readHead };
  const [commitTime, authorTime, ...parents] = git(mainCheckout, "log", "-1", "--format=%ct %at %P", head)
    .split(" ")
    .filter(Boolean);
  const singleParent = parents.length === 1;
  const files = singleParent
    ? git(mainCheckout, "diff-tree", "--no-commit-id", "--name-only", "-r", parents[0], head)
        .split("\n")
        .filter(Boolean)
    : [];
  const otherRefs = git(mainCheckout, "for-each-ref", "--contains", head, "--format=%(refname)")
    .split("\n")
    .filter((r) => r && r !== `refs/heads/${TRUNK}`);
  const detachedHeads = git(mainCheckout, "worktree", "list", "--porcelain")
    .split(/\n\n+/)
    .filter((w) => /^detached$/m.test(w))
    .map((w) => /^HEAD ([0-9a-f]+)$/m.exec(w)?.[1])
    .filter(Boolean);
  const inDetached = detachedHeads.some(
    (sha) => tryGit(mainCheckout, "merge-base", "--is-ancestor", head, sha) !== null,
  );
  return {
    trailer,
    singleParent,
    onlyBacklogFiles: files.length > 0 && files.every((f) => BACKLOG_FILES.includes(f)),
    rewritten: commitTime !== authorTime,
    commitTime: Number(commitTime) * 1000,
    now: Date.now(),
    containedElsewhere: otherRefs.length > 0 || inDetached,
    moved: head !== readHead,
    referenced: commits.some((c) => /^[0-9a-f]{4,64}$/i.test(c) && head.startsWith(c.toLowerCase())),
  };
}

/**
 * Commit `contents` ({ path: text }) onto the main checkout's branch, and
 * nothing else: built in a temporary index from HEAD, so neither the dev
 * keeper's staged work nor their unstaged edits of these files go in. The
 * real index then gets the committed copies, so their own edits show as
 * unstaged changes on top. The commit amends HEAD when shouldAmend says so
 * (its parent is HEAD's parent), and is a new commit on HEAD otherwise;
 * either way the ref only moves if HEAD is still the commit built on.
 * Returns false when nothing changed.
 * @param {Record<string, string>} contents @param {import("./amend.mjs").Write} w
 * @param {string} readHead @param {string[]} commits
 */
function commitContents(contents, w, readHead, commits) {
  const head = git(mainCheckout, "rev-parse", "HEAD");
  const tmpIndex = join(gitDir, `${NAME}-backlog-index-${process.pid}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    gitRaw(mainCheckout, ["read-tree", "HEAD"], { env });
    const blobs = Object.entries(contents).map(([rel, text]) => {
      const blob = gitRaw(mainCheckout, ["hash-object", "-w", "--stdin"], { input: text }).trim();
      gitRaw(mainCheckout, ["update-index", "--add", "--cacheinfo", `100644,${blob},${rel}`], { env });
      return [rel, blob];
    });
    const tree = gitRaw(mainCheckout, ["write-tree"], { env }).trim();
    if (tree === git(mainCheckout, "rev-parse", "HEAD^{tree}")) return false;
    const headRaw = gitRaw(mainCheckout, ["log", "-1", "--format=%B", head]);
    // A commit carrying more than the backlog's files never folds into an earlier one.
    const onlyBacklog = Object.keys(contents).every((rel) => BACKLOG_FILES.includes(rel));
    const amending =
      onlyBacklog && amend.shouldAmend(amendFacts(head, readHead, headRaw, commits)) === "amend";
    const parent = amending ? git(mainCheckout, "rev-parse", `${head}^`) : head;
    const message = amending ? amend.amendedMessage(headRaw, w) : amend.writeMessage(w);
    const commit = gitRaw(mainCheckout, ["commit-tree", tree, "-p", parent, "-F", "-"], {
      input: message,
    }).trim();
    const subject = message.split("\n")[0];
    git(
      mainCheckout,
      "update-ref",
      "-m",
      `backlog: ${amending ? "amend " : ""}${subject}`,
      "HEAD",
      commit,
      head,
    );
    for (const [rel, blob] of blobs)
      git(mainCheckout, "update-index", "--add", "--cacheinfo", `100644,${blob},${rel}`);
    return true;
  } finally {
    rmSync(tmpIndex, { force: true });
  }
}

/**
 * @typedef {{
 *   inbox: { text: string | null, edit?: (text: string) => string, commitAsIs?: boolean },
 *   archive: () => import("./format.mjs").Backlog,
 *   commitHandEdits?: boolean,
 *   quarantine?: string | null,
 * }} WriteContext
 */

/**
 * Read, change, write and commit the backlog on dev in the main checkout.
 * `change(backlog, ctx)` edits the parsed backlog. Only what the command
 * changed is committed (plans/backlog.md always, normalised, with any hand
 * edits of it):
 *   - `ctx.inbox.text = …` (ingest): the new inbox is written and committed;
 *   - `ctx.inbox.edit = fn` (archive): fn is applied to the committed inbox
 *     and, separately, to the working copy, so the user's uncommitted lines
 *     stay uncommitted;
 *   - `ctx.archive()` returns the archive (created if missing) to change;
 *   - `ctx.commitHandEdits` (the `commit` command): every file as it is.
 * Every write then recomputes derived statuses from local refs (no fetch).
 * `tool` is the command (the trailer); `describe` gives the ids it covered
 * and the subject's text, or is a function of `change`'s result that does.
 * @typedef {{ ids: string[], text: string }} Describe
 * @param {string} tool
 * @param {Describe | ((result: any) => Describe)} describe
 * @param {(b: import("./format.mjs").Backlog, ctx: WriteContext) => any} change
 * @param {{ lenient?: boolean, afterCommit?: (committed: boolean) => void }} [opts]
 */
function write(tool, describe, change, opts = {}) {
  return withLock(() => {
    const readHead = git(mainCheckout, "rev-parse", "HEAD");
    const branch = git(mainCheckout, "branch", "--show-current");
    if (branch !== TRUNK)
      throw new fmt.BacklogError(
        `the main checkout is on "${branch}", not ${TRUNK}; the backlog lives on ${TRUNK}`,
      );
    if (existsSync(join(gitDir, "MERGE_HEAD")))
      throw new fmt.BacklogError("the main checkout is in the middle of a merge; try again when it's done");

    const b = read(opts);
    const workingInbox = readText(inboxFile);
    const archiveBefore = readText(archiveFile);
    /** @type {import("./format.mjs").Backlog | null} */
    let archive = null;
    const loadArchive = () =>
      (archive ??=
        archiveBefore === null
          ? { preamble: fmt.ARCHIVE_PREAMBLE, items: [] }
          : fmt.parse(archiveBefore, opts));
    // Ids that are taken without being items here: archived ones, and inbox tags.
    b.archived =
      archiveBefore === null ? [] : fmt.parse(archiveBefore, { lenient: true }).items.map((i) => i.id);
    b.reserved = [
      ...b.archived,
      ...(workingInbox === null ? [] : fmt.parseInbox(workingInbox).flatMap((e) => (e.id ? [e.id] : []))),
    ];

    /** @type {WriteContext} */
    const ctx = { inbox: { text: workingInbox }, archive: loadArchive };
    const result = change(b, ctx);
    const refreshed = refreshStatuses(b);

    /** What to write to disk, and what to commit (they differ only for an inbox edit). */
    const disk = { [REL]: fmt.render(b) };
    const commit = { [REL]: disk[REL] };
    if (ctx.inbox.edit) {
      const committed = headText(INBOX_REL);
      if (workingInbox !== null) disk[INBOX_REL] = ctx.inbox.edit(workingInbox);
      if (committed !== null) commit[INBOX_REL] = ctx.inbox.edit(committed);
    } else if (ctx.inbox.text !== workingInbox && ctx.inbox.text !== null) {
      disk[INBOX_REL] = commit[INBOX_REL] = ctx.inbox.text;
    } else if (ctx.commitHandEdits && workingInbox !== null) {
      commit[INBOX_REL] = workingInbox;
    }
    if (archive) disk[ARCHIVE_REL] = commit[ARCHIVE_REL] = fmt.render(archive);
    else if (ctx.commitHandEdits && archiveBefore !== null) commit[ARCHIVE_REL] = archiveBefore;

    // Hand edits that go in with this commit: the working copy differed from HEAD.
    const before = {
      [REL]: readFileSync(file, "utf8"),
      [INBOX_REL]: workingInbox,
      [ARCHIVE_REL]: archiveBefore,
    };
    const handEdited = Object.keys(commit).filter(
      (rel) =>
        !(rel === INBOX_REL && ctx.inbox.edit) && before[rel] !== null && before[rel] !== headText(rel),
    );

    // The quarantine: committed from HEAD's copy; the working copy follows unless it has hand edits.
    if (QUARANTINE_REL && typeof ctx.quarantine === "string" && ctx.quarantine !== headText(QUARANTINE_REL)) {
      commit[QUARANTINE_REL] = ctx.quarantine;
      if (readText(join(mainCheckout, QUARANTINE_REL)) === headText(QUARANTINE_REL))
        disk[QUARANTINE_REL] = ctx.quarantine;
    }

    for (const [rel, text] of Object.entries(disk)) writeFileSync(join(mainCheckout, rel), text);
    const { ids: covered, text } = typeof describe === "function" ? describe(result) : describe;
    const lines = [
      `By: ${who()}`,
      ...(handEdited.length ? [`Includes uncommitted hand edits of ${handEdited.join(" and ")}.`] : []),
      ...(refreshed.length ? [`Statuses from git: ${refreshed.join(", ")}.`] : []),
    ];
    const commits = [...b.items, ...(archive?.items ?? [])].map((i) => i.commit).filter(Boolean);
    const committed = commitContents(commit, { tool, ids: covered, text, lines }, readHead, commits);
    opts.afterCommit?.(committed);
    return result;
  });
}

/** `add` stopped on look-alikes: nothing was filed (exit 3). */
class LookAlikeStop extends Error {
  /** @param {ReturnType<typeof fmt.similarItems>} matches */
  constructor(matches) {
    super("look-alikes");
    this.matches = matches;
  }
}

/**
 * Open and archived items to compare a new line with, each with its status
 * from git.
 * @param {import("./format.mjs").Item[]} items
 */
function similarPool(items) {
  const archived = readArchive({ lenient: true })?.items ?? [];
  const status = containment(false);
  status.prime([...items, ...archived]);
  return [
    ...items.map((i) => ({ ...i, status: status(i) })),
    ...archived.map((i) => ({ ...i, status: status(i), archived: true })),
  ];
}

/**
 * File every new inbox bullet as a tracker item (status inbox) and tag it with
 * its id. A line is always filed; one with look-alikes gets a note naming them.
 */
function ingest(b, inbox) {
  /** @type {{ item: import("./format.mjs").Item, similar: ReturnType<typeof fmt.similarItems> }[]} */
  const filed = [];
  if (inbox.text === null) return filed;
  const ctx = { by: who(), date: today() };
  const pool = similarPool(b.items);
  // In file order. Tagging only appends to a line, so line numbers never shift.
  for (const e of fmt.newInboxEntries(inbox.text)) {
    const title = fmt.titleFromBullet(e.text);
    const asked = [title !== e.text.replace(/\s+/g, " ").trim() ? e.text : "", e.details]
      .filter(Boolean)
      .join("\n");
    const similar = fmt.similarItems(e.text, pool);
    const it = fmt.add(b, { type: e.type, title, status: "inbox", ...ctx });
    if (asked) fmt.addNote(it, { text: `From the inbox: ${asked.replace(/\n/g, " / ")}`, ...ctx });
    if (similar.length)
      fmt.addNote(it, {
        text: `Looks like: ${similar.map((m) => `${m.id} (${m.status}${m.archived ? ", archived" : ""}) ${m.title}`).join("; ")}`,
        ...ctx,
      });
    inbox.text = fmt.tagInboxLine(inbox.text, e.line, it.id);
    pool.push({ ...it });
    filed.push({ item: it, similar });
  }
  return filed;
}

// ---- the inbox on origin/dev ----------------------------------------------

/** The main checkout of the repo DIR is in (its first worktree), or null outside one. */
const mainOf = (dir) =>
  tryGit(dir, "worktree", "list", "--porcelain")
    ?.split("\n")[0]
    .replace(/^worktree /, "") || null;
/** Whether two paths name one folder (both real paths), false when either is missing. */
const sameDir = (a, b) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

/**
 * The pickup: `prd dev-sync` (loops/lib.sh), best effort. Its
 * output goes to stderr; a refusal (the checkout off dev, mid-merge, other
 * edits in the way) prints why it skipped, and the command carries on. lib.sh
 * may live anywhere (a release install, `~/.risa/releases/<tag>/`, is a worktree
 * of Risa's own repo): it runs on this command's project, the main checkout the
 * current directory is in, and only when the project's config (the file this
 * command loaded, RISA_CONFIG's) is in that checkout and RISA_MAIN, when set,
 * names it, so a run against another repository never moves this one's dev.
 * lib.sh finds its repo from that checkout (find_repo, as `risa` does) and reads
 * that config.
 * @param {string} why
 */
function pickup(why) {
  if (process.env.BACKLOG_PICKUP === "off") return;
  const lib = fileURLToPath(new URL("../loops/lib.sh", import.meta.url));
  const skip = (reason) => console.error(`pickup skipped: ${reason}`);
  if (!existsSync(lib)) return skip(`no ${lib}`);
  const configMain = mainOf(dirname(CONFIG_FILE));
  if (!configMain || !sameDir(configMain, mainCheckout))
    return skip(`the config ${CONFIG_FILE} belongs to another checkout than ${mainCheckout}`);
  const pinned = process.env.RISA_MAIN;
  if (pinned && !sameDir(mainOf(pinned) ?? pinned, mainCheckout))
    return skip(`RISA_MAIN (${pinned}) names another checkout than ${mainCheckout}`);
  if (REMOTE !== "origin") return skip(`dev-sync works with origin, not ${REMOTE}`);
  if (tryGit(mainCheckout, "remote", "get-url", REMOTE) === null) return skip(`no ${REMOTE} remote`);
  const script = [
    'source "$0" || exit 1',
    'find_repo "$1" && [[ $main -ef $1 ]] || die "dev-sync: lib.sh found $main, not $1"',
    'dev_sync "$2"',
  ].join("\n");
  const env = { ...process.env, TRUNK, RISA_CONFIG: CONFIG_FILE, RISA_MAIN: mainCheckout };
  delete env.RISA_CONFIG_FOUND; // a pin: lib.sh's find_repo keeps it
  const r = spawnSync("bash", ["-c", script, lib, mainCheckout, why], {
    cwd: mainCheckout,
    encoding: "utf8",
    env,
    timeout: GIT_TIMEOUT_MS,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (r.status === 0) {
    if (out) console.error(out);
    return;
  }
  skip(out.split("\n").at(-1) || `dev-sync exited ${r.status ?? r.signal}`);
}

/** A file at a revision of the main checkout, or null. */
const showAt = (rev, rel) => {
  try {
    return gitRaw(mainCheckout, ["show", `${rev}:${rel}`]);
  } catch {
    return null;
  }
};

/**
 * The inbox as it stands: origin/dev's copy merged with the working copy (on
 * their merge base), or the working copy alone with no origin/dev.
 * `fetch`: fetch first, best effort.
 */
function mergedInbox(fetch) {
  const working = readText(inboxFile);
  const tracking = `refs/remotes/${REMOTE}/${TRUNK}`;
  if (fetch && tryGit(mainCheckout, "remote", "get-url", REMOTE) !== null)
    if (tryGit(mainCheckout, "fetch", "--quiet", REMOTE, TRUNK) === null)
      console.error(`couldn't fetch ${REMOTE}/${TRUNK}: its last fetched copy is used`);
  const theirs = showAt(tracking, INBOX_REL);
  if (theirs === null) return working;
  if (working === null) return theirs;
  const base = tryGit(mainCheckout, "merge-base", `refs/heads/${TRUNK}`, tracking);
  return mergeInbox((base && showAt(base, INBOX_REL)) ?? "", working, theirs).text;
}

/** A look-alike as a line: an item, or an unfiled inbox line. */
const lookAlikeLine = (m) => (m.id === "inbox" ? `unfiled inbox line  ${m.title}` : fmt.similarLine(m));

/** The writer's fixed parts, for one inbox command. */
const originWrite = () => ({
  main: mainCheckout,
  gitDir,
  remote: REMOTE,
  trunk: TRUNK,
  rel: INBOX_REL,
  name: NAME,
  backlogFiles: BACKLOG_FILES,
  withLock,
});

const sayPushed = (commit) => `on ${REMOTE}/${TRUNK} as ${commit.slice(0, 7)}`;

/** `inbox add <type> <text…> [--details TEXT] [--anyway]`. */
function inboxAdd(args, opts) {
  const [type, ...words] = args;
  const text = words.join(" ");
  if (!type || !text.trim()) throw new fmt.BacklogError("usage: inbox add <type> <text…> [--details TEXT]");
  fmt.checkType(type);
  const details = typeof opts.details === "string" ? opts.details : "";
  edits.addEntry("", type, text, details); // a bad line fails here, before any network
  const { commit } = pushInboxEdit({
    ...originWrite(),
    message: {
      tool: "inbox add",
      ids: [],
      text: `inbox: add (${type}) ${fmt.titleFromBullet(text)}`,
      lines: [`By: ${who()}`],
    },
    precheck: () => {
      if (opts.anyway) return;
      const merged = mergedInbox(false);
      const lines = merged === null ? [] : fmt.newInboxEntries(merged);
      const pool = [
        ...similarPool(read({ lenient: true }).items),
        ...lines.map((e) => ({ id: "inbox", status: "unfiled", prd: "", title: e.text })),
      ];
      const matches = fmt.similarItems(text, pool);
      if (matches.length) throw new LookAlikeStop(matches);
    },
    edit: (t) => edits.addEntry(t, type, text, details),
  });
  if (!commit) return console.log("nothing changed");
  const heading = edits.headingFor(showAt(commit, INBOX_REL) ?? "", type);
  console.log(`added under ${heading} ${sayPushed(commit)}: ${fmt.titleFromBullet(text)}`);
  pickup("an inbox push");
}

/**
 * The one unfiled bullet `words` find in `t` (origin/dev's inbox), for move,
 * edit and remove. A filed one (tagged on origin/dev, or only on local dev's
 * copy, `localText`) throws `filed(entry, id)`; none, or several, throw why.
 * @param {string} t @param {string | null} localText @param {string} words
 * @param {(e: import("./format.mjs").InboxEntry, id: string) => Error} filed
 */
function findUnfiled(t, localText, words, filed) {
  const key = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const local = localText === null ? [] : fmt.parseInbox(localText);
  const hits = edits.findEntries(t, words);
  if (!hits.length) {
    const there = localText === null ? [] : edits.findEntries(localText, words).filter((e) => e.id);
    if (there.length === 1) throw filed(there[0], /** @type {string} */ (there[0].id));
    const work = readText(inboxFile);
    if (work !== null && edits.findEntries(work, words).length)
      throw new fmt.BacklogError(
        `"${words}" is only in your uncommitted ${INBOX_REL}, not on ${REMOTE}/${TRUNK}: change it there by hand`,
      );
    throw new fmt.BacklogError(`no inbox line on ${REMOTE}/${TRUNK} has "${words}"`);
  }
  if (hits.length > 1)
    throw new fmt.BacklogError(
      `"${words}" is in ${hits.length} inbox lines (${hits.map((e) => `"${fmt.titleFromBullet(e.text)}"`).join(", ")}): give more of its words`,
    );
  const e = hits[0];
  if (e.id) throw filed(e, e.id);
  const tagged = local.find((l) => l.id && key(l.text) === key(e.text));
  if (tagged) throw filed(e, /** @type {string} */ (tagged.id));
  return e;
}

/** A filed line's refusal: `then` says what to do instead. */
const filedAs = (/** @type {{ text: string }} */ e, /** @type {string} */ id, /** @type {string} */ then) =>
  new fmt.BacklogError(`"${fmt.titleFromBullet(e.text)}" is filed as ${id}: ${then}`);

/** `inbox move <words…> <type>`. */
function inboxMove(args) {
  const type = args.at(-1);
  const words = args.slice(0, -1).join(" ");
  if (!type || !words.trim()) throw new fmt.BacklogError("usage: inbox move <words…> <type>");
  fmt.checkType(type);
  /** @type {{ text: string, from: string } | null} */
  let moved = null;
  const { commit } = pushInboxEdit({
    ...originWrite(),
    message: {
      tool: "inbox move",
      ids: [],
      text: `inbox: move "${fmt.titleFromBullet(words)}" to ${type}`,
      lines: [`By: ${who()}`],
    },
    edit: (t, localText) => {
      moved = null;
      const e = findUnfiled(t, localText, words, (x, id) =>
        filedAs(x, id, `change the item instead: ${toolCmd.backlog} set ${id} type=${type}`),
      );
      if (e.type === type) return t;
      moved = { text: e.text, from: e.type };
      return edits.moveEntry(t, e.line, type);
    },
  });
  if (!commit || !moved) return console.log(`already under ${type}: nothing to move`);
  const heading = edits.headingFor(showAt(commit, INBOX_REL) ?? "", type);
  console.log(`moved to ${heading} ${sayPushed(commit)}: ${fmt.titleFromBullet(moved.text)}`);
  pickup("an inbox push");
}

/** `inbox edit <words…> --to TEXT [--details TEXT]`: reword an unfiled bullet in place. */
function inboxEdit(args, opts) {
  const words = args.join(" ");
  const to = typeof opts.to === "string" ? opts.to : undefined;
  const details = typeof opts.details === "string" ? opts.details : undefined;
  if (!words.trim() || (to === undefined && details === undefined))
    throw new fmt.BacklogError("usage: inbox edit <words…> --to TEXT [--details TEXT]");
  if (to !== undefined) edits.addEntry("", "bug", to); // a bad line fails here, before any network
  /** @type {{ was: string, now: string } | null} */
  let changed = null;
  const { commit } = pushInboxEdit({
    ...originWrite(),
    message: {
      tool: "inbox edit",
      ids: [],
      text: `inbox: edit "${fmt.titleFromBullet(words)}"`,
      lines: [`By: ${who()}`],
    },
    edit: (t, localText) => {
      changed = null;
      const e = findUnfiled(t, localText, words, (x, id) =>
        filedAs(x, id, "change the item instead, in the backlog session"),
      );
      const out = edits.rewordEntry(t, e.line, to ?? e.text, details);
      if (out !== t)
        changed = { was: e.text, now: to === undefined ? e.text : to.replace(/\s+/g, " ").trim() };
      return out;
    },
  });
  if (!commit || !changed) return console.log("the line already says that: nothing to change");
  const { was, now } = changed;
  console.log(
    `edited ${sayPushed(commit)}: ${was === now ? fmt.titleFromBullet(now) : `"${fmt.titleFromBullet(was)}" is now "${fmt.titleFromBullet(now)}"`}`,
  );
  pickup("an inbox push");
}

/** `inbox remove <words…>`: an unfiled bullet and its details. */
function inboxRemove(args) {
  const words = args.join(" ");
  if (!words.trim()) throw new fmt.BacklogError("usage: inbox remove <words…>");
  /** @type {string | null} */
  let removed = null;
  const { commit } = pushInboxEdit({
    ...originWrite(),
    message: {
      tool: "inbox remove",
      ids: [],
      text: `inbox: remove "${fmt.titleFromBullet(words)}"`,
      lines: [`By: ${who()}`],
    },
    edit: (t, localText) => {
      const e = findUnfiled(t, localText, words, (x, id) =>
        filedAs(x, id, "drop the item instead, in the backlog session"),
      );
      removed = e.text;
      return edits.removeEntry(t, e.line);
    },
  });
  if (!commit || removed === null) return console.log("nothing changed");
  console.log(`removed ${sayPushed(commit)}: ${fmt.titleFromBullet(removed)}`);
  pickup("an inbox push");
}

// ---- deriving statuses from git -------------------------------------------

/**
 * A function from an item to its status, worked out from which branches
 * contain its commit (`fetch` updates the remote copies first). Batched: one
 * `rev-list` per branch and one lookup for every commit, so a write stays fast.
 */
function containment(fetch) {
  if (fetch) tryGit(mainCheckout, "fetch", "--quiet", REMOTE, TRUNK, "staging", "main");
  const ref = (b) =>
    tryGit(mainCheckout, "rev-parse", "--verify", "--quiet", `refs/remotes/${REMOTE}/${b}`)
      ? `${REMOTE}/${b}`
      : b;
  const refs = { dev: TRUNK, staging: ref("staging"), main: ref("main") };
  /** @type {Record<string, Set<string>>} */
  const reach = {};
  const reachable = (r) => {
    if (!reach[r]) {
      let out = "";
      try {
        out = gitRaw(mainCheckout, ["rev-list", r, "--"]);
      } catch {
        // no such branch here: it contains nothing
      }
      reach[r] = new Set(out.split("\n").filter(Boolean));
    }
    return reach[r];
  };
  /** @type {Map<string, string | null>} short sha → full sha (null: not a commit here) */
  const full = new Map();
  const resolve = (shas) => {
    const todo = [...new Set(shas)].filter((s) => !full.has(s));
    if (!todo.length) return;
    const out = gitRaw(mainCheckout, ["cat-file", "--batch-check"], {
      input: todo.map((s) => `${s}^{commit}`).join("\n") + "\n",
    }).split("\n");
    todo.forEach((s, i) => {
      const m = /^([0-9a-f]{40,64}) commit /.exec(out[i] ?? "");
      full.set(s, m ? m[1] : null);
    });
  };
  const status = (it) => {
    if (!it.commit || !fmt.DERIVED.includes(it.status) || !/^[0-9a-f]{4,64}$/i.test(it.commit))
      return it.status;
    resolve([it.commit]);
    const sha = full.get(it.commit);
    if (!sha) return it.status;
    return fmt.derive(it, {
      dev: reachable(refs.dev).has(sha),
      staging: reachable(refs.staging).has(sha),
      main: reachable(refs.main).has(sha),
    });
  };
  /** Resolve every item's commit in one call before asking item by item. */
  status.prime = (items) =>
    resolve(
      items
        .filter((i) => i.commit && fmt.DERIVED.includes(i.status) && /^[0-9a-f]{4,64}$/i.test(i.commit))
        .map((i) => i.commit),
    );
  return status;
}

/** Set every item's derived status from local refs; returns "B-n a → b" for each change. */
function refreshStatuses(b, fetch = false) {
  const status = containment(fetch);
  status.prime(b.items);
  const moved = [];
  for (const it of b.items) {
    const s = status(it);
    if (s === it.status) continue;
    moved.push(`${it.id} ${it.status} → ${s}`);
    it.status = s;
  }
  return moved;
}

// ---- commands -------------------------------------------------------------

function list(opts) {
  const items = [
    ...read().items,
    ...(opts.all ? (readArchive()?.items ?? []).map((i) => ({ ...i, archived: true })) : []),
  ];
  const status = containment(false);
  status.prime(items);
  const rows = items
    .map((i) => ({ ...i, status: status(i) }))
    .filter((i) => opts.all || !["live", "dropped"].includes(i.status))
    .filter((i) => !opts.prd || i.prd === opts.prd)
    .filter((i) => !opts.status || i.status === opts.status)
    .filter((i) => !opts.type || i.type === opts.type)
    .filter((i) => !opts.owner || i.owner === opts.owner);
  if (opts.json) return console.log(JSON.stringify(rows.map(({ notes: _notes, ...r }) => r)));
  const w = (k, min) => Math.max(min, ...rows.map((r) => r[k].length));
  const ws = {
    id: w("id", 4),
    type: w("type", 4),
    status: w("status", 6),
    prd: w("prd", 3),
    owner: w("owner", 5),
  };
  const line = (r) =>
    [
      r.id.padEnd(ws.id),
      r.type.padEnd(ws.type),
      r.status.padEnd(ws.status),
      r.prd.padEnd(ws.prd),
      r.owner.padEnd(ws.owner),
      r.title,
    ].join("  ");
  console.log(line({ id: "ID", type: "TYPE", status: "STATUS", prd: "PRD", owner: "OWNER", title: "TITLE" }));
  for (const r of rows) console.log(line(r));
  if (!rows.length) console.log("(no items)");
}

function show(id) {
  let it;
  let archived = false;
  try {
    it = fmt.find(read(), id);
  } catch (e) {
    const archive = readArchive();
    if (!archive || !archive.items.some((i) => i.id === fmt.normId(id))) throw e;
    it = fmt.find(archive, id);
    archived = true;
  }
  const status = containment(false)(it);
  console.log(`${it.id} · ${it.type} · ${it.title}${archived ? ` (archived in ${ARCHIVE_REL})` : ""}`);
  for (const f of fmt.FIELDS)
    console.log(
      `  ${f}: ${f === "status" && status !== it.status ? `${status} (file says ${it.status})` : it[f]}`,
    );
  if (it.notes) console.log(`\n${it.notes}`);
}

/**
 * Move finished items (landed, staging, live, dropped, by their status from
 * git) to the archive with their notes, and their bullets out of the inbox.
 * With `wanted` ids, only those; one that isn't finished refuses them all.
 * @param {import("./format.mjs").Backlog} b @param {WriteContext} ctx @param {string[]} [wanted]
 */
function archiveFinished(b, ctx, wanted = []) {
  refreshStatuses(b);
  const named = wanted.map((id) => fmt.find(b, id));
  const open = named.filter((i) => !fmt.FINISHED.includes(i.status));
  if (open.length)
    throw new fmt.BacklogError(
      `${open.map((i) => `${i.id} is ${i.status}`).join(", ")}, not finished; nothing archived`,
    );
  const done = wanted.length ? named : b.items.filter((i) => fmt.FINISHED.includes(i.status));
  if (!done.length) return [];
  const archive = ctx.archive();
  for (const it of done) {
    if (archive.items.some((a) => a.id === it.id))
      throw new fmt.BacklogError(`${it.id} is already in ${ARCHIVE_REL} (run ${toolCmd.backlog} doctor)`);
    archive.items.push(it);
  }
  b.items = b.items.filter((i) => !done.includes(i));
  const gone = done.map((i) => i.id);
  ctx.inbox.edit = (text) => fmt.removeInboxEntries(text, gone);
  return done;
}

/**
 * Everything wrong with the backlog. Each finding is { id, problem, fixable }.
 * Fixable ones (stale statuses, the summary) are what any write repairs.
 */
function findings() {
  /** @type {{ id: string, problem: string, fixable: boolean }[]} */
  const out = [];
  const text = readFileSync(file, "utf8");
  const b = fmt.parse(text, { lenient: true });
  const archiveText = readText(archiveFile);
  const archive = archiveText === null ? null : fmt.parse(archiveText, { lenient: true });
  const archived = archive?.items ?? [];

  for (const id of fmt.duplicateIds(b.items))
    out.push({ id, problem: `appears more than once in ${REL}`, fixable: false });
  for (const id of fmt.duplicateIds(archived))
    out.push({ id, problem: `appears more than once in ${ARCHIVE_REL}`, fixable: false });
  const archivedIds = new Set(archived.map((i) => i.id));
  for (const it of b.items)
    if (archivedIds.has(it.id))
      out.push({ id: it.id, problem: `is in both ${REL} and ${ARCHIVE_REL}`, fixable: false });

  // Inbox tags: each must name an item that came from that bullet, once.
  const inboxText = readText(inboxFile);
  if (inboxText !== null) {
    const all = [...b.items, ...archived];
    const tagged = new Map();
    for (const e of fmt.parseInbox(inboxText)) {
      if (!e.id) continue;
      const where = `inbox line ${e.line + 1} ("${fmt.titleFromBullet(e.text).slice(0, 60)}")`;
      if (tagged.has(e.id))
        out.push({
          id: e.id,
          problem: `tags both inbox lines ${tagged.get(e.id)} and ${e.line + 1}`,
          fixable: false,
        });
      else tagged.set(e.id, e.line + 1);
      const it = all.find((i) => i.id === e.id);
      if (!it)
        out.push({
          id: e.id,
          problem: `${where} is tagged with it, but there's no such item`,
          fixable: false,
        });
      else if (!fmt.titleFromEntry(e, it))
        out.push({
          id: e.id,
          problem: `${where} is tagged with it, but its title ("${it.title.slice(0, 60)}") didn't come from that line`,
          fixable: false,
        });
    }
  }

  // Statuses worked out from git.
  const status = containment(false);
  status.prime(b.items);
  const branches = new Set(
    git(mainCheckout, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean),
  );
  for (const it of b.items) {
    const s = status(it);
    if (s !== it.status)
      out.push({ id: it.id, problem: `status says ${it.status}, but git says ${s}`, fixable: true });
    if (it.owner && !fmt.FINISHED.includes(s) && !branches.has(it.owner))
      out.push({
        id: it.id,
        problem: `is ${s}, owned by ${it.owner}, which isn't a branch any more`,
        fixable: false,
      });
  }

  // The summary against the items (as written: stale statuses are reported above).
  const rows = fmt.summaryRows(text);
  const rowIds = new Set(rows.map((r) => r.id));
  const itemIds = new Set(b.items.map((i) => i.id));
  for (const r of rows)
    if (!itemIds.has(r.id))
      out.push({ id: r.id, problem: "is in the summary but has no item", fixable: true });
  for (const it of b.items)
    if (!rowIds.has(it.id)) out.push({ id: it.id, problem: "has no row in the summary", fixable: true });
  const expected = new Map(fmt.expectedSummaryRows(b).map((r) => [r.id, r.row]));
  const differ = rows.filter((r) => expected.has(r.id) && expected.get(r.id) !== r.row).map((r) => r.id);
  if (differ.length)
    out.push({
      id: differ.length === 1 ? differ[0] : `${differ.length} items`,
      problem: `summary row${differ.length === 1 ? "" : "s"} out of date${differ.length > 1 ? ` (${differ.slice(0, 8).join(", ")}${differ.length > 8 ? ", …" : ""})` : ""}`,
      fixable: true,
    });

  // The PRD registry (an old prose table is no one's to check).
  const registry = reg.parseRegistry(b.preamble);
  if (registry.format === "new") out.push(...reg.findings(registry.rows, b.items, archivedRows()));
  return out;
}

// ---- the PRD registry ---------------------------------------------------

/** What stateOf needs, from dev and the worktrees. @param {import("./format.mjs").Item[]} items @returns {reg.Facts} */
function registryFacts(items) {
  const PLANS = `${config.paths.plans}/`;
  const plans = new Set(
    (tryGit(mainCheckout, "ls-tree", "--name-only", TRUNK, PLANS) ?? "")
      .split("\n")
      .map((f) => (f.startsWith(PLANS) ? /^(.+)-plan\.md$/.exec(f.slice(PLANS.length))?.[1] : undefined))
      .filter(Boolean),
  );
  const worktrees = new Set(
    [...git(mainCheckout, "worktree", "list", "--porcelain").matchAll(/^branch refs\/heads\/(.+)$/gm)]
      .map((m) => m[1])
      .filter((b) => b.startsWith(PREFIX.prd))
      .map((b) => b.slice(PREFIX.prd.length)),
  );
  const waiting = new Map();
  for (const i of items)
    if (i.prd && i.status === "triaged") waiting.set(i.prd, (waiting.get(i.prd) ?? 0) + 1);
  return { plans, worktrees, waiting };
}

/** The archive's PRD rows (none without an archive or its table). */
const archivedRows = () => {
  const a = readArchive({ lenient: true });
  return a ? reg.archivedRowsOf(a.preamble) : [];
};

/** "--first", "--last", "--before T", "--after T" → a position (or `fallback`). */
function position(opts, fallback) {
  const given = [
    opts.first && { first: true },
    opts.last && { last: true },
    opts.before !== undefined && { before: opts.before },
    opts.after !== undefined && { after: opts.after },
  ].filter(Boolean);
  if (given.length > 1) throw new fmt.BacklogError("give one of --first, --last, --before, --after");
  if (!given.length && !fallback)
    throw new fmt.BacklogError("where to? --first, --last, --before T or --after T");
  return given[0] ?? fallback;
}

/** One locked write of the registry: `edit` gets the rows and returns the new ones. */
function writeRegistry(tool, text, edit) {
  write(tool, { ids: [], text }, (b) => {
    b.preamble = reg.withRows(b.preamble, edit(reg.rowsOf(b.preamble)));
  });
}

function prd(pos, opts) {
  const [sub, topic, ...pairs] = pos;
  switch (sub) {
    case "list":
    case undefined: {
      const b = read();
      // An After naming an archived (done) topic is met: the dispatcher reads this list.
      const rows = reg.withoutAfter(reg.rowsOf(b.preamble), new Set(archivedRows().map((r) => r.topic)));
      const facts = registryFacts(b.items);
      const out = rows.map((r) => ({
        ...r,
        state: reg.stateOf(r, facts),
        waiting: facts.waiting.get(r.topic) ?? 0,
      }));
      if (opts.json) return console.log(JSON.stringify(out));
      // A held row's reason goes on its own line under it: the columns stay narrow.
      const show = out.map((r) => ({
        prd: r.topic,
        state: r.state,
        flags: r.flags.join(",") || "—",
        after: r.after.join(",") || "—",
        waiting: String(r.waiting),
        hot: r.hot.join(", ") || "—",
      }));
      const head = {
        prd: "PRD",
        state: "STATE",
        flags: "FLAGS",
        after: "AFTER",
        waiting: "WAITING",
        hot: "HOT FILES",
      };
      const keys = /** @type {(keyof typeof head)[]} */ (Object.keys(head));
      const w = Object.fromEntries(
        keys.map((k) => [k, Math.max(head[k].length, ...show.map((r) => r[k].length))]),
      );
      const line = (r) => keys.map((k, i) => (i === keys.length - 1 ? r[k] : r[k].padEnd(w[k]))).join("  ");
      console.log(line(head));
      show.forEach((r, i) => {
        console.log(line(r));
        if (out[i].held) console.log(`  on hold since ${reg.heldText(out[i])}`);
      });
      if (!show.length) console.log("(no PRDs)");
      return;
    }
    case "add": {
      const p = position(opts, { last: true });
      writeRegistry("prd add", `prd add ${topic}`, (rows) =>
        reg.addRow(rows, topic, pairs, p, { today: today(), archived: archivedRows().map((r) => r.topic) }),
      );
      return console.log(`added ${topic}`);
    }
    case "show": {
      if (!topic) throw new fmt.BacklogError("usage: prd show <topic> [--json]");
      const b = read();
      const live = reg.rowsOf(b.preamble).find((r) => r.topic === topic);
      const r = live ?? archivedRows().find((a) => a.topic === topic);
      if (!r) throw new fmt.BacklogError(`no PRD row "${topic}" (${toolCmd.backlog} prd list)`);
      const facts = registryFacts(b.items);
      const out = {
        ...r,
        state: reg.stateOf(r, facts),
        waiting: facts.waiting.get(r.topic) ?? 0,
        archived: !live,
      };
      if (opts.json) return console.log(JSON.stringify(out));
      console.log(`${r.topic} · ${out.state}${live ? "" : ` (archived in ${ARCHIVE_REL})`}`);
      console.log(`  flags: ${r.flags.join(", ") || "—"}`);
      if (r.held) console.log(`  on hold since ${reg.heldText(r)}`);
      console.log(`  after: ${r.after.join(", ") || "—"}`);
      console.log(`  waiting: ${out.waiting}`);
      console.log(`  hot files: ${r.hot.join(", ") || "—"}`);
      console.log(`  notes: ${r.notes || "—"}`);
      return;
    }
    case "archive": {
      if (topic) throw new fmt.BacklogError("usage: prd archive (it moves every done row)");
      const res = write(
        "prd archive",
        (x) => ({
          ids: [],
          text: `prd archive ${x.moved.length} done row${x.moved.length === 1 ? "" : "s"}: ${x.moved.map((r) => r.topic).join(", ")}`,
        }),
        (b, c) => {
          const x = reg.archiveDone(reg.rowsOf(b.preamble), registryFacts(b.items).worktrees);
          if (!x.moved.length) return x;
          b.preamble = reg.withRows(b.preamble, x.rows);
          const a = c.archive();
          a.preamble = reg.withArchivedRows(a.preamble, [...reg.archivedRowsOf(a.preamble), ...x.moved]);
          return x;
        },
      );
      console.log(
        res.moved.length
          ? `archived ${res.moved.length} done PRD row${res.moved.length === 1 ? "" : "s"} to ${ARCHIVE_REL}: ${res.moved.map((r) => r.topic).join(", ")}`
          : "no done PRD rows to archive",
      );
      if (res.kept.length) console.log(`kept ${res.kept.join(", ")}: a prd/ worktree is still there`);
      return;
    }
    case "set":
      if (!topic) throw new fmt.BacklogError("usage: prd set <topic> key=value…");
      writeRegistry("prd set", `prd set ${topic}: ${pairs.join(", ")}`, (rows) =>
        reg.updateRow(rows, topic, pairs, { today: today() }),
      );
      return console.log(`updated ${topic}`);
    case "move": {
      if (!topic) throw new fmt.BacklogError("usage: prd move <topic> --first|--last|--before T|--after T");
      const p = position(opts, null);
      const where =
        "first" in p
          ? "first"
          : "last" in p
            ? "last"
            : "before" in p
              ? `before ${p.before}`
              : `after ${p.after}`;
      writeRegistry("prd move", `prd move ${topic} ${where}`, (rows) => reg.moveRow(rows, topic, p));
      return console.log(`moved ${topic} ${where}`);
    }
    default:
      throw new fmt.BacklogError(`unknown prd command "${sub}" (list, show, add, set, move, archive)`);
  }
}

function doctor(fix) {
  let found = findings();
  if (fix && found.some((f) => f.fixable)) {
    const n = found.filter((f) => f.fixable).length;
    write(
      "doctor",
      { ids: [], text: `doctor: fix ${n} finding${n === 1 ? "" : "s"} (statuses, summary)` },
      () => undefined,
      { lenient: true },
    );
    console.log(`fixed ${n}`);
    found = findings();
  }
  for (const f of found) console.log(`${f.id}  ${f.problem}${f.fixable && !fix ? " (--fix)" : ""}`);
  if (!found.length) return console.log("backlog ok");
  console.log(`${found.length} finding${found.length === 1 ? "" : "s"}`);
  process.exitCode = 1;
}

const ids = (pos) => {
  if (!pos.length) throw new fmt.BacklogError(`which item? (${fmt.IDS.prefix}n)`);
  return [...new Set(pos.map(fmt.normId))];
};
/** "B-1: …", "B-1, B-2, B-3 +2: …" */
/**
 * The item to change: in backlog.md, or with --archived in the archive too
 * (changed in place there; it stays archived). Without the flag an archived
 * id is refused, naming the flag.
 * @param {import("./format.mjs").Backlog} b @param {WriteContext} ctx @param {string} id @param {boolean} archived
 */
const target = (b, ctx, id, archived) =>
  archived && b.archived?.includes(fmt.normId(id)) ? fmt.find(ctx.archive(), id) : fmt.find(b, id);

const about = (list, what) => ({ ids: list, text: `${amend.idList(list)}: ${what}` });

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opts } = parseArgs(rest);
  const ctx = () => ({ by: who(), date: today() });
  switch (cmd) {
    case "list":
    case undefined:
      return list(opts);
    case "show":
      return show(ids(pos)[0]);
    case "path":
      return console.log(`${file}\n${inboxFile}`);
    case "inbox": {
      const [sub, ...args] = pos;
      if (sub === "add") return inboxAdd(args, opts);
      if (sub === "move") return inboxMove(args);
      if (sub === "edit") return inboxEdit(args, opts);
      if (sub === "remove") return inboxRemove(args);
      if (sub !== undefined)
        throw new fmt.BacklogError(`unknown inbox command "${sub}" (add, move, edit, remove)`);
      const merged = mergedInbox(true);
      const pending = merged === null ? [] : fmt.newInboxEntries(merged);
      for (const e of pending) console.log(`${e.type.padEnd(8)}  ${e.text}`);
      return console.log(
        pending.length
          ? `${pending.length} not filed yet (${toolCmd.backlog} ingest)`
          : "nothing new in the inbox",
      );
    }
    case "ingest": {
      pickup(`${toolCmd.backlog} ingest`); // before the lock: dev-sync takes it too
      const filed = write(
        "ingest",
        (items) => {
          const list = items.map((f) => f.item.id);
          return { ids: list, text: `file ${amend.idList(list)} from the inbox` };
        },
        (b, ctx) => ingest(b, ctx.inbox),
      );
      for (const { item: it, similar } of filed) {
        console.log(`${it.id}  ${it.type.padEnd(8)}  ${it.title}`);
        for (const m of similar) console.log(`  looks like ${fmt.similarLine(m)}`);
      }
      return console.log(filed.length ? `filed ${filed.length}` : "nothing new in the inbox");
    }
    case "similar": {
      const text = pos.join(" ");
      if (!text.trim()) throw new fmt.BacklogError("usage: similar <text…>");
      const matches = fmt.similarItems(text, similarPool(read({ lenient: true }).items));
      for (const m of matches) console.log(fmt.similarLine(m));
      if (!matches.length) console.log("no look-alikes");
      return;
    }
    case "add": {
      const [type, ...words] = pos;
      if (!type) throw new fmt.BacklogError("usage: add <type> <title…>");
      const it = write(
        "add",
        (item) => ({ ids: [item.id], text: `add ${item.id} (${item.type}) ${item.title}` }),
        (b) => {
          // Under the lock, before anything is written: a stop leaves the backlog as it was.
          if (!opts.anyway) {
            const matches = fmt.similarItems(words.join(" "), similarPool(b.items));
            if (matches.length) throw new LookAlikeStop(matches);
          }
          return fmt.add(b, {
            type,
            title: words.join(" "),
            prd: opts.prd,
            status: opts.status,
            note: opts.note,
            ...ctx(),
          });
        },
      );
      return console.log(`added ${it.id}`);
    }
    case "set": {
      const at = pos.findIndex((p) => p.includes("="));
      const list = ids(at < 0 ? pos : pos.slice(0, at));
      const pairs = at < 0 ? [] : pos.slice(at);
      if (!pairs.length) throw new fmt.BacklogError(`usage: set ${fmt.IDS.prefix}n… key=value…`);
      write("set", about(list, `set ${pairs.join(", ")}`), (b, c) => {
        for (const id of list) {
          const it = target(b, c, id, opts.archived);
          for (const p of pairs) {
            const eq = p.indexOf("=");
            if (eq < 1) throw new fmt.BacklogError(`"${p}" isn't key=value`);
            fmt.setField(it, p.slice(0, eq), p.slice(eq + 1));
          }
        }
      });
      return console.log(`updated ${list.join(", ")}`);
    }
    case "note": {
      // The first word is the id; more ids follow only in the B-n form, so a note can start with a number.
      let n = 1;
      while (n < pos.length && fmt.IDS.is(pos[n])) n++;
      const list = ids(pos.slice(0, n));
      const text = pos.slice(n).join(" ");
      if (!text.trim())
        throw new fmt.BacklogError(`usage: note ${fmt.IDS.prefix}n [${fmt.IDS.prefix}n…] <text…>`);
      write("note", about(list, "note"), (b, c) => {
        for (const id of list) fmt.addNote(target(b, c, id, opts.archived), { text, ...ctx() });
      });
      return console.log(`noted ${list.join(", ")}`);
    }
    case "claim": {
      const owner = opts.as ?? myBranch();
      if (!owner || owner === TRUNK)
        throw new fmt.BacklogError(
          `claim from your ${PREFIX.prd} or ${PREFIX.plan} branch, or pass --as OWNER`,
        );
      const list = ids(pos);
      write("claim", about(list, `claimed by ${owner}`), (b) => {
        const items = list.map((id) => fmt.find(b, id));
        // All or nothing: name every conflict before changing anything.
        const taken = items.filter((it) => it.owner && it.owner !== owner && !opts.force);
        if (taken.length)
          throw new fmt.BacklogError(
            `${taken.map((it) => `${it.id} is already claimed by ${it.owner}`).join(", ")}; ` +
              `nothing claimed (pass --force to take ${taken.length === 1 ? "it" : "them"})`,
          );
        for (const it of items) fmt.claim(it, owner, !!opts.force);
      });
      for (const id of list) console.log(`${id} claimed by ${owner}`);
      return;
    }
    case "release": {
      const list = ids(pos);
      write("release", about(list, "released"), (b) => {
        for (const id of list) fmt.release(fmt.find(b, id));
      });
      return;
    }
    case "done": {
      const sha = git(here, "rev-parse", "--short", `${opts.commit ?? "HEAD"}^{commit}`);
      const list = ids(pos);
      write("done", about(list, `ready at ${sha}`), (b) => {
        for (const id of list) {
          const it = fmt.find(b, id);
          it.commit = sha;
          it.status = "ready";
        }
      });
      return console.log(`${list.join(", ")} ready at ${sha}`);
    }
    case "refresh": {
      const changed = write("refresh", { ids: [], text: "refresh derived statuses" }, (b) =>
        refreshStatuses(b, !opts["no-fetch"]),
      );
      return console.log(changed.length ? changed.join("\n") : "no status changes");
    }
    case "commit":
      write("commit", { ids: [], text: pos.join(" ") || "hand edits" }, (_b, c) => {
        c.commitHandEdits = true;
      });
      return console.log("committed");
    case "ci-file": {
      const { findings = [] } = JSON.parse(readFileSync(0, "utf8") || "{}");
      let pushed = null;
      const out = write(
        "ci-file",
        (r) => {
          const list = r.filed.map((f) => f.id);
          return {
            ids: list,
            text: list.length ? `${amend.idList(list)}: filed from CI` : "tidy the quarantine",
          };
        },
        (b, c) => {
          refreshStatuses(b);
          const apply = /** @type {NonNullable<typeof filing>} */ (filing).applyFindings;
          if (!QUARANTINE_REL)
            throw new fmt.BacklogError("ci-file: the project config names no quarantine list");
          const r = apply(b, headText(QUARANTINE_REL), findings, {
            add: (f) =>
              fmt.add(b, {
                type: "bug",
                title: f.title,
                prd: f.prd,
                status: "triaged",
                note: f.note,
                ...ctx(),
              }),
            note: (it, text) => fmt.addNote(it, { text, ...ctx() }),
            hasFix: (it, commit) =>
              tryGit(
                mainCheckout,
                "merge-base",
                "--is-ancestor",
                `${it.commit}^{commit}`,
                `${commit}^{commit}`,
              ) !== null,
          });
          c.quarantine = r.quarantine;
          return r;
        },
        {
          // Under the lock: never forced, so a diverged origin only leaves it for the next landing.
          afterCommit: (committed) => {
            if (!opts.push || !committed) return;
            pushed =
              tryGit(mainCheckout, "push", "--quiet", REMOTE, `refs/heads/${TRUNK}:refs/heads/${TRUNK}`) !==
              null;
          },
        },
      );
      return console.log(
        JSON.stringify({ filed: out.filed, removed: out.removed, pushed, missed: out.missed }),
      );
    }
    case "doctor":
      return doctor(!!opts.fix);
    case "prd":
      return prd(pos, opts);
    case "archive": {
      const wanted = pos.length ? ids(pos) : [];
      const moved = write(
        "archive",
        (items) => ({
          ids: items.map((i) => i.id),
          text: `archive ${items.length} finished item${items.length === 1 ? "" : "s"}`,
        }),
        (b, c) => archiveFinished(b, c, wanted),
      );
      return console.log(
        moved.length
          ? `archived ${moved.length} to ${ARCHIVE_REL}: ${moved.map((i) => i.id).join(", ")}`
          : "nothing to archive",
      );
    }
    default:
      throw new fmt.BacklogError(`unknown command "${cmd}" (see the top of backlog/backlog.mjs)`);
  }
}

try {
  main();
} catch (e) {
  if (e instanceof LookAlikeStop) {
    console.error("backlog: this looks like what's already filed or in the inbox; nothing was added:");
    for (const m of e.matches) console.error(`  ${lookAlikeLine(m)}`);
    console.error(
      `Note the existing item (${toolCmd.backlog} note ${fmt.IDS.prefix}<n> …), or rerun with --anyway.`,
    );
    process.exit(3);
  }
  if (e instanceof fmt.BacklogError) {
    console.error(`backlog: ${e.message}`);
    process.exit(1);
  }
  if (e && typeof e === "object" && "stderr" in e && e.stderr) console.error(String(e.stderr));
  throw e;
}
