// The dispatcher's pick (dispatch-pick.mjs): one test per rule and per
// ordering, the fixes rule, no hold, and the reasons. Pure: facts in, one
// action and its reasons out.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAPS,
  DISPATCH_SESSION,
  KEEP_SESSION,
  MAX_REOPENS,
  REOPEN_OPTIONS,
  ROTATING_GRACE_MS,
  formatPick,
  hotCollision,
  pick,
  worktreeKind,
} from "./dispatch-pick.mjs";

const NOW = Date.parse("2026-11-21T12:00:00Z");

/** A registry row as `pnpm backlog prd list --json` gives it. */
const row = (topic, state, extra = {}) => ({
  topic,
  flags: [],
  after: [],
  hot: [],
  state,
  waiting: 0,
  ...extra,
});
const prdWt = (topic) => ({ name: topic, branch: `prd/${topic}` });
const planWt = (topic) => ({ name: `plan-${topic}`, branch: `plan/${topic}` });
const session = (name, extra = {}) => ({ name, live: true, managed: true, ...extra });
const question = (id, topic, extra = {}) => ({ id, kind: "question", topic, session: "prd-x", ...extra });

/** Facts with `topic` running under a live managed session. */
const runningFacts = (topics) => ({
  worktrees: topics.map(prdWt),
  sessions: topics.map((t) => session(`prd-${t}`)),
});

const go = (/** @type {import("./dispatch-pick.mjs").PickFacts} */ facts) => pick({ now: NOW, ...facts });
const whyOf = (p, topic) => p.reasons.find((r) => r.topic === topic)?.why;

describe("worktreeKind and hotCollision", () => {
  it("reads prd/ and plan/ branches and nothing else", () => {
    expect(worktreeKind("prd/a")).toEqual({ kind: "prd", topic: "a" });
    expect(worktreeKind("plan/a")).toEqual({ kind: "plan", topic: "a" });
    expect(worktreeKind("slice/a/1")).toBeNull();
    expect(worktreeKind("hotfix/x")).toBeNull();
  });

  it("collides when one prefix starts with the other, as plain text, naming the longer", () => {
    expect(hotCollision(["scripts/loops/"], ["scripts/loops/prompt.sh"])).toBe("scripts/loops/prompt.sh");
    expect(hotCollision(["scripts/loops/session"], ["scripts/loops/session.sh"])).toBe(
      "scripts/loops/session.sh",
    );
    expect(hotCollision(["scripts/loops/open-session."], ["scripts/loops/open-session.mjs"])).toBe(
      "scripts/loops/open-session.mjs",
    );
    expect(hotCollision(["web/"], ["scripts/"])).toBeNull();
    expect(hotCollision([], ["scripts/"])).toBeNull();
  });
});

describe("rule 1: paused", () => {
  it("does nothing, not even a reopen", () => {
    const p = go({
      paused: true,
      rows: [row("a", "planned"), row("b", "running")],
      worktrees: [prdWt("b")],
      sessions: [session("prd-b", { live: false })],
    });
    expect(p.action).toBe("none");
    expect(p.why).toBe("the dispatcher is paused");
  });
});

