// The dispatcher's lock, pause, resume and stop, taking over a stale lock
// (B-454), and tidy: dispatch.mjs on dispatch-fixture.mjs's throwaway repo.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TAKEOVER_STALE_MS, TIDY_EVERY_MS, lockHolder, takeLock } from "./dispatch.mjs";
import {
  main,
  loops,
  env,
  scripts,
  calls,
  openCalls,
  dispatch,
  ok,
  dstate,
  logText,
  setRows,
  setClock,
  state,
  T0,
  until,
  useDispatchRepo,
} from "./dispatch-fixture.mjs";

useDispatchRepo();

describe("the lock, pause, resume and stop", () => {
  it("a second instance refuses; a dead lock is taken over", async () => {
    const holder = spawn("sleep", ["30"]);
    try {
      writeFileSync(join(loops, ".dispatch.lock"), `${holder.pid}\n`);
      const r = dispatch();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`a dispatcher is already running (pid ${holder.pid})`);
    } finally {
      holder.kill();
    }
    await new Promise((r) => holder.on("exit", r));
    setRows([{ topic: "a", state: "planned" }]);
    expect(ok()).toContain("start a");
    expect(existsSync(join(loops, ".dispatch.lock"))).toBe(false);
  });

  it("--pause stops actions and --resume restores them", () => {
    setRows([{ topic: "a", state: "planned" }]);
    expect(ok(["--pause", "usage limit"])).toContain("Dispatcher paused: usage limit (none is running)");
    expect(dstate().paused).toMatchObject({ why: "usage limit" });
    expect(ok()).toContain("nothing: the dispatcher is paused");
    expect(calls("new")).toEqual([]);
    expect(ok(["--resume"])).toContain("Dispatcher resumed");
    expect(ok()).toContain("start a");
    expect(calls("new")).toEqual(["prd a"]);
  });

  it("--stop ends the running instance and frees the lock", async () => {
    setRows([]);
    const child = spawn("node", [scripts("dispatch.mjs"), "--every", "1"], { cwd: main, env });
    const exited = new Promise((r) => child.on("exit", (code) => r(code)));
    await until(() => existsSync(join(loops, ".dispatch.lock")) && existsSync(join(loops, ".dispatch.log")));
    expect(ok(["--stop"])).toContain(`Stopped the dispatcher (pid ${child.pid})`);
    expect(await exited).toBe(0);
    expect(existsSync(join(loops, ".dispatch.lock"))).toBe(false);
    expect(logText()).toContain("stopped (SIGTERM)");
    expect(ok(["--stop"])).toContain("No dispatcher is running.");
  });
});

