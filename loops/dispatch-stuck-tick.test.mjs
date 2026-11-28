// The stuck orchestrator's tick (B-408): dispatch.mjs on dispatch-fixture.mjs's
// throwaway repo, with a stub rotate.sh. Its decision is
// dispatch-stuck-decision.test.mjs's.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HELPER_SESSION } from "./dispatch.mjs";
import { STUCK_OPTIONS, STUCK_SESSION } from "./dispatch-stuck.mjs";
import {
  loops,
  sessions,
  asks,
  state,
  scripts,
  calls,
  openCalls,
  ok,
  dstate,
  setClock,
  T0,
  answer,
  askFile,
  until,
  useDispatchRepo,
} from "./dispatch-fixture.mjs";

useDispatchRepo();

const ROTATE_SH = `#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/rotate.calls"
[[ ! -e $STUB_STATE/refuse ]] || { echo "rotate: plan has uncommitted changes" >&2; exit 1; }
echo "rotating"
`;

describe("the stuck tick", () => {
  let procs = [];
  const heartbeats = () => join(loops, ".heartbeat");
  const iso = (secs) => new Date(secs * 1000).toISOString();
  /** A live, managed, run-through orchestrator on a real process. */
  const liveOrchestrator = (script = "while :; do sleep 1; done", extra = {}) => {
    const child = spawn("bash", ["-c", script], { detached: true, stdio: "ignore" });
    procs.push(child);
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "prd-x.json"),
      JSON.stringify({
        pid: child.pid,
        kind: "prd",
        topic: "x",
        managed: true,
        auto: true,
        started: new Date().toISOString(),
        ...extra,
      }),
    );
    return child.pid;
  };
  const beat = (pid, lastSecs, file = "session.json", extra = {}) => {
    mkdirSync(join(heartbeats(), "prd-x"), { recursive: true });
    writeFileSync(
      join(heartbeats(), "prd-x", file),
      JSON.stringify({
        session: "prd-x",
        pid,
        agent: file === "session.json" ? null : file.replace(/\.json$/, ""),
        lastStart: iso(lastSecs),
        lastEnd: iso(lastSecs),
        stoppedAt: null,
        running: {},
        ...extra,
      }),
    );
  };
  const stuckAsks = () =>
    readdirSync(asks)
      .map((f) => askFile(f.replace(/\.json$/, "")))
      .filter((a) => a.session === STUCK_SESSION);
  const tryAsks = () => (existsSync(asks) ? stuckAsks() : []);

  beforeAll(() => writeFileSync(scripts("rotate.sh"), ROTATE_SH));
  beforeEach(() => {
    for (const d of [heartbeats(), join(loops, ".watch")]) rmSync(d, { recursive: true, force: true });
  });
  afterEach(() => {
    for (const c of procs)
      try {
        process.kill(-c.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    procs = [];
  });

  it("files one waiting question under its own session, pushes it, and asks once per stall", () => {
    const pid = liveOrchestrator();
    beat(pid, T0 - 40 * 60);
    expect(ok()).toContain("stuck: prd-x asked (");
    const [a] = stuckAsks();
    expect(a).toMatchObject({ kind: "question", topic: "x", options: STUCK_OPTIONS, defaults: false });
    expect(a.text).toContain("prd-x looks stuck");
    expect(openCalls().filter((c) => c.includes(HELPER_SESSION))).toHaveLength(1);
    expect(dstate().stuck.sessions["prd-x"]).toMatchObject({ pid, askId: a.id });
    setClock(T0 + 60);
    ok();
    // Never defaults, however long it waits.
    setClock(T0 + 24 * 3600);
    writeFileSync(
      join(loops, ".dispatch.json"),
      JSON.stringify({ ...dstate(), stuck: { ...dstate().stuck, lastTickAt: (T0 + 24 * 3600 - 60) * 1000 } }),
    );
    ok();
    expect(stuckAsks()).toHaveLength(1);
    expect(askFile(a.id).answeredAt).toBeFalsy();
  });

  it('rotates mid-wave on "rotate it now"; a refusal files one report', () => {
    const pid = liveOrchestrator();
    beat(pid, T0 - 40 * 60);
    ok();
    writeFileSync(join(state, "refuse"), "");
    answer(stuckAsks()[0].id, STUCK_OPTIONS[0]);
    setClock(T0 + 60);
    expect(ok()).toContain("stuck: rotating prd-x was refused");
    setClock(T0 + 120);
    ok();
    expect(calls("rotate")).toEqual(["x --mid-wave --reason stuck"]);
    const reports = stuckAsks().filter((a) => a.kind === "report");
    expect(reports).toHaveLength(1);
    expect(reports[0].text).toContain("its rotation was refused");
    rmSync(join(state, "refuse"));
    setClock(T0 + 60 + 30 * 60);
    writeFileSync(
      join(loops, ".dispatch.json"),
      JSON.stringify({ ...dstate(), stuck: { ...dstate().stuck, lastTickAt: (T0 + 30 * 60) * 1000 } }),
    );
    expect(ok()).toContain("stuck: prd-x rotating");
    expect(calls("rotate")).toHaveLength(2);
    expect(stuckAsks().filter((a) => a.kind === "report")).toHaveLength(1);
  });

  it('"leave it" leaves that stall alone; a stall that ends clears it', () => {
    const pid = liveOrchestrator();
    beat(pid, T0 - 40 * 60);
    ok();
    answer(stuckAsks()[0].id, STUCK_OPTIONS[1]);
    setClock(T0 + 60);
    expect(ok()).toContain("means leave it for prd-x");
    setClock(T0 + 120);
    ok();
    expect(calls("rotate")).toEqual([]);
    expect(stuckAsks()).toHaveLength(1);
    beat(pid, T0 + 100);
    setClock(T0 + 180);
    expect(ok()).toContain("stuck: prd-x cleared");
    expect(dstate().stuck.sessions["prd-x"]).toBeUndefined();
  });

  it("asks about one whose only command under it is watch --wait; a pnpm prd command holds it", async () => {
    const waiting = liveOrchestrator(`bash -c "while :; do sleep 1; done # pnpm prd watch x --wait"; true`);
    beat(waiting, T0 - 40 * 60);
    await until(() => {
      try {
        return execFileSync("pgrep", ["-P", String(waiting)], { encoding: "utf8" }).trim() !== "";
      } catch {
        return false;
      }
    });
    expect(ok()).toContain("stuck: prd-x asked");
    for (const c of procs) process.kill(-c.pid, "SIGKILL");
    procs = [];
    rmSync(join(loops, ".dispatch.json"), { force: true });
    rmSync(asks, { recursive: true, force: true });
    const landing = liveOrchestrator(`bash -c "while :; do sleep 1; done # pnpm prd land x"; true`);
    beat(landing, T0 - 40 * 60);
    await until(() => {
      try {
        return execFileSync("pgrep", ["-P", String(landing)], { encoding: "utf8" }).trim() !== "";
      } catch {
        return false;
      }
    });
    expect(ok()).not.toContain("stuck:");
    expect(tryAsks()).toEqual([]);
  });

  it("asks about a hung slice agent's session and a watch action left unhandled, from their files", () => {
    const pid = liveOrchestrator();
    beat(pid, T0 - 40 * 60);
    beat(pid, T0 - 90 * 60, "a1.json", { running: { t1: { tool: "Bash", at: iso(T0 - 90 * 60) } } });
    expect(ok()).toContain("stuck: prd-x asked");
    rmSync(join(loops, ".dispatch.json"), { force: true });
    rmSync(asks, { recursive: true, force: true });
    beat(pid, T0 - 60);
    mkdirSync(join(loops, ".watch", "x"), { recursive: true });
    writeFileSync(
      join(loops, ".watch", "x", "state.json"),
      JSON.stringify({ actions: { 2: { action: "restart", since: iso(T0 - 35 * 60) } } }),
    );
    expect(ok()).toContain("stuck: prd-x asked");
    expect(stuckAsks()[0].text).toContain("slice 2's watch action (restart)");
  });

  it("leaves alone a recent agent, no heartbeat ever, a session opened by hand, and a paused dispatcher", () => {
    let pid = liveOrchestrator();
    beat(pid, T0 - 40 * 60);
    beat(pid, T0 - 5 * 60, "a1.json");
    expect(ok()).not.toContain("stuck:");
    rmSync(heartbeats(), { recursive: true, force: true });
    expect(ok()).not.toContain("stuck:");
    pid = liveOrchestrator(undefined, { managed: false });
    beat(pid, T0 - 40 * 60);
    expect(ok()).not.toContain("stuck:");
    pid = liveOrchestrator();
    beat(pid, T0 - 40 * 60);
    ok(["--pause", "t"]);
    setClock(T0 + 60);
    expect(ok()).not.toContain("stuck:");
    expect(tryAsks()).toEqual([]);
    // A paused tick writes nothing, its clocks neither.
    expect(dstate().stuck).toEqual({ lastTickAt: T0 * 1000, clockFrom: null });
    // But the tick's own heartbeat (risa status's last tick) still moves.
    expect(dstate().lastTickAt).toBe((T0 + 60) * 1000);
  });

  it("a tick gap resets the clocks: the stall counts again from the wake", () => {
    const pid = liveOrchestrator();
    beat(pid, T0 - 40 * 60);
    writeFileSync(
      join(loops, ".dispatch.json"),
      JSON.stringify({ stuck: { lastTickAt: (T0 - 3600) * 1000 } }),
    );
    expect(ok()).not.toContain("stuck:");
    expect(dstate().stuck.clockFrom).toBe(T0 * 1000);
    setClock(T0 + 29 * 60);
    for (let t = 60; t <= 29 * 60; t += 290) {
      setClock(T0 + t);
      expect(ok()).not.toContain("stuck:");
    }
    setClock(T0 + 30 * 60);
    expect(ok()).toContain("stuck: prd-x asked");
  });

  it("several going quiet together raise one report and no question", () => {
    const pid = liveOrchestrator();
    beat(pid, T0 - 40 * 60);
    const child = spawn("bash", ["-c", "while :; do sleep 1; done"], { detached: true, stdio: "ignore" });
    procs.push(child);
    writeFileSync(
      join(sessions, "prd-y.json"),
      JSON.stringify({
        pid: child.pid,
        kind: "prd",
        topic: "y",
        managed: true,
        auto: true,
        started: new Date().toISOString(),
      }),
    );
    mkdirSync(join(heartbeats(), "prd-y"), { recursive: true });
    writeFileSync(
      join(heartbeats(), "prd-y", "session.json"),
      JSON.stringify({
        session: "prd-y",
        pid: child.pid,
        agent: null,
        lastEnd: iso(T0 - 45 * 60),
        running: {},
      }),
    );
    expect(ok()).toContain("stuck: reported prd-x, prd-y quiet together");
    setClock(T0 + 60);
    ok();
    const all = stuckAsks();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: "report" });
    expect(all[0].text).toContain("prd-x, prd-y went quiet together");
  });
});
