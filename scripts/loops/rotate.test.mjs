// Rotation (`pnpm prd rotate`: rotate.sh, rotate-into.sh, rotate.mjs) and the
// done flag `pnpm prd rm` writes, against a throwaway repo with these scripts
// and the backlog tool copied in, a stub claude (CARETOOK_CLAUDE_BIN, named
// claude-stub so no walk up finds a real claude), CARETOOK_ITERM_APP pointing
// nowhere (the opener prints its command) and a fake docker. Nothing here
// starts a real claude, opens a tab or signals a process it didn't start.
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
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearsHot, doneFlags, slicesLeft } from "./rotate.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();

const plan = (rows, mode = "ask before each landing") => `# Plan: W

## Status

**Landing mode: ${mode}.**

| Slice | Wave | State | Merge |
| ----- | ---- | ----- | ----- |
${rows}

## Slice 1: One

Stack: no · Reads: none · Tests: unit
`;
const MERGED = "| 1 | 1 | merged (opus) | abc |\n| 2 | 1 | **landed** in `dev` | def |";

describe("the pure part", () => {
  it("reads the slices left from _Status_, whatever the table's columns", () => {
    expect(slicesLeft(plan(MERGED))).toEqual([]);
    expect(
      slicesLeft(
        plan(`${MERGED}\n| 3 | 2 | not started | |\n| 4 | 2 | handed off | |\n| 5 | 2 | ✅ merged | x |`),
      ),
    ).toEqual(["3", "4"]);
    expect(
      slicesLeft("## Status\n\n| Slice | State |\n| --- | --- |\n| 1 | dropped |\n| 2 | moved to x |\n"),
    ).toEqual([]);
    // No table to read: unknown, not "nothing left".
    expect(slicesLeft("# Plan\n\n## Status\n\nAll done.\n")).toBeNull();
    expect(slicesLeft("# Plan\n")).toBeNull();
  });

  it("marks done with the row's flags, never a standing or missing row", () => {
    const rows = [
      { topic: "a", flags: [] },
      { topic: "b", flags: ["hold", "alone"] },
      { topic: "c", flags: ["standing"] },
      { topic: "d", flags: ["done"] },
    ];
    expect(doneFlags(rows, "a")).toEqual({ flags: ["done"] });
    expect(doneFlags(rows, "b")).toEqual({ flags: ["alone", "done"] });
    expect(doneFlags(rows, "c")).toEqual({ skip: "c is standing: it never finishes" });
    expect(doneFlags(rows, "d")).toEqual({ skip: "d is already done" });
    expect(doneFlags(rows, "e")).toEqual({ skip: "the PRD table has no row e" });
  });

  it("clears hot files only for a standing row that has some", () => {
    const rows = [
      { topic: "f", flags: ["standing"], hot: ["scripts/loops/"] },
      { topic: "g", flags: ["standing"], hot: [] },
      { topic: "p", flags: [], hot: ["apps/web/"] },
    ];
    expect(clearsHot(rows, "f")).toBe(true);
    expect(clearsHot(rows, "g")).toBe(false);
    expect(clearsHot(rows, "p")).toBe(false);
    expect(clearsHot(rows, "missing")).toBe(false);
  });
});

// The stub: records its pid, args and the record it sees at start, then
// behaves as STUB_MODE says.
const STUB = `#!/usr/bin/env bash
mkdir -p "$STUB_STATE"
echo "$$" > "$STUB_STATE/pid"
printf '%s\\n' "$@" > "$STUB_STATE/args"
[[ -z \${STUB_NAME:-} ]] || cat "$CARETOOK_SESSIONS_DIR/$STUB_NAME.json" > "$STUB_STATE/record-at-start" 2>/dev/null || true
case \${STUB_MODE:-exit} in
  exit) exit 0 ;;
  wait)
    trap 'cat "$CARETOOK_SESSIONS_DIR/$STUB_NAME.json" > "$STUB_STATE/record-at-term"; exit 143' TERM
    touch "$STUB_STATE/ready"; for i in $(seq 200); do sleep 0.1; done ;;
  stubborn) trap '' TERM; touch "$STUB_STATE/ready"; for i in $(seq 200); do sleep 0.1; done ;;
  rotate) bash "$PRD_SH" rotate > "$STUB_STATE/rotate.out" 2>&1; echo "$?" > "$STUB_STATE/rotate.code" ;;
esac
`;

