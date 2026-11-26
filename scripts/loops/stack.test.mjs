// Stacks, test databases and gc (new.sh, stack.sh, rm.sh, ls.sh, gc.sh) through
// the config's stack hooks, against a throwaway repo with these scripts copied
// in, the hooks on the sample project's stub (its copy in the repo, named by a
// relative path) and fake pnpm, lsof and nvm on PATH: nothing here touches real
// containers, slots or worktrees. What the project's hooks do is their own
// tests' (scripts/project/).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { STUB_HOOK_COPY, stubHookConfig } from "./config-fixture.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();

const PLAN = `# Plan: T

## Slice 1: Stackless

Stack: no · Reads: none · Tests: integration

## Slice 2: Needs a stack

Stack: yes · Reads: none · Tests: unit

## Slice 3: To be merged

Stack: no · Reads: none · Tests: unit

## Slice 4: No fields
`;

let root, main, loops, log, env, state;
const sh = (script, args = [], opts = {}) =>
  spawnSync("bash", [join(main, "scripts/loops", script), ...args], {
    cwd: opts.cwd ?? main,
    encoding: "utf8",
    env: { ...env, ...opts.env },
    input: opts.input ?? "",
  });
const ok = (script, args, opts) => {
  const r = sh(script, args, opts);
  if (r.status !== 0) throw new Error(`${script} ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};
const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
const leases = () => (existsSync(join(loops, ".slots")) ? readdirSync(join(loops, ".slots")) : []);
const read = (...p) => readFileSync(join(...p), "utf8");

// A throwaway repo with the scripts and fakes in place; `use` points sh, ok,
// calls and leases at it.
const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "stack-test-")));
  const main = join(root, "repo");
  const loops = join(main, ".loops");
  const log = join(root, "calls.log");
  const bin = join(root, "bin");
  const nvm = join(root, "nvm");
  mkdirSync(bin);
  mkdirSync(nvm);
  writeFileSync(
    join(bin, "pnpm"),
    '#!/usr/bin/env bash\necho "pnpm $*" >> "$FAKE_LOG"\n[[ $1 != install || -z ${FAKE_INSTALL_FAIL:-} ]]\n',
  );
  writeFileSync(join(bin, "lsof"), "#!/usr/bin/env bash\nexit 1\n");
  for (const f of ["pnpm", "lsof"]) chmodSync(join(bin, f), 0o755);
  writeFileSync(join(nvm, "nvm.sh"), "nvm() { :; }\n");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    NVM_DIR: nvm,
    FAKE_LOG: log,
    TRUNK: "dev",
    CARETOOK_GC_STOPPED_HOURS: "",
    SAMPLE_STACK_STATE: join(root, "stack-state"),
    SAMPLE_STACK_LOG: log,
    // The repo's own records, never the inherited session's (B-871: a run under
    // a session wrote prd-u.json and overwrote backlog.json in the real one).
    CARETOOK_SESSIONS_DIR: join(loops, ".sessions"),
  };
  // The stub claude, the nearest one rm.sh finds above it: with STUB_RECORD, it
  // holds that live session record (as session.sh writes it); then it runs
  // rm.sh from STUB_CWD. Its records are the repo's (CARETOOK_SESSIONS_DIR).
  writeFileSync(
    join(bin, "claude"),
    `#!/usr/bin/env bash
echo "$$" > "$STUB_STATE/pid"
[[ -z \${STUB_RECORD:-} ]] || node "$SESSIONS_MJS" set "$STUB_RECORD" "pid=$$" kind=prd "started=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cd "$STUB_CWD" && bash "$RM_SH" "$@" > "$STUB_STATE/out" 2>&1
echo "$?" > "$STUB_STATE/code"
`,
  );
  chmodSync(join(bin, "claude"), 0o755);

  execFileSync("git", ["init", "-q", "-b", "dev", main]);
  for (const [k, v] of [
    ["user.email", "test@example.com"],
    ["user.name", "Test"],
    ["commit.gpgsign", "false"],
  ])
    git(main, "config", k, v);
  mkdirSync(join(main, "scripts/loops"), { recursive: true });
  for (const f of readdirSync(HERE).filter(
    (f) => f.endsWith(".sh") || ["slice-fields.mjs", "config.mjs", "run-log.mjs", "sessions.mjs"].includes(f),
  ))
    copyFileSync(join(HERE, f), join(main, "scripts/loops", f));
  env.RISA_CONFIG = stubHookConfig(main, { copy: true });
  const ciDir = join(HERE, "../ci");
  mkdirSync(join(main, "scripts/ci"), { recursive: true });
  for (const f of ["outstanding.mjs", "tier-data.mjs", "tiers.json"])
    copyFileSync(join(ciDir, f), join(main, "scripts/ci", f));
  writeFileSync(join(main, ".gitignore"), ".loops/\n.sample-*\n");
  mkdirSync(join(main, "plans"));
  writeFileSync(join(main, "plans/t-plan.md"), PLAN);
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "chore: init");
  git(main, "branch", "prd/t");
  return { root, main, loops, log, env, state: env.SAMPLE_STACK_STATE };
};
const use = (f) => ({ root, main, loops, log, env, state } = f);
// A worktree's stack, as the stub keeps it: its facts, or null without one.
const stack = (dir) => (existsSync(join(dir, ".sample-stack")) ? read(dir, ".sample-stack") : null);
// The stub's running projects: PROJECT runs (or not).
const setRunning = (project, on) => {
  const f = join(state, "running");
  const others = (existsSync(f) ? read(f) : "").split("\n").filter((l) => l && l !== project);
  writeFileSync(f, [...others, ...(on ? [project] : [])].map((l) => `${l}\n`).join(""));
};

// One repo for the file, made once; only gc's merged-slice test has its own (below).
let shared;
beforeAll(() => use((shared = fixture())));
afterAll(() => rmSync(shared.root, { recursive: true, force: true }));
beforeEach(() => rmSync(log, { force: true }));

describe("new.sh slice", () => {
  it("makes a Stack: no slice stackless, with its own test database", () => {
    const out = ok("new.sh", ["slice", "t", "1"]);
    expect(out).toMatch(/Stack: no/);
    const dir = join(loops, "t-1");
    expect(stack(dir)).toBeNull();
    // The stackless env through the stack down hook, and its own test database.
    expect(calls()).toMatch(/^stack down t-1 --base prd\/t\ntest-db use t-1\n/m);
    expect(out).toMatch(/integration tests use sample test database sample_t-1/);
    expect(leases()).toEqual([]);
    expect(calls()).toMatch(/pnpm install --frozen-lockfile/);
    expect(calls()).not.toMatch(/^stack up/m);
  });

  it("gives a Stack: yes slice a slot and a stack, and no test container of its own", () => {
    const out = ok("new.sh", ["slice", "t", "2"]);
    expect(out).toMatch(/Stack: yes/);
    const dir = join(loops, "t-2");
    expect(stack(dir)).toMatch(/^project=sample-loop1$/m);
    expect(leases()).toEqual(["1"]);
    // The stackless env first (before install), then the stack.
    expect(calls()).toMatch(/^stack down t-2 --base prd\/t\n(.*\n)*stack up t-2 --slot 1 --base prd\/t$/m);
    // The hook's facts, printed.
    expect(out).toMatch(
      /→ http:\/\/localhost:6173\n {2}sample stack sample-loop1 \(project sample-loop1\)\n/,
    );
    expect(out).toMatch(/pnpm test:integration → sample test database sample_t-2/);
  });

  it("gives the slot back when a stacked worktree's install fails, leaving it stackless", () => {
    const before = leases();
    const r = sh("new.sh", ["--stack", "slice", "t", "5"], { env: { FAKE_INSTALL_FAIL: "1" } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/install failed for t-5 \(it stays a worktree without a stack\)/);
    const dir = join(loops, "t-5");
    expect(calls()).toMatch(/^stack down t-5 --base prd\/t$/m);
    expect(calls()).not.toMatch(/^stack up t-5/m);
    expect(stack(dir)).toBeNull();
    expect(leases()).toEqual(before);
    ok("rm.sh", ["t-5"]);
  });

  it("treats missing fields as no stack, and honours --stack", () => {
    ok("new.sh", ["slice", "t", "4"]);
    expect(stack(join(loops, "t-4"))).toBeNull();
    ok("rm.sh", ["t-4"]);
    ok("new.sh", ["--stack", "slice", "t", "4"]);
    expect(stack(join(loops, "t-4"))).toMatch(/sample-loop2/);
    ok("rm.sh", ["t-4"]);
    expect(leases()).toEqual(["1"]);
  });
});

describe("new.sh by a relative path, as pnpm prd runs it", () => {
  // new.sh cds into the new worktree before it writes the env files; the stack
  // hooks must still run from the tool's checkout, not from that worktree's,
  // which on a branch older than the hooks has no hook scripts at all. (new.sh
  // fails when any hook does, so its success says the test-db hook ran too.)
  it("writes a worktree's env files with the tool's hooks on a branch that predates them", () => {
    const hooks = dirname(STUB_HOOK_COPY);
    const tmp = join(root, "old-branch");
    git(main, "worktree", "add", "-q", "-b", "hotfix/old", tmp, "dev");
    git(tmp, "rm", "-q", "-r", hooks);
    git(tmp, "commit", "-q", "-m", "chore: before the stack hooks");
    git(main, "worktree", "remove", tmp);
    git(main, "branch", "-q", "hotfix/old-stack", "hotfix/old");
    const rel = (args) => {
      const r = spawnSync("bash", ["scripts/loops/new.sh", ...args], { cwd: main, encoding: "utf8", env });
      if (r.status !== 0) throw new Error(`new.sh ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
    };
    try {
      rel(["hotfix", "old"]);
      const dir = join(loops, "hotfix-old");
      expect(existsSync(join(dir, hooks))).toBe(false);
      expect(stack(dir)).toBeNull();

      const before = leases().length;
      rel(["--stack", "hotfix", "old-stack"]);
      const sdir = join(loops, "hotfix-old-stack");
      expect(stack(sdir)).toMatch(/^slot=\d+$/m);
      expect(leases().length).toBe(before + 1);
    } finally {
      for (const n of ["hotfix-old", "hotfix-old-stack"]) if (existsSync(join(loops, n))) ok("rm.sh", [n]);
      for (const b of ["hotfix/old", "hotfix/old-stack"])
        if (git(main, "branch", "--list", b)) git(main, "branch", "-q", "-D", b);
    }
  });
});

