// The dispatcher's context follow-up: the pure decision, and the tick acting on
// it with a stub rotate and the real asks. All sessions and sizes are fictional.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAsk, getAsk, listAsks } from "./asks.mjs";
import { namesOf } from "./flavor.mjs";
import {
  CONTEXT_OPTIONS,
  CONTEXT_SESSION,
  commandUnder,
  contextAnswer,
  contextDecision,
  contextDefault,
  runsPrdCommand,
} from "./dispatch-context.mjs";
import { DISPATCH_SESSION, MAX_REOPENS, pick } from "./dispatch-pick.mjs";
import "./config-fixture.mjs";

/** The main backlog session's pool: the starfleet admirals (flavor.mjs). */
const ADMIRALS = namesOf("backlog");

const HERE = dirname(fileURLToPath(import.meta.url));
const MIN = 60_000;
const NOW = Date.parse("2026-11-22T12:00:00Z");
/** The hard limit: the dispatcher's follow-up starts there. */
const LIMIT = 225_000;
const WAIT = 15 * MIN;
const ago = (ms) => new Date(NOW - ms).toISOString();

const session = (extra = {}) => ({
  name: "prd-x",
  pid: 100,
  kind: "prd",
  topic: "x",
  managed: true,
  live: true,
  ...extra,
});
const over = (extra = {}) => ({ pid: 100, size: 240_000, hardOverAt: ago(WAIT), ...extra });
const decide = (facts = {}) =>
  contextDecision({
    sessions: [session()],
    sizes: { "prd-x": over() },
    limit: LIMIT,
    waitMs: WAIT,
    now: NOW,
    ...facts,
  });
const types = (actions) => actions.map((a) => a.type);
const question = (extra = {}) => ({ id: "a1", kind: "question", topic: "x", ...extra });
const asked = { "prd-x": { pid: 100, askId: "a1" } };
const delivered = over({ nudgeAt: ago(2 * WAIT), nudgeDeliveredAt: ago(WAIT) });

