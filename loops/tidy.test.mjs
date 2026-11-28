// The cleanup sorter (tidy.mjs): every safe, ask and never case, with a dirty,
// live or young case beside each safe one. Pure: facts in, lists out.
import { describe, expect, it } from "vitest";
import { HANG_LOG_DAYS, TICKET_GRACE_SECS, formatTidy, reportText, tidy } from "./tidy.mjs";

const targets = (/** @type {{ target: string }[]} */ list) => list.map((f) => f.target);
const one = (/** @type {import("./tidy.mjs").TidyFacts} */ facts) => tidy(facts);

describe("ci refs", () => {
  const ref = { ref: "ci/unit/x", sha: "a".repeat(40), ageSecs: 90_000, running: false };

  it("a ref older than a day with no run going is safe, naming its commit", () => {
    expect(one({ ciRefs: [ref] }).safe).toEqual([
      {
        kind: "ci-ref",
        target: "ci/unit/x",
        why: "25 hours old, no run going",
        how: "git push --delete",
        sha: ref.sha,
      },
    ]);
  });

  it("a young ref, one with a run going and one of unknown age are left", () => {
    const ciRefs = [
      { ...ref, ageSecs: 3600 },
      { ...ref, running: true },
      { ...ref, ageSecs: null },
    ];
    expect(one({ ciRefs })).toEqual({ safe: [], ask: [], kept: [] });
  });
});

describe("the quarantine", () => {
  it("removes an entry whose item is done, through the backlog's write", () => {
    const entry = { file: "loops/a.test.mjs", name: "one", item: "B-7" };
    expect(one({ quarantineDone: [entry] }).safe).toEqual([
      {
        kind: "quarantine",
        target: "loops/a.test.mjs: one",
        why: "its item B-7 is done",
        how: "pnpm backlog ci-file",
      },
    ]);
  });
});

describe("worktrees", () => {
  const slice = { name: "t-1", branch: "slice/t/1", merged: true, dirty: false };
  const plan = { name: "plan-t", branch: "plan/t", landed: true, level: true, dirty: false };

  it("a merged, clean slice worktree with nothing running is safe; dirty or busy ones are kept", () => {
    const { safe, kept, ask } = one({
      worktrees: [
        slice,
        { ...slice, name: "t-2", branch: "slice/t/2", dirty: true },
        { ...slice, name: "t-3", branch: "slice/t/3", busy: "its dev server is running" },
      ],
    });
    expect(safe).toEqual([
      { kind: "worktree", target: "t-1", why: "slice/t/1 is merged into prd/t", how: "pnpm prd rm t-1" },
    ]);
    expect(kept.map((k) => [k.target, k.why])).toEqual([
      ["t-2", "slice/t/2 is merged into prd/t, but it has uncommitted changes"],
      ["t-3", "slice/t/3 is merged into prd/t, but its dev server is running"],
    ]);
    expect(ask).toEqual([]);
  });

  it("keeps a merged slice its wave still needs, with why, and lists it once that clears", () => {
    const held = { ...slice, held: "its wave hasn't landed" };
    expect(one({ worktrees: [held] }).kept).toEqual([
      { kind: "worktree", target: "t-1", why: "slice/t/1 is merged into prd/t, but its wave hasn't landed" },
    ]);
    expect(one({ worktrees: [held] }).safe).toEqual([]);
    expect(one({ worktrees: [slice] }).safe.map((f) => f.target)).toEqual(["t-1"]);
  });

  it("an unmerged slice worktree is never listed", () => {
    expect(one({ worktrees: [{ ...slice, merged: false }] })).toEqual({ safe: [], ask: [], kept: [] });
  });

  it("a landed plan worktree level with dev is safe; a live session, dirt or a busy one keeps it", () => {
    const live = { name: "plan-u", live: true, worktree: "plan-u", worktreeExists: true };
    const { safe, kept } = one({
      worktrees: [
        plan,
        { ...plan, name: "plan-u", branch: "plan/u" },
        { ...plan, name: "plan-v", branch: "plan/v", dirty: true },
        { ...plan, name: "plan-w", branch: "plan/w", busy: "a process is working in it (pid 9)" },
      ],
      sessions: [live],
    });
    expect(targets(safe)).toEqual(["plan-t"]);
    expect(safe[0].why).toBe("plan/t landed in dev and is level with it");
    expect(kept.map((k) => k.target)).toEqual(["plan-u", "plan-v", "plan-w"]);
    expect(kept[0].why).toMatch(/its session plan-u is live$/);
  });

  it("a plan worktree that isn't landed, or has commits dev lacks, is never listed", () => {
    const { safe, kept } = one({
      worktrees: [
        { ...plan, landed: false },
        { ...plan, name: "plan-u", branch: "plan/u", level: false },
      ],
    });
    expect([...safe, ...kept]).toEqual([]);
  });

  it("never lists a PRD, hotfix or main-checkout branch's worktree, even merged", () => {
    const { safe, kept } = one({
      worktrees: [
        { name: "t", branch: "prd/t", merged: true, landed: true, level: true },
        { name: "hotfix-x", branch: "hotfix/x", merged: true, landed: true, level: true },
        { name: "odd", branch: "dev", merged: true, landed: true, level: true },
      ],
    });
    expect([...safe, ...kept]).toEqual([]);
  });
});

