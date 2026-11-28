// What `prd check` runs (the mode, the test files the diff itself adds or
// edits, whether the tooling tests join) and the CI tier a landing should wait
// for. Pure: changed files in, a plan out. The CLI at the bottom reads them from stdin,
// or for --propose with --base computes them (git diff base...head). It checks its
// flags before reading anything, so a wrong call exits 2 at once.
//   node check-plan.mjs --mode slice|quick|full
//   → three lines: mode, tooling (2 with the browser harness test, 1 without, 0
//     for none), the diff's own integration and component test files (space-separated)
//   node check-plan.mjs --propose [--declared <tier>] [--repo DIR --base REF [--head REF]]
//   → three lines: the proposed tier, why, and ok | below | refused for the declared tier
//   node check-plan.mjs --plan <plan-file>
//   → a plan's slice budget (planBudget, below): a warning per slice over it on
//     stderr, then how its waves were read; exits 0, or 1 when a slice's fields
//     have an error (an unknown Model, from slice-fields.mjs) (`prd anchors` runs it too)
// The three modes (the project's check hook runs them, through check-hook.sh):
//   slice  a slice's hand-off: typecheck, lint, format, every unit test, and only
//          the integration and component test files the slice added or edited.
//   quick  a prd/ or hotfix/ branch: the same, plus the integration tests related
//          to the diff. What a diff needs beyond that is the landing's tier.
//   full   pnpm check and the build budget.
// A package.json that changed only its `scripts` asks for no tier (package-diff.mjs).
// The CLI needs --base to tell: without it, any package.json proposes full.
//
// This is the engine; the rules are the project's data: the file its config's
// paths.checkPlanRules names (JSON), with the tiers from its tier data
// (paths.tierData) and CI's two lists from paths.brakeList and paths.quarantine:
//   ownTests        a pattern: the integration and component test files, the only
//                   tests a slice or quick check picks by name
//   suite           { tier, rules: [{ match, why, flags? }] }: what only the whole
//                   suite vouches for, and the tier that runs it (a file no rule
//                   covers asks for it too)
//   byPath          [{ match, tier, why }]: the tier by path, the first match
//   browserHarness  { tier, paths }: what the browser harness test exercises beyond
//                   the core's own files (CORE_HARNESS), and the tier a change to it asks
//                   for (optional: none, no harness)
//   tooling         paths that are tooling beyond the config's paths.tooling and the
//                   core's own folders: a change only to tooling asks for no tier
//   reachesCode     [{ match, why }]: what reaches a branch's code without an import,
//                   beyond the suite's list (dev-brought.mjs: a dev sync's risk)
// A `match` is a regular expression's source (`flags` its flags); a path is a file
// or a folder, from the repo's root.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readPackages, scriptsOnlyFiles } from "./package-diff.mjs";
import { loadConfig } from "./config.mjs";
import { TierDataError, tierData } from "../ci/tier-data.mjs";
import { FILE_EXT, mergedSlices, sliceFields, sliceRows, sliceSections } from "./slice-fields.mjs";

/** The core's own folders, tooling while they sit in the repo (lib.sh's exempt_re too). */
const CORE_TOOLING = ["loops", "backlog"];

/** What the browser harness test (the core's browser.test.mjs, the gate's) exercises of the core. */
const CORE_HARNESS = ["loops/browser.sh", "loops/browser.test.mjs", "loops/lib.sh", "loops/lease.sh"];

const KEYS = ["ownTests", "suite", "byPath", "browserHarness", "tooling", "reachesCode"];

/** A rules file that doesn't load: every problem, each naming its field. */
export class CheckPlanRulesError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(problems.join("\n"));
    this.name = "CheckPlanRulesError";
    this.problems = problems;
  }
}

/** @param {unknown} v */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** @param {unknown} v */
const isPath = (v) =>
  typeof v === "string" &&
  v !== "" &&
  !/[\s\\]/.test(v) &&
  v.split("/").every((part) => part !== "" && part !== "." && part !== "..");
/** @param {unknown} v */
const isWhy = (v) => typeof v === "string" && /^\S(.*\S)?$/.test(v);

