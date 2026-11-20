// The session opener (`pnpm prd open`: open-session.sh, open-session.mjs)
// against a throwaway repo with these scripts copied in, real git worktrees, a
// temporary Claude projects folder (CARETOOK_CLAUDE_PROJECTS) and a fake
// osascript that records its script and arguments. Nothing here opens a real
// iTerm2 tab or starts claude.
import { execFileSync, spawnSync } from "node:child_process";
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chooseCommand, projectFolder, runThrough } from "./open-session.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();

const plan = (status) => `# Plan: X

## Status

| Slice | State |
| ----- | ----- |
| 1     | merged |

${status}

## Architectural decisions

- Landing mode: run everything through (a decision elsewhere doesn't count).
`;

// Records each call: its arguments in $FAKE_STATE/osascript-args (one per
// line), the AppleScript from stdin in $FAKE_STATE/osascript-script.
const FAKE_OSASCRIPT = `#!/usr/bin/env bash
echo "osascript $*" >> "$FAKE_LOG"
printf '%s\\n' "$@" > "$FAKE_STATE/osascript-args"
cat > "$FAKE_STATE/osascript-script"
`;

let root, main, loops, log, state, projects, iterm, env;
const open = (args, extra = {}) =>
  spawnSync("bash", [join(main, "scripts/loops/prd.sh"), "open", ...args], {
    cwd: main,
    encoding: "utf8",
    env: { ...env, ...extra },
  });
