// The dispatcher (`pnpm prd dispatch`: dispatch.mjs): its pure parts, one tick
// per action, and the load gate and rules through a tick, on the throwaway repo
// dispatch-fixture.mjs sets up. Its other tests are split by group so Vitest's
// workers spread them: dispatch-{code,lock,deaths,requests,keep-alive,
// stuck-decision,stuck-tick,drain}.test.mjs.
import { existsSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROTATING_GRACE_MS } from "./dispatch-pick.mjs";
import {
  PICKUP_EVERY_S,
  TIDY_EVERY_MS,
  answerAction,
  helperLine,
  pickupDue,
  pickupEvery,
  sessionLine,
  tidyDue,
} from "./dispatch.mjs";
import {
  git,
  root,
  main,
  loops,
  sessions,
  asks,
  state,
  scripts,
  calls,
  openCalls,
  dispatch,
  ok,
  dstate,
  logText,
  setRows,
  setClock,
  deadRecord,
  worktree,
  useDispatchRepo,
} from "./dispatch-fixture.mjs";

useDispatchRepo();

describe("the pure parts", () => {
  it("reads a reopen ask's answer", () => {
    expect(answerAction("reopen again")).toBe("reset");
    expect(answerAction("1")).toBe("reset");
    expect(answerAction("Reopen it")).toBe("reset");
    expect(answerAction("hold the topic")).toBe("hold");
    expect(answerAction("hold")).toBe("hold");
    expect(answerAction("2")).toBe("hold");
    expect(answerAction("no idea")).toBeNull();
    expect(answerAction(null)).toBeNull();
  });

  it("tidies only on an idle, unpaused tick six hours after the last", () => {
    const idle = { action: "none", paused: false };
    expect(tidyDue({ lastTidy: 0 }, TIDY_EVERY_MS, idle)).toBe(true);
    expect(tidyDue({ lastTidy: 0 }, TIDY_EVERY_MS - 1, idle)).toBe(false);
    expect(tidyDue({ lastTidy: 0 }, TIDY_EVERY_MS, { action: "start", paused: false })).toBe(false);
    expect(tidyDue({ lastTidy: 0 }, TIDY_EVERY_MS, { action: "none", paused: true })).toBe(false);
    expect(tidyDue({}, TIDY_EVERY_MS, idle)).toBe(false);
  });

  it("picks up once a period, never paused or off; RISA_PICKUP_EVERY sets the period", () => {
    const every = pickupEvery(undefined);
    expect(every).toBe(PICKUP_EVERY_S * 1000);
    expect(pickupEvery("60")).toBe(60_000);
    expect(pickupEvery("nope")).toBe(every);
    expect(pickupEvery("off")).toBeNull();
    expect(pickupDue({}, 0, { paused: false, everyMs: every })).toBe(true);
    expect(pickupDue({ lastPickup: 0 }, every - 1, { paused: false, everyMs: every })).toBe(false);
    expect(pickupDue({ lastPickup: 0 }, every, { paused: false, everyMs: every })).toBe(true);
    expect(pickupDue({}, 0, { paused: true, everyMs: every })).toBe(false);
    expect(pickupDue({}, 0, { paused: false, everyMs: null })).toBe(false);
  });

  it("builds the run-through, managed session lines, with no item ids", () => {
    expect(sessionLine({ kind: "plan", topic: "t", dir: "/l/plan-t", wrapper: "/b/session.sh" })).toBe(
      `cd /l/plan-t && /b/session.sh plan-t --auto --managed -- --model opus --remote-control plan-t "$(/b/prompt.sh plan t --auto)"`,
    );
    expect(sessionLine({ kind: "prd", topic: "t", dir: "/l/t", wrapper: "/b/session.sh" })).toBe(
      `cd /l/t && /b/session.sh prd-t --auto --managed -- --remote-control prd-t "$(/b/prompt.sh orchestrator t --auto)"`,
    );
    const h = helperLine({ main: "/m", claude: "claude", line: "a: it's dead" });
    expect(h).toMatch(/^cd \/m && claude --model haiku --remote-control dispatch-push '/);
    expect(h).toContain("PushNotification");
    expect(h).toContain("pnpm prd end");
  });
});

describe("one tick per action", () => {
  it("start: makes the PRD worktree, writes a managed record, opens a run-through orchestrator in the background", () => {
    setRows([{ topic: "a", state: "planned" }]);
    const out = ok();
    expect(out).toContain("start a: planned, and nothing stops it");
    expect(calls("new")).toEqual(["prd a"]);
    const [open] = openCalls();
    expect(open).toEqual([
      "--command",
      `cd ${join(loops, "a")} && ${scripts("session.sh")} prd-a --auto --managed -- --remote-control prd-a "$(${scripts("prompt.sh")} orchestrator a --auto)"`,
      "--title",
      "prd-a",
      "--background",
    ]);
    expect(JSON.parse(readFileSync(join(sessions, "prd-a.json"), "utf8"))).toMatchObject({
      kind: "prd",
      topic: "a",
      managed: true,
      auto: true,
    });
    expect(logText()).toMatch(/^\S+Z start a: planned, and nothing stops it\n {2}new\.sh prd a: made a\n/);
  });

  it("plan: makes the plan worktree and opens a managed, run-through planner with no item ids", () => {
    setRows([{ topic: "p", state: "to-write", waiting: 4 }]);
    expect(ok()).toContain("plan p: 4 waiting, no plan yet");
    expect(calls("new")).toEqual(["plan p"]);
    const [open] = openCalls();
    expect(open[1]).toBe(
      `cd ${join(loops, "plan-p")} && ${scripts("session.sh")} plan-p --auto --managed -- --model opus --remote-control plan-p "$(${scripts("prompt.sh")} plan p --auto)"`,
    );
    expect(open[1]).not.toMatch(/B-\d/);
  });

  it("plan: a design row's planner opens on Fable", () => {
    setRows([{ topic: "pd", state: "to-write", waiting: 1, flags: ["design"] }]);
    ok();
    expect(openCalls()[0][1]).toContain('--model fable --remote-control plan-pd "$(');
  });

  it("the PRD cap defaults to four, and RISA_MAX_PRDS overrides it", () => {
    const names = ["w", "x", "y"];
    for (const n of names) worktree(n, `prd/${n}`);
    const running = names.map((topic) => ({ topic, state: "running" }));
    setRows([...running, { topic: "a", state: "planned" }]);
    expect(ok(["--dry-run"])).toContain("start a:");
    expect(ok(["--dry-run"], { RISA_MAX_PRDS: "3" })).toContain("no free slot (3 of 3 running)");
    worktree("z", "prd/z");
    setRows([...running, { topic: "z", state: "running" }, { topic: "a", state: "planned" }]);
    expect(ok(["--dry-run"])).toContain("no free slot (4 of 4 running)");
    expect(ok(["--dry-run"], { RISA_MAX_PRDS: "5" })).toContain("start a:");
  });

  it("--cap stores the PRD cap, read every tick over RISA_MAX_PRDS; default clears it", () => {
    const names = ["w", "x", "y"];
    for (const n of names) worktree(n, `prd/${n}`);
    setRows([...names.map((topic) => ({ topic, state: "running" })), { topic: "a", state: "planned" }]);
    const lowered = ok(["--cap", "2"]);
    expect(lowered).toContain("PRD cap 2 (pnpm prd dispatch --cap; was 4)");
    expect(lowered).toContain("3 PRD worktrees now: none start until fewer than 2 remain");
    expect(readFileSync(join(loops, ".prd-cap"), "utf8")).toBe("2\n");
    expect(logText()).toContain("PRD cap 2 (pnpm prd dispatch --cap; was 4)");
    expect(readdirSync(join(loops, ".notices")).length).toBeGreaterThan(0);
    // Lowering ends nothing: the running three stay, and no start.
    expect(ok(["--dry-run"], { RISA_MAX_PRDS: "6" })).toContain("no free slot (3 of 2 running)");
    expect(ok(["--cap", "6"])).toContain("3 more may start");
    expect(ok(["--dry-run"])).toContain("start a:");
    expect(ok(["--cap", "default"])).toContain("PRD cap 4 (default; was 6)");
    expect(existsSync(join(loops, ".prd-cap"))).toBe(false);
    expect(ok(["--dry-run"], { RISA_MAX_PRDS: "3" })).toContain("no free slot (3 of 3 running)");
    for (const bad of ["0", "20", "two", ""]) {
      const r = dispatch(["--cap", bad]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("--cap takes a number from 1 to 19, or default");
    }
  });

  it("a failed worktree opens nothing", () => {
    setRows([{ topic: "a", state: "planned" }]);
    const out = ok(["--once"], { STUB_NEW_FAIL: "1" });
    expect(out).toContain("new.sh prd a: failed (exit 1): no room");
    expect(openCalls()).toEqual([]);
    expect(existsSync(join(sessions, "prd-a.json"))).toBe(false);
  });

  it("a start whose tab never opens leaves no record, no worktree and no count, and starts on a later tick (B-468)", () => {
    setRows([{ topic: "a", state: "planned" }]);
    const out = ok(["--once"], { STUB_NEW_MAKE: "1", STUB_OPEN_FAIL: "prd-a" });
    expect(out).toContain(
      "  prd-a: its tab never opened, not counted as a death (failed (exit 1): no tab); a later tick retries; a removed",
    );
    expect(calls("rm")).toEqual(["a --no-registry"]);
    expect(existsSync(join(loops, "a"))).toBe(false);
    expect(existsSync(join(sessions, "prd-a.json"))).toBe(false);
    expect(dstate().reopens ?? {}).toEqual({});
    // One line for the failed open, after the new.sh line.
    expect(
      logText()
        .split("\n")
        .filter((l) => l.includes("prd-a")),
    ).toHaveLength(1);
    // The opener works again: the next tick starts it afresh, no reopen.
    git(main, "branch", "-q", "-D", "prd/a");
    expect(ok(["--once"], { STUB_NEW_MAKE: "1" })).toContain("start a: planned, and nothing stops it");
    expect(calls("new")).toEqual(["prd a", "prd a"]);
    expect(openCalls().at(-1)?.slice(2)).toEqual(["--title", "prd-a", "--background"]);
    expect(dstate().reopens ?? {}).toEqual({});
  });

  it("a planner whose tab never opens doesn't hold the planner slot", () => {
    setRows([
      { topic: "p", state: "to-write", waiting: 2 },
      { topic: "q", state: "to-write", waiting: 2 },
    ]);
    ok(["--once"], { STUB_NEW_MAKE: "1", STUB_OPEN_FAIL: "plan-p" });
    expect(calls("rm")).toEqual(["plan-p --no-registry"]);
    expect(existsSync(join(loops, "plan-p"))).toBe(false);
    // No planner runs: another may be planned (here p again, by row order), none is reopened.
    const next = ok(["--dry-run"]);
    expect(next).toContain("plan p: 2 waiting, no plan yet");
    expect(next).not.toContain("a planner is running");
    expect(next).not.toMatch(/reopen plan-p/);
  });

  it("a reopen whose tab never opens adds no count and files no ask: a later tick retries (B-468)", () => {
    worktree("a", "prd/a");
    deadRecord("prd-a");
    setRows([{ topic: "a", state: "running" }]);
    for (let i = 0; i < 4; i++) {
      const out = ok(["--once"], { STUB_OPEN_FAIL: "a" });
      expect(out).toContain("reopen prd-a: prd-a died (reopen 1 of 2)");
      expect(out).toContain("  prd-a: its tab never opened, not counted as a death");
    }
    expect(dstate().reopens ?? {}).toEqual({});
    expect(existsSync(asks)).toBe(false);
    expect(calls("rm")).toEqual([]);
    expect(existsSync(join(loops, "a"))).toBe(true);
    // Once a tab opens, it counts as the first reopen.
    expect(ok()).toContain("reopen prd-a: prd-a died (reopen 1 of 2)");
    expect(dstate().reopens).toEqual({ "prd-a": 1 });
  });

  it("reopen: the opener in the background, counted", () => {
    worktree("a", "prd/a");
    deadRecord("prd-a");
    setRows([{ topic: "a", state: "running" }]);
    expect(ok()).toContain("reopen prd-a: prd-a died (reopen 1 of 2)");
    expect(openCalls()).toEqual([["a", "--background"]]);
    expect(dstate().reopens).toEqual({ "prd-a": 1 });
  });

  it("reopens a record marked rotating over five minutes ago (its mtime), not a fresh one", () => {
    worktree("a", "prd/a");
    deadRecord("prd-a", { rotating: true });
    setRows([{ topic: "a", state: "running" }]);
    setClock(Math.floor(Date.now() / 1000));
    expect(ok()).toContain("a: its orchestrator is being rotated");
    expect(openCalls()).toEqual([]);
    const old = new Date(Date.now() - ROTATING_GRACE_MS - 60_000);
    utimesSync(join(sessions, "prd-a.json"), old, old);
    expect(ok()).toContain("reopen prd-a: prd-a died (reopen 1 of 2)");
    expect(openCalls()).toEqual([["a", "--background"]]);
  });

  it("leaves a worktree opened by hand alone, and logs why", () => {
    worktree("a", "prd/a");
    deadRecord("prd-a", { managed: false });
    setRows([{ topic: "a", state: "running" }]);
    expect(ok()).toContain("a: opened by hand, its orchestrator isn't live (left alone)");
    expect(openCalls()).toEqual([]);
  });

  it("the work switch off starts and plans nothing; RISA_WORK_SELF=1 lifts it for that process", () => {
    setRows([
      { topic: "a", state: "planned" },
      { topic: "p", state: "to-write", waiting: 2 },
    ]);
    const machine = join(root, "machine.json");
    writeFileSync(machine, JSON.stringify({ repos: [{ path: main, work: false }] }));
    const off = ok(["--dry-run"], { RISA_MACHINE_CONFIG: machine });
    expect(off).toMatch(
      /^nothing: the work switch is off \("work": false for .* in .*machine\.json; RISA_WORK_SELF=1/,
    );
    expect(off).toMatch(/\n {2}a: the work switch is off \(/);
    expect(off).toMatch(/\n {2}p: the work switch is off \(/);
    ok(["--once"], { RISA_MACHINE_CONFIG: machine });
    expect(calls("new")).toEqual([]);
    expect(openCalls()).toEqual([]);
    expect(ok(["--dry-run"], { RISA_MACHINE_CONFIG: machine, RISA_WORK_SELF: "1" })).toContain(
      "start a: planned, and nothing stops it",
    );
    // A bad machine config: the loader's line, nothing started.
    writeFileSync(machine, JSON.stringify({ repos: [{ path: "repo", work: "no" }] }));
    expect(ok(["--dry-run"], { RISA_MACHINE_CONFIG: machine })).toContain(
      "repos.0.path: must be an absolute path",
    );
  });

  it("--dry-run prints the pick and writes and opens nothing", () => {
    setRows([
      { topic: "a", state: "planned" },
      { topic: "b", state: "planned" },
    ]);
    const out = ok(["--dry-run"], { RISA_ITERM_APP: join(root, "nowhere") });
    expect(out).toContain("start a: planned, and nothing stops it");
    expect(out).toContain("  b: waits a tick: a starts first");
    expect(out).toContain("(dry run: nothing written, nothing opened)");
    expect(calls("new")).toEqual([]);
    expect(openCalls()).toEqual([]);
    for (const f of [".dispatch.json", ".dispatch.log", ".dispatch.lock"])
      expect(existsSync(join(loops, f))).toBe(false);
    expect(existsSync(sessions)).toBe(false);
  });

  it("--dry-run prints a hold's date and reason beside it; a bare hold as before (RISA-986)", () => {
    setRows([
      { topic: "a", state: "planned" },
      { topic: "h", state: "hold", flags: ["hold"], held: { date: "2026-11-21", why: "waits on the user" } },
      { topic: "k", state: "hold", flags: ["hold"] },
    ]);
    const out = ok(["--dry-run"]);
    expect(out).toContain("\n  h: on hold since 2026-11-21: waits on the user\n");
    expect(out).toContain("\n  k: on hold\n");
  });

  it("refuses to run without iTerm2", () => {
    setRows([{ topic: "a", state: "planned" }]);
    const r = dispatch(["--once"], { RISA_ITERM_APP: join(root, "nowhere") });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("dispatch needs iTerm2");
    expect(calls("new")).toEqual([]);
  });

  it("a new.sh that fails after making the worktree removes it: no slot held at the next tick (B-452)", () => {
    setRows([{ topic: "a", state: "planned" }]);
    const out = ok(["--once"], { STUB_NEW_MAKE: "1", STUB_NEW_FAIL_AFTER: "1" });
    expect(out).toContain("  new.sh prd a: failed (exit 1): migrate failed; a removed");
    // Forced (a half setup holds no work) and with the registry row left alone.
    expect(calls("rm")).toEqual(["a --no-registry --force"]);
    expect(existsSync(join(loops, "a"))).toBe(false);
    expect(existsSync(join(sessions, "prd-a.json"))).toBe(false);
    expect(openCalls()).toEqual([]);
    expect(
      logText()
        .split("\n")
        .filter((l) => l.includes("new.sh")),
    ).toHaveLength(1);
    // The next tick sees no worktree opened by hand and no slot taken: it starts a again.
    const next = ok(["--dry-run"], { RISA_MAX_PRDS: "1" });
    expect(next).toContain("start a: planned, and nothing stops it");
    expect(next).not.toContain("opened by hand");
  });

  it("a planner whose new.sh fails after making its worktree doesn't hold the planner slot (B-452)", () => {
    setRows([{ topic: "p", state: "to-write", waiting: 2 }]);
    ok(["--once"], { STUB_NEW_MAKE: "1", STUB_NEW_FAIL_AFTER: "1" });
    expect(calls("rm")).toEqual(["plan-p --no-registry --force"]);
    expect(existsSync(join(loops, "plan-p"))).toBe(false);
    const next = ok(["--dry-run"]);
    expect(next).toContain("plan p: 2 waiting, no plan yet");
    expect(next).not.toContain("a planner is running");
  });

  it("a new.sh that fails before making the worktree removes nothing", () => {
    setRows([{ topic: "a", state: "planned" }]);
    expect(ok(["--once"], { STUB_NEW_FAIL: "1" })).toContain("  new.sh prd a: failed (exit 1): no room\n");
    expect(calls("rm")).toEqual([]);
  });
});

describe("the load gate and the rules through a tick", () => {
  it("busy: starts and plans nothing, and logs why", () => {
    writeFileSync(join(root, "load"), "30 30 30");
    try {
      setRows([
        { topic: "a", state: "planned" },
        { topic: "p", state: "to-write", waiting: 2 },
      ]);
      const out = ok();
      expect(out).toContain("nothing: the machine is busy");
      expect(out).toContain("(the 5-minute load 30 is over 8)");
      expect(out).toContain("  a: the machine is busy");
      expect(out).toContain("  p: the machine is busy");
      expect(calls("new")).toEqual([]);
      expect(logText()).toContain("nothing: the machine is busy");
    } finally {
      writeFileSync(join(root, "load"), "1 1 1");
    }
  });

  it("starts a fixes topic as the pick says: with three waiting, or fewer when nothing else may start", () => {
    setRows([
      { topic: "fixes-a", state: "planned", flags: ["standing"], waiting: 1 },
      { topic: "b", state: "planned" },
    ]);
    expect(ok()).toContain("start b: planned, and nothing stops it");
    rmSync(join(state, "new.calls"));
    setRows([{ topic: "fixes-a", state: "planned", flags: ["standing"], waiting: 1 }]);
    expect(ok()).toContain("start fixes-a: 1 waiting fixes");
    expect(calls("new")).toEqual(["prd fixes-a"]);
  });

  it("starts a freshly planned topic on the next tick: no hold", () => {
    setRows([{ topic: "p", state: "to-write", waiting: 2 }]);
    ok();
    expect(calls("new")).toEqual(["plan p"]);
    // The planner landed its plan and removed its worktree: the row is planned.
    setRows([{ topic: "p", state: "planned", waiting: 2 }]);
    expect(ok()).toContain("start p: planned, and nothing stops it");
    expect(calls("new")).toEqual(["plan p", "prd p"]);
  });
});