describe("the context decision", () => {
  it("does nothing under the hard limit, or over it before the wait", () => {
    expect(decide({ sizes: { "prd-x": { pid: 100, size: LIMIT } } })).toEqual([]);
    // Past the soft limit only: the hook's reminders, never the dispatcher's follow-up.
    expect(decide({ sizes: { "prd-x": { pid: 100, size: 200_000, firstOverAt: ago(9 * WAIT) } } })).toEqual(
      [],
    );
    expect(decide({ sizes: { "prd-x": over({ hardOverAt: ago(WAIT - 1) }) } })).toEqual([]);
  });

  it("nudges after the wait, once", () => {
    expect(decide()).toEqual([{ type: "nudge", session: "prd-x", pid: 100 }]);
    expect(decide({ sizes: { "prd-x": over({ nudgeAt: ago(MIN) }) } })).toEqual([]);
  });

  it("never turns an undelivered nudge into a question", () => {
    expect(
      decide({ sizes: { "prd-x": over({ hardOverAt: ago(9 * WAIT), nudgeAt: ago(8 * WAIT) }) } }),
    ).toEqual([]);
  });

  it("asks the wait after the delivery, once", () => {
    expect(
      decide({ sizes: { "prd-x": over({ nudgeAt: ago(WAIT), nudgeDeliveredAt: ago(WAIT - 1) }) } }),
    ).toEqual([]);
    const [a] = decide({ sizes: { "prd-x": delivered } });
    expect(a).toMatchObject({ type: "ask", session: "prd-x", topic: "x", recommend: "rotate it now" });
    expect(a.text).toBe("prd-x is at 240k context and hasn't rotated");
    expect(decide({ sizes: { "prd-x": delivered }, entries: asked, asks: { a1: question() } })).toEqual([]);
  });

  it("gives nothing for a keep, a hand-opened session, a planner, a stale record or a pause", () => {
    const keep = { reason: "landing", until: new Date(NOW + MIN).toISOString() };
    expect(decide({ sizes: { "prd-x": over({ keep }) } })).toEqual([]);
    expect(decide({ sessions: [session({ managed: false })] })).toEqual([]);
    expect(
      decide({ sessions: [session({ name: "plan-x", kind: "plan" })], sizes: { "plan-x": over() } }),
    ).toEqual([]);
    expect(decide({ sizes: { "prd-x": over({ pid: 99 }) } })).toEqual([]);
    expect(decide({ paused: true })).toEqual([]);
  });

  it("an expired keep no longer holds it", () => {
    const keep = { reason: "landing", until: ago(1) };
    expect(types(decide({ sizes: { "prd-x": over({ keep }) } }))).toEqual(["nudge"]);
  });

  it.each([
    ["given", { answeredAt: ago(1), answer: CONTEXT_OPTIONS[0] }],
    ["defaulted", { answeredAt: ago(1), answer: CONTEXT_OPTIONS[0], defaulted: true }],
  ])("rotates on rotate it now (%s) only when no command runs", (_how, fields) => {
    const facts = { sizes: { "prd-x": delivered }, entries: asked, asks: { a1: question(fields) } };
    expect(types(decide(facts))).toEqual(["answered", "rotate"]);
    expect(decide(facts)[1]).toEqual({ type: "rotate", session: "prd-x", pid: 100, topic: "x" });
    expect(types(decide({ ...facts, running: new Set(["prd-x"]) }))).toEqual(["answered", "hold"]);
  });

  it("does not retry a rotation until the wait has passed", () => {
    const entry = (triedAt) => ({ "prd-x": { pid: 100, askId: "a1", answer: "rotate", triedAt } });
    expect(decide({ entries: entry(NOW - WAIT + 1) })).toEqual([]);
    expect(types(decide({ entries: entry(NOW - WAIT) }))).toEqual(["rotate"]);
  });

  it("leaves it alone on leave it, an unclear answer, a dismissal or a lost ask", () => {
    for (const ask of [
      question({ answeredAt: ago(1), answer: CONTEXT_OPTIONS[1] }),
      question({ answeredAt: ago(1), answer: "maybe later" }),
      question({ doneAt: ago(1) }),
      null,
    ]) {
      const a = decide({ sizes: { "prd-x": delivered }, entries: asked, asks: { a1: ask } });
      expect(a).toEqual([{ type: "answered", session: "prd-x", pid: 100, answer: "leave", askId: "a1" }]);
    }
    const left = { "prd-x": { pid: 100, askId: "a1", answer: "leave" } };
    expect(decide({ sizes: { "prd-x": delivered }, entries: left })).toEqual([]);
  });

  it("keeps leave it through a dip under the limit", () => {
    const left = { "prd-x": { pid: 100, askId: "a1", answer: "leave" } };
    expect(decide({ sizes: { "prd-x": { pid: 100, size: 1000 } }, entries: left })).toEqual([]);
  });

  it("clears the entry and its open question when the session drops under or ends", () => {
    const asks = { a1: question() };
    expect(decide({ sizes: { "prd-x": { pid: 100, size: 1000 } }, entries: asked, asks })).toEqual([
      { type: "clear", session: "prd-x", askId: "a1" },
    ]);
    expect(decide({ sessions: [session({ live: false })], entries: asked, asks })).toEqual([
      { type: "clear", session: "prd-x", askId: "a1" },
    ]);
  });

  it("starts a new session of the same name clean", () => {
    const left = { "prd-x": { pid: 99, askId: "a1", answer: "leave" } };
    expect(types(decide({ entries: left, asks: { a1: question({ answeredAt: ago(1) }) } }))).toEqual([
      "clear",
      "nudge",
    ]);
  });

  it("reads answers by word or number", () => {
    expect(["rotate it now", "1", "Rotate"].map(contextAnswer)).toEqual(["rotate", "rotate", "rotate"]);
    expect(["leave it", "2", "", null].map(contextAnswer)).toEqual(["leave", "leave", "leave", "leave"]);
  });
});

