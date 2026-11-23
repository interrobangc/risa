// The notice board: the store (notices.mjs) against throwaway directories, and
// `pnpm prd notice | notices` plus the lines gated commands print, through
// prd.sh in a throwaway main checkout (scripts copied in, a worktree in its
// .loops). Nothing reads or writes the real .loops.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_TEXT,
  createNotice,
  gateLines,
  listNotices,
  NoticeError,
  statusPart,
  withdrawNotice,
} from "./notices.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const NOW = Date.parse("2026-11-22T12:00:00Z");
const MIN = 60_000;

let root;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "notices-")));
});
afterAll(() => {
  // An unreadable board left by a test would stop the removal.
  for (const d of readdirSync(root)) chmodSync(join(root, d), 0o755);
  rmSync(root, { recursive: true, force: true });
});
const fresh = () => mkdtempSync(join(root, "board-"));

describe("the notice store", () => {
  it("never gives two creates the same id, even after the first expired and was pruned", () => {
    const dir = fresh();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(createNotice(dir, { text: `n ${i}`, now: NOW }).id);
    expect(new Set(ids).size).toBe(5);
    const short = createNotice(dir, { text: "short", minutes: 1, now: NOW });
    listNotices(dir, { now: NOW + 2 * MIN });
    const next = createNotice(dir, { text: "later", now: NOW + 2 * MIN });
    expect(next.id).not.toBe(short.id);
    expect([...ids, short.id]).not.toContain(next.id);
  });

  it("takes the next id when another create holds the one it wanted", () => {
    const dir = fresh();
    writeFileSync(
      join(dir, "n1.json"),
      JSON.stringify({
        id: "n1",
        text: "x",
        postedAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + MIN).toISOString(),
      }),
    );
    expect(createNotice(dir, { text: "mine", now: NOW }).id).toBe("n2");
  });

  it("lists the live ones oldest first, and deletes an expired one's file on the next list", () => {
    const dir = fresh();
    const a = createNotice(dir, { text: "a", session: "prd-a", topic: "a", minutes: 10, now: NOW });
    const b = createNotice(dir, { text: "b", minutes: 60, now: NOW + MIN });
    expect(listNotices(dir, { now: NOW + 2 * MIN }).map((n) => n.id)).toEqual([a.id, b.id]);
    expect(listNotices(dir, { now: NOW + 11 * MIN }).map((n) => n.id)).toEqual([b.id]);
    expect(existsSync(join(dir, `${a.id}.json`))).toBe(false);
    expect(existsSync(join(dir, `${b.id}.json`))).toBe(true);
  });

  it("lives 60 minutes by default and refuses a life over 24 hours", () => {
    const dir = fresh();
    const n = createNotice(dir, { text: "x", now: NOW });
    expect(Date.parse(n.expiresAt) - NOW).toBe(60 * MIN);
    expect(Date.parse(createNotice(dir, { text: "y", minutes: 1440, now: NOW }).expiresAt) - NOW).toBe(
      1440 * MIN,
    );
    expect(() => createNotice(dir, { text: "z", minutes: 1441, now: NOW })).toThrow(/24 hours/);
    expect(() => createNotice(dir, { text: "z", minutes: 0, now: NOW })).toThrow(NoticeError);
  });

  it("refuses an empty or overlong line, and folds whitespace into one line", () => {
    const dir = fresh();
    expect(() => createNotice(dir, { text: "  \n ", now: NOW })).toThrow(/needs its text/);
    expect(() => createNotice(dir, { text: "x".repeat(MAX_TEXT + 1), now: NOW })).toThrow(/200 characters/);
    expect(createNotice(dir, { text: "x".repeat(MAX_TEXT), now: NOW }).text).toHaveLength(MAX_TEXT);
    expect(createNotice(dir, { text: "two\n  lines", now: NOW }).text).toBe("two lines");
  });

  it("withdraws a live notice, and refuses an unknown or expired id", () => {
    const dir = fresh();
    const n = createNotice(dir, { text: "x", minutes: 5, now: NOW });
    const m = createNotice(dir, { text: "y", minutes: 1, now: NOW });
    expect(() => withdrawNotice(dir, "n99", { now: NOW })).toThrow(/no live notice n99/);
    expect(() => withdrawNotice(dir, "bogus", { now: NOW })).toThrow(NoticeError);
    expect(() => withdrawNotice(dir, m.id, { now: NOW + 2 * MIN })).toThrow(/no live notice/);
    expect(withdrawNotice(dir, n.id, { now: NOW }).id).toBe(n.id);
    expect(listNotices(dir, { now: NOW })).toEqual([]);
    expect(() => withdrawNotice(dir, n.id, { now: NOW })).toThrow(/no live notice/);
  });
});