/**
 * What is wrong with a pattern's source and flags, or null.
 * @param {unknown} match
 * @param {unknown} flags
 */
const patternProblem = (match, flags) => {
  if (typeof match !== "string" || match === "") return "must be a regular expression's source";
  if (flags !== undefined && !(typeof flags === "string" && /^[imsu]*$/.test(flags)))
    return "flags: must be some of i, m, s, u";
  try {
    new RegExp(match, /** @type {string | undefined} */ (flags));
    return null;
  } catch (e) {
    return `not a regular expression (${e instanceof Error ? e.message : e})`;
  }
};

/**
 * What is wrong with a parsed rules file: one line per problem, none when it loads.
 * @param {unknown} data
 * @param {readonly string[]} [tiers] the project's tiers: a rule's tier must be one
 * @returns {string[]}
 */
export function checkPlanRulesProblems(data, tiers) {
  if (!isObject(data)) return ["the file must hold one JSON object"];
  const d = /** @type {Record<string, any>} */ (data);
  /** @type {string[]} */
  const problems = Object.keys(d)
    .filter((k) => !KEYS.includes(k))
    .map((k) => `${k}: unknown key`);
  for (const k of ["ownTests", "suite"]) if (!(k in d)) problems.push(`${k}: missing`);
  const tier = (/** @type {string} */ at, /** @type {unknown} */ t) => {
    if (typeof t !== "string" || (tiers && !tiers.includes(t)))
      problems.push(`${at}: not a tier${tiers ? ` (${tiers.join(", ")})` : ""}`);
  };
  /**
   * @param {string} at
   * @param {unknown} list
   * @param {string[]} fields the keys each rule has (`flags` may join them)
   */
  const rules = (at, list, fields) => {
    if (!Array.isArray(list)) return problems.push(`${at}: must be a list of { ${fields.join(", ")} }`);
    list.forEach((/** @type {any} */ r, /** @type {number} */ i) => {
      if (!isObject(r)) return problems.push(`${at}.${i}: must be { ${fields.join(", ")} }`);
      for (const k of Object.keys(r))
        if (![...fields, "flags"].includes(k)) problems.push(`${at}.${i}.${k}: unknown key`);
      const bad = patternProblem(r.match, r.flags);
      if (bad) problems.push(`${at}.${i}.match: ${bad}`);
      if (!isWhy(r.why)) problems.push(`${at}.${i}.why: must be one line of text`);
      if (fields.includes("tier")) tier(`${at}.${i}.tier`, r.tier);
    });
  };
  const paths = (/** @type {string} */ at, /** @type {unknown} */ list) => {
    if (!Array.isArray(list)) return problems.push(`${at}: must be a list of paths`);
    list.forEach((p, i) => {
      if (!isPath(p)) problems.push(`${at}.${i}: must be a path from the repo's root`);
    });
  };
  if ("ownTests" in d) {
    const bad = patternProblem(d.ownTests, undefined);
    if (bad) problems.push(`ownTests: ${bad}`);
  }
  if ("suite" in d) {
    if (!isObject(d.suite)) problems.push("suite: must be { tier, rules }");
    else {
      for (const k of Object.keys(d.suite))
        if (!["tier", "rules"].includes(k)) problems.push(`suite.${k}: unknown key`);
      tier("suite.tier", d.suite.tier);
      rules("suite.rules", d.suite.rules, ["match", "why"]);
    }
  }
  if ("byPath" in d) rules("byPath", d.byPath, ["match", "tier", "why"]);
  if ("browserHarness" in d) {
    if (!isObject(d.browserHarness)) problems.push("browserHarness: must be { tier, paths }");
    else {
      for (const k of Object.keys(d.browserHarness))
        if (!["tier", "paths"].includes(k)) problems.push(`browserHarness.${k}: unknown key`);
      tier("browserHarness.tier", d.browserHarness.tier);
      paths("browserHarness.paths", d.browserHarness.paths);
    }
  }
  if ("tooling" in d) paths("tooling", d.tooling);
  if ("reachesCode" in d) rules("reachesCode", d.reachesCode, ["match", "why"]);
  return problems;
}

