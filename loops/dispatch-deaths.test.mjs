// The dispatcher's deaths and the reopen ask, its defaults on silence, and the
// pickup: dispatch.mjs on dispatch-fixture.mjs's throwaway repo.
import { execFileSync, spawn } from "node:child_process";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAsk, getAsk } from "./asks.mjs";
import { HELPER_SESSION, REOPEN_RESET_MS } from "./dispatch.mjs";
import {
  git,
  main,
  loops,
  sessions,
  asks,
  env,
  scripts,
  calls,
  openCalls,
  ok,
  dstate,
  logText,
  setRows,
  setClock,
  T0,
  deadRecord,
  worktree,
  answer,
  askFile,
  useDispatchRepo,
} from "./dispatch-fixture.mjs";

useDispatchRepo();

const updateReopens = (reopens) => {
  const s = dstate();
  writeFileSync(join(loops, ".dispatch.json"), JSON.stringify({ ...s, reopens }));
};

describe("deaths and the reopen ask", () => {
  const dying = () => {
    worktree("a", "prd/a");
    deadRecord("prd-a");
    setRows([{ topic: "a", state: "running" }]);
  };

  it("the third death files one ask and pushes it, with no fourth reopen; each answer is acted on", () => {
    dying();
    ok();
    ok();
    expect(openCalls()).toEqual([
      ["a", "--background"],
      ["a", "--background"],
    ]);
    const out = ok();
    expect(out).toContain("ask prd-a: prd-a died again after 2 reopens");
    expect(out).toContain("filed ask a1");
    const ask = askFile("a1");
    expect(ask).toMatchObject({ kind: "question", topic: "a", session: "dispatch" });
    expect(ask.options).toEqual(["reopen again", "hold the topic"]);
    const helper = openCalls()[2];
    expect(helper.slice(2)).toEqual(["--title", HELPER_SESSION, "--background"]);
    expect(helper[1]).toContain(`${env.RISA_CLAUDE_BIN} --model haiku --remote-control dispatch-push`);
    expect(helper[1]).toContain("a: prd-a (a) died again after 2 reopens");
    expect(dstate().asked).toEqual({ "prd-a": { id: "a1", topic: "a" } });
    // While it's open: no fourth reopen and no second ask.
    expect(ok()).toContain("a: its orchestrator died after 2 reopens; waits on ask a1");
    expect(openCalls()).toHaveLength(3);
    expect(readdirSync(asks).filter((f) => f.endsWith(".json"))).toEqual(["a1.json"]);

    // "reopen again": the count resets, and it reopens on that tick.
    answer("a1", "1");
    const again = ok();
    expect(again).toContain('ask a1 answered "reopen again": prd-a may be reopened again');
    expect(again).toContain("reopen prd-a: prd-a died (reopen 1 of 2)");
    expect(dstate()).toMatchObject({ reopens: { "prd-a": 1 }, asked: {} });

    // Two more deaths, a new ask; "hold the topic" flags the row and nothing reopens.
    ok();
    expect(ok()).toContain("filed ask a2");
    answer("a2", "hold the topic");
    const held = ok();
    expect(held).toContain('ask a2 answered "hold the topic": a flagged hold');
    expect(calls("backlog")).toEqual(["prd set a flags+=hold"]);
    expect(held).toContain("a: on hold; its orchestrator isn't live (not reopened)");
    expect(openCalls()).toHaveLength(6);
    expect(ok()).not.toContain("filed ask");
  });

  it("a helper that can't start changes nothing", () => {
    dying();
    ok();
    ok();
    const out = ok(["--once"], { STUB_OPEN_FAIL: HELPER_SESSION });
    expect(out).toContain("filed ask a1");
    expect(out).toContain(`${HELPER_SESSION} didn't start (ignored)`);
    expect(dstate().asked).toEqual({ "prd-a": { id: "a1", topic: "a" } });
    expect(ok()).toContain("waits on ask a1");
  });

  it("forgets the count once the session has stayed live, or its worktree is gone", async () => {
    worktree("a", "prd/a");
    setRows([{ topic: "a", state: "running" }]);
    deadRecord("prd-a");
    ok();
    expect(dstate().reopens).toEqual({ "prd-a": 1 });
    // A live session (a sleep standing in) started over REOPEN_RESET_MS ago by the clock.
    const live = spawn("sleep", ["30"]);
    try {
      writeFileSync(
        join(sessions, "prd-a.json"),
        JSON.stringify({ pid: live.pid, started: new Date().toISOString(), managed: true }),
      );
      setClock(Math.ceil((Date.now() + REOPEN_RESET_MS) / 1000));
      ok();
      expect(dstate().reopens).toEqual({});
    } finally {
      live.kill();
    }
    // Its worktree gone, a count is stale.
    git(main, "worktree", "remove", "--force", join(loops, "a"));
    updateReopens({ "prd-a": 1, "prd-gone": 2 });
    ok();
    expect(dstate().reopens).toEqual({});
  });

  it("a failed hold write keeps the answer and the count, skips the topic, and is retried next tick", () => {
    dying();
    ok();
    ok();
    expect(ok()).toContain("filed ask a1");
    answer("a1", "hold the topic");
    const failed = ok(["--once"], { STUB_BACKLOG_FAIL: "1" });
    expect(failed).toContain(
      'ask a1 answered "hold the topic", but flagging a hold failed (retried next tick)',
    );
    expect(failed).toContain("registry locked");
    expect(failed).toContain("a: its orchestrator died after 2 reopens; waits on ask a1");
    expect(failed).not.toContain("filed ask");
    expect(dstate()).toMatchObject({ reopens: { "prd-a": 2 }, asked: { "prd-a": { id: "a1", topic: "a" } } });
    // Two reopens and the helper's tab: nothing opened on the failed tick.
    expect(openCalls()).toHaveLength(3);

    const held = ok();
    expect(held).toContain('ask a1 answered "hold the topic": a flagged hold');
    expect(calls("backlog")).toEqual(["prd set a flags+=hold", "prd set a flags+=hold"]);
    expect(held).toContain("a: on hold; its orchestrator isn't live (not reopened)");
    expect(dstate()).toMatchObject({ reopens: {}, asked: {} });
    expect(openCalls()).toHaveLength(3);
  });
});

