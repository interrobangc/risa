// The keep-alive's decision (keep-alive.mjs). Pure: facts in, one decision per kind out.
import { describe, expect, it } from "vitest";
import { ROTATING_GRACE_MS } from "./dispatch-pick.mjs";
import {
  KEEP_OPTIONS,
  KEPT_KINDS,
  MAX_QUICK_DEATHS,
  QUICK_DEATH_MS,
  START_GRACE_MS,
  clearKeepStops,
  hasRemoteControl,
  keepAliveDecision,
  keepAnswerAction,
} from "./keep-alive.mjs";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const decide = (facts = {}) => keepAliveDecision({ processes: [], now: NOW, ...facts });
const one = (facts) => decide(facts)[0];

describe("keepAliveDecision", () => {
  it("opens when nothing is live and it isn't paused", () => {
    expect(one()).toMatchObject({ kind: "backlog", action: "open", deaths: 0 });
  });

  it("gives nothing for a live recorded session", () => {
    expect(one({ sessions: [{ name: "backlog", live: true }] })).toMatchObject({
      action: "none",
      why: "live",
    });
  });

  it("gives nothing for a rotating record inside the grace, and opens once it has passed", () => {
    const rotating = (ago) => ({
      sessions: [{ name: "backlog", live: false, rotating: true, rotatingAt: NOW - ago }],
    });
    expect(one(rotating(ROTATING_GRACE_MS - 1)).action).toBe("none");
    expect(one(rotating(ROTATING_GRACE_MS)).action).toBe("open");
  });

  it("gives nothing for an unrecorded --remote-control backlog process", () => {
    const processes = ["claude --model opus --remote-control backlog You are the new backlog agent."];
    expect(one({ processes })).toMatchObject({ action: "none", why: "live, opened by hand" });
  });

  it("opens nothing when the process list can't be read", () => {
    expect(one({ processes: null }).action).toBe("none");
  });

  it("gives nothing while paused or switched off", () => {
    expect(one({ paused: true }).action).toBe("none");
    expect(one({ off: true }).action).toBe("none");
  });

  it("waits out the start grace after an open", () => {
    const keep = (ago) => ({ backlog: { deaths: 0, openedAt: NOW - ago } });
    expect(one({ keep: keep(START_GRACE_MS - 1) })).toMatchObject({ action: "none", why: "just opened" });
    expect(one({ keep: keep(START_GRACE_MS) })).toMatchObject({ action: "open", deaths: 1 });
  });

  it("gives the question at the third quick death, not a fourth open", () => {
    const d = one({ keep: { backlog: { deaths: MAX_QUICK_DEATHS - 1, openedAt: NOW - START_GRACE_MS } } });
    expect(d).toMatchObject({ action: "ask", deaths: MAX_QUICK_DEATHS, options: KEEP_OPTIONS });
  });

  it("a death after the quick window starts the count again", () => {
    const d = one({ keep: { backlog: { deaths: 2, openedAt: NOW - QUICK_DEATH_MS } } });
    expect(d).toMatchObject({ action: "open", deaths: 0 });
  });

  it("a session that outlives the quick window clears the count", () => {
    const keep = { backlog: { deaths: 2, openedAt: NOW - QUICK_DEATH_MS } };
    expect(one({ keep, sessions: [{ name: "backlog", live: true }] }).reset).toBe(true);
    const young = { backlog: { deaths: 2, openedAt: NOW - 60_000 } };
    expect(one({ keep: young, sessions: [{ name: "backlog", live: true }] }).reset).toBeUndefined();
  });

  it("gives nothing while its question is open", () => {
    const keep = { backlog: { deaths: 3, openedAt: NOW - QUICK_DEATH_MS * 2, asked: { id: "a7" } } };
    expect(one({ keep })).toMatchObject({ action: "none", why: "waits on ask a7" });
  });

  it("asks again after a dismissed question, however long ago the last open was", () => {
    const keep = { backlog: { deaths: 3, openedAt: NOW - QUICK_DEATH_MS * 2 } };
    expect(one({ keep }).action).toBe("ask");
  });

  it('"stop keeping it alive" gives nothing until the next dispatcher start', () => {
    const keep = { backlog: { stopped: true } };
    expect(one({ keep }).action).toBe("none");
    expect(one({ keep: clearKeepStops(keep) }).action).toBe("open");
  });

  it("the kinds list drives it", () => {
    expect(KEPT_KINDS).toEqual(["backlog"]);
    const ds = decide({
      kinds: ["backlog", "inbox"],
      sessions: [{ name: "backlog", live: true }],
    });
    expect(ds.map((d) => [d.kind, d.action])).toEqual([
      ["backlog", "none"],
      ["inbox", "open"],
    ]);
  });
});

describe("hasRemoteControl", () => {
  it("matches a claude process under exactly that name", () => {
    expect(hasRemoteControl("claude --remote-control backlog hi", "backlog")).toBe(true);
    expect(hasRemoteControl("claude --remote-control=backlog", "backlog")).toBe(true);
    expect(hasRemoteControl("/usr/local/bin/claude --model opus --remote-control backlog", "backlog")).toBe(
      true,
    );
  });

  it("doesn't match a named session, a wrapper or a prompt quoting the flag", () => {
    expect(hasRemoteControl("claude --remote-control backlog-notes hi", "backlog")).toBe(false);
    expect(hasRemoteControl("claude --remote-control backlog - notes hi", "backlog")).toBe(false);
    expect(hasRemoteControl("bash session.sh backlog -- --remote-control backlog", "backlog")).toBe(false);
    expect(hasRemoteControl("claude --remote-control prd-a see `--remote-control backlog`", "backlog")).toBe(
      false,
    );
  });
});

describe("keepAnswerAction", () => {
  it("reads the answers", () => {
    expect(keepAnswerAction("open again")).toBe("open");
    expect(keepAnswerAction("1")).toBe("open");
    expect(keepAnswerAction("stop keeping it alive")).toBe("stop");
    expect(keepAnswerAction("2")).toBe("stop");
    expect(keepAnswerAction("hold the topic")).toBeNull();
    expect(keepAnswerAction(null)).toBeNull();
  });
});
