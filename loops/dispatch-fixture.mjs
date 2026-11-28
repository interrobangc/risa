// The throwaway repo the dispatcher's tests share (dispatch*.test.mjs): the
// dispatcher and its modules copied in, and stubs for the rest: the worktree
// command (new.sh), the opener (open-session.sh), rm.sh, tidy (tidy-cli.mjs),
// the pickup (prd.sh) and the backlog command (backlog.mjs, its registry rows a
// JSON file), a stub claude (RISA_CLAUDE_BIN), osascript, a load file and a
// clock file; `env` is the environment a tick runs in. A test file calls
// useDispatchRepo() once: the repo is the file's own, and each test starts with
// no worktrees, branches, records, asks or dispatcher state, the clock at T0.
// Nothing here starts a real claude, opens a tab or reads the real load.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import "./config-fixture.mjs";

export const HERE = new URL(".", import.meta.url).pathname;
export const git = (cwd, ...a) =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();

// The stubs. Each records its arguments, one call per line, in $STUB_STATE.
const NEW_SH = `#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/new.calls"
[[ -z \${STUB_NEW_FAIL:-} ]] || { echo "no room" >&2; exit 1; }
if [[ -n \${STUB_NEW_MAKE:-} ]]; then
  if [[ $1 == plan ]]; then name=plan-$2; else name=$2; fi
  git worktree add -q -b "$1/$2" ".loops/$name" dev
fi
[[ -z \${STUB_NEW_FAIL_AFTER:-} ]] || { echo "migrate failed" >&2; exit 1; }
echo "made $2"
`;
// rm.sh: removes the worktree and its session record, as the real one does.
const RM_SH = `#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/rm.calls"
if [[ $1 == plan-* ]]; then session=$1; else session=prd-$1; fi
git worktree remove --force ".loops/$1"
rm -f ".loops/.sessions/$session.json"
echo "removed $1"
`;
const OPEN_SH = `#!/usr/bin/env bash
printf '%s\\x1f' "$@" >> "$STUB_STATE/open.calls"; echo >> "$STUB_STATE/open.calls"
if [[ -n \${STUB_OPEN_FAIL:-} && " $* " == *" $STUB_OPEN_FAIL "* ]]; then echo "no tab" >&2; exit 1; fi
echo "Opened in a new background iTerm2 tab."
`;
const TIDY = `import { appendFileSync } from "node:fs";
appendFileSync(process.env.STUB_STATE + "/tidy.calls", process.argv.slice(2).join(" ") + "\\n");
console.log("removed 0 safe ones");
`;
// The backlog: prd list --json prints the rows file; prd set writes flags into it.
const BACKLOG = `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const file = process.env.STUB_ROWS;
const [a, b, topic, ...kv] = process.argv.slice(2);
if (a === "prd" && b === "list") console.log(readFileSync(file, "utf8"));
else if (a === "prd" && b === "set") {
  appendFileSync(process.env.STUB_STATE + "/backlog.calls", ["prd set", topic, ...kv].join(" ") + "\\n");
  if (process.env.STUB_BACKLOG_FAIL) {
    console.error("registry locked");
    process.exit(1);
  }
  const rows = JSON.parse(readFileSync(file, "utf8"));
  const row = rows.find((r) => r.topic === topic);
  for (const w of kv) {
    if (w.startsWith("flags=")) row.flags = w.slice(6).split(",").filter(Boolean);
    if (w.startsWith("flags+=")) row.flags = [...new Set([...(row.flags ?? []), ...w.slice(7).split(",")])];
  }
  writeFileSync(file, JSON.stringify(rows));
} else process.exit(2);
`;

// The pickup: `prd.sh dev-sync <why>`, recorded; STUB_PICKUP says how it ends.
const PRD_SH = `#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/prd.calls"
case \${STUB_PICKUP:-same} in
  same) echo "dev-sync: dev already has origin/dev" ;;
  moved) echo "dev-sync: fast-forwarded dev to abc1234" ;;
  refused) echo "dev-sync: the main checkout is in the middle of a merge, rebase or cherry-pick (MERGE_HEAD)" >&2; exit 1 ;;
esac
`;

export let root, main, loops, sessions, asks, state, env, clock, rowsFile, inboxDir, claudeConfig;
export const scripts = (f) => join(main, "loops", f);
export const calls = (f) => {
  const p = join(state, `${f}.calls`);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
};
export const openCalls = () => calls("open").map((l) => l.split("\x1f").filter(Boolean));
export const dispatch = (args = ["--once"], extra = {}) =>
  spawnSync("node", [scripts("dispatch.mjs"), ...args], {
    cwd: main,
    encoding: "utf8",
    env: { ...env, ...extra },
  });
export const ok = (args, extra) => {
  const r = dispatch(args, extra);
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  return r.stdout;
};
export const dstate = () => JSON.parse(readFileSync(join(loops, ".dispatch.json"), "utf8"));
export const logText = () => readFileSync(join(loops, ".dispatch.log"), "utf8");
export const setRows = (rows) =>
  writeFileSync(
    rowsFile,
    JSON.stringify(rows.map((r) => ({ flags: [], after: [], hot: [], waiting: 0, notes: "", ...r }))),
  );
