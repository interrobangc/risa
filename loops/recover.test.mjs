// `pnpm prd recover` and `pnpm prd down` (recover.sh, down.sh, recover-lib.mjs,
// inventory-facts.mjs, inventory.mjs) against a throwaway repo with these
// scripts copied in, real git worktrees, the sample project's stub stack hook
// (its state and calls shared with the fakes), and fake lsof, open, sleep,
// claude, nvm and osascript (with RISA_ITERM_APP a folder here):
// nothing here touches real containers, servers, slots, sessions, tabs, asks or worktrees,
// and the dry run must change nothing on disk. The dispatcher is a node process that
// only sleeps, its pid in the lock; the fake tab for it starts one (a minute at most).
// The fakes keep their state (running projects, listening ports) in FAKE_STATE.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stubHookConfig } from "./config-fixture.mjs";
import { sharedNames } from "./config.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
const DEAD_PID = "999999"; // above macOS's and Linux's default pid_max

const FAKE_LSOF = `#!/usr/bin/env bash
echo "lsof $*" >> "$FAKE_LOG"
for p in \${FAKE_LISTEN:-} $(cat "$FAKE_STATE/listen" 2>/dev/null); do [[ "$*" == *"TCP:$p "* ]] && { echo 4242; exit 0; }; done
exit 1
`;

const FAKES = {
  // The opener's tab: logs its title (and " [dispatcher locked]" when a live
  // dispatcher holds its lock then), and keeps the line the tab would run, per
  // title. The dispatcher's tab starts a stand-in dispatcher that takes the lock,
  // unless $FAKE_STATE/dispatch-fails exists. A notification (-e) logs only that.
  osascript: `#!/usr/bin/env bash
cat >/dev/null
[[ $1 == - ]] || { echo "osascript notify" >> "$FAKE_LOG"; exit 0; }
lk=""; p=$(cat "$FAKE_DISPATCH_LOCK" 2>/dev/null) && kill -0 "$p" 2>/dev/null && lk=" [dispatcher locked]"
echo "osascript $3$lk" >> "$FAKE_LOG"; printf '%s\\n' "$2" > "$FAKE_STATE/tab-line"; printf '%s\\n' "$2" > "$FAKE_STATE/tab-$3"
if [[ $3 == dispatch && ! -f $FAKE_STATE/dispatch-fails ]]; then
  node -e "setTimeout(() => {}, 60000)" </dev/null >/dev/null 2>&1 &
  echo $! >> "$FAKE_STATE/dispatchers"; echo $! > "$FAKE_DISPATCH_LOCK"
fi
`,
  open: `#!/usr/bin/env bash
echo "open $*" >> "$FAKE_LOG"
`,
  // A fake clock: with RISA_CLOCK_FILE, sleeping moves it on.
  sleep: `#!/usr/bin/env bash
echo "sleep $*" >> "$FAKE_LOG"
[[ -z \${RISA_CLOCK_FILE:-} ]] || echo $(($(cat "$RISA_CLOCK_FILE") + \${1%.*})) > "$RISA_CLOCK_FILE"
`,
  // The recovery agent (--remote-control): logs one line and records its cwd and
  // args, one per line, in $FAKE_STATE/agent-args. A probe (-p) fails
  // $FAKE_STATE/claude-fails times, then answers.
  claude: `#!/usr/bin/env bash
if [[ $1 == --remote-control ]]; then
  lk=""; p=$(cat "$FAKE_DISPATCH_LOCK" 2>/dev/null) && kill -0 "$p" 2>/dev/null && lk=" [dispatcher locked]"
  echo "claude --remote-control $2 (agent)$lk" >> "$FAKE_LOG"
  printf '%s\\n' "$PWD" "$@" > "$FAKE_STATE/agent-args"
  exit 0
fi
echo "claude $*" >> "$FAKE_LOG"
n=$(cat "$FAKE_STATE/claude-fails" 2>/dev/null || echo 0)
((n > 0)) && { echo $((n - 1)) > "$FAKE_STATE/claude-fails"; exit 1; }
exit 0
`,
};

