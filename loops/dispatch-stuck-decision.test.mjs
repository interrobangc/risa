// The stuck orchestrator's decision (B-408): dispatch-stuck.mjs's pure parts.
// The tick that acts on it is dispatch-stuck-tick.test.mjs's.
import { describe, expect, it } from "vitest";
import {
  STUCK_OPTIONS,
  STUCK_SESSION,
  busyUnder,
  onlyWaits,
  stuckAnswer,
  stuckClock,
  stuckDecision,
  stuckSettings,
} from "./dispatch-stuck.mjs";

describe("the stuck decision", () => {
  const NOW = Date.parse("2027-01-15T12:00:00Z");
  const LIMIT = 30 * 60_000;
  const ago = (min) => new Date(NOW - min * 60_000).toISOString();
  const sess = (extra = {}) => ({
    name: "prd-x",
    pid: 100,
    kind: "prd",
    topic: "x",
    managed: true,
    auto: true,
    live: true,
    ...extra,
  });
  const own = (extra = {}) => ({
    session: "prd-x",
    pid: 100,
    agent: null,
    lastStart: ago(41),
    lastEnd: ago(40),
    stoppedAt: ago(40),
    running: {},
    ...extra,
  });
  const agent = (extra = {}) => ({ ...own(), agent: "a1", stoppedAt: null, ...extra });
  const decide = (facts = {}) =>
    stuckDecision({ sessions: [sess()], heartbeats: [own()], limitMs: LIMIT, now: NOW, ...facts });
  const asks = (facts) => decide(facts).filter((a) => a.type === "ask");

  it("asks once about an orchestrator quiet for the limit, then waits on its question", () => {
    const [a] = asks();
    expect(a).toMatchObject({ session: "prd-x", pid: 100, topic: "x", since: Date.parse(ago(40)) });
    expect(a.text).toMatch(/prd-x looks stuck: no tool call for 40m/);
    expect(asks({ heartbeats: [own({ lastEnd: ago(29), stoppedAt: ago(29) })] })).toEqual([]);
    const open = { id: "a1", topic: "x", kind: "question", session: STUCK_SESSION };
    expect(decide({ entries: { "prd-x": { pid: 100, since: 0, askId: "a1" } }, asks: [open] })).toEqual([]);
  });

  it("asks about one whose only command is watch --wait (or ask --wait)", () => {
    const waiting = (command) => own({ running: { t1: { tool: "Bash", at: ago(41), command } } });
    expect(asks({ heartbeats: [waiting("pnpm prd watch x --wait --timeout 3600")] })).toHaveLength(1);
    expect(asks({ heartbeats: [waiting("pnpm prd ask --wait a7")] })).toHaveLength(1);
    expect(asks({ heartbeats: [waiting("pnpm test")] })).toEqual([]);
    expect(onlyWaits("pnpm prd watch x --json")).toBe(false);
  });

  it("asks about one whose slice agent is hung: an old unfinished call is no recent heartbeat", () => {
    const hung = agent({
      lastStart: ago(90),
      lastEnd: ago(95),
      running: { t2: { tool: "Bash", at: ago(90) } },
    });
    expect(asks({ heartbeats: [own(), hung] })).toHaveLength(1);
    // An open Agent call of its own is that agent's to speak for.
    const call = own({ running: { t3: { tool: "Agent", at: ago(90) } } });
    expect(asks({ heartbeats: [call, hung] })).toHaveLength(1);
  });

  it("asks about a watch action unhandled for the limit, though the orchestrator is active", () => {
    const active = own({ lastEnd: ago(1), stoppedAt: ago(1) });
    const watch = (since, marks = []) => ({
      x: { state: { actions: { 2: { action: "restart", since } } }, marks },
    });
    const [a] = asks({ heartbeats: [active], watch: watch(ago(35)) });
    expect(a.text).toContain("slice 2's watch action (restart) has waited 35m unhandled");
    expect(asks({ heartbeats: [active], watch: watch(ago(20)) })).toEqual([]);
    // A mark for that slice since the action handled it.
    expect(asks({ heartbeats: [active], watch: watch(ago(35), [{ slice: "2", at: ago(30) }]) })).toEqual([]);
    expect(asks({ heartbeats: [active], watch: watch(ago(35), [{ slice: "3", at: ago(30) }]) })).toHaveLength(
      1,
    );
  });

  it("asks nothing with a recent agent heartbeat, a running command or an open question", () => {
    expect(asks({ heartbeats: [own(), agent({ lastStart: ago(5), lastEnd: ago(5) })] })).toEqual([]);
    expect(asks({ running: new Set(["prd-x"]) })).toEqual([]);
    expect(
      asks({
        heartbeats: [own({ running: { t1: { tool: "Bash", at: ago(41), command: "pnpm prd land x" } } })],
      }),
    ).toEqual([]);
    const question = { id: "a4", topic: "x", kind: "question", session: "prd-x" };
    expect(asks({ asks: [question] })).toEqual([]);
    expect(asks({ asks: [{ ...question, answeredAt: ago(2), answer: "yes" }] })).toHaveLength(1);
    expect(asks({ asks: [{ ...question, topic: "y" }] })).toHaveLength(1);
  });

  it("leaves alone a session with no heartbeat ever, or another pid's", () => {
    expect(decide({ heartbeats: [] })).toEqual([]);
    expect(decide({ heartbeats: [own({ pid: 99 })] })).toEqual([]);
    expect(decide({ heartbeats: [agent()] })).toEqual([]);
  });

  it("ignores a session opened by hand, a planner, a dead or rotating one", () => {
    for (const extra of [
      { managed: false },
      { auto: false },
      { kind: "plan" },
      { live: false },
      { rotating: true },
    ])
      expect(decide({ sessions: [sess(extra)] })).toEqual([]);
  });

  it("a tick gap resets the clocks", () => {
    const gap = stuckSettings({}).gapMs;
    expect(gap).toBe(600_000);
    expect(stuckSettings({}, 300).gapMs).toBe(900_000);
    expect(stuckSettings({ RISA_STUCK_MIN: "5" }).limitMs).toBe(300_000);
    expect(stuckClock(undefined, NOW, gap)).toBeNull();
    expect(stuckClock({ lastTickAt: NOW - 60_000 }, NOW, gap)).toBeNull();
    expect(stuckClock({ lastTickAt: NOW - gap - 1 }, NOW, gap)).toBe(NOW);
    expect(stuckClock({ lastTickAt: NOW - 60_000, clockFrom: NOW - 3_600_000 }, NOW, gap)).toBe(
      NOW - 3_600_000,
    );
    expect(asks({ clockFrom: NOW - 10 * 60_000 })).toEqual([]);
    const watch = { x: { state: { actions: { 2: { action: "nudge", since: ago(90) } } }, marks: [] } };
    expect(asks({ heartbeats: [own({ lastEnd: ago(1) })], watch, clockFrom: NOW - 10 * 60_000 })).toEqual([]);
    expect(asks({ clockFrom: NOW - 31 * 60_000 })).toHaveLength(1);
  });

  it("several going quiet together raise one report and no question", () => {
    const y = sess({ name: "prd-y", pid: 200, topic: "y" });
    const yBeat = own({ session: "prd-y", pid: 200, lastEnd: ago(50), stoppedAt: ago(50) });
    const facts = { sessions: [sess(), y], heartbeats: [own(), yBeat] };
    const out = decide(facts);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "report", sessions: ["prd-x", "prd-y"] });
    expect(out[0].text).toContain("went quiet together");
    expect(decide({ ...facts, reported: [out[0].key] })).toEqual([]);
    // Quiet far apart: each its own question.
    const far = own({
      session: "prd-y",
      pid: 200,
      lastEnd: ago(200),
      stoppedAt: ago(200),
      lastStart: ago(200),
    });
    expect(asks({ ...facts, heartbeats: [own(), far] }).map((a) => a.session)).toEqual(["prd-x", "prd-y"]);
  });

  it("each answer does what it says", () => {
    expect(stuckAnswer(STUCK_OPTIONS[0])).toBe("rotate");
    expect(stuckAnswer("1")).toBe("rotate");
    expect(stuckAnswer(STUCK_OPTIONS[1])).toBe("leave");
    expect(stuckAnswer("who knows")).toBe("leave");
    const entry = (extra = {}) => ({ "prd-x": { pid: 100, since: 0, askId: "a1", ...extra } });
    const q = (extra = {}) => [{ id: "a1", topic: "x", kind: "question", session: STUCK_SESSION, ...extra }];
    expect(decide({ entries: entry(), asks: q({ answeredAt: ago(1), answer: STUCK_OPTIONS[0] }) })).toEqual([
      { type: "answered", session: "prd-x", answer: "rotate", askId: "a1" },
      { type: "rotate", session: "prd-x", pid: 100, topic: "x" },
    ]);
    expect(decide({ entries: entry(), asks: q({ answeredAt: ago(1), answer: STUCK_OPTIONS[1] }) })).toEqual([
      { type: "answered", session: "prd-x", answer: "leave", askId: "a1" },
    ]);
    expect(decide({ entries: entry(), asks: q({ doneAt: ago(1) }) })).toEqual([
      { type: "answered", session: "prd-x", answer: "leave", askId: "a1" },
    ]);
    expect(decide({ entries: entry({ answer: "leave" }) })).toEqual([]);
    expect(decide({ entries: entry({ answer: "rotate", triedAt: NOW - 60_000 }) })).toEqual([]);
    expect(decide({ entries: entry({ answer: "rotate", triedAt: NOW - LIMIT }) })).toEqual([
      { type: "rotate", session: "prd-x", pid: 100, topic: "x" },
    ]);
    // The stall over: its entry clears and its open question is dismissed.
    const active = own({ lastEnd: ago(1) });
    expect(decide({ heartbeats: [active], entries: entry(), asks: q() })).toEqual([
      { type: "clear", session: "prd-x", askId: "a1" },
    ]);
    expect(
      decide({ sessions: [sess({ pid: 101 })], heartbeats: [], entries: entry({ answer: "leave" }) }),
    ).toEqual([{ type: "clear", session: "prd-x", askId: null }]);
  });

  it("a paused dispatcher does nothing", () => {
    expect(decide({ paused: true })).toEqual([]);
  });

  it("counts a pnpm prd command under the session as running, a wait not", () => {
    const table = (args) =>
      new Map([
        [100, { ppid: 1, args: "claude pnpm prd land x" }],
        [101, { ppid: 100, args: "bash -c x" }],
        [102, { ppid: 101, args }],
      ]);
    expect(busyUnder(100, table("pnpm prd land x"))).toBe(true);
    expect(busyUnder(100, table("bash loops/prd.sh check --quick"))).toBe(true);
    expect(busyUnder(100, table("pnpm prd watch x --wait"))).toBe(false);
    expect(busyUnder(100, table("pnpm prd ask --wait a3"))).toBe(false);
    expect(busyUnder(100, table("sleep 60"))).toBe(false);
  });
});