describe("a managed backlog session", () => {
  const backlog = (extra = {}) => session({ name: "backlog", kind: "backlog", topic: "", ...extra });
  const facts = (size, extra = {}) => ({ sessions: [backlog()], sizes: { backlog: size }, ...extra });
  const entries = { backlog: { pid: 100, askId: "a1" } };
  const yes = { a1: question({ topic: "backlog", answeredAt: ago(1), answer: CONTEXT_OPTIONS[0] }) };
  const deliveredAt = NOW - WAIT;

  it("is nudged and then asked under its own name, the question defaulting to keep going", () => {
    expect(decide(facts(over()))).toEqual([{ type: "nudge", session: "backlog", pid: 100 }]);
    const [a] = decide(facts(delivered));
    expect(a).toMatchObject({ type: "ask", session: "backlog", topic: "backlog", recommend: "leave it" });
    expect(a.text).toBe(
      "backlog is at 240k context: hand it off, or leave it running (no answer keeps it going)?",
    );
    expect(contextDefault("backlog")).toBe(CONTEXT_OPTIONS[1]);
    expect(contextDefault("prd")).toBe(CONTEXT_OPTIONS[0]);
  });

  it("never rotates on a defaulted answer, a dismissal or a lost ask: it keeps going", () => {
    const defaulted = question({
      topic: "backlog",
      answeredAt: ago(1),
      answer: contextDefault("backlog"),
      defaulted: true,
    });
    for (const ask of [defaulted, question({ topic: "backlog", doneAt: ago(1) }), null]) {
      expect(decide(facts(delivered, { entries, asks: { a1: ask } }))).toEqual([
        { type: "answered", session: "backlog", pid: 100, answer: "leave", askId: "a1" },
      ]);
    }
  });

  it("gets nothing when opened by hand", () => {
    expect(decide({ sessions: [backlog({ managed: false })], sizes: { backlog: delivered } })).toEqual([]);
  });

  it("covers a named backlog session", () => {
    const named = backlog({ name: "backlog-tax" });
    expect(decide({ sessions: [named], sizes: { "backlog-tax": over() } })).toEqual([
      { type: "nudge", session: "backlog-tax", pid: 100 },
    ]);
  });

  it("holds the rotation a tick while a command runs", () => {
    const f = facts(delivered, { entries, asks: yes, running: new Set(["backlog"]) });
    expect(types(decide(f))).toEqual(["answered", "hold"]);
  });

  it.each([
    ["written after the delivery", { backlog: deliveredAt + 1 }, true],
    ["written at the delivery", { backlog: deliveredAt }, false],
    ["older than the delivery", { backlog: deliveredAt - MIN }, false],
    ["missing", {}, false],
  ])("rotates with a brief only when it is fresh: %s", (_what, briefs, brief) => {
    expect(decide(facts(delivered, { entries, asks: yes, briefs }))[1]).toEqual({
      type: "rotate-backlog",
      session: "backlog",
      pid: 100,
      topic: "backlog",
      brief,
    });
  });
});

describe("a managed inbox session", () => {
  const inbox = (extra = {}) => session({ name: "inbox", kind: "inbox", topic: "", ...extra });
  const yes = { a1: question({ topic: "inbox", answeredAt: ago(1), answer: CONTEXT_OPTIONS[0] }) };

  it("is nudged, asked under its own name, and rotated with no brief", () => {
    expect(decide({ sessions: [inbox()], sizes: { inbox: over() } })).toEqual([
      { type: "nudge", session: "inbox", pid: 100 },
    ]);
    const [a] = decide({ sessions: [inbox()], sizes: { inbox: delivered } });
    expect(a).toMatchObject({ type: "ask", session: "inbox", topic: "inbox" });
    const f = {
      sessions: [inbox()],
      sizes: { inbox: delivered },
      entries: { inbox: { pid: 100, askId: "a1" } },
    };
    expect(decide({ ...f, asks: yes })[1]).toEqual({
      type: "rotate-inbox",
      session: "inbox",
      pid: 100,
      topic: "inbox",
    });
  });

  it("gets nothing when opened by hand", () => {
    expect(decide({ sessions: [inbox({ managed: false })], sizes: { inbox: delivered } })).toEqual([]);
  });

  it("is followed up from its one limit, the soft one, and its question defaults to rotate", () => {
    const at170 = over({ size: 170_000 });
    const f = { sessions: [inbox()], sizes: { inbox: at170 }, inboxLimit: 160_000 };
    expect(decide(f)).toEqual([{ type: "nudge", session: "inbox", pid: 100 }]);
    const [a] = decide({ ...f, sizes: { inbox: { ...delivered, size: 170_000 } } });
    expect(a).toMatchObject({ type: "ask", recommend: CONTEXT_OPTIONS[0] });
    expect(contextDefault("inbox")).toBe(CONTEXT_OPTIONS[0]);
    // An orchestrator at the same size is under its hard limit: no follow-up.
    expect(decide({ sizes: { "prd-x": at170 }, inboxLimit: 160_000 })).toEqual([]);
  });
});

