#!/usr/bin/env node
// The standalone run: the core's tests on a copy of only the core's files, as they
// will run once the core is a tool of its own. It copies the manifest's `core` lines
// to a temp dir (a minimal package.json, the checkout's node_modules linked), puts a
// root config there, commits once on that config's trunk, and runs every core test
// file there with Vitest.
//
//   node scripts/loops/standalone.mjs [--root sample|project|none] [--limit S] [--keep]
//
//   --root   the config at the copy's root: the sample project's (default), this
//            checkout's risa.json, or none
//   --limit  a file running past S seconds (default 300) is hung: the run is stopped,
//            the file named, and the files it hadn't finished are run again without it
//   --keep   leave the copy (its path is printed) for a look
//
// Prints `<failed> <file>` per file with a failed test, `hung <file>` per hung file,
// then the total. Exit 0 only when nothing failed or hung; 2 on a usage error.
// The Vitest config names scripts/loops/test-setup.mjs when the copy has it.
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST = "scripts/loops/boundary.manifest";
const SAMPLE_CONFIG = "scripts/loops/sample-project/risa.json";
const SETUP = "scripts/loops/test-setup.mjs";
const ROOT_MODES = ["sample", "project", "none"];
const LIMIT_SECONDS = 300;

/**
 * The manifest's core files, in its order.
 * @param {string} text the manifest (`<path> core|project` lines)
 * @returns {string[]}
 */
export function coreFiles(text) {
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 2 && parts[1] === "core")
    .map(([path]) => path);
}

/**
 * What a run's report says: the failed tests per file, the totals, and the expected
 * files it has no result for (hung). A file that failed with no failed test (an
 * import or hook error) counts one.
 * @param {{ testResults?: { name: string, status?: string, assertionResults?: { status: string }[] }[] }} report
 *   Vitest's JSON report shape
 * @param {string[]} [expected] the files the run was given, as the report names them
 * @returns {{ failed: Record<string, number>, hung: string[], tests: number, failedTests: number, files: number }}
 */
export function failedFrom(report, expected = []) {
  /** @type {Record<string, number>} */
  const failed = {};
  let tests = 0;
  let failedTests = 0;
  const seen = new Set();
  for (const r of report.testResults ?? []) {
    seen.add(r.name);
    const results = r.assertionResults ?? [];
    tests += results.length;
    let n = results.filter((a) => a.status === "failed").length;
    if (n === 0 && r.status === "failed") n = 1;
    if (n > 0) failed[r.name] = (failed[r.name] ?? 0) + n;
    failedTests += n;
  }
  return { failed, hung: expected.filter((f) => !seen.has(f)), tests, failedTests, files: seen.size };
}

// The reporter the run adds: a JSON-report-shaped line per finished file, and a
// line per started one, appended as they happen, so a stopped run keeps its results.
const REPORTER = `import { appendFileSync } from "node:fs";
const out = process.env.STANDALONE_PROGRESS;
const put = (o) => appendFileSync(out, JSON.stringify(o) + "\\n");
export default class {
  onTestModuleStart(m) { put({ started: m.moduleId, at: Date.now() }); }
  onTestModuleEnd(m) {
    const tests = [...m.children.allTests()].map((t) => ({ fullName: t.fullName, status: t.result().state }));
    put({ name: m.moduleId, status: m.state() === "failed" ? "failed" : "passed", assertionResults: tests });
  }
}
`;

/** The Vitest config for FILES (paths relative to the copy). */
const vitestConfig = (files, setup) =>
  `export default ${JSON.stringify(
    {
      test: {
        root: ".",
        include: files,
        testTimeout: 20_000,
        setupFiles: setup ? [setup] : [],
        env: { RISA_LOAD_GATE: "off" },
        reporters: ["./.standalone-reporter.mjs"],
      },
    },
    null,
    2,
  )};\n`;

