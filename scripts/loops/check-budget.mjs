// The check budget: how long a `pnpm prd check` may run, and how long it may go
// without printing, before check-run.sh stops it. Pure functions over the
// check log's runs (check-times.mjs parses them), plus a small CLI that
// check-run.sh calls.
//
// The budget: over the last 20 passing runs of the same mode (slice, quick,
// full) and branch kind (slice, prd, plan, hotfix, other), the larger of twice
// the median and the slowest plus 20%, scaled up for load, then held between
// the floor (10 minutes) and the hard limit (test-gates': CARETOOK_CHECK_LIMIT,
// else 20 minutes for a slice or quick check and 40 for a full one). With under
// five samples it is the hard limit. A floor above the hard limit gives way to it.
//
// Load scaling: the 5-minute load now against the median load the samples
// started at (15 when none recorded one), never below 1 and at most 3 times.
// The silence limit is CARETOOK_CHECK_SILENCE (480 s) scaled the same way.
// 480 s: the longest silent stretch measured in a check was its static step
// (tsc, ESLint and Prettier print only once all three finish), 67 to 133 s, at
// worst 261 s, so about twice that.
import { existsSync, readFileSync } from "node:fs";

import { parseLog } from "./check-times.mjs";
import { branchKind } from "./metrics.mjs";

export const DEFAULTS = Object.freeze({
  last: 20,
  minSamples: 5,
  floor: 600,
  silence: 480,
  refLoad: 15,
  maxScale: 3,
});

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** test-gates' hard limit for a mode: CARETOOK_CHECK_LIMIT when it's a number, else 1200 (2400 for full). */
export function hardLimit(mode, env = process.env) {
  const set = Number(env.CARETOOK_CHECK_LIMIT);
  if (env.CARETOOK_CHECK_LIMIT && Number.isFinite(set) && set > 0) return set;
  return mode === "full" ? 2400 : 1200;
}

/**
 * The budget and the silence limit for a check about to run.
 * @param {import("./check-times.mjs").Run[]} runs the check log's runs, in any order
 * @param {{ mode: string, branch: string, load?: number | null, ceiling: number, floor?: number,
 *   silence?: number, last?: number, minSamples?: number, refLoad?: number, maxScale?: number }} query
 * @returns {{ budget: number, silence: number, samples: number, medianSeconds: number | null,
 *   slowestSeconds: number | null, scale: number, from: "history" | "hard limit" }}
 */
export function checkBudget(runs, query) {
  const o = { ...DEFAULTS, ...query };
  const kind = branchKind(o.branch);
  const samples = runs
    .filter((r) => r.exit === 0 && r.mode === o.mode && branchKind(r.branch) === kind)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(-o.last);
  const secs = samples.map((r) => r.seconds);
  const loads = samples.map((r) => r.loadStart).filter((l) => Number.isFinite(l) && l > 0);
  const ref = median(loads) ?? o.refLoad;
  const load = Number(o.load);
  const scale = Number.isFinite(load) && load > 0 ? Math.min(o.maxScale, Math.max(1, load / ref)) : 1;
  const silence = Math.round(o.silence * scale);
  const medianSeconds = median(secs);
  const slowestSeconds = secs.length ? Math.max(...secs) : null;
  const base = { samples: secs.length, medianSeconds, slowestSeconds, scale, silence };
  if (secs.length < o.minSamples) return { ...base, budget: o.ceiling, from: "hard limit" };
  const usual = Math.max(2 * medianSeconds, 1.2 * slowestSeconds) * scale;
  const budget = Math.round(Math.min(o.ceiling, Math.max(Math.min(o.floor, o.ceiling), usual)));
  return { ...base, budget, from: "history" };
}

const m = (s) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;

/** One line for the check's start: the two limits and where they came from. */
export function describeBudget(b, { mode, branch }) {
  const kind = branchKind(branch);
  const load = b.scale > 1 ? `, ×${b.scale.toFixed(2)} for the load` : "";
  const why =
    b.from === "hard limit"
      ? `the hard limit: ${b.samples} passing ${mode} run(s) on ${kind} branches, under the 5 it needs`
      : `from ${b.samples} passing ${mode} runs on ${kind} branches, median ${m(b.medianSeconds)}, slowest ${m(b.slowestSeconds)}${load}`;
  return `Check budget ${m(b.budget)} (${why}); silence limit ${m(b.silence)}.`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // node check-budget.mjs --mode M --branch B [--log F] [--load L]
  //   → "<budget> <silence>" on the first line, the description on the second.
  const args = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < args.length; i += 2) opt[args[i].replace(/^--/, "")] = args[i + 1] ?? "";
  const mode = opt.mode || "slice";
  const ceiling = hardLimit(mode);
  const num = (v, d) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
  const env = process.env;
  let runs = [];
  try {
    if (opt.log && existsSync(opt.log)) runs = parseLog(readFileSync(opt.log, "utf8")).runs;
  } catch {
    runs = [];
  }
  const b = checkBudget(runs, {
    mode,
    branch: opt.branch ?? "",
    load: num(opt.load, null),
    ceiling,
    floor: num(env.CARETOOK_CHECK_BUDGET_FLOOR, DEFAULTS.floor),
    silence: num(env.CARETOOK_CHECK_SILENCE, DEFAULTS.silence),
  });
  console.log(`${b.budget} ${b.silence}`);
  console.log(describeBudget(b, { mode, branch: opt.branch ?? "" }));
}
