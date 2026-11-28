// Session records: .loops/.sessions/<name>.json, one per session started
// through session.sh: an orchestrator, planner, backlog, hotfix, recovery or inbox
// session (pid, kind, topic, started, command, model, remote, dir, auto, managed (the dispatcher started it), rotating, and ended and
// exit once it has exited). A record
// stays after its session exits and goes with its worktree (rm.sh), so "no
// live session" is a pid check.
//
// The pure part decides; the CLI gathers the facts (ps) and acts.
//
//   - isLive(record, proc, now): a record is live while it has no `ended`, its
//     pid exists and that process started when the record says (within
//     START_SLACK_MS), so a reused pid isn't taken for the session.
//   - ancestorClaude(pid, table, name): walking parent pids up from PID, the
//     first process whose command (or its script, for `bash <stub>`) is NAME:
//     the calling shell's own claude, for a session started before the wrapper.
//   - endTarget(name, record, facts): the claude process `prd end <name>`
//     may end (B-810): the record's pid only while it is a claude process of
//     that session (under `session.sh <name>`, or running in the record's dir),
//     else the one live claude under `session.sh <name>` in that dir (a reopen
//     the record doesn't name), else a refusal: never another process.
//   - liveIn(dir, { table, cwdOf, claude }): the live claude pids whose working
//     directory is DIR or under it, recorded or not (finish.mjs, tidy).
//
// CLI (RISA_SESSIONS_DIR: the records' folder, default .loops/.sessions of
// the main checkout):
//   node sessions.mjs set <name> key=value…   merge fields into the record (made
//                                             if missing); pid and exit are
//                                             numbers, auto, managed and
//                                             rotating booleans; key= removes
//                                             the key; --if-pid <pid> (before
//                                             the fields) writes only while the
//                                             record's pid is PID, else exit 3
//                                             and leaves it (a wrapper ending a
//                                             session a newer one replaced)
//   node sessions.mjs get <name>              the record as JSON (exit 1: none)
//   node sessions.mjs list [--json]           every record, live or ended
//   node sessions.mjs live <name>             its pid when live (exit 1 if not)
//   node sessions.mjs ancestor [<pid>]        the ancestor claude's pid (from the
//                                             CLI's parent by default; exit 1: none)
//   node sessions.mjs self [<name>]           the calling session: "<pid> record"
//                                             when NAME's record is live, else
//                                             "<pid> ancestor" (exit 1: neither)
//   node sessions.mjs target <name>           the process `prd end <name>` ends
//                                             (endTarget): "<pid> record", or
//                                             "<pid> reopened <stale pid>" (the
//                                             record is set to that pid first);
//                                             exit 4: it has ended; exit 1: refused,
//                                             saying why
//   node sessions.mjs caller                  the live record of the calling shell's
//                                             ancestor claude: "<name>\t<kind>\t<pid>\t<topic>"
//                                             (exit 1, saying why: no ancestor, or
//                                             it has no live record)
// The claude name is basename($RISA_CLAUDE_BIN), default claude (host.mjs).
//
// Under Vitest (VITEST set, and inherited by every script a test runs), a write
// to a `.loops/.sessions` outside the OS temp dir is refused (B-871): a test
// that forgets to name its own records' folder, and inherits the session's (the
// real one, which session.sh exports), fails instead of overwriting live records.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { claudeName as hostClaudeName } from "./host.mjs";

/** How far a process's start may be from the record's `started`. */
export const START_SLACK_MS = 60_000;

/** ps's etime ([[dd-]hh:]mm:ss) in seconds, or null when it doesn't parse. */
export function parseEtime(/** @type {string} */ s) {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(s ?? "");
  if (!m) return null;
  const [, d = "0", h = "0", mi, se] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(mi)) * 60 + Number(se);
}

/**
 * @typedef {{ pid?: number, kind?: string, topic?: string, started?: string, command?: string, model?: string,
 *   remote?: string, dir?: string, auto?: boolean, managed?: boolean, rotating?: boolean, ended?: string, exit?: number }} SessionRecord
 */

/**
 * @param {SessionRecord} record
 * @param {{ startedMs: number } | null} proc the record's pid's process, or null when there is none
 * @param {number} now
 */
export function isLive(record, proc, now = Date.now()) {
  if (!record || record.ended || !record.pid || !proc) return false;
  const started = Date.parse(record.started ?? "");
  if (Number.isNaN(started) || started > now + START_SLACK_MS) return false;
  return Math.abs(proc.startedMs - started) <= START_SLACK_MS;
}

/** Whether a ps command line runs NAME: as the command, or as the script of an interpreter. */
export function runs(/** @type {string} */ args, /** @type {string} */ name) {
  const words = (args ?? "").trim().split(/\s+/).slice(0, 2);
  return words.some((w) => basename(w) === name);
}

