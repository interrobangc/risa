// The dispatcher's drain and the resume after a limit: dispatch.mjs on
// dispatch-fixture.mjs's throwaway repo, with usage readings of its own.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequest } from "./session-requests.mjs";
import {
  root,
  loops,
  sessions,
  asks,
  state,
  calls,
  openCalls,
  ok,
  dstate,
  setRows,
  setClock,
  T0,
  deadRecord,
  worktree,
  askFile,
  until,
  useDispatchRepo,
} from "./dispatch-fixture.mjs";

useDispatchRepo();

describe("the drain", () => {
  let procs = [];
  const usageDir = () => join(loops, ".usage");
  const on = { RISA_USAGE_WATCH: "" };
  /** A current reading (by the fake clock) of the 5-hour window, from a session of its own. */
  const reading = (percent, resetSecs = T0 + 3600) => {
    mkdirSync(usageDir(), { recursive: true });
    writeFileSync(
      join(usageDir(), "reader.json"),
      JSON.stringify({
        session: "reader",
        windows: {
          fiveHour: {
            percent,
            at: new Date(T0 * 1000).toISOString(),
            resetsAt: new Date(resetSecs * 1000).toISOString(),
          },
        },
      }),
    );
  };
  const readingOf = (name) => JSON.parse(readFileSync(join(usageDir(), `${name}.json`), "utf8"));
  /** A live session on a real process (a bash loop standing in for claude). */
  const liveSession = (name, { managed = true, script = "while :; do sleep 0.2; done", ...extra } = {}) => {
    const child = spawn("bash", ["-c", script], { detached: true, stdio: "ignore" });
    procs.push(child);
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, `${name}.json`),
      JSON.stringify({ pid: child.pid, managed, started: new Date().toISOString(), ...extra }),
    );
    return child;
  };
  const gone = (child) => child.exitCode !== null || child.signalCode !== null;
  const drainAsks = () =>
    existsSync(asks)
      ? readdirSync(asks)
          .map((f) => askFile(f.replace(/\.json$/, "")))
          .filter((a) => a.session === "dispatch-usage")
      : [];

  beforeEach(() => {
    rmSync(usageDir(), { recursive: true, force: true });
    rmSync(join(loops, ".landing"), { recursive: true, force: true });
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

  it("draining: no start, plan or reopen, and --resume doesn't override it; RISA_USAGE_WATCH=off does", () => {
    reading(96);
    worktree("d", "prd/d");
    deadRecord("prd-d", { kind: "prd", topic: "d" });
    setRows([
      { topic: "a", state: "planned" },
      { topic: "p", state: "to-write", waiting: 2 },
      { topic: "d", state: "running" },
    ]);
    const out = ok(["--once"], on);
    expect(out).toMatch(/^\S+Z nothing: usage is draining: 5h 96%, at or over the drain line 95% \(until /);
    expect(out).toContain("  a: no start while usage is draining");
    expect(out).toContain("  p: no plan while usage is draining");
    expect(out).toContain("  d: its orchestrator died; not reopened while usage is draining");
    expect(out).toContain("usage: now draining: 5h 96%");
    ok(["--resume"]);
    expect(ok(["--once"], on)).toMatch(/^\S+Z nothing: usage is draining/);
    expect(calls("new")).toEqual([]);
    expect(openCalls()).toEqual([]);
    expect(dstate().drain).toMatchObject({ state: "draining" });
    // Off: the reopen goes ahead.
    expect(ok(["--once"])).toMatch(/^\S+Z reopen prd-d/);
  });

  it("--allow: the allowed topic starts while draining, shown in --dry-run and the drain's log line (RISA-813)", () => {
    reading(96);
    setRows([
      { topic: "a", state: "planned" },
      { topic: "b", state: "planned" },
    ]);
    try {
      expect(ok(["--once"], on)).toMatch(/^\S+Z nothing: usage is draining/);
      expect(ok(["--allow", "b"])).toContain("drain allowance: b");
      const dry = ok(["--dry-run"], on);
      expect(dry).toMatch(/^start b:/m);
      expect(dry).toContain("a: no start while usage is draining");
      expect(dry).toContain(
        "usage: allowance: b (pnpm prd dispatch --allow) starts, plans, reopens and resumes",
      );
      const out = ok(["--once"], on);
      expect(out).toMatch(/^\S+Z start b/);
      expect(out).toContain("usage: now draining: 5h 96%");
      expect(out).toContain("b is allowed past it");
      expect(dstate().drain).toMatchObject({ state: "draining", allow: "b" });
      expect(ok(["--allow", "none"])).toContain("drain allowance: none (was b)");
      expect(ok(["--dry-run"], on)).not.toContain("usage: allowance");
    } finally {
      rmSync(join(loops, ".drain-allow"), { force: true });
    }
  });

  it("draining ends nothing, and a session in a landing is never stopped", () => {
    reading(96);
    const s = liveSession("prd-x", { kind: "prd", topic: "x" });
    const l = liveSession("prd-y", {
      kind: "prd",
      topic: "y",
      script: "exec -a land.sh bash -c 'while :; do sleep 0.2; done'",
    });
    ok(["--once"], on);
    expect(gone(s) || gone(l)).toBe(false);
    expect(existsSync(join(usageDir(), "prd-x.json"))).toBe(false);
  });

  it("limited: ends each managed prd session (marked stalled), one in a landing only after it finishes; reports the hand-opened and backlog ones once", async () => {
    reading(99);
    const x = liveSession("prd-x", { kind: "prd", topic: "x" });
    const kept = liveSession("backlog", { kind: "backlog" });
    // The landing: a land.sh under the session (as `pnpm prd land` runs it), until a file says stop.
    const stop = join(root, "landing-done");
    rmSync(stop, { force: true });
    writeFileSync(join(root, "land.sh"), `while [[ ! -e ${stop} ]]; do sleep 0.2; done\n`);
    const y = liveSession("prd-y", {
      kind: "prd",
      topic: "y",
      script: `bash ${join(root, "land.sh")}; while :; do sleep 0.2; done`,
    });
    const hand = liveSession("hotfix-h", { managed: false, kind: "hotfix" });
    const landing = () =>
      execFileSync("ps", ["-A", "-o", "args="], { encoding: "utf8" })
        .split("\n")
        .some((l) => l.trim() === `bash ${join(root, "land.sh")}`);
    await until(landing);

    const first = ok(["--once"], on);
    expect(first).toMatch(/^\S+Z nothing: usage is limited: 5h 99%, at or over the stop line 98%/);
    expect(first).toMatch(new RegExp(`usage limited: ended prd-x \\(pid ${x.pid}, TERM; marked stalled\\)`));
    expect(first).not.toContain("usage limited: ended backlog");
    expect(first).toContain(
      "usage limited: prd-y left running (it runs a landing: ended once that finishes)",
    );
    expect(first).toContain(
      "usage limited: reported backlog, hotfix-h (opened by hand, or backlog or inbox: never ended)",
    );
    await until(() => gone(x));
    expect(gone(kept)).toBe(false);
    expect(
      existsSync(join(usageDir(), "backlog.json")) ? readingOf("backlog").stalled : undefined,
    ).toBeUndefined();
    expect(readingOf("prd-x").stalled).toMatchObject({
      error: "limited",
      pid: x.pid,
      resetsAt: new Date((T0 + 3600) * 1000).toISOString(),
    });
    expect(gone(y) || gone(hand)).toBe(false);
    const [report] = drainAsks();
    expect(report).toMatchObject({ kind: "report" });
    expect(report.text).toContain(
      "never ends one opened by hand, or a backlog or inbox session: backlog, hotfix-h are still live",
    );

    // The next tick: the landing still runs, and the report isn't filed again.
    setClock(T0 + 60);
    expect(ok(["--once"], on)).toContain("prd-y left running");
    expect(drainAsks()).toHaveLength(1);
    expect(gone(y)).toBe(false);

    // Its landing over, the session is ended; the hand-opened one never is.
    writeFileSync(stop, "");
    await until(() => !landing());
    setClock(T0 + 120);
    expect(ok(["--once"], on)).toMatch(new RegExp(`usage limited: ended prd-y \\(pid ${y.pid}`));
    await until(() => gone(y));
    expect(gone(hand) || gone(kept)).toBe(false);
    expect(drainAsks()).toHaveLength(1);
  });

  it("limited on overage, and a session that ignores TERM is killed a tick later", async () => {
    reading(100);
    const x = liveSession("prd-x", {
      kind: "prd",
      topic: "x",
      script: "trap '' TERM; while :; do sleep 0.2; done",
    });
    expect(ok(["--once"], on)).toMatch(/usage limited: ended prd-x/);
    setClock(T0 + 1);
    expect(ok(["--once"], on)).toContain("prd-x left running (sent TERM; waiting for it to end)");
    expect(gone(x)).toBe(false);
    setClock(T0 + 60);
    expect(ok(["--once"], on)).toContain(`usage limited: prd-x ignored TERM: killed it (pid ${x.pid})`);
    await until(() => gone(x));
  });

  it("nothing opens a claude while limited: no reopen ask's helper, keep-alive, session request or probe", () => {
    reading(99);
    const claudeCalls = join(state, "claude.calls");
    const claude = join(root, "claude-recording");
    writeFileSync(claude, `#!/usr/bin/env bash\necho "$*" >> ${claudeCalls}\n`);
    chmodSync(claude, 0o755);
    worktree("d", "prd/d");
    deadRecord("prd-d", { kind: "prd", topic: "d" });
    setRows([{ topic: "d", state: "running" }]);
    createRequest(join(loops, ".requests"), { name: "notes", now: T0 * 1000 });
    const extra = { ...on, RISA_CLAUDE_BIN: claude, RISA_KEEP_SESSIONS: "" };
    // Past the reopen limit: a normal tick would file an ask and open its helper.
    writeFileSync(join(loops, ".dispatch.json"), JSON.stringify({ reopens: { "prd-d": 2 } }));
    for (let t = 0; t < 3; t++) {
      setClock(T0 + 60 * t);
      ok(["--once"], extra);
    }
    expect(openCalls()).toEqual([]);
    expect(existsSync(claudeCalls)).toBe(false);
  });

  it("an unknown reading doesn't drain, and files one report while sessions are live", () => {
    liveSession("prd-x", { kind: "prd", topic: "x" });
    setRows([{ topic: "a", state: "planned" }]);
    const out = ok(["--once"], on);
    expect(out).toMatch(/^\S+Z start a:/);
    expect(out).toContain("usage: reported an unknown reading");
    setClock(T0 + 60);
    expect(ok(["--once"], on)).not.toContain("reported an unknown reading");
    const reports = drainAsks();
    expect(reports).toHaveLength(1);
    expect(reports[0].text).toContain("The usage reading is unknown");
  });

  describe("the resume after a limit", () => {
    /** A stall whose reset passed a minute ago (by the fake clock). */
    const stalled = (name, extra = {}) => {
      mkdirSync(usageDir(), { recursive: true });
      writeFileSync(
        join(usageDir(), `${name}.json`),
        JSON.stringify({
          session: name,
          windows: {},
          stalled: {
            at: new Date((T0 - 7200) * 1000).toISOString(),
            error: "limited",
            resetsAt: new Date((T0 - 60) * 1000).toISOString(),
            pid: 999_999,
            ...extra,
          },
        }),
      );
    };
    const claimed = () => dstate().resume?.claimed ?? {};
    const hasChild = (child) => {
      try {
        return execFileSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" }).trim() !== "";
      } catch {
        return false;
      }
    };

    it("reopens a stalled managed session with --continue and the carry-on prompt, one per tick, never counted", () => {
      reading(10);
      worktree("a", "prd/a");
      worktree("b", "prd/b");
      deadRecord("prd-a", { kind: "prd", topic: "a" });
      deadRecord("prd-b", { kind: "prd", topic: "b" });
      stalled("prd-a");
      stalled("prd-b");
      setRows([
        { topic: "a", state: "running" },
        { topic: "b", state: "running" },
        { topic: "n", state: "planned" },
      ]);
      // At the reopen limit: an ordinary reopen would be an ask.
      writeFileSync(join(loops, ".dispatch.json"), JSON.stringify({ reopens: { "prd-a": 2 } }));
      const first = ok(["--once"], on);
      expect(first).toMatch(
        /^\S+Z resume prd-a: stopped on a usage limit that has reset: --continue with the carry-on prompt \(not counted toward the reopen limit\)/,
      );
      expect(first).toContain("  n: waits a tick: the resume of prd-a goes first");
      expect(first).toContain(
        "  b: its orchestrator stopped on a usage limit: the resume brings it back (not counted)",
      );
      expect(first).toContain("resume: claimed prd-a (stalled on a limit, limited; its reset has passed)");
      expect(first).toContain("resume: prd-b waits (one resume a tick: prd-a first)");
      expect(openCalls()).toEqual([["a", "--background", "--carry-on"]]);
      expect(calls("new")).toEqual([]);
      expect(dstate().reopens).toEqual({ "prd-a": 2 });
      expect(Object.keys(claimed())).toEqual(["prd-b"]);
      expect(readingOf("prd-a").stalled).toBeUndefined();
      expect(readingOf("prd-b").stalled).toBeUndefined();
      expect(drainAsks()).toEqual([]);

      // The next tick: prd-a is up; prd-b's turn, still uncounted.
      liveSession("prd-a", { kind: "prd", topic: "a" });
      setClock(T0 + 60);
      expect(ok(["--once"], on)).toMatch(/^\S+Z resume prd-b:/);
      expect(openCalls()).toEqual([
        ["a", "--background", "--carry-on"],
        ["b", "--background", "--carry-on"],
      ]);
      expect(claimed()).toEqual({});
      // prd-b's resume added no count (prd-a's went with its recovery: live for REOPEN_RESET_MS).
      expect(dstate().reopens?.["prd-b"]).toBeUndefined();

      // Nothing left: the pick goes on as usual.
      liveSession("prd-b", { kind: "prd", topic: "b" });
      setClock(T0 + 120);
      expect(ok(["--once"], on)).toMatch(/^\S+Z start n:/);
    });

    it("waits until the reset, and a tab that never opens keeps the claim", () => {
      reading(10);
      worktree("a", "prd/a");
      deadRecord("prd-a", { kind: "prd", topic: "a" });
      setRows([{ topic: "a", state: "running" }]);
      stalled("prd-a", { resetsAt: new Date((T0 + 600) * 1000).toISOString() });
      const before = ok(["--once"], on);
      expect(before).toMatch(/^\S+Z nothing: usage is limited: stopped on a limit: prd-a/);
      expect(openCalls()).toEqual([]);
      setClock(T0 + 660);
      const failed = ok(["--once"], { ...on, STUB_OPEN_FAIL: "--carry-on" });
      expect(failed).toMatch(/^\S+Z resume prd-a:/);
      expect(failed).toMatch(/prd-a: its tab never opened .*a later tick retries/);
      expect(Object.keys(claimed())).toEqual(["prd-a"]);
      setClock(T0 + 720);
      expect(ok(["--once"], on)).toMatch(/^\S+Z resume prd-a:/);
      expect(openCalls()).toHaveLength(2);
      expect(dstate().reopens ?? {}).toEqual({});
    });

    it("leaves alone a session in a pnpm prd command or with a landing marker; ends a live one, then resumes it", async () => {
      reading(10);
      for (const t of ["a", "b", "c"]) worktree(t, `prd/${t}`);
      setRows(["a", "b", "c"].map((topic) => ({ topic, state: "running" })));
      const busy = liveSession("prd-a", {
        kind: "prd",
        topic: "a",
        script: `bash -c "while :; do sleep 0.2; done # pnpm prd check x"; true`,
      });
      await until(() => hasChild(busy));
      deadRecord("prd-b", { kind: "prd", topic: "b" });
      mkdirSync(join(loops, ".landing"), { recursive: true });
      writeFileSync(
        join(loops, ".landing", "prd-b.json"),
        JSON.stringify({ branch: "prd/b", path: "pr", step: "dev-sync", tip: "abc", pid: 999_999 }),
      );
      const idle = liveSession("prd-c", { kind: "prd", topic: "c" });
      for (const n of ["prd-a", "prd-b", "prd-c"]) stalled(n, { pid: null });

      const first = ok(["--once"], on);
      expect(first).toContain("resume: prd-a waits (it runs a pnpm prd command)");
      expect(first).toContain("resume: prd-b waits (it has a landing marker: a landing first)");
      expect(first).toMatch(
        new RegExp(`resume: ended prd-c \\(pid ${idle.pid}, TERM\\): resumed once it has ended`),
      );
      expect(openCalls()).toEqual([]);
      await until(() => gone(idle));
      expect(gone(busy)).toBe(false);

      setClock(T0 + 60);
      const second = ok(["--once"], on);
      expect(second).toMatch(/^\S+Z resume prd-c:/);
      expect(second).toContain("resume: prd-a waits (it runs a pnpm prd command)");
      expect(second).toContain("resume: prd-b waits (it has a landing marker: a landing first)");
      expect(openCalls()).toEqual([["c", "--background", "--carry-on"]]);
      expect(gone(busy)).toBe(false);
      expect(Object.keys(claimed()).sort()).toEqual(["prd-a", "prd-b"]);
    });

    it("a hand-opened session is only reported, once", () => {
      reading(10);
      worktree("h", "prd/h");
      setRows([{ topic: "h", state: "running" }]);
      const hand = liveSession("prd-h", { managed: false, kind: "prd", topic: "h" });
      stalled("prd-h", { error: "rate_limit", pid: hand.pid });
      const out = ok(["--once"], on);
      expect(out).toContain("resume: reported prd-h (opened by hand, never resumed)");
      setClock(T0 + 60);
      expect(ok(["--once"], on)).not.toContain("resume:");
      expect(openCalls()).toEqual([]);
      expect(gone(hand)).toBe(false);
      const reports = drainAsks();
      expect(reports).toHaveLength(1);
      expect(reports[0].text).toMatch(
        /^prd-h stopped on a usage limit that has now reset\. .*never one opened by hand/,
      );
      expect(claimed()).toEqual({});
    });

    it("a dead session whose stall's reset is ahead is held with the watch on; RISA_USAGE_WATCH=off reopens it", () => {
      reading(10);
      worktree("a", "prd/a");
      deadRecord("prd-a", { kind: "prd", topic: "a" });
      setRows([{ topic: "a", state: "running" }]);
      stalled("prd-a", { resetsAt: new Date((T0 + 600) * 1000).toISOString() });
      expect(ok(["--once"], on)).not.toMatch(/^\S+Z reopen prd-a/);
      expect(openCalls()).toEqual([]);
      setClock(T0 + 60);
      expect(ok(["--once"])).toMatch(/^\S+Z reopen prd-a/);
      expect(openCalls()).toHaveLength(1);
    });

    it("--dry-run claims, clears and opens nothing", () => {
      reading(10);
      worktree("a", "prd/a");
      deadRecord("prd-a", { kind: "prd", topic: "a" });
      setRows([{ topic: "a", state: "running" }]);
      stalled("prd-a");
      const out = ok(["--dry-run"], on);
      expect(out).toMatch(/^resume prd-a:/);
      expect(out).toContain("resume: would claim prd-a");
      expect(openCalls()).toEqual([]);
      expect(readingOf("prd-a").stalled).toBeTruthy();
      expect(existsSync(join(loops, ".dispatch.json"))).toBe(false);
    });
  });
});
