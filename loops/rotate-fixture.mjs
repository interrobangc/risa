// The throwaway repo rotation's tests share (rotate*.test.mjs, rm-done.test.mjs):
// rotate.sh, rotate-into.sh, rotate.mjs, every other script and the backlog
// tool copied in, a stub claude (RISA_CLAUDE_BIN, named claude-stub so no walk
// up finds a real claude), RISA_ITERM_APP pointing nowhere (the opener prints
// its command) and the stack hooks on the sample project's stub
// (config-fixture.mjs's stubHookConfig). Nothing here starts a real claude,
// opens a tab or signals a process it didn't start. A test file calls
// useRotateRepo() once: the repo is the file's own, the state and sessions
// each test's.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
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
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import { loadConfig } from "./config.mjs";
import { namesOf } from "./flavor.mjs";
import { fixtureTierData, stubHookConfig } from "./config-fixture.mjs";
import { displayName } from "./session-names.mjs";
import { scaledWait } from "./test-limits.mjs";

/** The main backlog session's pool: the starfleet admirals (flavor.mjs). */
export const ADMIRALS = namesOf("backlog");
/** The name session.sh shows claude for a session (session-names.mjs). */
export const shown = (name, kind, remote) =>
  displayName({ name, kind, remote, project: loadConfig().config.name });

const HERE = new URL(".", import.meta.url).pathname;
export const git = (cwd, ...a) =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();

export const plan = (rows, mode = "ask before each landing") => `# Plan: W

## Status

**Landing mode: ${mode}.**

| Slice | Wave | State | Merge |
| ----- | ---- | ----- | ----- |
${rows}

## Slice 1: One

Stack: no · Reads: none · Tests: unit
`;
export const MERGED = "| 1 | 1 | merged (opus) | abc |\n| 2 | 1 | **landed** in `dev` | def |";

// The stub: records its pid, args and the record it sees at start, then
// behaves as STUB_MODE says.
const STUB = `#!/usr/bin/env bash
mkdir -p "$STUB_STATE"
echo "$$" > "$STUB_STATE/pid"
printf '%s\\n' "$@" > "$STUB_STATE/args"
[[ -z \${STUB_NAME:-} ]] || cat "$RISA_SESSIONS_DIR/$STUB_NAME.json" > "$STUB_STATE/record-at-start" 2>/dev/null || true
case \${STUB_MODE:-exit} in
  exit) exit 0 ;;
  wait)
    trap 'cat "$RISA_SESSIONS_DIR/$STUB_NAME.json" > "$STUB_STATE/record-at-term"; exit 143' TERM
    touch "$STUB_STATE/ready"; for i in $(seq 200); do sleep 0.1; done ;;
  stubborn) trap '' TERM; touch "$STUB_STATE/ready"; for i in $(seq 200); do sleep 0.1; done ;;
  rotate) bash "$PRD_SH" rotate > "$STUB_STATE/rotate.out" 2>&1; echo "$?" > "$STUB_STATE/rotate.code" ;;
  self)
    trap 'cat "$RISA_SESSIONS_DIR/$STUB_NAME.json" > "$STUB_STATE/record-at-term" 2>/dev/null; exit 143' TERM
    bash "$PRD_SH" rotate --self \${STUB_ARGS:-} > "$STUB_STATE/rotate.out" 2>&1; echo "$?" > "$STUB_STATE/rotate.code"
    [[ -n \${STUB_STAY:-} ]] || exit 0
    touch "$STUB_STATE/ready"; for i in $(seq 200); do sleep 0.1; done ;;
esac
`;

// A stand-in osascript (`osascript - <line> <title> <0|1>`) for --self's tab (with RISA_ITERM_APP at a folder that exists): FAKE_TAB
// none opens a tab where nothing runs; run runs its line there (after removing FAKE_RM); rotating
// marks the record rotating a moment later, as rotate-into's first step does.
const FAKE_OSASCRIPT = `#!/usr/bin/env bash
cat > /dev/null
case \${FAKE_TAB:-none} in
  run) [[ -z \${FAKE_RM:-} ]] || rm -f "$FAKE_RM"; STUB_MODE=exit bash -c "$2" > "$STUB_STATE/tab.out" 2>&1 || true ;;
  rotating) (sleep 0.3; node "$SESSIONS_MJS" set "$STUB_NAME" rotating=true) > /dev/null 2>&1 & ;;
esac
`;

export let root, main, loops, sessions, state, stub, env, wt, tabEnv;
export const scripts = (f) => join(main, "loops", f);
export const record = (name) => JSON.parse(readFileSync(join(sessions, `${name}.json`), "utf8"));
export const stubPid = () => Number(readFileSync(join(state, "pid"), "utf8").trim());
export const stateFile = (f) => readFileSync(join(state, f), "utf8");
export const run = (script, args, extra = {}, cwd = main) =>
  spawnSync("bash", [scripts(script), ...args], { cwd, encoding: "utf8", env: { ...env, ...extra } });
