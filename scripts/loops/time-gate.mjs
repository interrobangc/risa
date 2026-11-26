// The time gate: did a measured run of the tests take too long? Pure functions
// over one measure's seconds and limits, plus a small CLI that the check runner
// (check-run.sh, for a finished quick or slice check) and CI's test-job wrapper
// call.
//
// The measures, each with an aim, a cutoff and an armed switch (the gates' data,
// `gates` in the tier data, read and checked by tier-data.mjs):
//   unit        CI's unit job's test step
//   components  each component shard's test step, on its own
//   quick       a local quick or slice check, its tooling step included (the
//               local measure: its `modes` are the check modes it covers)
// The verdict: `ok` at or under the aim, `warn` past it, `fail` past the cutoff.
// An unarmed measure's `fail` comes back as `warn`, saying "not armed". The local
// measure is judged only on a quiet machine: a 5-minute load, at the start and at
// the end, at most quietLoadPerCore × the core count; any other run (a busy or
// unread load) is `unjudged`. A breach's lines name the measure, its seconds
// against the aim and the cutoff, the steps it was given and its slowest files
// (ten at most).
//
// The gates' data's shape and defaults are in tier-data.mjs's header.
//
//   node time-gate.mjs (--measure M | --mode CHECK_MODE) --seconds S
//     [--load-start L --load-end L] [--cores N] [--slowest FILE] [--steps FILE] [--json]
//   FILE: one `<seconds> <name>` per line (a file, or a step). --mode: the measure
//   that check mode counts toward (the local one for its modes); a mode none
//   covers (full) prints nothing. Out: the verdict on the first line, then the
//   lines to print (or one JSON object with --json); exit 0 for every verdict, 2
//   for a bad call or broken gates' data.
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_QUIET_LOAD_PER_CORE,
  LOCAL_MEASURE,
  MEASURES,
  measureForMode,
  tierData,
} from "../ci/tier-data.mjs";

/** How many slowest files a breach names. */
export const SLOWEST = 10;

/** @typedef {import("../ci/tier-data.mjs").Limits} Limits */
/** @typedef {import("../ci/tier-data.mjs").Gates} Gates */

/** @typedef {{ name: string, seconds: number }} Timed */
/** @typedef {"ok" | "warn" | "fail" | "unjudged"} Verdict */

/** 6m05s. @param {number} s */
export const clock = (s) => {
  const r = Math.round(s);
  return `${Math.floor(r / 60)}m${String(r % 60).padStart(2, "0")}s`;
};
const secs = (/** @type {number} */ s) => `${Math.round(s)} s`;
const load = (/** @type {number | null | undefined} */ l) =>
  typeof l === "number" && Number.isFinite(l) ? String(Math.round(l * 10) / 10) : "unread";

/**
 * Judge one measured run.
 * @param {{ measure: string, seconds: number, limits: Limits,
 *   loads?: { start: number | null | undefined, end: number | null | undefined, cores: number,
 *     perCore?: number },
 *   slowest?: Timed[], steps?: Timed[] }} run
 *   loads: the 5-minute load at the start and the end, and the core count (the
 *   local measure only; perCore is the gates' quietLoadPerCore)
 * @returns {{ verdict: Verdict, armed: boolean, quiet: boolean | null, lines: string[] }}
 */
export function timeGate({ measure, seconds, limits, loads, slowest = [], steps = [] }) {
  const { aim, cutoff, armed } = limits;
  const head = `Time gate ${measure}: ${clock(seconds)} (${secs(seconds)}); aim ${clock(aim)}, cutoff ${clock(cutoff)}`;
  let quiet = null;
  if (measure === LOCAL_MEASURE) {
    const cores = loads?.cores ?? 0;
    const threshold = (loads?.perCore ?? DEFAULT_QUIET_LOAD_PER_CORE) * cores;
    const calm = (/** @type {unknown} */ l) => typeof l === "number" && Number.isFinite(l) && l <= threshold;
    quiet = calm(loads?.start) && calm(loads?.end);
    if (!quiet) {
      const why = `load ${load(loads?.start)} at the start, ${load(loads?.end)} at the end; quiet is at most ${load(threshold)} on ${cores} cores`;
      return { verdict: "unjudged", armed, quiet, lines: [`${head}: not judged (${why}).`] };
    }
  }
  if (seconds <= aim) return { verdict: "ok", armed, quiet, lines: [`${head}: ok.`] };
  const pastCutoff = seconds > cutoff;
  /** @type {Verdict} */
  const verdict = pastCutoff && armed ? "fail" : "warn";
  const what = pastCutoff
    ? armed
      ? `FAIL, ${secs(seconds - cutoff)} past the cutoff`
      : `WARN, ${secs(seconds - cutoff)} past the cutoff, not armed`
    : `WARN, ${secs(seconds - aim)} past the aim`;
  const lines = [`${head}: ${what}.`];
  const byTime = (/** @type {Timed[]} */ xs) =>
    [...xs].filter((x) => x && Number.isFinite(x.seconds)).sort((a, b) => b.seconds - a.seconds);
  const sortedSteps = byTime(steps);
  if (sortedSteps.length)
    lines.push(`  steps: ${sortedSteps.map((s) => `${s.name} ${secs(s.seconds)}`).join(", ")}`);
  const files = byTime(slowest).slice(0, SLOWEST);
  if (files.length) {
    lines.push(`  slowest files:`);
    for (const f of files) lines.push(`    ${secs(f.seconds).padStart(6)}  ${f.name}`);
  }
  return { verdict, armed, quiet, lines };
}

