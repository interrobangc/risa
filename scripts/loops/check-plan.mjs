// What `pnpm prd check` runs (the mode, the test files the diff itself adds or
// edits, whether the tooling tests join) and the CI tier a landing should wait
// for. Pure: changed files in, a plan out. The CLI at the bottom reads them from stdin,
// or for --propose with --base computes them (git diff base...head). It checks its
// flags before reading anything, so a wrong call exits 2 at once.
//   node check-plan.mjs --mode slice|quick|full
//   → three lines: mode, tooling (2 with the browser harness test, 1 without, 0
//     for none), the diff's own integration and component test files (space-separated)
//   node check-plan.mjs --propose [--declared <tier>] [--repo DIR --base REF [--head REF]]
//   → three lines: the proposed tier, why, and ok | below | refused for the declared tier
// The three modes (check-body.sh runs them):
//   slice  a slice's hand-off: typecheck, lint, format, every unit test, and only
//          the integration and component test files the slice added or edited.
//   quick  a prd/ or hotfix/ branch: the same, plus the integration tests related
//          to the diff. What a diff needs beyond that is the landing's tier.
//   full   pnpm check and the build budget.
// A package.json that changed only its `scripts` asks for no tier (package-diff.mjs).
// The CLI needs --base to tell: without it, any package.json proposes full.

import { spawnSync } from "node:child_process";
import { readPackages, scriptsOnlyFiles } from "./package-diff.mjs";
import { TIERS } from "../ci/tiers.mjs";

/** Integration and component test files: the only tests a slice or quick check picks by name. */
const OWN_TEST = /\.(int\.test\.ts|browser\.test\.tsx)$/;

