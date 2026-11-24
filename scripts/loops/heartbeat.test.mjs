// The heartbeat (heartbeat.mjs) and the hook that writes it (context.mjs hook),
// from fixture hook input in temporary folders: no real session, transcript or .loops.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { applyHeartbeat, heartbeatEvent, readHeartbeats, worktreeOfCwd, worktreesIn } from "./heartbeat.mjs";

const CONTEXT = new URL("./context.mjs", import.meta.url).pathname;
const LOOPS = "/fixture/main/.loops";
const NOW = Date.parse("2026-11-24T12:00:00Z");
const PID = 99_999_999;

describe("worktreesIn and worktreeOfCwd", () => {
  it("names each .loops worktree a text mentions, whole names only", () => {
    const cmd = `cd ${LOOPS}/topic-3 && git -C '${LOOPS}/topic' status; cat "${LOOPS}/topic-3/a.md"`;
    expect(worktreesIn(cmd, LOOPS)).toEqual(["topic-3", "topic", "topic-3"]);
    expect(worktreesIn(`${LOOPS}/.sessions/x.json`, LOOPS)).toEqual([]);
    expect(worktreesIn("/elsewhere/.loops/topic-3", LOOPS)).toEqual([]);
  });

  it("finds a cwd's worktree, the main checkout as main, anything else as null", () => {
    expect(worktreeOfCwd(`${LOOPS}/topic`, LOOPS)).toBe("topic");
    expect(worktreeOfCwd(`${LOOPS}/topic/apps/web`, LOOPS)).toBe("topic");
    expect(worktreeOfCwd("/fixture/main", LOOPS)).toBe("main");
    expect(worktreeOfCwd("/somewhere", LOOPS)).toBeNull();
  });
});

describe("heartbeatEvent and applyHeartbeat", () => {
  const input = (event, extra = {}) => ({ hook_event_name: event, cwd: `${LOOPS}/topic`, ...extra });
  const bash = (event, id, command, extra = {}) =>
    input(event, { tool_name: "Bash", tool_use_id: id, tool_input: { command }, ...extra });

  it("reads start, end, failure and stop; ignores other events and bad agent ids", () => {
    expect(heartbeatEvent(bash("PreToolUse", "t1", "ls"), LOOPS)).toMatchObject({
      type: "start",
      agent: null,
      tool: "Bash",
      id: "t1",
      command: "ls",
      cwdWorktree: "topic",
    });
    expect(heartbeatEvent(bash("PostToolUseFailure", "t1", "ls"), LOOPS)?.type).toBe("end");
    expect(heartbeatEvent(input("SubagentStop", { agent_id: "agent-ab12" }), LOOPS)).toMatchObject({
      type: "stop",
      agent: "ab12",
    });
    expect(heartbeatEvent(input("SubagentStop"), LOOPS)).toBeNull();
    expect(heartbeatEvent(input("Notification"), LOOPS)).toBeNull();
    expect(heartbeatEvent(input("PreToolUse", { agent_id: "../x" }), LOOPS)).toBeNull();
    expect(heartbeatEvent(null, LOOPS)).toBeNull();
  });

  it("a start is a running call until its end; a stop clears what's left", () => {
    const at = (min) => ({ session: "prd-topic", pid: PID, now: NOW + min * 60_000 });
    const agent = { agent_id: "ab12", agent_type: "general-purpose" };
    const cmd = `cd ${LOOPS}/topic-3 && pnpm prd check --quick "slice hand-off"`;
    let r = applyHeartbeat(null, heartbeatEvent(bash("PreToolUse", "t1", cmd, agent), LOOPS), at(0));
    expect(r).toMatchObject({ agent: "ab12", agentType: "general-purpose", worktree: "topic-3" });
    expect(r.running.t1).toMatchObject({ tool: "Bash", command: cmd });
    r = applyHeartbeat(r, heartbeatEvent(bash("PreToolUse", "t2", "ls", agent), LOOPS), at(1));
    r = applyHeartbeat(r, heartbeatEvent(bash("PostToolUse", "t2", "ls", agent), LOOPS), at(2));
    expect(Object.keys(r.running)).toEqual(["t1"]);
    expect(r).toMatchObject({ lastStart: new Date(NOW + 60_000).toISOString(), stoppedAt: null });
    r = applyHeartbeat(r, heartbeatEvent(input("SubagentStop", agent), LOOPS), at(3));
    expect(r.running).toEqual({});
    expect(r.stoppedAt).toBe(new Date(NOW + 3 * 60_000).toISOString());
    // A new call after the stop: no longer stopped.
    r = applyHeartbeat(r, heartbeatEvent(bash("PreToolUse", "t3", "ls", agent), LOOPS), at(4));
    expect(r.stoppedAt).toBeNull();
  });

  it("a subagent's worktree is the one its calls name most; the session's is its cwd", () => {
    const facts = { session: "prd-topic", pid: PID, now: NOW };
    const agent = { agent_id: "ab12" };
    const read = (path) =>
      input("PreToolUse", {
        tool_name: "Read",
        tool_use_id: path,
        tool_input: { file_path: path },
        ...agent,
      });
    let r = null;
    for (const p of [`${LOOPS}/topic/plan.md`, `${LOOPS}/topic-3/a.mjs`, `${LOOPS}/topic-3/b.mjs`])
      r = applyHeartbeat(r, heartbeatEvent(read(p), LOOPS), facts);
    expect(r.worktree).toBe("topic-3");
    // No path at all: unknown.
    const blind = applyHeartbeat(null, heartbeatEvent(input("PreToolUse", agent), LOOPS), facts);
    expect(blind.worktree).toBeNull();
    // The session's own call naming another worktree: still its cwd's.
    const session = { ...read(`${LOOPS}/topic-3/a.mjs`), agent_id: undefined };
    const own = applyHeartbeat(null, heartbeatEvent(session, LOOPS), facts);
    expect(own.worktree).toBe("topic");
  });

  it("a record of another pid starts over", () => {
    const old = { pid: 1, firstAt: "2026-01-01T00:00:00Z", running: { x: { tool: "Bash" } }, seen: {} };
    const r = applyHeartbeat(old, heartbeatEvent(input("PreToolUse"), LOOPS), {
      session: "s",
      pid: PID,
      now: NOW,
    });
    expect(r.firstAt).toBe(new Date(NOW).toISOString());
    expect(Object.keys(r.running)).toHaveLength(1);
  });
});

