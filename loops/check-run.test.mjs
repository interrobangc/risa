// check-run.sh (what prd.sh check runs inside the lease): one log line per run,
// pass or fail, with a stub command; the load gate's wait before it (a stubbed
// load: a file the tests write); the budget and the silence limit, and a
// machine sleep (a fake clock) that counts against neither; the time gate on a
// finished quick or slice check (a fake clock and load, a fixture config with
// the local measure armed). The slice's own check (check-hook.sh, RISA-1005): on
// a slice branch of a sample repo whose plan names a slice's Check file, only that
// file through the config's testFile. And the lease's default of two check slots.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseLog } from "./check-times.mjs";
import { fixtureTierData } from "./config-fixture.mjs";
import { SAMPLE_CONFIG, makeRepo } from "./sample-project/repo.mjs";

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

// A path in the check's state directory, for a stub command to write to.
const inState = (name) => `"$RISA_CHECK_STATE/${name}"`;

// clock: the fake clock's file (none: the real clock).
const run = (mode, why, cmd, { clock = "", ...extra } = {}) =>
  spawnSync("bash", [join(HERE, "check-run.sh"), mode, why, "--", "sh", "-c", cmd], {
    cwd: HERE,
    encoding: "utf8",
    env: {
      ...process.env,
      RISA_CHECK_LOG: logFile,
      RISA_LOAD_FILE: loadFile,
      RISA_LOAD_BUSY: "4",
      RISA_LOAD_POLL: "0.2",
      RISA_LOAD_GATE: "",
      RISA_LEASES: "",
      RISA_CHECK_LIMIT: "",
      RISA_CHECK_SILENCE: "",
      RISA_CHECK_BUDGET_LOAD: "1",
      RISA_CLOCK_FILE: clock,
      ...extra,
    },
  });
const lines = () => readFileSync(logFile, "utf8").trimEnd().split("\n");

