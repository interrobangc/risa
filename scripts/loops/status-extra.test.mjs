// The dispatcher, sessions and asks parts of `pnpm prd status` (status-extra.mjs),
// from temporary folders: no real claude, tab, dispatcher or .loops.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAsk, settleAsk } from "./asks.mjs";
import { dispatcherPart, lastEntry, statusParts } from "./status-extra.mjs";

const HERE = new URL(".", import.meta.url).pathname;
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
    record("prd-a", { pid: 1, started: ago(3 * H), auto: true, managed: true });
    record("prd-b", { pid: 2, started: ago(2 * H), rotating: true });
    record("plan-c", { pid: 3, started: ago(5 * H), ended: ago(H), exit: 0 });
    record("old", { pid: 4, started: ago(60 * H), ended: ago(48 * H), exit: 0 });
    const out = statusParts(sessions, asks, { now: NOW, live: (r) => !r.ended });
    expect(out).toContain("SESSIONS");
    expect(out).toMatch(/prd-a +live +3h +run-through +managed$/m);
    expect(out).toMatch(/prd-b +live, rotating +2h +asks first +by hand$/m);
    expect(out).toMatch(/plan-c +ended +5h +asks first +by hand$/m);
    expect(out).not.toContain("old ");
    expect(out).not.toContain("OPEN ASKS");
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
      env: { ...process.env, CARETOOK_SESSIONS_DIR: empty, CARETOOK_ASKS_DIR: asks },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("OPEN ASKS: 2");
    const none = spawnSync("node", [join(HERE, "status-extra.mjs")], {
      encoding: "utf8",
      env: {
        ...process.env,
        CARETOOK_SESSIONS_DIR: empty,
        CARETOOK_ASKS_DIR: empty,
        CARETOOK_DISPATCH_MAIN: empty,
      },
    });
    expect(none.stdout).toBe("DISPATCHER: stopped: start it in a tab of its own with pnpm prd dispatch\n\n");
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
        CARETOOK_SESSIONS_DIR: empty,
        CARETOOK_ASKS_DIR: empty,
        CARETOOK_DISPATCH_MAIN: main,
      },
    }).stdout;

  it("prints its three states: stopped, running, paused and why", () => {
    expect(cli()).toBe("DISPATCHER: stopped: start it in a tab of its own with pnpm prd dispatch\n\n");
    // A lock whose pid is gone is stopped too.
    writeFileSync(files().lock, "999999\n");
    expect(cli()).toMatch(/^DISPATCHER: stopped:/);
    writeFileSync(files().lock, `${process.pid}\n`);
    expect(cli()).toBe(`DISPATCHER: running (pid ${process.pid})\n\n`);
    writeFileSync(files().state, JSON.stringify({ paused: { at: ago(2 * H), why: "usage limit" } }));
    expect(dispatcherPart(files(), { now: NOW })).toBe(
      `DISPATCHER: running (pid ${process.pid}), paused, 2h ago: usage limit (pnpm prd dispatch --resume)\n\n`,
    );
    expect(dispatcherPart(files(), { now: NOW, holder: () => null })).toBe(
      "DISPATCHER: stopped (and paused, 2h ago: usage limit): start it in a tab of its own with pnpm prd dispatch\n\n",
    );
    writeFileSync(files().state, JSON.stringify({ paused: null }));
    expect(cli()).toBe(`DISPATCHER: running (pid ${process.pid})\n\n`);
  });

  it("adds its log's last entry, without the entry's indented reasons", () => {
    writeFileSync(
      files().log,
      [
        "2026-11-21T10:00:00Z started (pid 4, every 60s)",
        "2026-11-21T10:01:00Z start alpha",
        "  beta: waits for alpha",
        "  gamma: shares scripts/loops/ with alpha",
        "",
      ].join("\n"),
    );
    expect(lastEntry(files().log)).toBe("2026-11-21T10:01:00Z start alpha");
    expect(cli()).toContain("\nlast: 2026-11-21T10:01:00Z start alpha\n");
    expect(lastEntry(join(loops, "missing.log"))).toBeNull();
  });
});
