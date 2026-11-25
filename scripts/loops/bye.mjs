// `pnpm prd bye`: the hand-over check a session runs when the user says just
// "bye". It works out the calling session's role, gathers what that role may
// leave open, and either closes the session or lists each open thing.
//
//   node bye.mjs [--dry-run] [--json]
//
// The role: a slice/ branch is a loop (a subagent, whatever claude it runs
// under); else the live record of the shell's ancestor claude (prd, plan,
// backlog, inbox, hotfix, recovery); else the branch (prd/, plan/, hotfix/);
// else an unrecorded session.
//
// Open things (each blocks the close):
//   - uncommitted work in the role's worktree (the backlog session: the backlog
//     files in the main checkout; never the user's other edits there);
//   - commits on no remote and not in the trunk (prd, plan, hotfix);
//   - the role's worktrees and unmerged branches still out (prd: the PRD and
//     its slices; plan; hotfix);
//   - a stack still up or a dev server running (a slice or hotfix worktree;
//     a running server in any role's worktree);
//   - a lease whose holder is still running (a check, a browser run): the
//     worktree's, or one under the session's claude;
//   - background jobs: shells the session's claude started that are still
//     running (not this command's own);
//   - questions it filed that still await an answer.
// Notices for its topic from other sessions are listed to read, never blocking
// (not for a slice: its orchestrator reads them).
//
// Clean: it prints the hand-off line, releases the leases the session itself
// holds (its claude's pid, or a holder that is gone) and ends the session
// through end-session.sh. A loop is never ended: it sends its hand-off message.
// Not clean: it lists each open thing with how to clear it, closes nothing and
// exits 3; the session asks the user about each (finish, hand off, drop) and
// runs it again. It never discards work: it removes no file, worktree, branch
// or ask. --dry-run only reports; --json prints the facts and the verdict.
//
// Env: TRUNK (dev), CARETOOK_SESSIONS_DIR, CARETOOK_ASKS_DIR,
// CARETOOK_NOTICES_DIR, CARETOOK_LEASE_ROOT (default the main checkout's
// .loops/…), CARETOOK_CLAUDE_BIN (tests).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { awaitsAnswer, listAsks } from "./asks.mjs";
import { listNotices } from "./notices.mjs";
import { ancestorClaude, claudeName, isLive, processOf, processTable, readRecords } from "./sessions.mjs";
import { branchKinds } from "./config.mjs";

/** Exit code when something is open. */
export const OPEN = 3;

/**
 * @typedef {{ kind: string, n: string, path: string, worktree: string, check: string, pid: number,
 *   alive: boolean }} Lease
 * @typedef {{
 *   role: string, name: string, topic: string, sessionPid: number | null, recorded: boolean,
 *   worktree: { path: string, branch: string, dirty: string[], unpushed: number, stack: boolean,
 *     server: boolean } | null,
 *   left: { worktrees: string[], branches: string[] },
 *   leases: Lease[], jobs: { pid: number, args: string }[],
 *   asks: { id: string, text: string }[], notices: { id: string, session: string | null, text: string }[],
 * }} Facts
 */

/** "3 files", "1 commit". */
const count = (/** @type {number} */ n, /** @type {string} */ what) => `${n} ${what}${n === 1 ? "" : "s"}`;
const short = (/** @type {string} */ s, max = 90) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * Pure: what is open, what a clean close releases, and what to read.
 * @param {Facts} f
 */
