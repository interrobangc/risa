// The dispatcher, sessions and asks parts of `pnpm prd status` (status-extra.mjs),
// from temporary folders: no real claude, tab, dispatcher or .loops.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAsk, settleAsk } from "./asks.mjs";
import { codeHash, codeTarget } from "./dispatch.mjs";
import { createRequest } from "./session-requests.mjs";
import {
  againstUsual,
  dispatcherPart,
  gatherWorkers,
  lastEntry,
  prdArgs,
  prdCommands,
  statusParts,
  targetOf,
  workersPart,
} from "./status-extra.mjs";

const HERE = new URL(".", import.meta.url).pathname;
// The tool's own code hash: a running dispatcher that started on it is current.
const TOOL_HASH = codeHash(join(HERE, ".."));
const NOW = Date.parse("2026-11-21T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const H = 3600_000;

let root, sessions, asks, empty;
const record = (name, fields) => writeFileSync(join(sessions, `${name}.json`), JSON.stringify(fields));

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "status-extra-")));
  sessions = join(root, "sessions");
  asks = join(root, "asks");
  empty = join(root, "empty");
  for (const d of [sessions, asks, empty]) mkdirSync(d);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("statusParts", () => {
  it("prints neither heading when there are no sessions and no asks", () => {
    expect(statusParts(empty, join(root, "missing"), { now: NOW })).toBe("");
  });

  it("lists sessions (live or ended, age, run-through, managed) and leaves out ended ones over a day old", () => {
    record("prd-a", { pid: 1, kind: "prd", started: ago(3 * H), auto: true, managed: true });
    record("prd-b", { pid: 2, kind: "prd", started: ago(2 * H), rotating: true });
    record("plan-c", { pid: 3, kind: "plan", started: ago(5 * H), ended: ago(H), exit: 0 });
    record("backlog", { pid: 4, kind: "backlog", started: ago(H) });
    record("hotfix-t", { pid: 5, kind: "hotfix", started: ago(H) });
    record("old", { pid: 4, started: ago(60 * H), ended: ago(48 * H), exit: 0 });
    const out = statusParts(sessions, asks, { now: NOW, live: (r) => !r.ended });
    expect(out).toContain("SESSIONS");
    expect(out).toMatch(/prd-a +prd +live +3h +run-through +managed +no size yet$/m);
    expect(out).toMatch(/prd-b +prd +live, rotating +2h +asks first +by hand +no size yet$/m);
    expect(out).toMatch(/plan-c +plan +ended +5h +asks first +by hand$/m);
    expect(out).toMatch(/backlog +backlog +live +1h/);
    expect(out).toMatch(/hotfix-t +hotfix +live +1h/);
    expect(out).not.toContain("old ");
    expect(out).not.toContain("OPEN ASKS");
  });

  it("shows a live session's size, the soft and hard marks and the keep; a stale record is no size", () => {
    const dir = join(root, "sized", "sessions");
    const context = join(root, "sized", ".context");
    mkdirSync(dir, { recursive: true });
    mkdirSync(context);
    const started = ago(H);
    const sized = (name, pid, size, kind = "prd") => {
      writeFileSync(join(dir, `${name}.json`), JSON.stringify({ pid, started, kind }));
      writeFileSync(join(context, `${name}.json`), JSON.stringify(size));
    };
    sized("prd-small", 11, { pid: 11, size: 90_000 });
    sized("prd-large", 12, { pid: 12, size: 172_400 });
    sized("prd-kept", 13, {
      pid: 13,
      size: 181_000,
      keep: { reason: "landing under way", until: new Date(NOW + H).toISOString() },
    });
    sized("prd-stale", 14, { pid: 99, size: 200_000 });
    sized("prd-huge", 15, { pid: 15, size: 230_000 });
    // A backlog session has no hard limit.
    sized("backlog", 16, { pid: 16, size: 230_000 }, "backlog");
    const out = statusParts(dir, join(root, "missing"), { now: NOW, live: () => true });
    expect(out).toMatch(/prd-small .*by hand +90k$/m);
    expect(out).toMatch(/prd-large .*by hand +172k over soft$/m);
    expect(out).toMatch(/prd-kept .*by hand +181k over soft, kept: landing under way$/m);
    expect(out).toMatch(/prd-huge .*by hand +230k OVER hard$/m);
    expect(out).toMatch(/backlog .*by hand +230k over soft$/m);
    expect(out).toMatch(/prd-stale .*by hand +no size yet$/m);
  });

  it("prints the open asks: the count and the oldest with its age", () => {
    createAsk(asks, {
      kind: "question",
      topic: "x",
      text: "Which way?",
      options: ["a", "b"],
      now: NOW - 26 * H,
    });
    createAsk(asks, { kind: "report", topic: "y", text: "Wave landed", now: NOW - 2 * H });
    const out = statusParts(empty, asks, { now: NOW });
    expect(out).not.toContain("SESSIONS");
    expect(out).toContain("OPEN ASKS: 2 (pnpm prd asks): 1 question awaiting an answer, 1 report");
    expect(out).toMatch(/oldest: a1 question x, 1d ago: Which way\?/);
  });

  it("counts the questions awaiting an answer and the defaulted ones apart", () => {
    const dir = join(root, "asks-defaulted");
    const q = (topic, extra) =>
      createAsk(dir, {
        kind: "question",
        topic,
        text: `${topic}?`,
        options: ["a", "b"],
        recommended: "a",
        ...extra,
      });
    q("d", { defaults: true, waitMin: 30, now: NOW - 3 * H });
    q("e", { defaults: true, waitMin: 30, now: NOW - 2 * H });
    q("f", { now: NOW - H });
    settleAsk(dir, "a1", { now: NOW - 2 * H });
    settleAsk(dir, "a2", { now: NOW - H });
    const out = statusParts(empty, dir, { now: NOW });
    expect(out).toContain("OPEN ASKS: 3 (pnpm prd asks): 1 question awaiting an answer, 2 decided for you");
    // The oldest line names the oldest awaiting an answer, not a decided one.
    expect(out).toMatch(/oldest: a3 question f, 1h ago: f\?/);
  });

  it("runs as a CLI from the two folders", () => {
    const r = spawnSync("node", [join(HERE, "status-extra.mjs")], {
      encoding: "utf8",
      env: { ...process.env, RISA_SESSIONS_DIR: empty, RISA_ASKS_DIR: asks },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("OPEN ASKS: 2");
    const none = spawnSync("node", [join(HERE, "status-extra.mjs")], {
      encoding: "utf8",
      env: {
        ...process.env,
        RISA_SESSIONS_DIR: empty,
        RISA_ASKS_DIR: empty,
        RISA_DISPATCH_MAIN: empty,
      },
    });
    expect(none.stdout).toBe("DISPATCHER: stopped: start it in a tab of its own with pnpm prd dispatch\n\n");
  });

  it("the CLI prints the pending requests, from beside the sessions folder or the named one", () => {
    const base = join(root, "requests");
    const beside = join(base, "sessions");
    const named = join(base, "named");
    mkdirSync(beside, { recursive: true });
    createRequest(join(base, ".requests"), { name: "beside", now: NOW });
    createRequest(named, { name: "named", now: NOW });
    const run = (extra) =>
      spawnSync("node", [join(HERE, "status-extra.mjs")], {
        encoding: "utf8",
        env: {
          ...process.env,
          RISA_SESSIONS_DIR: beside,
          RISA_ASKS_DIR: empty,
          RISA_DISPATCH_MAIN: empty,
          RISA_REQUESTS_DIR: "",
          ...extra,
        },
      }).stdout;
    const byDefault = run({});
    expect(byDefault).toContain("SESSION REQUESTS: 1 pending");
    expect(byDefault).toContain("backlog - beside");
    const override = run({ RISA_REQUESTS_DIR: named });
    expect(override).toContain("backlog - named");
    expect(override).not.toContain("backlog - beside");
  });
});

describe("the dispatcher's part", () => {
  let main, loops;
  beforeAll(() => {
    main = join(root, "main");
    loops = join(main, ".loops");
    mkdirSync(loops, { recursive: true });
  });
  const files = () => ({
    lock: join(loops, ".dispatch.lock"),
    state: join(loops, ".dispatch.json"),
    log: join(loops, ".dispatch.log"),
  });
  /** `pnpm prd status`'s CLI against this main checkout's .loops. */
  const cli = () =>
    spawnSync("node", [join(HERE, "status-extra.mjs")], {
      encoding: "utf8",
      env: {
        ...process.env,
        RISA_SESSIONS_DIR: empty,
        RISA_ASKS_DIR: empty,
        RISA_DISPATCH_MAIN: main,
      },
    }).stdout;

  it("prints its three states: stopped, running, paused and why", () => {
    expect(cli()).toBe("DISPATCHER: stopped: start it in a tab of its own with pnpm prd dispatch\n\n");
    // A lock whose pid is gone is a dispatcher that died (RISA-1030).
    writeFileSync(files().lock, "999999\n");
    expect(cli()).toMatch(
      /^DISPATCHER: dead \(pid 999999 gone; no clean stop\): restart it with pnpm prd dispatch --restart\n/,
    );
    writeFileSync(files().lock, `${process.pid}\n`);
    writeFileSync(files().state, JSON.stringify({ code: { hash: TOOL_HASH, pid: process.pid, at: ago(H) } }));
    expect(cli()).toBe(`DISPATCHER: running (pid ${process.pid}), code current\n\n`);
    writeFileSync(
      files().state,
      JSON.stringify({
        paused: { at: ago(2 * H), why: "usage limit" },
        code: { hash: "abc", pid: process.pid, at: ago(H) },
      }),
    );
    expect(dispatcherPart(files(), { now: NOW, current: () => null })).toBe(
      `DISPATCHER: running (pid ${process.pid}), paused, 2h ago: usage limit (pnpm prd dispatch --resume)\n\n`,
    );
    expect(dispatcherPart(files(), { now: NOW, holder: () => null, current: () => null })).toBe(
      "DISPATCHER: stopped (and paused, 2h ago: usage limit): start it in a tab of its own with pnpm prd dispatch\n\n",
    );
    writeFileSync(
      files().state,
      JSON.stringify({ paused: null, code: { hash: TOOL_HASH, pid: process.pid, at: ago(H) } }),
    );
    expect(cli()).toBe(`DISPATCHER: running (pid ${process.pid}), code current\n\n`);
  });

  it("tells a dispatcher that died from one stopped on purpose (RISA-1030)", () => {
    const dead = () => false;
    writeFileSync(files().lock, "424242\n");
    writeFileSync(
      files().state,
      JSON.stringify({ code: { hash: "abc", pid: 424242, at: ago(H) }, lastTickAt: NOW - 3 * H }),
    );
    writeFileSync(files().log, "2026-11-21T08:59:00Z start alpha\n");
    expect(dispatcherPart(files(), { now: NOW, alive: dead, current: () => "abc" })).toBe(
      "DISPATCHER: dead (pid 424242 gone; last tick 3h ago, no clean stop): restart it with pnpm prd dispatch --restart\n" +
        "last: 2026-11-21T08:59:00Z start alpha · last tick 3h ago (2026-11-21T09:00:00Z)\n\n",
    );
    // Paused when it died: both said.
    writeFileSync(
      files().state,
      JSON.stringify({ paused: { at: ago(4 * H), why: "usage limit" }, lastTickAt: NOW - 3 * H }),
    );
    expect(dispatcherPart(files(), { now: NOW, alive: dead, current: () => "abc" })).toMatch(
      /^DISPATCHER: dead \(pid 424242 gone; last tick 3h ago, no clean stop\), and paused, 4h ago: usage limit: restart it/,
    );
    // No lock file (a clean stop removes it): stopped.
    rmSync(files().lock);
    expect(dispatcherPart(files(), { now: NOW, alive: dead, current: () => "abc" })).toMatch(
      /^DISPATCHER: stopped \(and paused, 4h ago: usage limit\): start it in a tab of its own with pnpm prd dispatch\n/,
    );
    // A lock with no pid in it is no dispatcher's: stopped.
    writeFileSync(files().lock, "\n");
    expect(dispatcherPart(files(), { now: NOW, alive: dead, current: () => "abc" })).toMatch(
      /^DISPATCHER: stopped/,
    );
    // A live pid: running, as before.
    writeFileSync(files().lock, `${process.pid}\n`);
    writeFileSync(files().state, JSON.stringify({ code: { hash: "abc", pid: process.pid, at: ago(H) } }));
    expect(dispatcherPart(files(), { now: NOW, current: () => "abc" })).toMatch(
      new RegExp(`^DISPATCHER: running \\(pid ${process.pid}\\), code current\n`),
    );
    rmSync(files().log);
    writeFileSync(files().state, "{}");
  });

  it("reads the stop mark: stopped and why with one, dead without (RISA-1037)", () => {
    const dead = () => false;
    writeFileSync(files().lock, "424242\n");
    writeFileSync(
      files().state,
      JSON.stringify({
        stopped: { pid: 424242, stoppedAt: ago(2 * H), why: "uncaught exception: Error: boom" },
      }),
    );
    expect(dispatcherPart(files(), { now: NOW, alive: dead, current: () => "abc" })).toBe(
      "DISPATCHER: stopped (uncaught exception: Error: boom, 2h ago): start it in a tab of its own with pnpm prd dispatch\n\n",
    );
    // Another pid's mark: this one died.
    writeFileSync(
      files().state,
      JSON.stringify({ stopped: { pid: 7, stoppedAt: ago(2 * H), why: "SIGTERM" } }),
    );
    expect(dispatcherPart(files(), { now: NOW, alive: dead, current: () => "abc" })).toMatch(
      /^DISPATCHER: dead \(pid 424242 gone; no clean stop\)/,
    );
    // No lock: the mark says why, paused too.
    rmSync(files().lock);
    writeFileSync(
      files().state,
      JSON.stringify({
        paused: { at: ago(4 * H), why: "usage limit" },
        stopped: { pid: 7, stoppedAt: ago(2 * H), why: "SIGTERM by --stop" },
      }),
    );
    expect(dispatcherPart(files(), { now: NOW, alive: dead, current: () => "abc" })).toMatch(
      /^DISPATCHER: stopped \(SIGTERM by --stop, 2h ago; and paused, 4h ago: usage limit\): start it/,
    );
    writeFileSync(files().state, "{}");
  });

  it("says whether the running dispatcher's code is current or stale (B-809)", () => {
    writeFileSync(files().lock, `${process.pid}\n`);
    writeFileSync(files().state, JSON.stringify({ code: { hash: "abc", pid: process.pid, at: ago(H) } }));
    expect(dispatcherPart(files(), { now: NOW, current: () => "abc" })).toBe(
      `DISPATCHER: running (pid ${process.pid}), code current\n\n`,
    );
    expect(dispatcherPart(files(), { now: NOW, current: () => "def" })).toBe(
      `DISPATCHER: running (pid ${process.pid}), code stale (abc; the tool's checkout has def: it re-execs onto ${join(HERE, "..", "loops", "dispatch.mjs")} before its next tick)\n\n`,
    );
    // A record of another pid, or none: a dispatcher from before the code check.
    writeFileSync(files().state, JSON.stringify({ code: { hash: "abc", pid: 4, at: ago(H) } }));
    expect(dispatcherPart(files(), { now: NOW, current: () => "abc" })).toContain(
      ", code unknown (it predates the code check: pnpm prd dispatch --stop, then pnpm prd dispatch)",
    );
    writeFileSync(files().state, "{}");
    expect(dispatcherPart(files(), { now: NOW, current: () => "abc" })).toContain(", code unknown");
    // Stopped: no code line.
    expect(dispatcherPart(files(), { now: NOW, holder: () => null, current: () => "def" })).not.toContain(
      "code",
    );
  });

  it("names the same target the dispatcher follows: the release the link points to now (RISA-981)", () => {
    writeFileSync(files().lock, `${process.pid}\n`);
    const rel = join(root, "releases");
    const v2 = join(rel, "v2");
    writeFileSync(
      files().state,
      JSON.stringify({
        code: { hash: "abc", pid: process.pid, at: ago(H), root: join(rel, "v1"), follows: true },
      }),
    );
    // The target is dispatch.mjs's codeTarget: the link's folder when it follows it.
    const seen = [];
    const out = dispatcherPart(files(), {
      now: NOW,
      target: (code) => codeTarget(code.root, code.follows, v2),
      current: (r) => (seen.push(r), "def"),
    });
    expect(seen).toEqual([v2]);
    expect(out).toContain(
      `code stale (abc; the release installed now has def: it re-execs onto ${join(v2, "loops", "dispatch.mjs")} before its next tick)`,
    );
    // A checkout-run one's target is its own recorded folder.
    expect(targetOf({ hash: "abc", pid: 1, at: ago(H), root: join(rel, "co"), follows: false })).toBe(
      join(rel, "co"),
    );
  });

  it("shows the last tick's time beside the last logged change", () => {
    writeFileSync(files().lock, `${process.pid}\n`);
    writeFileSync(
      files().state,
      JSON.stringify({
        code: { hash: "abc", pid: process.pid, at: ago(H) },
        lastTickAt: NOW - 120_000,
        stuck: { lastTickAt: NOW - 3_600_000 },
      }),
    );
    writeFileSync(files().log, "2026-11-21T10:01:00Z start alpha\n");
    expect(dispatcherPart(files(), { now: NOW, current: () => "abc" })).toBe(
      `DISPATCHER: running (pid ${process.pid}), code current\nlast: 2026-11-21T10:01:00Z start alpha · last tick 2m ago (2026-11-21T11:58:00Z)\n\n`,
    );
    rmSync(files().log);
    expect(dispatcherPart(files(), { now: NOW, current: () => "abc" })).toContain(
      "\nlast tick 2m ago (2026-11-21T11:58:00Z)\n",
    );
    // A paused dispatcher's tick still beats: the stuck watch's older time isn't shown.
    writeFileSync(
      files().state,
      JSON.stringify({
        code: { hash: "abc", pid: process.pid, at: ago(H) },
        paused: { at: new Date(NOW - H).toISOString(), why: "t" },
        lastTickAt: NOW - 60_000,
        stuck: { lastTickAt: NOW - H },
      }),
    );
    expect(dispatcherPart(files(), { now: NOW, current: () => "abc" })).toContain(
      "\nlast tick 1m ago (2026-11-21T11:59:00Z)\n",
    );
    // A state an older release wrote has only the stuck watch's time.
    writeFileSync(
      files().state,
      JSON.stringify({
        code: { hash: "abc", pid: process.pid, at: ago(H) },
        stuck: { lastTickAt: NOW - 120_000 },
      }),
    );
    expect(dispatcherPart(files(), { now: NOW, current: () => "abc" })).toContain(
      "\nlast tick 2m ago (2026-11-21T11:58:00Z)\n",
    );
    writeFileSync(files().state, "{}");
  });

  it("adds its log's last entry, without the entry's indented reasons", () => {
    writeFileSync(
      files().log,
      [
        "2026-11-21T10:00:00Z started (pid 4, every 60s)",
        "2026-11-21T10:01:00Z start alpha",
        "  beta: waits for alpha",
        "  gamma: shares loops/ with alpha",
        "",
      ].join("\n"),
    );
    expect(lastEntry(files().log)).toBe("2026-11-21T10:01:00Z start alpha");
    expect(cli()).toContain("\nlast: 2026-11-21T10:01:00Z start alpha\n");
    expect(lastEntry(join(loops, "missing.log"))).toBeNull();
  });
});

describe("the workers part", () => {
  const at = (ms) => new Date(NOW - ms).toISOString();
  const M = 60_000;
  const fact = (extra = {}) => ({
    name: "topic-3",
    dir: "/fixture/.loops/topic-3",
    branch: "slice/topic/3",
    agents: [],
    unknown: false,
    lastActivityAt: null,
    stopped: false,
    running: [],
    leases: [],
    lastCommitAt: at(5 * H),
    changes: [],
    lastChangeAt: null,
    lastProgressAt: at(5 * H),
    ...extra,
  });
  const agent = (extra = {}) => ({
    session: "prd-topic",
    agent: "ab12cd34ef",
    agentType: "general-purpose",
    firstAt: at(40 * M),
    lastActivityAt: at(M),
    stoppedAt: null,
    running: [],
    ...extra,
  });
  const usual = { samples: 5, medianSeconds: 600, slowestSeconds: 900 };
  const part = (extra) =>
    workersPart({ facts: [], leases: [], commands: [], usual: () => null, now: NOW, ...extra });

  it("prints nothing when no worker is running", () => {
    expect(part({})).toBe("");
    // A plan worktree, and a slice with no heartbeat and nothing recent, aren't workers.
    expect(part({ facts: [fact({ branch: "plan/topic" }), fact({ unknown: true })] })).toBe("");
    expect(gatherWorkers(empty, { now: NOW, env: {} })).toBe("");
  });

  it("lists every lease holder and waiter with its age, usual time and state", () => {
    const out = part({
      facts: [fact()],
      leases: [
        {
          kind: "check",
          n: 1,
          waiting: false,
          worktree: "topic-3",
          what: "pnpm check (slice)",
          pid: 1,
          started: at(20 * M),
          live: true,
        },
        {
          kind: "check",
          n: null,
          waiting: true,
          worktree: "other-1",
          what: "pnpm check (quick)",
          pid: 2,
          started: at(2 * M),
          live: true,
        },
        {
          kind: "browser",
          n: 2,
          waiting: false,
          worktree: "topic-3",
          what: "roundtrip",
          pid: 3,
          started: at(3 * M),
          live: true,
        },
      ],
      usual: (q) => (q.kind === "check" && q.mode === "slice" && q.branchKind === "slice" ? usual : null),
    });
    expect(out).toMatch(/^WORKERS \(age, usual time, state\)$/m);
    expect(out).toMatch(/^lease check 1 +topic-3 +pnpm check \(slice\) +20m +usual 10m +held, slow$/m);
    expect(out).toMatch(/^lease check queued +other-1 +pnpm check \(quick\) +2m +usual - +waiting$/m);
    expect(out).toMatch(/^lease browser 2 +topic-3 +roundtrip +3m +usual - +held$/m);
    expect(out.endsWith("\n\n")).toBe(true);
  });

  it("lists each pnpm prd command under a session, and each slice agent's state", () => {
    const out = part({
      commands: [{ session: "prd-topic", pid: 7, args: "watch --wait", ageSeconds: 1800 }],
      facts: [
        fact({
          agents: [
            agent({ running: [{ id: "t1", tool: "Bash", at: at(M), command: "pnpm prd check --quick" }] }),
            agent({ agent: "stopped1", stoppedAt: at(5 * M), lastActivityAt: at(5 * M) }),
            agent({ agent: "quiet1", lastActivityAt: at(25 * M), firstAt: at(2 * H) }),
            agent({ agent: "active1" }),
          ],
        }),
        fact({
          name: "topic-4",
          unknown: true,
          running: [{ source: "process", pid: 9, command: "node vitest run", since: at(M) }],
        }),
      ],
      usual: (q) => (q.kind === "slice" ? { samples: 4, medianSeconds: 3000, slowestSeconds: 4000 } : null),
    });
    expect(out).toMatch(/^command +prd-topic +pnpm prd watch --wait +30m +usual - +running$/m);
    expect(out).toMatch(
      /^agent ab12cd34 +topic-3 +prd-topic +40m +usual 50m +running Bash: pnpm prd check --quick$/m,
    );
    expect(out).toMatch(/^agent stopped1 +topic-3 +prd-topic +40m +usual 50m +stopped 5m ago$/m);
    expect(out).toMatch(/^agent quiet1 +topic-3 +prd-topic +2h +usual 50m +quiet 25m, slow$/m);
    expect(out).toMatch(/^agent active1 +topic-3 +prd-topic +40m +usual 50m +active, last call 1m ago$/m);
    expect(out).toMatch(/^agent \? +topic-4 +no heartbeat +\? +usual 50m +unknown; pid 9: node vitest run$/m);
  });

  it("slow only past the slowest of at least three samples", () => {
    expect(againstUsual(1000, usual)).toBe("slow");
    expect(againstUsual(800, usual)).toBe("");
    expect(againstUsual(1000, { ...usual, samples: 2 })).toBe("");
    expect(againstUsual(null, usual)).toBe("");
  });

  it("finds the outermost pnpm prd command under a live session", () => {
    expect(prdArgs("node /opt/pnpm/bin/pnpm.cjs prd check --quick slice hand-off")).toBe(
      "check --quick slice hand-off",
    );
    expect(prdArgs("pnpm -s -C /x prd status")).toBe("status");
    expect(prdArgs("bash loops/prd.sh dev-sync")).toBe("dev-sync");
    expect(prdArgs("/bin/zsh -c for n in 1 2; do pnpm prd rm x-$n; done")).toBeNull();
    expect(prdArgs("node vitest run")).toBeNull();
    const table = [
      { pid: 100, ppid: 1, ageSeconds: 3600, command: "claude" },
      { pid: 101, ppid: 100, ageSeconds: 60, command: "/bin/zsh -c pnpm prd check" },
      { pid: 102, ppid: 101, ageSeconds: 60, command: "node /opt/pnpm.cjs prd check" },
      { pid: 103, ppid: 102, ageSeconds: 59, command: "bash loops/prd.sh check" },
      { pid: 200, ppid: 1, ageSeconds: 10, command: "pnpm prd status" },
    ];
    expect(prdCommands(table, new Map([[100, "prd-topic"]]))).toEqual([
      { session: "prd-topic", pid: 102, args: "check", ageSeconds: 60 },
    ]);
  });

  it("the CLI adds a live lease holder from beside the sessions folder", () => {
    const base = join(root, "workers-cli");
    const own = join(base, "sessions");
    const lease = join(base, ".lease", "check", "1");
    mkdirSync(own, { recursive: true });
    mkdirSync(lease, { recursive: true });
    writeFileSync(
      join(lease, "name"),
      `kind=check\nworktree=topic-3\ncheck=pnpm check (slice)\npid=${process.pid}\nstarted=${Math.floor(Date.now() / 1000)}\n`,
    );
    const out = spawnSync("node", [join(HERE, "status-extra.mjs")], {
      encoding: "utf8",
      env: {
        ...process.env,
        RISA_SESSIONS_DIR: own,
        RISA_ASKS_DIR: empty,
        RISA_DISPATCH_MAIN: empty,
        RISA_LEASE_ROOT: "",
        RISA_BROWSER_LEASES: "",
        RISA_RUN_LOG: join(base, "none.jsonl"),
        RISA_CHECK_LOG: join(base, "none.log"),
      },
    }).stdout;
    expect(out).toMatch(/^lease check 1 +topic-3 +pnpm check \(slice\) +\d+s +usual - +held$/m);
  });
});