describe("the run log", () => {
  it("records a slice's start at new.sh and its end at rm.sh", () => {
    const runLog = join(root, "run-log.jsonl");
    const opts = { env: { CARETOOK_RUN_LOG: runLog } };
    ok("new.sh", ["slice", "t", "6"], opts);
    ok("rm.sh", ["t-6"], opts);
    const events = read(runLog)
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(events).toEqual([
      expect.objectContaining({
        kind: "slice-start",
        topic: "t",
        name: "t-6",
        branch: "slice/t/6",
        slice: 6,
      }),
      expect.objectContaining({
        kind: "slice-end",
        topic: "t",
        name: "t-6",
        branch: "slice/t/6",
        merged: true,
      }),
    ]);
  });
});

describe("stack up and down", () => {
  it("adds a stack to a stackless worktree, then removes all of it", () => {
    const dir = join(loops, "t-1");
    const up = ok("stack.sh", ["up"], { cwd: dir });
    expect(up).toMatch(/Stack up for t-1 \(slot 2/);
    expect(stack(dir)).toMatch(/^project=sample-loop2$/m);
    expect(leases().sort()).toEqual(["1", "2"]);
    expect(calls()).toMatch(/^stack up t-1 --slot 2 --base prd\/t$/m);

    // Its facts, from the stack status hook: the same slot, project and port.
    const facts = ok("stack.sh", ["status", "t-1"]);
    for (const f of ["slot=2", "project=sample-loop2", "web_port=6273"])
      expect(facts.split("\n")).toContain(f);
    expect(up).toMatch(/→ http:\/\/localhost:6273\n {2}sample stack sample-loop2\n/);
    // The ready hook's facts and exit, passed on.
    const ready = () => sh("stack.sh", ["ready", "t-1"]);
    const r = ready();
    expect([r.status, r.stdout]).toEqual([0, expect.stringMatching(/^containers=1\/1\nready=yes$/m)]);
    setRunning("sample-loop2", false);
    expect(ready().status).toBe(1);
    expect(ready().stdout).toMatch(/^containers=0\/1\nready=no$/m);
    // Up again on a stack it has: started, not leased again.
    expect(ok("stack.sh", ["up", "t-1"])).toMatch(/t-1 already has a stack \([^)]+\); starting it/);
    expect(leases().sort()).toEqual(["1", "2"]);

    expect(calls()).toMatch(/^stack up t-1 --base prd\/t$/m);
    const down = ok("stack.sh", ["down", "t-1"]);
    expect(down).toMatch(/sample-loop2 removed, slot released/);
    expect(calls()).toMatch(/^stack down t-1 --base prd\/t$/m);
    expect(stack(dir)).toBeNull();
    expect(leases()).toEqual(["1"]);
  });

  it("says so for a worktree without a stack, and releases no other's slot", () => {
    expect(ok("stack.sh", ["down", "t-1"])).toMatch(/has no stack/);
    expect(ok("stack.sh", ["status", "t-1"])).toBe("");
    expect(leases()).toEqual(["1"]);
  });
});

