// The worker reader (workers.mjs), on throwaway git repos and lease folders in a
// temporary .loops: no real worktree, lease or session.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitInit, withOldGit } from "./git-init.mjs";
import { factsOf, gitProgress, processCwds, readLeases, selfOf, workerFacts } from "./workers.mjs";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const FAKE_PID = 99_999_999;
const git = (dir, ...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });

let root, loops, sessions, slice;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "workers-")));
  loops = join(root, "main", ".loops");
  sessions = join(loops, ".sessions");
  slice = join(loops, "topic-3");
  mkdirSync(sessions, { recursive: true });
  sliceRepo(slice);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

// A slice's checkout at DIR: on its slice branch, one commit, a .gitignore.
function sliceRepo(dir) {
  gitInit(["-q", "-b", "slice/topic/3", dir]);
  git(dir, "config", "user.email", "loop@example.test");
  git(dir, "config", "user.name", "Fixture Loop");
  writeFileSync(join(dir, ".gitignore"), "cache/\n*.log\n");
  writeFileSync(join(dir, "a.mjs"), "export const a = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "chore: start");
}

describe("the slice fixture", () => {
  it("stops at a failed git init, before any later git command", () => {
    const dir = join(root, "old-git");
    const { error, calls } = withOldGit(() => sliceRepo(dir));
    expect(error?.message).toMatch(/^git init -q -b slice\/topic\/3 .* failed \(exit 129\)/);
    expect(calls).toEqual([`init -q -b slice/topic/3 ${dir}`]);
  });
});

describe("gitProgress", () => {
  it("a change to an ignored file is not progress; a tracked or unignored one is", () => {
    const clean = gitProgress(slice);
    expect(clean).toMatchObject({ branch: "slice/topic/3", changes: [], lastChangeAt: null });
    expect(clean.lastCommitAt).toBeTruthy();

    mkdirSync(join(slice, "cache"), { recursive: true });
    writeFileSync(join(slice, "cache", "blob"), "x");
    writeFileSync(join(slice, "run.log"), "x");
    expect(gitProgress(slice)).toMatchObject({ changes: [], lastChangeAt: null });

    writeFileSync(join(slice, "new.mjs"), "export {};\n");
    const when = new Date(NOW);
    utimesSync(join(slice, "new.mjs"), when, when);
    expect(gitProgress(slice)).toMatchObject({ changes: ["new.mjs"], lastChangeAt: when.toISOString() });

    writeFileSync(join(slice, "a.mjs"), "export const a = 2;\n");
    expect(gitProgress(slice).changes.sort()).toEqual(["a.mjs", "new.mjs"]);
    git(slice, "checkout", "--", "a.mjs");
    rmSync(join(slice, "new.mjs"));
  });
});

describe("readLeases", () => {
  it("reads held and queued leases of every kind, with their holder's liveness", () => {
    const leases = join(root, "lease");
    const name = (dir, fields) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "name"),
        Object.entries(fields)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n") + "\n",
      );
    };
    name(join(leases, "check", "1"), {
      kind: "check",
      worktree: "topic-3",
      check: "pnpm check (slice)",
      pid: process.pid,
      started: NOW / 1000 - 300,
    });
    name(join(leases, "check", ".waiting", "123"), {
      kind: "check",
      worktree: "other-1",
      check: "pnpm check (quick) (waiting for a lease)",
      pid: FAKE_PID,
      started: NOW / 1000,
    });
    name(join(leases, "browser", "2"), {
      kind: "browser",
      worktree: "topic-3",
      check: "roundtrip",
      pid: FAKE_PID,
    });
    const all = readLeases(leases).sort((a, b) => `${a.kind}${a.n}`.localeCompare(`${b.kind}${b.n}`));
    expect(all).toEqual([
      expect.objectContaining({ kind: "browser", n: 2, worktree: "topic-3", live: false, started: null }),
      expect.objectContaining({
        kind: "check",
        n: 1,
        what: "pnpm check (slice)",
        live: true,
        started: new Date(NOW - 300_000).toISOString(),
      }),
      expect.objectContaining({
        kind: "check",
        n: null,
        waiting: true,
        what: "pnpm check (quick)",
        live: false,
      }),
    ]);
    expect(readLeases(join(root, "missing"))).toEqual([]);
  });
});