/** What only the whole suite can vouch for. dev-brought.mjs reads it too. */
export const FULL = [
  [/^packages\/data\/src\/db\/migrations\//, "a migration"],
  [/^packages\/data\/(scripts|src)\/.*seed/i, "seeds"],
  [/^powersync\/sync-config\.yaml$/, "the sync config"],
  [/^pnpm-lock\.yaml$/, "the lockfile"],
  [/(^|\/)package\.json$/, "a package.json"],
  [/^vitest\.config\.ts$/, "the Vitest config"],
  [/^\.github\/(workflows|actions)\//, "the CI workflow"],
  [/^scripts\/ci\//, "scripts/ci"],
];

/** CI's two committed lists: filing a flake changes them, and that keeps a verdict. */
export const CI_LISTS = new Set(["scripts/ci/brake-list.txt", "scripts/ci/quarantine.txt"]);

// The project config (risa.json) counts as tooling: the tooling tests check it. So
// does the project's own folder of scripts (scripts/project/, the tooling that stays).
const TOOLING =
  /^(scripts\/loops\/|scripts\/backlog\/|scripts\/project\/|\.githooks\/|scripts\/hooks\.test\.mjs$|risa\.json$)/;

// What the browser harness test (scripts/loops/browser.test.mjs, the
// tooling:browser project) exercises: browser.sh, what it sources and starts, the
// manifest, the area map and its engine (the project's, in scripts/project/), and the
// checks' own directory.
const BROWSER_HARNESS =
  /^scripts\/(loops\/(browser\.sh|browser\.test\.mjs|lib\.sh|lease\.sh|serve\.sh|checks|check-areas\.d\/.+)|project\/check-areas\.mjs|browser-checks\/.+)$/;

/**
 * Whether a change needs the browser harness test.
 * @param {string[]} changed files changed against the base
 * @returns {boolean}
 */
export const needsBrowserHarness = (changed) => changed.some((f) => BROWSER_HARNESS.test(f));

/**
 * @param {string[]} changed files changed against the base
 * @param {"slice" | "quick" | "full"} asked
 * @returns {{ mode: "slice" | "quick" | "full", ownTests: string[], tooling: boolean }}
 */
export function planCheck(changed, asked) {
  const tooling = changed.some((f) => TOOLING.test(f));
  if (asked === "full") return { mode: "full", ownTests: [], tooling };
  return { mode: asked, ownTests: [...new Set(changed.filter((f) => OWN_TEST.test(f)))], tooling };
}

/** The tiers a landing can declare, lowest first. */
export const PROPOSED_TIERS = /** @type {const} */ (["none", ...TIERS]);

/** @typedef {(typeof PROPOSED_TIERS)[number]} ProposedTier */

export const tierRank = (/** @type {string} */ tier) =>
  PROPOSED_TIERS.indexOf(/** @type {ProposedTier} */ (tier));

/**
 * One file's tier. Markdown comes first, so a note can't match the seeds' pattern;
 * a file no rule covers asks for the most.
 * @param {string} file
 * @param {Set<string>} scriptsOnly
 * @returns {{ tier: ProposedTier, why: string }}
 */
function fileProposal(file, scriptsOnly) {
  if (file.endsWith(".md")) return { tier: "none", why: "docs" };
  if (scriptsOnly.has(file)) return { tier: "none", why: "a package.json's scripts" };
  for (const [re, what] of FULL)
    if (/** @type {RegExp} */ (re).test(file)) return { tier: "full", why: /** @type {string} */ (what) };
  if (file.startsWith("apps/")) return { tier: "components", why: "app code" };
  if (file.startsWith("packages/")) return { tier: "integration", why: "server code" };
  if (BROWSER_HARNESS.test(file)) return { tier: "integration", why: "the browser harness" };
  if (TOOLING.test(file)) return { tier: "none", why: "tooling" };
  return { tier: "full", why: "a file no rule covers" };
}

/**
 * The lowest tier a landing of this diff should wait for: its files' highest.
 * @param {string[]} changed files changed against the base
 * @param {Map<string, { base: string | null, head: string | null }>} [packages] both
 *   versions of each changed package.json; one missing here proposes full
 * @returns {{ tier: ProposedTier, reason: string }}
 */
export function proposeTier(changed, packages = new Map()) {
  const scriptsOnly = scriptsOnlyFiles(packages);
  /** @type {{ tier: ProposedTier, reason: string }} */
  let top = { tier: "none", reason: changed.length ? "docs and tooling only" : "no changes" };
  for (const file of changed) {
    const { tier, why } = fileProposal(file, scriptsOnly);
    if (tierRank(tier) > tierRank(top.tier)) top = { tier, reason: `${why} (${file})` };
  }
  return top;
}

/**
 * Whether commits changing these files keep a verdict from before them: docs,
 * tooling and CI's two lists. The browser harness doesn't, since a verdict ran it.
 * @param {string[]} changed
 * @param {Map<string, { base: string | null, head: string | null }>} [packages]
 */
export const keepsVerdict = (changed, packages = new Map()) =>
  proposeTier(
    changed.filter((f) => !CI_LISTS.has(f)),
    packages,
  ).tier === "none";

/**
 * What a dev sync (a merge of dev into the branch) asks the synced tip to recheck:
 * the tier of the files dev brought, which dev's own landing already vouched for
 * alone. The browser harness counts as tooling here, since `pnpm test:tooling` runs
 * its test, unless the branch changed that file too; CI's two lists count for nothing.
 * @param {string[]} brought files the merge changed against the branch's side
 * @param {string[]} touched files the branch itself changed against dev
 * @returns {{ tier: ProposedTier, reason: string }}
 */
export function syncTier(brought, touched) {
  const shared = new Set(touched);
  return proposeTier(brought.filter((f) => !CI_LISTS.has(f) && (shared.has(f) || !BROWSER_HARNESS.test(f))));
}

/**
 * A declared tier against the proposal. `none` under a real proposal is no gate at
 * all, which is what --force is for, so a reason doesn't buy it.
 * @param {string} proposed
 * @param {string} [declared]
 * @returns {"ok" | "below" | "refused"}
 */
export function declaredStatus(proposed, declared = proposed) {
  if (tierRank(declared) >= tierRank(proposed)) return "ok";
  return declared === "none" ? "refused" : "below";
}

/**
 * The lint step `pnpm test:tooling` runs first (tooling-lint.mjs): eslint and
 * prettier on the changed tooling files, since a docs-and-tooling-only diff
 * passes the gate with no check ("none needed") and would otherwise reach dev
 * unlinted. Markdown is left to `prettier --check`, so a Markdown-only diff
 * gets no step (both lists empty).
 * @param {string[]} changed files changed against the trunk
 * @returns {{ eslint: string[], prettier: string[] }}
 */
export function planToolingLint(changed) {
  const files = changed.filter((f) => TOOLING.test(f) && !f.endsWith(".md"));
  return { eslint: files.filter((f) => /\.[cm]?[jt]sx?$/.test(f)), prettier: files };
}

const USAGE = `usage: check-plan.mjs --mode slice|quick|full [--repo DIR --base REF --head REF] < changed-files
       check-plan.mjs --propose [--declared <tier>] [--repo DIR] [--base REF [--head REF] | < changed-files]`;

/** The CLI's flags, each taking a value but --propose. */
const VALUED = new Set(["--mode", "--declared", "--repo", "--base", "--head"]);

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
  if (!propose && !opts.mode) return { ok: false, error: "give --mode or --propose" };
  if (propose && opts.mode) return { ok: false, error: "--mode and --propose don't go together" };
  if (opts.head && !opts.base) return { ok: false, error: "--head needs --base" };
  return { ok: true, propose, opts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(`${args.error}\n${USAGE}`);
    process.exit(2);
  }
  const { propose, opts } = args;
  const repo = opts.repo || ".";
  const declared = opts.declared;
  if (declared && tierRank(declared) < 0) {
    console.error(`unknown tier ${declared} (${PROPOSED_TIERS.join(", ")})`);
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
