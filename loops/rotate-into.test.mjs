// rotate-into.sh, the line the opener prints, against rotate-fixture.mjs's
// throwaway repo and stub claude.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BASE, scaledWait } from "./test-limits.mjs";
import {
  shown,
  git,
  plan,
  MERGED,
  root,
  sessions,
  state,
  stub,
  env,
  wt,
  scripts,
  record,
  stubPid,
  stateFile,
  run,
  start,
  until,
  liveSession,
  printedLine,
  useRotateRepo,
} from "./rotate-fixture.mjs";

// The limits follow the load as this file starts, not only as the run did (RISA-994).
vi.setConfig({ testTimeout: scaledWait(BASE.testTimeout), hookTimeout: scaledWait(BASE.hookTimeout) });
useRotateRepo();

describe("rotate-into.sh", () => {
  /** Runs the printed line as the tab would; the new session is the stub in exit mode. */
  const runLine = (line, extra = {}) =>
    spawnSync("bash", ["-c", line], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, STUB_MODE: "exit", STUB_NAME: "prd-w", ...extra },
    });

  it("marks rotating, ends the old session, and starts the fresh resume prompt under the same name", async () => {
    const { s, pid } = await liveSession();
    const line = printedLine(run("prd.sh", ["rotate", "w"]).stdout);
    const r = runLine(line);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      `Rotating prd-w: ending pid ${pid}, then a fresh session with the resume prompt.`,
    );
    expect((await s.done).code).toBe(143);
    // rotating was set before the kill, and the new session cleared it.
    expect(JSON.parse(stateFile("record-at-term"))).toMatchObject({ pid, rotating: true });
    const atStart = JSON.parse(stateFile("record-at-start"));
    expect(atStart.pid).not.toBe(pid);
    expect(atStart).not.toHaveProperty("rotating");
    expect(atStart).not.toHaveProperty("ended");
    expect(atStart).toMatchObject({ kind: "prd", topic: "w", auto: false });
    // Fresh, the same name, the resume prompt; not run-through.
    const [settingsFlag, settingsFile, ...args] = stateFile("args").split("\n");
    expect(settingsFlag).toBe("--settings");
    expect(settingsFile).toMatch(/context-settings\.json$/);
    expect(args.slice(0, 2)).toEqual(["--remote-control", shown("prd-w", "prd", "prd-w")]);
    const prompt = args.slice(2).join("\n");
    expect(prompt).toContain('You are the PRD orchestrator for "w".');
    expect(prompt).toContain("**You're taking over after an interruption**");
    expect(prompt).not.toContain("**Landing mode: run everything through.**");
    // The old wrapper's end landed before the new start, never on top of it.
    expect(record("prd-w")).toMatchObject({ pid: atStart.pid, exit: 0 });
    expect(record("prd-w")).not.toHaveProperty("rotating");
  });

  it("carries run-through over from the record, or from _Status_", async () => {
    const first = await liveSession({ auto: true });
    expect(runLine(printedLine(run("prd.sh", ["rotate", "w"]).stdout)).status).toBe(0);
    await first.s.done;
    expect(JSON.parse(stateFile("record-at-start")).auto).toBe(true);
    expect(stateFile("args")).toContain("**Landing mode: run everything through.**");

    rmSync(state, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
    const { s, pid } = await liveSession();
    const line = printedLine(run("prd.sh", ["rotate", "w"]).stdout);
    // _Status_ says run-through (an edit after rotate's own check, as a tab may see it).
    writeFileSync(join(wt, "plans/w-plan.md"), plan(MERGED, "run everything through"));
    try {
      const r = runLine(line);
      expect(r.stdout).toContain(`ending pid ${pid}`);
      expect(r.stdout).toContain("(run-through)");
      await s.done;
      expect(JSON.parse(stateFile("record-at-start")).auto).toBe(true);
      expect(stateFile("args")).toContain("**Landing mode: run everything through.**");
    } finally {
      git(wt, "checkout", "--", "plans/w-plan.md");
    }
  });

  it("carries managed over from the record, and leaves a by-hand session by hand", async () => {
    const first = await liveSession({ managed: true });
    expect(runLine(printedLine(run("prd.sh", ["rotate", "w"]).stdout)).status).toBe(0);
    await first.s.done;
    expect(JSON.parse(stateFile("record-at-start"))).toMatchObject({ managed: true, auto: false });
    expect(record("prd-w")).toMatchObject({ managed: true });

    rmSync(state, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
    const second = await liveSession();
    expect(runLine(printedLine(run("prd.sh", ["rotate", "w"]).stdout)).status).toBe(0);
    await second.s.done;
    expect(JSON.parse(stateFile("record-at-start")).managed).toBe(false);
  });

  it("carries the record's model over, and passes none when none was recorded", async () => {
    const first = await liveSession({ model: "fable" });
    expect(runLine(printedLine(run("prd.sh", ["rotate", "w"]).stdout)).status).toBe(0);
    await first.s.done;
    expect(JSON.parse(stateFile("record-at-start"))).toMatchObject({ model: "fable" });
    const args = stateFile("args").split("\n");
    expect(args.slice(2, 6)).toEqual([
      "--model",
      "fable",
      "--remote-control",
      shown("prd-w", "prd", "prd-w"),
    ]);
    expect(record("prd-w")).toMatchObject({ model: "fable" });

    rmSync(state, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
    const second = await liveSession();
    expect(runLine(printedLine(run("prd.sh", ["rotate", "w"]).stdout)).status).toBe(0);
    await second.s.done;
    expect(stateFile("args")).not.toContain("--model");
  });

  it("kills a session that ignores TERM after the wait, making a record when there was none", async () => {
    const s = start(stub, [], { STUB_MODE: "stubborn" }, wt);
    await until(() => existsSync(join(state, "ready")));
    const pid = stubPid();
    const r = runLine(`cd ${wt} && ${scripts("rotate-into.sh")} prd-w ${pid}`, { RISA_ROTATE_WAIT: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`pid ${pid} ignored TERM for 1s: killed it.`);
    expect((await s.done).signal).toBe("SIGKILL");
    expect(stubPid()).not.toBe(pid);
    expect(record("prd-w")).toMatchObject({ kind: "prd", topic: "w", pid: stubPid(), exit: 0 });
  });

  it("refuses a name that isn't an orchestrator's, or no pid", () => {
    expect(run("rotate-into.sh", ["plan-w", "123"]).stderr).toMatch(/usage: rotate-into\.sh prd-<topic>/);
    expect(run("rotate-into.sh", ["prd-w"]).status).toBe(1);
    expect(run("rotate-into.sh", ["prd-nope", "123"]).stderr).toMatch(/no worktree nope/);
  });
});
