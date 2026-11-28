// Rotation's pure part (rotate.mjs) and `pnpm prd rotate` (rotate.sh), against
// rotate-fixture.mjs's throwaway repo and stub claude. The rest of rotation's
// tests: rotate-standing (a standing topic's run), rotate-into (rotate-into.sh),
// rotate-self (--self and the inbox session) and rm-done (`pnpm prd rm`'s done
// flag), split so Vitest's workers spread them.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { clearsHot, contextHold, doneFlags, handoffOutcome, slicesLeft, standingClose } from "./rotate.mjs";
import { pick } from "./dispatch-pick.mjs";
import { BASE, scaledWait } from "./test-limits.mjs";
import {
  git,
  plan,
  MERGED,
  root,
  main,
  loops,
  stub,
  env,
  wt,
  scripts,
  record,
  stubPid,
  stateFile,
  run,
  liveSession,
  printedLine,
  useRotateRepo,
} from "./rotate-fixture.mjs";

// The limits follow the load as this file starts, not only as the run did (RISA-994).
vi.setConfig({ testTimeout: scaledWait(BASE.testTimeout), hookTimeout: scaledWait(BASE.hookTimeout) });
useRotateRepo();

describe("the pure part", () => {
  it("reads the slices left from _Status_, whatever the table's columns", () => {
    expect(slicesLeft(plan(MERGED))).toEqual([]);
    expect(
      slicesLeft(
        plan(`${MERGED}\n| 3 | 2 | not started | |\n| 4 | 2 | handed off | |\n| 5 | 2 | ✅ merged | x |`),
      ),
    ).toEqual(["3", "4"]);
    expect(
      slicesLeft("## Status\n\n| Slice | State |\n| --- | --- |\n| 1 | dropped |\n| 2 | moved to x |\n"),
    ).toEqual([]);
    // No table to read: unknown, not "nothing left".
    expect(slicesLeft("# Plan\n\n## Status\n\nAll done.\n")).toBeNull();
    expect(slicesLeft("# Plan\n")).toBeNull();
  });

  it("marks done with the row's flags, never a standing or missing row", () => {
    const rows = [
      { topic: "a", flags: [] },
      { topic: "b", flags: ["hold", "alone"] },
      { topic: "c", flags: ["standing"] },
      { topic: "d", flags: ["done"] },
    ];
    expect(doneFlags(rows, "a")).toEqual({ flags: ["done"] });
    expect(doneFlags(rows, "b")).toEqual({ flags: ["alone", "done"] });
    expect(doneFlags(rows, "c")).toEqual({ skip: "c is standing: it never finishes" });
    expect(doneFlags(rows, "d")).toEqual({ skip: "d is already done" });
    expect(doneFlags(rows, "e")).toEqual({ skip: "the PRD table has no row e" });
  });

  it("clears hot files only for a standing row that has some", () => {
    const rows = [
      { topic: "f", flags: ["standing"], hot: ["loops/"] },
      { topic: "g", flags: ["standing"], hot: [] },
      { topic: "p", flags: [], hot: ["web/"] },
    ];
    expect(clearsHot(rows, "f")).toBe(true);
    expect(clearsHot(rows, "g")).toBe(false);
    expect(clearsHot(rows, "p")).toBe(false);
    expect(clearsHot(rows, "missing")).toBe(false);
  });

  it("holds a context rotation for the slices still at work, until the hard limit", () => {
    const planText = plan(`${MERGED}\n| 3 | 2 | handed off d4e5 | |\n| 4 | 2 | running (opus) | |`);
    // 1 merged, 3 handed off: done with; 4 running and 5 with no row: at work.
    expect(contextHold({ planText, slices: ["1", "3", "4", "5"], hard: 225_000 })).toEqual(["4", "5"]);
    expect(contextHold({ planText, slices: ["1", "3"], hard: 225_000 })).toEqual([]);
    // Under the hard limit (B-877: 166k) it holds; past it, or once marked over, it doesn't.
    expect(contextHold({ planText, slices: ["4"], record: { size: 166_000 }, hard: 225_000 })).toEqual(["4"]);
    expect(contextHold({ planText, slices: ["4"], record: { size: 230_000 }, hard: 225_000 })).toEqual([]);
    expect(
      contextHold({ planText, slices: ["4"], record: { size: 200_000, hardOverAt: "x" }, hard: 225_000 }),
    ).toEqual([]);
    // No table to read: every slice counts as at work.
    expect(contextHold({ planText: "# Plan\n", slices: ["2"], hard: 225_000 })).toEqual(["2"]);
  });

  describe("a standing topic's hand-over closes it when nothing runnable waits (RISA-952)", () => {
    const row = (topic, extra = {}) => ({ topic, flags: [], after: [], hot: [], state: "planned", ...extra });
    const fx = (extra = {}) => row("fx", { flags: ["standing"], state: "running", ...extra });
    const wts = [{ name: "fx", branch: "prd/fx" }];
    const caps = { prds: 1, planners: 1, fixesMin: 3 };
    const close = (rows, more = {}) => standingClose({ rows, worktrees: wts, caps, ...more }, "fx");

    it("closes one whose waiting items are all blocked", () => {
      expect(close([fx({ waiting: 0 })])).toBe("no waiting items");
      // Its items wait on another topic: an After not done, or a hot file a running topic shares.
      expect(close([fx({ waiting: 4, after: ["big"] }), row("big", { state: "to-write" })])).toBe(
        "nothing it could start: waits for big",
      );
      expect(
        close([fx({ waiting: 4, hot: ["loops/x"] }), row("big", { state: "running", hot: ["loops/"] })], {
          worktrees: [...wts, { name: "big", branch: "prd/big" }],
        }),
      ).toBe("nothing it could start: shares loops/x with big");
      // Held: the dispatcher never starts it.
      expect(close([fx({ waiting: 4, flags: ["standing", "hold"] })])).toMatch(
        /^nothing it could start: on hold/,
      );
      // Short of the minimum while another topic would take the lane it frees (fixes-ui's 4 h idle).
      expect(close([fx({ waiting: 1 }), row("fixes-bug", { flags: ["standing"], waiting: 4 })])).toBe(
        "1 waiting, under 3, and fixes-bug would start in its lane",
      );
    });

    it("rotates one with a runnable item, as now", () => {
      expect(close([fx({ waiting: 3 }), row("other")])).toBeNull();
      // Short, but nothing else would start in its place.
      expect(close([fx({ waiting: 1 })])).toBeNull();
      expect(close([fx({ waiting: 1 }), row("other", { state: "hold" })])).toBeNull();
      // Its own open question isn't a block: a fresh session carries it.
      expect(
        close([fx({ waiting: 3 })], {
          asks: [{ id: "a1", kind: "question", topic: "fx", session: "prd-fx" }],
        }),
      ).toBeNull();
    });

    it("decides on a landed-but-planned row as the dispatcher's pick would (RISA-1003)", () => {
      const rows = [fx({ waiting: 1 }), row("old")];
      const landed = { old: { sha: "abc1234def" } };
      // Without the landed guard, old would take the lane fx frees.
      expect(close(rows)).toBe("1 waiting, under 3, and old would start in its lane");
      // With it, the dispatcher never starts old, so fx rotates: the pick on the same facts with
      // fx closed starts fx itself, not old.
      expect(close(rows, { landed })).toBeNull();
      const closed = pick({
        rows: [fx({ waiting: 1, state: "planned" }), row("old")],
        worktrees: [],
        landed,
        caps,
      });
      expect(closed).toMatchObject({ action: "start", topic: "fx" });
    });

    it("rotates one whose wave's items are still claimed, though none waits", () => {
      expect(
        standingClose({ rows: [fx({ waiting: 0 })], worktrees: wts, caps }, "fx", { claimed: ["B-1"] }),
      ).toBeNull();
    });

    it("rotates a non-standing topic, as now", () => {
      expect(close([row("fx", { state: "running", waiting: 0 })])).toBeNull();
      expect(close([])).toBeNull();
    });
  });
});

