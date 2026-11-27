#!/usr/bin/env node
// What `land.sh` asks of the skeptic's records (skeptics.mjs): does a go cover
// this forced or unreviewed landing, and which Codex declines has the topic
// recorded since its last landing. A land verdict isn't spent, so a retry on the
// same tip works.
//
//   check --dir D --topic T --tip SHA --action force|no-review --id s1 [--id s2]
//       prints "s1 go: <why>" (exit 0), or the reason it doesn't count (exit 1)
//   declines --dir D --topic T   one line per decline verdict since the last landing
//   landed --dir D --topic T     marks the landing, after the merge
//
// The mark is `.landed-<topic>` beside the records; the store's listing ignores it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkRecord, getRecord, listRecords } from "./skeptics.mjs";

const markFile = (dir, topic) => join(dir, `.landed-${encodeURIComponent(topic)}`);

/**
 * The go that allows this action, from the ids given. A `no` on the same action
 * and tip refuses even beside a go. Pure, given the records.
 * @param {(object | null)[]} records
 * @param {{ topic: string, tip: string, action: string }} wanted
 * @param {{ now?: number, maxMin?: number }} [opts]
 * @returns {{ ok: true, record: any } | { ok: false, reason: string }}
 */
export function landGo(records, wanted, opts) {
  const refusal = records.find(
    (r) =>
      r?.kind === "land" &&
      r.topic === wanted.topic &&
      r.action === wanted.action &&
      r.tip === wanted.tip &&
      r.verdict === "no",
  );
  if (refusal) return { ok: false, reason: `the skeptic said no: ${refusal.why}` };
  const reasons = [];
  for (const record of records) {
    const result = checkRecord(record, { use: "land", ...wanted }, opts);
    if (result.ok) return { ok: true, record };
    reasons.push(result.reason);
  }
  return { ok: false, reason: reasons.join("; ") || "no skeptic record given" };
}

/** @param {any} r a land record @returns {string} the report's line for it */
export const verdictLine = (r) => `${r.id} ${r.verdict}: ${r.why}`;

/** When the topic last landed (ms), or 0. @param {string} dir @param {string} topic */
export function lastLanded(dir, topic) {
  try {
    const at = Date.parse(readFileSync(markFile(dir, topic), "utf8").trim());
    return Number.isFinite(at) ? at : 0;
  } catch (e) {
    if (e.code === "ENOENT") return 0;
    throw e;
  }
}

/** @param {string} dir @param {string} topic @param {number} [now] */
export function markLanded(dir, topic, now = Date.now()) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(markFile(dir, topic), new Date(now).toISOString() + "\n");
}

/** The topic's Codex-decline verdicts since its last landing, oldest first. */
export function declinesSince(dir, topic) {
  const since = lastLanded(dir, topic);
  return listRecords(dir, { topic }).filter(
    (r) => r.kind === "land" && r.action?.startsWith("decline ") && Date.parse(r.at) > since,
  );
}

function parse(argv) {
  const opts = { id: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.replace(/^--/, "");
    if (!["dir", "topic", "tip", "action", "id"].includes(name) || argv[i + 1] == null)
      throw new Error(`land-skeptic: bad argument ${argv[i]}`);
    if (name === "id") opts.id.push(argv[i + 1]);
    else opts[name] = argv[i + 1];
  }
  return opts;
}

function main([cmd, ...argv]) {
  const { dir, topic, tip, action, id } = parse(argv);
  if (!dir || !topic) throw new Error("land-skeptic: needs --dir and --topic");
  if (cmd === "check") {
    const result = landGo(
      id.map((i) => getRecord(dir, i)),
      { topic, tip, action },
    );
    console.log(result.ok ? verdictLine(result.record) : result.reason);
    return result.ok ? 0 : 1;
  }
  if (cmd === "declines") {
    for (const r of declinesSince(dir, topic))
      console.log(`${r.action.replace("decline ", "declining Codex thread ")}: ${verdictLine(r)}`);
    return 0;
  }
  if (cmd === "landed") {
    markLanded(dir, topic);
    return 0;
  }
  throw new Error(`land-skeptic: unknown command ${cmd}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
