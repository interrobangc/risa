#!/usr/bin/env node
// The live backlog, on dev in the main checkout:
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
//   pnpm backlog ingest                      file new inbox bullets (status inbox), tag them (B-n)
//   pnpm backlog inbox                       show inbox bullets not filed yet
//   pnpm backlog list [--all] [--prd P] [--status S] [--type T] [--owner O] [--json]
//   pnpm backlog show B-n                    finds archived items too (list --all lists them)
//   pnpm backlog add <type> <title…> [--prd P] [--status S] [--note TEXT]
//   pnpm backlog set B-n key=value…          keys: status type title prd owner commit
//   pnpm backlog note B-n <text…>
//   pnpm backlog claim B-n [--as OWNER] [--force]   owner defaults to your branch
//   pnpm backlog release B-n
//   pnpm backlog done B-n… [--commit SHA]    work merged into its PRD branch (default: your HEAD)
//   pnpm backlog refresh [--no-fetch]        write the derived statuses (landed, staging, live)
//   pnpm backlog commit [message]            commit hand edits of the files (backlog.md normalised)
//   pnpm backlog doctor [--fix]              check the backlog; exit 1 on findings; --fix the safe ones
//   pnpm backlog archive                     move landed, staging, live and dropped items to the archive
//   pnpm backlog path
//
// Env: BACKLOG_BY (who's writing; default your branch, or git user.name on dev),
// BACKLOG_BRANCH (default dev), BACKLOG_REMOTE (default origin).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as fmt from "./format.mjs";

const TRUNK = process.env.BACKLOG_BRANCH ?? "dev";
const REMOTE = process.env.BACKLOG_REMOTE ?? "origin";
const REL = "plans/backlog.md";
const INBOX_REL = "plans/inbox.md";
const ARCHIVE_REL = "plans/backlog-archive.md";

const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
  "caretook-backlog.lock",
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
      const flag = ["all", "force", "no-fetch", "json", "fix"].includes(key);
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

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Run `fn` under the lock; a lock older than 30 s is from a crashed writer and is taken over. */
function withLock(fn) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let age;
      try {
        age = Date.now() - statSync(lockDir).mtimeMs;
      } catch {
        continue; // released between the two calls
      }
      if (age > 30_000) rmSync(lockDir, { recursive: true, force: true });
      else if (Date.now() > deadline) throw new fmt.BacklogError(`backlog is locked (${lockDir}); try again`);
      else sleep(150);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/**
 * Commit `contents` ({ path: text }) onto the main checkout's branch, and
 * nothing else: built in a temporary index from HEAD, so neither the dev
 * keeper's staged work nor their unstaged edits of these files go in. The
 * real index then gets the committed copies, so their own edits show as
 * unstaged changes on top. Returns false when nothing changed.
 */