describe("defaults on silence", () => {
  const defaulting = (topic, session) =>
    createAsk(asks, {
      kind: "question",
      topic,
      session,
      text: "Land now?",
      options: ["yes", "no"],
      recommended: "yes",
      defaults: true,
      now: T0 * 1000,
    });

  it("a tick settles a due ask of a dead session, and its reopened session finds the answer", () => {
    worktree("a", "prd/a");
    deadRecord("prd-a");
    setRows([{ topic: "a", state: "running" }]);
    defaulting("a", "prd-a");
    setClock(T0 + 60);
    expect(ok()).not.toContain("defaulted");
    expect(getAsk(asks, "a1").answeredAt).toBe(null);
    setClock(T0 + 31 * 60);
    expect(ok()).toContain('ask a1 (a) defaulted to "yes": no answer came');
    expect(getAsk(asks, "a1")).toMatchObject({ answer: "yes", defaulted: true });
    const waited = execFileSync("node", [scripts("ask.mjs"), "ask", "--wait", "a1"], {
      env: { ...env, RISA_ASKS_DIR: asks },
      encoding: "utf8",
    });
    expect(waited.split("\n")[0]).toBe("yes");
    expect(waited).toContain("(defaulted: no answer in 30m");
  });

  it("a topic whose only ask was defaulted is started on the same tick; a dry run settles nothing", () => {
    setRows([{ topic: "b", state: "planned" }]);
    defaulting("b", "plan-b");
    setClock(T0 + 31 * 60);
    const dry = ok(["--dry-run"]);
    expect(dry).toContain("has an open question (a1)");
    expect(getAsk(asks, "a1").answeredAt).toBe(null);
    const out = ok();
    expect(out).toContain('ask a1 (b) defaulted to "yes"');
    expect(out).toContain("start b");
  });

  it("files its own reopen question as waiting: it never settles", () => {
    worktree("a", "prd/a");
    deadRecord("prd-a");
    setRows([{ topic: "a", state: "running" }]);
    ok();
    ok();
    expect(ok()).toContain("filed ask a1");
    expect(askFile("a1")).toMatchObject({ defaults: false, defaultAt: null });
    setClock(T0 + 24 * 3600);
    expect(ok()).toContain("waits on ask a1");
    expect(askFile("a1").answeredAt).toBe(null);
  });
});

describe("the pickup", () => {
  const every = { RISA_PICKUP_EVERY: "300" };
  const pickups = () => calls("prd");

  it("runs dev-sync once a period, not every tick, and says nothing when there was nothing", () => {
    expect(ok(["--once"], every)).not.toContain("pickup");
    expect(pickups()).toEqual(["dev-sync the dispatcher's pickup"]);
    setClock(T0 + 60);
    ok(["--once"], every);
    setClock(T0 + 299);
    ok(["--once"], every);
    expect(pickups()).toHaveLength(1);
    setClock(T0 + 300);
    expect(ok(["--once"], { ...every, STUB_PICKUP: "moved" })).toContain(
      "pickup: dev-sync: fast-forwarded dev to abc1234",
    );
    expect(pickups()).toHaveLength(2);
    expect(dstate().lastPickup).toBe((T0 + 300) * 1000);
  });

  it("a refused pickup logs one line and the tick still picks", () => {
    setRows([{ topic: "a", state: "planned" }]);
    const out = ok(["--once"], { ...every, STUB_PICKUP: "refused" });
    expect(out).toContain(
      "pickup: failed (exit 1): dev-sync: the main checkout is in the middle of a merge, rebase or cherry-pick (MERGE_HEAD)",
    );
    expect(out.match(/pickup/g)).toHaveLength(1);
    expect(out).toContain("start a:");
    expect(calls("new")).toEqual(["prd a"]);
    expect(logText()).toContain("pickup: failed (exit 1)");
    // Not retried on the next tick: once a period, failed or not.
    setClock(T0 + 60);
    ok(["--once"], { ...every, STUB_PICKUP: "refused" });
    expect(pickups()).toHaveLength(1);
  });

  it("runs by default, never paused, off or in a dry run", () => {
    ok(["--once"], { RISA_PICKUP_EVERY: "" });
    expect(pickups()).toHaveLength(1);
    rmSync(join(loops, ".dispatch.json"), { force: true });
    ok(["--pause", "t"]);
    ok(["--once"], every);
    ok(["--resume"]);
    ok(["--once"]);
    expect(pickups()).toHaveLength(1);
    expect(ok(["--dry-run"], every)).toContain("pickup: would run pnpm prd dev-sync");
    expect(pickups()).toHaveLength(1);
    expect(dstate().lastPickup).toBeUndefined();
  });
});
