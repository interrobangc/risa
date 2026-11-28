// The throwaway repo recover*.test.mjs share (`pnpm prd recover` and `pnpm prd down`:
// recover.sh, down.sh, recover-lib.mjs, inventory-facts.mjs, inventory.mjs): these
// scripts copied in, real git worktrees (a PRD, its slices, a planner), slot leases,
// the sample project's stub stack hook (its state and calls shared with the fakes),
// and fake lsof, open, sleep, claude, nvm and osascript (with RISA_ITERM_APP a folder
// here): nothing touches real containers, servers, slots, sessions, tabs, asks or
// worktrees. The dispatcher is a node process that only sleeps, its pid in the lock;
// the fake tab for it starts one (a minute at most). The fakes keep their state
// (running projects, listening ports) in FAKE_STATE. A describe group calls
// useRecoverRepo() once: the repo is built before its first test and removed after
// its last; the calls log is cleared before each test.
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { stubHookConfig } from "./config-fixture.mjs";
import { loadConfig } from "./config.mjs";
import { displayName } from "./session-names.mjs";

/** The recovery agent's Remote Control name as session.sh shows it (session-names.mjs). */
export const RECOVER = displayName({
  name: "recover",
  kind: "recovery",
  remote: "recover",
  project: loadConfig().config.name,
});

const HERE = new URL(".", import.meta.url).pathname;
export const git = (cwd, ...a) =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
export const DEAD_PID = "999999"; // above macOS's and Linux's default pid_max

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

export let root, main, loops, log, env, state;
export const recover = (args = [], extra = {}) =>
  spawnSync("bash", [join(main, "loops/prd.sh"), "recover", ...args], {
    cwd: main,
    encoding: "utf8",
    env: { ...env, ...extra },
  });
export const okRecover = (args, extra) => {
  const r = recover(args, extra);
  if (r.status !== 0) throw new Error(`recover ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};
export const json = (extra) => JSON.parse(okRecover(["--dry-run", "--json"], extra));
export const steps = (inv) => inv.actions.map((a) => (a.target ? `${a.step} ${a.target}` : a.step));
export const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
/** Write or remove one of the stub hook's and the fakes' state files. */
export const put = (file, text) => writeFileSync(join(state, file), text);
export const drop = (...files) => {
  for (const f of files) rmSync(join(state, f), { force: true });
};

/** Every path under DIR with its size and mtime (and a directory's entries). */
export function snapshot(dir, out = new Map()) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (p === log || p === state) continue; // the fakes' own bookkeeping
    const st = lstatSync(p);
    out.set(p, `${st.isDirectory() ? "d" : "f"} ${st.size} ${st.mtimeMs}`);
    if (st.isDirectory()) snapshot(p, out);
  }
  return out;
}

export const worktree = (name, branch, from) =>
  git(main, "worktree", "add", "-q", "-b", branch, join(loops, name), from);
export const stackEnv = (name, slot) => {
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
export const endDispatchers = () => {
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
/** The throwaway repo, built once per describe group: call at the top of each. */
export const useRecoverRepo = () => {
  beforeAll(build, BUILD_MS);
  afterAll(() => {
    endDispatchers();
    rmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => rmSync(log, { force: true }));
};
