#!/usr/bin/env node
// Helpers for down.sh and recover.sh that are worth testing on their own. Pure
// functions, plus a small CLI the shell scripts call:
//
//   node recover-lib.mjs record <path> [--at ISO]   stdin: the inventory (JSON).
//       Writes the down record to <path> (merged with one already there, so a
//       second `down` never forgets what the first stopped), then prints what is
//       up now, one "<kind>\t<name>" line each: server, stack, test-db,
//       dispatcher (its pid).
//   node recover-lib.mjs actions                     stdin: the inventory (JSON).
//       Prints its actions, one "<step>\t<target>" line each.
//   node recover-lib.mjs until HH:MM <now-epoch-secs>
//       Prints the epoch second of the next HH:MM local time after now (today's,
//       or tomorrow's when it has passed).
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * What a `down` stops now: stacks with a running container, dev servers that
 * answer, the shared test Postgres, and the dispatcher.
 * @param {ReturnType<typeof import("./inventory.mjs").inventory>} inv
 */
export function upNow(inv) {
  return {
    stacks: inv.worktrees.filter((w) => w.stack && w.containersUp > 0).map((w) => w.name),
    servers: inv.worktrees.filter((w) => w.webPort && w.serverRunning).map((w) => w.name),
    testDb: !!inv.testDb?.running,
    dispatcher: !!inv.dispatcher?.running,
  };
}

/**
 * The down record: what is up now, merged with a record already there (a
 * second `down`, or one cut off halfway, sees things already stopped).
 * @param {{ stacks: string[], servers: string[], testDb: boolean, dispatcher?: boolean }} now
 * @param {{ stacks?: string[], servers?: string[], testDb?: boolean, dispatcher?: boolean } | null} previous
 * @param {string} at ISO time
 */
export function mergeRecord(now, previous, at) {
  const union = (/** @type {string[]} */ a, /** @type {string[] | undefined} */ b) => [
    ...new Set([...(b ?? []), ...a]),
  ];
  return {
    at,
    stacks: union(now.stacks, previous?.stacks),
    servers: union(now.servers, previous?.servers),
    testDb: now.testDb || previous?.testDb === true,
    dispatcher: now.dispatcher === true || previous?.dispatcher === true,
  };
}

/**
 * The epoch second of the next HH:MM local time after `nowSecs`.
 * @param {string} hhmm
 * @param {number} nowSecs
 */
export function nextTime(hhmm, nowSecs) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error(`not a time: ${hhmm} (HH:MM, 24-hour)`);
  const now = new Date(nowSecs * 1000);
  const t = new Date(now);
  t.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return Math.round(t.getTime() / 1000);
}

const readJson = (/** @type {string} */ p) => {
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "until") {
    console.log(nextTime(args[0] ?? "", Number(args[1])));
    return;
  }
  const inv = JSON.parse(readFileSync(0, "utf8"));
  if (cmd === "actions") {
    for (const a of inv.actions) console.log(`${a.step}\t${a.target ?? ""}`);
  } else if (cmd === "record") {
    const path = args[0];
    if (!path) throw new Error("record: give the record's path");
    const i = args.indexOf("--at");
    const at = i >= 0 ? args[i + 1] : new Date().toISOString();
    const now = upNow(inv);
    const record = mergeRecord(now, readJson(path), at);
    writeFileSync(`${path}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
    for (const n of now.servers) console.log(`server\t${n}`);
    for (const n of now.stacks) console.log(`stack\t${n}`);
    if (now.testDb) console.log("test-db\t");
    if (now.dispatcher) console.log(`dispatcher\t${inv.dispatcher.pid ?? ""}`);
  } else {
    console.error(`recover-lib: unknown command ${cmd} (record, actions, until)`);
    process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
