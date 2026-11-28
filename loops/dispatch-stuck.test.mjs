// The stuck watch's `notified` stall (RISA-1033): a session whose newest transcript
// event is a delivered notification and that has taken no turn since. Fixture
// transcripts and heartbeats only, in the OS temp dir: no real session.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  STUCK_SESSION,
  notifiedAtOf,
  stuckDecision,
  stuckSettings,
  transcriptNotifiedAt,
} from "./dispatch-stuck.mjs";
import { applyHeartbeat, heartbeatEvent } from "./heartbeat.mjs";

const NOW = Date.parse("2027-01-15T12:00:00Z");
const LIMIT = 30 * 60_000;
const NOTIFIED = 10 * 60_000;
const ago = (/** @type {number} */ min) => new Date(NOW - min * 60_000).toISOString();
const msAgo = (/** @type {number} */ min) => NOW - min * 60_000;

const line = (/** @type {object} */ o) => JSON.stringify(o);
const assistant = (/** @type {number} */ min) =>
  line({
    type: "assistant",
    timestamp: ago(min),
    message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
  });
const enqueue = (
  /** @type {number} */ min,
  content = "<task-notification>\n<task-id>b1</task-id>\n</task-notification>",
) => line({ type: "queue-operation", operation: "enqueue", timestamp: ago(min), content });
const userNote = (/** @type {number} */ min, text = "<task-notification>\n<task-id>b1</task-id>") =>
  line({ type: "user", timestamp: ago(min), message: { role: "user", content: text } });

const sess = (/** @type {object} */ extra = {}) => ({
  name: "prd-x",
  pid: 100,
  kind: "prd",
  topic: "x",
  managed: true,
  auto: true,
  live: true,
  notifiedAt: msAgo(11),
  ...extra,
});
// Its turn ended 12 minutes ago: under the quiet limit, so only `notified` can fire.
const own = (/** @type {object} */ extra = {}) => ({
  session: "prd-x",
  pid: 100,
  agent: null,
  lastStart: ago(13),
  lastEnd: ago(12.5),
  stoppedAt: ago(12),
  running: {},
  ...extra,
});
const decide = (/** @type {object} */ facts = {}) =>
  stuckDecision({
    sessions: [sess()],
    heartbeats: [own()],
    limitMs: LIMIT,
    notifiedMs: NOTIFIED,
    now: NOW,
    ...facts,
  });
const asks = (/** @type {object} */ facts) => decide(facts).filter((a) => a.type === "ask");

