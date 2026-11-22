// The two parts `pnpm prd status` prints after the worktree table: the recorded
// sessions (.loops/.sessions: name, live or ended, age, run-through or not,
// managed by the dispatcher or opened by hand) and
// the open asks (the count, the oldest and its age). A part with nothing to show
// prints nothing, heading included. Ended sessions older than a day are left
// out to keep the list short.
//
//   node status-extra.mjs      CARETOOK_SESSIONS_DIR and CARETOOK_ASKS_DIR name the folders
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { age, listAsks, shorten } from "./asks.mjs";
import { isLive, processOf, readRecords } from "./sessions.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

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
      up ? (record.rotating ? "live, rotating" : "live") : "ended",
      Number.isNaN(since) ? "?" : age(record.started, now),
      record.auto ? "run-through" : "asks first",
      record.managed ? "managed" : "by hand",
    ]);
  }
  if (rows.length) {
    const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i].length)));
    out.push("SESSIONS (ended over a day ago left out)");
    for (const r of rows)
      out.push(
        `${r
          .slice(0, 4)
          .map((c, i) => c.padEnd(w[i]))
          .join("  ")}  ${r[4]}`,
      );
    out.push("");
  }

  const asks = existsSync(asksDir) ? listAsks(asksDir) : [];
  if (asks.length) {
    const o = asks[0];
    out.push(`OPEN ASKS: ${asks.length} (pnpm prd asks)`);
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
  process.stdout.write(statusParts(s, a));
}
