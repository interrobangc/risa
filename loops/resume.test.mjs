// The resume after a limit's decision (resume.mjs), pure: fictional sessions and a fake clock.
import { describe, expect, it } from "vitest";
import { END_WAIT_MS } from "./drain.mjs";
import { ROTATING_GRACE_MS } from "./dispatch-pick.mjs";
import { resumeDecision, resumingOf, sessionOfBranch } from "./resume.mjs";

const MIN = 60_000;
const NOW = Date.parse("2026-11-24T12:00:00Z");
const iso = (/** @type {number} */ t) => new Date(t).toISOString();
const normal = { state: /** @type {const} */ ("normal"), why: "under the drain line" };
/** A stall at NOW - 2h whose reset passed a minute ago. */
const mark = (session, extra = {}) => ({
  session,
  stalled: {
    at: iso(NOW - 120 * MIN),
    error: "limited",
    resetsAt: iso(NOW - MIN),
    pid: 99_999_999,
    ...extra,
  },
});
const dead = (name, extra = {}) => ({
  name,
  live: false,
  managed: true,
  pid: 99_999_999,
  started: iso(NOW - 180 * MIN),
  ...extra,
});
const trees = [
  { name: "a", branch: "prd/a" },
  { name: "b", branch: "prd/b" },
  { name: "plan-c", branch: "plan/c" },
];
const decide = (over = {}) =>
  resumeDecision({
    marks: [],
    sessions: [],
    worktrees: trees,
    rows: [],
    drain: normal,
    now: NOW,
    ...over,
  });

describe("sessionOfBranch", () => {
  it("names prd and plan sessions only", () => {
    expect(sessionOfBranch("prd/a")).toBe("prd-a");
    expect(sessionOfBranch("plan/c")).toBe("plan-c");
    expect(sessionOfBranch("slice/a/1")).toBeNull();
    expect(sessionOfBranch("hotfix/h")).toBeNull();
  });
});