describe("notifiedAtOf: the transcript's newest event is a notification", () => {
  it("gives the notification's time when nothing replied after it", () => {
    expect(notifiedAtOf([assistant(20), enqueue(11)].join("\n"))).toBe(msAgo(11));
    // Delivered as a turn's prompt (enqueue, then the user line), still unanswered.
    expect(notifiedAtOf([assistant(20), enqueue(11), userNote(11)].join("\n"))).toBe(msAgo(11));
    const message = `Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/x.sock">hi`;
    expect(notifiedAtOf([assistant(20), userNote(11, message)].join("\n"))).toBe(msAgo(11));
    expect(notifiedAtOf([assistant(20), enqueue(11, '<agent-message from="a1">done')].join("\n"))).toBe(
      msAgo(11),
    );
  });

  it("is null once a reply follows, or with no notification at all", () => {
    expect(notifiedAtOf([enqueue(11), assistant(10)].join("\n"))).toBeNull();
    expect(notifiedAtOf([assistant(20), userNote(15, "a plain prompt")].join("\n"))).toBeNull();
    expect(notifiedAtOf("")).toBeNull();
    // A cut first line (the tail read) and junk are skipped.
    expect(notifiedAtOf(['ype":"assistant"}', "not json", enqueue(11)].join("\n"))).toBe(msAgo(11));
  });

  it("reads a transcript file's end; a missing file is null", () => {
    const dir = mkdtempSync(join(tmpdir(), "risa-stuck-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "t.jsonl");
    writeFileSync(file, `${[assistant(20), enqueue(11)].join("\n")}\n`);
    expect(transcriptNotifiedAt(file)).toBe(msAgo(11));
    expect(transcriptNotifiedAt(join(dir, "gone.jsonl"))).toBeNull();
    expect(transcriptNotifiedAt(null)).toBeNull();
  });
});

describe("the session heartbeat keeps its transcript", () => {
  it("records the session's transcript path, not an agent's", () => {
    const input = (/** @type {object} */ extra) => ({
      hook_event_name: "Stop",
      session_id: "s1",
      cwd: "/fixture/main",
      transcript_path: "/fixture/projects/s1.jsonl",
      ...extra,
    });
    const ev = heartbeatEvent(input({}), "/fixture/main/.loops");
    const r = applyHeartbeat(null, /** @type {any} */ (ev), { session: "prd-x", pid: 1, now: NOW });
    expect(r.transcript).toBe("/fixture/projects/s1.jsonl");
    const sub = heartbeatEvent(
      input({ hook_event_name: "SubagentStop", agent_id: "agent-ab12" }),
      "/fixture/main/.loops",
    );
    expect(sub?.transcript).toBeNull();
  });
});

describe("the notified stall", () => {
  it("asks about a session notified 11 minutes ago with no turn since", () => {
    const [a] = asks();
    expect(a).toMatchObject({ session: "prd-x", pid: 100, topic: "x", since: msAgo(11) });
    expect(a.text).toMatch(
      /prd-x looks stuck: a notification reached it 11m ago and it hasn't taken a turn since/,
    );
    expect(a.text).toMatch(/SendMessage/);
  });

  it("sees it past an open question of its topic and a busy command (what hid it from the quiet watch)", () => {
    const open = { id: "a9", topic: "x", kind: "question", session: "someone" };
    expect(asks({ asks: [open], running: new Set(["prd-x"]) })).toHaveLength(1);
  });

  it("isn't one before the wait, after a turn, or mid-turn", () => {
    expect(asks({ sessions: [sess({ notifiedAt: msAgo(9) })] })).toEqual([]);
    // A turn after the notification: a tool call, or a reply with none (its Stop).
    expect(asks({ heartbeats: [own({ lastStart: ago(5), lastEnd: ago(5), stoppedAt: ago(4) })] })).toEqual(
      [],
    );
    expect(asks({ heartbeats: [own({ stoppedAt: ago(5) })] })).toEqual([]);
    // Inside a turn (a long foreground call): the notification waits for it.
    expect(
      asks({ heartbeats: [own({ stoppedAt: null, running: { t1: { tool: "Bash", at: ago(13) } } })] }),
    ).toEqual([]);
    expect(asks({ sessions: [sess({ notifiedAt: null })] })).toEqual([]);
    // RISA_STUCK_NOTIFIED_MIN sets the wait.
    expect(stuckSettings({}).notifiedMs).toBe(NOTIFIED);
    expect(stuckSettings({ RISA_STUCK_NOTIFIED_MIN: "20" }).notifiedMs).toBe(20 * 60_000);
  });

  it("asks once per stall, and clears when the session takes a turn", () => {
    const entries = { "prd-x": { pid: 100, since: msAgo(11), askId: "a1" } };
    const open = { id: "a1", topic: "x", kind: "question", session: STUCK_SESSION };
    expect(decide({ entries, asks: [open] })).toEqual([]);
    const later = decide({
      entries,
      asks: [open],
      heartbeats: [own({ lastStart: ago(1), lastEnd: ago(1), stoppedAt: ago(1) })],
    });
    expect(later).toEqual([{ type: "clear", session: "prd-x", askId: "a1" }]);
  });

  it("two sessions notified together make one report and no question", () => {
    const y = { name: "prd-y", pid: 200, topic: "y" };
    const actions = decide({
      sessions: [sess(), sess({ ...y, notifiedAt: msAgo(11.5) })],
      heartbeats: [own(), own({ session: "prd-y", pid: 200 })],
    });
    expect(actions.filter((a) => a.type === "ask")).toEqual([]);
    const reports = actions.filter((a) => a.type === "report");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ sessions: ["prd-x", "prd-y"] });
    // Reported once: the key in `reported` stops a second.
    const again = decide({
      sessions: [sess(), sess({ ...y, notifiedAt: msAgo(11.5) })],
      heartbeats: [own(), own({ session: "prd-y", pid: 200 })],
      reported: [/** @type {any} */ (reports[0]).key],
    });
    expect(again).toEqual([]);
  });
});

describe("a machine that lost the home (RISA-1084)", () => {
  const AWAY = "the home is the fictional machine Galileo";
  // Asked and answered "rotate it now": the next tick rotates, unless a gate holds it.
  const entries = {
    "prd-x": { pid: 100, since: msAgo(11), askId: "a1", answer: /** @type {const} */ ("rotate") },
  };
  const rotations = (/** @type {object} */ gates) =>
    decide({ entries, gates }).filter((a) => a.type === "rotate" || a.type === "gated");

  it("doesn't rotate a stuck session while the project's home is away, and says why", () => {
    expect(rotations({ project: AWAY, inbox: null })).toEqual([
      { type: "gated", session: "prd-x", why: AWAY },
    ]);
  });

  it("rotates as before with the home here, or with only the inbox gate closed", () => {
    const rotate = [{ type: "rotate", session: "prd-x", pid: 100, topic: "x" }];
    expect(rotations({ project: null, inbox: null })).toEqual(rotate);
    expect(rotations({})).toEqual(rotate);
    expect(rotations({ project: null, inbox: "the inbox home is Galileo" })).toEqual(rotate);
  });

  it("still asks about a stall: the question opens no session", () => {
    expect(asks({ gates: { project: AWAY } })).toHaveLength(1);
  });
});
