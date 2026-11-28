// `prd dispatch --restart` (RISA-1009) against a throwaway repo with the
// dispatcher and its modules copied in. The running dispatcher is a stub process
// holding the lock; the opener stub runs its --command line detached (standing in
// for the background tab), and the tool's command (the fixture's `pnpm prd`) is a
// stub `pnpm` that runs the copied dispatch.mjs. Nothing opens a tab or starts claude.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lockHolder } from "./dispatch.mjs";
import { dispatcherPart } from "./status-extra.mjs";
import "./config-fixture.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const MODULES = [
  "dispatch.mjs",
  "dispatch-pick.mjs",
  "dispatch-context.mjs",
  "dispatch-stuck.mjs",
  "context.mjs",
  "heartbeat.mjs",
  "keep-alive.mjs",
  "session-requests.mjs",
  "notices.mjs",
  "asks.mjs",
  "ask.mjs",
  "skeptics.mjs",
  "doc.mjs",
  "sessions.mjs",
  "captain.mjs",
  "flavor.mjs",
  "session-names.mjs",
  "load-gate.mjs",
  "rotate.mjs",
  "open-session.mjs",
  "host.mjs",
  "planner-model.mjs",
  "config.mjs",
  "machine.mjs",
  "drain.mjs",
  "usage.mjs",
  "land-journal.mjs",
  "finish.mjs",
  "landed.mjs",
  "resume.mjs",
];
// The opener: records its arguments, then runs the --command line detached.
const OPEN_SH = `#!/usr/bin/env bash
printf '%s\\x1f' "$@" >> "$STUB_STATE/open.calls"; echo >> "$STUB_STATE/open.calls"
while (($#)); do [[ $1 == --command ]] && cmd=$2; shift; done
nohup bash -c "$cmd" >/dev/null 2>&1 &
echo "Opened in a new background iTerm2 tab."
`;
// The tool's command: \`pnpm prd dispatch …\` runs the copied dispatcher.
const PNPM = `#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/pnpm.calls"
[[ $1 == prd ]] && shift
[[ $1 == dispatch ]] && shift
exec node "$STUB_MAIN/loops/dispatch.mjs" "$@"
`;
// The running dispatcher: holds the lock, frees it on TERM.
const HOLDER = `import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
const lock = process.env.STUB_LOCK;
writeFileSync(lock, process.pid + "\\n");
process.on("SIGTERM", () => {
  if (Number(readFileSync(lock, "utf8")) === process.pid) unlinkSync(lock);
  process.exit(0);
});
setInterval(() => {}, 1000);
`;
// Preloaded into a dispatcher (NODE_OPTIONS): once its exit handlers are on, it
// throws (or rejects) a two-line error from outside any tick. The node processes
// it runs load it too: they're left alone.
const THROWER = (
  /** @type {"throw" | "reject"} */ how,
) => `if (process.argv[1]?.endsWith("/loops/dispatch.mjs")) {
const t = setInterval(() => {
  if (!process.listenerCount("uncaughtException")) return;
  clearInterval(t);
  const e = new Error("boom from the test\\nsecond line");
  ${how === "throw" ? "throw e;" : "Promise.reject(e);"}
}, 50);
}
`;

let root, main, loops, state, env, lock;
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
const dispatch = (args) =>
  spawnSync("node", [join(main, "loops/dispatch.mjs"), ...args], { cwd: main, encoding: "utf8", env });
