// check-tooling.mjs's toolingStep under load (RISA-1088): the Vitest limits its run
// and its rerun get, by a stub vitest that works them out as vitest.config.mjs does
// (test-limits.mjs's testLimits of testLoad) and fails a file once. The load is a
// stand-in file (RISA_LOAD_FILE) and an injected reading, never the machine's.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { toolingStep } from "./check-tooling.mjs";

const LIMITS = new URL("./test-limits.mjs", import.meta.url).href;

// Logs "<first|rerun> <testTimeout> <hookTimeout>"; a.test.mjs fails the first run.
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const rerun = args.includes("--no-file-parallelism");
const out = args.find((a) => a.startsWith("--outputFile.json=")).split("=")[1];
import(${JSON.stringify(LIMITS)}).then(({ testLimits, testLoad }) => {
  const l = testLimits({ load: testLoad() });
  fs.appendFileSync(process.env.STUB_CALLS, (rerun ? "rerun" : "first") + " " + l.testTimeout + " " + l.hookTimeout + "\\n");
  const failed = rerun ? [] : ["a.test.mjs"];
  fs.writeFileSync(out, JSON.stringify({ testResults: failed.map((f) => ({ name: process.cwd() + "/" + f, status: "failed" })) }));
  process.exit(failed.length ? 1 : 0);
});
`;

let root, calls, loadFile;
const saved = {};
const VARS = ["STUB_CALLS", "RISA_LOAD_FILE", "RISA_TEST_LOAD"];

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "check-tooling-")));
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(root, "node_modules/.bin/vitest"), STUB);
  chmodSync(join(root, "node_modules/.bin/vitest"), 0o755);
  calls = join(root, "calls");
  loadFile = join(root, "loadavg");
  for (const v of VARS) saved[v] = process.env[v];
});
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The step at the machine load LOADAVG ("1m 5m 15m"), its own readings READINGS in turn. */
const step = async (loadavg, readings) => {
  writeFileSync(calls, "");
  writeFileSync(loadFile, loadavg);
  process.env.STUB_CALLS = calls;
  process.env.RISA_LOAD_FILE = loadFile;
  delete process.env.RISA_TEST_LOAD;
  const queue = [...readings];
  const code = await toolingStep({ root, projects: ["t:unit"], load: () => queue.shift() ?? null });
  const lines = readFileSync(calls, "utf8").trim().split("\n");
  return { code, runs: Object.fromEntries(lines.map((l) => l.split(" ")).map(([k, t, h]) => [k, [+t, +h]])) };
};

describe("toolingStep's limits under load", () => {
  it("gives the run and its rerun well over 20 s at a 1-minute load of 50 the 5-minute hasn't caught", async () => {
    // Two full checks overlapping on 16 cores: the 1-minute load at 50, the 5-minute still low.
    const { code, runs } = await step("50.00 14.00 8.00", [50, 18]);
    expect(code).toBe(0);
    expect(runs.first).toEqual([60_000, 30_000]);
    // The load eased by the rerun: it keeps the first run's limits, never lower.
    expect(runs.rerun).toEqual([60_000, 30_000]);
  });

  it("raises the rerun's limits when the load rose after the first run", async () => {
    const { runs } = await step("12.00 10.00 8.00", [12, 45]);
    expect(runs.first).toEqual([20_000, 10_000]);
    expect(runs.rerun).toEqual([60_000, 30_000]);
  });

  it("keeps the 20 s and 10 s limits at an idle load, and an unread reading changes nothing", async () => {
    expect((await step("2.00 3.00 3.00", [3, 2])).runs).toEqual({
      first: [20_000, 10_000],
      rerun: [20_000, 10_000],
    });
    expect((await step("2.00 3.00 3.00", [null, null])).runs).toEqual({
      first: [20_000, 10_000],
      rerun: [20_000, 10_000],
    });
  });
});
