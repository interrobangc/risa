// The context watch (context.mjs): the size read, the hook's decision, the hook
// as a command and `pnpm prd context`, against temporary folders. All
// transcript text is fictional; no real transcript or session is touched.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { agentTranscript, hardLimitFor, hookDecision, limitOf, sizeFromTranscript } from "./context.mjs";
import { toolCmd } from "./config.mjs";
import { processOf } from "./sessions.mjs";

const CONTEXT = new URL("./context.mjs", import.meta.url).pathname;
// The test sessions' pid: past any pid the OS hands out (macOS 99999, Linux at most
// 2^22), so `--all` never finds a real process behind it.
const PID = 99_999_999;
const MIN = 60_000;
const NOW = Date.parse("2026-11-22T12:00:00Z");

const assistant = (input, read = 0, create = 0, extra = {}) =>
  JSON.stringify({
    type: "assistant",
    message: {
      usage: {
        input_tokens: input,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: create,
        output_tokens: 999,
      },
    },
    ...extra,
  });

describe("sizeFromTranscript", () => {
  it("sums input, cache read and cache creation of the last assistant usage", () => {
    const text = [assistant(1, 2, 3), JSON.stringify({ type: "user" }), assistant(10, 20_000, 300)].join(
      "\n",
    );
    expect(sizeFromTranscript(text)).toBe(20_310);
  });

  it("gives no size for an empty transcript or lines without usage", () => {
    expect(sizeFromTranscript("")).toBeNull();
    expect(
      sizeFromTranscript(`${JSON.stringify({ type: "user", usage: 1 })}\n{"type":"assistant"}`),
    ).toBeNull();
  });

  it("skips a half-written last line, and gives none when it is the only one", () => {
    const half = '{"type":"assistant","message":{"usage":{"input_tokens":7';
    expect(sizeFromTranscript(`${assistant(5)}\n${half}`)).toBe(5);
    expect(sizeFromTranscript(half)).toBeNull();
  });

  it("skips a client-made all-zero usage, and subagent lines unless reading an agent", () => {
    expect(sizeFromTranscript(`${assistant(5)}\n${assistant(0)}`)).toBe(5);
    const side = assistant(9, 0, 0, { isSidechain: true });
    expect(sizeFromTranscript(`${assistant(5)}\n${side}`)).toBe(5);
    expect(sizeFromTranscript(side, { agent: true })).toBe(9);
  });
});

describe("agentTranscript", () => {
  it("finds the agent's own file beside the session's transcript", () => {
    expect(agentTranscript({ agent_id: "abc", transcript_path: "/p/s1.jsonl" })).toBe(
      "/p/s1/subagents/agent-abc.jsonl",
    );
    expect(agentTranscript({ agent_id: "agent-abc", transcript_path: "/p/s1.jsonl" })).toBe(
      "/p/s1/subagents/agent-abc.jsonl",
    );
    expect(agentTranscript({ agent_id: "abc", transcript_path: "/p/s1/subagents/agent-abc.jsonl" })).toBe(
      "/p/s1/subagents/agent-abc.jsonl",
    );
    expect(agentTranscript({ agent_id: "abc", agent_transcript_path: "/x/a.jsonl" })).toBe("/x/a.jsonl");
    expect(agentTranscript({ agent_id: "../up", transcript_path: "/p/s1.jsonl" })).toBeNull();
  });
});

