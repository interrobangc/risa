// `pnpm prd recover` and `pnpm prd down` (recover.sh, down.sh, recover-lib.mjs,
// inventory-facts.mjs, inventory.mjs) against a throwaway repo with these
// scripts copied in, real git worktrees, and fake docker, lsof, open, sleep,
// claude, pnpm, nvm, osascript (with CARETOOK_ITERM_APP a folder here) and serve.sh:
// nothing here touches real containers, servers, slots, sessions, tabs or worktrees,
// and the dry run must change nothing on disk. The dispatcher is a node process that
// only sleeps, its pid in the lock.
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

const HERE = new URL(".", import.meta.url).pathname;
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
const DEAD_PID = "999999"; // above macOS's and Linux's default pid_max

// Projects in FAKE_RUNNING or $FAKE_STATE/running have a running container; every
// caretook-loop* project has a stopped one. `compose up|stop|down` change the
// state. Each call is logged, marked when the down record already exists.
const MARK = `rec=""; [[ -f $FAKE_RECORD ]] && rec=" (record)"`;
const FAKE_DOCKER = `#!/usr/bin/env bash
${MARK}
echo "docker $*$rec" >> "$FAKE_LOG"
st=$FAKE_STATE; touch "$st/running"
is_running() { [[ " \${FAKE_RUNNING:-} " == *" $1 "* ]] || grep -qx "$1" "$st/running"; }
countdown() { local n; n=$(cat "$st/$1" 2>/dev/null || echo 0); ((n > 0)) || return 1; echo $((n - 1)) > "$st/$1"; }
case $1 in
  info)
    if [[ -n \${FAKE_DOCKER_DOWN:-} ]]; then
      [[ -f $st/docker-started ]] || exit 1
      countdown boot && exit 1
    fi ;;
  ps)
    proj=$(printf '%s\\n' "$@" | sed -n 's/^label=com.docker.compose.project=//p')
    if is_running "$proj"; then echo "id-$proj"
    elif [[ "$*" == *-aq* && $proj == caretook-loop* ]]; then echo "id-$proj"; fi ;;
  inspect) echo "false 2026-11-19T10:00:00.000Z" ;;
  compose)
    shift; proj="" file=0
    while (($#)); do case $1 in -p) proj=$2; shift 2 ;; -f) file=1; shift 2 ;; *) break ;; esac; done
    [[ -z $proj && $file == 1 ]] && proj=\${CARETOOK_SHARED_TEST_PROJECT:-}
    [[ -n $proj ]] || proj=$(sed -n 's/^CARETOOK_STACK=//p' .env 2>/dev/null)
    echo "compose $1 $proj$rec" >> "$FAKE_LOG"
    case $1 in
      up | start) is_running "$proj" || echo "$proj" >> "$st/running" ;;
      stop | down) grep -vx "$proj" "$st/running" > "$st/r" || true; mv "$st/r" "$st/running" ;;
    esac ;;
  exec) countdown pg-slow && exit 1 ;;
  *) exit 3 ;;
esac
exit 0
`;
const FAKE_LSOF = `#!/usr/bin/env bash
echo "lsof $*" >> "$FAKE_LOG"
for p in \${FAKE_LISTEN:-} $(cat "$FAKE_STATE/listen" 2>/dev/null); do [[ "$*" == *"TCP:$p "* ]] && { echo 4242; exit 0; }; done
exit 1
`;

