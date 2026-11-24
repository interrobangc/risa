// The watchdog (watchdog.mjs): the pure decision and state, and the command
// against a throwaway main checkout with a stub recover and docker. Nothing here
// reads the real .loops, sessions, usage readings or launchd.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { backoffMs, decide, limitedOf, nextState } from "./watchdog.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const MIN = 60_000;
const NOW = Date.parse("2026-11-24T12:00:00Z");
const iso = (t) => new Date(t).toISOString();
const DEAD_PID = 99_999_999;

/** A healthy machine: booted yesterday, the dispatcher live, a live session, a watchdog running for a day. */
const facts = (over = {}) => ({
  now: NOW,
  bootAt: NOW - 24 * 60 * MIN,
  stayDown: null,
  downRecord: null,
  dispatcher: { lock: "live", pid: 4242, paused: null },
  intent: false,
  recover: { running: false, pid: null },
  sessions: [{ name: "prd-alpha", kind: "prd", managed: true, started: iso(NOW - 60 * MIN), live: true }],
  usage: { limited: false, why: "under the limits" },
  state: { since: NOW - 24 * 60 * MIN },
  ...over,
});
/** After a reboot five minutes ago: every session dead, the dispatcher's lock left behind. */
const rebooted = (over = {}) =>
  facts({
    bootAt: NOW - 5 * MIN,
    dispatcher: { lock: "stale", pid: DEAD_PID, paused: null },
    sessions: [
      { name: "prd-alpha", kind: "prd", managed: true, started: iso(NOW - 60 * MIN), live: false },
      { name: "plan-beta", kind: "plan", managed: false, started: iso(NOW - 50 * MIN), live: false },
    ],
    ...over,
  });

