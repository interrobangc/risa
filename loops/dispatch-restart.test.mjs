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
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** @type {number[]} */
let started = [];
beforeEach(() => {
  rmSync(state, { recursive: true, force: true });
  mkdirSync(state, { recursive: true });
  rmSync(loops, { recursive: true, force: true });
  mkdirSync(loops, { recursive: true });
  started = [];
});
afterEach(() => {
  // The new dispatcher runs detached: end whatever holds the lock.
  const pid = lockHolder(lock);
  for (const p of [...started, ...(pid ? [pid] : [])])
    try {
      process.kill(p, "SIGTERM");
    } catch {
      /* gone */
    }
});

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