/**
 * Whether a file is under one of these paths, or is one that isn't a folder: a
 * changed file named as a folder (a symlink or gitlink in its place) isn't in it.
 * @param {readonly string[]} paths
 * @param {ReadonlySet<string>} folders the paths that are folders
 */
const under = (paths, folders) => (/** @type {string} */ file) =>
  paths.some((p) => (file === p && !folders.has(p)) || file.startsWith(`${p}/`));

/** @param {{ match: string, flags?: string, why: string, tier?: string }[]} list */
const compile = (list = []) =>
  list.map((r) => ({ re: new RegExp(r.match, r.flags), why: r.why, tier: r.tier ?? "" }));

/**
 * The check plan for one project: its rules file and tier data, from its config.
 * Throws a CheckPlanRulesError naming every problem with the rules.
 * @param {{ config: Record<string, any>, root: string }} project a loaded config
 * @param {{ repo?: string }} [where] the checkout whose tooling paths are statted to tell
 *   a folder from a file (default: the config's root; the CLI passes --repo)
 */
export function checkPlanFor(project, { repo = project.root } = {}) {
  const rel = project.config.paths?.checkPlanRules;
  if (!rel)
    throw new CheckPlanRulesError([
      "the project config sets no paths.checkPlanRules (the check plan's rules)",
    ]);
  const file = join(project.root, rel);
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new CheckPlanRulesError([
      `${file}: can't read the check plan's rules (${e instanceof Error ? e.message : e})`,
    ]);
  }
  const { TIERS } = tierData(project);
  const problems = checkPlanRulesProblems(data, TIERS);
  if (problems.length) throw new CheckPlanRulesError(problems.map((p) => `${file}: ${p}`));

  const ownTest = new RegExp(data.ownTests);
  /** @type {string} */
  const suiteTier = data.suite.tier;
  const suite = compile(data.suite.rules);
  const byPath = compile(data.byPath);
  const reaches = compile(data.reachesCode);
  const harnessTier = data.browserHarness?.tier;
  const harnessPaths = harnessTier ? [...CORE_HARNESS, ...data.browserHarness.paths] : [];
  const toolingPaths = [...CORE_TOOLING, ...(project.config.paths?.tooling ?? []), ...(data.tooling ?? [])];
  /** @param {string} p */
  const isFolder = (p) => {
    try {
      return statSync(join(repo, p)).isDirectory();
    } catch {
      return false;
    }
  };
  const folders = new Set([...CORE_TOOLING, ...[...harnessPaths, ...toolingPaths].filter(isFolder)]);
  const isHarness = harnessTier ? under(harnessPaths, folders) : (/** @type {string} */ _file) => false;
  const isTooling = under(toolingPaths, folders);
  const ciLists = new Set(
    [project.config.paths?.brakeList, project.config.paths?.quarantine].filter(Boolean),
  );

  /** The tiers a landing can declare, lowest first. */
  const PROPOSED_TIERS = Object.freeze(["none", ...TIERS]);
  const tierRank = (/** @type {string} */ tier) => PROPOSED_TIERS.indexOf(tier);

  /**
   * One file's tier. Markdown comes first, so a note can't match the seeds' pattern;
   * a file no rule covers asks for the suite's.
   * @param {string} file
   * @param {Set<string>} scriptsOnly
   * @returns {{ tier: string, why: string }}
   */
  const fileProposal = (file, scriptsOnly) => {
    if (file.endsWith(".md")) return { tier: "none", why: "docs" };
    if (scriptsOnly.has(file)) return { tier: "none", why: "a package.json's scripts" };
    for (const r of suite) if (r.re.test(file)) return { tier: suiteTier, why: r.why };
    for (const r of byPath) if (r.re.test(file)) return { tier: r.tier, why: r.why };
    if (isHarness(file)) return { tier: harnessTier, why: "the browser harness" };
    if (isTooling(file)) return { tier: "none", why: "tooling" };
    return { tier: suiteTier, why: "a file no rule covers" };
  };

  /**
   * The lowest tier a landing of this diff should wait for: its files' highest.
   * @param {string[]} changed files changed against the base
   * @param {Map<string, { base: string | null, head: string | null }>} [packages] both
   *   versions of each changed package.json; one missing here asks for the suite
   * @returns {{ tier: string, reason: string }}
   */
  const proposeTier = (changed, packages = new Map()) => {
    const scriptsOnly = scriptsOnlyFiles(packages);
    let top = { tier: "none", reason: changed.length ? "docs and tooling only" : "no changes" };
    for (const file of changed) {
      const { tier, why } = fileProposal(file, scriptsOnly);
      if (tierRank(tier) > tierRank(top.tier)) top = { tier, reason: `${why} (${file})` };
    }
    return top;
  };

  return Object.freeze({
    PROPOSED_TIERS,
    tierRank,
    proposeTier,
    /** Whether this is one of CI's two committed lists. @param {string} file */
    isCiList: (file) => ciLists.has(file),

    /**
     * Whether a change needs the browser harness test.
     * @param {string[]} changed files changed against the base
     */
    needsBrowserHarness: (changed) => changed.some(isHarness),

    /**
     * @param {string[]} changed files changed against the base
     * @param {"slice" | "quick" | "full"} asked
     * @returns {{ mode: "slice" | "quick" | "full", ownTests: string[], tooling: boolean }}
     */
    planCheck(changed, asked) {
      const tooling = changed.some(isTooling);
      if (asked === "full") return { mode: "full", ownTests: [], tooling };
      return { mode: asked, ownTests: [...new Set(changed.filter((f) => ownTest.test(f)))], tooling };
    },

    /**
     * Whether commits changing these files keep a verdict from before them: docs,
     * tooling and CI's two lists. The browser harness doesn't, since a verdict ran it.
     * @param {string[]} changed
     * @param {Map<string, { base: string | null, head: string | null }>} [packages]
     */
    keepsVerdict: (changed, packages = new Map()) =>
      proposeTier(
        changed.filter((f) => !ciLists.has(f)),
        packages,
      ).tier === "none",

    /**
     * What a dev sync (a merge of dev into the branch) asks the synced tip to recheck:
     * the tier of the files dev brought, which dev's own landing already vouched for
     * alone. The browser harness counts as tooling here, since `pnpm test:tooling` runs
     * its test, unless the branch changed that file too; CI's two lists count for nothing.
     * @param {string[]} brought files the merge changed against the branch's side
     * @param {string[]} touched files the branch itself changed against dev
     */
    syncTier(brought, touched) {
      const shared = new Set(touched);
      return proposeTier(brought.filter((f) => !ciLists.has(f) && (shared.has(f) || !isHarness(f))));
    },

    /**
     * A declared tier against the proposal. `none` under a real proposal is no gate at
     * all, which is what --force is for, so a reason doesn't buy it.
     * @param {string} proposed
     * @param {string} [declared]
     * @returns {"ok" | "below" | "refused"}
     */
    declaredStatus(proposed, declared = proposed) {
      if (tierRank(declared) >= tierRank(proposed)) return "ok";
      return declared === "none" ? "refused" : "below";
    },

    /**
     * The lint step `pnpm test:tooling` runs first (tooling-lint.mjs): eslint and
     * prettier on the changed tooling files, since a docs-and-tooling-only diff
     * passes the gate with no check ("none needed") and would otherwise reach dev
     * unlinted. Markdown is left to `prettier --check`, so a Markdown-only diff
     * gets no step (both lists empty).
     * @param {string[]} changed files changed against the trunk
     * @returns {{ eslint: string[], prettier: string[] }}
     */
    planToolingLint(changed) {
      const files = changed.filter((f) => isTooling(f) && !f.endsWith(".md"));
      return { eslint: files.filter((f) => /\.[cm]?[jt]sx?$/.test(f)), prettier: files };
    },

    /**
     * What kind of risky file a dev sync brought, or null (dev-brought.mjs): what
     * only the whole suite vouches for, and what reaches code without an import.
     * Markdown never is, so a note can't match the seeds' pattern; CI's two lists
     * aren't drift at all (lib.sh, trunk_drift).
     * @param {string} file
     * @returns {string | null}
     */
    riskyKind(file) {
      if (file.endsWith(".md") || ciLists.has(file)) return null;
      return [...suite, ...reaches].find((r) => r.re.test(file))?.why ?? null;
    },
  });
}