function commitContents(contents, subject, body) {
  const head = git(mainCheckout, "rev-parse", "HEAD");
  const tmpIndex = join(gitDir, `caretook-backlog-index-${process.pid}`);
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
    const commit = gitRaw(mainCheckout, ["commit-tree", tree, "-p", head, "-m", subject, "-m", body]).trim();
    git(mainCheckout, "update-ref", "-m", `backlog: ${subject}`, "HEAD", commit, head);
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
 * `message` is the commit subject, or a function of `change`'s result.
 * @param {string | ((result: any) => string)} message
 * @param {(b: import("./format.mjs").Backlog, ctx: WriteContext) => any} change
 * @param {{ lenient?: boolean }} [opts]
 */
function write(message, change, opts = {}) {
  return withLock(() => {
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

    for (const [rel, text] of Object.entries(disk)) writeFileSync(join(mainCheckout, rel), text);
    const subject = `chore(backlog): ${typeof message === "function" ? message(result) : message}`.slice(
      0,
      72,
    );
    const body = [
      `By: ${who()}`,
      ...(handEdited.length ? [`Includes uncommitted hand edits of ${handEdited.join(" and ")}.`] : []),
      ...(refreshed.length ? [`Statuses from git: ${refreshed.join(", ")}.`] : []),
    ];
    commitContents(commit, subject, body.join("\n"));
    return result;
  });
}

/** File every new inbox bullet as a tracker item (status inbox) and tag it with its id. */
function ingest(b, inbox) {
  if (inbox.text === null) return [];
  const ctx = { by: who(), date: today() };
  const filed = [];
  // In file order. Tagging only appends to a line, so line numbers never shift.
  for (const e of fmt.newInboxEntries(inbox.text)) {
    const title = fmt.titleFromBullet(e.text);
    const asked = [title !== e.text.replace(/\s+/g, " ").trim() ? e.text : "", e.details]
      .filter(Boolean)
      .join("\n");
    const it = fmt.add(b, { type: e.type, title, status: "inbox", ...ctx });
    if (asked) fmt.addNote(it, { text: `From the inbox: ${asked.replace(/\n/g, " / ")}`, ...ctx });
    inbox.text = fmt.tagInboxLine(inbox.text, e.line, it.id);
    filed.push(it);
  }
  return filed;
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
  const items = [...read().items, ...(opts.all ? (readArchive()?.items ?? []) : [])];
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
 * @param {import("./format.mjs").Backlog} b @param {WriteContext} ctx
 */
function archiveFinished(b, ctx) {
  refreshStatuses(b);
  const done = b.items.filter((i) => fmt.FINISHED.includes(i.status));
  if (!done.length) return [];
  const archive = ctx.archive();
  for (const it of done) {
    if (archive.items.some((a) => a.id === it.id))
      throw new fmt.BacklogError(`${it.id} is already in ${ARCHIVE_REL} (run pnpm backlog doctor)`);
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
  return out;
}

function doctor(fix) {
  let found = findings();
  if (fix && found.some((f) => f.fixable)) {
    const n = found.filter((f) => f.fixable).length;
    write(`doctor: fix ${n} finding${n === 1 ? "" : "s"} (statuses, summary)`, () => undefined, {
      lenient: true,
    });
    console.log(`fixed ${n}`);
    found = findings();
  }
  for (const f of found) console.log(`${f.id}  ${f.problem}${f.fixable && !fix ? " (--fix)" : ""}`);
  if (!found.length) return console.log("backlog ok");
  console.log(`${found.length} finding${found.length === 1 ? "" : "s"}`);
  process.exitCode = 1;
}

const ids = (pos) => {
  if (!pos.length) throw new fmt.BacklogError("which item? (B-n)");
  return pos;
};

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
      const pending = existsSync(inboxFile) ? fmt.newInboxEntries(readFileSync(inboxFile, "utf8")) : [];
      for (const e of pending) console.log(`${e.type.padEnd(8)}  ${e.text}`);
      return console.log(
        pending.length ? `${pending.length} not filed yet (pnpm backlog ingest)` : "nothing new in the inbox",
      );
    }
    case "ingest": {
      const filed = write(
        (items) => `file ${items.map((i) => i.id).join(", ")} from the inbox`,
        (b, ctx) => ingest(b, ctx.inbox),
      );
      for (const it of filed) console.log(`${it.id}  ${it.type.padEnd(8)}  ${it.title}`);
      return console.log(filed.length ? `filed ${filed.length}` : "nothing new in the inbox");
    }
    case "add": {
      const [type, ...words] = pos;
      if (!type) throw new fmt.BacklogError("usage: add <type> <title…>");
      const it = write(
        (item) => `add ${item.id} (${item.type}) ${item.title}`,
        (b) =>
          fmt.add(b, {
            type,
            title: words.join(" "),
            prd: opts.prd,
            status: opts.status,
            note: opts.note,
            ...ctx(),
          }),
      );
      return console.log(`added ${it.id}`);
    }
    case "set": {
      const [id, ...pairs] = pos;
      if (!pairs.length) throw new fmt.BacklogError("usage: set B-n key=value…");
      write(`${id.toUpperCase()}: set ${pairs.join(", ")}`, (b) => {
        const it = fmt.find(b, id);
        for (const p of pairs) {
          const eq = p.indexOf("=");
          if (eq < 1) throw new fmt.BacklogError(`"${p}" isn't key=value`);
          fmt.setField(it, p.slice(0, eq), p.slice(eq + 1));
        }
      });
      return console.log(`updated ${id}`);
    }
    case "note": {
      const [id, ...words] = pos;
      write(`${id?.toUpperCase()}: note`, (b) =>
        fmt.addNote(fmt.find(b, ids([id])[0]), { text: words.join(" "), ...ctx() }),
      );
      return console.log(`noted ${id}`);
    }
    case "claim": {
      const owner = opts.as ?? myBranch();
      if (!owner || owner === TRUNK)
        throw new fmt.BacklogError("claim from your prd/ or plan/ branch, or pass --as OWNER");
      for (const id of ids(pos)) {
        write(`${id.toUpperCase()}: claimed by ${owner}`, (b) =>
          fmt.claim(fmt.find(b, id), owner, !!opts.force),
        );
        console.log(`${id} claimed by ${owner}`);
      }
      return;
    }
    case "release":
      for (const id of ids(pos)) write(`${id.toUpperCase()}: released`, (b) => fmt.release(fmt.find(b, id)));
      return;
    case "done": {
      const sha = git(here, "rev-parse", "--short", `${opts.commit ?? "HEAD"}^{commit}`);
      for (const id of ids(pos))
        write(`${id.toUpperCase()}: ready at ${sha}`, (b) => {
          const it = fmt.find(b, id);
          it.commit = sha;
          it.status = "ready";
        });
      return console.log(`${pos.join(", ")} ready at ${sha}`);
    }
    case "refresh": {
      const changed = write("refresh derived statuses", (b) => refreshStatuses(b, !opts["no-fetch"]));
      return console.log(changed.length ? changed.join("\n") : "no status changes");
    }
    case "commit":
      write(pos.join(" ") || "hand edits", (_b, c) => {
        c.commitHandEdits = true;
      });
      return console.log("committed");
    case "doctor":
      return doctor(!!opts.fix);
    case "archive": {
      const moved = write(
        (items) => `archive ${items.length} finished item${items.length === 1 ? "" : "s"}`,
        (b, c) => archiveFinished(b, c),
      );
      return console.log(
        moved.length
          ? `archived ${moved.length} to ${ARCHIVE_REL}: ${moved.map((i) => i.id).join(", ")}`
          : "nothing to archive",
      );
    }
    default:
      throw new fmt.BacklogError(`unknown command "${cmd}" (see the top of scripts/backlog/backlog.mjs)`);
  }
}

try {
  main();
} catch (e) {
  if (e instanceof fmt.BacklogError) {
    console.error(`backlog: ${e.message}`);
    process.exit(1);
  }
  if (e && typeof e === "object" && "stderr" in e && e.stderr) console.error(String(e.stderr));
  throw e;
}
