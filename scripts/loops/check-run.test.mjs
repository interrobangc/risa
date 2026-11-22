// check-run.sh (what prd.sh check runs inside the lease): one log line per run,
// pass or fail, with a stub command; the load gate's wait before it (a stubbed
// load: a file the tests write). And the lease's default of two check slots.
import { spawn, spawnSync } from "node:child_process";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseLog } from "./check-times.mjs";

const HERE = new URL(".", import.meta.url).pathname;
let root, logFile, loadFile;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "check-run-")));
  logFile = join(root, "log");
  // Never the real machine's load: a quiet one unless a test says otherwise.
  loadFile = join(root, "load");
  writeFileSync(loadFile, "1 1 1\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const run = (mode, why, cmd, extra = {}) =>
  spawnSync("bash", [join(HERE, "check-run.sh"), mode, why, "--", "sh", "-c", cmd], {
    cwd: HERE,
    encoding: "utf8",
    env: {
      ...process.env,
      CARETOOK_CHECK_LOG: logFile,
      CARETOOK_LOAD_FILE: loadFile,
      CARETOOK_LOAD_BUSY: "4",
      CARETOOK_LOAD_POLL: "0.2",
      CARETOOK_LOAD_GATE: "",
      CARETOOK_LEASES: "",
      ...extra,
    },
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

describe("check-run.sh test-file counts", () => {
  it("logs the counts a command writes to CARETOOK_CHECK_COUNTS", () => {
    expect(run("quick", "counts", 'echo "7 31" > "$CARETOOK_CHECK_COUNTS"').status).toBe(0);
    const { runs } = parseLog(readFileSync(logFile, "utf8"));
    expect(runs.at(-1)).toMatchObject({ mode: "quick", reason: "counts", filesRun: 7, filesAll: 31 });
  });
});

describe("check-run.sh failure fields", () => {
  it("logs the failed step and files, and the flakes of a run that passed", () => {
    const failing =
      'echo integration > "$CARETOOK_CHECK_STATE/step"; printf "b.int.test.ts\\na.int.test.ts\\n" > "$CARETOOK_CHECK_STATE/failed"; exit 1';
    expect(run("slice", "fails", failing).status).toBe(1);
    expect(parseLog(readFileSync(logFile, "utf8")).runs.at(-1)).toMatchObject({
      failedStep: "integration",
      failedFiles: ["a.int.test.ts", "b.int.test.ts"],
      flakyFiles: [],
    });
    const flaky = 'echo unit > "$CARETOOK_CHECK_STATE/step"; echo c.test.ts > "$CARETOOK_CHECK_STATE/flaky"';
    expect(run("slice", "flaky", flaky).status).toBe(0);
    expect(parseLog(readFileSync(logFile, "utf8")).runs.at(-1)).toMatchObject({
      exit: 0,
      failedStep: "",
      failedFiles: [],
      flakyFiles: ["c.test.ts"],
    });
  });

  it("still parses a line from before the fields", () => {
    const old = ["2026-11-21T12:00:00Z", "wt", "prd/x", "full", "why", "60", "1", "1", "1", "", "", "0"];
    const { runs, skipped } = parseLog(old.join("\t"));
    expect(skipped).toBe(0);
    expect(runs[0]).toMatchObject({ exit: 1, failedStep: "", failedFiles: [], flakyFiles: [] });
  });
});

describe("check-run.sh time limit", () => {
  const alive = (pid) => spawnSync("kill", ["-0", pid]).status === 0;

  it("stops past its limit, exits non-zero, leaves no child and logs the step", () => {
    const pidFile = join(root, "grandchild");
    const cmd = `echo unit > "$CARETOOK_CHECK_STATE/step"; sh -c 'trap "" TERM; echo $$ > "${pidFile}"; while :; do sleep 1; done' & wait`;
    const r = run("quick", "hangs", cmd, { CARETOOK_CHECK_LIMIT: "1", CARETOOK_CHECK_KILL_GRACE: "1" });
    expect(r.status).toBe(124);
    expect(r.stderr).toMatch(/limit of 1s in the unit step/);
    expect(alive(readFileSync(pidFile, "utf8").trim())).toBe(false);
    expect(parseLog(readFileSync(logFile, "utf8")).runs.at(-1)).toMatchObject({
      reason: "hangs",
      exit: 124,
      failedStep: "unit",
    });
  });
});

describe("check-run.sh load reading", () => {
  it("logs one numeric load when sysctl fails and uptime prints a Linux line", () => {
    const bin = join(root, "stubs");
    mkdirSync(bin, { recursive: true });
    const stub = (name, body) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    stub("sysctl", "exit 1");
    stub("uptime", 'echo " 10:00:00 up 3 days,  2:11,  1 user,  load average: 0.52, 0.58, 0.59"');
    const before = readFileSync(logFile, "utf8").split("\n").length - 1;
    expect(run("quick", "linux", "exit 0", { PATH: `${bin}:${process.env.PATH}` }).status).toBe(0);
    // Not lines(): its trimEnd would eat the empty trailing fields.
    const added = readFileSync(logFile, "utf8").split("\n").slice(before, -1);
    expect(added).toHaveLength(1);
    const fields = added[0].split("\t");
    expect(fields).toHaveLength(15);
    expect(fields[11]).toBe("0");
    expect(fields[6]).toBe("0.58");
    expect(fields[7]).toBe("0.58");
    const { runs, skipped } = parseLog(readFileSync(logFile, "utf8"));
    expect(skipped).toBe(0);
    expect(runs.at(-1)).toMatchObject({ reason: "linux", exit: 0 });
  });
});

describe("check-run.sh and the load gate", () => {
  // The same run, in the background, so a test can change the load meanwhile.
  const runAsync = (why, extra = {}) =>
    new Promise((resolve) => {
      const child = spawn("bash", [join(HERE, "check-run.sh"), "quick", why, "--", "sh", "-c", "echo ran"], {
        cwd: HERE,
        env: {
          ...process.env,
          CARETOOK_CHECK_LOG: logFile,
          CARETOOK_LOAD_FILE: loadFile,
          CARETOOK_LOAD_BUSY: "4",
          CARETOOK_LOAD_POLL: "0.2",
          CARETOOK_LOAD_GATE: "",
          CARETOOK_LEASES: "",
          ...extra,
        },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (status) => resolve({ status, out }));
    });
  const last = () => parseLog(readFileSync(logFile, "utf8")).runs.at(-1);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const busy = () => writeFileSync(loadFile, "9 9 9\n");
  const quiet = () => writeFileSync(loadFile, "1 1 1\n");

  it("waits while busy, starts when the load drops, and logs the wait", async () => {
    busy();
    const done = runAsync("waits");
    await sleep(1500);
    quiet();
    const r = await done;
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/machine is busy \(5-minute load 9, over 4\): waiting up to 600s before the check/);
    expect(r.out).toMatch(/load dropped to 1 \(threshold 4\) after \d+s: starting the check/);
    expect(r.out.indexOf("load dropped")).toBeLessThan(r.out.indexOf("ran"));
    expect(last()).toMatchObject({ reason: "waits", exit: 0 });
    expect(last().loadWaited).toBeGreaterThanOrEqual(1);
  });

  it("goes ahead after the bounded wait and says so", async () => {
    busy();
    const r = await runAsync("gives up", { CARETOOK_LOAD_WAIT: "1" });
    quiet();
    expect(r.status).toBe(0);
    expect(r.out).toMatch(
      /Gave up waiting for the load after \d+s \(still 9, over 4\): starting the check anyway/,
    );
    expect(r.out).toContain("ran");
    expect(last()).toMatchObject({ reason: "gives up", exit: 0 });
    expect(last().loadWaited).toBeGreaterThanOrEqual(1);
  });

  it("waits for nothing with CARETOOK_LOAD_GATE=off or CARETOOK_LEASES=off", async () => {
    busy();
    for (const extra of [{ CARETOOK_LOAD_GATE: "off" }, { CARETOOK_LEASES: "off" }]) {
      const r = await runAsync("no wait", { ...extra, CARETOOK_LOAD_WAIT: "30" });
      expect(r.status).toBe(0);
      expect(r.out).not.toMatch(/busy/);
      expect(last()).toMatchObject({ reason: "no wait", loadWaited: 0 });
    }
    quiet();
  });

  it("isn't busy when the load can't be read", async () => {
    const r = await runAsync("unread", {
      CARETOOK_LOAD_FILE: join(root, "no-such-file"),
      CARETOOK_LOAD_WAIT: "30",
    });
    expect(r.status).toBe(0);
    expect(r.out).not.toMatch(/busy/);
    expect(last()).toMatchObject({ reason: "unread", loadWaited: 0 });
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