describe("a command under the session", () => {
  it("counts pnpm prd commands, but not a wait on a question", () => {
    expect(runsPrdCommand("node /opt/pnpm.cjs prd land x")).toBe(true);
    expect(runsPrdCommand("zsh -c cd /w && pnpm prd check --quick why")).toBe(true);
    expect(runsPrdCommand("bash loops/prd.sh review x --wait")).toBe(true);
    expect(runsPrdCommand("zsh -c pnpm prd ask --wait a7")).toBe(false);
    expect(runsPrdCommand("zsh -c pnpm prd ask --wait a7; pnpm prd land x")).toBe(true);
    expect(runsPrdCommand("pnpm test:tooling")).toBe(false);
  });

  it("counts pnpm backlog commands", () => {
    expect(runsPrdCommand("zsh -c pnpm backlog set B-1 status=triaged")).toBe(true);
    expect(runsPrdCommand("node /opt/pnpm.cjs backlog ingest")).toBe(true);
    expect(runsPrdCommand("node /m/backlog/backlog.mjs note B-1 fictional")).toBe(true);
    expect(runsPrdCommand("cat plans/backlog.md")).toBe(false);
  });

  it("walks the descendants and never reads the session's own arguments", () => {
    const table = new Map([
      [100, { ppid: 1, args: "claude pnpm prd land is in my prompt" }],
      [101, { ppid: 100, args: "zsh" }],
      [102, { ppid: 101, args: "node /opt/pnpm.cjs prd check" }],
      [200, { ppid: 1, args: "pnpm prd land other" }],
    ]);
    expect(commandUnder(100, table)).toBe(true);
    table.delete(102);
    expect(commandUnder(100, table)).toBe(false);
  });
});

describe("a reopen question and a context question on one topic", () => {
  const dead = {
    rows: [{ topic: "x", flags: [], after: [], hot: [], state: "running", waiting: 0 }],
    worktrees: [{ name: "x", branch: "prd/x" }],
    sessions: [{ name: "prd-x", live: false, managed: true }],
    reopens: { "prd-x": MAX_REOPENS },
    now: NOW,
  };

  it("a context question is never read as the reopen question", () => {
    const p = pick({ ...dead, asks: [question({ id: "a2", session: CONTEXT_SESSION })] });
    expect(p).toMatchObject({ action: "ask", session: "prd-x" });
  });

  it("a reopen question still holds its own ask with a context question beside it", () => {
    const p = pick({
      ...dead,
      asks: [
        question({ id: "a2", session: CONTEXT_SESSION }),
        question({ id: "a3", session: DISPATCH_SESSION }),
      ],
    });
    expect(p.action).toBe("none");
    expect(p.reasons.find((r) => r.topic === "x")?.why).toContain("waits on ask a3");
  });

  it("a reopen question's answer is never read as the context question's", () => {
    const a = decide({
      sizes: { "prd-x": delivered },
      entries: asked,
      asks: { a1: question(), a3: question({ id: "a3", answeredAt: ago(1), answer: "reopen again" }) },
    });
    expect(a).toEqual([]);
  });
});

