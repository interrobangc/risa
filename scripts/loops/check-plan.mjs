// What `pnpm prd check` runs (the mode, the test files the diff itself adds or
// edits, whether the tooling tests join) and the CI tier a landing should wait
// for. Pure: changed files in, a plan out. The CLI at the bottom reads them from stdin.
//   node check-plan.mjs --mode slice|quick|full
//   → three lines: mode, tooling (2 with the browser harness test, 1 without, 0
//     for none), the diff's own integration and component test files (space-separated)
//   node check-plan.mjs --propose [--declared <tier>] [--repo DIR --base REF --head REF]
//   → three lines: the proposed tier, why, and ok | below | refused for the declared tier
// The three modes (check-body.sh runs them):
//   slice  a slice's hand-off: typecheck, lint, format, every unit test, and only
//          the integration and component test files the slice added or edited.
//   quick  a prd/ or hotfix/ branch: the same, plus the integration tests related
//          to the diff. What a diff needs beyond that is the landing's tier.
//   full   pnpm check and the build budget.
// A package.json that changed only its `scripts` asks for no tier (package-diff.mjs).
// The CLI needs --base to tell: without it, any package.json proposes full.

import { readPackages, scriptsOnlyFiles } from "./package-diff.mjs";
import { TIERS } from "../ci/tiers.mjs";

/** Integration and component test files: the only tests a slice or quick check picks by name. */
const OWN_TEST = /\.(int\.test\.ts|browser\.test\.tsx)$/;

/** What only the whole suite can vouch for. */
const FULL = [
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
const CI_LISTS = new Set(["scripts/ci/brake-list.txt", "scripts/ci/quarantine.txt"]);

const TOOLING = /^(scripts\/loops\/|scripts\/backlog\/|\.githooks\/|scripts\/hooks\.test\.mjs$)/;

// What the browser harness test (scripts/loops/browser.test.mjs, the
// tooling:browser project) exercises: browser.sh, what it sources and starts, the
// manifest, the area map, and the checks' own directory.
const BROWSER_HARNESS =
  /^scripts\/(loops\/(browser\.sh|browser\.test\.mjs|lib\.sh|lease\.sh|serve\.sh|checks|check-areas\.mjs|check-areas\.d\/.+)|browser-checks\/.+)$/;

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

if (import.meta.url === `file://${process.argv[1]}`) {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const changed = text.split("\n").filter(Boolean);
  const flag = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : "");
  if (process.argv.includes("--propose")) {
    const from = { repo: flag("--repo") || ".", base: flag("--base"), head: flag("--head") };
    const declared = flag("--declared") || undefined;
    if (declared && tierRank(declared) < 0) {
      console.error(`unknown tier ${declared} (${PROPOSED_TIERS.join(", ")})`);
      process.exit(2);
    }
    const { tier, reason } = proposeTier(changed, readPackages(changed, from));
    console.log([tier, reason, declaredStatus(tier, declared)].join("\n"));
  } else {
    const mode = flag("--mode");
    const plan = planCheck(changed, mode === "slice" || mode === "quick" ? mode : "full");
    const tooling = plan.tooling ? (needsBrowserHarness(changed) ? 2 : 1) : 0;
    console.log([plan.mode, tooling, plan.ownTests.join(" ")].join("\n"));
  }
}