describe("check-run.sh", () => {
  it("logs a passing and a failing check, one line each, and keeps the exit code", () => {
    expect(run("full", "", "exit 0").status).toBe(0);
    expect(
      run("quick", "tweaked a doc\tand more", "exit 3", {
        RISA_CHECK_FILES_RUN: "4",
        RISA_CHECK_FILES_ALL: "90",
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
  it("logs the counts a command writes to RISA_CHECK_COUNTS", () => {
    expect(run("quick", "counts", 'echo "7 31" > "$RISA_CHECK_COUNTS"').status).toBe(0);
    const { runs } = parseLog(readFileSync(logFile, "utf8"));
    expect(runs.at(-1)).toMatchObject({ mode: "quick", reason: "counts", filesRun: 7, filesAll: 31 });
  });
});

describe("check-run.sh failure fields", () => {
  it("logs the failed step and files, and the flakes of a run that passed", () => {
    const failing = `echo integration > ${inState("step")}; printf "b.int.test.ts\\na.int.test.ts\\n" > ${inState("failed")}; exit 1`;
    expect(run("slice", "fails", failing).status).toBe(1);
    expect(parseLog(readFileSync(logFile, "utf8")).runs.at(-1)).toMatchObject({
      failedStep: "integration",
      failedFiles: ["a.int.test.ts", "b.int.test.ts"],
      flakyFiles: [],
    });
    const flaky = `echo unit > ${inState("step")}; echo c.test.ts > ${inState("flaky")}`;
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

describe("check-run.sh budget and silence limit", () => {
  const alive = (pid) => spawnSync("kill", ["-0", pid]).status === 0;
  // A step, a line of output, then a grandchild that ignores TERM and hangs.
  const hang = (pidFile) =>
    `echo unit > ${inState("step")}; echo "last words"; sh -c 'trap "" TERM; echo $$ > "${pidFile}"; while :; do sleep 1; done' & wait`;
  const lastRun = () => parseLog(readFileSync(logFile, "utf8")).runs.at(-1);

  it("stops past its budget, exits non-zero, leaves no child, prints the last lines and logs why", () => {
    const pidFile = join(root, "grandchild");
    const r = run("quick", "hangs", hang(pidFile), {
      RISA_CHECK_LIMIT: "1",
      RISA_CHECK_KILL_GRACE: "1",
    });
    expect(r.status).toBe(124);
    expect(r.stdout).toMatch(/^Check budget 0m01s \(the hard limit/m);
    expect(r.stderr).toMatch(/passed its budget of 1s in the unit step and was stopped/);
    expect(r.stderr).toContain("  | last words");
    expect(alive(readFileSync(pidFile, "utf8").trim())).toBe(false);
    expect(lastRun()).toMatchObject({
      reason: "hangs",
      exit: 124,
      failedStep: "unit",
      failedFiles: [],
      breach: "budget",
    });
  });

  it("stops at its silence limit well inside its budget", () => {
    const pidFile = join(root, "grandchild-quiet");
    const r = run("slice", "goes quiet", hang(pidFile), {
      RISA_CHECK_SILENCE: "1",
      RISA_CHECK_KILL_GRACE: "1",
    });
    expect(r.status).toBe(124);
    expect(r.stderr).toMatch(/printed nothing for 1s in the unit step and was stopped/);
    expect(r.stderr).toContain("  | last words");
    expect(alive(readFileSync(pidFile, "utf8").trim())).toBe(false);
    expect(lastRun()).toMatchObject({
      reason: "goes quiet",
      exit: 124,
      failedStep: "unit",
      breach: "silence",
    });
    expect(lastRun().seconds).toBeLessThan(10);
  });

  it("passes a slow check that keeps printing inside its budget", () => {
    const r = run(
      "slice",
      "slow but talking",
      "for i in 1 2 3 4 5 6 7 8 9 10; do echo tick $i; sleep 0.3; done",
      {
        RISA_CHECK_LIMIT: "20",
        RISA_CHECK_SILENCE: "1",
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("tick 10");
    expect(r.stderr).not.toMatch(/stopped/);
    expect(lastRun()).toMatchObject({ reason: "slow but talking", exit: 0, breach: "" });
  });

  it("keeps stdout and stderr apart", () => {
    const r = run("slice", "two streams", "echo to-out; echo to-err >&2");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("to-out");
    expect(r.stdout).not.toContain("to-err");
    expect(r.stderr).toContain("to-err");
  });

  it("doesn't count a machine sleep against either limit", () => {
    // The fake clock jumps an hour while the command is quiet: a sleep. Then it
    // keeps going past a second, quietly, and passes.
    const clock = join(root, "clock");
    writeFileSync(clock, "2000000000\n");
    const cmd = `sleep 0.6; echo 2000003600 > "${clock}.new"; mv "${clock}.new" "${clock}"; sleep 0.6; echo awake`;
    const r = run("slice", "slept", cmd, {
      clock,
      RISA_CHECK_LIMIT: "5",
      RISA_CHECK_SILENCE: "3",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/stopped/);
    expect(lastRun()).toMatchObject({ reason: "slept", exit: 0, breach: "" });
    expect(lastRun().seconds).toBeLessThan(5);
  });

  it("still stops past its budget after a sleep, counting only the time awake", () => {
    const clock = join(root, "clock-2");
    writeFileSync(clock, "2000000000\n");
    // An hour's sleep, then the clock goes on: 3 s awake against a 2 s budget.
    const tick = (t) => `echo ${t} > "${clock}.new"; mv "${clock}.new" "${clock}"; sleep 0.5`;
    const cmd = `echo working; sleep 0.5; ${tick(2000003600)}; ${tick(2000003601)}; ${tick(2000003603)}; sleep 30`;
    const r = run("slice", "slept then hung", cmd, {
      clock,
      RISA_CHECK_LIMIT: "2",
      RISA_CHECK_SILENCE: "100",
      RISA_CHECK_KILL_GRACE: "1",
    });
    expect(r.status).toBe(124);
    expect(lastRun()).toMatchObject({ reason: "slept then hung", breach: "budget" });
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
    expect(fields).toHaveLength(18);
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
          RISA_CHECK_LOG: logFile,
          RISA_LOAD_FILE: loadFile,
          RISA_LOAD_BUSY: "4",
          RISA_LOAD_POLL: "0.2",
          RISA_LOAD_GATE: "",
          RISA_LEASES: "",
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
  // Replace the load file by rename, never truncate it in place: the gate
  // polls it, and a half-written (empty) file reads as no load (RISA-1018).
  const setLoad = (text) => {
    writeFileSync(`${loadFile}.tmp`, text);
    renameSync(`${loadFile}.tmp`, loadFile);
  };
  const busy = () => setLoad("9 9 9\n");
  const quiet = () => setLoad("1 1 1\n");

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
    const r = await runAsync("gives up", { RISA_LOAD_WAIT: "1" });
    quiet();
    expect(r.status).toBe(0);
    expect(r.out).toMatch(
      /Gave up waiting for the load after \d+s \(still 9, over 4\): starting the check anyway/,
    );
    expect(r.out).toContain("ran");
    expect(last()).toMatchObject({ reason: "gives up", exit: 0 });
    expect(last().loadWaited).toBeGreaterThanOrEqual(1);
  });

  it("waits for nothing with RISA_LOAD_GATE=off or RISA_LEASES=off", async () => {
    busy();
    for (const extra of [{ RISA_LOAD_GATE: "off" }, { RISA_LEASES: "off" }]) {
      const r = await runAsync("no wait", { ...extra, RISA_LOAD_WAIT: "30" });
      expect(r.status).toBe(0);
      expect(r.out).not.toMatch(/busy/);
      expect(last()).toMatchObject({ reason: "no wait", loadWaited: 0 });
    }
    quiet();
  });

  it("isn't busy when the load can't be read", async () => {
    const r = await runAsync("unread", {
      RISA_LOAD_FILE: join(root, "no-such-file"),
      RISA_LOAD_WAIT: "30",
    });
    expect(r.status).toBe(0);
    expect(r.out).not.toMatch(/busy/);
    expect(last()).toMatchObject({ reason: "unread", loadWaited: 0 });
  });
});

describe("check-run.sh and the time gate", () => {
  let armedConfig, stubs, sysload;
  beforeAll(() => {
    // The load the check logs and the gate judges: a stub sysctl reads it from a
    // file (1, quiet on any machine; a test makes it busy).
    stubs = join(root, "gate-stubs");
    sysload = join(root, "sysload");
    mkdirSync(stubs, { recursive: true });
    writeFileSync(sysload, "1 1 1\n");
    writeFileSync(join(stubs, "sysctl"), `#!/bin/sh\necho "{ $(cat "${sysload}") }"\n`);
    chmodSync(join(stubs, "sysctl"), 0o755);
    // The config in RISA_CONFIG and its tier data, with the local measure armed.
    const dir = join(root, "armed");
    mkdirSync(dir, { recursive: true });
    const config = JSON.parse(readFileSync(/** @type {string} */ (process.env.RISA_CONFIG), "utf8"));
    const tiers = JSON.parse(fixtureTierData().text);
    tiers.gates.measures.quick.armed = true;
    config.paths.tierData = "tiers.json";
    writeFileSync(join(dir, "tiers.json"), JSON.stringify(tiers));
    armedConfig = join(dir, "risa.json");
    writeFileSync(armedConfig, JSON.stringify(config));
  });

  // A check that reports its step times and slowest files, then takes 400 s on
  // the fake clock (one jump, under the sleep gap); `end` runs last (a load change).
  const timed = (mode, { end = "", exit = 0, extra = {} } = {}) => {
    const clock = join(root, `clock-gate-${mode}`);
    writeFileSync(clock, "2000000000\n");
    const cmd = [
      `printf "5 typegen\\n80 static\\n150 unit\\n165 tooling\\n" > ${inState("times")}`,
      `printf "120 scripts/loops/fictional-slow.test.mjs\\n9 lib/fictional.test.ts\\n" > ${inState("slowest")}`,
      "sleep 0.5",
      `echo 2000000400 > "${clock}.new"`,
      `mv "${clock}.new" "${clock}"`,
      "sleep 0.5",
      end,
      `exit ${exit}`,
    ]
      .filter(Boolean)
      .join("; ");
    return run(mode, `gate ${mode}`, cmd, {
      clock,
      RISA_CHECK_SLEEP_GAP: "1000",
      PATH: `${stubs}:${process.env.PATH}`,
      ...extra,
    });
  };
  const lastRun = () => parseLog(readFileSync(logFile, "utf8")).runs.at(-1);
  const STEPS = [
    { step: "typegen", seconds: 5 },
    { step: "static", seconds: 80 },
    { step: "unit", seconds: 150 },
    { step: "tooling", seconds: 165 },
  ];

  it("fails a quiet 400 s quick check that passed when the measure is armed, naming its steps and slowest files", () => {
    const r = timed("quick", { extra: { RISA_CONFIG: armedConfig } });
    expect(r.status).toBe(125);
    expect(r.stderr).toContain(
      "Time gate quick: 6m40s (400 s); aim 5m00s, cutoff 6m00s: FAIL, 40 s past the cutoff.",
    );
    // The tooling step's seconds count: it is one of the steps named, the slowest.
    expect(r.stderr).toContain("  steps: tooling 165 s, unit 150 s, static 80 s, typegen 5 s");
    expect(r.stderr).toMatch(/120 s {2}scripts\/loops\/fictional-slow\.test\.mjs/);
    expect(r.stderr).toContain("A time breach, not a test failure");
    expect(lastRun()).toMatchObject({
      reason: "gate quick",
      seconds: 400,
      exit: 125,
      failedStep: "",
      breach: "",
      verdict: "fail",
      stepTimes: STEPS,
    });
  });

  it("warns, saying not armed, and passes when the measure isn't armed", () => {
    const r = timed("slice");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "Time gate quick: 6m40s (400 s); aim 5m00s, cutoff 6m00s: WARN, 40 s past the cutoff, not armed.",
    );
    expect(r.stdout).toContain("  steps: tooling 165 s");
    expect(lastRun()).toMatchObject({ exit: 0, verdict: "warn", stepTimes: STEPS });
  });

  it("doesn't judge a check that ended on a busy machine", () => {
    try {
      const r = timed("quick", {
        end: `echo "99999 99999 99999" > "${sysload}"`,
        extra: { RISA_CONFIG: armedConfig },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(
        /Time gate quick: 6m40s \(400 s\).*: not judged \(load 1 at the start, 99999 at the end/,
      );
      expect(lastRun()).toMatchObject({ exit: 0, verdict: "unjudged", stepTimes: STEPS });
    } finally {
      writeFileSync(sysload, "1 1 1\n");
    }
  });

  it("doesn't judge a full check, or a check that failed", () => {
    const full = timed("full", { extra: { RISA_CONFIG: armedConfig } });
    expect(full.status).toBe(0);
    expect(full.stdout + full.stderr).not.toMatch(/Time gate/);
    expect(lastRun()).toMatchObject({ mode: "full", exit: 0, verdict: "", stepTimes: STEPS });
    const failed = timed("quick", { exit: 1, extra: { RISA_CONFIG: armedConfig } });
    expect(failed.status).toBe(1);
    expect(failed.stdout + failed.stderr).not.toMatch(/Time gate/);
    expect(lastRun()).toMatchObject({ mode: "quick", exit: 1, verdict: "" });
  });
});

describe("the slice's own check (check-hook.sh)", () => {
  // A sample repo per config (with or without testFile) on a slice branch, part/t/3;
  // its plan names Check: a.test.mjs for slice 3 and no Check for slice 4. The
  // stubs print what ran: the static check, the test-file runner, the check hook.
  const PLAN =
    "# T plan\n\n## Slice 3: one file\n\nStack: no · Reads: a · Tests: unit · Check: a.test.mjs\n\n" +
    "## Slice 4: no field\n\nStack: no · Reads: a · Tests: unit\n";
  const repoFor = (name, commands) => {
    const dir = join(root, `own-${name}`);
    const cfgDir = join(dir, "cfg");
    mkdirSync(cfgDir, { recursive: true });
    cpSync(join(HERE, "sample-project/tools"), join(cfgDir, "tools"), { recursive: true });
    const config = JSON.parse(readFileSync(SAMPLE_CONFIG, "utf8"));
    Object.assign(config.commands, commands);
    writeFileSync(join(cfgDir, "risa.json"), JSON.stringify(config));
    const repo = join(dir, "repo");
    makeRepo(repo, {
      config: join(cfgDir, "risa.json"),
      files: {
        "work/plans/t-plan.md": PLAN,
        "tools/static.sh": 'echo "static check"\n',
        "tools/test-file.sh": 'echo "test file: $*"; exit "${TEST_FILE_EXIT:-0}"\n',
      },
    });
    return repo;
  };
  const STUBS = { staticCheck: "sh tools/static.sh", testFile: "sh tools/test-file.sh" };
  let withKey, withoutKey;
  beforeAll(() => {
    withKey = repoFor("key", STUBS);
    withoutKey = repoFor("nokey", {});
  });
  const { RISA_CONFIG: _, ...env } = process.env;
  const sliceCheck = (repo, n, extra = {}) => {
    execFileSync("git", ["-C", repo, "checkout", "-q", "-B", `part/t/${n}`]);
    const loops = join(repo, "loops");
    return spawnSync(
      "bash",
      [
        join(loops, "check-run.sh"),
        "slice",
        "own",
        "--",
        "bash",
        join(loops, "check-hook.sh"),
        "slice",
        "HEAD",
        "0",
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...env,
          RISA_MACHINE_CONFIG: "",
          RISA_CHECK_LOG: join(root, "own-log"),
          RISA_LOAD_FILE: loadFile,
          RISA_LOAD_GATE: "",
          RISA_LEASES: "",
          RISA_CHECK_LIMIT: "",
          RISA_CHECK_SILENCE: "",
          RISA_CHECK_BUDGET_LOAD: "1",
          RISA_CLOCK_FILE: "",
          SAMPLE_CHECK_EXIT: "",
          TEST_FILE_EXIT: "",
          ...extra,
        },
      },
    );
  };
  const ownRuns = () => parseLog(readFileSync(join(root, "own-log"), "utf8")).runs;

  it("runs the static check, then only the slice's Check file through testFile, never the hook", () => {
    const r = sliceCheck(withKey, 3);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("static check\ntest file: a.test.mjs\n");
    expect(r.stdout).not.toContain("sample check:");
  });

  it("fails with the runner's code, naming the file and the unit step", () => {
    expect(sliceCheck(withKey, 3, { TEST_FILE_EXIT: "4" }).status).toBe(4);
    expect(ownRuns().at(-1)).toMatchObject({ exit: 4, failedStep: "unit", failedFiles: ["a.test.mjs"] });
  });

  it("runs the check hook as now for a slice with no Check field, or a config with no testFile", () => {
    for (const r of [sliceCheck(withKey, 4), sliceCheck(withoutKey, 3)]) {
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("sample check: slice HEAD\n");
      expect(r.stdout).not.toContain("test file:");
    }
  });
});

describe("check lease slots", () => {
  const holders = (extra = {}) => {
    const env = { ...process.env, RISA_LEASE_ROOT: join(root, "leases"), ...extra };
    delete env.RISA_CHECK_SLOTS;
    Object.assign(env, extra);
    return spawnSync("bash", [join(HERE, "lease.sh"), "holders", "check"], { env, encoding: "utf8" }).stdout;
  };
  it("defaults to two, and RISA_CHECK_SLOTS changes it", () => {
    expect(holders()).toMatch(/^check leases: 0 of 2 held$/m);
    expect(holders({ RISA_CHECK_SLOTS: "5" })).toMatch(/^check leases: 0 of 5 held$/m);
  });
});
