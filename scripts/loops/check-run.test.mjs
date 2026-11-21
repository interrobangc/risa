// check-run.sh (what prd.sh check runs inside the lease): one log line per run,
// pass or fail, with a stub command. And the lease's default of two check slots.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseLog } from "./check-times.mjs";

const HERE = new URL(".", import.meta.url).pathname;
let root, logFile;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "check-run-")));
  logFile = join(root, "log");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const run = (mode, why, cmd, extra = {}) =>
  spawnSync("bash", [join(HERE, "check-run.sh"), mode, why, "--", "sh", "-c", cmd], {
    cwd: HERE,
    encoding: "utf8",
    env: { ...process.env, CARETOOK_CHECK_LOG: logFile, ...extra },
  });
const lines = () => readFileSync(logFile, "utf8").trimEnd().split("\n");

describe("check-run.sh", () => {
  it("logs a passing and a failing check, one line each, and keeps the exit code", () => {
    expect(run("full", "", "exit 0").status).toBe(0);
    expect(
      run("quick", "tweaked a doc\tand more", "exit 3", {
        CARETOOK_CHECK_FILES_RUN: "4",
        CARETOOK_CHECK_FILES_ALL: "90",
      }).status,
    ).toBe(3);
    expect(lines()).toHaveLength(2);
    const { runs, skipped } = parseLog(readFileSync(logFile, "utf8"));
    expect(skipped).toBe(0);
    expect(runs[0]).toMatchObject({ mode: "full", exit: 0, filesRun: null });
    expect(runs[1]).toMatchObject({
      mode: "quick",
      reason: "tweaked a doc and more",
      exit: 3,
      filesRun: 4,
      filesAll: 90,
    });
    expect(runs[1].seconds).toBeGreaterThanOrEqual(0);
    expect(runs[1].branch).not.toBe("");
  });
});

describe("check lease slots", () => {
  const holders = (extra = {}) => {
    const env = { ...process.env, CARETOOK_LEASE_ROOT: join(root, "leases"), ...extra };
    delete env.CARETOOK_CHECK_SLOTS;
    Object.assign(env, extra);
    return spawnSync("bash", [join(HERE, "lease.sh"), "holders", "check"], { env, encoding: "utf8" }).stdout;
  };
  it("defaults to two, and CARETOOK_CHECK_SLOTS changes it", () => {
    expect(holders()).toMatch(/^check leases: 0 of 2 held$/m);
    expect(holders({ CARETOOK_CHECK_SLOTS: "5" })).toMatch(/^check leases: 0 of 5 held$/m);
  });
});
