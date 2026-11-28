// check-hook.sh, the core's side of the check hook, on the sample project: it runs
// the project's check (the config's hooks.check, the sample's two-line script)
// with the mode, the base and the own test files, and then, when the plan says the
// diff touches the tooling, the tooling tests (check-tooling.mjs) with the
// check's rerun rules and state files, after the project-data check
// (project-check.mjs), which passes on the repo's sample data. A stub vitest
// stands in for the tests.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkProjects, failedFiles, slowestFiles, unhandledError } from "./check-tooling.mjs";
import { makeRepo, sampleData } from "./sample-project/repo.mjs";

let root, repo, calls, state;

// The stub vitest: log the arguments (but the reporters); a run reads
// $STUB_TESTS, "<file>:<times it fails>" pairs: a listed file still failing goes
// in the JSON report and fails the run. A first run reports $STUB_TIMES,
// "<file>:<seconds>" pairs, as passing files with their times.
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_CALLS, args.filter((a) => !a.startsWith("--reporter=") && !a.startsWith("--outputFile.json=")).join(" ") + "\\n");
const out = args.find((a) => a.startsWith("--outputFile.json=")).split("=")[1];
if (process.env.STUB_UNHANDLED) console.log("Vitest caught 1 unhandled error during the test run");
if (process.env.STUB_TITLE) console.log(" \u2713 scripts/x.test.mjs > the check > " + process.env.STUB_TITLE + " 12ms");
const seen = process.env.STUB_CALLS + ".seen";
const counts = fs.existsSync(seen) ? JSON.parse(fs.readFileSync(seen, "utf8")) : {};
const rerun = args.includes("--no-file-parallelism");
const failed = [];
for (const pair of (process.env.STUB_TESTS || "").split(",").filter(Boolean)) {
  const [file, times] = pair.split(":");
  if (rerun && !args.includes(file)) continue;
  counts[file] = (counts[file] || 0) + 1;
  if (counts[file] <= Number(times)) failed.push(file);
}
fs.writeFileSync(seen, JSON.stringify(counts));
const results = failed.map((name) => ({ name: process.cwd() + "/" + name, status: "failed" }));
for (const pair of rerun ? [] : (process.env.STUB_TIMES || "").split(",").filter(Boolean)) {
  const [file, secs] = pair.split(":");
  results.push({ name: process.cwd() + "/" + file, status: "passed", startTime: 5000, endTime: 5000 + Number(secs) * 1000 });
}
fs.writeFileSync(out, JSON.stringify({ testResults: results }));
process.exit(failed.length || process.env.STUB_UNHANDLED ? 1 : 0);
`;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "check-hook-")));
  repo = join(root, "repo");
  calls = join(root, "calls");
  state = join(root, "state");
  makeRepo(repo, { files: sampleData() });
  mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(repo, "node_modules/.bin/vitest"), STUB);
  chmodSync(join(repo, "node_modules/.bin/vitest"), 0o755);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const { RISA_CONFIG: _, ...env } = process.env;
const hook = (args, extra = {}, cwd = repo, at = repo) => {
  writeFileSync(calls, "");
  rmSync(`${calls}.seen`, { force: true });
  rmSync(state, { recursive: true, force: true });
  mkdirSync(state);
  const r = spawnSync("bash", [join(at, "loops/check-hook.sh"), ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...env,
      STUB_CALLS: calls,
      STUB_TESTS: "",
      STUB_TIMES: "",
      STUB_UNHANDLED: "",
      STUB_TITLE: "",
      SAMPLE_CHECK_EXIT: "",
      RISA_CHECK_STATE: state,
      RISA_CHECK_RERUN_MAX: "",
      ...extra,
    },
  });
  const read = (name) =>
    existsSync(join(state, name))
      ? readFileSync(join(state, name), "utf8").trim().split("\n").filter(Boolean)
      : [];
  return {
    status: r.status,
    out: r.stdout,
    err: r.stderr,
    ran: readFileSync(calls, "utf8").trimEnd().split("\n").filter(Boolean),
    step: read("step")[0],
    failed: read("failed"),
    flaky: read("flaky"),
    times: read("times"),
    slowest: read("slowest"),
  };
};

const TOOLS = "run --project tools:unit";

describe("check-hook.sh", () => {
  it("runs the project's check with the mode, the base and the own test files, and no tooling argument", () => {
    const r = hook(["slice", "abc123", "0", "a.int.test.ts", "b.browser.test.tsx"]);
    expect(r.status).toBe(0);
    expect(r.out).toBe("sample check: slice abc123 a.int.test.ts b.browser.test.tsx\n");
    expect(r.ran).toEqual([]);
  });

  it("runs it from the repo's root, wherever it is started", () => {
    mkdirSync(join(repo, "work"), { recursive: true });
    expect(hook(["quick", "abc123", "0"], {}, join(repo, "work")).out).toBe("sample check: quick abc123\n");
  });

  it("fails with the check's own code, and runs no tooling test after a failed check", () => {
    const r = hook(["full", "abc123", "1"], { SAMPLE_CHECK_EXIT: "5" });
    expect(r.status).toBe(5);
    expect(r.ran).toEqual([]);
  });

  it("then runs the config's tooling projects, and the browser harness's when the plan asks for it", () => {
    const r = hook(["slice", "abc123", "1"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/^sample check: slice abc123\n/);
    expect(r.ran).toEqual([TOOLS]);
    expect(r.step).toBe("tooling");
    expect(hook(["full", "abc123", "2"]).ran).toEqual([`${TOOLS} --project tools:browser`]);
  });

  it("fails the tooling step on the project-data check, with its lines, before any test", () => {
    const inbox = join(repo, "work/inbox.md");
    const text = readFileSync(inbox, "utf8");
    rmSync(inbox);
    try {
      const r = hook(["slice", "abc123", "1"]);
      expect(r.status).toBe(1);
      expect(r.out).toContain("work/inbox.md: missing (paths.inbox)\n");
      expect(r.out).toContain("the project-data check failed");
      expect(r.step).toBe("tooling");
      expect(r.ran).toEqual([]);
    } finally {
      writeFileSync(inbox, text);
    }
  });

  it("fails with no check hook in the config", () => {
    const cfg = JSON.parse(readFileSync(join(repo, "risa.json"), "utf8"));
    delete cfg.hooks;
    const bare = join(root, "bare");
    makeRepo(bare, { files: { "risa.json": JSON.stringify(cfg) } });
    const r = spawnSync("bash", [join(bare, "loops/check-hook.sh"), "slice", "abc123", "1"], {
      cwd: bare,
      encoding: "utf8",
      env,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/sets no check hook \(hooks\.check\)/);
  });
});

describe("the tooling step after the slice's own check (RISA-1015)", () => {
  // A sample repo whose config sets commands.testFile and staticCheck (stubs), on
  // slice branches part/t/3 (Check: loops/a.test.mjs) and part/t/4 (no Check).
  const PLAN =
    "# T plan\n\n## Slice 3: one file\n\nStack: no · Reads: a · Tests: unit · Check: loops/a.test.mjs\n\n" +
    "## Slice 4: no field\n\nStack: no · Reads: a · Tests: unit\n";
  let own;
  beforeAll(() => {
    own = join(root, "own");
    makeRepo(own, { files: { ...sampleData(), "work/plans/t-plan.md": PLAN } });
    const cfg = JSON.parse(readFileSync(join(own, "risa.json"), "utf8"));
    Object.assign(cfg.commands, { staticCheck: "true", testFile: "echo test file:" });
    writeFileSync(join(own, "risa.json"), JSON.stringify(cfg));
    mkdirSync(join(own, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(own, "node_modules/.bin/vitest"), STUB);
    chmodSync(join(own, "node_modules/.bin/vitest"), 0o755);
  });
  const onSlice = (n, tooling = "1") => {
    spawnSync("git", ["-C", own, "checkout", "-q", "-B", `part/t/${n}`]);
    return hook(["slice", "abc123", tooling], {}, own, own);
  };

  it("runs only the slice's Check file of the tooling projects, never the whole suite", () => {
    const r = onSlice(3);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain("test file: loops/a.test.mjs\n");
    expect(r.ran).toEqual([`${TOOLS} --passWithNoTests loops/a.test.mjs`]);
    expect(r.step).toBe("tooling");
    expect(onSlice(3, "2").ran).toEqual([
      `${TOOLS} --project tools:browser --passWithNoTests loops/a.test.mjs`,
    ]);
  });

  it("reruns that file alone when it fails, as the whole suite's step does", () => {
    spawnSync("git", ["-C", own, "checkout", "-q", "-B", "part/t/3"]);
    const r = hook(["slice", "abc123", "1"], { STUB_TESTS: "loops/a.test.mjs:1" }, own, own);
    expect(r.status).toBe(0);
    expect(r.flaky).toEqual(["loops/a.test.mjs"]);
  });

  it("runs the whole tooling suite as now for a slice with no Check field", () => {
    const r = onSlice(4);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toMatch(/^sample check: slice abc123\n/);
    expect(r.ran).toEqual([TOOLS]);
  });

  it("runs no tooling test when the plan says the diff touches none", () => {
    expect(onSlice(3, "0").ran).toEqual([]);
  });
});

describe("the check's tooling step reruns a failed test file", () => {
  it("a file that passes alone passes the step and is reported as a flake", () => {
    const r = hook(["slice", "abc123", "1"], { STUB_TESTS: "a.test.mjs:1" });
    expect(r.status).toBe(0);
    expect(r.flaky).toEqual(["a.test.mjs"]);
    expect(r.failed).toEqual([]);
    expect(r.ran).toEqual([TOOLS, "run --no-file-parallelism --project tools:unit a.test.mjs"]);
  });

  it("a file that fails twice fails the step, and a file that passed the rerun is a flake", () => {
    const r = hook(["slice", "abc123", "1"], { STUB_TESTS: "a.test.mjs:2,b.test.mjs:1" });
    expect(r.status).toBe(1);
    expect(r.step).toBe("tooling");
    expect(r.failed).toEqual(["a.test.mjs"]);
    expect(r.flaky).toEqual(["b.test.mjs"]);
    expect(r.out).toContain("tooling: failed again: a.test.mjs");
  });

  it("doesn't rerun after an unhandled error, or past the limit of failed files", () => {
    const u = hook(["slice", "abc123", "1"], { STUB_TESTS: "a.test.mjs:1", STUB_UNHANDLED: "1" });
    expect(u.status).toBe(1);
    expect(u.failed).toEqual(["a.test.mjs"]);
    expect(u.ran).toEqual([TOOLS]);
    const m = hook(["slice", "abc123", "1"], {
      STUB_TESTS: "a.test.mjs:1,b.test.mjs:1",
      RISA_CHECK_RERUN_MAX: "1",
    });
    expect(m.status).toBe(1);
    expect(m.failed).toEqual(["a.test.mjs", "b.test.mjs"]);
    expect(m.ran).toEqual([TOOLS]);
  });
  it("reruns when only a passing test's title says unhandled error (B-623, B-860)", () => {
    const r = hook(["slice", "abc123", "1"], {
      STUB_TESTS: "a.test.mjs:1",
      STUB_TITLE: "doesn't rerun after an Unhandled Error or an unhandled error",
    });
    expect(r.status).toBe(0);
    expect(r.flaky).toEqual(["a.test.mjs"]);
    expect(r.out).not.toContain("an unhandled error, so no rerun");
    expect(r.ran).toEqual([TOOLS, `run --no-file-parallelism --project tools:unit a.test.mjs`]);
  });
});

describe("the check's tooling step's times", () => {
  it("writes its seconds and its slowest files to the check's state directory", () => {
    const times = ["slow.test.mjs:90", ...Array.from({ length: 11 }, (_, i) => `t${i}.test.mjs:${i}`)];
    const r = hook(["slice", "abc123", "1"], { STUB_TIMES: times.join(",") });
    expect(r.status).toBe(0);
    expect(r.times).toHaveLength(1);
    expect(r.times[0]).toMatch(/^\d+ tooling$/);
    expect(r.slowest).toHaveLength(10);
    expect(r.slowest.slice(0, 2)).toEqual(["90 slow.test.mjs", "10 t10.test.mjs"]);
  });

  it("times a failed step too, its rerun included", () => {
    const r = hook(["slice", "abc123", "1"], { STUB_TESTS: "a.test.mjs:2" });
    expect(r.status).toBe(1);
    expect(r.times).toEqual([expect.stringMatching(/^\d+ tooling$/)]);
  });

  it("writes nothing when the plan runs no tooling tests", () => {
    const r = hook(["slice", "abc123", "0"]);
    expect(r.times).toEqual([]);
    expect(r.slowest).toEqual([]);
  });
});

describe("check-tooling.mjs", () => {
  it("finds an unhandled error only in Vitest's own report line, never in a test's title", () => {
    expect(unhandledError("\nVitest caught 1 unhandled error during the test run.\nThis might cause")).toBe(
      true,
    );
    expect(unhandledError("\x1b[31m\x1b[1m\nVitest caught 2 unhandled errors during the test run.")).toBe(
      true,
    );
    expect(unhandledError("x\n\x1b[31mVitest caught 1 unhandled error during the test run.")).toBe(true);
    expect(unhandledError("There were unhandled errors during test collection\n")).toBe(true);
    expect(
      unhandledError(
        " ✓ scripts/x.test.mjs > the check > doesn't rerun after an unhandled error 12ms\n" +
          " ✓ scripts/x.test.mjs > Unhandled Error and Unhandled Rejection are named 3ms\n" +
          " ✓ a > says Vitest caught 1 unhandled error during the test run 1ms\n",
      ),
    ).toBe(false);
  });

  it("names the projects, and none for a config with no tooling tests", () => {
    const config = { testProjects: { tooling: ["t:unit"], browserHarness: "t:browser" } };
    expect(checkProjects(config, false)).toEqual(["t:unit"]);
    expect(checkProjects(config, true)).toEqual(["t:unit", "t:browser"]);
    expect(checkProjects({ testProjects: { tooling: ["t:unit"] } }, true)).toEqual(["t:unit"]);
    expect(checkProjects({}, true)).toBeNull();
  });

  it("reads the slowest files of a report, and none of a broken one", () => {
    const report = JSON.stringify({
      testResults: [
        { name: "/r/a.test.mjs", status: "passed", startTime: 0, endTime: 1500 },
        { name: "/r/b.test.mjs", status: "failed", startTime: 0, endTime: 4000 },
        { name: "/r/c.test.mjs", status: "passed" },
      ],
    });
    expect(slowestFiles(report, "/r")).toEqual([
      { name: "b.test.mjs", seconds: 4 },
      { name: "a.test.mjs", seconds: 1.5 },
    ]);
    expect(slowestFiles("not json", "/r")).toEqual([]);
  });

  it("reads the failed files of a report, and none of a broken one", () => {
    const report = JSON.stringify({
      testResults: [
        { name: "/r/b.test.mjs", status: "failed" },
        { name: "/r/a.test.mjs", status: "failed" },
        { name: "/r/ok.test.mjs", status: "passed" },
      ],
    });
    expect(failedFiles(report, "/r")).toEqual(["a.test.mjs", "b.test.mjs"]);
    expect(failedFiles("not json", "/r")).toEqual([]);
  });
});