/** @typedef {ReturnType<typeof checkPlanFor>} CheckPlan */

/** @type {CheckPlan | undefined} */
let ours;
/** This repo's check plan, built on first use. */
export const checkPlan = () => (ours ??= checkPlanFor(loadConfig()));

// This repo's plan, function by function: what the scripts and the CLI call.

/** @type {string[] | undefined} */
let proposed;
/** The tiers a landing can declare, lowest first: read when first asked for, not at import, and kept. */
export const proposedTiers = () => (proposed ??= ["none", ...tierData().TIERS]);

export const tierRank = (/** @type {string} */ tier) => proposedTiers().indexOf(tier);

/** @param {string[]} changed */
export const needsBrowserHarness = (changed) => checkPlan().needsBrowserHarness(changed);
/** @param {string[]} changed @param {"slice" | "quick" | "full"} asked */
export const planCheck = (changed, asked) => checkPlan().planCheck(changed, asked);
/** @param {string[]} changed @param {Map<string, { base: string | null, head: string | null }>} [packages] */
export const proposeTier = (changed, packages) => checkPlan().proposeTier(changed, packages);
/** @param {string[]} changed @param {Map<string, { base: string | null, head: string | null }>} [packages] */
export const keepsVerdict = (changed, packages) => checkPlan().keepsVerdict(changed, packages);
/** @param {string[]} brought @param {string[]} touched */
export const syncTier = (brought, touched) => checkPlan().syncTier(brought, touched);
/** @param {string} proposed @param {string} [declared] */
export const declaredStatus = (proposed, declared) => checkPlan().declaredStatus(proposed, declared);
/** @param {string[]} changed */
export const planToolingLint = (changed) => checkPlan().planToolingLint(changed);

