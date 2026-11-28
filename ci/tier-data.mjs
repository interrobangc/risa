// The core's reader of a project's CI tier data: the file the project config's
// paths.tierData names (JSON). The project's own CI reads the same file with its
// own reader; this one checks the file's shape and gives the core what it asks of
// the tiers: their names and order, each tier's jobs, which tier runs a test file,
// a browser check's spec path, the two marker files and the CI ref's form.
//
// The data:
//   tiers           the tier names, lowest first; each includes the ones before it
//   jobs            the jobs each tier adds: { <tier>: [job, …] }, every tier
//   fileGroups      [{ group, pattern, tier }, …]: which step runs a test file (the
//                   first whose pattern matches) and the lowest tier that runs it;
//                   the last must match every file (`*`)
//   narrowedTiers   the tiers whose first job a narrowed run starts, if its files need them
//   browserCheck    a browser check's spec path, one `*` standing for its name
//   narrowedFile    the file list a narrowed run's throwaway commit adds
//   forcedFlakeFile the marker of a proof run's throwaway commit
//   refPrefix       what a requested run's ref starts with (`ci/`): `<prefix><tier>/<name>`
//   gates           optional: the time gates' data (time-gate.mjs judges with it),
//                   given as GATES with every default filled in; every field optional:
//     quietLoadPerCore           a quiet machine's 5-minute load per core (1)
//     measures.<measure>.aim     seconds (300); measures: unit, components, quick
//     measures.<measure>.cutoff  seconds, at least the aim (360)
//     measures.<measure>.armed   whether a fail past the cutoff fails (false)
//     measures.quick.modes       the check modes the local measure covers (quick, slice)
// A pattern's `*` matches anything, `/` and a newline too.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../loops/config.mjs";

const KEYS = [
  "tiers",
  "jobs",
  "fileGroups",
  "narrowedTiers",
  "browserCheck",
  "narrowedFile",
  "forcedFlakeFile",
  "refPrefix",
];
/** The keys a tier data file may leave out. */
const OPTIONAL = ["gates"];

// The time gates' data.
/** The measures and which is local (judged on load). */
export const MEASURES = Object.freeze(["unit", "components", "quick"]);
export const LOCAL_MEASURE = "quick";

export const DEFAULT_LIMITS = Object.freeze({ aim: 300, cutoff: 360, armed: false });
export const DEFAULT_QUIET_LOAD_PER_CORE = 1;
export const DEFAULT_LOCAL_MODES = Object.freeze(["quick", "slice"]);
const MEASURE_KEYS = ["aim", "cutoff", "armed", "modes"];

const isGroup = (/** @type {unknown} */ v) => !!v && typeof v === "object" && !Array.isArray(v);
const isSeconds = (/** @type {unknown} */ v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * What is wrong with the gates' data (the tier data's `gates`): one line per
 * problem, each naming its field; none when it loads. Undefined is the defaults.
 * @param {unknown} gates
 * @returns {string[]}
 */