const ok = (args, extra) => {
  const r = open(args, extra);
  if (r.status !== 0) throw new Error(`open ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};
const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
// osascript - CMD SESSION: the script comes from stdin.
const tabArgs = () => readFileSync(join(state, "osascript-args"), "utf8").split("\n");
const tabCommand = () => tabArgs()[1];
/** Saves a Claude conversation for worktree NAME, as Claude Code does. */
const saveConversation = (name) => {
  const folder = join(projects, projectFolder(join(loops, name)));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "0b5e-session.jsonl"), '{"type":"user"}\n');
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "open-session-test-")));
  main = join(root, "repo");
  loops = join(main, ".loops");
  log = join(root, "calls.log");
  state = join(root, "state");
  projects = join(root, "claude-projects");
  iterm = join(root, "Applications/iTerm.app");
  mkdirSync(state);
  mkdirSync(projects);
  mkdirSync(iterm, { recursive: true });
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "osascript"), FAKE_OSASCRIPT);
  chmodSync(join(bin, "osascript"), 0o755);
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_LOG: log,
    FAKE_STATE: state,
    TRUNK: "dev",
    CARETOOK_CLAUDE_PROJECTS: projects,
    CARETOOK_ITERM_APP: iterm,
  };

  execFileSync("git", ["init", "-q", "-b", "dev", main]);
  for (const [k, v] of [
    ["user.email", "test@example.com"],
    ["user.name", "Test"],
    ["commit.gpgsign", "false"],
  ])
    git(main, "config", k, v);
  mkdirSync(join(main, "scripts/loops"), { recursive: true });
  for (const f of ["prd.sh", "lib.sh", "open-session.sh", "open-session.mjs"])
    copyFileSync(join(HERE, f), join(main, "scripts/loops", f));
  writeFileSync(join(main, ".gitignore"), ".loops/\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "chore: init");

  // auto: queued (run-through); asks: asks before each landing; plan-v: a
  // planner; auto-1: a slice, which has no session of its own.
  for (const [topic, status] of [
    ["auto", "**Landing mode: run everything through** (queued with `pnpm prd queue auto`)."],
    ["asks", "**Landing mode: ask before each landing.**"],
  ]) {
    git(main, "branch", `prd/${topic}`);
    git(main, "worktree", "add", "-q", join(loops, topic), `prd/${topic}`);
    mkdirSync(join(loops, topic, "plans"));
    writeFileSync(join(loops, topic, "plans", `${topic}-plan.md`), plan(status));
  }
  git(main, "worktree", "add", "-q", "-b", "plan/v", join(loops, "plan-v"), "dev");
  git(main, "worktree", "add", "-q", "-b", "slice/auto/1", join(loops, "auto-1"), "prd/auto");
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(log, { force: true });
  rmSync(join(state, "osascript-args"), { force: true });
});

describe("choosing the command", () => {
  it("continues a saved conversation, keeping the Remote Control name", () => {
    expect(
      chooseCommand({ dir: "/w/.loops/t", branch: "prd/t", conversation: true, runThrough: true }),
    ).toEqual({
      session: "prd-t",
      kind: "prd",
      topic: "t",
      mode: "continue",
      command: "cd /w/.loops/t && claude --continue --remote-control prd-t",
    });
  });

  it("starts a fresh orchestrator with the resume prompt, --auto only for run-through", () => {
    const fresh = (auto) =>
      chooseCommand({ dir: "/w/.loops/t", branch: "prd/t", conversation: false, runThrough: auto }).command;
    expect(fresh(false)).toBe(
      'cd /w/.loops/t && claude --remote-control prd-t "$(scripts/loops/prompt.sh orchestrator t --resume)"',
    );
    expect(fresh(true)).toBe(
      'cd /w/.loops/t && claude --remote-control prd-t "$(scripts/loops/prompt.sh orchestrator t --resume --auto)"',
    );
  });

  it("gives a planner the plan prompt", () => {
    expect(
      chooseCommand({ dir: "/w/.loops/plan-u", branch: "plan/u", conversation: false, runThrough: false }),
    ).toMatchObject({
      session: "plan-u",
      mode: "fresh",
      command: 'cd /w/.loops/plan-u && claude --remote-control plan-u "$(scripts/loops/prompt.sh plan u)"',
    });
  });

  it("refuses a worktree that isn't a PRD or a planner", () => {
    expect(() =>
      chooseCommand({ dir: "/w/.loops/t-1", branch: "slice/t/1", conversation: false, runThrough: false }),
    ).toThrow(/only prd\/ and plan\/ worktrees/);
  });

  it("reads run-through from _Status_ only", () => {
    expect(runThrough(plan("**Landing mode: run everything through** (queued)."))).toBe(true);
    expect(runThrough(plan("Landing mode: **run it through** (the user)."))).toBe(true);
    expect(runThrough(plan("**Landing mode: ask before each landing.**"))).toBe(false);
    expect(runThrough(plan("**Landing mode: land some automatically** (wave 1)."))).toBe(false);
    expect(runThrough("# Plan\n\nLanding mode: run everything through\n")).toBe(false);
  });

  it("names the projects folder as Claude Code does", () => {
    expect(projectFolder("/Users/x/git/caretook.com/.loops/loop-recovery")).toBe(
      "-Users-x-git-caretook-com--loops-loop-recovery",
    );
  });
});

describe("pnpm prd open", () => {
  it("opens a fresh resume session in a new iTerm2 tab when there's no saved conversation", () => {
    const out = ok(["auto"]);
    expect(out).toMatch(/Opened prd-auto in a new iTerm2 tab \(a fresh session with the resume prompt\)/);
    expect(tabCommand()).toBe(
      `cd ${join(loops, "auto")} && claude --remote-control prd-auto "$(scripts/loops/prompt.sh orchestrator auto --resume --auto)"`,
    );
    const script = readFileSync(join(state, "osascript-script"), "utf8");
    expect(script).toMatch(/tell application "iTerm2"/);
    expect(script).toMatch(/create tab with default profile/);
    expect(script).toMatch(/write text cmd/);
    expect(tabArgs().slice(0, 3)).toEqual(["-", tabCommand(), "prd-auto"]);
  });

  it("leaves --auto off when _Status_ doesn't record run-through", () => {
    ok(["asks"]);
    expect(tabCommand()).toMatch(/prompt\.sh orchestrator asks --resume\)"$/);
  });

  it("continues the saved conversation when there is one, under the same name", () => {
    saveConversation("asks");
    const out = ok(["asks"]);
    expect(out).toMatch(/continuing its saved conversation/);
    expect(tabCommand()).toBe(`cd ${join(loops, "asks")} && claude --continue --remote-control prd-asks`);
  });

  it("ignores a projects folder with no transcript in it", () => {
    mkdirSync(join(projects, projectFolder(join(loops, "plan-v"))), { recursive: true });
    ok(["plan-v"]);
    expect(tabCommand()).toBe(
      `cd ${join(loops, "plan-v")} && claude --remote-control plan-v "$(scripts/loops/prompt.sh plan v)"`,
    );
  });

  it("prints the command without iTerm2, and with --print", () => {
    const out = ok(["auto"], { CARETOOK_ITERM_APP: join(root, "no-such-app") });
    expect(out).toMatch(/iTerm2 isn't here/);
    expect(out).toContain(
      `  cd ${join(loops, "auto")} && claude --remote-control prd-auto "$(scripts/loops/prompt.sh orchestrator auto --resume --auto)"`,
    );
    saveConversation("auto");
    expect(ok(["auto", "--print"])).toContain(
      `  cd ${join(loops, "auto")} && claude --continue --remote-control prd-auto`,
    );
    expect(calls()).not.toMatch(/osascript/);
  });

  it("refuses a slice, a missing worktree and unknown options", () => {
    expect(open(["auto-1"]).stderr).toMatch(/only prd\/ and plan\/ worktrees have sessions/);
    expect(open(["nope"]).stderr).toMatch(/no worktree nope/);
    expect(open(["auto", "--bogus"]).stderr).toMatch(/unknown option --bogus/);
    expect(open([]).stderr).toMatch(/usage: pnpm prd open/);
    expect(calls()).not.toMatch(/osascript/);
  });
});