const FAKE_SERVE = `#!/usr/bin/env bash
${MARK}
echo "serve $*$rec" >> "$FAKE_LOG"
port=$(sed -n 's/^WEB_PORT=//p' "$(dirname "$0")/../../.loops/$1/apps/web/.env")
touch "$FAKE_STATE/listen"
if [[ \${2:-} == --stop ]]; then grep -vx "$port" "$FAKE_STATE/listen" > "$FAKE_STATE/l" || true; mv "$FAKE_STATE/l" "$FAKE_STATE/listen"
else echo "$port" >> "$FAKE_STATE/listen"; echo "$1 is running at http://localhost:$port"; fi
`;
const FAKES = {
  // The opener's tab: logs its title, and keeps the line the tab would run.
  osascript: `#!/usr/bin/env bash
cat >/dev/null
echo "osascript $3" >> "$FAKE_LOG"; printf '%s\\n' "$2" > "$FAKE_STATE/tab-line"
`,
  open: `#!/usr/bin/env bash
echo "open $*" >> "$FAKE_LOG"; touch "$FAKE_STATE/docker-started"
`,
  // A fake clock: with CARETOOK_CLOCK_FILE, sleeping moves it on.
  sleep: `#!/usr/bin/env bash
echo "sleep $*" >> "$FAKE_LOG"
[[ -z \${CARETOOK_CLOCK_FILE:-} ]] || echo $(($(cat "$CARETOOK_CLOCK_FILE") + \${1%.*})) > "$CARETOOK_CLOCK_FILE"
`,
  // The recovery agent (--remote-control): logs one line and records its cwd and
  // args, one per line, in $FAKE_STATE/agent-args. A probe (-p) fails
  // $FAKE_STATE/claude-fails times, then answers.
  claude: `#!/usr/bin/env bash
if [[ $1 == --remote-control ]]; then
  echo "claude --remote-control $2 (agent)" >> "$FAKE_LOG"
  printf '%s\\n' "$PWD" "$@" > "$FAKE_STATE/agent-args"
  exit 0
fi
echo "claude $*" >> "$FAKE_LOG"
n=$(cat "$FAKE_STATE/claude-fails" 2>/dev/null || echo 0)
((n > 0)) && { echo $((n - 1)) > "$FAKE_STATE/claude-fails"; exit 1; }
exit 0
`,
  // Fails once for each worktree named in $FAKE_STATE/migrate-fail.
  pnpm: `#!/usr/bin/env bash
w=$(basename "$PWD")
echo "pnpm $* [$w]" >> "$FAKE_LOG"
if grep -qx "$w" "$FAKE_STATE/migrate-fail" 2>/dev/null; then
  grep -vx "$w" "$FAKE_STATE/migrate-fail" > "$FAKE_STATE/m" || true; mv "$FAKE_STATE/m" "$FAKE_STATE/migrate-fail"; exit 1
fi
`,
};

