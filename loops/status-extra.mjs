// The parts `prd status` prints after the worktree table: the dispatcher
// (running, its code current or stale, paused and why, or stopped, and its log's last entry), the recorded
// sessions (.loops/.sessions: name, kind, live or ended, age, run-through or not,
// managed by the dispatcher or opened by hand) and the open asks (the count,
// split into questions awaiting an answer, reports and those decided for you;
// the oldest awaiting one, else the oldest, and its age), and the workers: every lease
// holder (and waiter), every `prd` command under a live session and every slice
// agent, each with its age, its usual time (metrics.mjs) and its state. The sessions,
// asks and workers parts print nothing, heading included, when they have nothing to
// show; the dispatcher's always prints.
// Ended sessions older than a day are left out to keep the list short.
//
//   node status-extra.mjs      RISA_SESSIONS_DIR and RISA_ASKS_DIR name the folders;
//                              the dispatcher's files are in the main checkout's .loops
//                              (RISA_DISPATCH_MAIN names another main checkout); the
//                              workers' worktrees, heartbeats, leases (RISA_LEASE_ROOT,
//                              RISA_BROWSER_LEASES) and logs (RISA_RUN_LOG,
//                              RISA_CHECK_LOG) are beside the sessions folder
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { age, awaitsAnswer, listAsks, shorten, span } from "./asks.mjs";
import { contextDirOf, hardLimitFor, limitOf, sizeNote, sizeRecord } from "./context.mjs";
import {
  codeHash,
  codeTarget,
  linkedRoot,
  lockHolder,
  mainCheckout,
  pathsOf,
  readState,
  staleCode,
} from "./dispatch.mjs";
import { branchKind, readData, usualTime } from "./metrics.mjs";
import { pendingPart } from "./session-requests.mjs";
import { isLive, processOf, readRecords } from "./sessions.mjs";
import { ancestorsOf, processCwds, readLeases, workerFacts } from "./workers.mjs";
import { branchKinds, toolCmd } from "./config.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How much of the dispatcher's log's end is read for its last entry. */
const LOG_TAIL_BYTES = 64 * 1024;

/** The first line of the log's last entry (entries start unindented; their reasons are indented). */
export function lastEntry(/** @type {string} */ file) {
  let text;
  try {
    const size = statSync(file).size;
    const n = Math.min(size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(n);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buf, 0, n, size - n);
    } finally {
      closeSync(fd);
    }
    text = buf.toString("utf8");
  } catch {
    return null;
  }
  const heads = text.split("\n").filter((l) => l && !/^\s/.test(l));
  return heads.length ? heads[heads.length - 1] : null;
}

/** The tool folder status runs from: a dispatcher's own when its record predates `root`. */
const STATUS_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The folder a running dispatcher compares its code with (dispatch.mjs's
 * codeTarget): the one the `risa` link points to now when it follows the link (a
 * release install), else its own folder.
 * @param {import("./dispatch.mjs").DispatchState["code"]} code
 */
export const targetOf = (code) =>
  codeTarget(code?.root ?? STATUS_ROOT, code?.follows, code?.follows ? linkedRoot() : null);

/**
 * The dispatcher's code against its target's (ROOT, the folder; CURRENT: its hash,
 * null unreadable): "" when unknown, else ", code current" or ", code stale …",
 * naming the dispatch.mjs it re-execs onto. A running dispatcher with no code
 * record of its pid started before the check (B-809).
 * @param {import("./dispatch.mjs").DispatchState["code"]} code
 * @param {number} pid @param {string | null} current @param {string} [root]
 */
export function codePart(code, pid, current, root = STATUS_ROOT) {
  if (!code || code.pid !== pid)
    return `, code unknown (it predates the code check: ${toolCmd.prd} dispatch --stop, then ${toolCmd.prd} dispatch)`;
  if (!current) return "";
  const where = code.follows ? "the release installed now" : "the tool's checkout";
  return staleCode(code.hash, current)
    ? `, code stale (${code.hash}; ${where} has ${current}: it re-execs onto ${join(root, "loops", "dispatch.mjs")} before its next tick)`
    : ", code current";
}