describe("hookDecision", () => {
  const facts = { pid: PID, now: NOW, limit: 160_000, remindMs: 10 * MIN };
  const iso = (t) => new Date(t).toISOString();

  it("is silent under the soft limit, and clears the watch once back under it", () => {
    const d = hookDecision(
      {
        pid: PID,
        firstOverAt: iso(NOW),
        remindedAt: iso(NOW),
        remindedSize: 170_000,
        hardOverAt: iso(NOW),
        nudgeAt: iso(NOW),
      },
      { ...facts, size: 160_000 },
    );
    expect(d.message).toBeNull();
    expect(d.record).toEqual({ pid: PID, size: 160_000, readAt: iso(NOW) });
  });

  it("tells an orchestrator to rotate at the next wave boundary past soft, then only every further 25k, whatever the time", () => {
    const first = hookDecision(null, { ...facts, size: 170_000 });
    expect(first.message).toContain("170k");
    expect(first.message).toContain("soft limit of 160k");
    expect(first.message).toContain("hard limit is 225k");
    expect(first.message).toContain("Rotate unasked between waves only: at the next wave boundary");
    expect(first.message).toContain("write _Status_ as the brief");
    expect(first.message).toContain("run `pnpm prd rotate`, without asking");
    expect(first.message).toContain("Not mid-wave");
    expect(first.message).not.toContain('--mid-wave --reason "context"');
    expect(first.message).not.toContain("Judge");
    expect(first.record.hardOverAt).toBeUndefined();
    const quiet = hookDecision(first.record, { ...facts, size: 194_999, now: NOW + 60 * MIN });
    expect(quiet.message).toBeNull();
    expect(quiet.record.firstOverAt).toBe(iso(NOW));
    expect(hookDecision(quiet.record, { ...facts, size: 195_000 }).message).toContain("195k");
  });

  it("tells an orchestrator to rotate past hard at the crossing, then only after the repeat time", () => {
    const soft = hookDecision(null, { ...facts, size: 220_000 });
    const first = hookDecision(soft.record, { ...facts, size: 226_000, now: NOW + MIN });
    expect(first.message).toContain("past the hard limit of 225k");
    expect(first.message).toContain('pnpm prd rotate --mid-wave --reason "context"');
    expect(first.message).toContain('pnpm prd context --keep "<why>"');
    expect(first.message).not.toContain("Judge");
    expect(first.record.hardOverAt).toBe(iso(NOW + MIN));
    const soon = hookDecision(first.record, { ...facts, size: 260_000, now: NOW + 10 * MIN });
    expect(soon.message).toBeNull();
    const later = hookDecision(soon.record, { ...facts, size: 261_000, now: NOW + 11 * MIN });
    expect(later.message).toContain("261k");
    expect(later.record.hardOverAt).toBe(iso(NOW + MIN));
  });

  it("takes the hard limit it is given, never below the soft one", () => {
    expect(hookDecision(null, { ...facts, size: 205_000, hard: 200_000 }).message).toContain(
      "hard limit of 200k",
    );
    const below = hookDecision(null, { ...facts, size: 170_000, hard: 100_000 });
    expect(below.message).toContain("hard limit of 100k");
    expect(hookDecision(null, { ...facts, size: 150_000, hard: 100_000 }).message).toBeNull();
  });

  it("drops the hard watch and any nudge once back between the limits", () => {
    const hard = { pid: PID, firstOverAt: iso(NOW), hardOverAt: iso(NOW), nudgeAt: iso(NOW) };
    const d = hookDecision(hard, { ...facts, size: 200_000 });
    expect(d.record.hardOverAt).toBeUndefined();
    expect(d.record.nudgeAt).toBeUndefined();
    expect(d.message).toContain("soft limit");
  });

  it("delivers a waiting nudge once and marks it", () => {
    const waiting = {
      pid: PID,
      firstOverAt: iso(NOW - MIN),
      hardOverAt: iso(NOW - MIN),
      remindedAt: iso(NOW - MIN),
      nudgeAt: iso(NOW),
    };
    const d = hookDecision(waiting, { ...facts, size: 240_000 });
    expect(d.message).toContain("second notice");
    expect(d.message).toContain("hard limit of 225k");
    expect(d.record.nudgeDeliveredAt).toBe(iso(NOW));
    expect(hookDecision(d.record, { ...facts, size: 240_000, now: NOW + MIN }).message).toBeNull();
  });

  it("is silent while kept, and reminds once the keep has expired", () => {
    const kept = { pid: PID, keep: { reason: "landing", until: iso(NOW + MIN) }, nudgeAt: iso(NOW) };
    const d = hookDecision(kept, { ...facts, size: 240_000 });
    expect(d.message).toBeNull();
    expect(d.record.nudgeDeliveredAt).toBeUndefined();
    const after = hookDecision(d.record, { ...facts, size: 240_000, now: NOW + 2 * MIN });
    expect(after.message).toContain("second notice");
    expect(after.record.keep).toBeUndefined();
  });

  it("starts clean for a new session under the name, and gives a loop its own words", () => {
    const old = { pid: 1, remindedAt: iso(NOW), keep: { reason: "x", until: iso(NOW + MIN) } };
    expect(hookDecision(old, { ...facts, size: 170_000 }).message).toContain("this session");
    const loop = hookDecision(null, { ...facts, size: 180_000, loop: true });
    expect(loop.message).toContain("this agent");
    expect(loop.message).toContain("fresh `--continue` agent");
  });

  describe("a subagent's soft and hard limits", () => {
    const loop = (current, size, extra = {}) =>
      hookDecision(current, { ...facts, size, loop: true, ...extra });

    it("ignores the session limit, and is silent up to the soft limit", () => {
      expect(loop(null, 175_000).message).toBeNull();
      expect(loop(null, 100_000, { limit: 1000 }).message).toBeNull();
    });

    it("asks it to judge past soft, then only every further 25k, whatever the time", () => {
      const first = loop(null, 180_000);
      expect(first.message).toContain("soft limit of 175k");
      expect(first.message).toContain("Say which you chose");
      expect(first.message).toContain("commit any changes you were asked to make");
      const quiet = loop(first.record, 204_999, { now: NOW + 60 * MIN });
      expect(quiet.message).toBeNull();
      expect(loop(quiet.record, 205_000).message).toContain("205k");
    });

    it("says hand off past hard on every call, even straight from under soft or with a keep", () => {
      const first = loop({ pid: PID, size: 170_000 }, 310_000);
      expect(first.message).toContain("hard limit of 300k");
      expect(first.message).toContain("start no check");
      expect(first.message).toContain("any unfinished fix");
      expect(loop(first.record, 310_001).message).toContain("Hand off now");
      const kept = { ...first.record, keep: { reason: "x", until: iso(NOW + MIN) } };
      expect(loop(kept, 310_002).message).toContain("Hand off now");
    });

    it("lowers the mark on a shrink between the limits, and clears it under soft", () => {
      const high = loop(null, 274_000);
      const lower = loop(high.record, 200_000);
      expect(lower.message).toBeNull();
      expect(lower.record.remindedSize).toBe(200_000);
      expect(loop(lower.record, 225_000).message).toContain("225k");
      const under = loop(high.record, 95_000);
      expect(under.record.remindedSize).toBeUndefined();
      expect(loop(under.record, 180_000).message).toContain("soft limit");
    });

    it("handles a record from the old hook: no size mark, and no time throttle", () => {
      const old = { pid: PID, firstOverAt: iso(NOW), remindedAt: iso(NOW) };
      expect(loop(old, 180_000).message).toContain("soft limit");
      expect(loop(old, 310_000).message).toContain("hard limit");
    });
  });

  describe("a backlog session's soft limit", () => {
    const backlog = (current, size, extra = {}) =>
      hookDecision(current, { ...facts, size, backlog: true, ...extra });

    it("asks it to tell the user and let them choose, never to hand off unasked", () => {
      const first = backlog(null, 170_000);
      expect(first.message).toContain("170k");
      expect(first.message).toContain("soft limit of 160k");
      expect(first.message).toContain("never hand off on your own");
      expect(first.message).toContain("tell them the size and ask whether to hand off or keep going");
      expect(first.message).toContain("if they don't answer, keep going");
      expect(first.message).toContain("never in the middle of a question");
      expect(first.message).toContain("Only on their word to hand off");
      expect(first.message).toContain("pnpm prd rotate --self --brief <that file>");
      expect(first.message).not.toContain("without asking");
      expect(first.message).not.toContain("--mid-wave");
      expect(first.message).not.toContain("hard limit");
    });

    it("repeats only every further 25k, and never turns into a hand-off past the orchestrator's hard limit", () => {
      const first = backlog(null, 170_000);
      expect(backlog(first.record, 194_999, { now: NOW + 60 * MIN }).message).toBeNull();
      const far = backlog(first.record, 400_000);
      expect(far.message).toContain("ask whether to hand off or keep going");
      expect(far.message).not.toContain("without asking");
      expect(far.record.hardOverAt).toBe(iso(NOW));
    });

    it("gets a nudge that still leaves the choice to the user", () => {
      const waiting = { ...backlog(null, 240_000).record, nudgeAt: iso(NOW) };
      const nudge = backlog(waiting, 245_000);
      expect(nudge.message).toContain("second notice");
      expect(nudge.message).toContain("Never hand off on your own");
      expect(nudge.message).toContain("if they don't answer, keep going");
      expect(nudge.message).toContain("leaves the session running");
      expect(nudge.message).not.toContain("rotated if they don't answer");
      expect(nudge.message).not.toContain("--mid-wave");
    });
  });

  describe("a planner's limits", () => {
    const planner = (current, size, extra = {}) =>
      hookDecision(current, { ...facts, size, limit: 160_000, plan: { topic: "t" }, ...extra });

    it("tells it to head for landing past soft, then only every further 25k, never an orchestrator's rotate", () => {
      expect(planner(null, 150_000).message).toBeNull();
      const first = planner(null, 170_000);
      expect(first.message).toContain("planning session is at 170k");
      expect(first.message).toContain("past the soft limit of 160k");
      expect(first.message).toContain("Head for landing");
      expect(first.message).toContain("_Hand-over_");
      expect(first.message).not.toContain("rotate");
      expect(first.message).not.toContain("wave");
      expect(planner(first.record, 194_999, { now: NOW + 60 * MIN }).message).toBeNull();
      expect(planner(first.record, 195_000).message).toContain("195k");
    });

    it("tells it to land or hand over past hard, at the crossing and after the repeat time", () => {
      const first = planner(null, 240_000);
      expect(first.message).toContain("past the hard limit of 225k");
      expect(first.message).toContain("hand over now");
      expect(first.message).toContain(`\`${toolCmd.prd} plan t --open\``);
      expect(first.message).toContain(`\`${toolCmd.prd} end\``);
      expect(first.message).not.toContain("rotate");
      expect(planner(first.record, 241_000, { now: NOW + MIN }).message).toBeNull();
      expect(planner(first.record, 241_000, { now: NOW + 11 * MIN }).message).toContain("hand over now");
    });

    it("has an unattended planner report its hand-over and wait, not end", () => {
      const m = planner(null, 240_000, { plan: { topic: "t", auto: true } }).message;
      expect(m).toContain(`\`${toolCmd.prd} ask --topic t --report`);
      expect(m).toContain("without ending the session");
    });
  });

  it("gives the inbox session its own words: its hand-off command, no brief", () => {
    const inbox = "pnpm -s -C /m prd rotate --self";
    const first = hookDecision(null, { ...facts, size: 170_000, inbox });
    expect(first.message).toContain("170k");
    expect(first.message).toContain("never in the middle of a request");
    expect(first.message).toContain("fresh inbox session takes over");
    expect(first.message).toContain(`\`${inbox}\``);
    expect(first.message).not.toMatch(/--brief|--mid-wave|_Status_/);
    const waiting = { ...first.record, nudgeAt: iso(NOW) };
    const nudge = hookDecision(waiting, { ...facts, size: 180_000, inbox });
    expect(nudge.message).toContain("second notice");
    expect(nudge.message).toContain(`\`${inbox}\``);
    expect(nudge.record.nudgeDeliveredAt).toBe(iso(NOW));
  });

  it("gives the inbox session its rotate reminder past soft and under the orchestrator's hard limit, never a judge one", () => {
    const inbox = "pnpm -s -C /m prd rotate --self";
    const first = hookDecision(null, { ...facts, size: 170_000, hard: 225_000, inbox });
    expect(first.message).toContain("fresh inbox session takes over");
    expect(first.message).toContain("past the 160k limit");
    expect(first.message).not.toMatch(/Judge|soft limit|hard limit/);
    // Its one limit is the dispatcher's too: the follow-up starts at 160k.
    expect(first.record.hardOverAt).toBe(iso(NOW));
    expect(
      hookDecision(first.record, { ...facts, size: 171_000, hard: 225_000, inbox, now: NOW + MIN }).message,
    ).toBeNull();
    const again = hookDecision(first.record, {
      ...facts,
      size: 171_000,
      hard: 225_000,
      inbox,
      now: NOW + 10 * MIN,
    });
    expect(again.message).toContain("fresh inbox session takes over");
    expect(hardLimitFor("inbox", {})).toBe(160_000);
    expect(hardLimitFor("prd", {})).toBe(225_000);
    expect(hardLimitFor("backlog", {})).toBeNull();
  });

  it("gives an orchestrator a 120k soft limit and every other kind 160k: at 125k only the orchestrator hears", () => {
    expect(limitOf({}, "prd")).toBe(120_000);
    for (const kind of ["inbox", "backlog", "plan", undefined]) expect(limitOf({}, kind)).toBe(160_000);
    const at125 = { ...facts, size: 125_000 };
    const orchestrator = hookDecision(null, { ...at125, limit: limitOf({}, "prd") });
    expect(orchestrator.message).toContain("at the next wave boundary");
    expect(orchestrator.message).toContain("Not mid-wave");
    const inbox = hookDecision(null, {
      ...at125,
      limit: limitOf({}, "inbox"),
      inbox: "pnpm -s -C /m prd rotate --self",
    });
    expect(inbox.message).toBeNull();
    expect(hookDecision(null, { ...at125, limit: limitOf({}, "inbox"), loop: true }).message).toBeNull();
    // The hard limit stays 225k for an orchestrator; the inbox session's one limit is its 160k.
    expect(hardLimitFor("prd", {})).toBe(225_000);
  });
});

