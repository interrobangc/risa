// The watch (watch.mjs): the pure decision on fictional facts, the marks file in a
// temporary folder, and the command on a throwaway .loops (no real worktree,
// session, ask or log).
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitInit, withOldGit } from "./git-init.mjs";
import {
  decide,
  nextState,
  parseUntil,
  planStates,
  readMarks,
  readingClock,
  settingsFrom,
  watchFacts,
  writeMark,
} from "./watch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-11-24T12:00:00Z");
const M = 60_000;
const at = (min) => new Date(NOW - min * M).toISOString();
const settings = settingsFrom({});

/** A slice worker's watch facts: active a minute ago, progress five minutes ago. */
const worker = (n, extra = {}) => ({
  n: String(n),
  name: `topic-${n}`,
  status: "started",
  unknown: false,
  stopped: false,
  firstAt: at(60),
  startedAt: at(60),
  lastActivityAt: at(1),
  lastProgressAt: at(5),
  running: [],
  leases: [],
  dirty: false,
  risky: null,
  openAsk: null,
  ...extra,
});
const run = (workers, extra = {}) =>
  decide({ now: NOW, workers, orchestrator: null, marks: {}, usual: null, settings, ...extra });
const one = (w, extra = {}) => run([w], extra).workers[0];
const quiet = (n = 4, extra = {}) => worker(n, { lastActivityAt: at(25), ...extra });

