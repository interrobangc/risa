// `pnpm prd recover --dry-run` (recover.sh, recover-lib.mjs, inventory-facts.mjs,
// inventory.mjs): what it finds and plans after a cold boot, with everything up, with
// a live or dead dispatcher, a down record or a cut-off landing; and that it changes
// nothing on disk. The throwaway repo and fakes are recover-fixture.mjs's.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sharedNames } from "./config.mjs";
import {
  DEAD_PID,
  root,
  recover,
  okRecover,
  json,
  steps,
  calls,
  put,
  drop,
  snapshot,
  main,
  loops,
  env,
  state,
  useRecoverRepo,
} from "./recover-fixture.mjs";

describe("recover --dry-run", () => {
  useRecoverRepo();

  it("classifies every worktree", () => {
    const got = Object.fromEntries(json().worktrees.map((w) => [w.name, w.class]));
    expect(got).toEqual({
      "plan-u": "plan",
      t: "prd",
      "t-1": "merged",
      "t-2": "active",
      "t-3": "stackless",
      "t-4": "merged",
    });
  });

  it("after a cold boot: stale locks, test Postgres, active stacks, prd servers, gc offers, sessions", () => {
    expect(steps(json())).toEqual([
      `clear-lock ${join(loops, ".slots/9")}`,
      "test-db up",
      "stack up t",
      "stack up t-2",
      "serve t",
      "offer-gc t-1",
      "offer-gc t-4",
      "open-session t",
      "open-session plan-u",
    ]);
  });

  it("marks the dirty merged slice and keeps the live slot lease", () => {
    const inv = json();
    expect(inv.actions.find((a) => a.target === "t-4")).toMatchObject({ step: "offer-gc", dirty: true });
    expect(inv.locks.live.map((l) => l.path)).toEqual([join(loops, ".slots/1")]);
  });

  it("with the stack engine down, starts it first", () => {
    put("engine-down", "");
    try {
      const inv = json();
      expect(steps(inv)[0]).toBe("docker start");
      expect(calls()).not.toMatch(/^(stack (start|up)|test-db up)( |$)/m);
    } finally {
      drop("engine-down");
    }
  });

  it("with everything up, has only gc offers and sessions besides the locks", () => {
    put("running", "sample-loop1\nsample-loop2\n");
    put("testdb-up", "");
    let inv;
    try {
      inv = json({ FAKE_LISTEN: "6173" });
    } finally {
      drop("running", "testdb-up");
    }
    expect(inv.actions.filter((a) => a.step !== "clear-lock").map((a) => a.step)).toEqual([
      "offer-gc",
      "offer-gc",
      "open-session",
      "open-session",
    ]);
    expect(inv.worktrees.find((w) => w.name === "t")).toMatchObject({ containersUp: 1, serverRunning: true });
  });

  it("leaves a live dispatcher's lock alone, and clears a stale backlog lock", () => {
    const lock = join(loops, ".dispatch.lock");
    const backlogLock = join(main, ".git", sharedNames().backlogLock);
    writeFileSync(lock, `${process.pid}\n`);
    mkdirSync(backlogLock);
    try {
      let inv = json();
      expect(inv.locks.live.map((l) => l.kind)).toEqual(expect.arrayContaining(["dispatch", "backlog"]));
      expect(steps(inv)).not.toContain(`clear-lock ${lock}`);
      expect(steps(inv)).not.toContain("dispatch");
      expect(inv.dispatcher).toEqual({ running: true, pid: process.pid, reopen: false, intent: null });
      const old = (Date.now() - 120_000) / 1000;
      utimesSync(backlogLock, old, old);
      inv = json();
      expect(steps(inv)).toContain(`clear-lock ${backlogLock}`);
    } finally {
      rmSync(lock);
      rmSync(backlogLock, { recursive: true });
    }
  });

  it("names a dispatcher whose pid is gone: clears its lock and reopens it", () => {
    const lock = join(loops, ".dispatch.lock");
    writeFileSync(lock, `${DEAD_PID}\n`);
    try {
      const inv = json();
      expect(steps(inv)).toEqual(expect.arrayContaining([`clear-lock ${lock}`, "dispatch"]));
      expect(steps(inv).indexOf("dispatch")).toBe(steps(inv).indexOf("serve t") + 1);
      expect(inv.dispatcher).toEqual({ running: false, pid: null, reopen: true, intent: null });
      expect(okRecover(["--dry-run"])).toMatch(/^dispatcher: not running \(recover reopens it\)$/m);
    } finally {
      rmSync(lock);
    }
  });

  it("marks the open-session actions of managed sessions", () => {
    const sessions = join(loops, ".sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "prd-t.json"), JSON.stringify({ pid: 1, managed: true }));
    writeFileSync(join(sessions, "plan-u.json"), JSON.stringify({ pid: 2 }));
    try {
      const opens = json().actions.filter((a) => a.step === "open-session");
      expect(opens.map((a) => [a.session, a.managed ?? false])).toEqual([
        ["prd-t", true],
        ["plan-u", false],
      ]);
    } finally {
      rmSync(sessions, { recursive: true });
    }
  });

  it("follows a down record, and says it would delete it", () => {
    const record = join(loops, ".down.json");
    writeFileSync(
      record,
      JSON.stringify({ at: "2026-11-19T20:00:00Z", stacks: ["t-2"], servers: [], testDb: false }),
    );
    try {
      const inv = json();
      expect(steps(inv).filter((s) => !s.startsWith("clear-lock"))).toEqual([
        "stack up t-2",
        "offer-gc t-1",
        "offer-gc t-4",
        "open-session t",
        "open-session plan-u",
        `delete-down-record ${record}`,
      ]);
      expect(existsSync(record)).toBe(true);
    } finally {
      rmSync(record);
    }
  });

  it("lists a cut-off landing from its journal, to resume first", () => {
    mkdirSync(join(loops, ".landing"), { recursive: true });
    writeFileSync(
      join(loops, ".landing", "prd-t.json"),
      JSON.stringify({
        branch: "prd/t",
        path: "pr",
        tip: "a".repeat(40),
        step: "dev-sync",
        at: "2026-11-20T10:00:00Z",
      }),
    );
    const inv = json();
    expect(inv.landings).toEqual([
      { branch: "prd/t", path: "pr", step: "dev-sync", at: "2026-11-20T10:00:00Z" },
    ]);
    expect(inv.actions.filter((a) => a.step === "resume-landing").map((a) => a.target)).toEqual(["prd/t"]);
    rmSync(join(loops, ".landing"), { recursive: true });
  });

  it("flags low disk", () => {
    const inv = json({ RISA_FREE_GB: "3", RISA_MIN_FREE_GB: "5" });
    expect(inv.disk).toEqual({ freeGb: 3, minGb: 5, low: true });
    expect(okRecover(["--dry-run"], { RISA_FREE_GB: "3" })).toMatch(/disk: 3 GB free \(line: 10 GB\) · LOW/);
  });

  it("changes nothing on disk, and starts, stops, brings up or down nothing", () => {
    const before = snapshot(root);
    const text = okRecover(["--dry-run"]);
    expect(text).toMatch(/^NAME\s+CLASS/);
    expect(text).toMatch(/ 2\. test-db up/);
    expect(text).toMatch(/Dry run: nothing was changed\.$/m);
    okRecover(["--dry-run", "--json"]);
    expect(snapshot(root)).toEqual(before);
    expect(calls()).toMatch(/^stack engine status/m);
    expect(calls()).not.toMatch(/^(stack (up|down|start|stop|engine start)|test-db (up|down)|serve)( |$)/m);
    expect(calls()).not.toMatch(/^(claude|osascript|open) /m);
    expect(existsSync(join(state, "agent-args"))).toBe(false);
  });

  it("refuses unknown options, a bad time, and waiting in a dry run", () => {
    expect(recover(["--bogus"]).stderr).toMatch(/unknown option --bogus/);
    expect(recover(["--at", "25:00"]).stderr).toMatch(/24-hour time/);
    expect(recover(["--dry-run", "--wait"]).stderr).toMatch(/doesn't wait/);
    expect(calls()).not.toMatch(/^(stack|test-db|serve|sleep) /m);
  });

  it("lists recover and down in pnpm prd help", () => {
    const r = spawnSync("bash", [join(main, "loops/prd.sh"), "help"], { encoding: "utf8", env });
    expect(r.stdout).toMatch(/recover \[--at HH:MM\] \[--wait\]/);
    expect(r.stdout).toMatch(/recover --dry-run \[--json\]/);
    expect(r.stdout).toMatch(/^ {4}down {2,}before a planned restart/m);
    expect(r.stdout).toMatch(/\[--no-agent\]/);
    expect(r.stdout).toMatch(/claude --remote-control recover/);
    expect(r.stdout).toMatch(/^ {4}open <name> \[--print\] {2,}reopen/m);
    expect(r.stdout).toMatch(/^ {4}down --stay \[<why>\] {2,}the same, and stay down/m);
    expect(r.stdout).toMatch(/^ {4}autostart install\|remove\|status {2,}the LaunchAgent/m);
    expect(r.stdout).toMatch(/^ {4}watchdog \[--dry-run \[--json\]\] {2,}recover --unattended only/m);
  });
});