/**
 * The pid a lock file names, alive or not: null with no lock or no pid in it. The
 * dispatcher removes its lock on a clean stop (SIGTERM, SIGINT, exit), so a lock
 * naming a gone pid is one that died (RISA-1030).
 */
export function lockPid(/** @type {string} */ lock) {
  try {
    const pid = Number(readFileSync(lock, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Whether PID is a live process (EPERM: alive, someone else's). */
const pidAlive = (/** @type {number} */ pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
};

/**
 * The dispatcher's part: its state from its lock (a live pid: running; a gone
 * one: dead, no clean stop; none: stopped), its
 * code (current or stale against targetOf's folder) and its state file (paused and
 * why), its log's last entry (the last logged change) and its last tick's time.
 * @param {{ main?: string, lock: string, state: string, log: string }} files
 * @param {{ now?: number, holder?: (lock: string) => number | null,
 *   target?: (code: import("./dispatch.mjs").DispatchState["code"]) => string,
 *   current?: (root: string) => string | null, raw?: (lock: string) => number | null,
 *   alive?: (pid: number) => boolean }} [opts] raw: the lock's pid, alive or not
 */
export function dispatcherPart(
  files,
  {
    now = Date.now(),
    holder = lockHolder,
    target = targetOf,
    current = codeHash,
    raw = lockPid,
    alive = pidAlive,
  } = {},
) {
  const pid = holder(files.lock);
  const named = pid ? null : raw(files.lock);
  const gone = named !== null && !alive(named) ? named : null;
  const st = readState(files.state);
  const paused = st.paused;
  const since = paused?.at && !Number.isNaN(Date.parse(paused.at)) ? `, ${age(paused.at, now)} ago` : "";
  const why = paused ? `paused${since}: ${paused.why || "by hand"}` : "";
  const root = pid && st.code?.pid === pid ? target(st.code) : STATUS_ROOT;
  const code = pid ? codePart(st.code, pid, st.code?.pid === pid ? current(root) : null, root) : "";
  // The tick's own heartbeat; a state an older release wrote has only the stuck watch's.
  const tickAt = typeof st.lastTickAt === "number" ? st.lastTickAt : st.stuck?.lastTickAt;
  const ticked = typeof tickAt === "number" && Number.isFinite(tickAt);
  const state = pid
    ? `running (pid ${pid})${code}${paused ? `, ${why} (${toolCmd.prd} dispatch --resume)` : ""}`
    : gone
      ? `dead (pid ${gone} gone; ${ticked ? `last tick ${span(now - tickAt)} ago, ` : ""}no clean stop)${paused ? `, and ${why}` : ""}: restart it with ${toolCmd.prd} dispatch --restart`
      : `stopped${paused ? ` (and ${why})` : ""}: start it in a tab of its own with ${toolCmd.prd} dispatch`;
  const last = lastEntry(files.log);
  const tick = ticked
    ? `last tick ${span(now - tickAt)} ago (${new Date(tickAt).toISOString().replace(/\.\d+Z$/, "Z")})`
    : "";
  const lines = last ? [`last: ${shorten(last, 120)}${tick ? ` · ${tick}` : ""}`] : tick ? [tick] : [];
  return [`DISPATCHER: ${state}`, ...lines, ""].join("\n") + "\n";
}

/**
 * @param {string} sessionsDir @param {string} asksDir
 * @param {{ now?: number, live?: (record: any) => boolean }} [opts] live: the liveness test (default: a pid check)
 * @returns {string} the parts, each ending in a newline, or ""
 */
export function statusParts(sessionsDir, asksDir, { now = Date.now(), live } = {}) {
  const isUp = live ?? ((/** @type {any} */ r) => isLive(r, processOf(r.pid ?? 0, now), now));
  const out = [];

  const rows = [];
  for (const { name, record } of readRecords(sessionsDir)) {
    const up = isUp(record);
    const since = Date.parse(record.started ?? "");
    const ended = Date.parse(record.ended ?? "");
    if (!up && !Number.isNaN(ended) && now - ended > DAY_MS) continue;
    rows.push([
      name,
      record.kind ?? "?",
      up ? (record.rotating ? "live, rotating" : "live") : "ended",
      Number.isNaN(since) ? "?" : age(record.started, now),
      record.auto ? "run-through" : "asks first",
      record.managed ? "managed" : "by hand",
      up
        ? sizeNote(sizeRecord(contextDirOf(sessionsDir), name, record.pid ?? 0), {
            limit: limitOf(process.env, record.kind),
            hard: hardLimitFor(record.kind),
            now,
          })
        : "",
    ]);
  }
  if (rows.length) {
    const w = [0, 1, 2, 3, 4].map((i) => Math.max(...rows.map((r) => r[i].length)));
    out.push("SESSIONS (ended over a day ago left out)");
    for (const r of rows)
      out.push(
        `${r
          .slice(0, 5)
          .map((c, i) => c.padEnd(w[i]))
          .join("  ")}  ${r[5]}${r[6] ? `  ${r[6]}` : ""}`,
      );
    out.push("");
  }

  const asks = existsSync(asksDir) ? listAsks(asksDir) : [];
  if (asks.length) {
    // Questions awaiting an answer, reports, and the questions decided for you, counted apart.
    const awaiting = asks.filter(awaitsAnswer);
    const defaulted = asks.filter((a) => a.defaulted);
    const reports = asks.filter((a) => a.kind === "report");
    const counts = [
      [awaiting.length, `question${awaiting.length === 1 ? "" : "s"} awaiting an answer`],
      [reports.length, `report${reports.length === 1 ? "" : "s"}`],
      [defaulted.length, "decided for you"],
    ].flatMap(([n, what]) => (n ? [`${n} ${what}`] : []));
    const o = awaiting[0] ?? asks[0];
    out.push(`OPEN ASKS: ${asks.length} (${toolCmd.prd} asks): ${counts.join(", ")}`);
    out.push(`oldest: ${o.id} ${o.kind} ${o.topic}, ${age(o.askedAt, now)} ago: ${shorten(o.text, 80)}`);
    out.push("");
  }
  return out.length ? out.join("\n") + "\n" : "";
}

/** How long an agent may go without a call before status calls it quiet. */
const QUIET_MS = 10 * 60_000;
/** How recent a slice worktree's progress or process must be to show its agent as unknown. */
const UNKNOWN_RECENT_MS = 30 * 60_000;

/** A `prd` command line's arguments ("check --quick …"), or null for any other process. */
export function prdArgs(/** @type {string} */ command) {
  const m =
    /^(?:\S*node\s+)?\S*\bpnpm(?:\.c?js)?\s+(?:(?:-s|--silent|-C\s+\S+|--dir\s+\S+)\s+)*prd(?:\s+(.*))?$/.exec(
      command,
    ) ?? /^(?:\S*bash\s+)?\S*\bprd\.sh(?:\s+(.*))?$/.exec(command);
  return m ? (m[1] ?? "").trim() : null;
}

/**
 * Every `prd` command under a live session: the outermost of each (pnpm, then the
 * prd.sh it runs, count once). Pure.
 * @param {{ pid: number, ppid: number, ageSeconds: number | null, command: string }[]} table
 * @param {Map<number, string>} sessions a live session's pid to its name
 * @returns {{ session: string, pid: number, args: string, ageSeconds: number | null }[]}
 */
export function prdCommands(table, sessions) {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const out = [];
  for (const p of table) {
    const args = prdArgs(p.command);
    if (args === null) continue;
    const up = ancestorsOf(p.ppid, table);
    const session = up.find((pid) => sessions.has(pid));
    if (session === undefined) continue;
    // A prd above this one, below the session: this is its prd.sh.
    const below = up.slice(0, up.indexOf(session));
    if (below.some((pid) => prdArgs(byPid.get(pid)?.command ?? "") !== null)) continue;
    out.push({ session: sessions.get(session) ?? "?", pid: p.pid, args, ageSeconds: p.ageSeconds });
  }
  return out;
}

/** "usual 9m" from a usualTime answer, or "usual -" with no samples. */
const usualNote = (/** @type {ReturnType<typeof usualTime> | null} */ u) =>
  u?.medianSeconds != null ? `usual ${span(u.medianSeconds * 1000)}` : "usual -";

/** "slow" past the slowest usual sample (with at least three), else "". Pure. */
export function againstUsual(
  /** @type {number | null} */ seconds,
  /** @type {ReturnType<typeof usualTime> | null} */ u,
) {
  if (seconds === null || !u || u.samples < 3 || u.slowestSeconds === null) return "";
  return seconds > u.slowestSeconds ? "slow" : "";
}

/** A call or process "Bash: prd check --quick" for an agent's state. */
const callNote = (/** @type {any} */ c) =>
  shorten(
    c.command ? `${c.source === "process" ? `pid ${c.pid}` : c.tool}: ${c.command}` : (c.tool ?? "?"),
    60,
  );

/**
 * The workers part. Pure.
 * @param {{ facts: ReturnType<typeof workerFacts>, leases: ReturnType<typeof readLeases>,
 *   commands: ReturnType<typeof prdCommands>, usual: (q: Parameters<typeof usualTime>[1]) => ReturnType<typeof usualTime> | null,
 *   now: number }} input `leases`: every live lease, `facts` the worktrees
 * @returns {string} the part ending in a blank line, or ""
 */
export function workersPart({ facts, leases, commands, usual, now }) {
  const byName = new Map(facts.map((f) => [f.name, f]));
  /** @type {string[][]} */
  const rows = [];
  const row = (
    /** @type {string} */ what,
    /** @type {string} */ who,
    /** @type {string} */ doing,
    /** @type {number | null} */ secs,
    /** @type {ReturnType<typeof usualTime> | null} */ u,
    /** @type {string} */ state,
  ) => {
    const slow = againstUsual(secs, u);
    rows.push([
      what,
      who,
      shorten(doing, 50),
      secs === null ? "?" : span(secs * 1000),
      usualNote(u),
      [state, slow].filter(Boolean).join(", "),
    ]);
  };
  const secsSince = (/** @type {string | null | undefined} */ t) => {
    const ms = Date.parse(t ?? "");
    return Number.isNaN(ms) ? null : Math.max(0, Math.round((now - ms) / 1000));
  };

  for (const l of leases) {
    const w = byName.get(l.worktree);
    const mode = /\((quick|slice|full)\)/.exec(l.what)?.[1];
    const u =
      l.kind === "check" && !l.waiting
        ? usual({ kind: "check", mode, branchKind: w ? branchKind(w.branch) : undefined })
        : null;
    row(
      `lease ${l.kind} ${l.waiting ? "queued" : l.n}`,
      l.worktree,
      l.what || "?",
      secsSince(l.started),
      u,
      l.waiting ? "waiting" : "held",
    );
  }

  for (const c of commands) {
    const verb = c.args.split(/\s+/)[0];
    const u =
      verb === "check" ? usual({ kind: "check" }) : verb === "land" ? usual({ kind: "landing" }) : null;
    row("command", c.session, `${toolCmd.prd} ${c.args}`, c.ageSeconds, u, "running");
  }

  for (const f of facts) {
    if (!branchKinds().is(f.branch, "slice")) continue;
    const u = usual({ kind: "slice", branchKind: "slice" });
    const processes = f.running.filter((r) => r.source === "process");
    for (const a of f.agents) {
      if (!a.agent) continue;
      const calls = a.running.map((c) => ({ source: "call", ...c }));
      const last = secsSince(a.lastActivityAt);
      let state;
      if (calls.length) state = `running ${callNote(calls[0])}`;
      else if (a.stoppedAt && a.stoppedAt === a.lastActivityAt)
        state = `stopped ${age(a.stoppedAt, now)} ago`;
      else if (last !== null && last * 1000 >= QUIET_MS) state = `quiet ${span(last * 1000)}`;
      else state = `active${last === null ? "" : `, last call ${span(last * 1000)} ago`}`;
      if (processes.length && !calls.length) state += `; ${callNote(processes[0])}`;
      row(`agent ${a.agent.slice(0, 8)}`, f.name, a.session, secsSince(a.firstAt), u, state);
    }
    if (f.unknown) {
      const recent = [f.lastProgressAt, ...processes.map((p) => p.since)].some((t) => {
        const s = secsSince(t);
        return s !== null && s * 1000 < UNKNOWN_RECENT_MS;
      });
      if (processes.length || recent)
        row(
          "agent ?",
          f.name,
          "no heartbeat",
          null,
          u,
          `unknown${processes.length ? `; ${callNote(processes[0])}` : ""}`,
        );
    }
  }

  if (!rows.length) return "";
  const w = [0, 1, 2, 3, 4].map((i) => Math.max(...rows.map((r) => r[i].length)));
  const lines = ["WORKERS (age, usual time, state)"];
  for (const r of rows)
    lines.push(
      r
        .map((c, i) => (i < 5 ? c.padEnd(w[i]) : c))
        .join("  ")
        .trimEnd(),
    );
  return `${lines.join("\n")}\n\n`;
}

/**
 * The workers part, gathered: the worktrees in LOOPS, the heartbeats, leases and
 * processes, and the usual times from the logs. Any failure is no part.
 * @param {string} sessionsDir @param {{ now?: number, env?: NodeJS.ProcessEnv }} [opts]
 */
export function gatherWorkers(sessionsDir, { now = Date.now(), env = process.env } = {}) {
  const loops = dirname(sessionsDir);
  /** @type {Map<number, string>} */
  const live = new Map();
  for (const { name, record } of readRecords(sessionsDir))
    if (record.pid && isLive(record, processOf(record.pid, now), now)) live.set(record.pid, name);
  const leaseRoot = env.RISA_LEASE_ROOT || join(loops, ".lease");
  const browserRoot = env.RISA_BROWSER_LEASES || undefined;
  // The process table only when it's needed: commands need a live session, workerFacts a worktree.
  const table = live.size ? processCwds() : undefined;
  const facts = workerFacts({
    loops,
    sessionsDir,
    leaseRoot,
    browserRoot,
    processes: table,
    live: (session, pid) => live.get(pid) === session,
    now,
  });
  const leases = readLeases(leaseRoot, { browserRoot }).filter((l) => l.live);
  const commands = table ? prdCommands(table, live) : [];
  if (!leases.length && !commands.length && !facts.some((f) => branchKinds().is(f.branch, "slice")))
    return "";
  const data = readData({
    runLog: env.RISA_RUN_LOG || join(loops, ".run-log.jsonl"),
    checkLog: env.RISA_CHECK_LOG || join(loops, ".check-times.log"),
  });
  return workersPart({ facts, leases, commands, usual: (q) => usualTime(data, q), now });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const s = process.env.RISA_SESSIONS_DIR;
  const a = process.env.RISA_ASKS_DIR;
  if (!s || !a) {
    console.error("RISA_SESSIONS_DIR and RISA_ASKS_DIR must be set");
    process.exit(2);
  }
  let dispatcher = "";
  try {
    dispatcher = dispatcherPart(pathsOf(process.env.RISA_DISPATCH_MAIN || mainCheckout()));
  } catch {
    /* no git here: no dispatcher part */
  }
  let requests = "";
  try {
    requests = pendingPart(process.env.RISA_REQUESTS_DIR || join(dirname(s), ".requests"));
  } catch {
    /* an unreadable store: no requests part */
  }
  let workers = "";
  try {
    workers = gatherWorkers(s);
  } catch {
    /* unreadable: no workers part */
  }
  process.stdout.write(dispatcher + statusParts(s, a) + workers + requests);
}