describe("sessions", () => {
  const base = { name: "prd-t", worktree: "t", worktreeExists: true, branch: "prd/t", landed: false };

  it("an ended backlog record with no worktree is safe; a live or rotating one is never touched", () => {
    const rec = { name: "backlog", worktree: null, worktreeless: true, path: "/s/backlog.json" };
    expect(one({ sessions: [{ ...rec, live: false }] }).safe).toEqual([
      {
        kind: "record",
        target: "backlog",
        why: "ended, and it has no worktree",
        how: "delete the record",
        path: "/s/backlog.json",
      },
    ]);
    for (const s of [
      { ...rec, live: true },
      { ...rec, live: false, rotating: true },
    ])
      expect(one({ sessions: [s] })).toEqual({ safe: [], ask: [], kept: [] });
  });

  it("an ended record whose worktree is gone is safe; a live, rotating or still-housed one isn't", () => {
    const { safe, ask } = one({
      sessions: [
        { ...base, live: false, worktreeExists: false, path: "/x/prd-t.json" },
        { ...base, name: "prd-u", worktree: "u", live: false, worktreeExists: false, rotating: true },
        { ...base, name: "prd-v", worktree: "v", live: false },
      ],
    });
    expect(safe).toEqual([
      {
        kind: "record",
        target: "prd-t",
        why: "ended, and its worktree t is gone",
        how: "delete the record",
        path: "/x/prd-t.json",
      },
    ]);
    expect(ask).toEqual([]);
  });

  it("a live session whose worktree is gone, or whose branch is in dev, is asked about; never removed", () => {
    const { safe, ask } = one({
      sessions: [
        { ...base, live: true, worktreeExists: false },
        { ...base, name: "plan-u", worktree: "plan-u", branch: "plan/u", live: true, landed: true },
        { ...base, name: "prd-w", worktree: "w", live: true },
      ],
    });
    expect(safe).toEqual([]);
    expect(ask.map((a) => [a.kind, a.target])).toEqual([
      ["session", "prd-t"],
      ["session", "plan-u"],
    ]);
    expect(ask[0].why).toMatch(/worktree t is gone: looks finished/);
    expect(ask[1].why).toMatch(/branch plan\/u is in dev: looks finished/);
  });

  it("a session with no known worktree is left alone", () => {
    expect(one({ sessions: [{ name: "backlog", live: false, worktree: null }] }).safe).toEqual([]);
  });
});

describe("branches", () => {
  it("a branch with no worktree is asked about: merged named for deletion, unmerged never deleted", () => {
    const { safe, ask } = one({
      branches: [
        { name: "slice/t/1", worktree: false, parent: "prd/t", merged: true },
        { name: "slice/t/2", worktree: false, parent: "prd/t", merged: false },
        { name: "slice/t/3", worktree: true, parent: "prd/t", merged: true },
        { name: "dev", worktree: false, parent: "dev", merged: true },
        { name: "main", worktree: false, parent: "dev", merged: false },
      ],
    });
    expect(safe).toEqual([]);
    expect(ask.map((a) => [a.target, a.why])).toEqual([
      ["slice/t/1", "no worktree, merged into prd/t: can be deleted (git branch -d slice/t/1)"],
      ["slice/t/2", "no worktree, not merged into prd/t: kept, never deleted"],
    ]);
  });
});

