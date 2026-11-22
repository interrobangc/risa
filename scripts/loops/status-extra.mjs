// The parts `pnpm prd status` prints after the worktree table: the dispatcher
// (running, paused and why, or stopped, and its log's last entry), the recorded
// sessions (.loops/.sessions: name, kind, live or ended, age, run-through or not,
// managed by the dispatcher or opened by hand) and the open asks (the count,
// split into questions awaiting an answer, reports and those decided for you;
// the oldest awaiting one, else the oldest, and its age). The sessions and asks parts print nothing, heading
// included, when they have nothing to show; the dispatcher's always prints.
// Ended sessions older than a day are left out to keep the list short.
//
//   node status-extra.mjs      CARETOOK_SESSIONS_DIR and CARETOOK_ASKS_DIR name the folders;
//                              the dispatcher's files are in the main checkout's .loops
//                              (CARETOOK_DISPATCH_MAIN names another main checkout)
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { age, awaitsAnswer, listAsks, shorten } from "./asks.mjs";
import { contextDirOf, sizeNote, sizeRecord } from "./context.mjs";
import { lockHolder, mainCheckout, pathsOf, readState } from "./dispatch.mjs";
import { isLive, processOf, readRecords } from "./sessions.mjs";

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

/**
 * The dispatcher's part: its state from its lock (a live pid: running) and its
 * state file (paused and why), and its log's last entry.
 * @param {{ lock: string, state: string, log: string }} files
 * @param {{ now?: number, holder?: (lock: string) => number | null }} [opts]
 */
export function dispatcherPart(files, { now = Date.now(), holder = lockHolder } = {}) {
  const pid = holder(files.lock);
  const paused = readState(files.state).paused;
  const since = paused?.at && !Number.isNaN(Date.parse(paused.at)) ? `, ${age(paused.at, now)} ago` : "";
  const why = paused ? `paused${since}: ${paused.why || "by hand"}` : "";
  const state = pid
    ? `running (pid ${pid})${paused ? `, ${why} (pnpm prd dispatch --resume)` : ""}`
    : `stopped${paused ? ` (and ${why})` : ""}: start it in a tab of its own with pnpm prd dispatch`;
  const last = lastEntry(files.log);
  return [`DISPATCHER: ${state}`, ...(last ? [`last: ${shorten(last, 120)}`] : []), ""].join("\n") + "\n";
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
      up ? sizeNote(sizeRecord(contextDirOf(sessionsDir), name, record.pid ?? 0), { now }) : "",
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
    out.push(`OPEN ASKS: ${asks.length} (pnpm prd asks): ${counts.join(", ")}`);
    out.push(`oldest: ${o.id} ${o.kind} ${o.topic}, ${age(o.askedAt, now)} ago: ${shorten(o.text, 80)}`);
    out.push("");
  }
  return out.length ? out.join("\n") + "\n" : "";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const s = process.env.CARETOOK_SESSIONS_DIR;
  const a = process.env.CARETOOK_ASKS_DIR;
  if (!s || !a) {
    console.error("CARETOOK_SESSIONS_DIR and CARETOOK_ASKS_DIR must be set");
    process.exit(2);
  }
  let dispatcher = "";
  try {
    dispatcher = dispatcherPart(pathsOf(process.env.CARETOOK_DISPATCH_MAIN || mainCheckout()));
  } catch {
    /* no git here: no dispatcher part */
  }
  process.stdout.write(dispatcher + statusParts(s, a));
}