describe("decide", () => {
  it("an active agent is ok and left alone", () => {
    expect(one(worker(4))).toMatchObject({ state: "ok", action: "none" });
  });

  it("never acts on a stopped, unknown, handed-off, running or lease-waiting worker", () => {
    expect(one(quiet(4, { stopped: true }))).toMatchObject({ state: "stopped", action: "none" });
    expect(one(quiet(4, { unknown: true }))).toMatchObject({ state: "unknown", action: "none" });
    expect(one(quiet(4, { status: "handed off" }))).toMatchObject({ state: "quiet", action: "none" });
    expect(one(quiet(4, { status: "merged (opus)" })).action).toBe("none");
    const busy = one(quiet(4, { running: ["pnpm prd check --quick"] }));
    expect(busy).toMatchObject({ state: "ok", action: "none" });
    expect(busy.reason).toMatch(/running pnpm prd check/);
    expect(one(quiet(4, { leases: ["check (queued)"] }))).toMatchObject({ state: "ok", action: "none" });
  });

  it("one quiet agent gets a nudge, then a restart once the nudge goes unanswered", () => {
    expect(one(quiet())).toMatchObject({ state: "quiet", action: "nudge" });
    const nudged = { 4: [{ mark: "nudged", at: at(5) }] };
    expect(one(quiet(), { marks: nudged })).toMatchObject({ action: "none" });
    const long = { 4: [{ mark: "nudged", at: at(12) }] };
    expect(one(quiet(), { marks: long })).toMatchObject({ state: "quiet", action: "restart" });
  });

  it("a replied nudge is never restarted", () => {
    const marks = {
      4: [
        { mark: "nudged", at: at(15) },
        { mark: "replied", at: at(14) },
      ],
    };
    expect(one(quiet(), { marks })).toMatchObject({ action: "none" });
    expect(one(quiet(), { marks }).reason).toMatch(/replied/);
  });

  it("a dirty tree, a risky step or a second stall goes to the skeptic, not a restart", () => {
    const marks = { 4: [{ mark: "nudged", at: at(12) }] };
    expect(one(quiet(4, { dirty: true }), { marks })).toMatchObject({ action: "skeptic" });
    expect(one(quiet(4, { risky: "a changed migration (x)" }), { marks }).action).toBe("skeptic");
    const second = {
      4: [
        { mark: "nudged", at: at(90) },
        { mark: "nudged", at: at(12) },
      ],
    };
    const s = one(quiet(), { marks: second });
    expect(s).toMatchObject({ action: "skeptic" });
    expect(s.reason).toMatch(/second stall/);
  });

  it("an agent making calls without progress goes to the skeptic", () => {
    const w = worker(4, { lastProgressAt: at(50), firstAt: at(120) });
    expect(one(w)).toMatchObject({ state: "no-progress", action: "skeptic" });
    // A restarted agent's own first call starts its clock.
    expect(one({ ...w, firstAt: at(10) })).toMatchObject({ state: "ok" });
  });

  it("slow gets one nudge, only with three usual samples", () => {
    const usual = { samples: 3, slowestSeconds: 30 * 60 };
    expect(one(worker(4), { usual })).toMatchObject({ state: "slow", action: "nudge" });
    expect(one(worker(4), { usual: { ...usual, samples: 2 } })).toMatchObject({ state: "ok" });
    const marks = { 4: [{ mark: "nudged", at: at(20) }] };
    expect(one(worker(4), { usual, marks })).toMatchObject({ state: "slow", action: "none" });
  });

  it("an open ask means no action; an answered one goes to the skeptic", () => {
    expect(one(quiet(4, { openAsk: "a9" }))).toMatchObject({ action: "none" });
    const marks = {
      4: [
        { mark: "nudged", at: at(20) },
        { mark: "asked", at: at(15), ask: "a9" },
      ],
    };
    expect(one(quiet(), { marks, askOpen: () => true }).action).toBe("none");
    expect(one(quiet(), { marks, askOpen: () => false }).action).toBe("skeptic");
  });

  it("a left slice waits for its recheck time, then goes to the skeptic", () => {
    const left = (until) => ({
      4: [
        { mark: "nudged", at: at(20) },
        { mark: "left", at: at(15), until },
      ],
    });
    expect(one(quiet(), { marks: left(at(-30)) })).toMatchObject({ action: "none" });
    expect(one(quiet(), { marks: left(at(1)) })).toMatchObject({ action: "skeptic" });
  });

  it("a restart under way waits; no call since it for the restart limit goes to the skeptic", () => {
    const marks = (min) => ({
      4: [
        { mark: "nudged", at: at(24) },
        { mark: "restarted", at: at(min) },
      ],
    });
    expect(one(quiet(), { marks: marks(5) }).action).toBe("none");
    expect(one(quiet(), { marks: marks(11) }).action).toBe("skeptic");
  });

  it("an unconfirmed stop goes to the skeptic; a confirmed one says to spawn", () => {
    const marks = {
      4: [
        { mark: "nudged", at: at(40) },
        { mark: "restarted", at: at(15) },
      ],
    };
    // Still quiet, no stop recorded, no new agent's call since the mark.
    const unconfirmed = one(quiet(4, { lastActivityAt: at(50) }), { marks });
    expect(unconfirmed).toMatchObject({ state: "quiet", action: "skeptic" });
    expect(unconfirmed.reason).toMatch(/stop isn't confirmed .*spawn nothing/);
    const confirmed = one(quiet(4, { lastActivityAt: at(50), stopped: true }), { marks });
    expect(confirmed).toMatchObject({ state: "stopped", action: "none" });
    expect(confirmed.reason).toMatch(/stop confirmed: spawn its --continue agent/);
    expect(one(quiet(4, { stopped: true })).reason).not.toMatch(/spawn/);
  });

  it("a second restart becomes skeptic", () => {
    // Restarted once; the new agent worked, then went quiet again and wasn't answering a nudge.
    const marks = {
      4: [
        { mark: "nudged", at: at(90) },
        { mark: "restarted", at: at(80) },
        { mark: "nudged", at: at(12) },
      ],
    };
    const s = one(quiet(4, { firstAt: at(78) }), { marks });
    expect(s).toMatchObject({ state: "quiet", action: "skeptic" });
    expect(s.reason).toMatch(/second stall/);
  });

  it("two quiet agents at once are one finding, and neither is acted on", () => {
    const marks = { 4: [{ mark: "nudged", at: at(12) }] };
    const d = run([quiet(4), quiet(5, { lastActivityAt: at(30) }), worker(6)], { marks });
    expect(d.workers.map((w) => w.action)).toEqual(["none", "none", "none"]);
    expect(d.finding).toMatchObject({ slices: ["4", "5"], orchestrator: false, raised: false });
    expect(run([quiet(4), quiet(5)], { raised: [d.finding.key] }).finding).toBeTruthy();
    // Quiet far apart is two stalls, not one outage.
    expect(run([quiet(4), quiet(5, { lastActivityAt: at(80) })]).finding).toBeNull();
  });

  it("a quiet agent and its quiet orchestrator are one finding; a stopped orchestrator isn't quiet", () => {
    const orch = { lastActivityAt: at(26), stopped: false, running: false };
    const d = run([quiet()], { orchestrator: orch });
    expect(d.finding).toMatchObject({ slices: ["4"], orchestrator: true });
    expect(d.workers[0].action).toBe("none");
    expect(run([quiet()], { orchestrator: { ...orch, stopped: true } }).workers[0].action).toBe("nudge");
  });

  it("a sleep gap resets the clocks", () => {
    expect(one(quiet(), { clockFrom: NOW - 2 * M })).toMatchObject({ state: "ok", action: "none" });
    const clock = readingClock({ lastReadingAt: at(120) }, NOW, settings.sleepGapSec);
    expect(clock).toEqual({ clockFrom: NOW, gapSeconds: 7200 });
    expect(readingClock({ lastReadingAt: at(1) }, NOW, settings.sleepGapSec)).toEqual({
      clockFrom: null,
      gapSeconds: null,
    });
    expect(readingClock(null, NOW, settings.sleepGapSec, NOW - 3 * M).clockFrom).toBe(NOW - 3 * M);
    expect(readingClock({ lastReadingAt: at(1), clockFrom: at(30) }, NOW, 600).clockFrom).toBe(NOW - 30 * M);
  });
});

describe("watchFacts and the state", () => {
  it("picks the topic's slices, their _Status_ state and the orchestrator", () => {
    const f = (name, branch, agents, extra = {}) => ({
      name,
      dir: `/fixture/${name}`,
      branch,
      agents,
      unknown: false,
      lastActivityAt: agents[0]?.lastActivityAt ?? null,
      stopped: false,
      running: [],
      leases: [],
      lastCommitAt: at(5),
      changes: [],
      lastChangeAt: null,
      lastProgressAt: at(5),
      ...extra,
    });
    const agent = {
      session: "prd-topic",
      agent: "a1",
      firstAt: at(30),
      lastActivityAt: at(2),
      stoppedAt: null,
      running: [],
    };
    const facts = [
      f("topic", "prd/topic", [{ ...agent, agent: null, lastActivityAt: at(3) }]),
      f("topic-4", "slice/topic/4", [agent], { changes: ["db/migrations/0009_x.sql"] }),
      f("other-4", "slice/other/4", [agent]),
    ];
    const plan = planStates(
      "# Plan\n\n## Status\n\n| Slice | Wave | State | Merge |\n| - | - | - | - |\n| 4 | 3 | handed off | — |\n\n## Other\n| 5 | 1 | merged | x |\n",
    );
    expect(plan).toEqual({ 4: "handed off" });
    const out = watchFacts({ topic: "topic", facts, plan, asks: [{ id: "a3", text: "slice 4 is stuck" }] });
    expect(out.orchestrator).toEqual({ lastActivityAt: at(3), stopped: false, running: false });
    expect(out.workers).toEqual([
      expect.objectContaining({ n: "4", status: "handed off", dirty: true, openAsk: "a3" }),
    ]);
    expect(out.workers[0].risky).toMatch(/migration/);
  });

  it("keeps a pending action's first time and raises a finding once", () => {
    const d = { workers: [{ n: "4", action: "nudge" }], finding: { key: "4,5@x", raised: false } };
    const first = nextState(null, d, NOW - M, null, { raise: true });
    expect(first.actions).toEqual({ 4: { action: "nudge", since: at(1) } });
    expect(first.findings).toEqual(["4,5@x"]);
    const again = nextState(first, d, NOW, null);
    expect(again.actions[4].since).toBe(at(1));
    expect(nextState(again, { workers: [], finding: null }, NOW, null).actions).toEqual({});
  });

  it("parses a recheck time", () => {
    expect(parseUntil("+30m", NOW)).toBe(at(-30));
    expect(parseUntil("+2h", NOW)).toBe(at(-120));
    expect(parseUntil("2026-11-24T13:00:00Z", NOW)).toBe(at(-60));
    expect(parseUntil("soon", NOW)).toBeNull();
  });
});

describe("the command", () => {
  let root, loops, sessions, watchDir, sleeper;
  const env = () => ({
    ...process.env,
    RISA_SESSIONS_DIR: sessions,
    RISA_ASKS_DIR: join(root, "asks"),
    RISA_WATCH_DIR: watchDir,
    RISA_LEASE_ROOT: join(root, "lease"),
    RISA_BROWSER_LEASES: "",
    RISA_RUN_LOG: join(root, "none.jsonl"),
    RISA_CHECK_LOG: join(root, "none.log"),
    RISA_WATCH_POLL: "1",
    RISA_WATCH_WAKE: "off",
  });
  const watch = (...args) =>
    spawnSync("node", [join(HERE, "watch.mjs"), "topic", ...args], { encoding: "utf8", env: env() });
  // A slice's checkout at DIR: on its slice branch, one empty commit.
  const sliceRepo = (dir) => {
    gitInit(["-q", "-b", "slice/topic/4", dir]);
    spawnSync("git", [
      "-C",
      dir,
      "-c",
      "user.email=loop@example.test",
      "-c",
      "user.name=Fixture",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "chore: start",
    ]);
  };
  const beat = (lastMin) => {
    const t = new Date(Date.now() - lastMin * M).toISOString();
    const dir = join(loops, ".heartbeat", "prd-topic");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "agent1.json.tmp"),
      JSON.stringify({
        pid: sleeper.pid,
        agent: "agent1",
        worktree: "topic-4",
        firstAt: t,
        lastStart: t,
        lastEnd: t,
        running: {},
      }),
    );
    spawnSync("mv", [join(dir, "agent1.json.tmp"), join(dir, "agent1.json")]);
  };

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "watch-")));
    loops = join(root, "main", ".loops");
    sessions = join(loops, ".sessions");
    watchDir = join(root, "watch");
    mkdirSync(sessions, { recursive: true });
    sliceRepo(join(loops, "topic-4"));
    // A live session the heartbeat belongs to: a process of our own, recorded as started now.
    sleeper = spawn("sleep", ["120"], { stdio: "ignore" });
    writeFileSync(
      join(sessions, "prd-topic.json"),
      JSON.stringify({ pid: sleeper.pid, kind: "prd", topic: "topic", started: new Date().toISOString() }),
    );
  });
  afterAll(() => {
    sleeper?.kill();
    rmSync(root, { recursive: true, force: true });
  });

  it("the slice fixture stops at a failed git init, before any later git command", () => {
    const dir = join(root, "old-git");
    const { error, calls } = withOldGit(() => sliceRepo(dir));
    expect(error?.message).toMatch(/^git init -q -b slice\/topic\/4 .* failed \(exit 129\)/);
    expect(calls).toEqual([`init -q -b slice/topic/4 ${dir}`]);
  });

  it("marks survive a new process; a bad mark is refused", () => {
    expect(watch("--mark", "4", "left", "--until", "+30m").status).toBe(0);
    expect(watch("--mark", "topic-4", "asked", "--ask", "a7").status).toBe(0);
    const marks = readMarks(watchDir, "topic");
    expect(marks[4].map((m) => m.mark)).toEqual(["left", "asked"]);
    expect(Date.parse(marks[4][0].until)).toBeGreaterThan(Date.now() + 29 * M);
    expect(marks[4][1].ask).toBe("a7");
    expect(watch("--mark", "4", "forgot").status).toBe(2);
    expect(watch("--mark", "x", "nudged").status).toBe(2);
    writeMark(watchDir, "fresh", { slice: "2", mark: "nudged", at: at(1) });
    expect(readMarks(watchDir, "fresh")).toEqual({ 2: [{ slice: "2", mark: "nudged", at: at(1) }] });
    rmSync(join(watchDir, "topic"), { recursive: true, force: true });
  });

  it("refuses a second restart mark of a slice", () => {
    expect(watch("--mark", "4", "restarted").status).toBe(0);
    const again = watch("--mark", "4", "restarted");
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/restarted once already.*second restart is refused/);
    expect(readMarks(watchDir, "topic")[4].map((m) => m.mark)).toEqual(["restarted"]);
    rmSync(join(watchDir, "topic"), { recursive: true, force: true });
  });

  it("--wait times out with nothing to act on, then exits with the action on a stall", () => {
    beat(1);
    const calm = watch("--wait", "--timeout", "2");
    expect(calm.status).toBe(75);
    beat(30);
    const stall = watch("--wait", "--json", "--timeout", "30");
    expect(stall.status).toBe(0);
    const r = JSON.parse(stall.stdout);
    expect(r.workers).toEqual([
      expect.objectContaining({ name: "topic-4", state: "quiet", action: "nudge" }),
    ]);
    const state = JSON.parse(readFileSync(join(watchDir, "topic", "state.json"), "utf8"));
    expect(state.actions[4].action).toBe("nudge");
    expect(watch("--mark", "4", "nudged").status).toBe(0);
    expect(watch().stdout).toMatch(
      /^topic-4 +quiet +none +no tool call for 30m; nudged \d+s ago, no reply yet$/m,
    );
  });
});