let root, main, loops, log, env, state;
const recover = (args = [], extra = {}) =>
  spawnSync("bash", [join(main, "scripts/loops/prd.sh"), "recover", ...args], {
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
  writeFileSync(join(dir, ".env"), `CARETOOK_STACK=caretook-loop${slot}\n`);
  mkdirSync(join(dir, "apps/web"), { recursive: true });
  writeFileSync(join(dir, "apps/web/.env"), `BETTER_AUTH_URL="x"\nWEB_PORT=6${slot}73\n`);
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
  const fakes = { docker: FAKE_DOCKER, lsof: FAKE_LSOF, ...FAKES };
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
    FAKE_RECORD: join(root, "repo/.loops/.down.json"),
    NVM_DIR: join(root, "nvm"),
    TZ: "UTC",
    TRUNK: "dev",
    CARETOOK_FREE_GB: "50",
    CARETOOK_MIN_FREE_GB: "",
    CARETOOK_LEASE_ROOT: "",
    CARETOOK_SHARED_TEST_PROJECT: "",
    CARETOOK_CLOCK_FILE: "",
    CARETOOK_ITERM_APP: join(root, "iTerm.app"),
    CARETOOK_SESSIONS_DIR: "",
    CARETOOK_LANDING_DIR: "",
    CARETOOK_ASKS_DIR: "",
  };
  mkdirSync(join(root, "iTerm.app"));
  for (const k of [
    "CARETOOK_RECOVER_PROBE_SECS",
    "CARETOOK_DOCKER_WAIT_SECS",
    "CARETOOK_RECOVER_PG_SECS",
    "CARETOOK_RECOVER_STEP_SECS",
  ])
    delete env[k];

  execFileSync("git", ["init", "-q", "-b", "dev", main]);
  for (const [k, v] of [
    ["user.email", "test@example.com"],
    ["user.name", "Test"],
    ["commit.gpgsign", "false"],
  ])
    git(main, "config", k, v);
  mkdirSync(join(main, "scripts/loops"), { recursive: true });
  for (const f of readdirSync(HERE).filter((f) => f.endsWith(".sh") || f.endsWith(".mjs")))
    copyFileSync(join(HERE, f), join(main, "scripts/loops", f));
  cpSync(join(HERE, "prompts"), join(main, "scripts/loops/prompts"), { recursive: true });
  mkdirSync(join(main, "scripts/backlog"));
  for (const f of ["registry.mjs", "format.mjs"])
    copyFileSync(join(HERE, "../backlog", f), join(main, "scripts/backlog", f));
  writeFileSync(join(main, "scripts/loops/serve.sh"), FAKE_SERVE);
  writeFileSync(join(main, ".gitignore"), ".loops/\n.env\n.env.*\n");
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
const fresh = () => {
  beforeAll(build, BUILD_MS);
  afterAll(() => rmSync(root, { recursive: true, force: true }));
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

  it("with Docker down, starts it first", () => {
    const inv = json({ FAKE_DOCKER_DOWN: "1" });
    expect(steps(inv)[0]).toBe("docker start");
    expect(calls()).not.toMatch(/docker ps/);
  });

  it("with everything up, has only gc offers and sessions besides the locks", () => {
    const inv = json({
      FAKE_RUNNING: "caretook-loop1 caretook-loop2 caretook-shared-test",
      FAKE_LISTEN: "6173",
    });
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
    const backlogLock = join(main, ".git", "caretook-backlog.lock");
    writeFileSync(lock, `${process.pid}\n`);
    mkdirSync(backlogLock);
    try {
      let inv = json();
      expect(inv.locks.live.map((l) => l.kind)).toEqual(expect.arrayContaining(["dispatch", "backlog"]));
      expect(steps(inv)).not.toContain(`clear-lock ${lock}`);
      expect(steps(inv)).not.toContain("dispatch");
      expect(inv.dispatcher).toEqual({ running: true, pid: process.pid, reopen: false });
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
      expect(inv.dispatcher).toEqual({ running: false, pid: null, reopen: true });
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
    const inv = json({ CARETOOK_FREE_GB: "3", CARETOOK_MIN_FREE_GB: "5" });
    expect(inv.disk).toEqual({ freeGb: 3, minGb: 5, low: true });
    expect(okRecover(["--dry-run"], { CARETOOK_FREE_GB: "3" })).toMatch(
      /disk: 3 GB free \(line: 10 GB\) · LOW/,
    );
  });

  it("changes nothing on disk, and only asks docker and lsof", () => {
    const before = snapshot(root);
    const text = okRecover(["--dry-run"]);
    expect(text).toMatch(/^NAME\s+CLASS/);
    expect(text).toMatch(/ 2\. test-db up/);
    expect(text).toMatch(/Dry run: nothing was changed\.$/m);
    okRecover(["--dry-run", "--json"]);
    expect(snapshot(root)).toEqual(before);
    const docker = calls()
      .split("\n")
      .filter((l) => l.startsWith("docker "))
      .map((l) => l.split(" ")[1]);
    expect(new Set(docker)).toEqual(new Set(["info", "ps", "inspect"]));
    expect(calls()).not.toMatch(/^(claude|osascript|open) /m);
    expect(existsSync(join(state, "agent-args"))).toBe(false);
  });

  it("refuses unknown options, a bad time, and waiting in a dry run", () => {
    expect(recover(["--bogus"]).stderr).toMatch(/unknown option --bogus/);
    expect(recover(["--at", "25:00"]).stderr).toMatch(/24-hour time/);
    expect(recover(["--dry-run", "--wait"]).stderr).toMatch(/doesn't wait/);
    expect(calls()).not.toMatch(/compose|serve|sleep/);
  });

  it("lists recover and down in pnpm prd help", () => {
    const r = spawnSync("bash", [join(main, "scripts/loops/prd.sh"), "help"], { encoding: "utf8", env });
    expect(r.stdout).toMatch(/recover \[--at HH:MM\] \[--wait\]/);
    expect(r.stdout).toMatch(/recover --dry-run \[--json\]/);
    expect(r.stdout).toMatch(/^ {4}down {2,}before a planned restart/m);
    expect(r.stdout).toMatch(/\[--no-agent\]/);
    expect(r.stdout).toMatch(/claude --remote-control recover/);
    expect(r.stdout).toMatch(/^ {4}open <name> \[--print\] {2,}reopen/m);
  });
});

describe("down and recover", () => {
  fresh();
  const record = () => join(loops, ".down.json");
  const put = (file, text) => writeFileSync(join(state, file), text);
  // Everything recovery or down does to the machine, in order (not the read-only probes).
  // `marked` keeps the " (record)" mark: the record existed when the call was made.
  const effects = (marked = false) =>
    calls()
      .split("\n")
      .filter((l) => /^(compose|serve|pnpm|open|osascript|claude) /.test(l))
      .map((l) => (marked ? l : l.replace(/ \(record\)$/, "")));
  const down = (extra = {}) => {
    const r = spawnSync("bash", [join(main, "scripts/loops/prd.sh"), "down"], {
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
  };

  it("down writes the record first, then stops servers, stacks and the test Postgres", () => {
    // Up: t (prd), t-1 (merged) and t-2 (active) stacks, t's and t-2's servers, the test Postgres.
    put("running", "caretook-loop1\ncaretook-loop2\ncaretook-loop3\ncaretook-shared-test\n");
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
      "compose stop caretook-loop1 (record)",
      "compose stop caretook-loop3 (record)",
      "compose stop caretook-loop2 (record)",
      "compose down caretook-shared-test (record)",
    ]);
    expect(readFileSync(join(state, "running"), "utf8")).toBe("");
    expect(readFileSync(join(state, "listen"), "utf8")).toBe("");
    expect(out).toMatch(/stopped stack t-2 \(caretook-loop2, data kept\)/);
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
    put("migrate-fail", "t-2\n");
    put("pg-slow", "2");
    const out = okRecover([]);
    expect(effects()).toEqual([
      "compose up caretook-shared-test",
      "compose up caretook-loop1",
      "pnpm -s datastore:migrate [t]",
      "compose up caretook-loop3",
      "pnpm -s datastore:migrate [t-1]",
      "compose up caretook-loop2",
      "pnpm -s datastore:migrate [t-2]",
      "pnpm -s datastore:migrate [t-2]",
      "serve t",
      "serve t-2",
      "claude --remote-control recover (agent)",
    ]);
    expect(out).toMatch(/migrate failed; retrying once/);
    // It waited for t's Postgres (two refusals) before migrating.
    expect(calls().match(/^docker exec caretook-loop1-postgres-1 pg_isready/gm)).toHaveLength(3);
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
    expect(calls()).not.toMatch(/^docker (compose|exec)/m);
    expect(out).toMatch(/Sessions to carry on or reopen/);
    expect(out).toMatch(/--no-agent: to message and reopen them/);
    expect(existsSync(join(state, "agent-args"))).toBe(false);
  });

  it("doesn't open the agent when something didn't recover", () => {
    allDown();
    put("pg-slow", "1"); // t's Postgres refuses once, with no time left to wait
    rmSync(join(state, "agent-args"), { force: true });
    const r = recover([], { CARETOOK_RECOVER_PG_SECS: "0" });
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
    expect(effects()).toEqual([
      "compose up caretook-shared-test",
      "compose up caretook-loop1",
      "pnpm -s datastore:migrate [t]",
      "compose up caretook-loop2",
      "pnpm -s datastore:migrate [t-2]",
      "serve t",
    ]);
  });

  it("starts Docker Desktop when it isn't running and waits for it", () => {
    allDown();
    put("boot", "2"); // docker info fails twice more after open
    const out = okRecover([], { FAKE_DOCKER_DOWN: "1" });
    expect(out).toMatch(/Docker isn't running: starting Docker Desktop/);
    const lines = calls().split("\n");
    const opened = lines.indexOf("open -a Docker");
    expect(opened).toBeGreaterThanOrEqual(0);
    const after = lines.slice(opened);
    expect(after.filter((l) => l === "sleep 2")).toHaveLength(2);
    expect(after.indexOf("compose up caretook-shared-test")).toBeGreaterThan(after.lastIndexOf("sleep 2"));
    expect(effects()).toContain("compose up caretook-loop2");
  });

  it("gives up when Docker never answers", () => {
    rmSync(join(state, "docker-started"));
    put("boot", "1000");
    const clock = join(state, "clock");
    put("clock", "1000000");
    const r = recover([], {
      FAKE_DOCKER_DOWN: "1",
      CARETOOK_CLOCK_FILE: clock,
      CARETOOK_DOCKER_WAIT_SECS: "10",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Docker didn't answer within 10s/);
    expect(effects().filter((l) => l.startsWith("compose"))).toEqual([]);
  });

  it("--at sleeps until that time, then recovers", () => {
    allDown();
    const clock = join(state, "clock");
    put("clock", String(Date.UTC(2026, 10, 19, 12, 0, 0) / 1000)); // 12:00 UTC
    const out = okRecover(["--at", "15:00"], { CARETOOK_CLOCK_FILE: clock });
    expect(out).toMatch(/Waiting until 15:00 \(in 3h00m\)/);
    const lines = calls().split("\n");
    const slept = lines.filter((l) => l.startsWith("sleep ")).map((l) => Number(l.split(" ")[1]));
    expect(slept.reduce((a, b) => a + b, 0)).toBe(3 * 3600);
    expect(Math.max(...slept)).toBeLessThanOrEqual(300);
    const lastSleep = lines.findLastIndex((l) => l.startsWith("sleep "));
    expect(lines.indexOf("compose up caretook-shared-test")).toBeGreaterThan(lastSleep);
  });

  // A wait of most of a day in 300 s steps is 258 fake sleeps, each a process or
  // two: about 3 s idle and past the 20 s test timeout under load (B-418). The
  // step test above keeps 300 s; these take 6 h steps, so they stay a handful.
  const slept = () =>
    calls()
      .split("\n")
      .filter((l) => l.startsWith("sleep "))
      .map((l) => Number(l.split(" ")[1]));
  const STEP = { CARETOOK_RECOVER_STEP_SECS: String(6 * 3600) };

  it("--at a time that has passed waits until tomorrow", () => {
    const clock = join(state, "clock");
    put("clock", String(Date.UTC(2026, 10, 19, 12, 0, 0) / 1000));
    const out = okRecover(["--at=09:30"], { ...STEP, CARETOOK_CLOCK_FILE: clock });
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
      CARETOOK_CLOCK_FILE: clock,
    });
    expect(out).toMatch(/Waiting until 03:30 \(in 23h30m\)/);
    expect(Number(readFileSync(clock, "utf8"))).toBe(Date.UTC(2026, 10, 20, 11, 30, 0) / 1000);
    expect(slept().reduce((a, b) => a + b, 0)).toBe(23.5 * 3600);
  });

  it("refuses a step that isn't a whole number of seconds", () => {
    put("clock", String(Date.UTC(2026, 10, 19, 12, 0, 0) / 1000));
    const r = recover(["--at", "13:00"], {
      CARETOOK_RECOVER_STEP_SECS: "0",
      CARETOOK_CLOCK_FILE: join(state, "clock"),
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/CARETOOK_RECOVER_STEP_SECS must be a whole number/);
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
      .filter((l) => /^(claude|sleep|compose) /.test(l));
    expect(lines.slice(0, 6)).toEqual([
      "claude -p ok",
      "sleep 600",
      "claude -p ok",
      "sleep 600",
      "claude -p ok",
      "compose up caretook-shared-test",
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
      .filter((l) => /^(compose|serve|pnpm|open|osascript|claude) /.test(l))
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
    const r = spawnSync("bash", [join(main, "scripts/loops/prd.sh"), "down"], {
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

  it("recover clears the stale lock, reopens it in a background tab, then opens the agent", () => {
    const out = okRecover([]);
    expect(out).toMatch(/• cleared stale lock \.loops\/\.dispatch\.lock/);
    expect(out).toMatch(
      /• the dispatcher \(it was running\)\n {2}Opened dispatch in a new background iTerm2 tab/,
    );
    expect(tabs()).toEqual(["osascript dispatch"]);
    const e = effects();
    expect(e.indexOf("osascript dispatch")).toBeGreaterThan(e.indexOf("compose up caretook-shared-test"));
    expect(e.at(-1)).toBe("claude --remote-control recover (agent)");
    expect(readFileSync(join(state, "tab-line"), "utf8").trim()).toBe(
      `cd ${main} && exec scripts/loops/prd.sh dispatch`,
    );
    expect(existsSync(lock())).toBe(false);
    expect(existsSync(record())).toBe(false);
  });

  it("a second recover doesn't reopen it (it wasn't running)", () => {
    okRecover(["--no-agent"]);
    expect(tabs()).toEqual([]);
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