export function byeVerdict(f) {
  /** @type {{ what: string, detail: string, clear: string }[]} */
  const open = [];
  const w = f.worktree;
  if (w) {
    if (w.dirty.length)
      open.push({
        what: "uncommitted work",
        detail: `${count(w.dirty.length, "file")} in ${w.path} (${short(w.dirty.slice(0, 3).join(", "), 60)}${w.dirty.length > 3 ? ", …" : ""})`,
        clear: "commit it, or drop it on the user's word",
      });
    if (w.unpushed)
      open.push({
        what: "unpushed commits",
        detail: `${count(w.unpushed, "commit")} on ${w.branch} on no remote and not in the trunk`,
        clear: "push or land them (pnpm prd pr / land), or hand them off",
      });
    if (w.stack) open.push({ what: "a stack still up", detail: w.path, clear: "pnpm prd stack down" });
    if (w.server) open.push({ what: "a dev server running", detail: w.path, clear: "pnpm prd serve --stop" });
  }
  for (const t of f.left.worktrees)
    open.push({ what: "a worktree still out", detail: t, clear: "finish and land it, then pnpm prd rm" });
  for (const b of f.left.branches)
    open.push({ what: "a branch not merged into the trunk", detail: b, clear: "land it, or hand it off" });
  const release = [];
  for (const l of f.leases) {
    if (l.alive && l.pid !== f.sessionPid)
      open.push({
        what: `a ${l.kind} lease held`,
        detail: `${l.worktree}: ${l.check || "?"} (pid ${l.pid})`,
        clear: `let it finish (pnpm prd wait ${l.kind}) or stop it`,
      });
    else release.push(l);
  }
  for (const j of f.jobs)
    open.push({
      what: "a background job running",
      detail: `pid ${j.pid}: ${short(j.args)}`,
      clear: "wait for it, or stop it",
    });
  for (const a of f.asks)
    open.push({
      what: "an open question it filed",
      detail: `${a.id}: ${short(a.text)}`,
      clear: `wait for the answer, or dismiss it (pnpm prd asks --done ${a.id})`,
    });
  const read = f.notices.map((n) => `${n.id}${n.session ? ` (${n.session})` : ""}: ${short(n.text)}`);
  return { clean: open.length === 0, open, release, read };
}

/** Pure: the lines bye prints for a verdict. */
export function byeLines(
  /** @type {Facts} */ f,
  /** @type {ReturnType<typeof byeVerdict>} */ v,
  { dryRun = false } = {},
) {
  const who = `${f.name} (${f.role})`;
  const lines = [];
  if (v.read.length) {
    lines.push(`Notices for ${f.topic || "this session"} to read first (none blocks):`);
    for (const r of v.read) lines.push(`  ${r}`);
  }
  if (!v.clean) {
    lines.push(`bye: ${who} has ${count(v.open.length, "open thing")}; nothing was closed:`);
    v.open.forEach((o, i) => lines.push(`  ${i + 1}. ${o.what}: ${o.detail} (${o.clear})`));
    lines.push(
      "Ask the user about each, one at a time: finish it, hand it off or drop it (only on their word). Then run pnpm prd bye again.",
    );
    return lines;
  }
  const released = v.release.length ? `; released ${count(v.release.length, "lease")}` : "";
  lines.push(
    `bye: ${who} is clean: nothing open${dryRun ? " (dry run: nothing released or ended)" : released}.`,
  );
  if (f.role === "slice")
    lines.push(
      "A slice has no session of its own to end: send your hand-off message now, and nothing after it.",
    );
  else if (!dryRun) lines.push("Hand-off: the session ends now; say nothing after this.");
  return lines;
}

// ---- gathering the facts -------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const run = (/** @type {string} */ cmd, /** @type {string[]} */ args, cwd = process.cwd()) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return r.status === 0 ? r.stdout.trimEnd() : null; // (status lines start with a space)
};
const git = (/** @type {string} */ cwd, /** @type {string[]} */ ...args) => run("git", ["-C", cwd, ...args]);

function mainCheckout() {
  const first = git(here, "worktree", "list", "--porcelain")?.split("\n")[0] ?? "";
  return first.replace(/^worktree /, "");
}

/** key=value lines of a file, or {}. */
function envFile(/** @type {string} */ file) {
  /** @type {Record<string, string>} */
  const out = {};
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    /* none */
  }
  return out;
}

/** Whether pid runs and its command line contains cmd (lease.sh's lease_alive). */
function holderAlive(/** @type {number} */ pid, /** @type {string} */ cmd) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EPERM") return false;
  }
  if (!cmd) return true;
  return (run("ps", ["-p", String(pid), "-o", "command="]) ?? "").includes(cmd);
}

/** Every lease under the root, live or not. */
function readLeases(/** @type {string} */ root) {
  /** @type {Lease[]} */
  const out = [];
  if (!existsSync(root)) return out;
  for (const kind of readdirSync(root)) {
    if (!/^[a-z][a-z0-9-]*$/.test(kind)) continue;
    const dir = join(root, kind);
    let ns;
    try {
      ns = readdirSync(dir).filter((n) => /^\d+$/.test(n));
    } catch {
      continue;
    }
    for (const n of ns) {
      const path = join(dir, n);
      const e = envFile(join(path, "name"));
      const pid = Number(e.pid) || 0;
      out.push({
        kind,
        n,
        path,
        worktree: e.worktree ?? "",
        check: e.check ?? "",
        pid,
        alive: holderAlive(pid, e.cmd ?? ""),
      });
    }
  }
  return out;
}