const git = (cwd, args) => {
  const r = spawnSync(
    "git",
    ["-c", "user.name=Standalone Run", "-c", "user.email=standalone@example.invalid", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
};

/** Copies the core files and the root config into a new repo; returns it and its test files. */
function makeCopy(rootMode) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "standalone-")));
  const repo = join(dir, "repo");
  const files = coreFiles(readFileSync(join(ROOT, MANIFEST), "utf8"));
  for (const f of files) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    copyFileSync(join(ROOT, f), join(repo, f));
  }
  const configFrom = { sample: SAMPLE_CONFIG, project: "risa.json", none: null }[rootMode];
  let trunk = "main";
  if (configFrom) {
    copyFileSync(join(ROOT, configFrom), join(repo, "risa.json"));
    trunk = JSON.parse(readFileSync(join(repo, "risa.json"), "utf8")).branches?.trunk ?? trunk;
  }
  writeFileSync(
    join(repo, "package.json"),
    `${JSON.stringify({ name: "standalone", private: true, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(join(repo, ".gitignore"), "node_modules\n.standalone-*\nvitest.config.mjs\n");
  symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
  git(repo, ["init", "-q", "-b", trunk]);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "core.hooksPath=/dev/null", "commit", "-q", "--no-verify", "-m", "the core's files"]);
  writeFileSync(join(repo, ".standalone-reporter.mjs"), REPORTER);
  const tests = files.filter((f) => /\.test\.m?[jt]s$/.test(f));
  return { dir, repo, tests, trunk, setup: files.includes(SETUP) ? SETUP : null };
}

const readLines = (path) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/**
 * Runs Vitest on FILES in the copy until it ends, or a file passes the limit (then
 * stops it, process group and all). Resolves with the lines it wrote and the hung file.
 */
function runOnce(copy, files, limitSeconds, round) {
  const progress = join(copy.dir, `progress-${round}.jsonl`);
  writeFileSync(join(copy.repo, "vitest.config.mjs"), vitestConfig(files, copy.setup));
  const env = { ...process.env, STANDALONE_PROGRESS: progress };
  // The root config is the copy's own (or none): never this checkout's by override.
  delete env.RISA_CONFIG;
  const child = spawn(
    process.execPath,
    [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.mjs"],
    { cwd: copy.repo, env, stdio: ["ignore", "ignore", "ignore"], detached: true },
  );
  return new Promise((resolve) => {
    /** @type {string | null} */
    let hung = null;
    const timer = setInterval(() => {
      const lines = readLines(progress);
      const done = new Set(lines.filter((l) => l.name).map((l) => l.name));
      const over = lines.find(
        (l) => l.started && !done.has(l.started) && Date.now() - l.at > limitSeconds * 1000,
      );
      if (over) {
        hung = over.started;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }, 1000);
    child.once("exit", () => {
      clearInterval(timer);
      // A hang's leftovers (a spawned script looping) share the group: stop them too.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // none left
      }
      resolve({ lines: readLines(progress), hung });
    });
  });
}

/** The whole run: rounds until every file has a result or is hung. */
async function run({ rootMode, limitSeconds, keep, log }) {
  const copy = makeCopy(rootMode);
  const abs = (f) => join(copy.repo, f);
  /** @type {any[]} */
  const results = [];
  /** @type {string[]} */
  const hung = [];
  let pending = copy.tests;
  for (let round = 1; pending.length; round++) {
    const { lines, hung: h } = await runOnce(copy, pending, limitSeconds, round);
    const ended = lines.filter((l) => l.name);
    results.push(...ended);
    const done = new Set(ended.map((l) => l.name));
    if (h) hung.push(h);
    const left = pending.filter((f) => !done.has(abs(f)) && !hung.includes(abs(f)));
    // A run that ended without a hang and still left files has nothing more to give.
    if (!h || left.length === pending.length) {
      for (const f of left) hung.push(abs(f));
      break;
    }
    pending = left;
  }
  const summary = failedFrom({ testResults: results });
  const rel = (f) => relative(copy.repo, f);
  for (const [file, n] of Object.entries(summary.failed).sort(([a], [b]) => (a < b ? -1 : 1)))
    log(`${n} ${rel(file)}`);
  for (const f of [...new Set(hung)].sort()) log(`hung ${rel(f)}`);
  log(
    `${rootMode}: ${summary.failedTests} failed of ${summary.tests} tests in ${Object.keys(summary.failed).length} files` +
      ` (${summary.files} of ${copy.tests.length} files ran, ${new Set(hung).size} hung)`,
  );
  if (keep) log(`kept: ${copy.repo}`);
  else rmSync(copy.dir, { recursive: true, force: true });
  return summary.failedTests === 0 && hung.length === 0 ? 0 : 1;
}

const USAGE = "usage: standalone.mjs [--root sample|project|none] [--limit SECONDS] [--keep]";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  let rootMode = "sample";
  let limitSeconds = LIMIT_SECONDS;
  let keep = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--root") rootMode = args[++i];
    else if (a === "--limit") limitSeconds = Number(args[++i]);
    else if (a === "--keep") keep = true;
    else rootMode = "";
    if (!ROOT_MODES.includes(rootMode) || !(limitSeconds > 0)) {
      console.error(USAGE);
      process.exit(2);
    }
  }
  process.exitCode = await run({ rootMode, limitSeconds, keep, log: (l) => console.log(l) });
}
