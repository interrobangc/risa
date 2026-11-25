// check-tooling.mjs: the check's tooling step, which check-hook.sh runs after the
// project's check passed and the check plan said the diff touches the tooling.
// The Vitest projects of the config's testProjects.tooling (and its
// browserHarness with --harness: the plan decided), under the check's rerun
// rules, reporting to the check's state directory as the project's check does.
// The tests `pnpm test:tooling` runs (tooling-tests.mjs), without its lint (the
// check's static steps linted everything) and without the check plan (decided).
//
//   node check-tooling.mjs [--harness] [--state DIR] [--rerun-max N]
//
// No tooling tests in the config (testProjects.tooling unset): the project has
// none, so the step runs nothing and passes (tooling-tests.mjs, asked by hand to
// run tests it can't name, refuses instead).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { loadConfig } from "./config.mjs";

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
}