/** The pids under root in the table (not root itself). */
function descendants(
  /** @type {number} */ root,
  /** @type {Map<number, { ppid: number, args: string }>} */ table,
) {
  const kids = new Map();
  for (const [pid, row] of table) {
    if (!kids.has(row.ppid)) kids.set(row.ppid, []);
    kids.get(row.ppid).push(pid);
  }
  const out = new Set();
  const todo = [...(kids.get(root) ?? [])];
  while (todo.length) {
    const p = todo.pop();
    if (out.has(p)) continue;
    out.add(p);
    todo.push(...(kids.get(p) ?? []));
  }
  return out;
}

const SHELL = /^(?:\S*\/)?(?:bash|zsh|sh)$/;

/** @returns {Facts} */
export function gather({ cwd = process.cwd(), env = process.env } = {}) {
  const main = mainCheckout();
  const loops = join(main, ".loops");
  const trunk = env.TRUNK || "dev";
  const top = git(cwd, "rev-parse", "--show-toplevel");
  const branch = top ? (git(top, "branch", "--show-current") ?? "") : "";
  const table = processTable();
  const sessionPid = ancestorClaude(process.pid, table, claudeName());
  const sessionsDir = env.CARETOOK_SESSIONS_DIR || join(loops, ".sessions");
  const rec = sessionPid
    ? readRecords(sessionsDir).find(
        ({ record }) => record?.pid === sessionPid && isLive(record, processOf(sessionPid)),
      )
    : undefined;

  let role = "session",
    name = "this shell's claude",
    topic = "";
  const slice = /^(.+)\/(\d+)$/.exec(branchKinds().nameOf(branch, "slice") ?? "");
  if (slice) [role, name, topic] = ["slice", `${slice[1]}-${slice[2]}`, slice[1]];
  else if (rec) [role, name, topic] = [rec.record.kind || "session", rec.name, rec.record.topic || ""];
  else {
    const kind = branchKinds().kindOf(branch);
    const rest = kind && kind !== "slice" ? branchKinds().nameOf(branch, kind) : "";
    if (kind && rest) [role, name, topic] = [kind, `${kind}-${rest}`, rest];
  }

  // The role's worktree: its own for slice, prd, plan and hotfix (when still there).
  const own = {
    slice: top,
    prd: join(loops, topic),
    plan: join(loops, `plan-${topic}`),
    hotfix: join(loops, `hotfix-${topic}`),
  }[role];
  // Every worktree: its path and branch.
  const listed = (git(main, "worktree", "list", "--porcelain") ?? "").split("\n\n").map((block) => ({
    path: /^worktree (.+)$/m.exec(block)?.[1] ?? "",
    branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? "",
  }));
  const worktrees = listed.map((w) => w.path).filter(Boolean);
  /** @type {Facts["worktree"]} */
  let worktree = null;
  if (own && topic && worktrees.includes(own)) {
    const wbranch = git(own, "branch", "--show-current") ?? "";
    const dirty = (git(own, "status", "--porcelain") ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3));
    const unpushed =
      role === "slice"
        ? 0
        : Number(git(own, "rev-list", "--count", "HEAD", "--not", "--remotes", trunk) ?? 0);
    const port = envFile(join(own, "apps/web/.env")).WEB_PORT;
    const server = Boolean(port && run("lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"]));
    const stack =
      (role === "slice" || role === "hotfix") && /^\d+$/.test(envFile(join(own, ".env.loop")).SLOT ?? "");
    worktree = { path: own, branch: wbranch, dirty, unpushed, stack, server };
  } else if (role === "backlog") {
    const files = ["plans/backlog.md", "plans/backlog-archive.md", "plans/inbox.md"];
    const dirty = (git(main, "status", "--porcelain", "--", ...files) ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3));
    worktree = { path: main, branch: trunk, dirty, unpushed: 0, stack: false, server: false };
  }

  // Worktrees and unmerged branches still out, beyond the role's own worktree (counted above).
  const left = { worktrees: /** @type {string[]} */ ([]), branches: /** @type {string[]} */ ([]) };
  const patterns = {
    prd: [
      new RegExp(`^${escape(topic)}(?:-\\d+)?$`),
      [branchKinds().branch("prd", topic), branchKinds().branch("slice", topic, "*")],
    ],
    plan: [new RegExp(`^plan-${escape(topic)}$`), [branchKinds().branch("plan", topic)]],
    hotfix: [new RegExp(`^hotfix-${escape(topic)}$`), [branchKinds().branch("hotfix", topic)]],
  }[role];
  if (patterns && topic) {
    const [re, refs] = /** @type {[RegExp, string[]]} */ (patterns);
    left.worktrees = worktrees.filter((p) => dirname(p) === loops && re.test(basename(p)));
    // A branch checked out in one of them is counted with its worktree.
    const out = new Set(listed.filter((w) => left.worktrees.includes(w.path)).map((w) => w.branch));
    left.branches = (
      git(main, "branch", "--format=%(refname:short)", "--no-merged", trunk, "--list", ...refs) ?? ""
    )
      .split("\n")
      .filter((b) => b && !out.has(b));
  }

  // Leases: the worktree's (by name), and any held under the session's claude.
  const under = sessionPid && role !== "slice" ? descendants(sessionPid, table) : new Set();
  const wtName = own && topic ? basename(own) : null;
  const leases = readLeases(env.CARETOOK_LEASE_ROOT || join(loops, ".lease")).filter(
    (l) =>
      (wtName && l.worktree === wtName) ||
      (role !== "slice" && l.pid && (l.pid === sessionPid || under.has(l.pid))),
  );

  // Background jobs: shells directly under the session's claude, not this command's own chain.
  const mine = new Set();
  for (let p = process.pid; p && p > 1 && !mine.has(p); p = table.get(p)?.ppid ?? 0) mine.add(p);
  const jobs =
    sessionPid && role !== "slice"
      ? [...table]
          .filter(
            ([pid, row]) => row.ppid === sessionPid && !mine.has(pid) && SHELL.test(row.args.split(/\s+/)[0]),
          )
          .map(([pid, row]) => ({ pid, args: row.args }))
      : [];

  const asksDir = env.CARETOOK_ASKS_DIR || join(loops, ".asks");
  const asks =
    role === "slice" || !rec
      ? []
      : listAsks(asksDir)
          .filter((a) => a.session === name && awaitsAnswer(a))
          .map((a) => ({ id: a.id, text: a.text }));
  const notices =
    topic && role !== "slice"
      ? listNotices(env.CARETOOK_NOTICES_DIR || join(loops, ".notices"))
          .filter((n) => n.topic === topic && n.session !== name)
          .map((n) => ({ id: n.id, session: n.session, text: n.text }))
      : [];

  return {
    role,
    name,
    topic,
    sessionPid,
    recorded: Boolean(rec),
    worktree,
    left,
    leases,
    jobs,
    asks,
    notices,
  };
}