let root, main, loops, log, env, state;
const recover = (args = [], extra = {}) =>
  spawnSync("bash", [join(main, "loops/prd.sh"), "recover", ...args], {
    cwd: main,
    encoding: "utf8",
    env: { ...env, ...extra },
  });
const okRecover = (args, extra) => {
  const r = recover(args, extra);
  if (r.status !== 0) throw new Error(`recover ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};
const json = (extra) => JSON.parse(okRecover(["--dry-run", "--json"], extra));
const steps = (inv) => inv.actions.map((a) => (a.target ? `${a.step} ${a.target}` : a.step));
const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
/** Write or remove one of the stub hook's and the fakes' state files. */
const put = (file, text) => writeFileSync(join(state, file), text);
const drop = (...files) => {
  for (const f of files) rmSync(join(state, f), { force: true });
};

/** Every path under DIR with its size and mtime (and a directory's entries). */
function snapshot(dir, out = new Map()) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (p === log || p === state) continue; // the fakes' own bookkeeping
    const st = lstatSync(p);
    out.set(p, `${st.isDirectory() ? "d" : "f"} ${st.size} ${st.mtimeMs}`);
    if (st.isDirectory()) snapshot(p, out);
  }
  return out;
}

const worktree = (name, branch, from) =>
  git(main, "worktree", "add", "-q", "-b", branch, join(loops, name), from);
const stackEnv = (name, slot) => {
  const dir = join(loops, name);
  writeFileSync(
    join(dir, ".sample-stack"),
    `project=sample-loop${slot}\nslot=${slot}\nweb_port=6${slot}73\n`,
  );
};

function build() {
  root = realpathSync(mkdtempSync(join(tmpdir(), "recover-test-")));
  main = join(root, "repo");
  loops = join(main, ".loops");
  log = join(root, "calls.log");
  state = join(root, "state");
  mkdirSync(state);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const fakes = { lsof: FAKE_LSOF, ...FAKES };
  for (const [f, text] of Object.entries(fakes)) {
    writeFileSync(join(bin, f), text);
    chmodSync(join(bin, f), 0o755);
  }
  mkdirSync(join(root, "nvm"));
  writeFileSync(join(root, "nvm/nvm.sh"), "nvm() { :; }\n");
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_LOG: log,
    FAKE_STATE: state,
    SAMPLE_STACK_STATE: state,
    SAMPLE_STACK_LOG: log,
    SAMPLE_STACK_MARK: join(root, "repo/.loops/.down.json"),
    FAKE_RECORD: join(root, "repo/.loops/.down.json"),
    FAKE_DISPATCH_LOCK: join(root, "repo/.loops/.dispatch.lock"),
    NVM_DIR: join(root, "nvm"),
    TZ: "UTC",
    TRUNK: "dev",
    RISA_FREE_GB: "50",
    RISA_MIN_FREE_GB: "",
    RISA_LEASE_ROOT: "",
    RISA_CLOCK_FILE: "",
    RISA_ITERM_APP: join(root, "iTerm.app"),
    RISA_SESSIONS_DIR: "",
    RISA_LANDING_DIR: "",
    RISA_ASKS_DIR: "",
  };
  mkdirSync(join(root, "iTerm.app"));
  for (const k of [
    "RISA_RECOVER_PROBE_SECS",
    "RISA_RECOVER_STEP_SECS",
    "RISA_RECOVER_DISPATCH_SECS",
    "SAMPLE_STACK_FAIL",
  ])
    delete env[k];

  execFileSync("git", ["init", "-q", "-b", "dev", main]);
  for (const [k, v] of [
    ["user.email", "test@example.com"],
    ["user.name", "Test"],
    ["commit.gpgsign", "false"],
  ])
    git(main, "config", k, v);
  mkdirSync(join(main, "loops"), { recursive: true });
  for (const f of readdirSync(HERE).filter((f) => f.endsWith(".sh") || f.endsWith(".mjs")))
    copyFileSync(join(HERE, f), join(main, "loops", f));
  cpSync(join(HERE, "prompts"), join(main, "loops/prompts"), { recursive: true });
  mkdirSync(join(main, "backlog"));
  for (const f of ["registry.mjs", "format.mjs"])
    copyFileSync(join(HERE, "../backlog", f), join(main, "backlog", f));
  env.RISA_CONFIG = stubHookConfig(main);
  writeFileSync(join(main, ".gitignore"), ".loops/\n.env\n.env.*\n.sample-*\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "chore: init");
  git(main, "branch", "prd/t");

  // t: the PRD (stack, server port); t-1: merged (stack); t-2: active (stack); t-3: stackless and
  // dirty; t-4: merged and dirty; plan-u: a planner.
  git(main, "worktree", "add", "-q", join(loops, "t"), "prd/t");
  stackEnv("t", 1);
  for (const n of [1, 2, 3, 4]) {
    worktree(`t-${n}`, `slice/t/${n}`, "prd/t");
    writeFileSync(join(loops, `t-${n}`, `s${n}.txt`), `slice ${n}\n`);
    git(join(loops, `t-${n}`), "add", ".");
    git(join(loops, `t-${n}`), "commit", "-q", "-m", `feat(t): slice ${n}`);
  }
  for (const n of [1, 4])
    git(join(loops, "t"), "merge", "-q", "--no-ff", "-m", `feat(t): slice ${n}`, `slice/t/${n}`);
  stackEnv("t-2", 2);
  stackEnv("t-1", 3);
  writeFileSync(join(loops, "t-3", "wip.txt"), "uncommitted\n");
  writeFileSync(join(loops, "t-4", "wip.txt"), "uncommitted\n");
  worktree("plan-u", "plan/u", "dev");

  // Locks: a live and a stale slot lease.
  mkdirSync(join(loops, ".slots/1"), { recursive: true });
  writeFileSync(join(loops, ".slots/1/name"), "t\n");
  mkdirSync(join(loops, ".slots/9"), { recursive: true });
  writeFileSync(join(loops, ".slots/9/name"), "gone-7\n");
}
const BUILD_MS = 60_000; // dozens of git commands, slow when pnpm check runs beside it
/** End the stand-in dispatchers the fake tab started. */
const endDispatchers = () => {
  const f = join(state, "dispatchers");
  if (!existsSync(f)) return;
  for (const pid of readFileSync(f, "utf8").split("\n").filter(Boolean))
    try {
      process.kill(Number(pid));
    } catch {
      /* already gone */
    }
  rmSync(f);
};
const fresh = () => {
  beforeAll(build, BUILD_MS);
  afterAll(() => {
    endDispatchers();
    rmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => rmSync(log, { force: true }));
};

describe("recover --dry-run", () => {
  fresh();

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

describe("down and recover", () => {
  fresh();
  const record = () => join(loops, ".down.json");
  // Everything recovery or down does to the machine, in order (not the read-only probes).
  // `marked` keeps the " (record)" mark: the record existed when the call was made.
  const effects = (marked = false) =>
    calls()
      .split("\n")
      .filter((l) => /^(stack (start|stop) |test-db (up|down)( |$)|(serve|open|osascript|claude) )/.test(l))
      .map((l) => (marked ? l : l.replace(/ \(record\)$/, "")));
  const down = (extra = {}) => {
    const r = spawnSync("bash", [join(main, "loops/prd.sh"), "down"], {
      cwd: main,
      encoding: "utf8",
      env: { ...env, ...extra },
    });
    if (r.status !== 0) throw new Error(`down failed:\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
  };
  const allDown = () => {
    put("running", "");
    put("listen", "");
    drop("testdb-up", "engine-down");
  };

  it("down writes the record first, then stops servers, stacks and the test Postgres", () => {
    // Up: t (prd), t-1 (merged) and t-2 (active) stacks, t's and t-2's servers, the test Postgres.
    put("running", "sample-loop1\nsample-loop2\nsample-loop3\n");
    put("testdb-up", "");
    put("listen", "6173\n6273\n");
    const out = down();
    expect(JSON.parse(readFileSync(record(), "utf8"))).toEqual({
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      stacks: ["t", "t-1", "t-2"],
      servers: ["t", "t-2"],
      testDb: true,
      dispatcher: false,
    });
    expect(effects(true)).toEqual([
      "serve t --stop (record)",
      "serve t-2 --stop (record)",
      "stack stop t (record)",
      "stack stop t-1 (record)",
      "stack stop t-2 (record)",
      "test-db down (record)",
    ]);
    expect(readFileSync(join(state, "running"), "utf8")).toBe("");
    expect(existsSync(join(state, "testdb-up"))).toBe(false);
    expect(readFileSync(join(state, "listen"), "utf8")).toBe("");
    expect(out).toMatch(/stopped stack t-2 \(sample-loop2, data kept\)/);
    expect(out).toMatch(/stopped dev server t\n/);
    expect(out).toMatch(/stopped the shared test Postgres/);
  });

  it("a second down stops nothing and keeps the record", () => {
    const before = JSON.parse(readFileSync(record(), "utf8"));
    expect(down()).toMatch(/nothing was running/);
    expect(effects()).toEqual([]);
    expect(JSON.parse(readFileSync(record(), "utf8"))).toMatchObject({
      stacks: before.stacks,
      servers: before.servers,
      testDb: true,
    });
  });

  it("recover issues exactly the recorded starts in order, clears only stale locks, and deletes the record", () => {
    const out = okRecover([]);
    expect(effects()).toEqual([
      "test-db up",
      "stack start t",
      "stack start t-1",
      "stack start t-2",
      "serve t",
      "serve t-2",
      "claude --remote-control recover (agent)",
    ]);
    expect(out).toMatch(/• stack t-2\n {2}up and migrated \(sample-loop2\)/);
    expect(existsSync(record())).toBe(false);
    expect(existsSync(join(loops, ".slots/9"))).toBe(false);
    expect(existsSync(join(loops, ".slots/1"))).toBe(true);
    expect(out).toMatch(/Merged slices to clean up[^\n]*\n {2}t-1\n {2}t-4\n/);
    expect(out).toMatch(/Sessions to carry on or reopen[^\n]*\n {2}prd-t {2}in \S+\/t\n {2}plan-u {2}in /);
    expect(out).toMatch(/Recovered\.$/m);
    // Last, the recovery agent in this terminal, in the main checkout, with its prompt.
    expect(out).toMatch(/Opening the recovery agent/);
    const [cwd, ...args] = readFileSync(join(state, "agent-args"), "utf8").split("\n");
    expect(cwd).toBe(main);
    expect(args.slice(0, 2)).toEqual(["--remote-control", "recover"]);
    expect(args[2]).toMatch(/^You are the recovery agent\./);
    expect(args.join("\n")).toMatch(/ListAgents/);
    // Through the wrapper: recorded as a recovery session.
    const rec = JSON.parse(readFileSync(join(loops, ".sessions/recover.json"), "utf8"));
    expect(rec).toMatchObject({ kind: "recovery", exit: 0 });
  });

  it("a second recover does nothing (with --no-agent, launches nothing)", () => {
    rmSync(join(state, "agent-args"));
    const out = okRecover(["--no-agent"]);
    expect(effects()).toEqual([]);
    expect(out).not.toMatch(/^• /m);
    expect(calls()).not.toMatch(/^(stack (start|up)|test-db up)( |$)/m);
    expect(out).toMatch(/Sessions to carry on or reopen/);
    expect(out).toMatch(/--no-agent: to message and reopen them/);
    expect(existsSync(join(state, "agent-args"))).toBe(false);
  });

  it("doesn't open the agent when something didn't recover", () => {
    allDown();
    rmSync(join(state, "agent-args"), { force: true });
    const r = recover([], { SAMPLE_STACK_FAIL: "start:t" }); // t's stack doesn't start
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Didn't recover:\n {2}stack t/);
    expect(r.stdout).toMatch(/Not opening the recovery agent/);
    expect(r.stdout).not.toMatch(/Recovered\./);
    expect(effects()).not.toContain("claude --remote-control recover (agent)");
    expect(existsSync(join(state, "agent-args"))).toBe(false);
  });

  it("without a record, brings back only the prd and active stacks and the prd server", () => {
    allDown();
    okRecover(["--no-agent"]);
    expect(effects()).toEqual(["test-db up", "stack start t", "stack start t-2", "serve t"]);
  });

  it("starts the stack engine (the stackEngine hook) when it isn't running, before anything else", () => {
    allDown();
    put("engine-down", "");
    const out = okRecover([]);
    expect(out).toMatch(/Sample engine isn't running: starting it/);
    const lines = calls().split("\n");
    const started = lines.indexOf("stack engine start");
    expect(started).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf("test-db up")).toBeGreaterThan(started);
    expect(effects()).toContain("stack start t-2");
  });

  it("gives up when the stack engine doesn't start", () => {
    allDown();
    put("engine-down", "");
    const r = recover([], { SAMPLE_STACK_FAIL: "engine:start" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/recover: Sample engine didn't start/);
    expect(effects().filter((l) => /^(stack start|test-db up)/.test(l))).toEqual([]);
    drop("engine-down");
  });

  it("--at sleeps until that time, then recovers", () => {
    allDown();
    const clock = join(state, "clock");
    put("clock", String(Date.UTC(2026, 10, 19, 12, 0, 0) / 1000)); // 12:00 UTC
    const out = okRecover(["--at", "15:00"], { RISA_CLOCK_FILE: clock });
    expect(out).toMatch(/Waiting until 15:00 \(in 3h00m\)/);
    const lines = calls().split("\n");
    const slept = lines.filter((l) => l.startsWith("sleep ")).map((l) => Number(l.split(" ")[1]));
    expect(slept.reduce((a, b) => a + b, 0)).toBe(3 * 3600);
    expect(Math.max(...slept)).toBeLessThanOrEqual(300);
    const lastSleep = lines.findLastIndex((l) => l.startsWith("sleep "));
    expect(lines.indexOf("test-db up")).toBeGreaterThan(lastSleep);
  });

  // A wait of most of a day in 300 s steps is 258 fake sleeps, each a process or
  // two: about 3 s idle and past the 20 s test timeout under load (B-418). The
  // step test above keeps 300 s; these take 6 h steps, so they stay a handful.
  const slept = () =>
    calls()
      .split("\n")
      .filter((l) => l.startsWith("sleep "))
      .map((l) => Number(l.split(" ")[1]));
  const STEP = { RISA_RECOVER_STEP_SECS: String(6 * 3600) };

  it("--at a time that has passed waits until tomorrow", () => {
    const clock = join(state, "clock");
    put("clock", String(Date.UTC(2026, 10, 19, 12, 0, 0) / 1000));
    const out = okRecover(["--at=09:30"], { ...STEP, RISA_CLOCK_FILE: clock });
    expect(out).toMatch(/Waiting until 09:30 \(in 21h30m\)/);
    expect(Number(readFileSync(clock, "utf8"))).toBe(Date.UTC(2026, 10, 20, 9, 30, 0) / 1000);
    expect(slept()).toEqual([21600, 21600, 21600, 12600]);
  });

  it("--at reads the time in the local time zone, not UTC", () => {
    const clock = join(state, "clock");
    put("clock", String(Date.UTC(2026, 10, 19, 12, 0, 0) / 1000)); // 04:00 in Los Angeles (PST)
    const out = okRecover(["--at", "03:30"], {
      ...STEP,
      TZ: "America/Los_Angeles",
      RISA_CLOCK_FILE: clock,
    });
    expect(out).toMatch(/Waiting until 03:30 \(in 23h30m\)/);
    expect(Number(readFileSync(clock, "utf8"))).toBe(Date.UTC(2026, 10, 20, 11, 30, 0) / 1000);
    expect(slept().reduce((a, b) => a + b, 0)).toBe(23.5 * 3600);
  });

  it("refuses a step that isn't a whole number of seconds", () => {
    put("clock", String(Date.UTC(2026, 10, 19, 12, 0, 0) / 1000));
    const r = recover(["--at", "13:00"], {
      RISA_RECOVER_STEP_SECS: "0",
      RISA_CLOCK_FILE: join(state, "clock"),
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/RISA_RECOVER_STEP_SECS must be a whole number/);
    expect(calls()).not.toMatch(/^sleep /m);
  });

  it("--wait probes claude every 10 minutes until one answers, then recovers", () => {
    allDown();
    put("claude-fails", "2");
    const out = okRecover(["--wait"]);
    expect(out).toMatch(/a claude -p probe every 10m00s/);
    expect(out).toMatch(/probe 3: Claude answered/);
    const lines = calls()
      .split("\n")
      .filter((l) => /^(claude |sleep |test-db up$)/.test(l));
    expect(lines.slice(0, 6)).toEqual([
      "claude -p ok",
      "sleep 600",
      "claude -p ok",
      "sleep 600",
      "claude -p ok",
      "test-db up",
    ]);
  });
});

describe("down and recover with the dispatcher", () => {
  fresh();
  const record = () => join(loops, ".down.json");
  const lock = () => join(loops, ".dispatch.lock");
  const effects = () =>
    calls()
      .split("\n")
      .filter((l) => /^(stack (start|stop) |test-db (up|down)( |$)|(serve|open|osascript|claude) )/.test(l))
      .map((l) => l.replace(/ \(record\)$/, ""));
  const tabs = () => effects().filter((l) => l.startsWith("osascript"));
  /**
   * A stand-in dispatcher: a process that only sleeps, its pid in the lock. Started
   * through a shell that exits at once, so it isn't this test's child (a child that
   * died would linger as a zombie, still answering kill 0, while spawnSync blocks).
   */
  const fakeDispatcher = () => {
    const pid = Number(
      execFileSync(
        "bash",
        ["-c", `"${process.execPath}" -e "setInterval(() => {}, 1000)" </dev/null >/dev/null 2>&1 & echo $!`],
        { encoding: "utf8" },
      ).trim(),
    );
    writeFileSync(lock(), `${pid}\n`);
    return pid;
  };
  const gone = (/** @type {number} */ pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };

  it("down records that the dispatcher ran, and stops it", () => {
    const pid = fakeDispatcher();
    const r = spawnSync("bash", [join(main, "loops/prd.sh"), "down"], {
      cwd: main,
      encoding: "utf8",
      env,
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`stopped the dispatcher (pid ${pid})`);
    expect(r.stdout).not.toMatch(/nothing was running/);
    expect(JSON.parse(readFileSync(record(), "utf8")).dispatcher).toBe(true);
    expect(gone(pid)).toBe(true);
  });

  it("recover clears the stale lock, reopens it in a background tab, waits for its lock, then opens the agent", () => {
    const out = okRecover([]);
    expect(out).toMatch(/• cleared stale lock \.loops\/\.dispatch\.lock/);
    expect(out).toMatch(
      /• the dispatcher \(it was running\)\n {2}Opened dispatch in a new background iTerm2 tab[^\n]*\n {2}running \(pid \d+\)/,
    );
    expect(tabs()).toEqual(["osascript dispatch"]);
    const e = effects();
    expect(e.indexOf("osascript dispatch")).toBeGreaterThan(e.indexOf("test-db up"));
    // The agent opened only once the new dispatcher held its lock.
    expect(e.at(-1)).toBe("claude --remote-control recover (agent) [dispatcher locked]");
    expect(readFileSync(join(state, "tab-line"), "utf8").trim()).toBe(
      `cd ${main} && exec ${join(main, "loops/prd.sh")} dispatch`,
    );
    const started = readFileSync(join(state, "dispatchers"), "utf8").trim().split("\n").at(-1);
    expect(readFileSync(lock(), "utf8").trim()).toBe(started);
    expect(existsSync(record())).toBe(false);
    expect(existsSync(join(loops, ".dispatch-intent.json"))).toBe(false);
    expect(existsSync(join(loops, ".recover.lock"))).toBe(false);
  });

  it("a second recover doesn't reopen it (it runs now)", () => {
    okRecover(["--no-agent"]);
    expect(tabs()).toEqual([]);
    endDispatchers();
    rmSync(lock(), { force: true });
  });

  it("recover leaves a running dispatcher alone", () => {
    const pid = fakeDispatcher();
    try {
      expect(okRecover(["--no-agent"])).not.toMatch(/dispatcher/);
      expect(tabs()).toEqual([]);
      expect(readFileSync(lock(), "utf8").trim()).toBe(String(pid));
    } finally {
      process.kill(pid);
      rmSync(lock(), { force: true });
    }
  });
});

describe("down when the dispatcher won't stop", () => {
  fresh();
  const record = () => join(loops, ".down.json");
  const lock = () => join(loops, ".dispatch.lock");
  const effects = () =>
    calls()
      .split("\n")
      .filter((l) => /^(stack (start|stop) |test-db (up|down)( |$)|serve )/.test(l))
      .map((l) => l.replace(/ \(record\)$/, ""));
  /** A stand-in dispatcher (not this test's child), its pid in the lock; `stubborn` ignores TERM. */
  const dispatcher = (stubborn) => {
    const code = `${stubborn ? "process.on('SIGTERM', () => {}); " : ""}setInterval(() => {}, 1000)`;
    const pid = Number(
      execFileSync(
        "bash",
        ["-c", `"${process.execPath}" -e "${code}" </dev/null >/dev/null 2>&1 & echo $!`],
        {
          encoding: "utf8",
        },
      ).trim(),
    );
    writeFileSync(lock(), `${pid}\n`);
    return pid;
  };
  const down = () =>
    spawnSync("bash", [join(main, "loops/prd.sh"), "down"], {
      cwd: main,
      encoding: "utf8",
      env: { ...env, RISA_DISPATCH_STOP_SECS: "0.5" },
    });
  const allUp = () => {
    put("running", "sample-loop1\nsample-loop2\nsample-loop3\n");
    put("testdb-up", "");
    put("listen", "6173\n6273\n");
  };

  it("stops nothing else, keeps the record and says how to retry", async () => {
    allUp();
    const pid = dispatcher(true);
    try {
      // Let it install its TERM handler before down sends TERM.
      await new Promise((r) => setTimeout(r, 500));
      const r = down();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(`couldn't stop the dispatcher (pid ${pid})`);
      expect(r.stderr).toMatch(/stopped nothing else.*record stays.*then pnpm prd down/);
      expect(effects()).toEqual([]);
      expect(readFileSync(join(state, "running"), "utf8")).toBe("sample-loop1\nsample-loop2\nsample-loop3\n");
      expect(existsSync(join(state, "testdb-up"))).toBe(true);
      expect(readFileSync(join(state, "listen"), "utf8")).toBe("6173\n6273\n");
      expect(JSON.parse(readFileSync(record(), "utf8"))).toMatchObject({
        stacks: ["t", "t-1", "t-2"],
        servers: ["t", "t-2"],
        testDb: true,
        dispatcher: true,
      });
    } finally {
      process.kill(pid, "SIGKILL");
      rmSync(lock(), { force: true });
    }
  });

  it("the retry, with a dispatcher that stops, stops them all", () => {
    const pid = dispatcher(false);
    const r = down();
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`stopped the dispatcher (pid ${pid})`);
    expect(effects()).toEqual([
      "serve t --stop",
      "serve t-2 --stop",
      "stack stop t",
      "stack stop t-1",
      "stack stop t-2",
      "test-db down",
    ]);
    expect(readFileSync(join(state, "running"), "utf8")).toBe("");
    expect(existsSync(join(state, "testdb-up"))).toBe(false);
    expect(JSON.parse(readFileSync(record(), "utf8"))).toMatchObject({ testDb: true, dispatcher: true });
  });
});

describe("recover unattended: the lock, the gated dispatcher, its intent, the migrate marker", () => {
  fresh();
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
    expect(effects().at(-1)).toBe("claude --remote-control recover (agent) [dispatcher locked]");
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
