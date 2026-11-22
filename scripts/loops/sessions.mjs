// Session records: .loops/.sessions/<name>.json, one per orchestrator or
// planner session started through session.sh (pid, kind, topic, started,
// command, auto, managed (the dispatcher started it), rotating, and ended and
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
//
// CLI (CARETOOK_SESSIONS_DIR: the records' folder, default .loops/.sessions of
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
// The claude name is basename($CARETOOK_CLAUDE_BIN), default claude.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
 * @typedef {{ pid?: number, kind?: string, topic?: string, started?: string, command?: string,
 *   auto?: boolean, managed?: boolean, rotating?: boolean, ended?: string, exit?: number }} SessionRecord
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

export const claudeName = () => basename(process.env.CARETOOK_CLAUDE_BIN || "claude");

const defaultDir = () => {
  if (process.env.CARETOOK_SESSIONS_DIR) return process.env.CARETOOK_SESSIONS_DIR;
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
      default:
        fail("usage: sessions.mjs set|get|list|live|ancestor|self …", 2);
    }
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}