describe("rule 2: dead sessions", () => {
  const dead = { rows: [row("a", "running"), row("b", "planned")], worktrees: [prdWt("a")] };

  it("reopens a managed worktree with no live session, before any start", () => {
    const p = go({ ...dead, sessions: [session("prd-a", { live: false })] });
    expect(p).toMatchObject({ action: "reopen", topic: "a", session: "prd-a", worktree: "a" });
    expect(p.why).toBe(`prd-a died (reopen 1 of ${MAX_REOPENS})`);
    expect(whyOf(p, "b")).toBe("waits a tick: prd-a died (reopen 1 of 2)");
  });

  it("leaves a session the resume claimed to it: never reopened, never counted, nothing asked", () => {
    const p = go({
      ...dead,
      sessions: [session("prd-a", { live: false, resuming: true })],
      reopens: { "prd-a": MAX_REOPENS },
    });
    expect(p.action).toBe("start");
    expect(whyOf(p, "a")).toBe(
      "its orchestrator stopped on a usage limit: the resume brings it back (not counted)",
    );
    expect(formatPick({ action: "resume", session: "prd-a", why: "x", reasons: [] })).toEqual([
      "resume prd-a: x",
    ]);
  });

  it("reopens a managed planner too", () => {
    const p = go({
      rows: [row("a", "to-write", { waiting: 2 })],
      worktrees: [planWt("a")],
      sessions: [session("plan-a", { live: false })],
    });
    expect(p).toMatchObject({ action: "reopen", topic: "a", session: "plan-a", worktree: "plan-a" });
  });

  it("the third death is an ask, and the topic is skipped while that ask is open", () => {
    const facts = {
      ...dead,
      sessions: [session("prd-a", { live: false })],
      reopens: { "prd-a": MAX_REOPENS },
    };
    const p = go(facts);
    expect(p).toMatchObject({ action: "ask", topic: "a", session: "prd-a", options: REOPEN_OPTIONS });
    expect(p.text).toContain("Reopen it once more, or hold a?");

    const asked = go({ ...facts, asks: [question("a7", "a", { session: DISPATCH_SESSION })] });
    expect(asked.action).toBe("start");
    expect(asked.topic).toBe("b");
    expect(whyOf(asked, "a")).toBe("its orchestrator died after 2 reopens; waits on ask a7");
  });

  it("an answered reopen ask no longer holds it back: the count decides", () => {
    const p = go({
      ...dead,
      sessions: [session("prd-a", { live: false })],
      reopens: { "prd-a": MAX_REOPENS },
      asks: [question("a7", "a", { session: DISPATCH_SESSION, answeredAt: "2026-11-21T11:00:00Z" })],
    });
    expect(p.action).toBe("ask");
  });

  it("never reopens or asks about a held topic's dead session", () => {
    const held = { ...dead, rows: [row("a", "running", { flags: ["hold"] }), row("b", "planned")] };
    for (const reopens of [{}, { "prd-a": MAX_REOPENS }]) {
      const p = go({ ...held, sessions: [session("prd-a", { live: false })], reopens });
      expect(p.action).toBe("start");
      expect(whyOf(p, "a")).toBe("on hold; its orchestrator isn't live (not reopened)");
    }
  });

  it("a record marked rotating in the last five minutes isn't reopened; an older one is", () => {
    const rot = (ago) => [session("prd-a", { live: false, rotating: true, rotatingAt: NOW - ago })];
    const fresh = go({ ...dead, sessions: rot(ROTATING_GRACE_MS - 1000) });
    expect(fresh.action).toBe("start");
    expect(whyOf(fresh, "a")).toBe("its orchestrator is being rotated");
    expect(go({ ...dead, sessions: rot(ROTATING_GRACE_MS + 1000) }).action).toBe("reopen");
    // ISO times work too, and no time at all counts as just now.
    expect(
      go({
        ...dead,
        sessions: [
          session("prd-a", { live: false, rotating: true, rotatingAt: new Date(NOW - 60_000).toISOString() }),
        ],
      }).action,
    ).toBe("start");
    expect(go({ ...dead, sessions: [session("prd-a", { live: false, rotating: true })] }).action).toBe(
      "start",
    );
  });

  it("an unmanaged worktree is only reported, and still takes a slot and its hot files", () => {
    const rows = [
      row("a", "running", { hot: ["scripts/loops/"] }),
      row("b", "planned", { hot: ["scripts/loops/prompt.sh"] }),
      row("c", "planned"),
    ];
    const dead = go({
      rows,
      worktrees: [prdWt("a")],
      sessions: [session("prd-a", { live: false, managed: false })],
    });
    expect(dead.action).toBe("start");
    expect(dead.topic).toBe("c");
    expect(whyOf(dead, "a")).toBe("opened by hand, its orchestrator isn't live (left alone)");
    expect(whyOf(dead, "b")).toBe("shares scripts/loops/prompt.sh with a");

    // No record at all is a hand-opened worktree too, and a live one is "running, opened by hand".
    expect(whyOf(go({ rows, worktrees: [prdWt("a")] }), "a")).toBe(
      "opened by hand, its orchestrator isn't live (left alone)",
    );
    expect(
      whyOf(go({ rows, worktrees: [prdWt("a")], sessions: [session("prd-a", { managed: false })] }), "a"),
    ).toBe("running, opened by hand");

    const full = go({
      rows: [row("a", "running"), row("x", "running"), row("y", "running"), row("c", "planned")],
      worktrees: [prdWt("a"), prdWt("x"), prdWt("y")],
      sessions: [session("prd-x"), session("prd-y")],
      caps: { prds: 3 },
    });
    expect(full.action).toBe("none");
    expect(whyOf(full, "c")).toBe("no free slot (3 of 3 running)");
  });

  it("a finished topic's leftover worktree isn't reopened", () => {
    expect(
      go({ rows: [row("a", "done")], worktrees: [prdWt("a")], sessions: [session("prd-a", { live: false })] })
        .action,
    ).toBe("none");
    const p = go({
      rows: [row("a", "planned")],
      worktrees: [planWt("a")],
      sessions: [session("plan-a", { live: false })],
    });
    expect(p.action).toBe("start");
    expect(p.topic).toBe("a");
  });
  it("a landed planner's leftover worktree neither counts as a planner nor hides its topic's reason", () => {
    const p = go({
      rows: [row("a", "planned", { after: ["z"] }), row("b", "to-write", { waiting: 1 })],
      worktrees: [planWt("a")],
      sessions: [session("plan-a")],
    });
    expect(p).toMatchObject({ action: "plan", topic: "b" });
    expect(whyOf(p, "a")).toBe("waits for z");
  });
});