let root, main, loops, sessions, state, stub, env, wt;
const scripts = (f) => join(main, "scripts/loops", f);
const record = (name) => JSON.parse(readFileSync(join(sessions, `${name}.json`), "utf8"));
const stubPid = () => Number(readFileSync(join(state, "pid"), "utf8").trim());
const stateFile = (f) => readFileSync(join(state, f), "utf8");
const run = (script, args, extra = {}, cwd = main) =>
  spawnSync("bash", [scripts(script), ...args], { cwd, encoding: "utf8", env: { ...env, ...extra } });
const backlog = (...args) =>
  execFileSync("node", [join(main, "scripts/backlog/backlog.mjs"), ...args], {
    cwd: main,
    encoding: "utf8",
    env,
  }).trim();

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
/** A recorded session prd-w, waiting in the worktree. */
const liveSession = async (extra = {}) => {
  const s = start(
    "bash",
    [
      scripts("session.sh"),
      "prd-w",
      ...(extra.auto ? ["--auto"] : []),
      ...(extra.managed ? ["--managed"] : []),
      "--",
      "x",
    ],
    { STUB_MODE: extra.mode ?? "wait", STUB_NAME: "prd-w" },
    wt,
  );
  await until(() => existsSync(join(state, "ready")));
  return { s, pid: stubPid() };
};
/** The rotate-into.sh line the opener printed. */
const printedLine = (out) => {
  const lines = out.split("\n");
  const i = lines.findIndex((l) => l.startsWith("iTerm2 isn't here"));
  expect(i).toBeGreaterThanOrEqual(0);
  return lines[i + 1].trim();
};

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
  writeFileSync(join(bin, "docker"), "#!/usr/bin/env bash\nexit 0\n");
  for (const f of ["claude-stub", "docker"]) chmodSync(join(bin, f), 0o755);
  execFileSync("git", ["init", "-q", "-b", "dev", main]);
  for (const [k, v] of [
    ["user.email", "test@example.com"],
    ["user.name", "Test"],
    ["commit.gpgsign", "false"],
  ])
    git(main, "config", k, v);
  mkdirSync(join(main, "scripts/loops"), { recursive: true });
  mkdirSync(join(main, "scripts/backlog"), { recursive: true });
  for (const f of [
    "prd.sh",
    "lib.sh",
    "session.sh",
    "sessions.mjs",
    "rotate.sh",
    "rotate-into.sh",
    "rotate.mjs",
    "open-session.sh",
    "open-session.mjs",
    "prompt.sh",
    "rm.sh",
    "stack-lib.sh",
    "test-db.sh",
  ])
    copyFileSync(join(HERE, f), scripts(f));
  const backlogDir = join(HERE, "../backlog");
  for (const f of readdirSync(backlogDir).filter((f) => f.endsWith(".mjs") && !f.includes(".test.")))
    copyFileSync(join(backlogDir, f), join(main, "scripts/backlog", f));
  writeFileSync(join(main, ".gitignore"), ".loops/\n");
  mkdirSync(join(main, "plans"));
  writeFileSync(join(main, "plans/w-plan.md"), plan(`${MERGED}\n| 3 | 2 | not started | |`));
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "chore: init");
  git(main, "worktree", "add", "-q", "-b", "prd/w", wt, "dev");
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TRUNK: "dev",
    CARETOOK_CLAUDE_BIN: stub,
    CARETOOK_ITERM_APP: join(root, "no-iterm"),
    CARETOOK_SESSIONS_DIR: "",
    CARETOOK_ROTATE_WAIT: "",
    BACKLOG_BY: "",
    STUB_STATE: state,
    PRD_SH: scripts("prd.sh"),
  };
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(state, { recursive: true, force: true });
  rmSync(sessions, { recursive: true, force: true });
});

