// check-tooling.mjs: the check's tooling step, which check-hook.sh runs after the
// project's check passed and the check plan said the diff touches the tooling.
// The Vitest projects of the config's testProjects.tooling (and its
// browserHarness with --harness: the plan decided), under the check's rerun
// rules, reporting to the check's state directory as the project's check does.
// The tests `pnpm test:tooling` runs (tooling-tests.mjs), without its lint (the
// check's static steps linted everything) and without the check plan (decided).
//
//   node check-tooling.mjs [--harness] [--state DIR] [--rerun-max N] [--file F]… [--ran]
//
// With --file (check-hook.sh, after a slice's own check: its Check files), only
// those files of the projects; a file in none of them runs nothing, and passes.
// With --ran too, those files already passed a run of their own (the slice's unit
// step, RISA-1021): any the projects hold (Vitest's own list) is skipped, in one
// line, so a Check file that is also a tooling test (Risa's own repo) runs once.
//
// No tooling tests in the config (testProjects.tooling unset): the project has
// none, so the step runs nothing and passes (tooling-tests.mjs too). First, the
// project-data check (project-check.mjs): its failure fails the step with its
// lines (step `tooling`), and no test runs.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
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
 * A Vitest JSON report's slowest test files, by each file's start and end time,
 * slowest first, names relative to cwd; none from an unreadable report. The core's
 * copy of the project's check-failed.mjs's.
 * @param {string} text
 * @param {string} cwd
 * @param {number} [n]
 * @returns {{ name: string, seconds: number }[]}
 */
export function slowestFiles(text, cwd, n = 10) {
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(report?.testResults)) return [];
  return report.testResults
    .filter(
      (/** @type {any} */ r) =>
        typeof r?.name === "string" &&
        Number.isFinite(r.startTime) &&
        Number.isFinite(r.endTime) &&
        r.endTime >= r.startTime,
    )
    .map((/** @type {any} */ r) => ({
      name: isAbsolute(r.name) ? relative(cwd, r.name) : r.name,
      seconds: Math.round((r.endTime - r.startTime) / 100) / 10,
    }))
    .sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name))
    .slice(0, n);
}

/**
 * Whether a Vitest run's output reports an unhandled error: only the runner's own
 * report line (`Vitest caught N unhandled error(s) during the test run`, or a
 * collection's `There were unhandled errors during test collection`), at a line's
 * start, colours stripped, so a test's title that says "unhandled error" (a `✓`
 * line, its file and describe first) never counts. The core's copy of the
 * project's check-failed.mjs's.
 * @param {string} text
 * @returns {boolean}
 */
export function unhandledError(text) {
  // eslint-disable-next-line no-control-regex -- the colour codes themselves
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  return /^(Vitest caught \d+ unhandled errors? during the test run|There were unhandled errors during test collection)/m.test(
    plain,
  );
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
 * The files of `files` the projects hold, by Vitest's own list (`vitest list
 * --filesOnly`), as given; none when the list fails, so each file runs as before.
 * @param {{ root: string, projects: string[], files: string[], vitest?: string }} opts
 * @returns {string[]}
 */
export function projectFiles({ root, projects, files, vitest }) {
  if (!files.length) return [];
  const work = mkdtempSync(join(tmpdir(), "tooling-list-"));
  const out = join(work, "list.json");
  try {
    const r = spawnSync(
      vitest ?? join(root, "node_modules/.bin/vitest"),
      ["list", "--filesOnly", `--json=${out}`, ...projects.flatMap((p) => ["--project", p]), ...files],
      { cwd: root, encoding: "utf8" },
    );
    if (r.status !== 0) return [];
    const listed = new Set(
      JSON.parse(readFileSync(out, "utf8")).map((/** @type {any} */ e) =>
        normalize(isAbsolute(e.file) ? relative(root, e.file) : e.file),
      ),
    );
    return files.filter((f) => listed.has(normalize(f)));
  } catch {
    return [];
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The check's tooling step: the tooling tests under the check's rerun rules. A
 * failed run reruns only its failed files, once, one at a time; a pass there
 * passes the step and names them as flakes. No rerun after an unhandled error (no
 * file owns it) or past `rerunMax` failed files. With a state directory, writes
 * `step` (tooling) and adds to `failed` and `flaky`, as the project's check does,
 * and to `times` (`<seconds> tooling`, the rerun included) and `slowest` (the
 * first run's ten slowest files, `<seconds> <file>` lines). With `files`, only
 * those files of the projects (none of them there: nothing runs, and it passes);
 * with `ran` too, those files already passed on their own, so the projects' own
 * among them are skipped (none left: nothing runs, and it passes).
 * @param {{ root: string, projects: string[], files?: string[], ran?: boolean, state?: string, rerunMax?: number, vitest?: string }} opts
 * @returns {Promise<number>} the step's exit code
 */
export async function toolingStep({
  root,
  projects,
  files = [],
  ran = false,
  state = "",
  rerunMax = 20,
  vitest,
}) {
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
  const started = Date.now();
  try {
    if (state) writeFileSync(join(state, "step"), "tooling\n");
    if (ran) {
      const done = projectFiles({ root, projects, files, vitest });
      if (done.length) {
        console.log(`tooling: skipping what the slice's unit step already ran and passed: ${done.join(" ")}`);
        files = files.filter((f) => !done.includes(f));
        if (!files.length) return 0;
      }
    }
    const first = join(work, "first.json");
    const run = await streamed(
      bin,
      [
        "run",
        ...flags,
        ...(files.length ? ["--passWithNoTests", ...files] : []),
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${first}`,
      ],
      root,
    );
    if (state) {
      let text = "";
      try {
        text = readFileSync(first, "utf8");
      } catch {
        // no report: no slowest files
      }
      appendFileSync(
        join(state, "slowest"),
        slowestFiles(text, root)
          .map((f) => `${f.seconds} ${f.name}\n`)
          .join(""),
      );
    }
    if (run.code === 0) return 0;
    const failed = reported(first);
    if (!failed.length) {
      console.log("tooling failed with no test file to rerun");
      return run.code;
    }
    if (unhandledError(run.out)) {
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
    if (state) appendFileSync(join(state, "times"), `${Math.round((Date.now() - started) / 1000)} tooling\n`);
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
  const state = opt("--state") ?? "";
  const files = args.flatMap((a, i) => (a === "--file" && args[i + 1] ? [args[i + 1]] : []));
  const here = dirname(fileURLToPath(import.meta.url));
  const checked = spawnSync(process.execPath, [join(here, "project-check.mjs")], {
    cwd: root || process.cwd(),
    stdio: "inherit",
  });
  if (checked.status !== 0) {
    if (state) writeFileSync(join(state, "step"), "tooling\n");
    console.log("tooling: the project-data check failed (above), so no tooling test ran");
    process.exitCode = checked.status ?? 1;
  } else if (!projects) {
    console.log(
      "The project config names no tooling tests (testProjects.tooling): the tooling step has none to run.",
    );
  } else {
    process.exitCode = await toolingStep({
      root: root || process.cwd(),
      projects,
      files,
      ran: files.length > 0 && args.includes("--ran"),
      state,
      rerunMax: Number.isInteger(max) && max >= 0 ? max : 20,
    });
  }
}