describe("rule 3: busy", () => {
  it("stops starts and plans, with the reason", () => {
    const p = go({ busy: true, rows: [row("a", "planned"), row("b", "to-write", { waiting: 2 })] });
    expect(p.action).toBe("none");
    expect(p.why).toBe("the machine is busy");
    expect(whyOf(p, "a")).toBe("the machine is busy");
    expect(whyOf(p, "b")).toBe("the machine is busy");
  });

  it("doesn't stop a reopen", () => {
    const p = go({
      busy: true,
      rows: [row("a", "running")],
      worktrees: [prdWt("a")],
      sessions: [session("prd-a", { live: false })],
    });
    expect(p.action).toBe("reopen");
  });
});

describe("rule 4: starts", () => {
  it("starts a planned topic when nothing stops it", () => {
    const p = go({ rows: [row("a", "planned")] });
    expect(p).toMatchObject({ action: "start", topic: "a", why: "planned, and nothing stops it" });
  });

  it("the cap", () => {
    const p = go({
      rows: [row("x", "running"), row("y", "running"), row("a", "planned")],
      ...runningFacts(["x", "y"]),
      caps: { prds: 2 },
    });
    expect(p.action).toBe("none");
    expect(whyOf(p, "a")).toBe("no free slot (2 of 2 running)");
    expect(go({ rows: [row("x", "running"), row("a", "planned")], ...runningFacts(["x"]) }).topic).toBe("a");
  });

  it("the default cap is four", () => {
    const names = ["w", "x", "y"];
    const rows = [...names.map((n) => row(n, "running")), row("a", "planned")];
    expect(DEFAULT_CAPS.prds).toBe(4);
    expect(go({ rows, ...runningFacts(names) }).topic).toBe("a");
    const full = go({
      rows: [row("z", "running"), ...rows],
      ...runningFacts([...names, "z"]),
    });
    expect(full.action).toBe("none");
    expect(whyOf(full, "a")).toBe("no free slot (4 of 4 running)");
  });

  it("an After topic not done", () => {
    const rows = [row("planner-2", "running"), row("a", "planned", { after: ["planner-2"] })];
    const p = go({ rows, ...runningFacts(["planner-2"]) });
    expect(p.action).toBe("none");
    expect(whyOf(p, "a")).toBe("waits for planner-2");
    expect(go({ rows: [row("planner-2", "done"), rows[1]] }).topic).toBe("a");
    // An After topic with no row isn't done.
    expect(whyOf(go({ rows: [rows[1]] }), "a")).toBe("waits for planner-2");
  });

  it("a hot-file collision with a running topic", () => {
    const rows = [
      row("check-speed", "running", { hot: ["scripts/loops/prompt.sh"] }),
      row("a", "planned", { hot: ["scripts/loops/"] }),
      row("b", "planned", { hot: ["web/"] }),
    ];
    const p = go({ rows, ...runningFacts(["check-speed"]) });
    expect(p.topic).toBe("b");
    expect(whyOf(p, "a")).toBe("shares scripts/loops/prompt.sh with check-speed");
  });

  it("a running topic with no hot files collides with nothing", () => {
    const rows = [row("x", "running"), row("a", "planned", { hot: ["scripts/loops/"] })];
    expect(go({ rows, ...runningFacts(["x"]) }).topic).toBe("a");
  });

  it("alone, both ways", () => {
    const aloneRunning = go({
      rows: [row("x", "running", { flags: ["alone"] }), row("a", "planned")],
      ...runningFacts(["x"]),
    });
    expect(aloneRunning.action).toBe("none");
    expect(whyOf(aloneRunning, "a")).toBe("x runs alone");

    const aloneWaiting = go({
      rows: [row("x", "running"), row("a", "planned", { flags: ["alone"] })],
      ...runningFacts(["x"]),
    });
    expect(aloneWaiting.action).toBe("none");
    expect(whyOf(aloneWaiting, "a")).toBe("runs alone, and x is running");
    expect(go({ rows: [row("a", "planned", { flags: ["alone"] })] }).topic).toBe("a");
  });

  it("an open question skips only its topic", () => {
    const p = go({ rows: [row("a", "planned"), row("b", "planned")], asks: [question("a3", "a")] });
    expect(p.topic).toBe("b");
    expect(whyOf(p, "a")).toBe("has an open question (a3)");
    // A report, an answered question and a dismissed one don't count.
    const asks = [
      { id: "a4", kind: "report", topic: "a" },
      question("a5", "a", { answeredAt: "2026-11-21T11:00:00Z" }),
      question("a6", "a", { doneAt: "2026-11-21T11:00:00Z" }),
    ];
    expect(go({ rows: [row("a", "planned")], asks }).topic).toBe("a");
  });

  it("a defaulted question no longer skips its topic; one still awaiting an answer does", () => {
    const defaulted = question("a5", "a", {
      defaults: true,
      defaulted: true,
      answer: "yes",
      answeredAt: "2026-11-21T11:30:00Z",
    });
    expect(go({ rows: [row("a", "planned")], asks: [defaulted] })).toMatchObject({
      action: "start",
      topic: "a",
    });
    // Due but not settled yet: it still awaits an answer (the tick settles it first).
    const due = question("a6", "a", { defaults: true, defaultAt: "2026-11-21T11:00:00Z" });
    const p = go({ rows: [row("a", "planned")], asks: [due] });
    expect(p.action).toBe("none");
    expect(whyOf(p, "a")).toBe("has an open question (a6)");
  });

  it("hold and done are never picked", () => {
    const p = go({ rows: [row("a", "hold"), row("b", "done"), row("c", "planned")] });
    expect(p.topic).toBe("c");
    expect(whyOf(p, "a")).toBe("on hold");
    expect(whyOf(p, "b")).toBeUndefined();
    expect(go({ rows: [row("a", "hold"), row("b", "done")] }).action).toBe("none");
  });

  it("no hold: a topic planned a minute ago starts on the next pick", () => {
    // Its planner landed a minute ago and is still ending in its plan worktree.
    const p = go({
      rows: [row("a", "planned", { waiting: 3 })],
      worktrees: [planWt("a")],
      sessions: [session("plan-a", { started: new Date(NOW - 30 * 60_000).toISOString() })],
      asks: [{ id: "a9", kind: "report", topic: "a", askedAt: new Date(NOW - 60_000).toISOString() }],
    });
    expect(p).toMatchObject({ action: "start", topic: "a" });
  });
});