describe("pnpm prd rotate", () => {
  it("prints the rotate-into command with the record's pid when there's no iTerm2, and ends nothing", async () => {
    const { s, pid } = await liveSession();
    const r = run("prd.sh", ["rotate", "w", "--reason", "slow now"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Rotating prd-w: pid ${pid} (from its record).`);
    expect(printedLine(r.stdout)).toBe(
      `cd ${wt} && ${scripts("rotate-into.sh")} prd-w ${pid} --reason slow\\ now`,
    );
    // Nothing was ended or marked.
    expect(spawnSync("kill", ["-0", String(pid)]).status).toBe(0);
    expect(record("prd-w")).not.toHaveProperty("rotating");
    process.kill(pid, "SIGTERM");
    await s.done;
  });

  it("takes the calling shell's ancestor claude when there's no record", () => {
    expect(
      spawnSync(stub, [], { cwd: wt, encoding: "utf8", env: { ...env, STUB_MODE: "rotate" } }).status,
    ).toBe(0);
    const out = stateFile("rotate.out");
    expect(stateFile("rotate.code").trim()).toBe("0");
    expect(out).toContain(`Rotating prd-w: pid ${stubPid()} (from the calling shell's ancestor claude).`);
    expect(printedLine(out)).toBe(`cd ${wt} && ${scripts("rotate-into.sh")} prd-w ${stubPid()}`);
  });

  it("refuses an uncommitted plan, no session to end, and slice worktrees without --mid-wave", async () => {
    const planFile = join(wt, "plans/w-plan.md");
    writeFileSync(planFile, `${readFileSync(planFile, "utf8")}\nmore\n`);
    let r = run("prd.sh", ["rotate", "w"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/plans\/w-plan\.md has uncommitted changes: commit _Status_ first/);
    git(wt, "checkout", "--", "plans/w-plan.md");

    // No record, from the main checkout: the ancestor doesn't count here.
    r = run("prd.sh", ["rotate", "w"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /no session to end: no live record prd-w \(without one, run it from w's own session\)/,
    );
    // From the worktree, with no claude above the shell.
    r = run("prd.sh", ["rotate"], {}, wt);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no live record prd-w, and this shell isn't under a claude process/);

    git(main, "worktree", "add", "-q", "-b", "slice/w/1", join(loops, "w-1"), "prd/w");
    try {
      r = run("prd.sh", ["rotate", "w"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(
        /slice worktrees of w still exist \(w-1\): merge them first, or pass --mid-wave/,
      );
      const { s, pid } = await liveSession();
      r = run("prd.sh", ["rotate", "w", "--mid-wave"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`pid ${pid} (from its record), mid-wave (the agents of w-1 end too).`);
      process.kill(pid, "SIGTERM");
      await s.done;
    } finally {
      git(main, "worktree", "remove", "--force", join(loops, "w-1"));
      git(main, "branch", "-D", "slice/w/1");
    }
  });
});

describe("rotate-into.sh", () => {
  /** Runs the printed line as the tab would; the new session is the stub in exit mode. */
  const runLine = (line, extra = {}) =>
    spawnSync("bash", ["-c", line], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, STUB_MODE: "exit", STUB_NAME: "prd-w", ...extra },
    });

  it("marks rotating, ends the old session, and starts the fresh resume prompt under the same name", async () => {
    const { s, pid } = await liveSession();
    const line = printedLine(run("prd.sh", ["rotate", "w"]).stdout);
    const r = runLine(line);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      `Rotating prd-w: ending pid ${pid}, then a fresh session with the resume prompt.`,
    );
    expect((await s.done).code).toBe(143);
    // rotating was set before the kill, and the new session cleared it.
    expect(JSON.parse(stateFile("record-at-term"))).toMatchObject({ pid, rotating: true });
    const atStart = JSON.parse(stateFile("record-at-start"));
    expect(atStart.pid).not.toBe(pid);
    expect(atStart).not.toHaveProperty("rotating");
    expect(atStart).not.toHaveProperty("ended");
    expect(atStart).toMatchObject({ kind: "prd", topic: "w", auto: false });
    // Fresh, the same name, the resume prompt; not run-through.
    const args = stateFile("args").split("\n");
    expect(args.slice(0, 2)).toEqual(["--remote-control", "prd-w"]);
    const prompt = args.slice(2).join("\n");
    expect(prompt).toContain('You are the PRD orchestrator for "w".');
    expect(prompt).toContain("**You're taking over after an interruption**");
    expect(prompt).not.toContain("**Landing mode: run everything through.**");
    // The old wrapper's end landed before the new start, never on top of it.
    expect(record("prd-w")).toMatchObject({ pid: atStart.pid, exit: 0 });
    expect(record("prd-w")).not.toHaveProperty("rotating");
  });

  it("carries run-through over from the record, or from _Status_", async () => {
    const first = await liveSession({ auto: true });
    expect(runLine(printedLine(run("prd.sh", ["rotate", "w"]).stdout)).status).toBe(0);
    await first.s.done;
    expect(JSON.parse(stateFile("record-at-start")).auto).toBe(true);
    expect(stateFile("args")).toContain("**Landing mode: run everything through.**");

    rmSync(state, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
    const { s, pid } = await liveSession();
    const line = printedLine(run("prd.sh", ["rotate", "w"]).stdout);
    // _Status_ says run-through (an edit after rotate's own check, as a tab may see it).
    writeFileSync(join(wt, "plans/w-plan.md"), plan(MERGED, "run everything through"));
    try {
      const r = runLine(line);
      expect(r.stdout).toContain(`ending pid ${pid}`);
      expect(r.stdout).toContain("(run-through)");
      await s.done;
      expect(JSON.parse(stateFile("record-at-start")).auto).toBe(true);
      expect(stateFile("args")).toContain("**Landing mode: run everything through.**");
    } finally {
      git(wt, "checkout", "--", "plans/w-plan.md");
    }
  });

  it("carries managed over from the record, and leaves a by-hand session by hand", async () => {
    const first = await liveSession({ managed: true });
    expect(runLine(printedLine(run("prd.sh", ["rotate", "w"]).stdout)).status).toBe(0);
    await first.s.done;
    expect(JSON.parse(stateFile("record-at-start"))).toMatchObject({ managed: true, auto: false });
    expect(record("prd-w")).toMatchObject({ managed: true });

    rmSync(state, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
    const second = await liveSession();
    expect(runLine(printedLine(run("prd.sh", ["rotate", "w"]).stdout)).status).toBe(0);
    await second.s.done;
    expect(JSON.parse(stateFile("record-at-start")).managed).toBe(false);
  });

  it("kills a session that ignores TERM after the wait, making a record when there was none", async () => {
    const s = start(stub, [], { STUB_MODE: "stubborn" }, wt);
    await until(() => existsSync(join(state, "ready")));
    const pid = stubPid();
    const r = runLine(`cd ${wt} && ${scripts("rotate-into.sh")} prd-w ${pid}`, { CARETOOK_ROTATE_WAIT: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`pid ${pid} ignored TERM for 1s: killed it.`);
    expect((await s.done).signal).toBe("SIGKILL");
    expect(stubPid()).not.toBe(pid);
    expect(record("prd-w")).toMatchObject({ kind: "prd", topic: "w", pid: stubPid(), exit: 0 });
  });

  it("refuses a name that isn't an orchestrator's, or no pid", () => {
    expect(run("rotate-into.sh", ["plan-w", "123"]).stderr).toMatch(/usage: rotate-into\.sh prd-<topic>/);
    expect(run("rotate-into.sh", ["prd-w"]).status).toBe(1);
    expect(run("rotate-into.sh", ["prd-nope", "123"]).stderr).toMatch(/no worktree nope/);
  });
});

describe("pnpm prd rm marks a finished PRD done", () => {
  const REGISTRY = `# Backlog tracker

Intro.

## PRDs

The registry.

| PRD | Flags | After | Hot files | Doc and notes |
| --- | ----- | ----- | --------- | ------------- |
| \`fin\` | hold | — | — | finished |
| \`open\` | — | — | — | a slice left |
| \`std\` | standing | — | — | standing |
| \`unm\` | — | — | — | not merged |
| \`notable\` | — | — | — | no table |
| \`fixes-x\` | standing, alone | — | \`scripts/loops/\`, \`docs/\` | a fixes wave |
| \`busy\` | — | — | \`apps/web/\` | a PRD with hot files |

## Items

### B-1 · bug · Something

- status: triaged
- prd: std
`;
  const OLD = `# Backlog tracker

Intro.

## PRDs

| PRD | Doc | Depends on | Hot files |
| --- | --- | ---------- | --------- |
| \`pre\` | [plan](pre-plan.md) | — | — |

## Items
`;
  const commitOnDev = (files) => {
    for (const [f, text] of Object.entries(files)) writeFileSync(join(main, f), text);
    git(main, "add", ...Object.keys(files));
    git(main, "commit", "-q", "-m", "chore: fixture");
  };
  /** A prd/<topic> worktree; unmerged gets a commit dev lacks. */
  const prdWorktree = (topic, { merged = true } = {}) => {
    const dir = join(loops, topic);
    git(main, "worktree", "add", "-q", "-b", `prd/${topic}`, dir, "dev");
    if (!merged) {
      writeFileSync(join(dir, "extra.txt"), "x\n");
      git(dir, "add", "extra.txt");
      git(dir, "commit", "-q", "-m", "feat: extra");
    }
  };
  const flagsOf = (topic) =>
    JSON.parse(backlog("prd", "list", "--json")).find((r) => r.topic === topic).flags;

  it("skips it with the old prose table", () => {
    commitOnDev({ "plans/backlog.md": OLD, "plans/pre-plan.md": plan(MERGED) });
    prdWorktree("pre");
    const r = run("rm.sh", ["pre"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Not marking pre done: .*old prose form/);
    expect(r.stdout).toMatch(/Removed pre and its branch prd\/pre/);
  });

  it("sets done only for a merged branch with no slice left, keeping the other flags, never for standing", () => {
    commitOnDev({
      "plans/backlog.md": REGISTRY,
      "plans/fin-plan.md": plan(MERGED),
      "plans/open-plan.md": plan(`${MERGED}\n| 3 | 2 | not started | |`),
      "plans/std-plan.md": plan(MERGED),
      "plans/unm-plan.md": plan(MERGED),
      "plans/notable-plan.md": "# Plan\n\n## Status\n\nAll in.\n",
    });
    for (const t of ["fin", "open", "std", "notable"]) prdWorktree(t);
    prdWorktree("unm", { merged: false });

    let r = run("rm.sh", ["fin"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Marked fin done in the PRD registry (flags done)");
    expect(flagsOf("fin")).toEqual(["done"]);
    expect(git(main, "log", "-1", "--format=%s")).toMatch(/^chore\(backlog\): prd set fin: flags=done/);

    r = run("rm.sh", ["open"]);
    expect(r.stdout).toContain("Not marking open done: slices 3 are still to run (plans/open-plan.md)");
    r = run("rm.sh", ["std"]);
    expect(r.stdout).toContain("Not marking std done: std is standing: it never finishes");
    r = run("rm.sh", ["notable"]);
    expect(r.stdout).toContain("Not marking notable done: plans/notable-plan.md has no _Status_ slice table");
    r = run("rm.sh", ["unm"]);
    expect(r.stdout).not.toMatch(/done/);
    expect(r.stdout).toMatch(/kept prd\/unm: it isn't merged/);
    for (const t of ["open", "std", "notable", "unm"]) expect(flagsOf(t)).not.toContain("done");
    expect(flagsOf("std")).toEqual(["standing"]);
  });

  it("clears a standing topic's hot files when its worktree goes, keeping its flags; others keep theirs", () => {
    commitOnDev({
      "plans/backlog.md": REGISTRY,
      "plans/fixes-x-plan.md": plan(`${MERGED}\n| 3 | 2 | not started | |`),
      "plans/busy-plan.md": plan(`${MERGED}\n| 3 | 2 | not started | |`),
    });
    prdWorktree("fixes-x", { merged: false });
    prdWorktree("busy");
    const rowOf = (topic) => JSON.parse(backlog("prd", "list", "--json")).find((r) => r.topic === topic);

    let r = run("rm.sh", ["fixes-x", "--force"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Cleared fixes-x's hot files in the PRD registry");
    expect(rowOf("fixes-x")).toMatchObject({ flags: ["standing", "alone"], hot: [] });
    expect(git(main, "log", "-1", "--format=%s")).toMatch(/^chore\(backlog\): prd set fixes-x: hot=—/);

    r = run("rm.sh", ["busy"]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("hot files");
    expect(rowOf("busy").hot).toEqual(["apps/web/"]);
  });
});