/**
 * @param {number} pid where the walk starts (not itself a candidate)
 * @param {Map<number, { ppid: number, args: string }>} table every process
 * @param {string} name
 * @returns {number | null}
 */
export function ancestorClaude(pid, table, name) {
  const seen = new Set();
  let p = table.get(pid)?.ppid;
  while (p && p > 1 && !seen.has(p)) {
    seen.add(p);
    const row = table.get(p);
    if (!row) return null;
    if (runs(row.args, name)) return p;
    p = row.ppid;
  }
  return null;
}

/** The session name a `session.sh <name> …` command line runs (as the command or bash's script), or null. */
export function wrapperName(/** @type {string} */ args) {
  const words = (args ?? "").trim().split(/\s+/);
  const shell = /^(ba|z|da)?sh$/.test(basename(words[0] ?? ""));
  const i =
    basename(words[0] ?? "") === "session.sh"
      ? 0
      : shell && basename(words[1] ?? "") === "session.sh"
        ? 1
        : -1;
  return i < 0 ? null : (words[i + 1] ?? null);
}

/**
 * The name of the session.sh nearest above PID, or null when there is none or
 * another claude comes first (PID is then a process inside some session, not its claude).
 * @param {number} pid
 * @param {Map<number, { ppid: number, args: string }>} table
 * @param {string} claude
 */
export function wrappedAs(pid, table, claude) {
  const seen = new Set();
  let p = table.get(pid)?.ppid;
  while (p && p > 1 && !seen.has(p)) {
    seen.add(p);
    const row = table.get(p);
    if (!row) return null;
    const w = wrapperName(row.args);
    if (w) return w;
    if (runs(row.args, claude)) return null;
    p = row.ppid;
  }
  return null;
}

/**
 * Which process `prd end <name>` ends (B-810: a reopened session's record
 * once named an older pid, and end killed that instead of the live session).
 *
 * The record's pid only while the record is live and the pid is a claude
 * process of this session: under `session.sh <name>`, running in the
 * record's dir (a session whose wrapper is gone), or the caller's own ancestor
 * claude (a session ending itself, `prd bye`). Otherwise the one live claude
 * right under `session.sh <name>` in the record's dir: a reopen whose record
 * still names the old pid. Two such sessions, or a pid that isn't the
 * session's, are refused: it never ends a process it can't tie to the session.
 *
 * @param {string} name
 * @param {SessionRecord | null} record
 * @param {{ live: boolean, table: Map<number, { ppid: number, args: string }>, claude: string,
 *   cwdOf: (pid: number) => string | null, caller?: number | null }} facts
 * @returns {{ pid: number, how: "record" | "reopened" } | { ended: true } | { refuse: string }}
 */
export function endTarget(name, record, { live, table, claude, cwdOf, caller = null }) {
  const dir = record?.dir;
  const isClaude = (/** @type {number} */ pid) => runs(table.get(pid)?.args ?? "", claude);
  const inDir = (/** @type {number} */ pid) => !!dir && cwdOf(pid) === dir;
  const ofSession = (/** @type {number} */ pid) =>
    isClaude(pid) && (pid === caller || wrappedAs(pid, table, claude) === name || inDir(pid));
  const pid = record?.pid ?? 0;
  const recordOk = live && pid > 0 && ofSession(pid);
  const wrapped = [...table.keys()].filter(
    (p) => isClaude(p) && wrappedAs(p, table, claude) === name && (!dir || inDir(p)),
  );
  const others = wrapped.filter((p) => p !== pid);
  if (recordOk && !others.length) return { pid, how: "record" };
  if (others.length > 1 || (recordOk && others.length))
    return {
      refuse: `${name} has more than one live claude (pids ${[...new Set([...(recordOk ? [pid] : []), ...others])].join(", ")}): refusing to guess which to end`,
    };
  if (others.length === 1) return { pid: /** @type {number} */ (others[0]), how: "reopened" };
  if (!live) return { ended: true };
  const row = table.get(pid);
  const what = !row
    ? "no such process"
    : isClaude(pid)
      ? `a claude neither under session.sh ${name}, nor in ${dir ?? "its record's dir"}, nor this shell's own`
      : `it runs ${row.args.slice(0, 80)}`;
  return { refuse: `pid ${pid} in ${name}'s record isn't its claude (${what}): refusing to end it` };
}

/**
 * The live claude processes working in DIR (their cwd is DIR or under it), by pid.
 * @param {string} dir a real path
 * @param {{ table: Map<number, { ppid: number, args: string }>, cwdOf: (pid: number) => string | null,
 *   claude: string }} facts
 * @returns {number[]}
 */