// A plan's slice budget (`prd doc planner`, The plan's shape): about 4 files, one
// test file named by the slice's Check field, and no Check file shared by two
// slices of one wave. It only warns: an old plan without Check still passes. A
// fields line slice-fields.mjs refuses (an unknown Model) is an error.

/** Build files past this many warn. */
export const BUILD_FILES = 4;

/**
 * The distinct backticked files a slice's Build (or What to build) paragraph
 * names, up to the next bold label (`**Acceptance criteria:**`) or heading.
 */
export function buildFiles(/** @type {string} */ body) {
  const m = /^\*\*(?:What to )?build\b[^\n]*(?:\n(?!\*\*[^*\n]+:\*\*|#)[^\n]*)*/im.exec(body);
  const spans = m ? [...m[0].matchAll(/`([^`\s]+)`/g)].map((f) => f[1]) : [];
  return [...new Set(spans.filter((f) => FILE_EXT.test(f)))];
}

/**
 * Each unmerged slice's wave, and where it was read from: the slices' `Blocked by`
 * chains (when every one gives the field: a slice blocked by no unmerged slice is
 * wave 1, else one past its blockers'), failing that the _Status_ table's Wave
 * column (when it has a value for every one), failing that one wave of the slices
 * after the last merged one.
 * @param {string} planText
 * @param {{ n: number, blockedBy: number[], given: string[] }[]} slices the unmerged ones
 * @param {Set<number>} merged
 * @returns {{ waves: Map<number, string>, wavesFrom: string }}
 */
export function sliceWaves(planText, slices, merged) {
  const waves = new Map();
  if (slices.length && slices.every((s) => s.given.includes("blocked by"))) {
    const by = new Map(slices.map((s) => [s.n, s.blockedBy.filter((b) => !merged.has(b))]));
    const depth = (/** @type {number} */ n, seen = new Set()) => {
      if (seen.has(n)) return 1; // a cycle: stop counting
      seen.add(n);
      const up = (by.get(n) ?? []).filter((b) => by.has(b));
      return up.length ? 1 + Math.max(...up.map((b) => depth(b, new Set(seen)))) : 1;
    };
    for (const s of slices) waves.set(s.n, String(depth(s.n)));
    return { waves, wavesFrom: "waves from the slices' Blocked by chains" };
  }
  const status = new Map(sliceRows(planText).map((r) => [r.slice, r.cells.wave ?? ""]));
  if (slices.length && slices.every((s) => /\S/.test(status.get(s.n) ?? ""))) {
    for (const s of slices) waves.set(s.n, /** @type {string} */ (status.get(s.n)));
    return { waves, wavesFrom: "waves from the Status table's Wave column" };
  }
  const last = Math.max(0, ...merged);
  for (const s of slices) if (s.n > last) waves.set(s.n, "after");
  return { waves, wavesFrom: `one wave: the slices after the last merged one (${last || "none merged"})` };
}

/**
 * The budget warnings for a plan's open slices: those not merged and, when the
 * plan's Status table lists any slice, listed there (status-trim moves a landed
 * wave's rows out, so a slice with no row has landed). `errors` are the fields
 * errors sliceFields gives those slices (an unknown Model), its own messages.
 * @param {string} planText
 * @param {{ merged?: Set<number> }} [opts] the merged slices (default: the plan's own tables)
 * @returns {{ warnings: { slice: number, text: string }[], errors: { slice: number, text: string }[], wavesFrom: string }}
 */
export function planBudget(planText, { merged = mergedSlices([planText]) } = {}) {
  /** @type {{ slice: number, text: string }[]} */
  const warnings = [];
  /** @type {{ slice: number, text: string }[]} */
  const errors = [];
  const slices = [];
  const listed = new Set(sliceRows(planText).map((r) => r.slice));
  for (const { n, body } of sliceSections(planText)) {
    if (merged.has(n) || (listed.size && !listed.has(n))) continue;
    const f = sliceFields(planText, n);
    for (const text of f.errors) errors.push({ slice: n, text });
    slices.push({ n, blockedBy: f.blockedBy, given: f.given, check: f.check });
    const files = buildFiles(body);
    if (files.length > BUILD_FILES)
      warnings.push({
        slice: n,
        text: `Build names ${files.length} files (budget: about ${BUILD_FILES}): split it`,
      });
    if (!f.given.includes("check")) warnings.push({ slice: n, text: "no Check field (its one test file)" });
    else if (f.check.length !== 1)
      warnings.push({ slice: n, text: `Check names ${f.check.length} test files, not one` });
  }
  const { waves, wavesFrom } = sliceWaves(planText, slices, merged);
  /** @type {Map<string, number[]>} */
  const named = new Map();
  for (const s of slices) {
    if (!waves.has(s.n)) continue;
    for (const file of s.check) {
      const key = `${waves.get(s.n)}\0${file}`;
      named.set(key, [...(named.get(key) ?? []), s.n]);
    }
  }
  for (const [key, ns] of named)
    if (ns.length > 1)
      warnings.push({
        slice: /** @type {number} */ (ns.at(-1)),
        text: `shares its Check file ${key.split("\0")[1]} with slice ${ns.slice(0, -1).join(", ")} in one wave`,
      });
  return { warnings, errors, wavesFrom };
}

/** `--plan <file>`: the budget's warnings and errors on stderr, how waves were read; exit 1 on an error. */
function planCli(/** @type {string} */ file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    console.error(`check-plan: can't read ${file} (${e instanceof Error ? e.message : e})`);
    process.exit(2);
  }
  const history = file.replace(/-plan\.md$/, "-history.md");
  let historyText = "";
  if (history !== file)
    try {
      historyText = readFileSync(history, "utf8");
    } catch {
      // no history yet
    }
  const { warnings, errors, wavesFrom } = planBudget(text, { merged: mergedSlices([text, historyText]) });
  for (const w of warnings) console.error(`warning: slice ${w.slice}: ${w.text}`);
  for (const e of errors) console.error(`error: slice ${e.slice}: ${e.text}`);
  console.log(
    warnings.length ? `${warnings.length} budget warning(s); ${wavesFrom}` : `budget ok; ${wavesFrom}`,
  );
  if (errors.length) {
    console.error(`check-plan: ${errors.length} fields error(s) in ${file}`);
    process.exit(1);
  }
}

const USAGE = `usage: check-plan.mjs --mode slice|quick|full [--repo DIR --base REF --head REF] < changed-files
       check-plan.mjs --propose [--declared <tier>] [--repo DIR] [--base REF [--head REF] | < changed-files]
       check-plan.mjs --plan <plan-file>`;

/** The CLI's flags, each taking a value but --propose. */
const VALUED = new Set(["--mode", "--declared", "--repo", "--base", "--head", "--plan"]);

/**
 * The CLI's arguments, checked before anything reads stdin, so a wrong call
 * fails at once instead of waiting on a terminal's stdin.
 * @param {string[]} argv
 * @returns {{ ok: true, propose: boolean, opts: Record<string, string> } | { ok: false, error: string }}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const opts = {};
  let propose = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = /** @type {string} */ (argv[i]);
    if (arg === "--propose") propose = true;
    else if (VALUED.has(arg)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) return { ok: false, error: `${arg} needs a value` };
      opts[arg.slice(2)] = value;
    } else return { ok: false, error: `unknown argument ${arg}` };
  }
  if (opts.plan)
    return Object.keys(opts).length > 1 || propose
      ? { ok: false, error: "--plan goes alone" }
      : { ok: true, propose, opts };
  if (!propose && !opts.mode) return { ok: false, error: "give --mode or --propose" };
  if (propose && opts.mode) return { ok: false, error: "--mode and --propose don't go together" };
  if (opts.head && !opts.base) return { ok: false, error: "--head needs --base" };
  return { ok: true, propose, opts };
}