describe("rule 5: fixes topics", () => {
  const fixes = (topic, waiting, extra = {}) =>
    row(topic, "planned", { flags: ["standing"], waiting, ...extra });

  it("a second fixes topic waits while one runs", () => {
    const p = go({
      rows: [row("fixes-ui", "running", { flags: ["standing"] }), fixes("fixes-tooling", 5)],
      ...runningFacts(["fixes-ui"]),
    });
    expect(p.action).toBe("none");
    expect(whyOf(p, "fixes-tooling")).toBe("another fixes topic (fixes-ui) is running");
  });

  it("fewer than three waiting waits while another topic may start, and starts when none may", () => {
    const rows = [fixes("fixes-ui", 2), row("a", "planned")];
    const p = go({ rows });
    expect(p.topic).toBe("a");
    expect(whyOf(p, "fixes-ui")).toBe("2 waiting, under 3, and a may start");

    const none = go({ rows: [fixes("fixes-ui", 2), row("a", "planned", { after: ["z"] })] });
    expect(none).toMatchObject({ action: "start", topic: "fixes-ui", why: "2 waiting fixes" });
  });

  it("three waiting starts in row order", () => {
    expect(go({ rows: [fixes("fixes-ui", 3), row("a", "planned")] }).topic).toBe("fixes-ui");
    expect(go({ rows: [row("a", "planned"), fixes("fixes-ui", 3)] }).topic).toBe("a");
  });

  it("the minimum is a setting", () => {
    expect(go({ rows: [fixes("fixes-ui", 1), row("a", "planned")], caps: { fixesMin: 1 } }).topic).toBe(
      "fixes-ui",
    );
  });

  it("idle never starts", () => {
    const p = go({ rows: [row("fixes-ui", "idle", { flags: ["standing"] })] });
    expect(p.action).toBe("none");
    expect(whyOf(p, "fixes-ui")).toBe("no waiting items");
  });

  it("a fixes topic sharing a hot file with a running topic waits", () => {
    const p = go({
      rows: [
        row("a", "running", { hot: ["scripts/loops/"] }),
        fixes("fixes-tooling", 4, { hot: ["scripts/loops/land.sh"] }),
      ],
      ...runningFacts(["a"]),
    });
    expect(whyOf(p, "fixes-tooling")).toBe("shares scripts/loops/land.sh with a");
  });
});