describe("the hook as a command", () => {
  const roots = [];
  let loops, sessions, beats;
  beforeEach(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "heartbeat-")));
    roots.push(root);
    loops = join(root, "main", ".loops");
    sessions = join(loops, ".sessions");
    beats = join(loops, ".heartbeat", "prd-topic");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "prd-topic.json"),
      JSON.stringify({ pid: PID, started: new Date().toISOString() }),
    );
  });
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
  const hook = (input, extra = {}) =>
    spawnSync("node", [CONTEXT, "hook"], {
      input: typeof input === "string" ? input : JSON.stringify(input),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        CARETOOK_SESSIONS_DIR: sessions,
        CARETOOK_SESSION_NAME: "prd-topic",
        CARETOOK_SESSION_PID: String(PID),
        ...extra,
      },
    });
  const beat = (name) => JSON.parse(readFileSync(join(beats, `${name}.json`), "utf8"));

  it("writes a subagent's start, end and stop, silently", () => {
    const call = {
      agent_id: "ab12",
      agent_type: "general-purpose",
      cwd: join(loops, "topic"),
      tool_name: "Bash",
      tool_use_id: "toolu_1",
      tool_input: { command: `cd ${join(loops, "topic-3")} && pnpm prd check --quick "slice hand-off"` },
    };
    const start = hook({ ...call, hook_event_name: "PreToolUse" });
    expect([start.status, start.stdout, start.stderr]).toEqual([0, "", ""]);
    expect(beat("ab12")).toMatchObject({
      session: "prd-topic",
      pid: PID,
      agent: "ab12",
      worktree: "topic-3",
      running: { toolu_1: { tool: "Bash" } },
      stoppedAt: null,
    });
    // No transcript: PostToolUse still ends the call, and sizing has nothing to say.
    const end = hook({ ...call, hook_event_name: "PostToolUse", tool_response: { stdout: "" } });
    expect([end.status, end.stdout]).toEqual([0, ""]);
    expect(beat("ab12").running).toEqual({});
    expect(beat("ab12").lastEnd).toBeTruthy();
    const stop = hook({ hook_event_name: "SubagentStop", agent_id: "ab12", cwd: call.cwd });
    expect([stop.status, stop.stdout]).toEqual([0, ""]);
    expect(beat("ab12").stoppedAt).toBeTruthy();
    // The session's own call is its own record, its worktree from its cwd.
    hook({
      hook_event_name: "PreToolUse",
      cwd: join(loops, "topic"),
      tool_name: "Read",
      tool_use_id: "toolu_2",
    });
    expect(beat("session")).toMatchObject({ agent: null, worktree: "topic" });
    expect(
      readHeartbeats(join(loops, ".heartbeat"))
        .map((r) => r.agent ?? "session")
        .sort(),
    ).toEqual(["ab12", "session"]);
  });

  it("bad input, or no live session, exits 0 silently and writes nothing", () => {
    for (const bad of [
      "not json",
      "",
      "[]",
      JSON.stringify({ hook_event_name: "PreToolUse", agent_id: "../../x" }),
    ]) {
      const r = hook(bad);
      expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
    }
    const stale = hook({ hook_event_name: "PreToolUse", tool_name: "Read" }, { CARETOOK_SESSION_PID: "77" });
    expect([stale.status, stale.stdout]).toEqual([0, ""]);
    const none = hook({ hook_event_name: "PreToolUse", tool_name: "Read" }, { CARETOOK_SESSIONS_DIR: "" });
    expect([none.status, none.stdout]).toEqual([0, ""]);
    expect(existsSync(beats) ? readdirSync(beats).filter((f) => f.endsWith(".json")) : []).toEqual([]);
  });

  it("an unwritable heartbeat folder never fails the call", () => {
    mkdirSync(join(loops, ".heartbeat"), { recursive: true });
    writeFileSync(beats, "a file where the folder goes");
    const r = hook({ hook_event_name: "PreToolUse", agent_id: "ab12", tool_name: "Read" });
    expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
  });
});