export const backlog = (...args) =>
  execFileSync("node", [join(main, "backlog/backlog.mjs"), ...args], {
    cwd: main,
    encoding: "utf8",
    env,
  }).trim();

export function start(cmd, args, extra = {}, cwd = main) {
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
// A wait on a started script, scaled for the load (test-limits.mjs): a busy
// machine starts session.sh slower, not wrongly.
export const until = async (what, ms = 10_000) => {
  const end = Date.now() + scaledWait(ms);
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};
/** A recorded session prd-w, waiting in the worktree. */
export const liveSession = async (extra = {}) => {
  const s = start(
    "bash",
    [
      scripts("session.sh"),
      "prd-w",
      ...(extra.auto ? ["--auto"] : []),
      ...(extra.managed ? ["--managed"] : []),
      "--",
      ...(extra.model ? ["--model", extra.model] : []),
      "x",
    ],
    { STUB_MODE: extra.mode ?? "wait", STUB_NAME: "prd-w" },
    wt,
  );
  await until(() => existsSync(join(state, "ready")));
  return { s, pid: stubPid() };
};
/** The rotate-into.sh line the opener printed. */
export const printedLine = (out) => {
  const lines = out.split("\n");
  const i = lines.findIndex((l) => l.startsWith("iTerm2 isn't here"));
  expect(i).toBeGreaterThanOrEqual(0);
  return lines[i + 1].trim();
};

/** The throwaway repo, built once for the file; each test starts with no stub state and no sessions. */
export function useRotateRepo() {
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "rotate-test-")));
    main = join(root, "repo");
    loops = join(main, ".loops");
    sessions = join(loops, ".sessions");
    state = join(root, "state");
    wt = join(loops, "w");
    const bin = join(root, "bin");
    mkdirSync(bin);
    stub = join(bin, "claude-stub");
    writeFileSync(stub, STUB);
    chmodSync(stub, 0o755);
    const tabBin = join(root, "tab-bin");
    mkdirSync(tabBin);
    writeFileSync(join(tabBin, "osascript"), FAKE_OSASCRIPT);
    chmodSync(join(tabBin, "osascript"), 0o755);
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
    // Every script, not a list: standing-close reads the dispatcher's facts (dispatch.mjs and its imports).
    for (const f of readdirSync(HERE).filter((f) => /\.(mjs|sh)$/.test(f) && !f.includes(".test.")))
      copyFileSync(join(HERE, f), scripts(f));
    cpSync(join(HERE, "prompts"), scripts("prompts"), { recursive: true });
    const backlogDir = join(HERE, "../backlog");
    for (const f of readdirSync(backlogDir).filter((f) => f.endsWith(".mjs") && !f.includes(".test.")))
      copyFileSync(join(backlogDir, f), join(main, "backlog", f));
    const ciDir = join(HERE, "../ci");
    mkdirSync(join(main, "ci"), { recursive: true });
    for (const f of ["outstanding.mjs", "tier-data.mjs"]) copyFileSync(join(ciDir, f), join(main, "ci", f));
    fixtureTierData(main);
    writeFileSync(join(main, ".gitignore"), ".loops/\n");
    // The stack hooks on the sample project's stub: rm.sh's stack down and test-db drop.
    const config = stubHookConfig(main);
    mkdirSync(join(main, "plans"));
    writeFileSync(join(main, "plans/w-plan.md"), plan(`${MERGED}\n| 3 | 2 | not started | |`));
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", "chore: init");
    git(main, "worktree", "add", "-q", "-b", "prd/w", wt, "dev");
    env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TRUNK: "dev",
      RISA_CLAUDE_BIN: stub,
      RISA_ITERM_APP: join(root, "no-iterm"),
      RISA_SESSIONS_DIR: "",
      RISA_ROTATE_WAIT: "",
      // rotate --self's wait for its tab (RISA-1082): short, so no test sits out the 30 s default.
      RISA_ROTATE_START_WAIT: "5",
      BACKLOG_BY: "",
      STUB_STATE: state,
      PRD_SH: scripts("prd.sh"),
      RISA_CONFIG: config,
      SAMPLE_STACK_STATE: join(root, "stack-state"),
    };
    // A tab that opens (the stand-in osascript, FAKE_TAB): for --self's hand-off tests.
    tabEnv = {
      PATH: `${tabBin}:${env.PATH}`,
      RISA_ITERM_APP: join(root, "iTerm.app"),
      SESSIONS_MJS: scripts("sessions.mjs"),
    };
  }, scaledWait(60_000));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => {
    rmSync(state, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  });
}