describe("factsOf", () => {
  const worktree = (extra = {}) => ({
    name: "topic-3",
    dir: "/fixture/.loops/topic-3",
    branch: "slice/topic/3",
    lastCommitAt: "2026-11-24T11:00:00.000Z",
    changes: [],
    lastChangeAt: null,
    ...extra,
  });
  const beat = (extra = {}) => ({
    session: "prd-topic",
    pid: FAKE_PID,
    agent: "ab12",
    worktree: "topic-3",
    firstAt: "2026-11-24T10:00:00.000Z",
    lastStart: "2026-11-24T11:50:00.000Z",
    lastEnd: "2026-11-24T11:40:00.000Z",
    stoppedAt: null,
    running: {},
    ...extra,
  });
  const facts = (extra) =>
    factsOf({ worktrees: [worktree()], heartbeats: [], leases: [], processes: [], now: NOW, ...extra })[0];

  it("a started, unfinished call is a running command", () => {
    const f = facts({
      heartbeats: [
        beat({
          running: { t1: { tool: "Bash", at: "2026-11-24T11:50:00.000Z", command: "pnpm prd check" } },
        }),
      ],
    });
    expect(f.unknown).toBe(false);
    expect(f.running).toEqual([
      expect.objectContaining({ source: "call", agent: "ab12", tool: "Bash", command: "pnpm prd check" }),
    ]);
    expect(f.lastActivityAt).toBe("2026-11-24T11:50:00.000Z");
    expect(f.stopped).toBe(false);
  });

  it("a live process in the worktree counts; this reader's own, claude and login shells don't", () => {
    const proc = (pid, cwd, command) => ({ pid, ppid: 1, cwd, ageSeconds: 120, command });
    const f = facts({
      processes: [
        proc(11, "/fixture/.loops/topic-3/web/app", "node vitest run"),
        proc(12, "/fixture/.loops/topic-3", "/usr/local/bin/claude --settings x"),
        proc(13, "/fixture/.loops/topic-3", "-zsh"),
        proc(14, "/fixture/.loops/topic-3", "node status-extra.mjs"),
        proc(15, "/fixture/.loops/topic-30", "node other"),
        proc(16, null, "node unknown cwd"),
      ],
      self: [14],
    });
    expect(f.running).toEqual([
      {
        source: "process",
        pid: 11,
        command: "node vitest run",
        since: new Date(NOW - 120_000).toISOString(),
      },
    ]);
  });

  it("a slice no heartbeat names is unknown; a stop with nothing running is stopped", () => {
    expect(facts({ heartbeats: [beat({ worktree: "elsewhere" })] }).unknown).toBe(true);
    const stopped = facts({ heartbeats: [beat({ stoppedAt: "2026-11-24T11:55:00.000Z" })] });
    expect(stopped).toMatchObject({
      unknown: false,
      stopped: true,
      lastActivityAt: "2026-11-24T11:55:00.000Z",
    });
  });

  it("progress is the later of the last commit and the last change; leases are the worktree's live ones", () => {
    const f = factsOf({
      worktrees: [worktree({ lastChangeAt: "2026-11-24T11:30:00.000Z", changes: ["a.mjs"] })],
      heartbeats: [],
      leases: [
        {
          kind: "check",
          n: 1,
          waiting: false,
          worktree: "topic-3",
          what: "x",
          pid: 1,
          started: null,
          live: true,
        },
        {
          kind: "check",
          n: 2,
          waiting: false,
          worktree: "topic-3",
          what: "x",
          pid: 2,
          started: null,
          live: false,
        },
        {
          kind: "check",
          n: 3,
          waiting: false,
          worktree: "other",
          what: "x",
          pid: 3,
          started: null,
          live: true,
        },
      ],
      processes: [],
      now: NOW,
    })[0];
    expect(f.lastProgressAt).toBe("2026-11-24T11:30:00.000Z");
    expect(f.leases.map((l) => l.n)).toEqual([1]);
  });
});

describe("workerFacts", () => {
  let child;
  afterAll(() => child?.kill("SIGKILL"));

  it("gathers a real worktree, its heartbeat and a live process in it", async () => {
    const beats = join(loops, ".heartbeat", "prd-topic");
    mkdirSync(beats, { recursive: true });
    writeFileSync(
      join(beats, "ab12.json"),
      JSON.stringify({
        pid: FAKE_PID,
        agent: "ab12",
        worktree: "topic-3",
        lastStart: new Date(NOW).toISOString(),
        running: {},
      }),
    );
    child = spawn("sleep", ["30"], { cwd: slice, stdio: "ignore" });
    await new Promise((resolve) => child.once("spawn", resolve));
    const [f] = workerFacts({ loops, sessionsDir: sessions, now: NOW });
    expect(f).toMatchObject({ name: "topic-3", branch: "slice/topic/3", unknown: false, changes: [] });
    expect(f.agents.map((a) => a.agent)).toEqual(["ab12"]);
    expect(f.running).toContainEqual(expect.objectContaining({ source: "process", pid: child.pid }));
    // A heartbeat of a session that isn't live is left out.
    const [g] = workerFacts({ loops, sessionsDir: sessions, live: () => false, processes: [], now: NOW });
    expect(g).toMatchObject({ agents: [], unknown: true });
  });

  it("selfOf is the pid, its ancestors and its pipeline", () => {
    const table = [
      { pid: 2, ppid: 1 },
      { pid: 3, ppid: 2 },
      { pid: 4, ppid: 3 },
      { pid: 5, ppid: 3 },
      { pid: 6, ppid: 2 },
    ];
    expect([...new Set(selfOf(4, table))].sort()).toEqual([2, 3, 4, 5]);
    expect(processCwds().some((p) => p.pid === process.pid)).toBe(true);
  });
});