describe("leftovers", () => {
  const old = TICKET_GRACE_SECS + 1;

  it("dead lease and slot tickets are safe; live ones aren't listed; just-taken ones are kept; recover's locks aren't tidy's", () => {
    const { safe, kept } = one({
      locks: [
        { kind: "lease", path: "/l/check/1", alive: false, pid: 11, ageSecs: old },
        { kind: "slot", path: "/s/3", alive: false, holder: "t-9", ageSecs: old },
        { kind: "lease", path: "/l/check/2", alive: true, pid: 13, ageSecs: old },
        { kind: "lease", path: "/l/browser/1", alive: false, pid: null, ageSecs: 5 },
        { kind: "backlog", path: "/g/sample-backlog.lock", alive: false, ageSecs: old },
        { kind: "dispatch", path: "/l/.dispatch.lock", alive: false, pid: 12, ageSecs: old },
      ],
    });
    expect(targets(safe)).toEqual(["/l/check/1", "/s/3"]);
    expect(safe[0].why).toBe("lease: pid 11 is gone");
    expect(safe[1].why).toBe("slot t-9: its worktree is gone");
    expect(kept.map((k) => [k.target, k.why])).toEqual([
      ["/l/browser/1", "lease: pid ? is gone, but it was just taken"],
    ]);
  });

  it("a test database no worktree owns (the hook's orphans) is safe", () => {
    const { safe } = one({ testDbOrphans: ["sample_db_gone"] });
    expect(safe).toEqual([
      {
        kind: "test-db",
        target: "sample_db_gone",
        why: "no worktree owns it",
        how: "test-db drop-db sample_db_gone",
      },
    ]);
  });

  it("stale remote-tracking refs are safe (git fetch --prune)", () => {
    const { safe } = one({ staleRemotes: ["origin/slice/t/1"] });
    expect(safe).toEqual([
      { kind: "remote", target: "origin/slice/t/1", why: "gone from the remote", how: "git fetch --prune" },
    ]);
  });

  it("the stack hook's leftovers are safe, with the hook's why", () => {
    const { safe } = one({ volumes: [{ name: "stack9_data", why: "dangling; no worktree uses stack9" }] });
    expect(safe).toEqual([
      {
        kind: "volume",
        target: "stack9_data",
        why: "dangling; no worktree uses stack9",
        how: "stack leftovers remove volume",
      },
    ]);
  });

  it("browser-hang logs older than a week are safe; newer ones aren't listed", () => {
    const day = 86400;
    const { safe } = one({
      hangLogs: [
        { path: "/h/old.log", ageSecs: (HANG_LOG_DAYS + 1) * day },
        { path: "/h/new.log", ageSecs: day },
      ],
    });
    expect(safe).toEqual([{ kind: "hang-log", target: "/h/old.log", why: "8 days old", how: "delete it" }]);
  });
});

describe("the backlog and the registry", () => {
  it("finished items are safe to archive, never an ask; none when nothing is finished", () => {
    const { safe, ask } = one({
      items: [
        { id: "B-1", status: "landed", prd: "old" },
        { id: "B-2", status: "dropped" },
        { id: "B-3", status: "triaged", prd: "old" },
      ],
      prdWorktrees: [],
    });
    expect(safe).toEqual([
      {
        kind: "archive",
        target: "2 items",
        why: "finished, still in the backlog (B-1, B-2)",
        how: "pnpm backlog archive",
        ids: ["B-1", "B-2"],
      },
    ]);
    expect(ask).toEqual([]);
    expect(one({ items: [{ id: "B-3", status: "in-progress" }] }).safe).toEqual([]);
    expect(one({ items: null }).safe).toEqual([]);
  });

  it("keeps a running topic's finished items, with why, but archives its dropped ones", () => {
    const { safe, kept } = one({
      items: [
        { id: "B-1", status: "landed", prd: "busy" },
        { id: "B-2", status: "live", prd: "busy" },
        { id: "B-3", status: "dropped", prd: "busy" },
        { id: "B-4", status: "staging", prd: "other" },
      ],
      prdWorktrees: ["busy"],
    });
    expect(safe.map((f) => f.ids)).toEqual([["B-3", "B-4"]]);
    expect(kept).toEqual([
      {
        kind: "archive",
        target: "busy: 2 items",
        why: "finished, but prd/busy still has a worktree (B-1, B-2)",
      },
    ]);
  });

  it("unreadable worktrees keep every finished item with a topic", () => {
    const { safe, kept } = one({
      items: [
        { id: "B-1", status: "landed", prd: "any" },
        { id: "B-2", status: "dropped", prd: "any" },
        { id: "B-3", status: "landed" },
      ],
      prdWorktrees: null,
    });
    expect(safe.map((f) => f.ids)).toEqual([["B-2", "B-3"]]);
    expect(kept[0].why).toBe("finished, but the worktrees can't be read (B-1)");
  });

  it("registry rows that look done are asked about; done, hold, standing and running ones aren't", () => {
    const row = { flags: [], state: "planned", waiting: 0, notes: "" };
    const { ask, safe } = one({
      registry: [
        { ...row, topic: "said-done", state: "to-write", waiting: 2, notes: "[PRD](x.md): **done**" },
        { ...row, topic: "all-in" },
        { ...row, topic: "flagged", flags: ["done"], state: "done", notes: "**done**" },
        { ...row, topic: "held", flags: ["hold"], state: "hold", notes: "**done** except going live" },
        { ...row, topic: "fixes-ui", flags: ["standing"], state: "idle" },
        { ...row, topic: "busy", state: "running", notes: "**done**" },
        { ...row, topic: "to-do", waiting: 3 },
      ],
    });
    expect(safe).toEqual([]);
    expect(ask.map((a) => a.target)).toEqual(["said-done", "all-in"]);
    expect(ask[0].why).toMatch(/its notes say done.*pnpm backlog prd set said-done flags=done\)$/);
    expect(ask[1].why).toMatch(/^planned, with no waiting items/);
  });
});

