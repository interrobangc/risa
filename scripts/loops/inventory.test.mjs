// The recovery inventory (inventory.mjs): facts in, classes and ordered actions out.
import { describe, expect, it } from "vitest";
import { actionLine, classify, formatInventory, inventory, STEPS } from "./inventory.mjs";

const wt = (name, branch, extra = {}) => ({
  name,
  branch,
  parent: branch.startsWith("slice/") ? `prd/${branch.split("/")[1]}` : "dev",
  merged: false,
  dirty: false,
  stack: null,
  containersUp: 0,
  containersAll: 0,
  webPort: null,
  serverRunning: false,
  ...extra,
});

// One of each class, every stack down, nothing running: a cold boot.
const COLD = {
  worktrees: [
    wt("t", "prd/t", { stack: "caretook-loop1", containersAll: 3, webPort: 6173 }),
    wt("t-1", "slice/t/1", { merged: true, stack: "caretook-loop2", containersAll: 3, webPort: 6273 }),
    wt("t-2", "slice/t/2", { stack: "caretook-loop3", containersAll: 3, webPort: 6373 }),
    wt("t-3", "slice/t/3"),
    wt("t-4", "slice/t/4", { merged: true, dirty: true }),
    wt("plan-u", "plan/u"),
    wt("a", "prd/a", { stack: "caretook-loop4", containersAll: 3, webPort: 6473 }),
  ],
  locks: [],
  docker: { running: true },
  testDb: { running: false },
  downRecord: null,
  disk: { freeGb: 100, minGb: 10 },
};
const lines = (inv) => inv.actions.map(actionLine);
const clone = (o) => structuredClone(o);

describe("classify", () => {
  it("gives every class, with a reason", () => {
    const got = Object.fromEntries(inventory(COLD).worktrees.map((w) => [w.name, w.class]));
    expect(got).toEqual({
      a: "prd",
      "plan-u": "plan",
      t: "prd",
      "t-1": "merged",
      "t-2": "active",
      "t-3": "stackless",
      "t-4": "merged",
    });
    for (const w of inventory(COLD).worktrees) expect(w.why).toBeTruthy();
  });

  it("says a dirty merged slice is kept by gc", () => {
    expect(classify(wt("t-4", "slice/t/4", { merged: true, dirty: true })).why).toMatch(/dirty: gc keeps it/);
  });

  it("calls any other branch, or a detached HEAD, stackless", () => {
    expect(classify(wt("x", "feature/x", { stack: "caretook-loop9" })).class).toBe("stackless");
    expect(classify(wt("y", "")).why).toMatch(/detached/);
  });
});

describe("actions without a down record", () => {
  it("brings back prd and active stacks, prd servers, the test Postgres; offers gc; opens sessions", () => {
    expect(lines(inventory(COLD))).toEqual([
      "test-db up",
      "stack up a",
      "stack up t",
      "stack up t-2",
      "serve a",
      "serve t",
      "offer-gc t-1",
      "offer-gc t-4",
      "open-session a",
      "open-session t",
      "open-session plan-u",
    ]);
  });

  it("offers a dirty merged slice to gc, marked dirty, and never brings its stack back", () => {
    const inv = inventory(COLD);
    expect(inv.actions.find((a) => a.target === "t-4")).toMatchObject({ step: "offer-gc", dirty: true });
    expect(lines(inv)).not.toContain("stack up t-1");
  });

  it("names each session prd-<topic> or plan-<topic>", () => {
    const s = inventory(COLD)
      .actions.filter((a) => a.step === "open-session")
      .map((a) => a.session);
    expect(s).toEqual(["prd-a", "prd-t", "plan-u"]);
  });

  it("skips what's already up, so a second recover has only gc offers and sessions", () => {
    const warm = clone(COLD);
    warm.testDb.running = true;
    for (const w of warm.worktrees) {
      if (w.stack) w.containersUp = w.containersAll;
      if (w.webPort) w.serverRunning = true;
    }
    expect(inventory(warm).actions.map((a) => a.step)).toEqual([
      "offer-gc",
      "offer-gc",
      "open-session",
      "open-session",
      "open-session",
    ]);
  });

  it("brings a half-up stack back up", () => {
    const f = clone(COLD);
    f.worktrees[0].containersUp = 1;
    expect(lines(inventory(f))).toContain("stack up t");
  });
});

describe("Docker", () => {
  it("puts docker start first, and brings everything back regardless of what was seen", () => {
    const f = clone(COLD);
    f.docker.running = false;
    f.testDb.running = true; // can't be true with Docker down
    f.worktrees[0].containersUp = 3;
    const l = lines(inventory(f));
    expect(l[0]).toBe("docker start");
    expect(l).toContain("test-db up");
    expect(l).toContain("stack up t");
  });

  it("has no docker start when Docker answers", () => {
    expect(lines(inventory(COLD))).not.toContain("docker start");
  });
});