const dstate = () => JSON.parse(readFileSync(join(loops, ".dispatch.json"), "utf8"));
const calls = (f) => {
  const p = join(state, `${f}.calls`);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-restart-")));
  main = join(root, "repo");
  loops = join(main, ".loops");
  lock = join(loops, ".dispatch.lock");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude-stub"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(bin, "osascript"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(bin, "pnpm"), PNPM);
  for (const f of ["claude-stub", "osascript", "pnpm"]) chmodSync(join(bin, f), 0o755);
  mkdirSync(join(root, "iTerm.app"));
  execFileSync("git", ["init", "-q", "-b", "dev", main]);
  for (const [k, v] of [
    ["user.email", "test@example.com"],
    ["user.name", "Test"],
    ["commit.gpgsign", "false"],
  ])
    git(main, "config", k, v);
  mkdirSync(join(main, "loops"), { recursive: true });
  mkdirSync(join(main, "backlog"), { recursive: true });
  for (const f of MODULES) copyFileSync(join(HERE, f), join(main, "loops", f));
  writeFileSync(join(main, "loops/open-session.sh"), OPEN_SH);
  writeFileSync(join(root, "holder.mjs"), HOLDER);
  // The backlog: an empty registry, so every tick does nothing.
  writeFileSync(join(main, "backlog/backlog.mjs"), 'console.log("[]");\n');
  for (const f of ["registry.mjs", "format.mjs"])
    copyFileSync(join(HERE, "../backlog", f), join(main, "backlog", f));
  writeFileSync(join(main, ".gitignore"), ".loops/\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "chore: init");
  writeFileSync(join(root, "load"), "1 1 1");
  state = join(root, "state");
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    RISA_MAIN: main,
    RISA_CLAUDE_BIN: join(bin, "claude-stub"),
    RISA_ITERM_APP: join(root, "iTerm.app"),
    RISA_SESSIONS_DIR: "",
    RISA_ASKS_DIR: "",
    RISA_ASK_NOTIFY: "",
    RISA_REQUESTS_DIR: "",
    RISA_NOTICES_DIR: "",
    RISA_LOAD_FILE: join(root, "load"),
    RISA_LOAD_GATE: "",
    RISA_CLOCK_FILE: "",
    RISA_KEEP_SESSIONS: "off",
    RISA_PROCESS_FILE: join(root, "processes"),
    RISA_USAGE_WATCH: "off",
    RISA_USAGE_DIR: "",
    RISA_LANDING_DIR: "",
    RISA_PICKUP_EVERY: "off",
    RISA_CONTEXT_WATCH: "off",
    RISA_STUCK_WATCH: "off",
    RISA_INBOX_DIR: join(root, "inbox"),
    RISA_CLAUDE_PROJECTS: join(root, "projects"),
    RISA_CLAUDE_CONFIG: join(root, "claude.json"),
    RISA_DISPATCH_START_SECS: "20",
    STUB_STATE: state,
    STUB_MAIN: main,
    STUB_LOCK: lock,
  };
}, 60_000);
// A TERMed dispatcher may still be writing its log: retry the removal.
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