describe("rm.sh", () => {
  it("takes down its stack and drops its test database through the hooks", () => {
    ok("new.sh", ["--stack", "slice", "t", "5"]);
    rmSync(log, { force: true });
    ok("rm.sh", ["t-5"]);
    expect(calls()).toMatch(/^stack down t-5\ntest-db drop t-5$/m);
    expect(existsSync(join(loops, "t-5"))).toBe(false);
    expect(leases()).toEqual(["1"]);
  });

  it("keeps the worktree when its stack down hook fails", () => {
    ok("new.sh", ["slice", "t", "5"]);
    const r = sh("rm.sh", ["t-5"], { env: { SAMPLE_STACK_FAIL: "down:t-5" } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/couldn't take down t-5's stack; the worktree stays/);
    expect(existsSync(join(loops, "t-5"))).toBe(true);
    ok("rm.sh", ["t-5"]);
  });

  it("removes the worktree's session record and leaves the others", () => {
    ok("new.sh", ["plan", "r"]);
    const sessions = join(loops, ".sessions");
    mkdirSync(sessions, { recursive: true });
    for (const n of ["plan-r", "prd-other"]) writeFileSync(join(sessions, `${n}.json`), '{"pid":1}\n');
    ok("rm.sh", ["plan-r"]);
    expect(existsSync(join(sessions, "plan-r.json"))).toBe(false);
    expect(existsSync(join(sessions, "prd-other.json"))).toBe(true);
  });
});

describe("rm.sh from inside the worktree it removes (B-812)", () => {
  const stubState = () => join(root, "stub-state");
  const sessions = () => join(loops, ".sessions");
  /** Runs rm.sh ARGS (space-separated) from CWD under the stub claude; resolves {signal, out, code, pid}. */
  const underClaude = (args, cwd, record) =>
    new Promise((resolve) => {
      rmSync(stubState(), { recursive: true, force: true });
      mkdirSync(stubState(), { recursive: true });
      const child = spawn(join(root, "bin", "claude"), args.split(" "), {
        cwd: main,
        stdio: "ignore",
        env: {
          ...env,
          STUB_STATE: stubState(),
          STUB_CWD: cwd,
          STUB_RECORD: record ?? "",
          SESSIONS_MJS: join(main, "scripts/loops/sessions.mjs"),
          RM_SH: join(main, "scripts/loops/rm.sh"),
        },
      });
      child.on("close", (_code, signal) => {
        const f = (n) => (existsSync(join(stubState(), n)) ? read(stubState(), n) : "");
        resolve({ signal, out: f("out"), code: f("code").trim(), pid: Number(f("pid")) });
      });
    });
  beforeEach(() => {
    rmSync(sessions(), { recursive: true, force: true });
    if (!existsSync(join(loops, "u"))) ok("new.sh", ["--no-stack", "prd", "u"]);
  });
  afterAll(() => {
    if (existsSync(join(loops, "u"))) ok("rm.sh", ["u"]);
  });

  it("ends its own orchestrator's session once the worktree is gone", async () => {
    const r = await underClaude("u", join(loops, "u", "plans"), "prd-u");
    expect(r.signal).toBe("SIGTERM");
    expect(r.out).toMatch(/^Removed u and its branch prd\/u/m);
    expect(r.out).toContain(`Ending prd-u (pid ${r.pid}): its worktree is gone, so this was its last step.`);
    expect(existsSync(join(loops, "u"))).toBe(false);
    expect(existsSync(join(sessions(), "prd-u.json"))).toBe(false);
  });

  it("refuses another caller inside it, with the line to run from the main checkout", async () => {
    // A claude with no record (its orchestrator, maybe): the line ends it too.
    const r = await underClaude("u", join(loops, "u"));
    expect(r.signal).toBeNull();
    expect(r.code).toBe("1");
    expect(r.out).toContain(
      `rm: this shell is inside u, which rm would delete under it; run instead: cd ${main} && pnpm prd rm u && pnpm prd end`,
    );
    expect(existsSync(join(loops, "u"))).toBe(true);
    // Another session's claude: no end in the line, and its options kept.
    const other = await underClaude("u --keep-branch", join(loops, "u"), "backlog");
    expect(other.code).toBe("1");
    expect(other.out).toMatch(/run instead: cd \S+ && pnpm prd rm u --keep-branch\n$/);
    expect(existsSync(join(loops, "u"))).toBe(true);
    // The stub's record went to the repo's own folder (B-871), not an inherited one.
    expect(JSON.parse(read(sessions(), "backlog.json"))).toMatchObject({ pid: other.pid, kind: "prd" });
  });

  it("from the main checkout removes it as before and ends no session", async () => {
    const r = await underClaude("u", main, "prd-u");
    expect(r.signal).toBeNull();
    expect(r.code).toBe("0");
    expect(r.out).toMatch(/^Removed u and its branch prd\/u/m);
    expect(r.out).not.toMatch(/Ending/);
    expect(existsSync(join(loops, "u"))).toBe(false);
  });
});

describe("status and gc", () => {
  // Every ls.sh and gc.sh call walks every worktree, with a dozen or more git
  // starts each (B-740), so this test has a repo of its own with just the two
  // it reads: a fresh slice (t-1) and the one it merges (t-3). On the file's
  // repo (t-1 and t-2 besides) it took 12-15 s at load 10-100 and hit 20 s at
  // load 60; here 7-9 s. ls.sh runs once per state, not once per assertion.
  describe("a merged slice", () => {
    beforeAll(() => {
      use(fixture());
      ok("new.sh", ["slice", "t", "1"]);
    });
    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
      use(shared);
    });

    it("flags a merged slice, not a fresh one, and gc removes it only after a yes", () => {
      ok("new.sh", ["slice", "t", "3"]);
      expect(ok("ls.sh", [])).not.toMatch(/merged:/);
      const dir = join(loops, "t-3");
      writeFileSync(join(dir, "work.txt"), "done\n");
      git(dir, "add", "work.txt");
      git(dir, "commit", "-q", "-m", "feat(t): work");
      const prd = join(root, "prd-t");
      git(main, "worktree", "add", "-q", prd, "prd/t");
      git(prd, "merge", "--no-ff", "-q", "-m", "feat(t): merge slice 3", "slice/t/3");
      // Its wave hasn't landed: the worktree stays for a fix, and says so.
      const handedOff = ok("ls.sh", []);
      expect(handedOff).not.toMatch(/merged: t-3/);
      expect(handedOff).toMatch(/^ {2}t-3: handed off$/m);
      expect(ok("gc.sh", ["--list"])).toMatch(/^keep {8}t-3 \(merged, but its wave hasn't landed\)/m);
      git(main, "merge", "--no-ff", "-q", "-m", "feat(t): land", "prd/t");
      const status = ok("ls.sh", []);
      expect(status).toMatch(/merged: t-3 \(slice\/t\/3 is merged into prd\/t\): pnpm prd gc/);
      expect(status).not.toMatch(/merged: t-1/);
      expect(status).toMatch(/sample test database: stopped/);

      expect(ok("gc.sh", ["--list"])).toMatch(/^remove {6}t-3 /m);
      expect(ok("gc.sh", [], { input: "n\n" })).toMatch(/Nothing changed/);
      expect(existsSync(join(loops, "t-3"))).toBe(true);

      const out = ok("gc.sh", [], { input: "y\n" });
      expect(out).toMatch(/Cleaned up 1/);
      expect(existsSync(join(loops, "t-3"))).toBe(false);
      expect(git(main, "branch", "--list", "slice/t/3")).toBe("");
      expect(calls()).toMatch(/^test-db drop t-3$/m);
      expect(existsSync(join(loops, "t-1"))).toBe(true);
    });
  });

  it("flags a stack stopped for over a day, and gc takes it down but keeps the worktree", () => {
    // The ready hook's stopped_secs: three days, then running, then a minute.
    const dir = join(loops, "t-2");
    const secs = join(dir, ".sample-stopped-secs");
    setRunning("sample-loop1", false);
    writeFileSync(secs, `${3 * 86400}\n`);
    expect(ok("ls.sh", [])).toMatch(/stopped stack: t-2 \(sample-loop1 stopped 3d ago\)/);
    setRunning("sample-loop1", true);
    expect(ok("ls.sh", [])).not.toMatch(/stopped stack/);
    expect(ok("gc.sh", ["--list"])).toMatch(/Nothing to clean up/);
    setRunning("sample-loop1", false);
    writeFileSync(secs, "60\n");
    expect(ok("ls.sh", [])).not.toMatch(/stopped stack/);

    writeFileSync(secs, `${3 * 86400}\n`);
    // A failed ready hook is no answer, not "no stack": ls says unknown, gc keeps it.
    const failed = { env: { SAMPLE_STACK_FAIL: "ready:t-2" } };
    expect(ok("ls.sh", [], failed)).toMatch(/^t-2 +\? .* unknown +\? \(the stackReady hook failed\)$/m);
    const kept = ok("gc.sh", ["--list"], failed);
    expect(kept).toMatch(/^keep {8}t-2 \(its stack is unknown: the stackReady hook failed\)$/m);
    expect(kept).not.toMatch(/stack down/);
    const out = ok("gc.sh", ["--yes"]);
    expect(out).toMatch(/^stack down {2}t-2 /m);
    expect(calls()).toMatch(/^stack down t-2/m);
    expect(existsSync(dir)).toBe(true);
    expect(stack(dir)).toBeNull();
    expect(leases()).toEqual([]);
  });
});

describe("a slice's place in its wave", () => {
  const state = (dir, going) =>
    execFileSync(
      "bash",
      ["-c", 'source "$1/stack-lib.sh"; slice_state "$2" "$3"', "x", join(main, "scripts/loops"), dir, going],
      {
        encoding: "utf8",
        env,
      },
    ).trim();

  it("reads working, handed off, waiting for the run, then fixing after a second commit", () => {
    ok("new.sh", ["slice", "t", "6"]);
    const dir = join(loops, "t-6");
    writeFileSync(join(dir, "six.txt"), "1\n");
    git(dir, "add", "six.txt");
    git(dir, "commit", "-q", "-m", "feat(t): six");
    expect(state(dir, "0")).toBe("working");
    const prd = join(root, "prd-t");
    if (!existsSync(prd)) git(main, "worktree", "add", "-q", prd, "prd/t");
    git(prd, "merge", "--no-ff", "-q", "-m", "feat(t): merge slice 6", "slice/t/6");
    expect(state(dir, "0")).toBe("handed off");
    expect(state(dir, "1")).toBe("waiting for the run");
    git(dir, "merge", "--no-ff", "-q", "-m", "chore(t): merge prd/t for a fix", "prd/t");
    writeFileSync(join(dir, "six.txt"), "2\n");
    git(dir, "commit", "-q", "-am", "fix(t): six");
    expect(state(dir, "1")).toBe("fixing");
    ok("rm.sh", ["t-6", "--force"]);
  });

  it("a hand-off leaves no stack up, and stack up takes it again for a fix", () => {
    ok("new.sh", ["--stack", "slice", "t", "7"]);
    const dir = join(loops, "t-7");
    expect(stack(dir)).toMatch(/^slot=[0-9]/m);
    ok("stack.sh", ["down"], { cwd: dir });
    expect(stack(dir)).toBeNull();
    expect(ok("stack.sh", ["down"], { cwd: dir })).toMatch(/has no stack/);
    expect(ok("stack.sh", ["up"], { cwd: dir })).toMatch(/Stack up for t-7/);
    ok("stack.sh", ["down"], { cwd: dir });
    ok("rm.sh", ["t-7", "--force"]);
  });
});
