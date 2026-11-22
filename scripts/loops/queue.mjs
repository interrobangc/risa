#!/usr/bin/env node
// pnpm prd queue <topic>: put a topic first in the PRD registry (row order is
// the priority, so the dispatcher takes it next when it may run) and return at
// once. It prints one line: that the running dispatcher will take it, or that
// none is running (start one, or start the topic by hand).
//
// The move is `pnpm backlog prd move <topic> --first` (one backlog commit on
// dev); a topic already first isn't moved again. Nothing waits and nothing is
// started here: the dispatcher (dispatch.mjs) does the starting.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lockHolder, mainCheckout, pathsOf, readState } from "./dispatch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKLOG = join(HERE, "../backlog/backlog.mjs");

/** The line queue prints, from whether a dispatcher runs (its pid) and whether it is paused. */
export function queueLine(
  /** @type {string} */ topic,
  /** @type {{ pid: number | null, paused?: { why?: string } | null, moved: boolean }} */ s,
) {
  const where = s.moved
    ? `${topic} is first in the PRD registry now`
    : `${topic} is already first in the PRD registry`;
  if (!s.pid)
    return `${where}, but no dispatcher is running: start one in a tab of its own (pnpm prd dispatch), or start ${topic} by hand (pnpm prd start ${topic}).`;
  const paused = s.paused ? ` It is paused (${s.paused.why || "by hand"}): pnpm prd dispatch --resume.` : "";
  return `${where}: the dispatcher (pid ${s.pid}) takes it as soon as it may run (pnpm prd dispatch --dry-run says why not).${paused}`;
}

const backlog = (/** @type {string[]} */ args) => {
  const r = spawnSync("node", [BACKLOG, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "-h" || args[0] === "--help") {
    console.log("pnpm prd queue <topic>: put it first in the PRD registry, for the dispatcher to take next");
    return;
  }
  const [topic, ...rest] = args;
  if (!topic || rest.length) {
    console.error("usage: pnpm prd queue <topic> (it takes no options)");
    process.exit(2);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(topic)) {
    console.error(`pnpm prd: "${topic}" isn't a topic (lowercase letters, digits, -)`);
    process.exit(2);
  }
  const listed = backlog(["prd", "list", "--json"]);
  if (!listed.ok) {
    console.error(`pnpm prd: ${listed.err || listed.out}`);
    process.exit(1);
  }
  const rows = /** @type {{ topic: string }[]} */ (JSON.parse(listed.out));
  if (!rows.some((r) => r.topic === topic)) {
    console.error(`pnpm prd: no PRD row "${topic}" (add it with pnpm backlog prd add ${topic} --first)`);
    process.exit(1);
  }
  const moved = rows[0]?.topic !== topic;
  if (moved) {
    const r = backlog(["prd", "move", topic, "--first"]);
    if (!r.ok) {
      console.error(`pnpm prd: ${r.err || r.out}`);
      process.exit(1);
    }
  }
  const p = pathsOf(mainCheckout(HERE));
  console.log(queueLine(topic, { pid: lockHolder(p.lock), paused: readState(p.state).paused, moved }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