describe("a backlog command that hangs (RISA-1094)", () => {
  const hang = { STUB_BACKLOG_HANG: "1", RISA_DISPATCH_RUN_SECS: "1" };
  /** The hung stub's pid, once it has started hanging; 0 before. */
  const hungPid = () => {
    try {
      return Number(readFileSync(join(state, "backlog.hang"), "utf8"));
    } catch {
      return 0;
    }
  };
  const alive = (/** @type {number} */ pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // A stub the dispatcher failed to kill must not outlive its test.
  afterEach(() => {
    const pid = hungPid();
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
  });

  it("ends the tick with a line naming the command and its limit, starting and closing nothing", () => {
    setRows([{ topic: "a", state: "planned" }]);
    const t0 = Date.now();
    const out = ok(["--once"], hang);
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(out).toMatch(/nothing: couldn't gather the facts \(.*prd list timed out after 1s \(killed\)\)/);
    expect(calls("new")).toEqual([]);
    expect(calls("rm")).toEqual([]);
    expect(openCalls()).toEqual([]);
    expect(alive(hungPid())).toBe(false);
  });

  it("a SIGTERM sent while it hangs stops the dispatcher within a few seconds", async () => {
    setRows([{ topic: "a", state: "planned" }]);
    const child = spawn("node", [scripts("dispatch.mjs"), "--every", "1"], {
      cwd: main,
      env: { ...env, ...hang, RISA_DISPATCH_RUN_SECS: "2" },
    });
    try {
      const exited = new Promise((r) => child.on("exit", (code) => r(code)));
      await until(() => hungPid() > 0);
      const sent = Date.now();
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
      expect(Date.now() - sent).toBeLessThan(5000);
      const log = logText();
      expect(log).toMatch(/prd list timed out after 2s \(killed\)/);
      expect(log).toContain("stopped (SIGTERM)");
      expect(log).not.toContain("start a");
      expect(calls("new")).toEqual([]);
      expect(existsSync(join(loops, ".dispatch.lock"))).toBe(false);
      expect(alive(hungPid())).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("one that answers in time behaves as before", () => {
    setRows([{ topic: "a", state: "planned" }]);
    expect(ok(["--once"], { RISA_DISPATCH_RUN_SECS: "5" })).toContain("start a");
    expect(calls("new")).toEqual(["prd a"]);
  });
});

describe("taking over a stale lock (B-454)", () => {
  // Two takers in this process, each with a live pid of its own; `between` runs
  // the other taker at the point the old unlink-and-write raced.
  const A = process.pid;
  const B = process.ppid;
  /** @type {string} */ let dir;
  /** @type {string} */ let lock;
  /** @type {number} */ let dead;

  beforeAll(() => {
    const r = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" });
    dead = Number(r.stdout.trim());
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dispatch-lock-"));
    lock = join(dir, ".dispatch.lock");
    writeFileSync(lock, `${dead}\n`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const held = () => Number(readFileSync(lock, "utf8").trim());

  it("two takers racing over a dead holder's lock end with one holder", () => {
    /** @type {any} */ let inner;
    const outer = takeLock(lock, { pid: A, between: () => (inner = takeLock(lock, { pid: B })) });
    expect(inner).toEqual({ ok: true });
    expect(outer).toEqual({ ok: false, pid: B });
    expect(held()).toBe(B);
    expect(existsSync(`${lock}.takeover`)).toBe(false);
  });

  it("the same race the other way round also ends with one holder", () => {
    /** @type {any} */ let inner;
    const outer = takeLock(lock, { pid: B, between: () => (inner = takeLock(lock, { pid: A })) });
    expect(inner).toEqual({ ok: true });
    expect(outer).toEqual({ ok: false, pid: A });
    expect(held()).toBe(A);
  });

  it("a lone taker takes a dead holder's lock", () => {
    expect(takeLock(lock, { pid: A })).toEqual({ ok: true });
    expect(lockHolder(lock)).toBe(A);
  });

  it("a live holder's lock is never taken", () => {
    writeFileSync(lock, `${B}\n`);
    expect(takeLock(lock, { pid: A })).toEqual({ ok: false, pid: B });
    expect(held()).toBe(B);
  });

  it("a crashed taker's stale guard is cleared; a fresh one is waited on", () => {
    mkdirSync(`${lock}.takeover`);
    const old = (Date.now() - TAKEOVER_STALE_MS - 1000) / 1000;
    utimesSync(`${lock}.takeover`, old, old);
    expect(takeLock(lock, { pid: A })).toEqual({ ok: true });
    expect(held()).toBe(A);

    writeFileSync(lock, `${dead}\n`);
    mkdirSync(`${lock}.takeover`);
    expect(takeLock(lock, { pid: A })).toEqual({ ok: false, pid: 0 });
    expect(held()).toBe(dead);
  });
});

describe("tidy", () => {
  it("runs once the six hours have passed, not before, and never on a tick that acted", () => {
    ok();
    expect(dstate().lastTidy).toBe(T0 * 1000);
    setClock(T0 + TIDY_EVERY_MS / 1000 - 1);
    ok();
    expect(calls("tidy")).toEqual([]);
    // Due, but the tick starts a topic: no tidy.
    setClock(T0 + TIDY_EVERY_MS / 1000);
    setRows([{ topic: "a", state: "planned" }]);
    ok();
    expect(calls("tidy")).toEqual([]);
    // The next idle tick tidies, once.
    setRows([]);
    expect(ok()).toContain("tidy --yes: removed 0 safe ones");
    expect(calls("tidy")).toEqual(["--yes"]);
    ok();
    expect(calls("tidy")).toEqual(["--yes"]);
    expect(dstate().lastTidy).toBe((T0 + TIDY_EVERY_MS / 1000) * 1000);
  });
});
