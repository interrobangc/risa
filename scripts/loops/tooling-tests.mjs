// tooling-tests.mjs: the tests `pnpm test:tooling` runs, after its lint. Always
// the Vitest projects the config's testProjects.tooling names; the browser harness
// test's (testProjects.browserHarness) too when the change touches what it tests
// (check-plan.mjs), when the check's base can't be found, or when files are named
// on the command line (they filter).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPlan } from "./check-plan.mjs";
import { loadConfig } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const git = (root, ...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
const lines = (r) => r.stdout.split("\n").filter(Boolean);

/**
 * The files changed since the check plan's base (committed, staged, unstaged and
 * untracked), or null when the base can't be determined.
 * @param {string} root the worktree
 * @returns {string[] | null}
 */
export function changedSinceBase(root) {
  const branch = git(root, "branch", "--show-current").stdout.trim();
  const asked = branch.startsWith("slice/") ? "slice" : "quick";
  const found = spawnSync(
    "bash",
    ["-c", 'source "$1/lib.sh" && check_base "$2" "$3"', "tooling-tests", HERE, root, asked],
    { encoding: "utf8" },
  );
  const base = found.status === 0 ? found.stdout.trim() : "";
  if (!/^[0-9a-f]{40}$/.test(base)) return null;
  const diff = git(root, "diff", "--name-only", "--no-renames", base);
  const untracked = git(root, "ls-files", "--others", "--exclude-standard");
  if (diff.status !== 0 || untracked.status !== 0) return null;
  return [...new Set([...lines(diff), ...lines(untracked)])];
}

/**
 * The Vitest projects for this run.
 * @param {string[] | null} changed the changed files, null when unknown
 * @param {string[]} [named] files named on the command line
 * @param {{ config?: Record<string, any>, plan?: import("./check-plan.mjs").CheckPlan }} [opts]
 *   the project's config and check plan (default: this repo's)
 * @returns {string[]}
 */
export function toolingProjects(changed, named = [], { config = loadConfig().config, plan } = {}) {
  const { tooling, browserHarness } = config.testProjects ?? {};
  if (!tooling)
    throw new Error("the project config sets no testProjects.tooling (the tooling tests' projects)");
  const projects = [...tooling];
  if (
    browserHarness &&
    (named.length || changed === null || (plan ?? checkPlan()).needsBrowserHarness(changed))
  )
    projects.push(browserHarness);
  return projects;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const named = process.argv.slice(2);
  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
  const projects = toolingProjects(root ? changedSinceBase(root) : null, named);
  const harness = loadConfig().config.testProjects?.browserHarness;
  if (harness && !projects.includes(harness))
    console.log("test:tooling: the browser harness test is skipped (nothing it tests changed)");
  const r = spawnSync(
    join(root, "node_modules/.bin/vitest"),
    ["run", ...projects.flatMap((p) => ["--project", p]), ...named],
    { cwd: root, stdio: "inherit" },
  );
  process.exit(r.status ?? 1);
}