describe("locks", () => {
  const f = clone(COLD);
  f.locks = [
    { kind: "slot", path: "/l/.slots/7", holder: "gone-1", alive: false },
    { kind: "slot", path: "/l/.slots/1", holder: "t", alive: true },
    { kind: "dispatch", path: "/l/.dispatch.lock", pid: 99, alive: false },
    { kind: "backlog", path: "/g/caretook-backlog.lock", alive: true },
    { kind: "lease", path: "/l/.lease/browser/1", pid: 5, alive: false },
    { kind: "lease", path: "/l/.lease/check/1", pid: 6, alive: true },
  ];
  const inv = inventory(f);

  it("clears stale locks and only those", () => {
    expect(inv.actions.filter((a) => a.step === "clear-lock").map((a) => a.target)).toEqual([
      "/l/.slots/7",
      "/l/.dispatch.lock",
    ]);
  });

  it("lists live locks to leave alone", () => {
    expect(inv.locks.live.map((l) => l.path)).toEqual([
      "/l/.slots/1",
      "/g/caretook-backlog.lock",
      "/l/.lease/check/1",
    ]);
  });

  it("only reports a dead machine-wide lease (lease.sh takes it over)", () => {
    expect(inv.locks.takenOver.map((l) => l.path)).toEqual(["/l/.lease/browser/1"]);
    expect(lines(inv)).not.toContain("clear-lock /l/.lease/browser/1");
    expect(inv.warnings.join("\n")).toMatch(/takes it over/);
  });

  it("clears a stale backlog lock", () => {
    const g = clone(COLD);
    g.locks = [{ kind: "backlog", path: "/g/caretook-backlog.lock", alive: false }];
    expect(lines(inventory(g))).toContain("clear-lock /g/caretook-backlog.lock");
  });
});

describe("the dispatcher", () => {
  const reopen = (f) => lines(inventory(f)).filter((l) => l === "dispatch");

  it("does nothing about a dispatcher that never ran, or one still running", () => {
    expect(reopen(COLD)).toEqual([]);
    expect(inventory(COLD).dispatcher).toEqual({ running: false, pid: null, reopen: false });
    const f = clone(COLD);
    f.dispatcher = { running: true, pid: 42 };
    f.locks = [{ kind: "dispatch", path: "/l/.dispatch.lock", pid: 42, alive: true }];
    f.downRecord = { stacks: [], servers: [], dispatcher: true };
    const inv = inventory(f);
    expect(reopen(f)).toEqual([]);
    expect(lines(inv)).not.toContain("clear-lock /l/.dispatch.lock");
    expect(inv.locks.live.map((l) => l.path)).toEqual(["/l/.dispatch.lock"]);
    expect(inv.dispatcher).toEqual({ running: true, pid: 42, reopen: false });
  });

  it("clears a stale lock (its pid is gone: a crash) and reopens it, after the servers", () => {
    const f = clone(COLD);
    f.dispatcher = { running: false, pid: 99 };
    f.locks = [{ kind: "dispatch", path: "/l/.dispatch.lock", pid: 99, alive: false }];
    const inv = inventory(f);
    const l = lines(inv);
    expect(l[0]).toBe("clear-lock /l/.dispatch.lock");
    expect(l.indexOf("dispatch")).toBe(l.indexOf("serve a") + 2);
    expect(l[l.indexOf("dispatch") + 1]).toBe("offer-gc t-1");
    expect(inv.actions.find((a) => a.step === "dispatch")?.why).toMatch(/stale \(pid 99 is gone\)/);
    expect(inv.dispatcher).toEqual({ running: false, pid: null, reopen: true });
  });

  it("reopens it when the down record had it running, and not when it hadn't", () => {
    const f = clone(COLD);
    f.downRecord = { stacks: [], servers: [], testDb: false, dispatcher: true };
    expect(reopen(f)).toEqual(["dispatch"]);
    expect(inventory(f).actions.find((a) => a.step === "dispatch")?.why).toMatch(/down record had/);
    f.downRecord.dispatcher = false;
    expect(reopen(f)).toEqual([]);
  });

  it("marks the sessions it manages, and says so in the text", () => {
    const f = clone(COLD);
    f.managed = ["prd-a", "plan-x"];
    f.dispatcher = { running: true, pid: 7 };
    const inv = inventory(f);
    const opens = inv.actions.filter((a) => a.step === "open-session");
    expect(opens.map((a) => [a.session, a.managed ?? false])).toEqual([
      ["prd-a", true],
      ["prd-t", false],
      ["plan-u", false],
    ]);
    expect(formatInventory(inv)).toMatch(/^dispatcher: running \(pid 7\)$/m);
    expect(formatInventory(inventory(COLD))).toMatch(/^dispatcher: not running$/m);
  });
});