export function gatesProblems(gates) {
  if (gates === undefined) return [];
  if (!isGroup(gates)) return ["gates: must be a group of keys (quietLoadPerCore, measures)"];
  const g = /** @type {Record<string, any>} */ (gates);
  const problems = Object.keys(g)
    .filter((k) => !["quietLoadPerCore", "measures"].includes(k))
    .map((k) => `gates.${k}: unknown key`);
  if ("quietLoadPerCore" in g && !isSeconds(g.quietLoadPerCore))
    problems.push("gates.quietLoadPerCore: must be a number above 0");
  if (!("measures" in g)) return problems;
  if (!isGroup(g.measures)) return [...problems, "gates.measures: must be a group of keys, one per measure"];
  for (const [name, m] of Object.entries(g.measures)) {
    const at = `gates.measures.${name}`;
    if (!MEASURES.includes(name)) {
      problems.push(`${at}: unknown measure (${MEASURES.join(", ")})`);
      continue;
    }
    if (!isGroup(m)) {
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

/** A tier data file that doesn't load: every problem, each naming its field. */
export class TierDataError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(problems.join("\n"));
    this.name = "TierDataError";
    this.problems = problems;
  }
}

const isName = (/** @type {unknown} */ v) => typeof v === "string" && /^[\w.-]+$/.test(v);
const isText = (/** @type {unknown} */ v) => typeof v === "string" && v !== "" && !/\s/.test(v);
const isNames = (/** @type {unknown} */ v) =>
  Array.isArray(v) && v.length > 0 && v.every(isName) && new Set(v).size === v.length;

/**
 * What is wrong with a parsed tier data file: one line per problem, none when it loads.
 * @param {unknown} data
 * @returns {string[]}
 */
export function tierDataProblems(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return ["the file must hold one JSON object"];
  const d = /** @type {Record<string, any>} */ (data);
  const problems = [
    ...Object.keys(d)
      .filter((k) => !KEYS.includes(k) && !OPTIONAL.includes(k))
      .map((k) => `${k}: unknown key`),
    ...KEYS.filter((k) => !(k in d)).map((k) => `${k}: missing`),
  ];
  const tiers = isNames(d.tiers) ? /** @type {string[]} */ (d.tiers) : null;
  if ("tiers" in d && !tiers) problems.push("tiers: must be a list of names, not empty, no repeats");
  const isTier = (/** @type {unknown} */ t) => !tiers || tiers.includes(/** @type {string} */ (t));
  if ("jobs" in d) {
    if (!d.jobs || typeof d.jobs !== "object" || Array.isArray(d.jobs))
      problems.push("jobs: must be a group of keys, one per tier");
    else {
      for (const [tier, jobs] of Object.entries(d.jobs)) {
        if (!isTier(tier)) problems.push(`jobs.${tier}: not a tier`);
        if (!isNames(jobs)) problems.push(`jobs.${tier}: must be a list of job names, not empty, no repeats`);
      }
      for (const tier of tiers ?? []) if (!(tier in d.jobs)) problems.push(`jobs.${tier}: missing`);
    }
  }
  if ("fileGroups" in d) {
    if (!Array.isArray(d.fileGroups) || d.fileGroups.length === 0)
      problems.push("fileGroups: must be a list of { group, pattern, tier }, not empty");
    else {
      d.fileGroups.forEach((/** @type {any} */ g, /** @type {number} */ i) => {
        const at = `fileGroups.${i}`;
        if (!g || typeof g !== "object" || Array.isArray(g))
          return problems.push(`${at}: must be { group, pattern, tier }`);
        const extra = Object.keys(g).filter((k) => !["group", "pattern", "tier"].includes(k));
        for (const k of extra) problems.push(`${at}.${k}: unknown key`);
        if (!isName(g.group)) problems.push(`${at}.group: must be a name`);
        if (!isText(g.pattern)) problems.push(`${at}.pattern: must be a pattern (no spaces)`);
        if (!isName(g.tier) || !isTier(g.tier)) problems.push(`${at}.tier: not a tier`);
      });
      if (d.fileGroups.at(-1)?.pattern !== "*")
        problems.push("fileGroups: the last group must match every file (`*`)");
    }
  }
  if ("narrowedTiers" in d) {
    if (!isNames(d.narrowedTiers))
      problems.push("narrowedTiers: must be a list of tiers, not empty, no repeats");
    else for (const t of d.narrowedTiers) if (!isTier(t)) problems.push(`narrowedTiers: ${t} is not a tier`);
  }
  if ("browserCheck" in d && !(isText(d.browserCheck) && d.browserCheck.split("*").length === 2))
    problems.push("browserCheck: must be a path with one `*` for the check's name");
  for (const k of ["narrowedFile", "forcedFlakeFile"])
    if (k in d && !(isText(d[k]) && !d[k].includes("*"))) problems.push(`${k}: must be a path`);
  if ("refPrefix" in d && !(typeof d.refPrefix === "string" && /^[\w.-]+(\/[\w.-]+)*\/$/.test(d.refPrefix)))
    problems.push("refPrefix: must be a ref prefix ending in a slash (`ci/`)");
  problems.push(...gatesProblems(d.gates));
  return problems;
}

/** A pattern whose `*` matches anything, `/` and a newline too. @param {string} pattern */
const glob = (pattern) =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
    "s",
  );
const escape = (/** @type {string} */ s) => s.replace(/[.+?^${}()|[\]\\/]/g, "\\$&");

/**
 * The tiers from parsed data, checked. Throws a TierDataError naming every problem.
 * @param {unknown} data
 * @param {string} [source] the file, for the errors
 */
