// What `pnpm prd check` runs: the mode, why, the test files the diff itself
// adds or edits, and whether the tooling tests join. Pure: changed files and the
// asked mode in, a plan out. The CLI at the bottom reads the changed files from stdin.
//   node check-plan.mjs --mode slice|quick|full [--repo DIR --base REF --head REF]
//   → four lines: mode, reason,
//   tooling (2 with the browser harness test, 1 without, 0 for none), the diff's own integration and component test files
//   (space-separated)
// The three modes (check-body.sh runs them):
//   slice  a slice's hand-off: typecheck, lint, format, every unit test, and only
//          the integration and component test files the slice added or edited.
//          Never forced to full: the orchestrator's checks cover the rest.
//   quick  a prd/ or hotfix/ branch: the same, plus the integration tests related
//          to the diff; forced to full by the files below.
//   full   pnpm check and the build budget.
// A package.json that changed only its `scripts` forces nothing (package-diff.mjs).
// The CLI needs --base to tell: without it, any package.json still forces full.

import { readPackages, scriptsOnlyFiles } from "./package-diff.mjs";

/** Integration and component test files: the only tests a slice or quick check picks by name. */
const OWN_TEST = /\.(int\.test\.ts|browser\.test\.tsx)$/;

const FORCED = [
  [/^packages\/data\/src\/db\/migrations\//, "a migration"],
  [/^packages\/data\/(scripts|src)\/.*seed/i, "seeds"],
  [/^powersync\/sync-config\.yaml$/, "the sync config"],
  [/^pnpm-lock\.yaml$/, "the lockfile"],
  [/(^|\/)package\.json$/, "a package.json"],
  [/^vitest\.config\.ts$/, "the Vitest config"],
];

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
 * @param {Map<string, { base: string | null, head: string | null }>} [packages] both
 *   versions of each changed package.json; one missing here still forces full
 * @returns {{ mode: "slice" | "quick" | "full", reason: string, ownTests: string[], tooling: boolean }}
 */
export function planCheck(changed, asked, packages = new Map()) {
  const tooling = changed.some((f) => TOOLING.test(f));
  if (asked === "full") return { mode: "full", reason: "", ownTests: [], tooling };
  const ownTests = [...new Set(changed.filter((f) => OWN_TEST.test(f)))];
  if (asked === "slice") return { mode: "slice", reason: "", ownTests, tooling };
  const scriptsOnly = scriptsOnlyFiles(packages);
  for (const [re, what] of FORCED) {
    const file = changed.find((f) => re.test(f) && !scriptsOnly.has(f));
    if (file)
      return { mode: "full", reason: `${what} changed (${file}): a full check`, ownTests: [], tooling };
  }
  return { mode: "quick", reason: "", ownTests, tooling };
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
  const i = process.argv.indexOf("--mode");
  const asked = ["slice", "quick"].includes(process.argv[i + 1]) ? process.argv[i + 1] : "full";
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const changed = text.split("\n").filter(Boolean);
  const flag = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : "");
  const from = { repo: flag("--repo") || ".", base: flag("--base"), head: flag("--head") };
  const plan = planCheck(changed, asked, readPackages(changed, from));
  const tooling = plan.tooling ? (needsBrowserHarness(changed) ? 2 : 1) : 0;
  console.log([plan.mode, plan.reason, tooling, plan.ownTests.join(" ")].join("\n"));
}
