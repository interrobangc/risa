// Session records (sessions.mjs), the wrapper that writes them (session.sh) and
// `pnpm prd end` (end-session.sh), against a throwaway repo with these scripts
// copied in and a stub claude (RISA_CLAUDE_BIN). The stub is named
// claude-stub, never claude, so no walk up from a test can find the real
// claude session the tests may be running under.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CAPTAINS } from "./captain.mjs";
import {
  ancestorClaude,
  endTarget,
  isLive,
  liveDirRefusal,
  parseEtime,
  parseFields,
  readRecord,
  readRecords,
  runs,
  START_SLACK_MS,
  wrappedAs,
  wrapperName,
  writeRecord,
} from "./sessions.mjs";
import "./config-fixture.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();

describe("the pure part", () => {
  it("parses ps's elapsed times", () => {
    expect(parseEtime("00:07")).toBe(7);
    expect(parseEtime("  12:34")).toBe(754);
    expect(parseEtime("01:00:00")).toBe(3600);
    expect(parseEtime("2-03:04:05")).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5);
    expect(parseEtime("soon")).toBeNull();
  });

  it("calls a record live only while it hasn't ended and its pid is the process it started", () => {
    const now = Date.parse("2026-11-21T12:00:00Z");
    const record = { pid: 42, started: "2026-11-21T11:00:00Z" };
    const startedAt = (iso) => ({ startedMs: Date.parse(iso) });
    expect(isLive(record, startedAt("2026-11-21T11:00:01Z"), now)).toBe(true);
    // Ended: the record says so, whatever holds the pid now.
    expect(isLive({ ...record, ended: "2026-11-21T11:30:00Z" }, startedAt("2026-11-21T11:00:01Z"), now)).toBe(
      false,
    );
    // No such process.
    expect(isLive(record, null, now)).toBe(false);
    // The pid reused by a process that started later (or earlier).
    expect(isLive(record, { startedMs: Date.parse(record.started) + START_SLACK_MS + 1000 }, now)).toBe(
      false,
    );
    expect(isLive(record, startedAt("2026-11-20T11:00:00Z"), now)).toBe(false);
    expect(isLive({ started: record.started }, startedAt(record.started), now)).toBe(false);
  });

  it("finds the nearest ancestor running claude, as a command or an interpreter's script", () => {
    expect(runs("/Users/x/.local/bin/claude --remote-control prd-t", "claude")).toBe(true);
    expect(runs("bash /tmp/bin/claude-stub --remote-control prd-t", "claude-stub")).toBe(true);
    expect(runs("node /x/vitest.mjs claude", "claude")).toBe(false);
    const table = new Map([
      [100, { ppid: 1, args: "/sbin/launchd-ish" }],
      [200, { ppid: 100, args: "/usr/local/bin/claude --continue" }],
      [300, { ppid: 200, args: "/bin/zsh -c pnpm prd end" }],
      [400, { ppid: 300, args: "bash loops/end-session.sh" }],
      [500, { ppid: 400, args: "node sessions.mjs self" }],
    ]);
    expect(ancestorClaude(500, table, "claude")).toBe(200);
    // The starting process itself isn't a candidate; nothing above 200 runs claude.
    expect(ancestorClaude(200, table, "claude")).toBeNull();
    expect(ancestorClaude(500, table, "claude-stub")).toBeNull();
    // A loop in the table ends the walk.
    expect(
      ancestorClaude(
        2,
        new Map([
          [2, { ppid: 3, args: "a" }],
          [3, { ppid: 2, args: "b" }],
        ]),
        "c",
      ),
    ).toBeNull();
  });

  it("merges fields into a record and removes empty ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-unit-"));
    try {
      expect(
        parseFields(["pid=12", "auto=true", "managed=true", "rotating=", "topic=t", "command=a=b c"]),
      ).toEqual({
        pid: 12,
        auto: true,
        managed: true,
        rotating: undefined,
        topic: "t",
        command: "a=b c",
      });
      writeRecord(dir, "prd-t", { pid: 1, rotating: true, auto: false });
      writeRecord(dir, "prd-t", { pid: 2, rotating: undefined });
      expect(readRecord(dir, "prd-t")).toEqual({ pid: 2, auto: false });
      expect(readRecords(dir).map((r) => r.name)).toEqual(["prd-t"]);
      expect(readRecord(dir, "plan-none")).toBeNull();
      expect(() => readRecord(dir, "../x")).toThrow(/not a session name/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ends a record only while its pid is the ender's (--if-pid)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-unit-"));
    try {
      writeRecord(dir, "prd-t", { pid: 20, started: "2026-11-21T12:00:00Z" });
      // A stale pid (the first session's wrapper, after a second took the name) leaves it live.
      expect(writeRecord(dir, "prd-t", { ended: "2026-11-21T12:05:00Z", exit: 0 }, { ifPid: 10 })).toBeNull();
      expect(readRecord(dir, "prd-t")).toEqual({ pid: 20, started: "2026-11-21T12:00:00Z" });
      // No record at all: nothing to end.
      expect(writeRecord(dir, "prd-none", { ended: "x" }, { ifPid: 10 })).toBeNull();
      expect(readRecord(dir, "prd-none")).toBeNull();
      // The matching pid ends it.
      expect(writeRecord(dir, "prd-t", { ended: "2026-11-21T12:05:00Z", exit: 0 }, { ifPid: 20 })).toEqual({
        pid: 20,
        started: "2026-11-21T12:00:00Z",
        ended: "2026-11-21T12:05:00Z",
        exit: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("set --if-pid exits 3 and leaves the record on a stale pid, and writes on the matching one", () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-unit-"));
    const node = (...a) =>
      spawnSync("node", [join(HERE, "sessions.mjs"), "set", ...a], {
        encoding: "utf8",
        env: { ...process.env, RISA_SESSIONS_DIR: dir },
      });
    try {
      writeRecord(dir, "prd-t", { pid: 20 });
      const stale = node("prd-t", "--if-pid", "10", "ended=now", "exit=0");
      expect(stale.status).toBe(3);
      expect(stale.stderr).toMatch(/pid 20, not 10/);
      expect(readRecord(dir, "prd-t")).toEqual({ pid: 20 });
      expect(node("prd-t", "--if-pid", "20", "ended=now", "exit=0").status).toBe(0);
      expect(readRecord(dir, "prd-t")).toEqual({ pid: 20, ended: "now", exit: 0 });
      expect(node("prd-t", "--if-pid", "x", "ended=now").status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // B-871: a test that inherits the session's records' folder (the real one)
  // fails instead of writing into it.
  it("refuses a write to the real checkout's .loops/.sessions under Vitest, and allows a temp one", () => {
    const main = execFileSync("git", ["-C", HERE, "worktree", "list", "--porcelain"], { encoding: "utf8" })
      .split("\n")[0]
      .replace(/^worktree /, "");
    // A checkout that is itself in the temp dir (the standalone run's copy) stands
    // in for one outside it: the guard goes by the path, and refuses before writing.
    const inTmp = main.startsWith(realpathSync(tmpdir()));
    const real = join(inTmp ? "/risa-not-tmp/checkout" : main, ".loops", ".sessions");
    const probe = "b871-guard-probe";
    expect(liveDirRefusal(real)).toMatch(
      /refusing to write session records into .*\.loops\/\.sessions under Vitest/,
    );
    expect(() => writeRecord(real, probe, { pid: 1 })).toThrow(/a records' folder in a temp dir/);
    expect(existsSync(join(real, `${probe}.json`))).toBe(false);
    // Outside Vitest, any folder; under it, a temp dir's .loops/.sessions, or one not named so.
    expect(liveDirRefusal(real, {})).toBeNull();
    const tmp = mkdtempSync(join(tmpdir(), "sessions-guard-"));
    try {
      const temp = join(tmp, "repo", ".loops", ".sessions");
      expect(liveDirRefusal(temp)).toBeNull();
      expect(writeRecord(temp, probe, { pid: 1 })).toEqual({ pid: 1 });
      expect(liveDirRefusal("/nowhere/repo/.loops/.sessions", { VITEST: "true" }, tmp)).toMatch(/refusing/);
      expect(liveDirRefusal("/nowhere/repo/records", { VITEST: "true" }, tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("which process pnpm prd end ends (B-810)", () => {
  // 10: launchd-ish; 20: session.sh prd-t; 21: its claude; 22: a shell in it; 23: a claude under that shell;
  // 30: session.sh prd-t (a reopen); 31: its claude; 40: a stray claude; 50: sleep.
  const table = new Map([
    [10, { ppid: 1, args: "launchd" }],
    [20, { ppid: 10, args: "bash /r/loops/session.sh prd-t -- x" }],
    [21, { ppid: 20, args: "claude-stub --remote-control prd-t" }],
    [22, { ppid: 21, args: "bash -c pnpm prd end prd-t" }],
    [23, { ppid: 22, args: "bash /bin/claude-stub" }],
    [30, { ppid: 10, args: "/r/loops/session.sh prd-t -- x" }],
    [31, { ppid: 30, args: "claude-stub" }],
    [40, { ppid: 10, args: "claude-stub" }],
    [50, { ppid: 10, args: "sleep 30" }],
  ]);
  const cwds = { 21: "/w", 23: "/w", 31: "/w", 40: "/elsewhere" };
  const facts = (/** @type {number[]} */ drop = [], live = true, cwd = cwds) => ({
    live,
    table: new Map([...table].filter(([p]) => !drop.includes(p))),
    claude: "claude-stub",
    cwdOf: (/** @type {number} */ p) => /** @type {Record<number, string>} */ (cwd)[p] ?? null,
  });
  const rec = (pid) => ({ pid, dir: "/w", started: "2026-11-26T00:00:00Z" });

  it("reads session.sh's name from its command line, as the command or bash's script", () => {
    expect(wrapperName("bash /r/loops/session.sh prd-t -- x")).toBe("prd-t");
    expect(wrapperName("/r/loops/session.sh plan-v")).toBe("plan-v");
    expect(wrapperName("claude-stub session.sh prd-t")).toBeNull();
    expect(wrappedAs(21, table, "claude-stub")).toBe("prd-t");
    // A claude inside a session's shell isn't that session's claude.
    expect(wrappedAs(23, table, "claude-stub")).toBeNull();
    expect(wrappedAs(40, table, "claude-stub")).toBeNull();
  });

  it("ends the record's pid when it is the session's claude", () => {
    expect(endTarget("prd-t", rec(21), facts([30, 31]))).toEqual({ pid: 21, how: "record" });
    // Its wrapper gone, it is still the session's by its directory.
    const orphan = facts([30, 31]);
    orphan.table.set(21, { ppid: 1, args: "claude-stub" });
    expect(endTarget("prd-t", rec(21), orphan)).toEqual({ pid: 21, how: "record" });
  });

  it("refuses a stale pid that isn't the session's claude, and kills nothing", () => {
    expect(endTarget("prd-t", rec(50), facts([20, 21, 30, 31]))).toMatchObject({
      refuse: expect.stringMatching(/pid 50 in prd-t's record isn't its claude \(it runs sleep 30\)/),
    });
    expect(endTarget("prd-t", rec(40), facts([20, 21, 30, 31]))).toMatchObject({
      refuse: expect.stringMatching(
        /a claude neither under session.sh prd-t, nor in \/w, nor this shell's own/,
      ),
    });
    // The caller's own claude (a session ending itself) is its own, record dir or not.
    expect(endTarget("prd-t", { pid: 40 }, { ...facts([20, 21, 30, 31]), caller: 40 })).toEqual({
      pid: 40,
      how: "record",
    });
    expect(endTarget("prd-t", rec(99_999_999), facts([20, 21, 30, 31]))).toMatchObject({
      refuse: expect.stringMatching(/no such process/),
    });
  });

  it("ends the reopened session when the record still names an older pid", () => {
    expect(endTarget("prd-t", rec(50), facts([20, 21]))).toEqual({ pid: 31, how: "reopened" });
    expect(endTarget("prd-t", rec(40), facts([20, 21]))).toEqual({ pid: 31, how: "reopened" });
    // Not live by its record (a dead or reused pid): the live reopen still ends.
    expect(endTarget("prd-t", rec(46), facts([20, 21], false))).toEqual({ pid: 31, how: "reopened" });
    // One in another directory (another checkout's prd-t) isn't this record's.
    expect(endTarget("prd-t", rec(50), facts([20, 21], true, { ...cwds, 31: "/other" }))).toMatchObject({
      refuse: expect.any(String),
    });
  });

  it("refuses two live sessions under one name, and says ended when none is", () => {
    expect(endTarget("prd-t", rec(21), facts())).toMatchObject({
      refuse: expect.stringMatching(/more than one live claude \(pids 21, 31\)/),
    });
    expect(endTarget("prd-t", rec(21), facts([20, 21, 30, 31], false))).toEqual({ ended: true });
  });
});

// The stub: records its pid, args and the record it sees, then behaves as
// STUB_MODE says.
const STUB = `#!/usr/bin/env bash
mkdir -p "$STUB_STATE"
echo "$$" > "$STUB_STATE/pid"
printf '%s\\n' "$@" > "$STUB_STATE/args"
pwd -P > "$STUB_STATE/cwd"
echo "\${RISA_SESSION_NAME:-} \${RISA_CONTEXT_HOOK:-}" > "$STUB_STATE/hook"
[[ -z \${STUB_NAME:-} ]] || cat "$RISA_SESSIONS_DIR/$STUB_NAME.json" > "$STUB_STATE/record-at-start" 2>/dev/null || true
case \${STUB_MODE:-exit} in
  exit) exit "\${STUB_EXIT:-0}" ;;
  ancestor) bash -c 'node "$SESSIONS_MJS" ancestor; echo "exit $?"' > "$STUB_STATE/ancestor" ;;
  end) bash "$PRD_SH" end > "$STUB_STATE/end.out" 2>&1; sleep 5 ;;
  wait) touch "$STUB_STATE/ready"; for i in $(seq 100); do sleep 0.1; done ;;
  stubborn) trap '' TERM; touch "$STUB_STATE/ready"; for i in $(seq 100); do sleep 0.1; done ;;
esac
`;

let root, main, loops, sessions, state, stub, env;
const scripts = (f) => join(main, "loops", f);
const record = (name) => JSON.parse(readFileSync(join(sessions, `${name}.json`), "utf8"));
const stubPid = () => Number(readFileSync(join(state, "pid"), "utf8").trim());
const run = (script, args, extra = {}, cwd = main) =>
  spawnSync("bash", [scripts(script), ...args], { cwd, encoding: "utf8", env: { ...env, ...extra } });

/** Starts a command in the background; resolves {code, signal, stdout, stderr} when it exits. */
function start(cmd, args, extra = {}, cwd = main) {
  const child = spawn(cmd, args, { cwd, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const done = new Promise((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })),
  );
  return { child, done };
}
const until = async (what, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sessions-test-")));
  main = join(root, "repo");
  loops = join(main, ".loops");
  sessions = join(loops, ".sessions");
  state = join(root, "state");
  const bin = join(root, "bin");
  mkdirSync(bin);
  stub = join(bin, "claude-stub");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  execFileSync("git", ["init", "-q", "-b", "dev", main]);
  for (const [k, v] of [
    ["user.email", "test@example.com"],
    ["user.name", "Test"],
    ["commit.gpgsign", "false"],
  ])
    git(main, "config", k, v);
  mkdirSync(join(main, "loops"), { recursive: true });
  for (const f of [
    "prd.sh",
    "lib.sh",
    "config.mjs",
    "session.sh",
    "sessions.mjs",
    "host.mjs",
    "captain.mjs",
    "end-session.sh",
    "prompt.sh",
    "planner-model.mjs",
    "inbox-settings.json",
  ])
    copyFileSync(join(HERE, f), scripts(f));
  cpSync(join(HERE, "prompts"), scripts("prompts"), { recursive: true });
  mkdirSync(join(main, "backlog"));
  for (const f of ["registry.mjs", "format.mjs"])
    copyFileSync(join(HERE, "../backlog", f), join(main, "backlog", f));
  writeFileSync(join(main, ".gitignore"), ".loops/\n");
  mkdirSync(join(main, "plans"));
  writeFileSync(join(main, "plans/w-plan.md"), "# Plan: W\n\n## Status\n\nNot started.\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "chore: init");
  git(main, "worktree", "add", "-q", "-b", "prd/w", join(loops, "w"), "dev");
  git(main, "worktree", "add", "-q", "-b", "plan/v", join(loops, "plan-v"), "dev");
  env = {
    ...process.env,
    TRUNK: "dev",
    RISA_CLAUDE_BIN: stub,
    RISA_SESSIONS_DIR: "",
    RISA_END_WAIT: "",
    STUB_STATE: state,
    SESSIONS_MJS: scripts("sessions.mjs"),
    PRD_SH: scripts("prd.sh"),
  };
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(state, { recursive: true, force: true });
  rmSync(sessions, { recursive: true, force: true });
});

describe("session.sh", () => {
  it("records the session at start and after it exits, passing its exit code on", () => {
    // A rotation's leftovers in the record are cleared at start.
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "prd-t.json"),
      JSON.stringify({ pid: 1, rotating: true, ended: "2026-11-20T00:00:00Z", exit: 0 }),
    );
    const r = run("session.sh", ["prd-t", "--auto", "--", "--remote-control", "prd-t", "a prompt"], {
      STUB_NAME: "prd-t",
      STUB_EXIT: "3",
    });
    expect(r.status).toBe(3);
    const atStart = JSON.parse(readFileSync(join(state, "record-at-start"), "utf8"));
    expect(atStart).toMatchObject({ pid: stubPid(), kind: "prd", topic: "t", auto: true });
    expect(atStart.started).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(atStart.command).toBe(`${stub} --remote-control prd-t a\\ prompt`);
    expect(atStart).not.toHaveProperty("rotating");
    expect(atStart).not.toHaveProperty("ended");
    expect(readFileSync(join(state, "args"), "utf8")).toBe(
      `--settings\n${scripts("context-settings.json")}\n--remote-control\nprd-t\na prompt\n`,
    );
    const after = record("prd-t");
    expect(after).toMatchObject({ pid: stubPid(), exit: 3, auto: true });
    expect(Date.parse(after.ended)).toBeGreaterThanOrEqual(Date.parse(after.started));
  });

  it("records --managed (the dispatcher's), and by hand without it", () => {
    const r = run("session.sh", ["plan-m", "--auto", "--managed", "--", "x"], { STUB_NAME: "plan-m" });
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(join(state, "record-at-start"), "utf8"))).toMatchObject({
      kind: "plan",
      auto: true,
      managed: true,
    });
    expect(readFileSync(join(state, "args"), "utf8")).toBe(
      `--settings\n${scripts("context-settings.json")}\nx\n`,
    );
    expect(record("plan-m")).toMatchObject({ managed: true, exit: 0 });
    expect(run("session.sh", ["plan-m", "--", "x"], { STUB_NAME: "plan-m" }).status).toBe(0);
    expect(record("plan-m")).toMatchObject({ managed: false, auto: false });
  });

  it("leaves a newer session's record live when an older one under the same name exits", async () => {
    const first = start("bash", [scripts("session.sh"), "prd-t", "--", "x"], { STUB_MODE: "wait" });
    await until(() => existsSync(join(state, "ready")));
    const firstPid = stubPid();
    rmSync(join(state, "ready"));
    const second = start("bash", [scripts("session.sh"), "prd-t", "--", "x"], { STUB_MODE: "wait" });
    await until(() => existsSync(join(state, "ready")) && stubPid() !== firstPid);
    const secondPid = stubPid();
    process.kill(firstPid, "SIGTERM");
    const a = await first.done;
    expect(a.code).toBe(143);
    expect(a.stderr).toMatch(/belongs to a newer session now; its end \(pid \d+\) isn't recorded/);
    expect(record("prd-t")).toMatchObject({ pid: secondPid });
    expect(record("prd-t")).not.toHaveProperty("ended");
    process.kill(secondPid, "SIGTERM");
    const b = await second.done;
    expect(b.stderr).not.toMatch(/session.sh:/);
    expect(record("prd-t")).toMatchObject({ pid: secondPid, exit: 143 });
    expect(record("prd-t")).toHaveProperty("ended");
  });

  it("takes the kind and topic from a planner's name, and refuses a name it can't type", () => {
    expect(run("session.sh", ["plan-u", "--", "x"], { STUB_NAME: "plan-u" }).status).toBe(0);
    expect(record("plan-u")).toMatchObject({
      kind: "plan",
      topic: "u",
      auto: false,
      managed: false,
      exit: 0,
    });
    const r = run("session.sh", ["other", "--", "x"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--kind prd\|plan\|backlog\|hotfix\|recovery/);
    const bad = run("session.sh", ["other", "--kind", "nope", "--", "x"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/--kind prd\|plan\|backlog\|hotfix\|recovery\|inbox \(nope\)/);
  });

  it.each([
    ["backlog", "backlog", undefined],
    ["backlog-triage", "backlog", undefined],
    ["hotfix-trim", "hotfix", "trim"],
    ["recover", "recovery", undefined],
  ])("records %s as kind %s, with its model", (name, kind, topic) => {
    const r = run("session.sh", [name, "--", "--model", "sonnet", "--remote-control", name, "a prompt"], {
      STUB_NAME: name,
    });
    expect(r.status).toBe(0);
    const rec = record(name);
    expect(rec).toMatchObject({ kind, model: "sonnet", exit: 0 });
    expect(rec.topic).toBe(topic);
  });

  it("reads --model=<m>, and a later session with no model clears the old one", () => {
    expect(run("session.sh", ["backlog", "--", "--model=haiku", "x"], { STUB_NAME: "backlog" }).status).toBe(
      0,
    );
    expect(record("backlog").model).toBe("haiku");
    expect(run("session.sh", ["backlog", "--", "x"], { STUB_NAME: "backlog" }).status).toBe(0);
    expect(record("backlog").model).toBeUndefined();
  });
});

describe("liveness", () => {
  it("is live while the session runs, ended after, and never for a reused pid", async () => {
    const s = start("bash", [scripts("session.sh"), "prd-t", "--", "x"], { STUB_MODE: "wait" });
    await until(() => existsSync(join(state, "ready")));
    const node = (args) => spawnSync("node", [scripts("sessions.mjs"), ...args], { encoding: "utf8", env });
    expect(node(["live", "prd-t"]).stdout.trim()).toBe(String(stubPid()));
    process.kill(stubPid(), "SIGTERM");
    await s.done;
    expect(node(["live", "prd-t"]).status).toBe(1);
    // This test's own pid is live, but it isn't the process the record started.
    writeFileSync(
      join(sessions, "prd-old.json"),
      JSON.stringify({ pid: process.pid, kind: "prd", started: "2026-01-01T00:00:00Z" }),
    );
    expect(node(["live", "prd-old"]).status).toBe(1);
    const list = JSON.parse(node(["list", "--json"]).stdout);
    expect(list.map((r) => [r.name, r.live])).toEqual([
      ["prd-old", false],
      ["prd-t", false],
    ]);
  });

  it("gives prd and plan sessions the context hook and a hotfix none, whatever it inherited", () => {
    const argsOf = () => readFileSync(join(state, "args"), "utf8").trim().split("\n");
    expect(run("session.sh", ["prd-t", "--", "go"]).status).toBe(0);
    expect(argsOf()).toEqual(["--settings", scripts("context-settings.json"), "go"]);
    expect(run("session.sh", ["plan-t", "--", "go"]).status).toBe(0);
    expect(argsOf()).toEqual(["--settings", scripts("context-settings.json"), "go"]);
    const inherited = { RISA_SESSION_NAME: "prd-other", RISA_CONTEXT_HOOK: "/elsewhere" };
    expect(run("session.sh", ["hotfix-t", "--", "go"], inherited).status).toBe(0);
    expect(argsOf()).toEqual(["go"]);
    const shown = join(root, "env-stub");
    writeFileSync(
      shown,
      `#!/usr/bin/env bash\necho "\${RISA_SESSION_NAME:-none} \${RISA_CONTEXT_HOOK:-none}" > "$STUB_STATE/env"\n`,
    );
    chmodSync(shown, 0o755);
    expect(run("session.sh", ["hotfix-t", "--", "go"], { ...inherited, RISA_CLAUDE_BIN: shown }).status).toBe(
      0,
    );
    expect(readFileSync(join(state, "env"), "utf8").trim()).toBe("none none");
    expect(run("session.sh", ["prd-t", "--", "go"], { RISA_CLAUDE_BIN: shown }).status).toBe(0);
    expect(readFileSync(join(state, "env"), "utf8").trim()).toBe(`prd-t ${scripts("context.mjs")}`);
  });

  it("gives a backlog session the context hook, a named one too", () => {
    const argsOf = () => readFileSync(join(state, "args"), "utf8").trim().split("\n");
    for (const name of ["backlog", "backlog-tax"]) {
      expect(run("session.sh", [name, "--", "--model", "opus", "go"]).status).toBe(0);
      expect(argsOf()).toEqual(["--settings", scripts("context-settings.json"), "--model", "opus", "go"]);
    }
  });

  it("finds the ancestor claude from a shell under the stub, and none from one that isn't", () => {
    expect(spawnSync(stub, [], { encoding: "utf8", env: { ...env, STUB_MODE: "ancestor" } }).status).toBe(0);
    expect(readFileSync(join(state, "ancestor"), "utf8")).toBe(`${stubPid()}\nexit 0\n`);
    const r = spawnSync("node", [scripts("sessions.mjs"), "ancestor"], { encoding: "utf8", env });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
  });
});

describe("pnpm prd end", () => {
  it("ends a named session through its record, and its wrapper records the end", async () => {
    const s = start("bash", [scripts("session.sh"), "prd-t", "--", "x"], { STUB_MODE: "wait" });
    await until(() => existsSync(join(state, "ready")));
    const r = run("prd.sh", ["end", "prd-t"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`Ending prd-t \\(pid ${stubPid()}, from its record\\)`));
    const { code } = await s.done;
    expect(code).toBe(143);
    expect(record("prd-t")).toMatchObject({ exit: 143 });
    // Again: it has ended.
    expect(run("prd.sh", ["end", "prd-t"]).stdout).toMatch(/prd-t isn't running/);
  });

  it("with no name, ends the calling shell's own session: its worktree's record", async () => {
    const s = start(
      "bash",
      [scripts("session.sh"), "prd-w", "--", "x"],
      { STUB_MODE: "end" },
      join(loops, "w"),
    );
    const { code } = await s.done;
    expect(code).toBe(143);
    expect(readFileSync(join(state, "end.out"), "utf8")).toMatch(
      new RegExp(`Ending prd-w \\(pid ${stubPid()}, from its record\\)`),
    );
  });

  it("with no name and no record, ends the shell's ancestor claude", async () => {
    const s = start(stub, [], { STUB_MODE: "end" });
    const { signal } = await s.done;
    expect(signal).toBe("SIGTERM");
    expect(readFileSync(join(state, "end.out"), "utf8")).toMatch(
      new RegExp(`Ending this shell's claude \\(pid ${stubPid()}, from the calling shell's ancestor\\)`),
    );
  });

  it("kills a session that ignores TERM after the wait", async () => {
    const s = start("bash", [scripts("session.sh"), "prd-t", "--", "x"], { STUB_MODE: "stubborn" });
    await until(() => existsSync(join(state, "ready")));
    const r = run("prd.sh", ["end", "prd-t"], { RISA_END_WAIT: "1" });
    expect(r.stdout).toMatch(/ignored TERM for 1s: killed it/);
    expect((await s.done).code).toBe(137);
  });

  it("refuses a record whose live pid isn't the session's claude, and leaves that process alone (B-810)", async () => {
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    const stray = start(stub, [], { STUB_MODE: "wait", STUB_STATE: join(root, "stray") }, root);
    try {
      await until(() => existsSync(join(root, "stray", "ready")));
      const strayPid = Number(readFileSync(join(root, "stray", "pid"), "utf8").trim());
      const started = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      for (const pid of [sleeper.pid, strayPid]) {
        writeRecord(sessions, "prd-s", { pid, started, kind: "prd", topic: "s", dir: main });
        const r = run("prd.sh", ["end", "prd-s"]);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(new RegExp(`end: pid ${pid} in prd-s's record isn't its claude`));
        expect(r.stdout).not.toMatch(/Ending/);
        expect(() => process.kill(/** @type {number} */ (pid), 0)).not.toThrow();
      }
    } finally {
      sleeper.kill("SIGKILL");
      stray.child.kill("SIGKILL");
      rmSync(join(root, "stray"), { recursive: true, force: true });
    }
  });

  it("ends the live reopened session when the record names an older pid, and records its end (B-810)", async () => {
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const s = start("bash", [scripts("session.sh"), "prd-t", "--", "x"], { STUB_MODE: "wait" });
      await until(() => existsSync(join(state, "ready")));
      // The record went back to an older session's pid, still a running process.
      const started = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      writeRecord(sessions, "prd-t", { pid: sleeper.pid, started });
      const r = run("prd.sh", ["end", "prd-t"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(
        new RegExp(
          `Ending prd-t \\(pid ${stubPid()}, from the live session.sh prd-t \\(its record's pid ${sleeper.pid} was stale\\)\\)`,
        ),
      );
      expect((await s.done).code).toBe(143);
      expect(() => process.kill(/** @type {number} */ (sleeper.pid), 0)).not.toThrow();
      expect(record("prd-t")).toMatchObject({ pid: stubPid(), exit: 143 });
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("refuses with neither a record nor a claude above it, and an unknown name", () => {
    const r = run("prd.sh", ["end"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no session to end/);
    const named = run("prd.sh", ["end", "prd-nope"]);
    expect(named.status).toBe(1);
    expect(named.stderr).toMatch(/no session record prd-nope/);
  });
});

describe("sessions start through the wrapper", () => {
  it("pnpm prd start prints a command through session.sh", () => {
    const r = run("prd.sh", ["start", "w"]);
    expect(r.stdout).toContain(
      `cd ${join(loops, "w")} && ${scripts("session.sh")} prd-w -- --remote-control prd-w "$(${scripts("prompt.sh")} orchestrator w)"`,
    );
  });

  it("pnpm prd plan --open records a planner; without --open it prints the wrapped command", () => {
    const printed = run("prd.sh", ["plan", "v"]);
    expect(printed.stdout).toContain(
      `cd ${join(loops, "plan-v")} && ${scripts("session.sh")} plan-v -- --model opus --remote-control plan-v`,
    );
    expect(run("prd.sh", ["plan", "v", "--open", "--model", "opus"]).status).toBe(0);
    expect(record("plan-v")).toMatchObject({ pid: stubPid(), kind: "plan", topic: "v", exit: 0 });
    const args = readFileSync(join(state, "args"), "utf8").split("\n");
    expect(args.slice(0, 6)).toEqual([
      "--settings",
      scripts("context-settings.json"),
      "--model",
      "opus",
      "--remote-control",
      "plan-v",
    ]);
  });

  it("pnpm prd plan runs a design row's planner on Fable, and --model still overrides", () => {
    writeFileSync(
      join(main, "plans/backlog.md"),
      "## PRDs\n\n| PRD | Flags | After | Hot files | Doc and notes |\n| --- | --- | --- | --- | --- |\n| `v` | design | — | — | — |\n",
    );
    try {
      expect(run("prd.sh", ["plan", "v"]).stdout).toContain("-- --model fable --remote-control plan-v");
      expect(run("prd.sh", ["plan", "v", "--model", "sonnet"]).stdout).toContain(
        "-- --model sonnet --remote-control plan-v",
      );
      expect(run("prd.sh", ["plan", "v", "--open"]).status).toBe(0);
      const args = readFileSync(join(state, "args"), "utf8").split("\n");
      expect(args.slice(0, 4)).toEqual(["--settings", scripts("context-settings.json"), "--model", "fable"]);
    } finally {
      rmSync(join(main, "plans/backlog.md"), { force: true });
    }
  });

  it("pnpm prd plan with no topic is a recorded backlog session in the main checkout", () => {
    expect(run("prd.sh", ["plan", "--model", "sonnet"]).status).toBe(0);
    expect(record("backlog")).toMatchObject({ pid: stubPid(), kind: "backlog", model: "sonnet", exit: 0 });
    const args = readFileSync(join(state, "args"), "utf8").split("\n");
    expect(args.slice(2, 5)).toEqual(["--model", "sonnet", "--remote-control"]);
    // Its display name is a captain's; the record stays backlog and remembers it.
    expect(CAPTAINS).toContain(args[5]);
    expect(record("backlog").remote).toBe(args[5]);
  });

  it("each start of the main backlog session is a new captain, its tab titled the same", () => {
    let last = null;
    for (let i = 0; i < 6; i++) {
      const r = run("prd.sh", ["plan"], { RISA_TAB_TITLE: "always" });
      expect(r.status).toBe(0);
      const captain = readFileSync(join(state, "args"), "utf8").split("\n")[5];
      expect(CAPTAINS).toContain(captain);
      expect(captain).not.toBe(last);
      expect(r.stdout).toContain(`\x1b]0;${captain}\x07`);
      expect(record("backlog")).toMatchObject({ kind: "backlog", remote: captain });
      last = captain;
    }
  });

  it("titles no other session's tab: a backlog-<name> one keeps its name", () => {
    const r = run("session.sh", ["backlog-notes", "--", "--remote-control", "backlog - notes", "x"], {
      RISA_TAB_TITLE: "always",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("\x1b]0;");
    expect(record("backlog-notes")).toMatchObject({ kind: "backlog", remote: "backlog - notes" });
  });

  it("pnpm prd hotfix --open records the session; without --open it prints the wrapped command", () => {
    git(main, "worktree", "add", "-q", "-b", "hotfix/trim", join(loops, "hotfix-trim"), "dev");
    const printed = run("prd.sh", ["hotfix", "trim"]);
    expect(printed.stdout).toContain(
      `cd ${join(loops, "hotfix-trim")} && ${scripts("session.sh")} hotfix-trim -- --model opus --remote-control hotfix-trim`,
    );
    expect(run("prd.sh", ["hotfix", "trim", "--open", "--model", "sonnet"]).status).toBe(0);
    expect(record("hotfix-trim")).toMatchObject({
      pid: stubPid(),
      kind: "hotfix",
      topic: "trim",
      model: "sonnet",
      exit: 0,
    });
    const args = readFileSync(join(state, "args"), "utf8").split("\n");
    expect(args.slice(0, 4)).toEqual(["--model", "sonnet", "--remote-control", "hotfix-trim"]);
  });
});

describe("the inbox session", () => {
  const home = () => join(root, "home");
  const inboxDir = () => join(home(), ".risa/inbox");
  const inbox = (args = [], extra = {}) =>
    run("prd.sh", ["inbox", ...args], { RISA_INBOX_DIR: inboxDir(), ...extra });
  beforeEach(() => rmSync(home(), { recursive: true, force: true }));

  it("starts in its own directory outside the repository, creating it, on Opus at low effort", () => {
    const r = inbox();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(`Made ${inboxDir()} for the inbox session.`);
    expect(readFileSync(join(state, "cwd"), "utf8").trim()).toBe(inboxDir());
    expect(record("inbox")).toMatchObject({
      pid: stubPid(),
      kind: "inbox",
      model: "opus",
      remote: "inbox",
      exit: 0,
    });
    const args = readFileSync(join(state, "args"), "utf8").split("\n");
    // One settings file, and it is the one holding the context hook and the effort.
    expect(args.filter((a) => a === "--settings")).toHaveLength(1);
    expect(args.slice(0, 6)).toEqual([
      "--settings",
      scripts("inbox-settings.json"),
      "--model",
      "opus",
      "--remote-control",
      "inbox",
    ]);
    expect(args.slice(6).join("\n")).toMatch(/^You are the inbox agent\./);
    // A second start reuses the directory without the note.
    expect(inbox().stderr).not.toContain("Made ");
  });

  it("--model overrides Opus; the low-effort settings stay", () => {
    expect(inbox(["--model", "sonnet"]).status).toBe(0);
    expect(record("inbox")).toMatchObject({ kind: "inbox", model: "sonnet" });
    const args = readFileSync(join(state, "args"), "utf8").split("\n");
    expect(args.slice(0, 4)).toEqual(["--settings", scripts("inbox-settings.json"), "--model", "sonnet"]);
    expect(inbox(["--model=haiku"]).status).toBe(0);
    expect(record("inbox").model).toBe("haiku");
    expect(inbox(["--bogus"]).stderr).toContain(
      "inbox: unknown argument --bogus (--model <m>, --dir <d>, --managed)",
    );
  });

  it("records its directory, and takes --dir and --managed for a reopen", () => {
    expect(inbox().status).toBe(0);
    expect(record("inbox")).toMatchObject({ dir: inboxDir(), managed: false });
    const other = join(home(), "other-inbox");
    expect(inbox(["--dir", other, "--managed"], { RISA_INBOX_DIR: "" }).status).toBe(0);
    expect(readFileSync(join(state, "cwd"), "utf8").trim()).toBe(other);
    expect(record("inbox")).toMatchObject({ kind: "inbox", dir: other, managed: true, model: "opus" });
    expect(inbox(["--dir", join(main, "scripts")]).stderr).toContain("where AGENTS.md would load");
  });

  it("exports the context hook to the inbox session, as to a backlog session", () => {
    expect(inbox().status).toBe(0);
    expect(readFileSync(join(state, "hook"), "utf8").trim()).toBe(`inbox ${scripts("context.mjs")}`);
  });

  it("the settings file holds the context hook, low effort and fast mode off, and nothing else", () => {
    const own = JSON.parse(readFileSync(join(HERE, "inbox-settings.json"), "utf8"));
    const context = JSON.parse(readFileSync(join(HERE, "context-settings.json"), "utf8"));
    expect(own).toEqual({ ...context, fastMode: false, effortLevel: "low" });
  });

  it("refuses a directory inside a repository or under a CLAUDE.md or AGENTS.md", () => {
    const inside = inbox([], { RISA_INBOX_DIR: join(main, "inbox-here") });
    expect(inside.status).not.toBe(0);
    expect(inside.stderr).toContain(`is inside the git repository ${main}, where AGENTS.md would load`);
    mkdirSync(home(), { recursive: true });
    writeFileSync(join(home(), "AGENTS.md"), "# not for the inbox\n");
    const under = inbox();
    expect(under.status).not.toBe(0);
    expect(under.stderr).toContain(`inbox: ${home()}/AGENTS.md would load into the inbox session`);
    expect(existsSync(join(state, "args"))).toBe(false);
  });

  it("session.sh knows the inbox kind, and an unknown kind fails with every kind named", () => {
    expect(run("session.sh", ["inbox", "--", "x"]).status).toBe(0);
    expect(record("inbox").kind).toBe("inbox");
    const r = run("session.sh", ["nobody", "--", "x"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(
      "session.sh: --kind prd|plan|backlog|hotfix|recovery|inbox (none from the name nobody)",
    );
  });

  it("pnpm prd help lists it", () => {
    expect(run("prd.sh", ["help"]).stdout).toMatch(/^ {4}inbox \[--model <m>\] +the inbox agent/m);
  });
});