export function tiersFrom(data, source = "the tier data") {
  const problems = tierDataProblems(data);
  if (problems.length) throw new TierDataError(problems.map((p) => `${source}: ${p}`));
  const d = /** @type {Record<string, any>} */ (data);
  /** @type {readonly string[]} */
  const TIERS = Object.freeze([...d.tiers]);
  /** @type {Readonly<Record<string, readonly string[]>>} */
  const TIER_JOBS = Object.freeze(Object.fromEntries(TIERS.map((t) => [t, Object.freeze([...d.jobs[t]])])));
  const isTier = (/** @type {string} */ tier) => TIERS.includes(tier);
  const unknownTier = (/** @type {string} */ tier) =>
    new Error(`unknown tier "${tier}" (${TIERS.join(", ")})`);
  const groups = d.fileGroups.map((/** @type {{ group: string, pattern: string, tier: string }} */ g) => ({
    group: g.group,
    re: glob(g.pattern),
    tier: g.tier,
  }));
  /** @param {string} file */
  const groupOf = (file) =>
    /** @type {{ group: string, tier: string }} */ (groups.find((g) => g.re.test(file)));
  const [checkHead, checkTail] = /** @type {[string, string]} */ (d.browserCheck.split("*"));
  const check = glob(d.browserCheck);
  /** @type {string} */
  const prefix = d.refPrefix;
  const ref = new RegExp(`^(?:refs\\/heads\\/)?${escape(prefix)}([^/]+)\\/(.+)$`);
  /** @type {readonly string[]} */
  const narrowedTiers = d.narrowedTiers;

  return Object.freeze({
    TIERS,
    TIER_JOBS,
    isTier,
    /** The file list a narrowed run's throwaway commit adds, at the repo root. */
    NARROWED_FILE: /** @type {string} */ (d.narrowedFile),
    /** The marker of a proof run's throwaway commit: its check fails once. */
    FORCED_FLAKE_FILE: /** @type {string} */ (d.forcedFlakeFile),
    /** The time gates: each measure's aim, cutoff and armed switch, the quiet load per core. */
    GATES: gatesFrom(d.gates),
    /** The jobs a tier runs: its own and those of every tier before it. @param {string} tier */
    jobsFor(tier) {
      if (!isTier(tier)) throw unknownTier(tier);
      const asked = TIERS.slice(0, TIERS.indexOf(tier) + 1);
      return { jobs: asked.flatMap((t) => [...(TIER_JOBS[t] ?? [])]), ranTier: tier };
    },
    /** A browser check's spec. @param {string} name */
    browserCheckFile: (name) => `${checkHead}${name}${checkTail}`,
    /** @param {string} file */
    isBrowserCheckFile: (file) => check.test(file),
    /** Which step runs a test file. @param {string} file */
    fileGroup: (file) => groupOf(file).group,
    /** The lowest tier that runs a test file. @param {string} file */
    fileTier: (file) => groupOf(file).tier,
    /** The jobs a narrowed run starts: the first job of each tier its files need. @param {string[]} files */
    narrowedJobs(files) {
      const need = new Set(files.map((f) => groupOf(f).tier));
      return narrowedTiers.filter((t) => need.has(t)).map((t) => /** @type {string} */ (TIER_JOBS[t]?.[0]));
    },
    /** The ref a requested run is pushed to. @param {string} tier @param {string} branch */
    ciRefName(tier, branch) {
      if (!isTier(tier)) throw unknownTier(tier);
      const name = branch.replace(/^refs\/heads\//, "").replaceAll("/", "-");
      if (!name) throw new Error("a CI ref needs a branch name");
      return `${prefix}${tier}/${name}`;
    },
    /** The tier and name in a `<prefix><tier>/<name>` ref, or null. @param {string} name */
    parseCiRef(name) {
      const m = ref.exec(name);
      return m && isTier(/** @type {string} */ (m[1]))
        ? { tier: /** @type {string} */ (m[1]), name: /** @type {string} */ (m[2]) }
        : null;
    },
  });
}

/** @typedef {ReturnType<typeof tiersFrom>} Tiers */

/** @type {Map<string, Tiers>} */
const loaded = new Map();

/**
 * The project's tiers, from the file its config names (read once per file).
 * @param {{ config: Record<string, any>, root: string }} [project] a loaded config
 *   (default: loadConfig())
 * @returns {Tiers}
 */
export function tierData(project = loadConfig()) {
  const rel = project.config.paths?.tierData;
  if (!rel) throw new TierDataError(["the project config sets no paths.tierData (the CI tier data)"]);
  const file = join(project.root, rel);
  const known = loaded.get(file);
  if (known) return known;
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new TierDataError([`${file}: can't read the tier data (${e instanceof Error ? e.message : e})`]);
  }
  const tiers = tiersFrom(data, file);
  loaded.set(file, tiers);
  return tiers;
}

/**
 * tierData for a command's import: a tier data file that doesn't load prints one
 * `<who>: …` line (every problem on it) and exits 2, never a Node stack.
 * @param {string} who the command's name, first on the line (ci)
 * @returns {Tiers}
 */
export function tierDataOrExit(who) {
  try {
    return tierData();
  } catch (e) {
    if (!(e instanceof TierDataError)) throw e;
    process.stderr.write(`${who}: ${e.problems.join("; ")}\n`);
    process.exit(2);
  }
}

/** @type {Tiers | undefined} */
let ciLoaded;

/**
 * The CI commands' tiers (`ci` and the modules it runs): tierDataOrExit("ci"),
 * read when a module first uses them and kept, never at import, so a module that
 * only imports another reads no tier data.
 * @returns {Tiers}
 */
export const ciTiers = () => (ciLoaded ??= tierDataOrExit("ci"));