export const setClock = (secs) => writeFileSync(clock, String(secs));
export const T0 = 1_800_000_000;
/** A managed record whose pid is long gone: a dead session. */
export const deadRecord = (name, extra = {}) => {
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    join(sessions, `${name}.json`),
    JSON.stringify({
      pid: 999_999,
      started: "2026-01-01T00:00:00Z",
      ended: "2026-01-01T01:00:00Z",
      managed: true,
      ...extra,
    }),
  );
};
export const worktree = (name, branch) => {
  if (!existsSync(join(loops, name)))
    git(main, "worktree", "add", "-q", "-b", branch, join(loops, name), "dev");
};
export const answer = (id, text) =>
  execFileSync("node", [scripts("ask.mjs"), "answer", id, text], {
    env: { ...env, RISA_ASKS_DIR: asks },
    encoding: "utf8",
  });
export const askFile = (id) => JSON.parse(readFileSync(join(asks, `${id}.json`), "utf8"));
export const until = async (what, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};

/** The file's throwaway repo: call once at the top of a test file. */
export function useDispatchRepo() {
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-test-")));
    main = join(root, "repo");
    loops = join(main, ".loops");
    sessions = join(loops, ".sessions");
    asks = join(loops, ".asks");
    state = join(root, "state");
    clock = join(root, "clock");
    rowsFile = join(root, "rows.json");
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude-stub"), "#!/usr/bin/env bash\nexit 0\n");
    writeFileSync(join(bin, "osascript"), "#!/bin/sh\nexit 0\n");
    for (const f of ["claude-stub", "osascript"]) chmodSync(join(bin, f), 0o755);
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
    for (const f of [
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
    ])
      copyFileSync(join(HERE, f), scripts(f));
    writeFileSync(scripts("new.sh"), NEW_SH);
    writeFileSync(scripts("open-session.sh"), OPEN_SH);
    writeFileSync(scripts("rm.sh"), RM_SH);
    writeFileSync(scripts("tidy-cli.mjs"), TIDY);
    writeFileSync(scripts("prd.sh"), PRD_SH);
    writeFileSync(join(main, "backlog/backlog.mjs"), BACKLOG);
    for (const f of ["registry.mjs", "format.mjs"])
      copyFileSync(join(HERE, "../backlog", f), join(main, "backlog", f));
    writeFileSync(join(main, ".gitignore"), ".loops/\n");
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", "chore: init");
    // .loops/ there from the start, as the earlier tests in one file once left it:
    // a file's first test may write its lock or state directly.
    mkdirSync(loops, { recursive: true });
    writeFileSync(join(root, "load"), "1 1 1");
    inboxDir = join(root, "home/.risa/inbox");
    claudeConfig = join(root, "claude.json");
    env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RISA_CLAUDE_BIN: join(bin, "claude-stub"),
      RISA_ITERM_APP: join(root, "iTerm.app"),
      RISA_SESSIONS_DIR: "",
      RISA_ASKS_DIR: "",
      RISA_ASK_NOTIFY: "",
      RISA_REQUESTS_DIR: "",
      RISA_NOTICES_DIR: "",
      RISA_MAX_BACKLOG_SESSIONS: "",
      RISA_LOAD_FILE: join(root, "load"),
      RISA_LOAD_BUSY: "8",
      RISA_LOAD_GATE: "",
      RISA_MAX_PRDS: "",
      RISA_MAX_PLANNERS: "",
      RISA_FIXES_MIN: "",
      RISA_CLOCK_FILE: clock,
      // Off unless a test turns it on, and never the machine's real processes.
      RISA_KEEP_SESSIONS: "off",
      RISA_PROCESS_FILE: join(root, "processes"),
      // The drain: off unless a test turns it on; never the machine's own readings or landings.
      RISA_USAGE_WATCH: "off",
      RISA_USAGE_DIR: "",
      RISA_USAGE_DRAIN: "",
      RISA_USAGE_STOP: "",
      RISA_USAGE_STALE_MIN: "",
      RISA_LANDING_DIR: "",
      // Off unless a test turns it on; never the machine's own inbox folder or Claude Code files.
      RISA_PICKUP_EVERY: "off",
      RISA_INBOX_DIR: inboxDir,
      RISA_CLAUDE_PROJECTS: join(root, "projects"),
      RISA_CLAUDE_CONFIG: claudeConfig,
      STUB_STATE: state,
      STUB_ROWS: rowsFile,
    };
  }, 60_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => {
    for (const d of [state, sessions, asks, join(loops, ".requests"), join(loops, ".notices")])
      rmSync(d, { recursive: true, force: true });
    for (const f of [".dispatch.json", ".dispatch.log", ".dispatch.lock", ".prd-cap"])
      rmSync(join(loops, f), { force: true });
    for (const w of existsSync(loops) ? readdirSync(loops) : [])
      if (!w.startsWith(".")) git(main, "worktree", "remove", "--force", join(loops, w));
    for (const b of git(main, "branch", "--format=%(refname:short)").split("\n"))
      if (b && b !== "dev") git(main, "branch", "-q", "-D", b);
    mkdirSync(state, { recursive: true });
    setClock(T0);
    setRows([]);
    writeFileSync(join(root, "processes"), "");
    rmSync(join(root, "home"), { recursive: true, force: true });
    rmSync(claudeConfig, { force: true });
  });
}