describe("pnpm prd rotate", () => {
  it("prints the rotate-into command with the record's pid when there's no iTerm2, and ends nothing", async () => {
    const { s, pid } = await liveSession();
    const r = run("prd.sh", ["rotate", "w", "--reason", "slow now"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Rotating prd-w: pid ${pid} (from its record).`);
    expect(printedLine(r.stdout)).toBe(
      `cd ${wt} && ${scripts("rotate-into.sh")} prd-w ${pid} --reason slow\\ now`,
    );
    // Nothing was ended or marked.
    expect(spawnSync("kill", ["-0", String(pid)]).status).toBe(0);
    expect(record("prd-w")).not.toHaveProperty("rotating");
    process.kill(pid, "SIGTERM");
    await s.done;
  });

  it("takes the calling shell's ancestor claude when there's no record", () => {
    expect(
      spawnSync(stub, [], { cwd: wt, encoding: "utf8", env: { ...env, STUB_MODE: "rotate" } }).status,
    ).toBe(0);
    const out = stateFile("rotate.out");
    expect(stateFile("rotate.code").trim()).toBe("0");
    expect(out).toContain(`Rotating prd-w: pid ${stubPid()} (from the calling shell's ancestor claude).`);
    expect(printedLine(out)).toBe(`cd ${wt} && ${scripts("rotate-into.sh")} prd-w ${stubPid()}`);
  });

  it("refuses while a requested run has no verdict, naming it, and passes with --mid-wave", async () => {
    const bare = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    git(main, "remote", "add", "origin", bare);
    const sha = git(main, "rev-parse", "dev");
    git(main, "push", "-q", "origin", `${sha}:refs/heads/ci/integration/prd-w`);
    const ghBin = join(root, "gh-bin");
    mkdirSync(ghBin, { recursive: true });
    const runs = JSON.stringify([
      {
        databaseId: 77,
        headSha: sha,
        status: "in_progress",
        url: "https://ci.example/77",
        workflowName: "CI",
      },
    ]);
    writeFileSync(join(ghBin, "gh"), `#!/usr/bin/env bash\ncat <<'J'\n${runs}\nJ\n`);
    chmodSync(join(ghBin, "gh"), 0o755);
    const withGh = { PATH: `${ghBin}:${env.PATH}` };
    try {
      const { s, pid } = await liveSession();
      let r = run("prd.sh", ["rotate", "w"], withGh);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(
        "has a requested run with no verdict: ci/integration/prd-w (https://ci.example/77)",
      );
      r = run("prd.sh", ["rotate", "w", "--mid-wave"], withGh);
      expect(r.status).toBe(0);
      process.kill(pid, "SIGTERM");
      await s.done;
    } finally {
      git(main, "remote", "remove", "origin");
    }
  });

  it("refuses an uncommitted plan, no session to end, and slice worktrees without --mid-wave", async () => {
    const planFile = join(wt, "plans/w-plan.md");
    writeFileSync(planFile, `${readFileSync(planFile, "utf8")}\nmore\n`);
    let r = run("prd.sh", ["rotate", "w"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/plans\/w-plan\.md has uncommitted changes: commit _Status_ first/);
    git(wt, "checkout", "--", "plans/w-plan.md");

    // No record, from the main checkout: the ancestor doesn't count here.
    r = run("prd.sh", ["rotate", "w"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /no session to end: no live record prd-w \(without one, run it from w's own session\)/,
    );
    // From the worktree, with no claude above the shell.
    r = run("prd.sh", ["rotate"], {}, wt);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no live record prd-w, and this shell isn't under a claude process/);

    git(main, "worktree", "add", "-q", "-b", "slice/w/1", join(loops, "w-1"), "prd/w");
    try {
      r = run("prd.sh", ["rotate", "w"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(
        /slice worktrees of w still exist \(w-1\): merge them first, or pass --mid-wave/,
      );
      const { s, pid } = await liveSession();
      r = run("prd.sh", ["rotate", "w", "--mid-wave"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`pid ${pid} (from its record), mid-wave (the agents of w-1 end too).`);
      process.kill(pid, "SIGTERM");
      await s.done;
    } finally {
      git(main, "worktree", "remove", "--force", join(loops, "w-1"));
      git(main, "branch", "-D", "slice/w/1");
    }
  });

  it("holds a mid-wave context rotation for a slice still at work, until the hard limit", async () => {
    // Slice 3's row is "not started": its agent would be cut off (B-877).
    git(main, "worktree", "add", "-q", "-b", "slice/w/3", join(loops, "w-3"), "prd/w");
    const sizeFile = join(loops, ".context/prd-w.json");
    try {
      const { s, pid } = await liveSession();
      let r = run("prd.sh", ["rotate", "w", "--mid-wave", "--reason", "context"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("waits for the slices still at work (3)");
      expect(spawnSync("kill", ["-0", String(pid)]).status).toBe(0);
      // Another reason (the user's word) goes ahead.
      r = run("prd.sh", ["rotate", "w", "--mid-wave", "--reason", "user"]);
      expect(r.status).toBe(0);
      // Past the hard limit, a context rotation goes ahead too.
      mkdirSync(join(loops, ".context"), { recursive: true });
      writeFileSync(sizeFile, JSON.stringify({ pid, size: 230_000, hardOverAt: new Date().toISOString() }));
      r = run("prd.sh", ["rotate", "w", "--mid-wave", "--reason", "context"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("mid-wave (the agents of w-3 end too).");
      process.kill(pid, "SIGTERM");
      await s.done;
    } finally {
      rmSync(sizeFile, { force: true });
      git(main, "worktree", "remove", "--force", join(loops, "w-3"));
      git(main, "branch", "-D", "slice/w/3");
    }
  });
});

describe("whether rotate --self's hand-off started (RISA-1082)", () => {
  const rec = { pid: 42, kind: "backlog" };
  it("started once the record is marked rotating, or replaced by another pid", () => {
    expect(handoffOutcome({ record: { ...rec, rotating: true }, pid: 42 }).state).toBe("started");
    expect(handoffOutcome({ record: { ...rec, pid: 43 }, pid: 42 })).toEqual({
      state: "started",
      why: "replaced by pid 43",
    });
  });
  it("refused when rotate-into left its reason for this pid; a stale one for another pid doesn't count", () => {
    const refusal = "42\trotate-into: pid 42 isn't backlog's live session; nothing was ended\n";
    expect(handoffOutcome({ record: rec, pid: 42, refusal })).toEqual({
      state: "refused",
      why: "rotate-into: pid 42 isn't backlog's live session; nothing was ended",
    });
    expect(handoffOutcome({ record: rec, pid: 42, refusal: refusal.replace(/^42/, "41") }).state).toBe(
      "waiting",
    );
  });
  it("still waiting with the record as it was, or none", () => {
    expect(handoffOutcome({ record: rec, pid: 42 })).toEqual({ state: "waiting" });
    expect(handoffOutcome({ record: null, pid: 42 })).toEqual({ state: "waiting" });
  });
});