describe("with a down record", () => {
  const f = clone(COLD);
  f.downRecord = { at: "2026-11-19T20:00:00Z", stacks: ["t-2", "t", "gone"], servers: ["t-2"], testDb: true };
  f.downRecordPath = "/l/.down.json";
  const inv = inventory(f);

  it("brings back exactly its stacks (in its order) and servers, then deletes it", () => {
    expect(lines(inv)).toEqual([
      "test-db up",
      "stack up t-2",
      "stack up t",
      "serve t-2",
      "offer-gc t-1",
      "offer-gc t-4",
      "open-session a",
      "open-session t",
      "open-session plan-u",
      "delete-down-record /l/.down.json",
    ]);
  });

  it("warns about a name with no worktree now", () => {
    expect(inv.warnings.join("\n")).toMatch(/gone, which has no worktree/);
  });

  it("leaves the test Postgres down when the record had it down", () => {
    const g = clone(f);
    g.downRecord.testDb = false;
    expect(lines(inventory(g))).not.toContain("test-db up");
  });

  it("ignores an unreadable record, with a warning", () => {
    const g = clone(COLD);
    g.downRecordError = "/l/.down.json: Unexpected token";
    const i = inventory(g);
    expect(lines(i)).not.toContain("delete-down-record /l/.down.json");
    expect(i.warnings.join("\n")).toMatch(/can't read the down record/);
  });
});

describe("cut-off landings", () => {
  it("lists each, to resume first, after the dispatcher and before gc and the sessions", () => {
    const f = clone(COLD);
    f.landings = [
      { branch: "prd/t", path: "pr", step: "dev-sync", at: "2026-11-20T10:00:00Z" },
      { branch: "hotfix/y", path: "local", step: "merge" },
    ];
    const inv = inventory(f);
    const resumes = inv.actions.filter((a) => a.step === "resume-landing");
    expect(resumes.map(actionLine)).toEqual(["resume-landing prd/t", "resume-landing hotfix/y"]);
    expect(resumes[0].why).toContain("pnpm prd land --resume prd/t");
    const steps = inv.actions.map((a) => a.step);
    expect(steps.indexOf("resume-landing")).toBeLessThan(steps.indexOf("offer-gc"));
    expect(inv.landings).toEqual([
      { branch: "prd/t", path: "pr", step: "dev-sync", at: "2026-11-20T10:00:00Z" },
      { branch: "hotfix/y", path: "local", step: "merge", at: null },
    ]);
    expect(formatInventory(inv)).toMatch(/cut-off landings[^\n]*\n {2}prd\/t: at dev-sync \(pr\)/);
  });

  it("has none without a journal", () => {
    expect(inventory(COLD).landings).toEqual([]);
    expect(lines(inventory(COLD)).some((l) => l.startsWith("resume-landing"))).toBe(false);
  });
});

describe("order and disk", () => {
  it("keeps the fixed order: Docker, locks, test Postgres, stacks, servers, gc, sessions, record", () => {
    const f = clone(COLD);
    f.docker.running = false;
    f.locks = [{ kind: "slot", path: "/l/.slots/7", alive: false }];
    f.downRecord = { stacks: ["t"], servers: ["t"], dispatcher: true };
    f.downRecordPath = "/l/.down.json";
    f.landings = [{ branch: "prd/t", path: "pr", step: "dev-sync" }];
    const steps = inventory(f).actions.map((a) => a.step);
    const ranks = steps.map((s) => STEPS.indexOf(s));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect([...new Set(steps)]).toEqual(STEPS);
  });

  it("flags low disk with a warning and keeps the actions", () => {
    const f = clone(COLD);
    f.disk = { freeGb: 4.2, minGb: 10 };
    const inv = inventory(f);
    expect(inv.disk.low).toBe(true);
    expect(inv.warnings.join("\n")).toMatch(/4.2 GB, under 10 GB.*pnpm prd reclaim/);
    expect(lines(inv)).toEqual(lines(inventory(COLD)));
  });
});

describe("formatInventory", () => {
  it("prints the table, the locks and the numbered actions", () => {
    const f = clone(COLD);
    f.locks = [{ kind: "slot", path: "/l/.slots/7", holder: "gone-1", alive: false, why: "no worktree" }];
    const text = formatInventory(inventory(f));
    expect(text).toMatch(/^NAME\s+CLASS\s+BRANCH/);
    expect(text).toMatch(/t-4\s+merged\s+slice\/t\/4\s+dirty/);
    expect(text).toMatch(/stale locks \(cleared\):\n {2}slot {4}\/l\/\.slots\/7 \(gone-1\): no worktree/);
    expect(text).toMatch(/ {3}1\. clear-lock \/l\/\.slots\/7/);
  });

  it("says when there's nothing to do", () => {
    expect(
      formatInventory(inventory({ worktrees: [], docker: { running: true }, testDb: { running: true } })),
    ).toMatch(/\(no worktrees\)[\s\S]*actions:\n {2}\(none\)/);
  });
});
