// check-hook.sh, the core's side of the check hook, on the sample project: it runs
// the project's check (the config's hooks.check, the sample's two-line script)
// with the mode, the base and the own test files, and then, when the plan says the
// diff touches the tooling, the tooling tests (check-tooling.mjs) with the
// check's rerun rules and state files. A stub vitest stands in for the tests.
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
import { checkProjects, failedFiles } from "./check-tooling.mjs";
import { makeRepo } from "./sample-project/repo.mjs";

let root, repo, calls, state;

// The stub vitest: log the arguments (but the reporters); a run reads
// $STUB_TESTS, "<file>:<times it fails>" pairs: a listed file still failing goes
// in the JSON report and fails the run.
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_CALLS, args.filter((a) => !a.startsWith("--reporter=") && !a.startsWith("--outputFile.json=")).join(" ") + "\\n");
const out = args.find((a) => a.startsWith("--outputFile.json=")).split("=")[1];
if (process.env.STUB_UNHANDLED) console.log("Vitest caught 1 unhandled error during the test run");
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
fs.writeFileSync(out, JSON.stringify({ testResults: failed.map((name) => ({ name: process.cwd() + "/" + name, status: "failed" })) }));
process.exit(failed.length || process.env.STUB_UNHANDLED ? 1 : 0);
`;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "check-hook-")));
  repo = join(root, "repo");
  calls = join(root, "calls");
  state = join(root, "state");
  makeRepo(repo);
  mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(repo, "node_modules/.bin/vitest"), STUB);
  chmodSync(join(repo, "node_modules/.bin/vitest"), 0o755);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const { RISA_CONFIG: _, ...env } = process.env;
const hook = (args, extra = {}, cwd = repo) => {
  writeFileSync(calls, "");
  rmSync(`${calls}.seen`, { force: true });
  rmSync(state, { recursive: true, force: true });
  mkdirSync(state);
  const r = spawnSync("bash", [join(repo, "scripts/loops/check-hook.sh"), ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...env,
      STUB_CALLS: calls,
      STUB_TESTS: "",
      STUB_UNHANDLED: "",
      SAMPLE_CHECK_EXIT: "",
      CARETOOK_CHECK_STATE: state,
      CARETOOK_CHECK_RERUN_MAX: "",
      ...extra,
    },
  });
  const read = (name) =>
    existsSync(join(state, name)) ? readFileSync(join(state, name), "utf8").trim().split("\n") : [];
  return {
    status: r.status,
    out: r.stdout,
    err: r.stderr,
    ran: readFileSync(calls, "utf8").trimEnd().split("\n").filter(Boolean),
    step: read("step")[0],
    failed: read("failed"),
    flaky: read("flaky"),
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

  it("fails with no check hook in the config", () => {
    const cfg = JSON.parse(readFileSync(join(repo, "risa.json"), "utf8"));
    delete cfg.hooks;
    const bare = join(root, "bare");
    makeRepo(bare, { files: { "risa.json": JSON.stringify(cfg) } });
    const r = spawnSync("bash", [join(bare, "scripts/loops/check-hook.sh"), "slice", "abc123", "1"], {
      cwd: bare,
      encoding: "utf8",
      env,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/sets no check hook \(hooks\.check\)/);
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
      CARETOOK_CHECK_RERUN_MAX: "1",
    });
    expect(m.status).toBe(1);
    expect(m.failed).toEqual(["a.test.mjs", "b.test.mjs"]);
    expect(m.ran).toEqual([TOOLS]);
  });
});

describe("check-tooling.mjs", () => {
  it("names the projects, and none for a config with no tooling tests", () => {
    const config = { testProjects: { tooling: ["t:unit"], browserHarness: "t:browser" } };
    expect(checkProjects(config, false)).toEqual(["t:unit"]);
    expect(checkProjects(config, true)).toEqual(["t:unit", "t:browser"]);
    expect(checkProjects({ testProjects: { tooling: ["t:unit"] } }, true)).toEqual(["t:unit"]);
    expect(checkProjects({}, true)).toBeNull();
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
