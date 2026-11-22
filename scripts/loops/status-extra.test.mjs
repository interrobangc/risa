// The sessions and asks parts of `pnpm prd status` (status-extra.mjs), from
// temporary folders: no real claude, tab or .loops.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAsk } from "./asks.mjs";
import { statusParts } from "./status-extra.mjs";

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
    expect(out).toContain("OPEN ASKS: 2");
    expect(out).toMatch(/oldest: a1 question x, 1d ago: Which way\?/);
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
      env: { ...process.env, CARETOOK_SESSIONS_DIR: empty, CARETOOK_ASKS_DIR: empty },
    });
    expect(none.stdout).toBe("");
  });
});