// ---- the tick ----------------------------------------------------------------------

const BACKLOG = `#!/usr/bin/env node
process.stdout.write("[]");
`;
const OPEN_SH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_STATE/open.calls"
`;
const ROTATE_SH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_STATE/rotate.calls"
[[ ! -e $STUB_STATE/refuse ]] || { echo "rotate: plan has uncommitted changes" >&2; exit 1; }
`;

const T0 = 1_800_000_000;
let root, main, loops, sessions, asksDir, stubs, clock, env, procs;
const scripts = (f) => join(main, "loops", f);
const sizeFile = () => join(loops, ".context", "prd-x.json");
const stateFile = () => join(loops, ".dispatch.json");
const callsOf = (f) => {
  const file = join(stubs, `${f}.calls`);
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
};
const tick = (args = ["--once"], extra = {}) => {
  const r = spawnSync("node", [scripts("dispatch.mjs"), ...args], {
    cwd: main,
    encoding: "utf8",
    env: { ...env, ...extra },
  });
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  return r.stdout;
};
const iso = (secs) => new Date(secs * 1000).toISOString();
const setClock = (secs) => writeFileSync(clock, String(secs));
const writeSize = (fields) => {
  mkdirSync(dirname(sizeFile()), { recursive: true });
  writeFileSync(sizeFile(), JSON.stringify(fields));
};
const readSizeFile = () => JSON.parse(readFileSync(sizeFile(), "utf8"));
const contextState = () =>
  existsSync(stateFile()) ? (JSON.parse(readFileSync(stateFile(), "utf8")).context ?? {}) : {};
/** A live managed orchestrator record on a real process. */
const liveSession = (script = "while :; do sleep 1; done") => {
  const child = spawn("bash", ["-c", script], { detached: true, stdio: "ignore" });
  procs.push(child);
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    join(sessions, "prd-x.json"),
    JSON.stringify({
      pid: child.pid,
      kind: "prd",
      topic: "x",
      managed: true,
      started: new Date().toISOString(),
    }),
  );
  return /** @type {number} */ (child.pid);
};
/** Over the limit, nudged and delivered: the next tick asks. */
const readyToAsk = (pid) =>
  writeSize({
    pid,
    size: 240_000,
    hardOverAt: iso(T0 - 3600),
    nudgeAt: iso(T0 - 1800),
    nudgeDeliveredAt: iso(T0 - 900),
  });
const answer = (id, text) =>
  execFileSync("node", [scripts("ask.mjs"), "answer", id, text], {
    env: { ...env, RISA_ASKS_DIR: asksDir },
    encoding: "utf8",
  });

