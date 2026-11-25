// tooling-tests.mjs: the tests `pnpm test:tooling` runs, after its lint. Always
// the Vitest projects the config's testProjects.tooling names; the browser harness
// test's (testProjects.browserHarness) too when the change touches what it tests
// (check-plan.mjs), when the check's base can't be found, or when files are named
// on the command line (they filter).
//
//   node tooling-tests.mjs [FILE…]   the run `pnpm test:tooling` makes
//   node tooling-tests.mjs --check [--harness] [--state DIR] [--rerun-max N]
//     the check's tooling step (check-hook.sh, after the project's check): the
//     projects, plus the harness's with --harness (the check plan decided), with
//     the check's rerun rules, reporting to the check's state directory
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
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

/**
 * The failed test files of a Vitest JSON report, relative to cwd, sorted; none
 * from an unreadable report. The core's copy of the project's check-failed.mjs (a
 * small pure module both sides use is copied, not shared).
 * @param {string} text
 * @param {string} cwd
 * @returns {string[]}
 */
export function failedFiles(text, cwd) {
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(report?.testResults)) return [];
  const names = report.testResults
    .filter((/** @type {any} */ r) => r?.status === "failed" && typeof r.name === "string")
    .map((/** @type {any} */ r) => (isAbsolute(r.name) ? relative(cwd, r.name) : r.name));
  return [...new Set(names)].sort();
}

/**
 * Runs a command in `cwd`, its output passed on as it comes and kept.
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ code: number, out: string }>}
 */
const streamed = (cmd, args, cwd) =>
  new Promise((done) => {
    let out = "";
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (b) => {
      out += b;
      process.stdout.write(b);
    });
    child.stderr.on("data", (b) => {
      out += b;
      process.stderr.write(b);
    });
    child.on("error", (e) => {
      process.stderr.write(`${e.message}\n`);
      done({ code: 127, out });
    });
    child.on("close", (code, signal) => done({ code: code ?? (signal ? 128 : 1), out }));
  });

/**
 * The projects the check's tooling step runs: the config's testProjects.tooling,
 * and its browserHarness when the check plan asked for it. Null when the config
 * names no tooling tests: the project has none, so the step has nothing to run.
 * @param {Record<string, any>} config
 * @param {boolean} harness
 * @returns {string[] | null}
 */
export function checkProjects(config, harness) {
  const { tooling, browserHarness } = config.testProjects ?? {};
  if (!tooling) return null;
  return harness && browserHarness ? [...tooling, browserHarness] : [...tooling];
}

/**
 * The check's tooling step: the tooling tests under the check's rerun rules. A
 * failed run reruns only its failed files, once, one at a time; a pass there
 * passes the step and names them as flakes. No rerun after an unhandled error (no
 * file owns it) or past `rerunMax` failed files. With a state directory, writes
 * `step` (tooling) and adds to `failed` and `flaky`, as the project's check does.
 * @param {{ root: string, projects: string[], state?: string, rerunMax?: number, vitest?: string }} opts
 * @returns {Promise<number>} the step's exit code
 */
export async function toolingStep({ root, projects, state = "", rerunMax = 20, vitest }) {
  const bin = vitest ?? join(root, "node_modules/.bin/vitest");
  const work = mkdtempSync(join(tmpdir(), "tooling-step-"));
  const record = (/** @type {string} */ kind, /** @type {string[]} */ files) => {
    if (state && files.length) appendFileSync(join(state, kind), files.map((f) => `${f}\n`).join(""));
  };
  const flags = projects.flatMap((p) => ["--project", p]);
  const reported = (/** @type {string} */ json) => {
    try {
      return failedFiles(readFileSync(json, "utf8"), root);
    } catch {
      return []; // no report: the run died before writing one
    }
  };
  try {
    if (state) writeFileSync(join(state, "step"), "tooling\n");
    const first = join(work, "first.json");
    const run = await streamed(
      bin,
      ["run", ...flags, "--reporter=default", "--reporter=json", `--outputFile.json=${first}`],
      root,
    );
    if (run.code === 0) return 0;
    const failed = reported(first);
    if (!failed.length) {
      console.log("tooling failed with no test file to rerun");
      return run.code;
    }
    if (/Unhandled (Error|Rejection)|unhandled error/.test(run.out)) {
      console.log("tooling: an unhandled error, so no rerun");
      record("failed", failed);
      return run.code;
    }
    if (failed.length > rerunMax) {
      console.log(`tooling: ${failed.length} files failed, so no rerun`);
      record("failed", failed);
      return run.code;
    }
    console.log(`tooling: rerunning the ${failed.length} failed file(s) alone: ${failed.join(" ")}`);
    const again = join(work, "again.json");
    const rerun = await streamed(
      bin,
      [
        "run",
        "--no-file-parallelism",
        ...flags,
        ...failed,
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${again}`,
      ],
      root,
    );
    if (rerun.code === 0) {
      console.log(`tooling: passed alone, logged as flaky: ${failed.join(" ")}`);
      record("flaky", failed);
      return 0;
    }
    // A rerun that failed and names no file proves nothing: every file still counts.
    const named = reported(again);
    const still = named.length ? named : failed;
    record("failed", still);
    record(
      "flaky",
      failed.filter((f) => !still.includes(f)),
    );
    console.log(`tooling: failed again: ${still.join(" ")}`);
    return rerun.code;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
  if (args[0] === "--check") {
    const opt = (/** @type {string} */ name) => {
      const i = args.indexOf(name);
      return i < 0 ? undefined : args[i + 1];
    };
    const max = Number(opt("--rerun-max") ?? 20);
    const projects = checkProjects(loadConfig().config, args.includes("--harness"));
    if (!projects) {
      console.log(
        "The project config names no tooling tests (testProjects.tooling): the tooling step has none to run.",
      );
    } else {
      process.exitCode = await toolingStep({
        root: root || process.cwd(),
        projects,
        state: opt("--state") ?? "",
        rerunMax: Number.isInteger(max) && max >= 0 ? max : 20,
      });
    }
  } else {
    const named = args;
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
}
