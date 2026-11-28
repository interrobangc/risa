// write-verdict.mjs: the verdict file of one run of Risa's own CI
// (.github/workflows/ci.yml), the file `risa ci run --wait` reads from the run's
// VERDICT_ARTIFACT (ci-runs.mjs's readVerdict). The workflow runs it after
// `pnpm check`, pass or fail, and uploads what it writes. Its inputs, from the
// workflow's env:
//   VERDICT_OUT      the file to write
//   VERDICT_COMMIT   the commit the run tested
//   VERDICT_RUN_ID   the run's id
//   VERDICT_REF      the ref's short name (`ci/<tier>/<name>` names the tier)
//   CHECK_OUTCOME    the check step's outcome (success, failure, skipped, cancelled)
//   VERDICT_REPORT   vitest's JSON report (vitest.config.mjs writes it under RISA_CI_REPORT)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { VERDICT_VERSION } from "./ci-runs.mjs";

/** Failed tests named before the rest are left to the run's log. */
export const MAX_TESTS = 50;

/**
 * The failed files and tests in vitest's JSON report, paths relative to `root`.
 * @param {any} report
 * @param {string} job
 * @param {string} root
 */
export function failuresOf(report, job, root) {
  /** @type {string[]} */ const files = [];
  /** @type {{ job: string, file: string, name: string }[]} */ const tests = [];
  for (const result of report?.testResults ?? []) {
    const name = String(result.name ?? "");
    const file = isAbsolute(name) ? relative(root, name) : name;
    const failed = (result.assertionResults ?? []).filter((/** @type {any} */ a) => a.status === "failed");
    if (result.status !== "failed" && !failed.length) continue;
    files.push(file);
    for (const a of failed) tests.push({ job, file, name: String(a.fullName ?? a.title ?? "") });
  }
  return { files, tests };
}

/**
 * A run's verdict: green when the check passed, `file` when it failed (with the
 * failing tests the report names), infra when it never ran.
 * @param {{ commit: string, runId: string, tier: string, jobs: string[], outcome: string, report?: any, root?: string, narrowed?: { target: string, files: string[] } | null, forcedFlake?: string | null }} run
 */
export function buildVerdict({
  commit,
  runId,
  tier,
  jobs,
  outcome,
  report,
  root = "",
  narrowed,
  forcedFlake,
}) {
  const job = jobs[0] ?? "check";
  const kind = outcome === "success" ? "green" : outcome === "failure" ? "file" : "infra";
  const found = kind === "file" ? failuresOf(report, job, root) : { files: [], tests: [] };
  return {
    version: VERDICT_VERSION,
    commit,
    target: narrowed?.target ?? commit,
    runId: String(runId),
    tier,
    ranTier: tier,
    narrowed: !!narrowed,
    narrowedFiles: narrowed?.files ?? [],
    forcedFlake: forcedFlake ?? null,
    kind,
    failed: {
      jobs: kind === "file" ? [job] : [],
      files: found.files,
      tests: found.tests.slice(0, MAX_TESTS),
      truncated: found.tests.length > MAX_TESTS,
      unnamedJobs: kind === "file" && !found.tests.length ? [job] : [],
    },
    afterRerun: null,
    flaky: [],
    brake: { jobs: [], tests: [], files: [] },
    infra: { jobs: kind === "infra" ? [job] : [], notRun: [] },
    time: { jobs: [], breaches: [] },
    browser: null,
    secondZone: null,
    quarantined: [],
    quarantineList: [],
  };
}

const readJson = (/** @type {string | undefined} */ file) => {
  if (!file || !existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

async function main() {
  const { ciTiers } = await import("./tier-data.mjs");
  const tiers = ciTiers();
  const env = process.env;
  const tier = tiers.parseCiRef(env.VERDICT_REF ?? "")?.tier ?? /** @type {string} */ (tiers.TIERS[0]);
  const narrowed = readJson(tiers.NARROWED_FILE);
  const verdict = buildVerdict({
    commit: env.VERDICT_COMMIT ?? "",
    runId: env.VERDICT_RUN_ID ?? "",
    tier,
    jobs: tiers.jobsFor(tier).jobs,
    outcome: env.CHECK_OUTCOME ?? "",
    report: readJson(env.VERDICT_REPORT),
    root: process.cwd(),
    narrowed: narrowed ? { target: narrowed.target, files: narrowed.files ?? [] } : null,
    forcedFlake: readJson(tiers.FORCED_FLAKE_FILE)?.check ?? null,
  });
  const out = env.VERDICT_OUT || "verdict.json";
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(verdict, null, 2)}\n`);
  console.log(`verdict: ${verdict.kind} · ${verdict.tier} · ${verdict.commit.slice(0, 8)} -> ${out}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