describe("resumeDecision", () => {
  it("after the reset: claims a stalled managed session and resumes it, with --continue and the carry-on prompt", () => {
    const d = decide({ marks: [mark("prd-a")], sessions: [dead("prd-a")] });
    expect(d.claim).toEqual([
      {
        session: "prd-a",
        claim: { at: NOW, since: NOW - 120 * MIN, pid: 99_999_999, error: "limited" },
      },
    ]);
    expect(d.acts).toEqual([
      {
        type: "open",
        session: "prd-a",
        worktree: "a",
        why: expect.stringMatching(/carry-on prompt \(not counted toward the reopen limit\)/),
      },
    ]);
    expect(resumingOf({}, d)).toEqual(new Set(["prd-a"]));
  });

  it("claims a StopFailure's rate_limit mark too, and a planner", () => {
    const d = decide({
      marks: [mark("plan-c", { error: "rate_limit", pid: null })],
      sessions: [dead("plan-c")],
    });
    expect(d.claim).toMatchObject([{ session: "plan-c", claim: { error: "rate_limit", pid: null } }]);
    expect(d.acts).toMatchObject([{ type: "open", session: "plan-c", worktree: "plan-c" }]);
  });

  it("before the reset, or while limited: nothing is claimed", () => {
    const before = mark("prd-a", { resetsAt: iso(NOW + MIN) });
    expect(decide({ marks: [before], sessions: [dead("prd-a")] })).toMatchObject({ claim: [], acts: [] });
    const limited = { state: /** @type {const} */ ("limited"), why: "5h 99%" };
    expect(decide({ marks: [mark("prd-a")], sessions: [dead("prd-a")], drain: limited })).toMatchObject({
      claim: [],
      acts: [],
    });
  });

  it("one per tick: the oldest claim first, the rest wait", () => {
    const claimed = {
      "prd-b": { at: NOW - 2 * MIN, since: NOW - 120 * MIN, pid: 99_999_999, error: "limited" },
    };
    const d = decide({
      marks: [mark("prd-a")],
      sessions: [dead("prd-a"), dead("prd-b")],
      claimed,
    });
    expect(d.acts).toMatchObject([{ type: "open", session: "prd-b" }]);
    expect(d.waits).toEqual([{ session: "prd-a", why: "one resume a tick: prd-b first" }]);
    // Both stay the resume's, so the pick counts neither as a death.
    expect(resumingOf(claimed, d)).toEqual(new Set(["prd-a", "prd-b"]));
  });

  it("an already claimed session's new mark is only cleared", () => {
    const claimed = { "prd-a": { at: NOW - MIN, since: NOW - 120 * MIN, pid: 99_999_999, error: "limited" } };
    const d = decide({ marks: [mark("prd-a")], sessions: [dead("prd-a")], claimed });
    expect(d.claim).toEqual([]);
    expect(d.clear).toEqual(["prd-a"]);
    expect(d.acts).toMatchObject([{ type: "open", session: "prd-a" }]);
  });

  it("waits while paused, draining, on hold, being rotated, or with a landing marker", () => {
    const base = { marks: [mark("prd-a")], sessions: [dead("prd-a")] };
    const why = (over) => decide({ ...base, ...over }).waits.map((w) => w.why);
    expect(why({ paused: true })).toEqual(["the dispatcher is paused"]);
    expect(why({ drain: { state: "draining", why: "5h 90%" } })).toEqual(["usage is draining"]);
    expect(why({ rows: [{ topic: "a", state: "running", flags: ["hold"] }] })).toEqual([
      "its topic is on hold",
    ]);
    expect(why({ landing: new Set(["prd-a"]) })).toEqual(["it has a landing marker: a landing first"]);
    expect(
      why({ sessions: [dead("prd-a", { rotating: true, rotatingAt: NOW - ROTATING_GRACE_MS + MIN })] }),
    ).toEqual(["it is being rotated"]);
    // Waiting still claims it: the pick leaves it alone.
    const d = decide({ ...base, paused: true });
    expect(d.acts).toEqual([]);
    expect(resumingOf({}, d)).toEqual(new Set(["prd-a"]));
  });

  it("a live stalled session is ended first (TERM, KILL after the wait), never in a pnpm prd command", () => {
    const live = { ...dead("prd-a"), live: true };
    const base = { marks: [mark("prd-a")], sessions: [live] };
    expect(decide(base).acts).toEqual([{ type: "end", session: "prd-a", pid: 99_999_999 }]);
    expect(decide({ ...base, commands: new Set(["prd-a"]) })).toMatchObject({
      acts: [],
      waits: [{ session: "prd-a", why: "it runs a pnpm prd command" }],
    });
    expect(decide({ ...base, commands: null }).waits[0].why).toBe("the process table can't be read");
    expect(decide({ ...base, landing: new Set(["prd-a"]) }).acts).toEqual([]);
    const termed = (at) => ({
      "prd-a": {
        at: NOW - 5 * MIN,
        since: NOW - 120 * MIN,
        pid: 99_999_999,
        error: "limited",
        termPid: 99_999_999,
        termAt: at,
      },
    });
    expect(decide({ sessions: [live], claimed: termed(NOW - 1000) })).toMatchObject({
      acts: [],
      waits: [{ why: "sent TERM; waiting for it to end" }],
    });
    expect(decide({ sessions: [live], claimed: termed(NOW - END_WAIT_MS) }).acts).toEqual([
      { type: "kill", session: "prd-a", pid: 99_999_999 },
    ]);
  });

  it("drops a claim whose session came back, whose worktree or record went, or whose topic is done", () => {
    const claimed = { "prd-a": { at: NOW - MIN, since: NOW - 120 * MIN, pid: 99_999_999, error: "limited" } };
    const back = { name: "prd-a", live: true, managed: true, pid: 99_999_998, started: iso(NOW - 10 * MIN) };
    const drops = (over) => decide({ claimed, ...over }).drop.map((x) => x.why);
    expect(drops({ sessions: [back] })).toEqual([
      "it came back meanwhile (a session started after the stall)",
    ]);
    expect(drops({ sessions: [dead("prd-a")], worktrees: [] })).toEqual(["its worktree is gone"]);
    expect(drops({ sessions: [] })).toEqual(["it has no managed record"]);
    expect(drops({ sessions: [dead("prd-a")], rows: [{ topic: "a", state: "done" }] })).toEqual([
      "its topic is done",
    ]);
    expect(resumingOf(claimed, decide({ claimed, sessions: [back] }))).toEqual(new Set());
  });

  it("a hand-opened session is only reported; another managed session's mark is only cleared", () => {
    const d = decide({
      marks: [
        mark("prd-b", { error: "rate_limit" }),
        mark("hotfix-h", { error: "rate_limit" }),
        mark("backlog"),
      ],
      sessions: [
        { ...dead("prd-b"), managed: false, live: true },
        { ...dead("hotfix-h"), managed: false },
        dead("backlog"),
      ],
    });
    expect(d.claim).toEqual([]);
    expect(d.acts).toEqual([]);
    expect(d.clear).toEqual(["backlog"]);
    expect(d.report?.sessions).toEqual(["hotfix-h", "prd-b"]);
    expect(d.report?.text).toMatch(
      /^hotfix-h, prd-b stopped on a usage limit that has now reset\. .*never one opened by hand/,
    );
  });
});