let root, sessions, context, transcript;
const roots = [];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "context-test-")));
  roots.push(root);
  sessions = join(root, ".sessions");
  context = join(root, ".context");
  transcript = join(root, "s1.jsonl");
  mkdirSync(sessions);
  writeFileSync(
    join(sessions, "prd-t.json"),
    JSON.stringify({ pid: PID, kind: "prd", started: new Date().toISOString() }),
  );
});
afterAll(() => {
  for (const r of roots) {
    if (existsSync(context)) chmodSync(context, 0o755);
    rmSync(r, { recursive: true, force: true });
  }
});

const baseEnv = () => ({
  PATH: process.env.PATH,
  RISA_CONFIG: process.env.RISA_CONFIG,
  RISA_SESSIONS_DIR: sessions,
  RISA_SESSION_NAME: "prd-t",
  RISA_SESSION_PID: String(PID),
});
const hook = (input, extra = {}) =>
  spawnSync("node", [CONTEXT, "hook"], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { ...baseEnv(), ...extra },
  });
const sizeFile = () => JSON.parse(readFileSync(join(context, "prd-t.json"), "utf8"));
const contextOf = (out) => JSON.parse(out).hookSpecificOutput;

describe("the hook as a command", () => {
  it("under the limit prints nothing and writes the size", () => {
    writeFileSync(transcript, assistant(100, 50_000, 0));
    const r = hook({ transcript_path: transcript });
    expect([r.status, r.stdout]).toEqual([0, ""]);
    expect(sizeFile()).toMatchObject({ pid: PID, size: 50_100 });
  });

  it("past hard adds the reminder as context, then stays quiet inside the repeat time", () => {
    writeFileSync(transcript, assistant(1, 240_000));
    const first = hook({ transcript_path: transcript });
    expect(first.status).toBe(0);
    expect(contextOf(first.stdout).hookEventName).toBe("PostToolUse");
    expect(contextOf(first.stdout).additionalContext).toContain("240k");
    expect(hook({ transcript_path: transcript }).stdout).toBe("");
    const again = hook({ transcript_path: transcript }, { RISA_CONTEXT_REMIND_MIN: "0.00001" });
    expect(contextOf(again.stdout).additionalContext).toContain("240k");
  });

  it("takes the soft and hard limits from the environment", () => {
    writeFileSync(transcript, assistant(1, 120_000));
    const env = { RISA_CONTEXT_LIMIT: "100000", RISA_CONTEXT_HARD_LIMIT: "110000" };
    const r = hook({ transcript_path: transcript }, env);
    expect(contextOf(r.stdout).additionalContext).toContain("past the hard limit of 110k");
    writeFileSync(transcript, assistant(1, 105_000));
    expect(contextOf(hook({ transcript_path: transcript }, env).stdout).additionalContext).toContain(
      "soft limit of 100k",
    );
  });

  it("at 125k tells an orchestrator to rotate at the next wave boundary, and leaves its slice agent alone", () => {
    writeFileSync(transcript, assistant(1, 125_000));
    const orchestrator = contextOf(hook({ transcript_path: transcript }).stdout).additionalContext;
    expect(orchestrator).toContain("past the soft limit of 120k");
    expect(orchestrator).toContain("at the next wave boundary");
    expect(orchestrator).toContain("Not mid-wave");
    expect(orchestrator).not.toContain('--mid-wave --reason "context"');
    // A slice agent of that orchestrator: its own transcript, its own 175k limit.
    mkdirSync(join(root, "s1", "subagents"), { recursive: true });
    writeFileSync(
      join(root, "s1", "subagents", "agent-a1.jsonl"),
      assistant(1, 125_000, 0, { isSidechain: true }),
    );
    expect(hook({ transcript_path: transcript, agent_id: "a1" }).stdout).toBe("");
  });

  it("delivers a waiting nudge once and marks it in the record", () => {
    writeFileSync(transcript, assistant(1, 240_000));
    hook({ transcript_path: transcript });
    writeFileSync(
      join(context, "prd-t.json"),
      JSON.stringify({ ...sizeFile(), nudgeAt: new Date().toISOString() }),
    );
    expect(contextOf(hook({ transcript_path: transcript }).stdout).additionalContext).toContain(
      "second notice",
    );
    expect(sizeFile().nudgeDeliveredAt).toBeTruthy();
    expect(hook({ transcript_path: transcript }).stdout).toBe("");
  });

  it("is silent while kept and speaks again once the keep has expired", () => {
    writeFileSync(transcript, assistant(1, 170_000));
    mkdirSync(context);
    const keep = (until) =>
      writeFileSync(
        join(context, "prd-t.json"),
        JSON.stringify({ pid: PID, keep: { reason: "landing", until } }),
      );
    keep(new Date(Date.now() + 10 * MIN).toISOString());
    expect(hook({ transcript_path: transcript }).stdout).toBe("");
    keep(new Date(Date.now() - MIN).toISOString());
    expect(contextOf(hook({ transcript_path: transcript }).stdout).additionalContext).toContain("170k");
  });

  it("gives a subagent's call the loop's words from its own transcript, leaving the session's size", () => {
    writeFileSync(transcript, assistant(1, 40_000));
    hook({ transcript_path: transcript });
    mkdirSync(join(root, "s1", "subagents"), { recursive: true });
    writeFileSync(
      join(root, "s1", "subagents", "agent-a1.jsonl"),
      assistant(1, 180_000, 0, { isSidechain: true }),
    );
    const r = hook({ transcript_path: transcript, agent_id: "a1", agent_type: "general-purpose" });
    expect(contextOf(r.stdout).additionalContext).toContain("this agent is at 180k");
    expect(sizeFile().size).toBe(40_001);
    // Its transcript missing: nothing, and never the session's transcript instead.
    expect(hook({ transcript_path: transcript, agent_id: "a2" }).stdout).toBe("");
    expect(existsSync(join(context, ".agents", "prd-t", "a2.json"))).toBe(false);
  });

  it("gives a backlog session the backlog words, and its subagents nothing", () => {
    writeFileSync(
      join(sessions, "backlog.json"),
      JSON.stringify({ pid: PID, kind: "backlog", started: new Date().toISOString() }),
    );
    const asBacklog = { RISA_SESSION_NAME: "backlog" };
    writeFileSync(transcript, assistant(1, 170_000));
    mkdirSync(join(root, "s1", "subagents"), { recursive: true });
    writeFileSync(
      join(root, "s1", "subagents", "agent-a1.jsonl"),
      assistant(1, 165_000, 0, { isSidechain: true }),
    );
    expect(hook({ transcript_path: transcript, agent_id: "a1" }, asBacklog).stdout).toBe("");
    expect(existsSync(join(context, ".agents", "backlog"))).toBe(false);
    const r = hook({ transcript_path: transcript }, asBacklog);
    expect(contextOf(r.stdout).additionalContext).toContain("ask whether to hand off or keep going");
  });

  it("gives the inbox session its hand-off by the main checkout's path, and its subagents nothing", () => {
    writeFileSync(
      join(sessions, "inbox.json"),
      JSON.stringify({ pid: PID, kind: "inbox", started: new Date().toISOString() }),
    );
    const asInbox = { RISA_SESSION_NAME: "inbox" };
    writeFileSync(transcript, assistant(1, 170_000));
    mkdirSync(join(root, "s1", "subagents"), { recursive: true });
    writeFileSync(
      join(root, "s1", "subagents", "agent-a2.jsonl"),
      assistant(1, 165_000, 0, { isSidechain: true }),
    );
    expect(hook({ transcript_path: transcript, agent_id: "a2" }, asInbox).stdout).toBe("");
    const r = hook({ transcript_path: transcript }, asInbox);
    // The sessions folder is <main>/.loops/.sessions; here <root>/.sessions, so main is root's parent.
    expect(contextOf(r.stdout).additionalContext).toContain(
      `\`pnpm -s -C ${dirname(root)} prd rotate --self\``,
    );
    expect(JSON.parse(readFileSync(join(context, "inbox.json"), "utf8"))).toMatchObject({ size: 170_001 });
  });

  it("gives a planner a planner's words past each limit, and its subagents the loop's", () => {
    writeFileSync(
      join(sessions, "plan-t.json"),
      JSON.stringify({ pid: PID, kind: "plan", topic: "t", auto: true, started: new Date().toISOString() }),
    );
    const asPlanner = { RISA_SESSION_NAME: "plan-t" };
    writeFileSync(transcript, assistant(1, 170_000));
    const soft = contextOf(hook({ transcript_path: transcript }, asPlanner).stdout).additionalContext;
    expect(soft).toContain("planning session is at 170k");
    expect(soft).toContain("Head for landing");
    writeFileSync(transcript, assistant(1, 240_000));
    const hard = contextOf(hook({ transcript_path: transcript }, asPlanner).stdout).additionalContext;
    expect(hard).toContain("past the hard limit of 225k");
    expect(hard).toContain("--report");
    mkdirSync(join(root, "s1", "subagents"), { recursive: true });
    writeFileSync(
      join(root, "s1", "subagents", "agent-a3.jsonl"),
      assistant(1, 180_000, 0, { isSidechain: true }),
    );
    const sub = hook({ transcript_path: transcript, agent_id: "a3" }, asPlanner);
    expect(contextOf(sub.stdout).additionalContext).toContain("this agent is at 180k");
  });

  it("exits 0 with no output on a missing transcript, bad input or an unwritable folder", () => {
    for (const input of [{ transcript_path: join(root, "none.jsonl") }, "not json", {}]) {
      const r = hook(input);
      expect([r.status, r.stdout]).toEqual([0, ""]);
    }
    writeFileSync(transcript, assistant(1, 170_000));
    writeFileSync(context, "a file where the folder should be");
    const r = hook({ transcript_path: transcript });
    expect([r.status, r.stdout]).toEqual([0, ""]);
    rmSync(context);
  });

  it("does nothing outside a wrapped session, or for a session its record no longer names", () => {
    writeFileSync(transcript, assistant(1, 170_000));
    const own = spawnSync("node", [CONTEXT, "hook"], {
      input: JSON.stringify({ transcript_path: transcript }),
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    expect([own.status, own.stdout]).toEqual([0, ""]);
    expect(hook({ transcript_path: transcript }, { RISA_SESSION_PID: "77" }).stdout).toBe("");
    expect(existsSync(join(context, "prd-t.json"))).toBe(false);
  });
});

describe("pnpm prd context", () => {
  const cli = (args, extra = {}, cwd = root) =>
    spawnSync("node", [CONTEXT, ...args], { cwd, encoding: "utf8", env: { ...baseEnv(), ...extra } });

  it("prints the caller's size and its limits", () => {
    writeFileSync(transcript, assistant(1, 170_000));
    hook({ transcript_path: transcript });
    expect(cli([]).stdout).toBe("prd-t: 170k over soft (soft 120k, hard 225k)\n");
    writeFileSync(transcript, assistant(1, 240_000));
    hook({ transcript_path: transcript });
    expect(cli([]).stdout).toBe("prd-t: 240k OVER hard (soft 120k, hard 225k)\n");
  });

  it("prints a backlog session's soft limit only", () => {
    writeFileSync(
      join(sessions, "backlog.json"),
      JSON.stringify({ pid: PID, kind: "backlog", started: new Date().toISOString() }),
    );
    const asBacklog = { RISA_SESSION_NAME: "backlog" };
    writeFileSync(transcript, assistant(1, 240_000));
    hook({ transcript_path: transcript }, asBacklog);
    expect(cli([], asBacklog).stdout).toBe("backlog: 240k over soft (soft 160k, no hard limit)\n");
  });

  it("refuses --keep without a reason, and with one sets the expiry", () => {
    expect(cli(["--keep"]).status).toBe(2);
    expect(cli(["--keep", "  "]).status).toBe(2);
    const before = Date.now();
    const r = cli(["--keep", "landing under way"]);
    expect(r.status).toBe(0);
    const { keep } = sizeFile();
    expect(keep.reason).toBe("landing under way");
    expect(Date.parse(keep.until)).toBeGreaterThanOrEqual(before + 30 * MIN);
    expect(Date.parse(keep.until)).toBeLessThanOrEqual(Date.now() + 30 * MIN);
  });

  it("refuses --keep outside a wrapped session and from a slice branch", () => {
    expect(cli(["--keep", "x"], { RISA_SESSION_NAME: "" }).status).toBe(1);
    const repo = join(root, "slice");
    mkdirSync(repo);
    spawnSync("git", ["init", "-q", "-b", "slice/t/1", repo]);
    const r = cli(["--keep", "x"], {}, repo);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("a loop hands off");
  });

  it("--all --json lists live sessions only and ignores a stale size record", async () => {
    // Outlives any slow run (killed below): a child gone mid-test drops every row.
    const child = spawn("sleep", ["600"], { stdio: "ignore" });
    try {
      const started = new Date().toISOString();
      // A live process under a record that started long before it: a reused pid, not the session.
      writeFileSync(
        join(sessions, "prd-reused.json"),
        JSON.stringify({ pid: child.pid, started: new Date(Date.now() - 10 * MIN).toISOString() }),
      );
      writeFileSync(
        join(sessions, "prd-live.json"),
        JSON.stringify({ pid: child.pid, kind: "prd", started }),
      );
      writeFileSync(join(sessions, "prd-stale.json"), JSON.stringify({ pid: child.pid, started }));
      writeFileSync(
        join(sessions, "prd-gone.json"),
        JSON.stringify({ pid: child.pid, started, ended: started }),
      );
      mkdirSync(context);
      writeFileSync(
        join(sessions, "backlog.json"),
        JSON.stringify({ pid: child.pid, kind: "backlog", started }),
      );
      writeFileSync(join(sessions, "prd-big.json"), JSON.stringify({ pid: child.pid, started }));
      writeFileSync(join(context, "prd-live.json"), JSON.stringify({ pid: child.pid, size: 165_000 }));
      writeFileSync(join(context, "prd-stale.json"), JSON.stringify({ pid: 1, size: 199_000 }));
      writeFileSync(join(context, "prd-big.json"), JSON.stringify({ pid: child.pid, size: 230_000 }));
      writeFileSync(join(context, "backlog.json"), JSON.stringify({ pid: child.pid, size: 230_000 }));
      const rows = JSON.parse(cli(["--all", "--json"]).stdout);
      const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
      // In name order, whatever the files' times; prd-t (the fixed PID) and prd-reused never.
      expect(rows.map((r) => r.name)).toEqual(["backlog", "prd-big", "prd-live", "prd-stale"]);
      expect(byName["prd-live"]).toMatchObject({
        size: 165_000,
        limit: 120_000,
        hard: 225_000,
        over: true,
        overHard: false,
        note: "165k over soft",
      });
      expect(byName["prd-stale"]).toMatchObject({ size: null, over: false, note: "no size yet" });
      expect(byName["prd-big"]).toMatchObject({ over: true, overHard: true, note: "230k OVER hard" });
      expect(byName.backlog).toMatchObject({
        limit: 160_000,
        hard: null,
        over: true,
        overHard: false,
        note: "230k over soft",
      });
      expect(cli(["--all"]).stdout).toContain("prd-big  230k OVER hard\n");
    } finally {
      child.kill();
    }
  });

  it("--all never takes the test sessions' fixed pid for a live process", () => {
    // prd-t (every test's session) under a pid a busy machine could hand out was --all's row.
    expect(processOf(PID)).toBeNull();
    expect(JSON.parse(cli(["--all", "--json"]).stdout)).toEqual([]);
  });
});