describe("rule 6: planning", () => {
  it("plans a to-write topic with waiting items", () => {
    const p = go({ rows: [row("a", "to-write", { waiting: 2 })] });
    expect(p).toMatchObject({ action: "plan", topic: "a", why: "2 waiting, no plan yet" });
  });

  it("a to-write topic with no waiting items isn't planned", () => {
    const p = go({ rows: [row("a", "to-write")] });
    expect(p.action).toBe("none");
    expect(whyOf(p, "a")).toBe("nothing waiting to plan");
  });

  it("an After topic not done, or an open question, stops a plan", () => {
    expect(
      whyOf(
        go({
          rows: [row("b", "planned", { after: ["z"] }), row("a", "to-write", { waiting: 1, after: ["b"] })],
        }),
        "a",
      ),
    ).toBe("waits for b");
    expect(
      whyOf(go({ rows: [row("a", "to-write", { waiting: 1 })], asks: [question("a2", "a")] }), "a"),
    ).toBe("has an open question (a2)");
  });

  it("one planner at a time; a second only when the first's topic has an open question", () => {
    const rows = [row("p", "to-write", { waiting: 1 }), row("a", "to-write", { waiting: 2 })];
    const facts = { rows, worktrees: [planWt("p")], sessions: [session("plan-p")] };
    const p = go(facts);
    expect(p.action).toBe("none");
    expect(whyOf(p, "p")).toBe("being planned");
    expect(whyOf(p, "a")).toBe("a planner is running (plan-p)");

    const waiting = go({ ...facts, asks: [question("a1", "p", { session: "plan-p" })] });
    expect(waiting).toMatchObject({ action: "plan", topic: "a" });

    // Never a third, even when both wait on questions.
    const third = go({
      rows: [...rows, row("c", "to-write", { waiting: 1 })],
      worktrees: [planWt("p"), planWt("a")],
      sessions: [session("plan-p"), session("plan-a")],
      asks: [question("a1", "p"), question("a2", "a")],
    });
    expect(third.action).toBe("none");
    expect(whyOf(third, "c")).toBe("a planner is running (plan-p, plan-a)");
  });

  it("the planner cap is a setting", () => {
    const rows = [row("p", "to-write", { waiting: 1 }), row("a", "to-write", { waiting: 2 })];
    expect(
      go({ rows, worktrees: [planWt("p")], sessions: [session("plan-p")], caps: { planners: 2 } }).topic,
    ).toBe("a");
  });
});