describe("gateLines and statusPart", () => {
  const notice = (id, session, text = "t") => ({
    id,
    session,
    topic: session?.replace(/^prd-/, "") ?? null,
    text,
    postedAt: new Date(NOW - 3 * MIN).toISOString(),
    expiresAt: new Date(NOW + 57 * MIN).toISOString(),
  });

  it("leaves out the caller's own notices, and prints nothing when only those are live", () => {
    const lines = gateLines([notice("n1", "prd-a", "mine"), notice("n2", "prd-b", "theirs")], "prd-a", {
      now: NOW,
    });
    expect(lines).toEqual(["notice n2 from prd-b (b, 3m ago): theirs"]);
    expect(gateLines([notice("n1", "prd-a")], "prd-a", { now: NOW })).toEqual([]);
  });

  it("prints at most five lines, the last counting the rest", () => {
    const many = Array.from({ length: 8 }, (_, i) => notice(`n${i + 1}`, `prd-t${i}`));
    const lines = gateLines(many, null, { now: NOW });
    expect(lines).toHaveLength(5);
    expect(lines[3]).toContain("n4");
    expect(lines[4]).toBe("… and 4 more: pnpm prd notices");
    expect(gateLines(many.slice(0, 5), null, { now: NOW })).toHaveLength(5);
  });

  it("status prints only the count, and nothing when there are none", () => {
    expect(statusPart([])).toBe("");
    expect(statusPart([notice("n1", "prd-a"), notice("n2", null)])).toBe("NOTICES: 2 (pnpm prd notices)\n");
  });
});

describe("pnpm prd notice, notices and the gated commands", () => {
  let main, wt, board;
  const git = (dir, ...a) =>
    execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
  const prd = (args, { cwd = wt, env = {} } = {}) =>
    spawnSync("bash", [join(main, "scripts/loops/prd.sh"), ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CARETOOK_NOTICES_DIR: board, CARETOOK_SESSION: "", ...env },
    });

  beforeAll(() => {
    main = join(root, "main");
    mkdirSync(join(main, "scripts"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "dev", main]);
    git(main, "config", "user.email", "t@example.com");
    git(main, "config", "user.name", "T");
    git(main, "config", "core.hooksPath", "/dev/null");
    cpSync(HERE, join(main, "scripts/loops"), { recursive: true, filter: (s) => !s.endsWith(".test.mjs") });
    writeFileSync(join(main, ".gitignore"), ".loops/\n");
    git(main, "add", "-A");
    git(main, "commit", "-qm", "base");
    wt = join(main, ".loops", "x");
    git(main, "worktree", "add", "-q", "-b", "prd/x", wt);
  });
  beforeEach(() => {
    board = mkdtempSync(join(root, "cli-"));
  });

  it("notice prints the id, and notices lists it with its session, topic, age and time left", () => {
    const r = prd(["notice", "landing x soon", "--for", "90"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("n1");
    const l = prd(["notices"], { cwd: root });
    expect(l.status, l.stderr).toBe(0);
    expect(l.stdout).toMatch(/^n1 {2}prd-x {2}x {2}\d+s ago, (89m|1h) left: landing x soon$/m);
    const j = JSON.parse(prd(["notices", "--json"], { cwd: root }).stdout);
    expect(j).toMatchObject([{ id: "n1", session: "prd-x", topic: "x", text: "landing x soon" }]);
    expect(prd(["notices", "--done", "n1"], { cwd: root }).stdout).toContain("n1 withdrawn");
    expect(prd(["notices"], { cwd: root }).stdout).toContain("No live notices.");
  });

  it("refuses a bad --for, an overlong line and an unknown id, exiting non-zero", () => {
    expect(prd(["notice", "x", "--for", "1500"]).stderr).toMatch(/24 hours/);
    expect(prd(["notice", "x", "--for", "soon"]).status).not.toBe(0);
    expect(prd(["notice", "y".repeat(201)]).status).not.toBe(0);
    const r = prd(["notices", "--done", "n7"], { cwd: root });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no live notice n7");
  });

  it("a gated command prints another session's notice on stderr and not its own", () => {
    createNotice(board, { text: "my own", session: "prd-x", topic: "x" });
    createNotice(board, { text: "landed y: sync later", session: "prd-y", topic: "y" });
    const r = prd(["sync"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("up to date");
    expect(r.stdout).not.toContain("notice");
    expect(r.stderr).toMatch(/^notice n2 from prd-y \(y, \d+s ago\): landed y: sync later$/m);
    expect(r.stderr).not.toContain("my own");
  });

  it("prints at most five lines", () => {
    for (let i = 0; i < 7; i++) createNotice(board, { text: `other ${i}`, session: `prd-o${i}` });
    const r = prd(["sync"]);
    expect(r.stderr.split("\n").filter((l) => l.startsWith("notice ") || l.startsWith("… and"))).toHaveLength(
      5,
    );
  });

  it("keeps the command's own exit code when the board is unreadable", () => {
    createNotice(board, { text: "hidden", session: "prd-y" });
    chmodSync(board, 0o000);
    try {
      const ok = prd(["sync"]);
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stderr).not.toContain("hidden");
      const bad = prd(["sync"], { cwd: root });
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("inside a PRD's worktree");
    } finally {
      chmodSync(board, 0o755);
    }
  });

  it("status prints the live notices' count; check --times prints none first", () => {
    createNotice(board, { text: "for status", session: "prd-y", topic: "y" });
    const s = prd(["status"]);
    expect(s.stdout).toMatch(/^NOTICES: 1 \(pnpm prd notices\)$/m);
    expect(s.stdout).not.toContain("for status");
    const t = prd(["check", "--times"], { env: { CARETOOK_CHECK_LOG: join(board, "none.log") } });
    expect(t.stderr).not.toContain("for status");
  });
});