describe("decide", () => {
  it("recovers after a reboot that follows a down record", () => {
    const d = decide(
      facts({
        bootAt: NOW - 5 * MIN,
        downRecord: { at: iso(NOW - 30 * MIN) },
        dispatcher: { lock: "none", pid: null, paused: null },
        sessions: [],
      }),
    );
    expect(d).toMatchObject({ action: "recover", report: true });
    expect(d.reason).toMatch(/a reboot since pnpm prd down/);
  });

  it("leaves a down record alone until a reboot, whatever else is dead", () => {
    const d = decide(rebooted({ bootAt: NOW - 60 * MIN, downRecord: { at: iso(NOW - 30 * MIN) } }));
    expect(d.action).toBe("nothing");
    expect(d.reason).toMatch(/pnpm prd down at 2026-11-24 11:30Z and no reboot since: left down/);
  });

  it("recovers a crash: the dispatcher's lock with its pid gone, and a hand-opened session gone", () => {
    const d = decide(rebooted());
    expect(d.action).toBe("recover");
    expect(d.reason).toBe(`the dispatcher's pid ${DEAD_PID} is gone; crashed: plan-beta`);
  });

  it("recovers a hand-opened orchestrator that crashed with no reboot", () => {
    const d = decide(
      facts({
        sessions: [
          { name: "prd-gamma", kind: "prd", managed: false, started: iso(NOW - 20 * MIN), live: false },
        ],
      }),
    );
    expect(d).toMatchObject({ action: "recover", reason: "crashed: prd-gamma" });
  });

  it("recovers on a kept dispatcher intent with no dispatcher", () => {
    const d = decide(facts({ intent: true, dispatcher: { lock: "none", pid: null, paused: null } }));
    expect(d).toMatchObject({ action: "recover", reason: "the dispatcher's kept intent to reopen" });
  });

  it("leaves a clean dispatch --stop alone, its managed sessions too", () => {
    const d = decide(
      facts({
        dispatcher: { lock: "none", pid: null, paused: null },
        sessions: [
          { name: "prd-alpha", kind: "prd", managed: true, started: iso(NOW - 60 * MIN), live: false },
        ],
      }),
    );
    expect(d).toMatchObject({ action: "nothing", healthy: true });
    expect(d.reason).toBe("all healthy (the dispatcher isn't running)");
  });

  it("ignores ended sessions, other kinds, and records the last recover already saw", () => {
    const d = decide(
      facts({
        state: { since: NOW - 24 * 60 * MIN, lastSuccess: NOW - 30 * MIN },
        sessions: [
          {
            name: "prd-a",
            kind: "prd",
            started: iso(NOW - 90 * MIN),
            ended: iso(NOW - 10 * MIN),
            live: false,
          },
          { name: "backlog", kind: "backlog", started: iso(NOW - 20 * MIN), live: false },
          { name: "hotfix-b", kind: "hotfix", started: iso(NOW - 20 * MIN), live: false },
          { name: "recover", kind: "recovery", started: iso(NOW - 20 * MIN), live: false },
          { name: "plan-old", kind: "plan", started: iso(NOW - 40 * MIN), live: false },
        ],
      }),
    );
    expect(d).toMatchObject({ action: "nothing", healthy: true, reason: "all healthy" });
  });

  it("on its first run, takes older dead records as history", () => {
    const d = decide(
      facts({
        state: {},
        sessions: [{ name: "plan-old", kind: "plan", started: iso(NOW - 40 * MIN), live: false }],
      }),
    );
    expect(d).toMatchObject({ action: "nothing", healthy: true });
  });

  it("does nothing while paused, even after a reboot", () => {
    const d = decide(
      rebooted({ dispatcher: { lock: "stale", pid: DEAD_PID, paused: { why: "profiling" } } }),
    );
    expect(d).toMatchObject({ action: "nothing", reason: "the dispatcher is paused (profiling)" });
  });

  it("does nothing while stay-down, even after a reboot that follows its down record", () => {
    const d = decide(
      rebooted({
        downRecord: { at: iso(NOW - 30 * MIN) },
        stayDown: { at: iso(NOW - 30 * MIN), why: "night off" },
      }),
    );
    expect(d.action).toBe("nothing");
    expect(d.reason).toMatch(/^stay-down: pnpm prd down --stay \(night off\); pnpm prd recover by hand/);
  });

  it("does nothing while a recover runs", () => {
    expect(decide(rebooted({ recover: { running: true, pid: 777 } }))).toMatchObject({
      action: "nothing",
      reason: "a recover is running (pid 777)",
    });
  });

  it("does nothing while the reading says limited", () => {
    const d = decide(rebooted({ usage: { limited: true, why: "the 5-hour limit is at 99%" } }));
    expect(d).toMatchObject({ action: "nothing", reason: "limited: the 5-hour limit is at 99%" });
  });

  it("does nothing when all is healthy", () => {
    expect(decide(facts())).toMatchObject({ action: "nothing", healthy: true, reason: "all healthy" });
  });

  it("backs off after failures, up to 30 minutes, and reports only the first of an incident", () => {
    expect([1, 2, 3, 4, 9].map((n) => backoffMs(n) / MIN)).toEqual([10, 20, 30, 30, 30]);
    const failed = (failures, agoMin) => ({
      since: NOW - 24 * 60 * MIN,
      failures,
      lastAttempt: NOW - agoMin * MIN,
      incident: { since: NOW - 60 * MIN, reported: true },
    });
    const early = decide(rebooted({ state: failed(1, 5) }));
    expect(early.action).toBe("nothing");
    expect(early.reason).toMatch(
      /^backing off after 1 failed recover, until 2026-11-24 12:05Z \(the dispatcher's/,
    );
    expect(decide(rebooted({ state: failed(1, 10) }))).toMatchObject({ action: "recover", report: false });
    expect(decide(rebooted({ state: failed(5, 29) })).reason).toMatch(
      /after 5 failed recovers, until 2026-11-24 12:01Z/,
    );
    expect(decide(rebooted({ state: failed(5, 30) }))).toMatchObject({ action: "recover", report: false });
  });
});

describe("nextState", () => {
  const rec = { action: "recover", reason: "x", report: true };
  it("counts failures into one reported incident, and a success or a healthy tick ends it", () => {
    let s = nextState({}, rec, 1, NOW);
    expect(s).toEqual({
      since: NOW,
      lastAttempt: NOW,
      failures: 1,
      incident: { since: NOW, reported: true },
    });
    s = nextState(s, { ...rec, report: false }, 1, NOW + 10 * MIN);
    expect(s).toMatchObject({
      failures: 2,
      lastAttempt: NOW + 10 * MIN,
      incident: { since: NOW, reported: true },
    });
    expect(nextState(s, rec, 0, NOW + 30 * MIN)).toMatchObject({
      failures: 0,
      incident: null,
      lastSuccess: NOW + 30 * MIN,
    });
    expect(
      nextState(s, { action: "nothing", reason: "all healthy", healthy: true }, null, NOW),
    ).toMatchObject({
      failures: 0,
      incident: null,
    });
    expect(nextState(s, { action: "nothing", reason: "paused" }, null, NOW)).toMatchObject({ failures: 2 });
  });
  it("takes recover's 75 (another one runs) as neither", () => {
    const s = { since: 1, failures: 1, lastAttempt: 5, incident: { since: 5, reported: true } };
    expect(nextState(s, rec, 75, NOW)).toEqual(s);
  });
});

describe("limitedOf", () => {
  const u = (over) => ({
    known: true,
    fiveHour: null,
    sevenDay: null,
    overage: false,
    stalled: [],
    resetsAt: null,
    ...over,
  });
  it("is limited at the stop line, on overage, or with a session stalled", () => {
    expect(limitedOf(u({ fiveHour: { percent: 98.2, resetsAt: NOW + 60 * MIN } }), 98)).toEqual({
      limited: true,
      why: "the 5-hour limit is at 98% until 2026-11-24 13:00Z",
    });
    expect(limitedOf(u({ sevenDay: { percent: 99, resetsAt: null } }), 98).why).toBe(
      "the weekly limit is at 99%",
    );
    expect(limitedOf(u({ overage: true }), 98).limited).toBe(true);
    expect(limitedOf(u({ stalled: [{ session: "prd-a" }], resetsAt: NOW + MIN }), 98).why).toMatch(
      /^prd-a stopped on a rate limit until/,
    );
  });
  it("isn't limited below it, or with no reading", () => {
    expect(limitedOf(u({ fiveHour: { percent: 90, resetsAt: null } }), 98).limited).toBe(false);
    expect(limitedOf(u({ known: false }), 98)).toEqual({ limited: false, why: "no current reading" });
  });
});

describe("pnpm prd watchdog (stub recover)", () => {
  let root, main, loops, env, recoverLog;
  const run = (args = [], extra = {}) =>
    spawnSync(process.execPath, [join(HERE, "watchdog.mjs"), "--main", main, ...args], {
      encoding: "utf8",
      env: { ...env, ...extra },
    });
  const state = () => JSON.parse(readFileSync(join(loops, ".watchdog.json"), "utf8"));
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "watchdog-test-"));
    main = join(root, "main");
    loops = join(main, ".loops");
    mkdirSync(join(loops, ".sessions"), { recursive: true });
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 1\n");
    recoverLog = join(root, "recover.log");
    // Logs its args and whether it may report; exits with $root/recover-exit (0).
    writeFileSync(
      join(bin, "recover"),
      `#!/bin/sh\necho "$* report=\${CARETOOK_RECOVER_REPORT:-on}" >> "${recoverLog}"\nexit $(cat "${root}/recover-exit" 2>/dev/null || echo 0)\n`,
    );
    for (const f of ["docker", "recover"]) chmodSync(join(bin, f), 0o755);
    writeFileSync(join(root, "clock"), String(NOW / 1000));
    env = {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      CARETOOK_RECOVER_BIN: join(bin, "recover"),
      CARETOOK_CLOCK_FILE: join(root, "clock"),
      CARETOOK_BOOT_TIME: String(NOW / 1000 - 300),
      CARETOOK_FREE_GB: "50",
      CARETOOK_SESSIONS_DIR: join(loops, ".sessions"),
      CARETOOK_USAGE_DIR: join(loops, ".usage"),
      CARETOOK_LEASE_ROOT: join(loops, ".lease"),
      CARETOOK_LANDING_DIR: join(loops, ".landing"),
    };
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => rmSync(recoverLog, { force: true }));
  const clock = (min) => writeFileSync(join(root, "clock"), String(NOW / 1000 + min * 60));
  const recovers = () =>
    existsSync(recoverLog) ? readFileSync(recoverLog, "utf8").split("\n").filter(Boolean) : [];

  it("a healthy first run records its start and runs nothing", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/nothing: all healthy \(the dispatcher isn't running\)/);
    expect(recovers()).toEqual([]);
    expect(state()).toMatchObject({
      since: NOW,
      lastLine: "nothing: all healthy (the dispatcher isn't running)",
    });
    expect(run().stdout).toBe(""); // the same decision prints nothing
  });

  it("a stale dispatcher lock runs recover --unattended; failures report once and back off", () => {
    writeFileSync(join(loops, ".dispatch.lock"), `${DEAD_PID}\n`);
    expect(JSON.parse(run(["--dry-run", "--json"]).stdout)).toMatchObject({
      action: "recover",
      report: true,
    });
    expect(recovers()).toEqual([]); // a dry run runs nothing

    writeFileSync(join(root, "recover-exit"), "1");
    let r = run();
    expect(r.stdout).toMatch(/recover failed \(exit 1\); reported/);
    expect(recovers()).toEqual(["--unattended report=on"]);
    expect(state()).toMatchObject({ failures: 1, lastAttempt: NOW, incident: { reported: true } });

    clock(5);
    expect(run().stdout).toMatch(/nothing: backing off after 1 failed recover/);
    expect(recovers()).toHaveLength(1);

    clock(10);
    r = run();
    expect(r.stdout).toMatch(/already reported this incident/);
    expect(recovers().at(-1)).toBe("--unattended report=off");

    writeFileSync(join(root, "recover-exit"), "75");
    clock(31);
    expect(run().stdout).toMatch(/recover was already running/);
    expect(state()).toMatchObject({ failures: 2 });

    writeFileSync(join(root, "recover-exit"), "0");
    clock(61);
    expect(run().stdout).toMatch(/recover succeeded/);
    expect(state()).toMatchObject({ failures: 0, incident: null, lastSuccess: NOW + 61 * MIN });
    rmSync(join(loops, ".dispatch.lock"));
  });

  it("stay-down wins over the stale lock", () => {
    writeFileSync(join(loops, ".dispatch.lock"), `${DEAD_PID}\n`);
    writeFileSync(join(loops, ".stay-down.json"), JSON.stringify({ at: iso(NOW), why: "profiling" }));
    expect(run().stdout).toMatch(/nothing: stay-down: pnpm prd down --stay \(profiling\)/);
    expect(recovers()).toEqual([]);
    rmSync(join(loops, ".stay-down.json"));
    rmSync(join(loops, ".dispatch.lock"));
  });

  it("never fails: a main it can't write to exits 0 with one line", () => {
    writeFileSync(join(root, "a-file"), "");
    const r = spawnSync(process.execPath, [join(HERE, "watchdog.mjs"), "--main", join(root, "a-file")], {
      encoding: "utf8",
      env,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/^watchdog: /);
  });
});