describe("rule 6: the lookahead (lane cap + 1)", () => {
  // Two lanes full, so no planned topic may start: only the plan is in question.
  const full = (planned, extra = {}) => ({
    rows: [
      row("x", "running"),
      row("y", "running"),
      ...planned.map((t) => row(t, "planned")),
      row("w", "to-write", { waiting: 2 }),
    ],
    ...runningFacts(["x", "y"]),
    caps: { prds: 2 },
    ...extra,
  });

  it("cap 2 with 3 planned topics waiting plans nothing, and says why", () => {
    const p = go(full(["a", "b", "c"]));
    expect(p.action).toBe("none");
    expect(whyOf(p, "w")).toBe(
      "the lookahead is full: 3 planned waiting, lane cap 2 + 1 (plan it by hand: pnpm prd plan)",
    );
  });

  it("cap 2 with 2 planned topics waiting plans one", () => {
    expect(go(full(["a", "b"]))).toMatchObject({ action: "plan", topic: "w" });
  });

  it("a running planner counts toward the lookahead", () => {
    const facts = full(["a", "b"], {
      worktrees: [prdWt("x"), prdWt("y"), planWt("p")],
      sessions: [session("prd-x"), session("prd-y"), session("plan-p")],
      asks: [question("q1", "p", { session: "plan-p" })],
    });
    facts.rows.push(row("p", "to-write", { waiting: 1 }));
    const p = go(facts);
    expect(p.action).toBe("none");
    expect(whyOf(p, "w")).toBe(
      "the lookahead is full: 2 planned waiting and 1 being planned, lane cap 2 + 1 (plan it by hand: pnpm prd plan)",
    );
  });

  it("standing and held topics don't fill it", () => {
    const facts = full(["a", "b"]);
    facts.rows.push(
      row("fixes-ui", "planned", { flags: ["standing"], waiting: 5, hot: ["x"] }),
      row("h", "hold", { flags: ["hold"] }),
    );
    expect(go(facts)).toMatchObject({ action: "plan", topic: "w" });
  });

  it("a held topic is never planned, even with items waiting and room ahead (already so: its state is hold)", () => {
    const p = go({ rows: [row("h", "hold", { flags: ["hold"], waiting: 4 })] });
    expect(p.action).toBe("none");
    expect(whyOf(p, "h")).toBe("on hold");
  });
});

describe("rule 7: ordering", () => {
  it("a start beats a plan, even when the plan's row comes first", () => {
    const p = go({ rows: [row("a", "to-write", { waiting: 4 }), row("b", "planned")] });
    expect(p).toMatchObject({ action: "start", topic: "b" });
    expect(whyOf(p, "a")).toBe("waits a tick: b starts first");
  });

  it("row order within starts and within plans", () => {
    const starts = go({ rows: [row("a", "planned"), row("b", "planned")] });
    expect(starts.topic).toBe("a");
    expect(whyOf(starts, "b")).toBe("waits a tick: a starts first");
    const plans = go({ rows: [row("a", "to-write", { waiting: 1 }), row("b", "to-write", { waiting: 9 })] });
    expect(plans.topic).toBe("a");
    expect(whyOf(plans, "b")).toBe("waits a tick: a is planned first");
  });

  it("reopens come first in row order, not worktree order", () => {
    const p = go({
      rows: [row("a", "running"), row("b", "running")],
      worktrees: [prdWt("b"), prdWt("a")],
      sessions: [session("prd-a", { live: false }), session("prd-b", { live: false })],
    });
    expect(p.session).toBe("prd-a");
    expect(whyOf(p, "b")).toBe("its orchestrator died");
  });
});

describe("nothing to do, and the reasons", () => {
  it("nothing to do", () => {
    const p = go({ rows: [row("a", "done"), row("b", "running")], ...runningFacts(["b"]) });
    expect(p).toMatchObject({ action: "none", why: "nothing to do" });
    expect(p.reasons).toEqual([{ topic: "b", why: "running" }]);
  });

  it("every passed-over topic has a reason a person can read", () => {
    const rows = [
      row("planner-2", "running"),
      row("check-speed", "running", { hot: ["scripts/loops/prompt.sh"] }),
      row("hand", "running"),
      row("a", "planned", { after: ["planner-2"] }),
      row("b", "planned", { hot: ["scripts/loops/"] }),
      row("c", "hold"),
      row("d", "to-write", { waiting: 1 }),
      row("e", "idle", { flags: ["standing"] }),
    ];
    const facts = {
      rows,
      worktrees: [prdWt("planner-2"), prdWt("check-speed"), prdWt("hand")],
      sessions: [session("prd-planner-2"), session("prd-check-speed")],
      caps: { prds: 4 },
    };
    const p = go(facts);
    expect(p).toMatchObject({ action: "plan", topic: "d" });
    expect(p.reasons).toEqual([
      { topic: "planner-2", why: "running" },
      { topic: "check-speed", why: "running" },
      { topic: "hand", why: "opened by hand, its orchestrator isn't live (left alone)" },
      { topic: "a", why: "waits for planner-2" },
      { topic: "b", why: "shares scripts/loops/prompt.sh with check-speed" },
      { topic: "c", why: "on hold" },
      { topic: "e", why: "no waiting items" },
    ]);

    const busy = go({ ...facts, busy: true });
    expect(whyOf(busy, "d")).toBe("the machine is busy");

    expect(formatPick(p)).toEqual([
      "plan d: 1 waiting, no plan yet",
      "  planner-2: running",
      "  check-speed: running",
      "  hand: opened by hand, its orchestrator isn't live (left alone)",
      "  a: waits for planner-2",
      "  b: shares scripts/loops/prompt.sh with check-speed",
      "  c: on hold",
      "  e: no waiting items",
    ]);
    expect(formatPick(busy)[0]).toBe("nothing: the machine is busy");
  });

  it("a worktree with no registry row is still reported", () => {
    const p = go({ rows: [], worktrees: [prdWt("ghost")] });
    expect(p.reasons).toEqual([
      { topic: "ghost", why: "opened by hand, its orchestrator isn't live (left alone) (no registry row)" },
    ]);
  });
});

