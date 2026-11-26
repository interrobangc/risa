// The time gate: did a measured run of the tests take too long? Pure functions
// over one measure's seconds and limits, plus a small CLI that the check runner
// and CI's test-job wrapper call (neither does yet).
//
// The measures, each with an aim, a cutoff and an armed switch (the gates' data,
// `gates` in the tier data, read by tier-data.mjs):
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
// The gates' data, all optional (a missing field takes its default):
//   gates.quietLoadPerCore           the quiet load per core (1)
//   gates.measures.<measure>.aim     seconds (300)
//   gates.measures.<measure>.cutoff  seconds, at least the aim (360)
//   gates.measures.<measure>.armed   whether a fail fails (false)
//   gates.measures.quick.modes       the check modes the local measure covers (quick, slice)
//
//   node time-gate.mjs --measure M --seconds S [--load-start L --load-end L] [--cores N]
//     [--slowest FILE] [--steps FILE] [--json]
//   FILE: one `<seconds> <name>` per line (a file, or a step). Out: the verdict on
//   the first line, then the lines to print (or one JSON object with --json); exit
//   0 for every verdict, 2 for a bad call or broken gates' data.
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { pathToFileURL } from "node:url";

/** The measures and which is local (judged on load). */
export const MEASURES = Object.freeze(["unit", "components", "quick"]);
export const LOCAL_MEASURE = "quick";

export const DEFAULT_LIMITS = Object.freeze({ aim: 300, cutoff: 360, armed: false });
export const DEFAULT_QUIET_LOAD_PER_CORE = 1;
export const DEFAULT_LOCAL_MODES = Object.freeze(["quick", "slice"]);
/** How many slowest files a breach names. */
export const SLOWEST = 10;

const MEASURE_KEYS = ["aim", "cutoff", "armed", "modes"];

const isObject = (/** @type {unknown} */ v) => !!v && typeof v === "object" && !Array.isArray(v);
const isSeconds = (/** @type {unknown} */ v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * What is wrong with the gates' data (the tier data's `gates`): one line per
 * problem, each naming its field; none when it loads. Undefined is the defaults.
 * @param {unknown} gates
 * @returns {string[]}
 */
export function gatesProblems(gates) {
  if (gates === undefined) return [];
  if (!isObject(gates)) return ["gates: must be a group of keys (quietLoadPerCore, measures)"];
  const g = /** @type {Record<string, any>} */ (gates);
  const problems = Object.keys(g)
    .filter((k) => !["quietLoadPerCore", "measures"].includes(k))
    .map((k) => `gates.${k}: unknown key`);
  if ("quietLoadPerCore" in g && !isSeconds(g.quietLoadPerCore))
    problems.push("gates.quietLoadPerCore: must be a number above 0");
  if (!("measures" in g)) return problems;
  if (!isObject(g.measures)) return [...problems, "gates.measures: must be a group of keys, one per measure"];
  for (const [name, m] of Object.entries(g.measures)) {
    const at = `gates.measures.${name}`;
    if (!MEASURES.includes(name)) {
      problems.push(`${at}: unknown measure (${MEASURES.join(", ")})`);
      continue;
    }
    if (!isObject(m)) {
      problems.push(`${at}: must be { aim, cutoff, armed }`);
      continue;
    }
    for (const k of Object.keys(m).filter((k) => !MEASURE_KEYS.includes(k)))
      problems.push(`${at}.${k}: unknown key`);
    if ("aim" in m && !isSeconds(m.aim)) problems.push(`${at}.aim: must be seconds above 0`);
    if ("cutoff" in m && !isSeconds(m.cutoff)) problems.push(`${at}.cutoff: must be seconds above 0`);
    if ("armed" in m && typeof m.armed !== "boolean") problems.push(`${at}.armed: must be true or false`);
    const aim = "aim" in m ? m.aim : DEFAULT_LIMITS.aim;
    const cutoff = "cutoff" in m ? m.cutoff : DEFAULT_LIMITS.cutoff;
    if (isSeconds(aim) && isSeconds(cutoff) && aim > cutoff)
      problems.push(`${at}.aim: ${aim} s is above its cutoff (${cutoff} s)`);
    if ("modes" in m) {
      if (name !== LOCAL_MEASURE)
        problems.push(`${at}.modes: only the local measure (${LOCAL_MEASURE}) has modes`);
      else if (
        !Array.isArray(m.modes) ||
        m.modes.length === 0 ||
        !m.modes.every((/** @type {unknown} */ x) => typeof x === "string" && /^[\w-]+$/.test(x)) ||
        new Set(m.modes).size !== m.modes.length
      )
        problems.push(`${at}.modes: must be a list of check modes, not empty, no repeats`);
    }
  }
  return problems;
}

/** @typedef {{ aim: number, cutoff: number, armed: boolean }} Limits */
/** @typedef {{ quietLoadPerCore: number, measures: Readonly<Record<string, Readonly<Limits>>>,
 *   localModes: readonly string[] }} Gates */

/**
 * The gates from their data, every default filled in. Throws naming every problem.
 * @param {unknown} gates the tier data's `gates` (undefined: all defaults)
 * @returns {Readonly<Gates>}
 */
export function gatesFrom(gates) {
  const problems = gatesProblems(gates);
  if (problems.length) throw new Error(problems.join("\n"));
  const g = /** @type {Record<string, any>} */ (gates ?? {});
  const given = /** @type {Record<string, any>} */ (g.measures ?? {});
  const measures = Object.fromEntries(
    MEASURES.map((name) => {
      const m = given[name] ?? {};
      return [
        name,
        Object.freeze({
          aim: m.aim ?? DEFAULT_LIMITS.aim,
          cutoff: m.cutoff ?? DEFAULT_LIMITS.cutoff,
          armed: m.armed ?? DEFAULT_LIMITS.armed,
        }),
      ];
    }),
  );
  return Object.freeze({
    quietLoadPerCore: g.quietLoadPerCore ?? DEFAULT_QUIET_LOAD_PER_CORE,
    measures: Object.freeze(measures),
    localModes: Object.freeze([...(given[LOCAL_MEASURE]?.modes ?? DEFAULT_LOCAL_MODES)]),
  });
}

/**
 * The measure a local check mode counts toward, or null (a full check: none).
 * @param {Readonly<Gates>} gates @param {string} mode
 */
export const measureForMode = (gates, mode) => (gates.localModes.includes(mode) ? LOCAL_MEASURE : null);

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
    else if (/^--(measure|seconds|load-start|load-end|cores|slowest|steps)$/.test(a) && i + 1 < argv.length)
      opt[a.slice(2)] = /** @type {string} */ (argv[++i]);
    else return fail(`unknown or incomplete argument ${a}`);
  }
  const measure = opt.measure ?? "";
  if (!MEASURES.includes(measure)) return fail(`--measure must be one of ${MEASURES.join(", ")}`);
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
  // tier-data.mjs imports this module: a top-level await here would never settle.
  void import("../ci/tier-data.mjs").then(({ tierData }) => {
    const r = runCli(process.argv.slice(2), {
      gates: () => tierData().GATES,
      read: (file) => readFileSync(file === "-" ? 0 : file, "utf8"),
      cores: () => availableParallelism(),
    });
    process.stdout.write(r.out);
    process.stderr.write(r.err);
    process.exit(r.code);
  });
}