describe("landed topics with leftovers (RISA-811)", () => {
  const topic = { topic: "t", worktree: "t", rowDone: false };

  it("a landed topic with a worktree and no dispatcher is one ask naming finish", () => {
    const { ask, safe, kept } = one({ landed: [topic] });
    expect(ask).toEqual([
      {
        kind: "landed",
        target: "t",
        why: "landed with its worktree t and its row not done, and no dispatcher is running (pnpm prd finish t)",
      },
    ]);
    expect([...safe, ...kept]).toEqual([]);
    expect(one({ landed: [{ ...topic, rowDone: null }] }).ask[0].why).toMatch(/with its worktree t, and/);
  });

  it("is none while the dispatcher runs", () => {
    expect(one({ landed: [topic], dispatcherRunning: true }).ask).toEqual([]);
  });

  it("a code-tail topic is one ask", () => {
    const { ask } = one({ landed: [{ ...topic, code: true, worktree: null }] });
    expect(ask.map((a) => [a.kind, a.target])).toEqual([["landed", "t"]]);
    expect(ask[0].why).toMatch(
      /^landed, with code past its landing, with its row not done.*pnpm prd finish t\)$/,
    );
  });

  it("a standing topic whose wave landed with nothing past it is none; nor one with nothing left", () => {
    expect(one({ landed: [{ ...topic, standing: true }] }).ask).toEqual([]);
    expect(one({ landed: [{ topic: "u", worktree: null, rowDone: true }] }).ask).toEqual([]);
  });
});

describe("topics with more than one live claude (RISA-811)", () => {
  it("two live claudes in one topic's worktrees are one ask naming both pids", () => {
    const { ask } = one({
      claudes: [
        { topic: "t", pid: 11, worktree: "t" },
        { topic: "t", pid: 12, worktree: "t-1" },
        { topic: "u", pid: 13, worktree: "u" },
      ],
    });
    expect(ask).toEqual([
      {
        kind: "sessions",
        target: "t",
        why: "2 live claudes across its worktrees (pid 11 in t, pid 12 in t-1): one is enough, end the others",
      },
    ]);
  });

  it("one live claude is none, even seen twice", () => {
    const claudes = [
      { topic: "t", pid: 11, worktree: "t" },
      { topic: "t", pid: 11, worktree: "t" },
    ];
    expect(one({ claudes })).toEqual({ safe: [], ask: [], kept: [] });
  });
});

describe("output", () => {
  it("formats both lists and the kept ones, and the report names each ask", () => {
    const lists = one({
      worktrees: [
        { name: "t-1", branch: "slice/t/1", merged: true },
        { name: "t-2", branch: "slice/t/2", merged: true, dirty: true },
      ],
      branches: [{ name: "slice/t/5", worktree: false, parent: "prd/t", merged: false }],
    });
    const text = formatTidy(lists);
    expect(text).toMatch(/^Safe to remove \(pnpm prd tidy --yes\):\n {2}worktree +t-1 \(/);
    expect(text).toMatch(/^To ask about .*\n {2}branch +slice\/t\/5 \(no worktree, not merged/m);
    expect(text).toMatch(/^Kept:\n {2}worktree +t-2 \(.*uncommitted changes\)$/m);
    expect(formatTidy({ safe: [], ask: [], kept: [] })).toBe(
      "Safe to remove: nothing.\n\nTo ask about: nothing.",
    );
    expect(reportText(lists.ask)).toBe(
      "pnpm prd tidy: 1 thing to decide (nothing here was removed):\n" +
        "- branch slice/t/5: no worktree, not merged into prd/t: kept, never deleted",
    );
  });
});