describe("the keep-alive's question", () => {
  const keepAsk = (id, topic) => question(id, topic, { session: KEEP_SESSION });

  it("is never read as the topic's reopen question: the reopen ask is still filed", () => {
    const p = go({
      rows: [row("a", "running")],
      worktrees: [prdWt("a")],
      sessions: [session("prd-a", { live: false })],
      reopens: { "prd-a": MAX_REOPENS },
      asks: [keepAsk("a1", "a")],
    });
    expect(p).toMatchObject({ action: "ask", session: "prd-a", options: REOPEN_OPTIONS });
  });

  it("with a reopen question open too, the reopen one alone holds the topic", () => {
    const p = go({
      rows: [row("a", "running")],
      worktrees: [prdWt("a")],
      sessions: [session("prd-a", { live: false })],
      reopens: { "prd-a": MAX_REOPENS },
      asks: [keepAsk("a1", "a"), question("a2", "a", { session: DISPATCH_SESSION })],
    });
    expect(p.action).toBe("none");
    expect(whyOf(p, "a")).toContain("waits on ask a2");
  });

  it("doesn't stop a start, and a backlog session takes no slot", () => {
    const p = go({
      rows: [row("a", "planned")],
      sessions: [session("backlog"), session("backlog-notes")],
      asks: [keepAsk("a1", "a")],
      caps: { prds: 1 },
    });
    expect(p).toMatchObject({ action: "start", topic: "a" });
  });
});

// B-431: planner-3 landed with its row still planned and was started nine times.
describe("rule 8: a landed topic is never started or reopened", () => {
  const landed = { a: { sha: "8c1fa06aabbccdd" } };

  it("skips a planned topic whose last landing is in dev with no slice left, and starts the next", () => {
    const p = go({ rows: [row("a", "planned"), row("b", "planned")], landed });
    expect(p).toMatchObject({ action: "start", topic: "b" });
    expect(whyOf(p, "a")).toBe(
      "landed in dev as 8c1fa06 with no slice left: never started again (mark it done: pnpm backlog prd set a flags=done)",
    );
    expect(go({ rows: [row("a", "planned")], landed }).action).toBe("none");
  });

  it("never reopens its worktree's dead orchestrator, and says how to finish it", () => {
    const p = go({
      rows: [row("a", "planned")],
      worktrees: [prdWt("a")],
      sessions: [session("prd-a", { live: false })],
      landed,
    });
    expect(p.action).toBe("none");
    expect(whyOf(p, "a")).toBe(
      "landed in dev as 8c1fa06 with no slice left: not reopened (pnpm prd rm a marks it done)",
    );
  });

  it("leaves a live orchestrator be: it is finishing the topic", () => {
    const p = go({ rows: [row("a", "running")], ...runningFacts(["a"]), landed });
    expect(whyOf(p, "a")).toBe("running");
  });

  it("a standing topic stays: its next wave starts as before", () => {
    const p = go({
      rows: [row("fixes-a", "planned", { flags: ["standing"], waiting: 3 })],
      landed: { "fixes-a": landed.a },
    });
    expect(p).toMatchObject({ action: "start", topic: "fixes-a" });
  });

  it("doesn't fill the lookahead", () => {
    const p = go({
      rows: [row("a", "planned"), row("w", "to-write", { waiting: 2 })],
      caps: { prds: 0 },
      landed,
    });
    expect(p).toMatchObject({ action: "plan", topic: "w" });
  });
});