/** @type {number[]} */
let started = [];
beforeEach(() => {
  rmSync(state, { recursive: true, force: true });
  mkdirSync(state, { recursive: true });
  rmSync(loops, { recursive: true, force: true });
  mkdirSync(loops, { recursive: true });
  started = [];
});
afterEach(async () => {
  // The new dispatcher runs detached: end whatever holds the lock, and wait for it to go.
  const pid = lockHolder(lock);
  const pids = [...started, ...(pid ? [pid] : [])];
  for (const p of pids)
    try {
      process.kill(p, "SIGTERM");
    } catch {
      /* gone */
    }
  const end = Date.now() + 10_000;
  while (pids.some(alive) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
}, 15_000);

describe("dispatch --restart (RISA-1009)", () => {
  it("ends the running one and starts one new one detached, keeping its --every and keep-alive", async () => {
    // A user's "stop keeping it alive" for the inbox: a plain start would clear it.
    writeFileSync(
      join(loops, ".dispatch.json"),
      JSON.stringify({ keepAlive: { inbox: { stopped: true }, backlog: { deaths: 1, openedAt: 1 } } }),
    );
    const holder = spawn("node", [join(root, "holder.mjs"), "--every", "7"], { env, stdio: "ignore" });
    const exited = new Promise((r) => holder.on("exit", (code) => r(code)));
    started.push(/** @type {number} */ (holder.pid));
    const end = Date.now() + 10_000;
    while (lockHolder(lock) !== holder.pid && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(lockHolder(lock)).toBe(holder.pid);

    const r = dispatch(["--restart"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(await exited).toBe(0);
    const now = lockHolder(lock);
    expect(now).toBeTruthy();
    expect(now).not.toBe(holder.pid);
    const s = dstate();
    expect(s.code).toMatchObject({ pid: now, every: 7 });
    expect(r.stdout.trim()).toBe(
      `Restarted the dispatcher: pid ${holder.pid} -> ${now}, code ${s.code.hash} (every 7s, keep-alive kept).`,
    );
    expect(s.keepAlive).toEqual({ inbox: { stopped: true }, backlog: { deaths: 1, openedAt: 1 } });
    // One tab, through the tool's command (the fixture's `pnpm prd`), not this checkout's file.
    const opens = calls("open").map((l) => l.split("\x1f").filter(Boolean));
    expect(opens).toEqual([
      [
        "--command",
        `cd ${main} && pnpm prd dispatch --every 7 --restarted ${holder.pid}`,
        "--title",
        "dispatch",
        "--background",
      ],
    ]);
    expect(calls("pnpm")).toEqual([`prd dispatch --every 7 --restarted ${holder.pid}`]);
    expect(readFileSync(join(loops, ".dispatch.log"), "utf8")).toContain(
      `restarted (was pid ${holder.pid}; pid ${now}`,
    );

    // Restarting the new one carries the --every its start wrote down.
    const again = dispatch(["--restart"]);
    expect(again.status).toBe(0);
    const third = lockHolder(lock);
    expect(third).not.toBe(now);
    expect(alive(/** @type {number} */ (now))).toBe(false);
    expect(again.stdout).toContain(`pid ${now} -> ${third}`);
    expect(dstate().code).toMatchObject({ pid: third, every: 7 });
    expect(dstate().keepAlive.inbox).toEqual({ stopped: true });
  }, 60_000);

  it("with no tab to open it refuses and leaves the running one running (RISA-1012)", async () => {
    const holder = spawn("node", [join(root, "holder.mjs"), "--every", "7"], { env, stdio: "ignore" });
    started.push(/** @type {number} */ (holder.pid));
    const end = Date.now() + 10_000;
    while (lockHolder(lock) !== holder.pid && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(lockHolder(lock)).toBe(holder.pid);

    const headless = { ...env, RISA_ITERM_APP: join(root, "no-iTerm.app") };
    const r = spawnSync("node", [join(main, "loops/dispatch.mjs"), "--restart"], {
      cwd: main,
      encoding: "utf8",
      env: headless,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--restart needs iTerm2");
    expect(r.stderr).toContain(`the running one (pid ${holder.pid}) was left running`);
    expect(alive(/** @type {number} */ (holder.pid))).toBe(true);
    expect(lockHolder(lock)).toBe(holder.pid);
    expect(calls("open")).toEqual([]);
    expect(calls("pnpm")).toEqual([]);
  }, 60_000);

  it("with none running it starts one", async () => {
    const r = dispatch(["--restart", "--every", "5"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const now = lockHolder(lock);
    expect(now).toBeTruthy();
    expect(r.stdout.trim()).toMatch(
      new RegExp(`^Restarted the dispatcher: pid none -> ${now}, code \\S+ \\(every 5s\\)\\.$`),
    );
    expect(calls("pnpm")).toEqual(["prd dispatch --every 5"]);
    expect(dstate().code).toMatchObject({ pid: now, every: 5 });
  }, 60_000);
});

describe("the dispatcher logs why it exits (RISA-1037)", () => {
  const files = () => ({ lock, state: join(loops, ".dispatch.json"), log: join(loops, ".dispatch.log") });
  const logText = () => readFileSync(join(loops, ".dispatch.log"), "utf8");
  /** Starts a real dispatcher and waits for it to hold its lock and record its start. */
  const start = async (/** @type {NodeJS.ProcessEnv} */ e = env) => {
    const child = spawn("node", [join(main, "loops/dispatch.mjs"), "--every", "1"], {
      cwd: main,
      env: e,
      stdio: "ignore",
    });
    const exited = new Promise((r) => child.on("exit", (code, sig) => r(code ?? sig)));
    const pid = /** @type {number} */ (child.pid);
    started.push(pid);
    const end = Date.now() + 20_000;
    while (!(lockHolder(lock) === pid && existsSync(files().state) && dstate().code?.pid === pid)) {
      if (Date.now() > end) throw new Error("the dispatcher never started");
      await new Promise((r) => setTimeout(r, 50));
    }
    return { child, pid, exited };
  };
  const status = () => dispatcherPart(files(), { current: () => null });

  it("a dispatcher sent SIGTERM logs it, marks the state stopped and frees its lock", async () => {
    const { child, pid, exited } = await start();
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(logText()).toMatch(/^\S+Z stopped \(SIGTERM\)$/m);
    expect(dstate().stopped).toMatchObject({ pid, why: "SIGTERM" });
    expect(Date.parse(dstate().stopped.stoppedAt)).not.toBeNaN();
    expect(existsSync(lock)).toBe(false);
    expect(status()).toMatch(
      /^DISPATCHER: stopped \(SIGTERM, \d+s ago\): start it in a tab of its own with \S+ prd dispatch\n/,
    );

    // A start clears the mark; --stop's TERM says who sent it.
    const next = await start();
    expect(dstate().stopped).toBeNull();
    expect(dispatch(["--stop"]).stdout).toContain(`Stopped the dispatcher (pid ${next.pid})`);
    expect(await next.exited).toBe(0);
    expect(logText()).toContain("stopped (SIGTERM) by --stop");
    expect(dstate().stopped).toMatchObject({ pid: next.pid, why: "SIGTERM by --stop" });
    expect(dstate().stopRequest).toBeNull();
  }, 60_000);

  it.each([
    ["throw", "uncaught exception"],
    ["reject", "unhandled rejection"],
  ])(
    "a dispatcher that throws (%s) logs the error's first line and marks the state",
    async (how, what) => {
      const pre = join(root, `thrower-${how}.mjs`);
      writeFileSync(pre, THROWER(/** @type {"throw" | "reject"} */ (how)));
      const { pid, exited } = await start({ ...env, NODE_OPTIONS: `--import ${pre}` });
      expect(await exited).toBe(1);
      const why = `${what}: Error: boom from the test`;
      expect(logText()).toMatch(new RegExp(`^\\S+Z stopped \\(${why}\\)$`, "m"));
      expect(logText()).not.toContain("second line");
      expect(dstate().stopped).toMatchObject({ pid, why });
      expect(existsSync(lock)).toBe(false);
      expect(status()).toMatch(new RegExp(`^DISPATCHER: stopped \\(${why}, \\d+s ago\\)`));
    },
    60_000,
  );

  it("one whose lock is removed ends, saying it lost it", async () => {
    const { pid, exited } = await start();
    rmSync(lock);
    expect(await exited).toBe(1);
    expect(logText()).toContain("stopped (lost its lock (the lock file is gone))");
    expect(dstate().stopped).toMatchObject({ pid, why: "lost its lock (the lock file is gone)" });
  }, 60_000);

  it("a SIGKILLed one leaves its lock and no mark: status reads dead", async () => {
    const { child, pid, exited } = await start();
    child.kill("SIGKILL");
    expect(await exited).toBe("SIGKILL");
    expect(dstate().stopped).toBeNull();
    expect(logText()).not.toMatch(/stopped \(/);
    expect(status()).toMatch(new RegExp(`^DISPATCHER: dead \\(pid ${pid} gone; .*no clean stop\\)`));
    // A mark of another pid is no mark of this one's.
    writeFileSync(
      files().state,
      JSON.stringify({ stopped: { pid: pid + 1, stoppedAt: new Date().toISOString(), why: "SIGTERM" } }),
    );
    expect(status()).toMatch(/^DISPATCHER: dead /);
    rmSync(lock);
    expect(status()).toMatch(/^DISPATCHER: stopped \(SIGTERM, \d+s ago\)/);
  }, 60_000);
});