export function liveIn(dir, { table, cwdOf, claude }) {
  const root = dir.replace(/\/+$/, "");
  if (!root) return [];
  return [...table.keys()].filter((pid) => {
    if (!runs(table.get(pid)?.args ?? "", claude)) return false;
    const cwd = cwdOf(pid);
    return !!cwd && (cwd === root || cwd.startsWith(`${root}/`));
  });
}

/** PID's working directory (its real path), or null when it can't be read. */
export function cwdOf(/** @type {number} */ pid) {
  const real = (/** @type {string} */ p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  try {
    return realpathSync(`/proc/${pid}/cwd`);
  } catch {
    // Not Linux: lsof.
  }
  try {
    const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = out.split("\n").find((l) => l.startsWith("n"));
    return line ? real(line.slice(1)) : null;
  } catch {
    return null;
  }
}

/** ps -A's pid, ppid and command lines. */
export function processTable() {
  const out = execFileSync("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "args="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  /** @type {Map<number, { ppid: number, args: string }>} */
  const table = new Map();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), args: m[3] });
  }
  return table;
}

/** The process PID, with its start time, or null when it doesn't exist (or is a zombie). */
export function processOf(/** @type {number} */ pid, now = Date.now()) {
  if (!pid) return null;
  try {
    const out = execFileSync("ps", ["-o", "stat=", "-o", "etime=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const [stat, etime] = out.split(/\s+/);
    if (!stat || stat.startsWith("Z")) return null;
    const secs = parseEtime(etime);
    return secs === null ? null : { startedMs: now - secs * 1000 };
  } catch {
    return null;
  }
}

/** The name claude's processes show (the host layer's). */
export const claudeName = () => hostClaudeName();

export const defaultDir = () => {
  if (process.env.RISA_SESSIONS_DIR) return process.env.RISA_SESSIONS_DIR;
  if (process.env.RISA_MAIN) return join(process.env.RISA_MAIN, ".loops", ".sessions");
  const here = dirname(fileURLToPath(import.meta.url));
  const first = execFileSync("git", ["-C", here, "worktree", "list", "--porcelain"], { encoding: "utf8" })
    .split("\n")[0]
    .replace(/^worktree /, "");
  return join(first, ".loops", ".sessions");
};

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const fileOf = (/** @type {string} */ dir, /** @type {string} */ name) => {
  if (!NAME.test(name)) throw new Error(`not a session name: ${name}`);
  return join(dir, `${name}.json`);
};

/** @returns {SessionRecord | null} */
export function readRecord(/** @type {string} */ dir, /** @type {string} */ name) {
  const f = fileOf(dir, name);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

/** Every record in DIR, by name. */
export function readRecords(/** @type {string} */ dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ name: f.slice(0, -5), record: readRecord(dir, f.slice(0, -5)) }))
    .filter((r) => r.record !== null);
}

/** The fields a set's key=value words give (pid, exit: numbers; auto, managed, rotating: booleans; key=: removed). */
export function parseFields(/** @type {string[]} */ words) {
  /** @type {Record<string, unknown>} */
  const fields = {};
  for (const w of words) {
    const i = w.indexOf("=");
    if (i < 1) throw new Error(`set: key=value, not ${w}`);
    const key = w.slice(0, i);
    const value = w.slice(i + 1);
    if (value === "") fields[key] = undefined;
    else if (key === "pid" || key === "exit") fields[key] = Number(value);
    else if (key === "auto" || key === "managed" || key === "rotating")
      fields[key] = value === "true" || value === "1";
    else fields[key] = value;
  }
  return fields;
}

/** P's real path, through its nearest existing ancestor when P doesn't exist yet. */
const realish = (/** @type {string} */ p) => {
  const rest = [];
  let cur = resolve(p);
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    rest.unshift(basename(cur));
    cur = up;
  }
  return join(realpathSync(cur), ...rest);
};

/**
 * Why a write to DIR is refused, or null: under Vitest (ENV.VITEST), a
 * `.loops/.sessions` that isn't inside the OS temp dir is a real checkout's.
 */
export function liveDirRefusal(/** @type {string} */ dir, env = process.env, tmp = tmpdir()) {
  if (!env.VITEST) return null;
  const real = realish(dir);
  if (!real.endsWith(`${sep}.loops${sep}.sessions`)) return null;
  const t = realish(tmp);
  if (real.startsWith(t.endsWith(sep) ? t : t + sep)) return null;
  return `sessions.mjs: refusing to write session records into ${real} under Vitest: a test names a records' folder in a temp dir (B-871)`;
}

/**
 * Merges FIELDS into NAME's record (undefined removes a key), written atomically.
 * With `ifPid`, only while the record's pid is that pid: otherwise nothing is
 * written and it returns null (the record belongs to a newer session).
 */
