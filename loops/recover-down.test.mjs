// `pnpm prd down` then `pnpm prd recover` (down.sh, recover.sh): the down record,
// what each stops and starts and in what order, the stack engine, --at and --wait;
// then the same with the dispatcher running (stopped, reopened in a background tab,
// waited for). The throwaway repo and fakes are recover-fixture.mjs's.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RECOVER,
  recover,
  okRecover,
  calls,
  put,
  drop,
  endDispatchers,
  main,
  loops,
  env,
  state,
  useRecoverRepo,
} from "./recover-fixture.mjs";

describe("down and recover", () => {
  useRecoverRepo();
  const record = () => join(loops, ".down.json");
  // Everything recovery or down does to the machine, in order (not the read-only probes).
  // `marked` keeps the " (record)" mark: the record existed when the call was made.
  const effects = (marked = false) =>
    calls()
      .split("\n")
      .filter((l) => /^(stack (start|stop) |test-db (up|down)( |$)|(serve|open|osascript|claude) )/.test(l))
      .map((l) => (marked ? l : l.replace(/ \(record\)$/, "")));
  const down = (extra = {}) => {
    const r = spawnSync("bash", [join(main, "loops/prd.sh"), "down"], {
      cwd: main,
      encoding: "utf8",
      env: { ...env, ...extra },
    });
    if (r.status !== 0) throw new Error(`down failed:\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
  };
  const allDown = () => {
    put("running", "");
    put("listen", "");
    drop("testdb-up", "engine-down");
  };

  it("down writes the record first, then stops servers, stacks and the test Postgres", () => {
    // Up: t (prd), t-1 (merged) and t-2 (active) stacks, t's and t-2's servers, the test Postgres.
    put("running", "sample-loop1\nsample-loop2\nsample-loop3\n");
    put("testdb-up", "");
    put("listen", "6173\n6273\n");
    const out = down();
    expect(JSON.parse(readFileSync(record(), "utf8"))).toEqual({
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      stacks: ["t", "t-1", "t-2"],
      servers: ["t", "t-2"],
      testDb: true,
      dispatcher: false,
    });
    expect(effects(true)).toEqual([
      "serve t --stop (record)",
      "serve t-2 --stop (record)",
      "stack stop t (record)",
      "stack stop t-1 (record)",
      "stack stop t-2 (record)",
      "test-db down (record)",
    ]);
    expect(readFileSync(join(state, "running"), "utf8")).toBe("");
    expect(existsSync(join(state, "testdb-up"))).toBe(false);
    expect(readFileSync(join(state, "listen"), "utf8")).toBe("");
    expect(out).toMatch(/stopped stack t-2 \(sample-loop2, data kept\)/);
    expect(out).toMatch(/stopped dev server t\n/);
    expect(out).toMatch(/stopped the shared test Postgres/);
  });

  it("a second down stops nothing and keeps the record", () => {
    const before = JSON.parse(readFileSync(record(), "utf8"));
    expect(down()).toMatch(/nothing was running/);
    expect(effects()).toEqual([]);
    expect(JSON.parse(readFileSync(record(), "utf8"))).toMatchObject({
      stacks: before.stacks,
      servers: before.servers,
      testDb: true,
    });
  });

  it("recover issues exactly the recorded starts in order, clears only stale locks, and deletes the record", () => {
    const out = okRecover([]);
    expect(effects()).toEqual([
      "test-db up",
      "stack start t",
      "stack start t-1",
      "stack start t-2",
      "serve t",
      "serve t-2",
      `claude --remote-control ${RECOVER} (agent)`,
    ]);
    expect(out).toMatch(/• stack t-2\n {2}up and migrated \(sample-loop2\)/);
    expect(existsSync(record())).toBe(false);
    expect(existsSync(join(loops, ".slots/9"))).toBe(false);
    expect(existsSync(join(loops, ".slots/1"))).toBe(true);
    expect(out).toMatch(/Merged slices to clean up[^\n]*\n {2}t-1\n {2}t-4\n/);
    expect(out).toMatch(/Sessions to carry on or reopen[^\n]*\n {2}prd-t {2}in \S+\/t\n {2}plan-u {2}in /);
    expect(out).toMatch(/Recovered\.$/m);
    // Last, the recovery agent in this terminal, in the main checkout, with its prompt.
    expect(out).toMatch(/Opening the recovery agent/);
    const [cwd, ...args] = readFileSync(join(state, "agent-args"), "utf8").split("\n");
    expect(cwd).toBe(main);
    expect(args.slice(0, 4)).toEqual(["--remote-control", RECOVER, "--name", RECOVER]);
    expect(args[4]).toMatch(/^You are the recovery agent\./);
    expect(args.join("\n")).toMatch(/ListAgents/);
    // Through the wrapper: recorded as a recovery session.
    const rec = JSON.parse(readFileSync(join(loops, ".sessions/recover.json"), "utf8"));
    expect(rec).toMatchObject({ kind: "recovery", exit: 0 });
  });

  it("a second recover does nothing (with --no-agent, launches nothing)", () => {
    rmSync(join(state, "agent-args"));
    const out = okRecover(["--no-agent"]);
    expect(effects()).toEqual([]);
    expect(out).not.toMatch(/^• /m);
    expect(calls()).not.toMatch(/^(stack (start|up)|test-db up)( |$)/m);
    expect(out).toMatch(/Sessions to carry on or reopen/);
    expect(out).toMatch(/--no-agent: to message and reopen them/);
    expect(existsSync(join(state, "agent-args"))).toBe(false);
  });

  it("doesn't open the agent when something didn't recover", () => {
    allDown();
    rmSync(join(state, "agent-args"), { force: true });
    const r = recover([], { SAMPLE_STACK_FAIL: "start:t" }); // t's stack doesn't start
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Didn't recover:\n {2}stack t/);
    expect(r.stdout).toMatch(/Not opening the recovery agent/);
    expect(r.stdout).not.toMatch(/Recovered\./);
    expect(effects()).not.toContain(`claude --remote-control ${RECOVER} (agent)`);
    expect(existsSync(join(state, "agent-args"))).toBe(false);
  });

  it("without a record, brings back only the prd and active stacks and the prd server", () => {
    allDown();
    okRecover(["--no-agent"]);
    expect(effects()).toEqual(["test-db up", "stack start t", "stack start t-2", "serve t"]);
  });

  it("starts the stack engine (the stackEngine hook) when it isn't running, before anything else", () => {
    allDown();
    put("engine-down", "");
    const out = okRecover([]);
    expect(out).toMatch(/Sample engine isn't running: starting it/);
    const lines = calls().split("\n");
    const started = lines.indexOf("stack engine start");
    expect(started).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf("test-db up")).toBeGreaterThan(started);
    expect(effects()).toContain("stack start t-2");
  });

  it("gives up when the stack engine doesn't start", () => {
    allDown();
    put("engine-down", "");
    const r = recover([], { SAMPLE_STACK_FAIL: "engine:start" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/recover: Sample engine didn't start/);
    expect(effects().filter((l) => /^(stack start|test-db up)/.test(l))).toEqual([]);
    drop("engine-down");
  });

  it("--at sleeps until that time, then recovers", () => {
    allDown();
    const clock = join(state, "clock");
    put("clock", String(Date.UTC(2026, 10, 19, 12, 0, 0) / 1000)); // 12:00 UTC
    const out = okRecover(["--at", "15:00"], { RISA_CLOCK_FILE: clock });
    expect(out).toMatch(/Waiting until 15:00 \(in 3h00m\)/);
    const lines = calls().split("\n");
    const slept = lines.filter((l) => l.startsWith("sleep ")).map((l) => Number(l.split(" ")[1]));
    expect(slept.reduce((a, b) => a + b, 0)).toBe(3 * 3600);
    expect(Math.max(...slept)).toBeLessThanOrEqual(300);
    const lastSleep = lines.findLastIndex((l) => l.startsWith("sleep "));
    expect(lines.indexOf("test-db up")).toBeGreaterThan(lastSleep);
  });

  // A wait of most of a day in 300 s steps is 258 fake sleeps, each a process or
  // two: about 3 s idle and past the 20 s test timeout under load (B-418). The
  // step test above keeps 300 s; these take 6 h steps, so they stay a handful.
  const slept = () =>
    calls()
      .split("\n")
      .filter((l) => l.startsWith("sleep "))
      .map((l) => Number(l.split(" ")[1]));
  const STEP = { RISA_RECOVER_STEP_SECS: String(6 * 3600) };

  it("--at a time that has passed waits until tomorrow", () => {
    const clock = join(state, "clock");
    put("clock", String(Date.UTC(2026, 10, 19, 12, 0, 0) / 1000));
    const out = okRecover(["--at=09:30"], { ...STEP, RISA_CLOCK_FILE: clock });
    expect(out).toMatch(/Waiting until 09:30 \(in 21h30m\)/);
    expect(Number(readFileSync(clock, "utf8"))).toBe(Date.UTC(2026, 10, 20, 9, 30, 0) / 1000);
    expect(slept()).toEqual([21600, 21600, 21600, 12600]);
  });

  it("--at reads the time in the local time zone, not UTC", () => {
    const clock = join(state, "clock");
    put("clock", String(Date.UTC(2026, 10, 19, 12, 0, 0) / 1000)); // 04:00 in Los Angeles (PST)
    const out = okRecover(["--at", "03:30"], {
      ...STEP,
      TZ: "America/Los_Angeles",
      RISA_CLOCK_FILE: clock,
    });
    expect(out).toMatch(/Waiting until 03:30 \(in 23h30m\)/);
    expect(Number(readFileSync(clock, "utf8"))).toBe(Date.UTC(2026, 10, 20, 11, 30, 0) / 1000);
    expect(slept().reduce((a, b) => a + b, 0)).toBe(23.5 * 3600);
  });

  it("refuses a step that isn't a whole number of seconds", () => {
    put("clock", String(Date.UTC(2026, 10, 19, 12, 0, 0) / 1000));
    const r = recover(["--at", "13:00"], {
      RISA_RECOVER_STEP_SECS: "0",
      RISA_CLOCK_FILE: join(state, "clock"),
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/RISA_RECOVER_STEP_SECS must be a whole number/);
    expect(calls()).not.toMatch(/^sleep /m);
  });

  it("--wait probes claude every 10 minutes until one answers, then recovers", () => {
    allDown();
    put("claude-fails", "2");
    const out = okRecover(["--wait"]);
    expect(out).toMatch(/a claude -p probe every 10m00s/);
    expect(out).toMatch(/probe 3: Claude answered/);
    const lines = calls()
      .split("\n")
      .filter((l) => /^(claude |sleep |test-db up$)/.test(l));
    expect(lines.slice(0, 6)).toEqual([
      "claude -p ok",
      "sleep 600",
      "claude -p ok",
      "sleep 600",
      "claude -p ok",
      "test-db up",
    ]);
  });
});

describe("down and recover with the dispatcher", () => {
  useRecoverRepo();
  const record = () => join(loops, ".down.json");
  const lock = () => join(loops, ".dispatch.lock");
  const effects = () =>
    calls()
      .split("\n")
      .filter((l) => /^(stack (start|stop) |test-db (up|down)( |$)|(serve|open|osascript|claude) )/.test(l))
      .map((l) => l.replace(/ \(record\)$/, ""));
  const tabs = () => effects().filter((l) => l.startsWith("osascript"));
  /**
   * A stand-in dispatcher: a process that only sleeps, its pid in the lock. Started
   * through a shell that exits at once, so it isn't this test's child (a child that
   * died would linger as a zombie, still answering kill 0, while spawnSync blocks).
   */
  const fakeDispatcher = () => {
    const pid = Number(
      execFileSync(
        "bash",
        ["-c", `"${process.execPath}" -e "setInterval(() => {}, 1000)" </dev/null >/dev/null 2>&1 & echo $!`],
        { encoding: "utf8" },
      ).trim(),
    );
    writeFileSync(lock(), `${pid}\n`);
    return pid;
  };
  const gone = (/** @type {number} */ pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };

  it("down records that the dispatcher ran, and stops it", () => {
    const pid = fakeDispatcher();
    const r = spawnSync("bash", [join(main, "loops/prd.sh"), "down"], {
      cwd: main,
      encoding: "utf8",
      env,
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`stopped the dispatcher (pid ${pid})`);
    expect(r.stdout).not.toMatch(/nothing was running/);
    expect(JSON.parse(readFileSync(record(), "utf8")).dispatcher).toBe(true);
    expect(gone(pid)).toBe(true);
  });

  it("recover clears the stale lock, reopens it in a background tab, waits for its lock, then opens the agent", () => {
    const out = okRecover([]);
    expect(out).toMatch(/• cleared stale lock \.loops\/\.dispatch\.lock/);
    expect(out).toMatch(
      /• the dispatcher \(it was running\)\n {2}Opened dispatch in a new background iTerm2 tab[^\n]*\n {2}running \(pid \d+\)/,
    );
    expect(tabs()).toEqual(["osascript dispatch"]);
    const e = effects();
    expect(e.indexOf("osascript dispatch")).toBeGreaterThan(e.indexOf("test-db up"));
    // The agent opened only once the new dispatcher held its lock.
    expect(e.at(-1)).toBe(`claude --remote-control ${RECOVER} (agent) [dispatcher locked]`);
    expect(readFileSync(join(state, "tab-line"), "utf8").trim()).toBe(
      `cd ${main} && exec ${join(main, "loops/prd.sh")} dispatch`,
    );
    const started = readFileSync(join(state, "dispatchers"), "utf8").trim().split("\n").at(-1);
    expect(readFileSync(lock(), "utf8").trim()).toBe(started);
    expect(existsSync(record())).toBe(false);
    expect(existsSync(join(loops, ".dispatch-intent.json"))).toBe(false);
    expect(existsSync(join(loops, ".recover.lock"))).toBe(false);
  });

  it("a second recover doesn't reopen it (it runs now)", () => {
    okRecover(["--no-agent"]);
    expect(tabs()).toEqual([]);
    endDispatchers();
    rmSync(lock(), { force: true });
  });

  it("recover leaves a running dispatcher alone", () => {
    const pid = fakeDispatcher();
    try {
      expect(okRecover(["--no-agent"])).not.toMatch(/dispatcher/);
      expect(tabs()).toEqual([]);
      expect(readFileSync(lock(), "utf8").trim()).toBe(String(pid));
    } finally {
      process.kill(pid);
      rmSync(lock(), { force: true });
    }
  });
});