/** The CLI, after its arguments are checked. @param {{ propose: boolean, opts: Record<string, string> }} args */
async function cli({ propose, opts }) {
  const repo = opts.repo || ".";
  // Which tooling paths are folders is read in the repo the check runs on.
  if (opts.repo) ours = checkPlanFor(loadConfig(), { repo });
  const declared = opts.declared;
  if (declared && tierRank(declared) < 0) {
    console.error(`unknown tier ${declared} (${proposedTiers().join(", ")})`);
    process.exit(2);
  }
  let text = "";
  let base = opts.base || "";
  const head = opts.base ? opts.head || "HEAD" : "";
  if (propose && base) {
    // The diff itself (base...head: from their merge base), so a proposal never
    // depends on what was piped in; the package.json contents compare from there too.
    const git = (/** @type {string[]} */ ...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
    const mb = git("merge-base", base, head);
    const diff = mb.status === 0 ? git("diff", "--name-only", "--no-renames", mb.stdout.trim(), head) : mb;
    if (diff.status !== 0) {
      console.error(diff.stderr.trim() || `can't diff ${base}...${head}`);
      process.exit(1);
    }
    base = mb.stdout.trim();
    text = diff.stdout;
  } else {
    if (process.stdin.isTTY) {
      console.error(`pipe the changed files in${propose ? ", or pass --base" : ""}\n${USAGE}`);
      process.exit(2);
    }
    for await (const chunk of process.stdin) text += chunk;
  }
  const changed = text.split("\n").filter(Boolean);
  if (propose) {
    const { tier, reason } = proposeTier(changed, readPackages(changed, { repo, base, head }));
    console.log([tier, reason, declaredStatus(tier, declared)].join("\n"));
  } else {
    const mode = opts.mode;
    const plan = planCheck(changed, mode === "slice" || mode === "quick" ? mode : "full");
    const tooling = plan.tooling ? (needsBrowserHarness(changed) ? 2 : 1) : 0;
    console.log([plan.mode, tooling, plan.ownTests.join(" ")].join("\n"));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(`${args.error}\n${USAGE}`);
    process.exit(2);
  }
  try {
    if (args.opts.plan) planCli(args.opts.plan);
    else await cli(args);
  } catch (e) {
    // A rules or tier data file that doesn't load: one line, never a Node stack.
    if (!(e instanceof CheckPlanRulesError || e instanceof TierDataError)) throw e;
    console.error(`check-plan: ${e.problems.join("; ")}`);
    process.exit(2);
  }
}