export function writeRecord(
  /** @type {string} */ dir,
  /** @type {string} */ name,
  /** @type {Record<string, unknown>} */ fields,
  /** @type {{ ifPid?: number }} */ { ifPid } = {},
) {
  const refusal = liveDirRefusal(dir);
  if (refusal) throw new Error(refusal);
  mkdirSync(dir, { recursive: true });
  const current = readRecord(dir, name);
  if (ifPid !== undefined && current?.pid !== ifPid) return null;
  const next = { ...(current ?? {}), ...fields };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  const f = fileOf(dir, name);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, f);
  return next;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...args] = process.argv.slice(2);
  const fail = (/** @type {string} */ msg, code = 1) => {
    if (msg) console.error(msg);
    process.exit(code);
  };
  try {
    const dir = defaultDir();
    const liveRecord = (/** @type {string} */ name) => {
      const r = readRecord(dir, name);
      return r && isLive(r, processOf(r.pid ?? 0)) ? r : null;
    };
    const ancestor = (/** @type {number} */ from) => ancestorClaude(from, processTable(), claudeName());
    switch (cmd) {
      case "set": {
        const [name, ...rest] = args;
        if (!name) fail("usage: sessions.mjs set <name> [--if-pid <pid>] key=value…", 2);
        let ifPid;
        if (rest[0] === "--if-pid") {
          ifPid = Number(rest[1]);
          if (!Number.isInteger(ifPid) || ifPid <= 0) fail("set: --if-pid <pid>", 2);
          rest.splice(0, 2);
        }
        if (!writeRecord(dir, name, parseFields(rest), { ifPid })) {
          const pid = readRecord(dir, name)?.pid;
          fail(`set: ${name}'s record is pid ${pid ?? "none"}, not ${ifPid}; left as it is`, 3);
        }
        break;
      }
      case "get": {
        const r = args[0] ? readRecord(dir, args[0]) : null;
        if (!r) fail("");
        console.log(JSON.stringify(r));
        break;
      }
      case "list": {
        const rows = readRecords(dir).map(({ name, record }) => ({
          name,
          ...record,
          live: isLive(record, processOf(record.pid ?? 0)),
        }));
        if (args.includes("--json")) console.log(JSON.stringify(rows));
        else
          for (const r of rows)
            console.log(`${r.name}\t${r.live ? "live" : "ended"}\t${r.pid ?? ""}\t${r.started ?? ""}`);
        break;
      }
      case "live": {
        const r = args[0] ? liveRecord(args[0]) : null;
        if (!r) fail("");
        console.log(r.pid);
        break;
      }
      case "ancestor": {
        const p = ancestor(args[0] ? Number(args[0]) : process.pid);
        if (!p) fail("");
        console.log(p);
        break;
      }
      case "self": {
        const r = args[0] ? liveRecord(args[0]) : null;
        if (r) console.log(`${r.pid} record`);
        else {
          const p = ancestor(process.pid);
          if (!p) fail("");
          console.log(`${p} ancestor`);
        }
        break;
      }
      case "target": {
        const name = args[0];
        if (!name) fail("usage: sessions.mjs target <name>", 2);
        const r = readRecord(dir, /** @type {string} */ (name));
        if (!r) fail(`end: no session record ${name}`);
        const live = !!r && isLive(r, processOf(r.pid ?? 0));
        const table = processTable();
        const t = endTarget(/** @type {string} */ (name), r, {
          live,
          table,
          claude: claudeName(),
          cwdOf,
          caller: ancestorClaude(process.pid, table, claudeName()),
        });
        if ("ended" in t) fail("", 4);
        else if ("refuse" in t) fail(`end: ${t.refuse}`);
        else if (t.how === "record") console.log(`${t.pid} record`);
        else {
          // The record takes the live session's pid, so its wrapper records the end.
          const proc = processOf(t.pid);
          const started = new Date(proc ? proc.startedMs : Date.now())
            .toISOString()
            .replace(/\.\d{3}Z$/, "Z");
          writeRecord(dir, /** @type {string} */ (name), {
            pid: t.pid,
            started,
            ended: undefined,
            exit: undefined,
          });
          console.log(`${t.pid} reopened ${r?.pid ?? "none"}`);
        }
        break;
      }
      case "caller": {
        const p = ancestor(process.pid);
        if (!p) fail("this shell isn't under a claude process");
        const proc = processOf(p ?? 0);
        const hit = readRecords(dir).find(({ record }) => record?.pid === p && isLive(record, proc));
        if (!hit) fail(`its claude (pid ${p}) has no live session record`);
        else console.log([hit.name, hit.record?.kind || "unknown", p, hit.record?.topic ?? ""].join("\t"));
        break;
      }
      default:
        fail("usage: sessions.mjs set|get|list|live|ancestor|self|target|caller …", 2);
    }
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}