/** `<seconds> <name>` lines into timed entries; blank lines and `#` comments skipped. @param {string} text */
export function parseTimed(text) {
  /** @type {Timed[]} */
  const out = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(\S+)\s+(.+)$/.exec(line);
    const n = m ? Number(m[1]) : NaN;
    if (!m || !Number.isFinite(n) || n < 0) throw new Error(`not "<seconds> <name>": ${line}`);
    out.push({ seconds: n, name: /** @type {string} */ (m[2]) });
  }
  return out;
}

/**
 * The CLI's work, its reads given: the exit code and what it prints.
 * @param {string[]} argv
 * @param {{ gates: () => Readonly<Gates>, read: (file: string) => string, cores: () => number }} io
 * @returns {{ code: number, out: string, err: string }}
 */
export function runCli(argv, io) {
  /** @type {Record<string, string>} */
  const opt = {};
  let json = false;
  const fail = (/** @type {string} */ why) => ({ code: 2, out: "", err: `time-gate: ${why}\n` });
  for (let i = 0; i < argv.length; i++) {
    const a = /** @type {string} */ (argv[i]);
    if (a === "--json") json = true;
    else if (
      /^--(measure|mode|seconds|load-start|load-end|cores|slowest|steps)$/.test(a) &&
      i + 1 < argv.length
    )
      opt[a.slice(2)] = /** @type {string} */ (argv[++i]);
    else return fail(`unknown or incomplete argument ${a}`);
  }
  if (opt.mode !== undefined && opt.measure !== undefined) return fail("--measure or --mode, not both");
  if (opt.mode === undefined && !MEASURES.includes(opt.measure ?? ""))
    return fail(`--measure must be one of ${MEASURES.join(", ")}`);
  const seconds = Number(opt.seconds);
  if (opt.seconds === undefined || !Number.isFinite(seconds) || seconds < 0)
    return fail("--seconds must be a number of seconds");
  const num = (/** @type {string | undefined} */ v) =>
    v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
  let gates;
  try {
    gates = io.gates();
  } catch (e) {
    return fail(e instanceof Error ? e.message.replaceAll("\n", "; ") : String(e));
  }
  const measure = opt.mode === undefined ? (opt.measure ?? "") : measureForMode(gates, opt.mode);
  if (measure === null) return { code: 0, out: "", err: "" };
  /** @type {{ slowest: Timed[], steps: Timed[] }} */
  const lists = { slowest: [], steps: [] };
  for (const k of /** @type {const} */ (["slowest", "steps"])) {
    const file = opt[k];
    if (file === undefined) continue;
    try {
      lists[k] = parseTimed(io.read(file));
    } catch (e) {
      return fail(`--${k} ${file}: ${e instanceof Error ? e.message : e}`);
    }
  }
  const cores = num(opt.cores) ?? io.cores();
  const r = timeGate({
    measure,
    seconds,
    limits: /** @type {Limits} */ (gates.measures[measure]),
    loads: {
      start: num(opt["load-start"]),
      end: num(opt["load-end"]),
      cores,
      perCore: gates.quietLoadPerCore,
    },
    ...lists,
  });
  const out = json
    ? `${JSON.stringify({ measure, seconds, ...r })}\n`
    : `${[r.verdict, ...r.lines].join("\n")}\n`;
  return { code: 0, out, err: "" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = runCli(process.argv.slice(2), {
    gates: () => tierData().GATES,
    read: (file) => readFileSync(file === "-" ? 0 : file, "utf8"),
    cores: () => availableParallelism(),
  });
  process.stdout.write(r.out);
  process.stderr.write(r.err);
  process.exit(r.code);
}
