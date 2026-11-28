// `pnpm prd recover --unattended` (recover.sh): its own lock, the gated dispatcher
// and its kept intent, the agent in a background tab, the reports it files, the
// migrate marker, and down --stay. The throwaway repo and fakes are
// recover-fixture.mjs's.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RECOVER,
  DEAD_PID,
  recover,
  okRecover,
  json,
  steps,
  calls,
  put,
  drop,
  endDispatchers,
  main,
  loops,
  log,
  env,
  state,
  useRecoverRepo,
} from "./recover-fixture.mjs";

describe("recover unattended: the lock, the gated dispatcher, its intent, the migrate marker", () => {
  useRecoverRepo();
  const lock = () => join(loops, ".dispatch.lock");
  const intent = () => join(loops, ".dispatch-intent.json");
  const recoverLock = () => join(loops, ".recover.lock");
  const asks = () => join(loops, ".asks");
  const effects = () =>
    calls()
      .split("\n")
      .filter((l) => /^(stack (start|stop) |test-db (up|down)( |$)|(serve|open|osascript|claude) )/.test(l));
  const tabs = () => effects().filter((l) => l.startsWith("osascript") && l !== "osascript notify");
  const reports = () =>
    existsSync(asks())
      ? readdirSync(asks())
          .filter((f) => f.endsWith(".json"))
          .map((f) => JSON.parse(readFileSync(join(asks(), f), "utf8")))
      : [];
  /** A cold boot after a crash: nothing up, the dispatcher's lock left by a dead pid. */
  const crashed = () => {
    put("running", "");
    put("listen", "");
    drop("testdb-up", "engine-down");
    endDispatchers();
    writeFileSync(lock(), `${DEAD_PID}\n`);
    for (const f of [intent(), join(state, "dispatch-fails"), join(state, "agent-args")])
      rmSync(f, { force: true });
    rmSync(asks(), { recursive: true, force: true });
  };

  it.each([
    ["test-Postgres", { SAMPLE_STACK_FAIL: "test-db:up" }, /test Postgres/],
    ["stack", { SAMPLE_STACK_FAIL: "start:t-2" }, /stack t-2/],
    ["server", { SAMPLE_STACK_FAIL: "serve:t" }, /server t/],
  ])("a failed %s step leaves the dispatcher closed with its intent kept", (_, extra, failure) => {
    crashed();
    const r = recover(["--no-agent"], extra);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Didn't recover:/);
    expect(r.stderr).toMatch(failure);
    expect(r.stdout).toMatch(
      /the dispatcher: not reopened while something above didn't recover \(its intent is kept\)/,
    );
    expect(tabs()).toEqual([]);
    expect(existsSync(lock())).toBe(false); // the stale lock went, but only after the intent was kept
    expect(JSON.parse(readFileSync(intent(), "utf8"))).toMatchObject({ at: expect.any(String) });
    expect(json().dispatcher).toMatchObject({ running: false, reopen: true });
  });

  it("a failed reopen keeps the intent and opens no agent; the next run retries it", () => {
    crashed();
    put("dispatch-fails", "");
    let r = recover([], { RISA_RECOVER_DISPATCH_SECS: "0" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/didn't take its lock within 0s; its intent is kept/);
    expect(r.stderr).toMatch(/Didn't recover:\n {2}dispatcher/);
    expect(tabs()).toEqual(["osascript dispatch"]);
    expect(effects().some((l) => l.startsWith("claude"))).toBe(false);
    expect(existsSync(intent())).toBe(true);
    expect(existsSync(lock())).toBe(false);

    // The lock is gone and there's no down record: the intent alone brings it back.
    rmSync(join(state, "dispatch-fails"));
    rmSync(log);
    r = recover([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/• the dispatcher \(it was running\)/);
    expect(tabs()).toEqual(["osascript dispatch"]);
    expect(effects().at(-1)).toBe(`claude --remote-control ${RECOVER} (agent) [dispatcher locked]`);
    expect(existsSync(intent())).toBe(false);
  });

  it("drops a kept intent when the dispatcher already runs", () => {
    writeFileSync(intent(), '{ "at": "2026-11-20T08:00:00Z" }\n');
    const out = okRecover(["--no-agent"]);
    expect(out).toMatch(/• the dispatcher runs: dropped its kept intent/);
    expect(tabs()).toEqual([]);
    expect(existsSync(intent())).toBe(false);
  });

  it("a second recover exits without acting; a dead holder's lock is taken over and released", () => {
    writeFileSync(recoverLock(), `${process.pid}\n`);
    try {
      const r = recover(["--unattended"]);
      expect(r.status).toBe(75);
      expect(r.stderr).toMatch(
        new RegExp(`another recover is running \\(pid ${process.pid}\\): nothing done`),
      );
      expect(calls()).toBe(""); // not even the inventory's engine status, nor a report
      expect(reports()).toEqual([]);
      expect(readFileSync(recoverLock(), "utf8").trim()).toBe(String(process.pid));
      expect(okRecover(["--dry-run"])).toMatch(
        new RegExp(`^recover: running \\(pid ${process.pid}\\)$`, "m"),
      );
    } finally {
      rmSync(recoverLock(), { force: true });
    }

    writeFileSync(recoverLock(), `${DEAD_PID}\n`);
    okRecover(["--no-agent"]);
    expect(existsSync(recoverLock())).toBe(false);
  });

  it("--unattended needs no terminal: the agent opens in a background tab after the dispatcher holds its lock", () => {
    crashed();
    const r = spawnSync("bash", [join(main, "loops/prd.sh"), "recover", "--unattended"], {
      cwd: main,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /Opening the recovery agent \(claude --remote-control recover\) in a background tab/,
    );
    expect(tabs()).toEqual(["osascript dispatch", "osascript recover [dispatcher locked]"]);
    expect(effects().some((l) => l.startsWith("claude"))).toBe(false); // not in this process
    const line = readFileSync(join(state, "tab-recover"), "utf8");
    expect(line).toMatch(
      new RegExp(
        `^cd ${main} && exec \\S+/session\\.sh recover --kind recovery -- --remote-control recover `,
      ),
    );
    expect(line).toMatch(/You\\ are\\ the\\ recovery\\ agent|You are the recovery agent/);
    expect(reports()).toEqual([]);
    expect(existsSync(recoverLock())).toBe(false);
  });

  it("--unattended files one report on failure", () => {
    crashed();
    const failed = recover(["--unattended"], { SAMPLE_STACK_FAIL: "start:t" }); // t's stack doesn't start
    expect(failed.status).toBe(1);
    expect(tabs()).not.toContain("osascript recover");
    const got = reports();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "report", topic: "recover" });
    expect(got[0].text).toMatch(/recover --unattended stopped: didn't recover: stack t/);
    expect(existsSync(recoverLock())).toBe(false);
  });

  it("--unattended reports a step that gives up, like the stack engine not starting", () => {
    crashed();
    put("engine-down", "");
    const r = recover(["--unattended"], { SAMPLE_STACK_FAIL: "engine:start" });
    expect(r.status).toBe(1);
    const got = reports();
    expect(got).toHaveLength(1);
    expect(got[0].text).toMatch(/stopped: recover: Sample engine didn't start/);
    drop("engine-down");
  });

  it("a migrate marker left behind is reported and rerun, and cleared once it passes", () => {
    endDispatchers();
    rmSync(lock(), { force: true });
    rmSync(intent(), { force: true });
    put("running", "sample-loop1\nsample-loop2\n");
    put("testdb-up", "");
    put("listen", "6173\n");
    mkdirSync(join(loops, ".migrate"), { recursive: true });
    writeFileSync(join(loops, ".migrate/t"), "2026-11-20T08:00:00Z\n");
    writeFileSync(join(loops, ".migrate/gone-5"), "2026-11-20T08:00:00Z\n");
    const extra = {};
    const inv = json(extra);
    expect(inv.warnings.join("\n")).toMatch(
      /t: a migrate was cut off \(started 2026-11-20T08:00:00Z\); the stack step reruns it/,
    );
    expect(steps(inv)).toEqual(
      expect.arrayContaining(["stack up t", `clear-lock ${join(loops, ".migrate/gone-5")}`]),
    );
    expect(steps(inv)).not.toContain("stack up t-2");

    // A start that fails (its migrate, retried once in the hook) leaves the marker for the next run.
    const r = recover(["--no-agent"], { SAMPLE_STACK_FAIL: "start:t" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/a migrate here was cut off \(started 2026-11-20T08:00:00Z\): rerunning it/);
    expect(existsSync(join(loops, ".migrate/t"))).toBe(true);
    expect(existsSync(join(loops, ".migrate/gone-5"))).toBe(false);

    rmSync(log);
    okRecover(["--no-agent"], extra);
    expect(effects().filter((l) => /^stack start/.test(l))).toEqual(["stack start t"]);
    expect(existsSync(join(loops, ".migrate/t"))).toBe(false);
    expect(json(extra).warnings.join("\n")).not.toMatch(/migrate was cut off/);
  });

  it("the migrate marker stands while a start runs, and stays only when it got to its migrate", () => {
    endDispatchers();
    rmSync(lock(), { force: true });
    rmSync(intent(), { force: true });
    put("running", "sample-loop1\n");
    put("testdb-up", "");
    put("listen", "6173\n");
    const marker = join(loops, ".migrate/t-2");
    rmSync(marker, { force: true });

    // A start that fails before its migrate (the stack's start, its database's wait) leaves none.
    expect(recover(["--no-agent"], { SAMPLE_STACK_FAIL: "start:t-2" }).status).toBe(1);
    expect(existsSync(marker)).toBe(false);

    // A start that gets there: the marker stood during the call, and goes once it passes.
    rmSync(log, { force: true });
    okRecover(["--no-agent"], { SAMPLE_STACK_MARK: marker });
    expect(calls()).toMatch(/^stack start t-2 \(record\)$/m);
    expect(existsSync(marker)).toBe(false);

    // A migrate that fails keeps it for the next run.
    put("running", "sample-loop1\n");
    expect(recover(["--no-agent"], { SAMPLE_STACK_FAIL: "migrate:t-2" }).status).toBe(1);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
  });

  it("--unattended with RISA_RECOVER_REPORT=off (the watchdog's later tries) files no report", () => {
    crashed();
    const r = recover(["--unattended"], { SAMPLE_STACK_FAIL: "start:t", RISA_RECOVER_REPORT: "off" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not reported again this incident/);
    expect(reports()).toEqual([]);
  });

  it("down --stay marks stay-down: --unattended then does nothing, and a recover by hand deletes the mark", () => {
    const stay = join(loops, ".stay-down.json");
    put("running", "");
    put("listen", "");
    endDispatchers();
    rmSync(lock(), { force: true });
    const d = spawnSync("bash", [join(main, "loops/prd.sh"), "down", "--stay", "profiling"], {
      cwd: main,
      encoding: "utf8",
      env,
    });
    expect(d.status).toBe(0);
    expect(d.stdout).toMatch(/Down, and staying down/);
    expect(JSON.parse(readFileSync(stay, "utf8"))).toEqual({ at: expect.any(String), why: "profiling" });
    rmSync(log);
    const r = recover(["--unattended"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/stay-down .*: nothing done/);
    expect(calls()).toBe("");
    expect(existsSync(stay)).toBe(true);
    const out = okRecover(["--no-agent"]);
    expect(out).toMatch(/deleted the stay-down mark/);
    expect(existsSync(stay)).toBe(false);
    rmSync(join(loops, ".down.json"), { force: true });
  });
});
