// finish.mjs's pure decision, sessions.mjs's liveIn on a stub process table,
// and landedWithCode on a throwaway repo.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { finishDecision, landedWithCode, reportKey } from "./finish.mjs";
import { liveIn } from "./sessions.mjs";

const NOW = Date.parse("2026-03-01T12:00:00Z");
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const idle = (extra = {}) => ({
  running: {},
  firstAt: ago(60),
  lastEnd: ago(30),
  stoppedAt: ago(20),
  ...extra,
});

/** A landed topic with a docs tail, its worktree clean, one idle recorded session. */
const facts = (over = {}) => ({
  topic: "t",
  landed: true,
  sha: "aaa",
  tail: "docs",
  tailCommits: 1,
  branch: "prd/t",
  tip: "tip1",
  worktree: { name: "t", dir: "/r/.loops/t", dirty: false },
  slot: "/r/.loops/.slots/2",
  sliceWorktrees: [],
  row: { topic: "t", flags: [] },
  sessions: [{ name: "prd-t", pid: 11, heartbeats: [idle()] }],
  unrecorded: [],
  journal: null,
  now: NOW,
  idleMin: 10,
  reported: [],
  ...over,
});

describe("finishDecision", () => {
  it("leaves a topic that hasn't landed running", () => {
    expect(finishDecision(facts({ landed: false })).kind).toBe("running");
  });

  it("is clean once landed with no worktree, no slot and its row done", () => {
    const d = finishDecision(
      facts({ worktree: null, slot: null, sessions: [], row: { topic: "t", flags: ["done"] } }),
    );
    expect(d.kind).toBe("clean");
  });

  it("waits on a recorded session with a running call, or an event 5 minutes ago", () => {
    const running = finishDecision(
      facts({
        sessions: [
          {
            name: "prd-t",
            pid: 11,
            heartbeats: [idle(), idle({ agent: "a1", running: { x: { tool: "Bash", at: ago(40) } } })],
          },
        ],
      }),
    );
    expect(running.kind).toBe("wait");
    expect(running.why).toMatch(/prd-t is running a call \(Bash\)/);
    const recent = finishDecision(
      facts({ sessions: [{ name: "prd-t", pid: 11, heartbeats: [idle({ lastEnd: ago(5) })] }] }),
    );
    expect(recent.kind).toBe("wait");
    expect(recent.why).toMatch(/last event was 5 min ago/);
  });

  it("waits on a landing journal", () => {
    const d = finishDecision(facts({ journal: { branch: "prd/t", step: "merge" } }));
    expect(d.kind).toBe("wait");
    expect(d.why).toMatch(/land --resume prd\/t/);
  });

  it("acts on idle recorded sessions and a docs tail, ending both, then rm", () => {
    const d = finishDecision(
      facts({
        sessions: [
          { name: "prd-t", pid: 11, heartbeats: [idle()] },
          { name: "other", pid: 12, heartbeats: [idle()] },
        ],
      }),
    );
    expect(d).toMatchObject({ kind: "act", end: ["prd-t", "other"], rm: true });
  });

  it("reports a code tail once per tip", () => {
    const d = finishDecision(facts({ tail: "code" }));
    expect(d.kind).toBe("report");
    expect(d.key).toBe(reportKey("t", ["code"], "tip1"));
    expect(d.why).toMatch(/prd\/t has 1 commit past its last landing that aren't Markdown only/);
    expect(finishDecision(facts({ tail: "code", reported: [d.key] }))).toBeNull();
    const next = finishDecision(facts({ tail: "code", tip: "tip2", reported: [d.key] }));
    expect(next.kind).toBe("report");
    expect(next.key).not.toBe(d.key);
  });

  it.each([
    ["a dirty worktree", { worktree: { name: "t", dir: "/r/.loops/t", dirty: true } }, /uncommitted/],
    ["a slice worktree left", { sliceWorktrees: ["t-2"] }, /slice worktrees t-2 are left/],
    ["an unrecorded claude in the worktree", { unrecorded: [77] }, /no session record names .*pid 77/],
    [
      "a recorded live session with no heartbeat record",
      { sessions: [{ name: "prd-t", pid: 11, heartbeats: [] }] },
      /prd-t \(pid 11\) is live with no heartbeat record/,
    ],
  ])("reports %s, ending no session", (_, over, why) => {
    const d = finishDecision(facts(over));
    expect(d.kind).toBe("report");
    expect(d.why).toMatch(why);
    expect(d).not.toHaveProperty("end");
  });

  it("reports a landed topic with no worktree whose row isn't done, naming the prd set line, never act", () => {
    const d = finishDecision(facts({ worktree: null, slot: null, sessions: [] }));
    expect(d.kind).toBe("report");
    expect(d.reasons.map((r) => r.line)).toEqual(["pnpm backlog prd set t flags=done"]);
  });

  it("reports a slot left with no worktree", () => {
    const d = finishDecision(facts({ worktree: null, sessions: [], row: { topic: "t", flags: ["done"] } }));
    expect(d.kind).toBe("report");
    expect(d.reasons.map((r) => r.reason)).toEqual(["slot"]);
  });

  it("leaves a standing topic running", () => {
    expect(finishDecision(facts({ row: { topic: "t", flags: ["standing"] } })).kind).toBe("running");
  });

  it("waits while the registry can't be read", () => {
    expect(finishDecision(facts({ row: null, registryError: "boom" })).kind).toBe("wait");
  });
});

describe("liveIn", () => {
  it("names the claudes in the worktree and under it, never one elsewhere or a non-claude", () => {
    const table = new Map([
      [1, { ppid: 0, args: "/usr/bin/claude --model x" }],
      [2, { ppid: 0, args: "claude" }],
      [3, { ppid: 0, args: "claude" }],
      [4, { ppid: 0, args: "/bin/zsh" }],
      [5, { ppid: 0, args: "claude" }],
    ]);
    const cwds = { 1: "/r/.loops/t", 2: "/r/.loops/t/web", 3: "/r/.loops/t-2", 4: "/r/.loops/t", 5: null };
    expect(liveIn("/r/.loops/t", { table, cwdOf: (p) => cwds[p], claude: "claude" })).toEqual([1, 2]);
  });
});

describe("landedWithCode", () => {
  let repo;
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
  const commit = (file, msg) => {
    writeFileSync(join(repo, file), `${msg}\n`);
    git("add", file);
    git("commit", "-q", "-m", msg);
  };
  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "finish-landed-")));
    execFileSync("git", ["init", "-q", "-b", "dev", repo]);
    for (const [k, v] of [
      ["user.email", "test@example.com"],
      ["user.name", "Test"],
      ["commit.gpgsign", "false"],
    ])
      git("config", k, v);
    commit("README.md", "init");
    for (const [t, tail] of [
      ["code", "tail.mjs"],
      ["docs", "tail.md"],
    ]) {
      git("checkout", "-q", "-b", `prd/${t}`, "dev");
      commit(`${t}.txt`, `feat(${t}): work`);
      git("checkout", "-q", "dev");
      git("merge", "-q", "--no-ff", "-m", `feat(${t}): land`, `prd/${t}`);
      git("checkout", "-q", `prd/${t}`);
      commit(tail, `${t}: past the landing`);
      git("checkout", "-q", "dev");
    }
    git("checkout", "-q", "-b", "prd/never", "dev");
    commit("never.mjs", "never landed");
    git("checkout", "-q", "dev");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("names a topic landed with code past it, not one with only Markdown, nor one never landed", () => {
    const out = landedWithCode(repo, ["code", "docs", "never", "none"], "dev");
    expect(Object.keys(out)).toEqual(["code"]);
    expect(out.code.sha).toBe(git("rev-parse", "dev~1"));
  });
});
