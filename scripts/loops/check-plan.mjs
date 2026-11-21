// What `pnpm prd check` runs: the mode, why, the tests a quick check always
// adds, and whether the tooling tests join. Pure: changed files and the asked
// mode in, a plan out. The CLI at the bottom reads the changed files from stdin.
//   node check-plan.mjs --mode quick|full   → four lines: mode, reason,
//   tooling (1 or 0), the always-run test files (space-separated)

/** Tests that read files by path, so `vitest --changed` can't see what breaks them. */
export const ALWAYS_RUN = [
  "scripts/loops/sync-matrix.test.mjs",
  "scripts/loops/check-areas.test.mjs",
  "scripts/loops/checks.test.mjs",
  "scripts/deploy/workflows.test.mjs",
  "apps/web/app/libLayout.test.ts",
  "apps/web/app/.server/securityHeaders.test.ts",
  "apps/web/app/routes/marketing/site/screenshots.test.ts",
  "packages/data/src/errors/errors.test.ts",
  "packages/data/src/db/roles/rolesSql.test.ts",
];

const FORCED = [
  [/^packages\/data\/src\/db\/migrations\//, "a migration"],
  [/^packages\/data\/(scripts|src)\/.*seed/i, "seeds"],
  [/^powersync\/sync-config\.yaml$/, "the sync config"],
  [/^pnpm-lock\.yaml$/, "the lockfile"],
  [/(^|\/)package\.json$/, "a package.json"],
  [/^vitest\.config\.ts$/, "the Vitest config"],
];

const TOOLING = /^(scripts\/loops\/|scripts\/backlog\/|\.githooks\/|scripts\/hooks\.test\.mjs$)/;

/**
 * @param {string[]} changed files changed against the base
 * @param {"quick" | "full"} asked
 * @returns {{ mode: "quick" | "full", reason: string, alwaysRun: string[], tooling: boolean }}
 */
export function planCheck(changed, asked) {
  const tooling = changed.some((f) => TOOLING.test(f));
  if (asked === "full") return { mode: "full", reason: "", alwaysRun: [], tooling };
  for (const [re, what] of FORCED) {
    const file = changed.find((f) => re.test(f));
    if (file)
      return { mode: "full", reason: `${what} changed (${file}): a full check`, alwaysRun: [], tooling };
  }
  return { mode: "quick", reason: "", alwaysRun: [...ALWAYS_RUN], tooling };
}

/** True when a quick check ran more than half of all test files. */
export const tooBroad = (run, all) => all > 0 && run * 2 > all;

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf("--mode");
  const asked = process.argv[i + 1] === "quick" ? "quick" : "full";
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const plan = planCheck(text.split("\n").filter(Boolean), asked);
  console.log([plan.mode, plan.reason, plan.tooling ? 1 : 0, plan.alwaysRun.join(" ")].join("\n"));
}