describe("the tick", () => {
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-context-")));
    main = join(root, "repo");
    loops = join(main, ".loops");
    sessions = join(loops, ".sessions");
    asksDir = join(loops, ".asks");
    stubs = join(root, "stubs");
    clock = join(root, "clock");
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "osascript"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "osascript"), 0o755);
    mkdirSync(join(root, "iTerm.app"));
    execFileSync("git", ["init", "-q", "-b", "dev", main]);
    mkdirSync(join(main, "loops"), { recursive: true });
    mkdirSync(join(main, "backlog"), { recursive: true });
    for (const f of [
      "dispatch.mjs",
      "dispatch-context.mjs",
      "dispatch-stuck.mjs",
      "dispatch-pick.mjs",
      "context.mjs",
      "heartbeat.mjs",
      "keep-alive.mjs",
      "session-requests.mjs",
      "notices.mjs",
      "asks.mjs",
      "ask.mjs",
      "skeptics.mjs",
      "doc.mjs",
      "sessions.mjs",
      "captain.mjs",
      "flavor.mjs",
      "load-gate.mjs",
      "rotate.mjs",
      "open-session.mjs",
      "host.mjs",
      "planner-model.mjs",
      "config.mjs",
      "machine.mjs",
      "drain.mjs",
      "usage.mjs",
      "land-journal.mjs",
      "landed.mjs",
      "resume.mjs",
    ])
      copyFileSync(join(HERE, f), scripts(f));
    writeFileSync(scripts("open-session.sh"), OPEN_SH);
    writeFileSync(scripts("rotate.sh"), ROTATE_SH);
    writeFileSync(join(main, "backlog/backlog.mjs"), BACKLOG);
    for (const f of ["registry.mjs", "format.mjs"])
      copyFileSync(join(HERE, "../backlog", f), join(main, "backlog", f));
    writeFileSync(join(root, "load"), "1 1 1");
    env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RISA_CLAUDE_BIN: "claude-stub",
      RISA_ITERM_APP: join(root, "iTerm.app"),
      RISA_SESSIONS_DIR: "",
      RISA_ASKS_DIR: "",
      RISA_ASK_NOTIFY: "",
      RISA_LOAD_FILE: join(root, "load"),
      RISA_LOAD_BUSY: "8",
      RISA_LOAD_GATE: "",
      RISA_CONTEXT_LIMIT: "",
      RISA_CONTEXT_HARD_LIMIT: "",
      RISA_CONTEXT_NUDGE_MIN: "",
      RISA_CONTEXT_WATCH: "",
      RISA_KEEP_SESSIONS: "off",
      // The drain (drain.mjs): off, and never the machine's own readings or landings.
      RISA_USAGE_WATCH: "off",
      RISA_USAGE_DIR: "",
      RISA_LANDING_DIR: "",
      RISA_PICKUP_EVERY: "off",
      RISA_CLOCK_FILE: clock,
      STUB_STATE: stubs,
    };
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => {
    procs = [];
    for (const d of [stubs, sessions, asksDir, join(loops, ".context"), join(loops, ".briefs")])
      rmSync(d, { recursive: true, force: true });
    for (const f of [".dispatch.json", ".dispatch.log", ".dispatch.lock"])
      rmSync(join(loops, f), { force: true });
    mkdirSync(stubs, { recursive: true });
    setClock(T0);
  });
  afterEach(() => {
    for (const c of procs)
      try {
        process.kill(-c.pid, "SIGKILL");
      } catch {
        /* gone */
      }
  });

  it("leaves a session past only the soft limit alone", () => {
    const pid = liveSession();
    writeSize({ pid, size: 200_000, firstOverAt: iso(T0 - 3600) });
    expect(tick()).not.toContain("nudged");
    expect(readSizeFile().nudgeAt).toBeUndefined();
  });

  it("writes the nudge to the size record", () => {
    const pid = liveSession();
    writeSize({ pid, size: 240_000, hardOverAt: iso(T0 - 900) });
    expect(tick()).toContain("context: prd-x nudged");
    expect(readSizeFile().nudgeAt).toBe(iso(T0));
  });

  it("files a defaulting question under its own session and starts the push helper", () => {
    readyToAsk(liveSession());
    tick();
    const [ask] = listAsks(asksDir);
    expect(ask).toMatchObject({
      kind: "question",
      topic: "x",
      session: CONTEXT_SESSION,
      options: CONTEXT_OPTIONS,
      recommended: CONTEXT_OPTIONS[0],
      defaults: true,
    });
    expect(contextState()["prd-x"].askId).toBe(ask.id);
    expect(callsOf("open").filter((l) => l.includes("dispatch-push"))).toHaveLength(1);
    tick();
    expect(listAsks(asksDir)).toHaveLength(1);
  });

  it("rotates the topic mid-wave on the answer", () => {
    readyToAsk(liveSession());
    tick();
    answer(listAsks(asksDir)[0].id, CONTEXT_OPTIONS[0]);
    tick();
    expect(callsOf("rotate")).toEqual(["x --mid-wave --reason context"]);
  });

  it("waits a tick while a pnpm prd command runs under the session", () => {
    readyToAsk(liveSession(`bash -c "while :; do sleep 1; done # pnpm prd land x"; true`));
    tick();
    answer(listAsks(asksDir)[0].id, CONTEXT_OPTIONS[0]);
    for (let i = 0; i < 50; i++) {
      const out = tick(["--dry-run"]);
      if (out.includes("waits to rotate")) break;
    }
    expect(tick()).toContain("waits to rotate");
    expect(callsOf("rotate")).toEqual([]);
  });

  it("files one report for a refusing rotation and doesn't retry every tick", () => {
    readyToAsk(liveSession());
    writeFileSync(join(stubs, "refuse"), "");
    tick();
    answer(listAsks(asksDir)[0].id, CONTEXT_OPTIONS[0]);
    tick();
    tick();
    expect(callsOf("rotate")).toHaveLength(1);
    setClock(T0 + 900);
    tick();
    expect(callsOf("rotate")).toHaveLength(2);
    const reports = listAsks(asksDir).filter((a) => a.kind === "report");
    expect(reports).toHaveLength(1);
    expect(reports[0].text).toContain("uncommitted changes");
  });

  describe("for a backlog session", () => {
    const backlogSize = () => join(loops, ".context", "backlog.json");
    const brief = () => join(loops, ".briefs", "backlog.md");
    const liveBacklog = (script = "while :; do sleep 1; done") => {
      const child = spawn("bash", ["-c", script], { detached: true, stdio: "ignore" });
      procs.push(child);
      mkdirSync(sessions, { recursive: true });
      writeFileSync(
        join(sessions, "backlog.json"),
        JSON.stringify({
          pid: child.pid,
          kind: "backlog",
          managed: true,
          remote: "Kirk",
          started: new Date().toISOString(),
        }),
      );
      mkdirSync(dirname(backlogSize()), { recursive: true });
      writeFileSync(
        backlogSize(),
        JSON.stringify({
          pid: child.pid,
          size: 240_000,
          hardOverAt: iso(T0 - 3600),
          nudgeAt: iso(T0 - 1800),
          nudgeDeliveredAt: iso(T0 - 900),
        }),
      );
      return /** @type {number} */ (child.pid);
    };
    const writeBrief = (secs, text = "Fictional brief.\n") => {
      mkdirSync(dirname(brief()), { recursive: true });
      writeFileSync(brief(), text);
      utimesSync(brief(), secs, secs);
    };
    const rotationLines = () => callsOf("open").filter((l) => l.includes("rotate-into.sh"));
    const askAndAnswer = () => {
      tick();
      const [ask] = listAsks(asksDir);
      expect(ask).toMatchObject({
        topic: "backlog",
        session: CONTEXT_SESSION,
        defaults: true,
        recommended: CONTEXT_OPTIONS[1],
      });
      answer(ask.id, CONTEXT_OPTIONS[0]);
    };

    it("rotates with a brief written after the delivery", () => {
      const pid = liveBacklog();
      askAndAnswer();
      writeBrief(T0 - 60);
      tick();
      expect(callsOf("rotate")).toEqual([]);
      expect(rotationLines()).toHaveLength(1);
      const m = new RegExp(
        `rotate-into\\.sh backlog ${pid} --reason context --brief ${brief()} --captain ([A-Za-z]+) --title ([A-Za-z]+) --background`,
      ).exec(rotationLines()[0]);
      expect(m).not.toBeNull();
      // The main backlog session comes back as a new captain, its tab titled the same, never the last one.
      expect(ADMIRALS).toContain(m?.[1]);
      expect(m?.[2]).toBe(m?.[1]);
      expect(m?.[1]).not.toBe("Kirk");
    });

    it("rotates without a brief when the only one is older, and says so", () => {
      const pid = liveBacklog();
      askAndAnswer();
      writeBrief(T0 - 3000);
      tick();
      expect(rotationLines()[0]).toContain(`rotate-into.sh backlog ${pid} --reason context --no-brief`);
    });

    it("treats an empty brief as none", () => {
      liveBacklog();
      askAndAnswer();
      writeBrief(T0 - 60, "  \n");
      tick();
      expect(rotationLines()[0]).toContain("--no-brief");
    });

    it("holds the rotation while a pnpm backlog command runs under it", () => {
      liveBacklog(`bash -c "while :; do sleep 1; done # pnpm backlog ingest"; true`);
      askAndAnswer();
      for (let i = 0; i < 50; i++) if (tick(["--dry-run"]).includes("waits to rotate")) break;
      expect(tick()).toContain("waits to rotate");
      expect(rotationLines()).toEqual([]);
    });

    it("files one report when the rotation can't open", () => {
      liveBacklog();
      askAndAnswer();
      writeFileSync(
        scripts("open-session.sh"),
        `#!/usr/bin/env bash\n[[ "$*" != *rotate-into* ]] || { echo "no tab" >&2; exit 1; }\n`,
      );
      try {
        tick();
        tick();
      } finally {
        writeFileSync(scripts("open-session.sh"), OPEN_SH);
      }
      const reports = listAsks(asksDir).filter((a) => a.kind === "report");
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ topic: "backlog" });
      expect(reports[0].text).toContain("no tab");
    });
  });

  it("rotates a managed inbox session into a fresh one, with no brief", () => {
    const child = spawn("bash", ["-c", "while :; do sleep 1; done"], { detached: true, stdio: "ignore" });
    procs.push(child);
    mkdirSync(sessions, { recursive: true });
    const record = { pid: child.pid, kind: "inbox", managed: true, started: new Date().toISOString() };
    writeFileSync(join(sessions, "inbox.json"), JSON.stringify(record));
    mkdirSync(join(loops, ".context"), { recursive: true });
    writeFileSync(
      join(loops, ".context", "inbox.json"),
      JSON.stringify({
        pid: child.pid,
        size: 200_000,
        firstOverAt: iso(T0 - 3600),
        nudgeAt: iso(T0 - 1800),
        nudgeDeliveredAt: iso(T0 - 900),
      }),
    );
    tick();
    const [ask] = listAsks(asksDir);
    expect(ask).toMatchObject({ topic: "inbox", session: CONTEXT_SESSION });
    answer(ask.id, CONTEXT_OPTIONS[0]);
    tick();
    const lines = callsOf("open").filter((l) => l.includes("rotate-into.sh"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      `rotate-into.sh inbox ${child.pid} --reason context --title inbox --background`,
    );
    expect(callsOf("rotate")).toEqual([]);
  });

  it("writes nothing on a dry run", () => {
    readyToAsk(liveSession());
    const before = readFileSync(sizeFile(), "utf8");
    expect(tick(["--dry-run"])).toContain("context: would ask prd-x");
    expect(readFileSync(sizeFile(), "utf8")).toBe(before);
    expect(listAsks(asksDir)).toEqual([]);
    expect(existsSync(stateFile())).toBe(false);
    expect(callsOf("open")).toEqual([]);
  });

  it("does nothing with the watch off", () => {
    readyToAsk(liveSession());
    tick(["--once"], { RISA_CONTEXT_WATCH: "off" });
    expect(listAsks(asksDir)).toEqual([]);
  });

  it("dismisses the open question when the session drops under the limit", () => {
    const pid = liveSession();
    readyToAsk(pid);
    // The fake clock is ahead of the ask's real one: a long default keeps it open.
    tick(["--once"], { RISA_ASK_DEFAULT_MIN: "9999999" });
    const { id } = listAsks(asksDir)[0];
    writeSize({ pid, size: 1000 });
    tick();
    expect(getAsk(asksDir, id).doneAt).toBeTruthy();
    expect(contextState()).toEqual({});
  });

  it("the reopen bookkeeping never touches a context question", () => {
    createAsk(asksDir, {
      kind: "question",
      topic: "x",
      text: "fictional",
      session: CONTEXT_SESSION,
      options: CONTEXT_OPTIONS,
      recommended: null,
      defaults: false,
      waitMin: 30,
    });
    tick();
    expect(listAsks(asksDir)[0].doneAt ?? null).toBeNull();
  });
});