function escape(/** @type {string} */ s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const json = args.includes("--json");
  if (args.some((a) => a === "-h" || a === "--help")) {
    console.log(
      readFileSync(fileURLToPath(import.meta.url), "utf8")
        .split("\nimport ")[0]
        .replace(/^\/\/ ?/gm, ""),
    );
    process.exit(0);
  }
  const unknown = args.find((a) => !["--dry-run", "--json"].includes(a));
  if (unknown) {
    console.error(`bye: unknown option ${unknown} (--dry-run, --json)`);
    process.exit(1);
  }
  let facts;
  try {
    facts = gather();
  } catch (e) {
    console.error(`bye: couldn't gather the facts: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  const verdict = byeVerdict(facts);
  if (json) console.log(JSON.stringify({ facts, verdict }, null, 2));
  else for (const line of byeLines(facts, verdict, { dryRun })) console.log(line);
  if (!verdict.clean) process.exit(OPEN);
  if (dryRun || json || facts.role === "slice") process.exit(0);
  for (const l of verdict.release) rmSync(l.path, { recursive: true, force: true });
  if (!facts.sessionPid && !facts.recorded) {
    console.error("bye: no session to end: this shell isn't under a claude process.");
    process.exit(1);
  }
  // end-session.sh prints its own line, then ends the session (and with it, this command).
  const r = spawnSync("bash", [join(here, "end-session.sh"), ...(facts.recorded ? [facts.name] : [])], {
    stdio: "inherit",
  });
  process.exit(r.status ?? 1);
}
