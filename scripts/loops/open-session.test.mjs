// The session opener (`pnpm prd open`: open-session.sh, open-session.mjs)
// against a throwaway repo with these scripts copied in, real git worktrees, a
// temporary Claude projects folder (CARETOOK_CLAUDE_PROJECTS), session records
// in the repo's .loops/.sessions and a fake osascript that records its script
// and arguments. Nothing here opens a real iTerm2 tab or starts claude.
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
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  carryOnPrompt,
  chooseCommand,
  chooseMainCommand,
  inboxDirOf,
  inboxUntrusted,
  projectFolder,
  runThrough,
} from "./open-session.mjs";
import { CAPTAINS } from "./captain.mjs";
import "./config-fixture.mjs";

const SESSION_SH = "/o/scripts/loops/session.sh";
const W = `cd /w/.loops/t && ${SESSION_SH} prd-t`;

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
// osascript - LINE SESSION BACKGROUND: the script comes from stdin. The tab's
// line is the command with exec after its cd, so the tab closes with it.
const tabArgs = () => readFileSync(join(state, "osascript-args"), "utf8").split("\n");
const tabCommand = () => tabArgs()[1];
const tabScript = () => readFileSync(join(state, "osascript-script"), "utf8");
/** The line a tab runs for worktree NAME: cd, then exec session.sh SESSION, then claude's args. */
const tabLine = (name, session, rest) =>
  `cd ${join(loops, name)} && exec ${join(main, "scripts/loops/session.sh")} ${session} -- ${rest}`;
const writeRecord = (session, record) => {
  mkdirSync(join(loops, ".sessions"), { recursive: true });
  writeFileSync(join(loops, ".sessions", `${session}.json`), JSON.stringify(record));
};
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
    // A recorded session's own sessions dir would leak in and win over the test repo's.
    CARETOOK_SESSIONS_DIR: "",
  };

  execFileSync("git", ["init", "-q", "-b", "dev", main]);
  for (const [k, v] of [
    ["user.email", "test@example.com"],
    ["user.name", "Test"],
    ["commit.gpgsign", "false"],
  ])
    git(main, "config", k, v);
  mkdirSync(join(main, "scripts/loops"), { recursive: true });
  for (const f of [
    "prd.sh",
    "lib.sh",
    "config.mjs",
    "open-session.sh",
    "open-session.mjs",
    "planner-model.mjs",
    "sessions.mjs",
    "captain.mjs",
  ])
    copyFileSync(join(HERE, f), join(main, "scripts/loops", f));
  mkdirSync(join(main, "scripts/backlog"));
  for (const f of ["registry.mjs", "format.mjs"])
    copyFileSync(join(HERE, "../backlog", f), join(main, "scripts/backlog", f));
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
  git(main, "worktree", "add", "-q", "-b", "hotfix/trim", join(loops, "hotfix-trim"), "dev");
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(log, { force: true });
  rmSync(join(state, "osascript-args"), { force: true });
  rmSync(join(loops, ".sessions"), { recursive: true, force: true });
});

describe("backlog, recovery and hotfix sessions", () => {
  const wrapper = join("/o", "session.sh");

  it("a backlog session opens fresh in the main checkout on its recorded model and stays managed", () => {
    expect(
      chooseMainCommand({
        name: "backlog",
        main: "/m",
        wrapper,
        record: { kind: "backlog", model: "sonnet", managed: true },
        captain: "Pike",
      }),
    ).toMatchObject({
      session: "backlog",
      title: "Pike",
      mode: "fresh",
      managed: true,
      command: `cd /m && ${wrapper} backlog --kind backlog --managed -- --model sonnet --remote-control Pike "$(CARETOOK_CAPTAIN=Pike scripts/loops/prompt.sh backlog)"`,
    });
  });

  it("the main backlog session reopens as a new captain, never its last one", () => {
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      const c = chooseMainCommand({
        name: "backlog",
        main: "/m",
        wrapper,
        record: { kind: "backlog", remote: "Riker" },
      });
      expect(CAPTAINS).toContain(c.title);
      expect(c.title).not.toBe("Riker");
      expect(c.session).toBe("backlog");
      expect(c.command).toContain(
        `${wrapper} backlog --kind backlog -- --model opus --remote-control ${c.title} `,
      );
      seen.add(c.title);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("a named backlog session reopens under its recorded Remote Control name, with no captain", () => {
    expect(
      chooseMainCommand({
        name: "backlog-x",
        main: "/m",
        wrapper,
        record: { kind: "backlog", model: "sonnet", managed: true, remote: "backlog - x" },
      }),
    ).toEqual(expect.not.objectContaining({ title: expect.anything() }));
    expect(
      chooseMainCommand({
        name: "backlog-x",
        main: "/m",
        wrapper,
        record: { kind: "backlog", model: "sonnet", managed: true, remote: "backlog - x" },
      }).command,
    ).toBe(
      `cd /m && ${wrapper} backlog-x --kind backlog --managed -- --model sonnet --remote-control 'backlog - x' "$(scripts/loops/prompt.sh backlog)"`,
    );
  });

  it("a recovery session opens fresh with its prompt and no model unless one was recorded", () => {
    expect(
      chooseMainCommand({ name: "recover", main: "/m", wrapper, record: { kind: "recovery" } }).command,
    ).toBe(
      `cd /m && ${wrapper} recover --kind recovery -- --remote-control recover "$(scripts/loops/prompt.sh recover)"`,
    );
  });

  it("refuses any other kind of record", () => {
    expect(() => chooseMainCommand({ name: "x", main: "/m", wrapper, record: { kind: "prd" } })).toThrow(
      /not a backlog, recovery or inbox/,
    );
  });

  it("the inbox session reopens through prd.sh inbox in its recorded directory, on prd.sh's model", () => {
    const prd = wrapper.replace(/session\.sh$/, "prd.sh");
    // A record from the old default (Opus) passes no --model: prd.sh's Sonnet at low effort takes over.
    const record = { kind: "inbox", model: "opus", managed: true, dir: "/h/.caretook/inbox" };
    expect(chooseMainCommand({ name: "inbox", main: "/m", wrapper, record })).toMatchObject({
      session: "inbox",
      kind: "inbox",
      mode: "fresh",
      managed: true,
      command: `cd /m && ${prd} inbox --dir /h/.caretook/inbox --managed`,
    });
    // No directory or model recorded: the default directory; by hand stays by hand.
    expect(
      chooseMainCommand({ name: "inbox", main: "/m", wrapper, record: { kind: "inbox" }, inboxDir: "/d" })
        .command,
    ).toBe(`cd /m && ${prd} inbox --dir /d`);
  });

  it("the inbox directory is the record's, else CARETOOK_INBOX_DIR, else ~/.caretook/inbox", () => {
    expect(inboxDirOf({ dir: "/r" }, { CARETOOK_INBOX_DIR: "/e" })).toBe("/r");
    expect(inboxDirOf(null, { CARETOOK_INBOX_DIR: "/e" })).toBe("/e");
    expect(inboxDirOf({}, {})).toMatch(/\/\.caretook\/inbox$/);
  });

  it("the inbox directory is trusted after a saved conversation there, or Claude Code's accepted folder", () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "inbox-trust-")));
    try {
      const dir = join(tmp, "home/.caretook/inbox");
      const projects = join(tmp, "projects");
      const config = join(tmp, "claude.json");
      const opts = { projects, config };
      expect(inboxUntrusted(dir, opts)).toMatch(/doesn't exist yet: run `pnpm prd inbox` once by hand/);
      mkdirSync(dir, { recursive: true });
      expect(inboxUntrusted(dir, opts)).toBe(
        `its directory ${dir} isn't trusted yet: run \`pnpm prd inbox\` once by hand and accept the folder`,
      );
      // Another folder's trust, or one not accepted, doesn't count; a folder above it does.
      const trust = (projectsMap) => writeFileSync(config, JSON.stringify({ projects: projectsMap }));
      trust({
        [join(tmp, "other")]: { hasTrustDialogAccepted: true },
        [dir]: { hasTrustDialogAccepted: false },
      });
      expect(inboxUntrusted(dir, opts)).toMatch(/isn't trusted yet/);
      trust({ [join(tmp, "home")]: { hasTrustDialogAccepted: true } });
      expect(inboxUntrusted(dir, opts)).toBeNull();
      writeFileSync(config, "not json");
      expect(inboxUntrusted(dir, opts)).toMatch(/isn't trusted yet/);
      mkdirSync(join(projects, projectFolder(dir)), { recursive: true });
      writeFileSync(join(projects, projectFolder(dir), "s.jsonl"), "{}\n");
      expect(inboxUntrusted(dir, opts)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a hotfix continues in its worktree on its recorded model, and is fresh after a rotation", () => {
    const base = { dir: "/w/hotfix-t", branch: "hotfix/t", conversation: true, runThrough: false, wrapper };
    expect(chooseCommand({ ...base, record: { model: "sonnet" } }).command).toBe(
      `cd /w/hotfix-t && ${wrapper} hotfix-t -- --model sonnet --continue --remote-control hotfix-t`,
    );
    const fresh = chooseCommand({ ...base, record: { model: "sonnet", rotating: true } });
    expect(fresh.mode).toBe("fresh");
    expect(fresh.command).toBe(
      `cd /w/hotfix-t && ${wrapper} hotfix-t -- --model sonnet --remote-control hotfix-t "$(scripts/loops/prompt.sh hotfix t)"`,
    );
  });

  it("pnpm prd open reopens a recorded backlog session fresh, even with conversations in the main checkout", () => {
    const folder = join(projects, projectFolder(main));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "someone-else.jsonl"), '{"type":"user"}\n');
    writeRecord("backlog", { kind: "backlog", model: "sonnet", ended: "2026-01-01T00:00:00Z" });
    const out = ok(["backlog", "--print"]);
    expect(out).toContain(`cd ${main} && `);
    const captain = /^backlog as ([A-Za-z]+) /m.exec(out)?.[1];
    expect(CAPTAINS).toContain(captain);
    expect(out).toContain(
      `--model sonnet --remote-control ${captain} "$(CARETOOK_CAPTAIN=${captain} scripts/loops/prompt.sh backlog)"`,
    );
    expect(out).not.toContain("--continue");
    rmSync(folder, { recursive: true });
  });

  it("pnpm prd open continues a hotfix in its worktree", () => {
    saveConversation("hotfix-trim");
    writeRecord("hotfix-trim", { kind: "hotfix", model: "sonnet", ended: "2026-01-01T00:00:00Z" });
    const out = ok(["hotfix-trim", "--print"]);
    expect(out).toContain(`cd ${join(loops, "hotfix-trim")} && `);
    expect(out).toContain("--model sonnet --continue --remote-control hotfix-trim");
    rmSync(join(projects, projectFolder(join(loops, "hotfix-trim"))), { recursive: true });
  });

  it("refuses a live backlog or hotfix session, and a name with no worktree or record", () => {
    const live = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const rec = { pid: live.pid, started: new Date().toISOString() };
      writeRecord("backlog", { ...rec, kind: "backlog" });
      writeRecord("hotfix-trim", { ...rec, kind: "hotfix" });
      expect(open(["backlog", "--print"]).stderr).toMatch(/backlog is already live/);
      expect(open(["hotfix-trim", "--print"]).stderr).toMatch(/hotfix-trim is already live/);
    } finally {
      live.kill("SIGKILL");
    }
    const none = open(["nope", "--print"]);
    expect(none.status).not.toBe(0);
    expect(none.stderr).toMatch(/no worktree nope/);
  });
});

describe("choosing the command", () => {
  it("continues a saved conversation, keeping the Remote Control name", () => {
    expect(
      chooseCommand({
        dir: "/w/.loops/t",
        branch: "prd/t",
        conversation: true,
        runThrough: true,
        wrapper: SESSION_SH,
      }),
    ).toEqual({
      session: "prd-t",
      kind: "prd",
      topic: "t",
      mode: "continue",
      auto: true,
      managed: false,
      command: `${W} --auto -- --continue --remote-control prd-t`,
    });
  });

  it("starts a fresh orchestrator with the resume prompt, --auto only for run-through", () => {
    const fresh = (auto) =>
      chooseCommand({
        dir: "/w/.loops/t",
        branch: "prd/t",
        conversation: false,
        runThrough: auto,
        wrapper: SESSION_SH,
      }).command;
    expect(fresh(false)).toBe(
      `${W} -- --remote-control prd-t "$(scripts/loops/prompt.sh orchestrator t --resume)"`,
    );
    expect(fresh(true)).toBe(
      `${W} --auto -- --remote-control prd-t "$(scripts/loops/prompt.sh orchestrator t --resume --auto)"`,
    );
  });

  it("carries a record's run-through over to the new session", () => {
    const choose = (record) =>
      chooseCommand({
        dir: "/w/.loops/t",
        branch: "prd/t",
        conversation: false,
        runThrough: false,
        record,
        wrapper: SESSION_SH,
      });
    expect(choose({ auto: true })).toMatchObject({
      auto: true,
      command: `${W} --auto -- --remote-control prd-t "$(scripts/loops/prompt.sh orchestrator t --resume --auto)"`,
    });
    expect(choose({ auto: false }).auto).toBe(false);
    expect(choose(null).auto).toBe(false);
  });

  it("starts fresh, never --continue, when the record says a rotation was under way", () => {
    expect(
      chooseCommand({
        dir: "/w/.loops/t",
        branch: "prd/t",
        conversation: true,
        runThrough: false,
        record: { rotating: true, auto: true },
        wrapper: SESSION_SH,
      }),
    ).toMatchObject({
      mode: "fresh",
      command: `${W} --auto -- --remote-control prd-t "$(scripts/loops/prompt.sh orchestrator t --resume --auto)"`,
    });
  });

  it("gives a planner the plan prompt", () => {
    expect(
      chooseCommand({
        dir: "/w/.loops/plan-u",
        branch: "plan/u",
        conversation: false,
        runThrough: false,
        wrapper: SESSION_SH,
      }),
    ).toMatchObject({
      session: "plan-u",
      mode: "fresh",
      command: `cd /w/.loops/plan-u && ${SESSION_SH} plan-u -- --model opus --remote-control plan-u "$(scripts/loops/prompt.sh plan u)"`,
    });
  });

  it("carries a record's managed over, continued or fresh, and reopens a run-through planner with --auto", () => {
    const choose = (branch, conversation, record) =>
      chooseCommand({
        dir: `/w/.loops/${branch.replace("/", "-").replace(/^prd-/, "")}`,
        branch,
        conversation,
        runThrough: false,
        record,
        wrapper: SESSION_SH,
      });
    expect(choose("prd/t", true, { managed: true })).toMatchObject({
      managed: true,
      command: `${W} --managed -- --continue --remote-control prd-t`,
    });
    expect(choose("prd/t", false, { managed: true, auto: true }).command).toBe(
      `${W} --auto --managed -- --remote-control prd-t "$(scripts/loops/prompt.sh orchestrator t --resume --auto)"`,
    );
    expect(choose("prd/t", false, { auto: true }).managed).toBe(false);
    expect(choose("plan/u", false, { managed: true, auto: true })).toMatchObject({
      managed: true,
      command: `cd /w/.loops/plan-u && ${SESSION_SH} plan-u --auto --managed -- --model opus --remote-control plan-u "$(scripts/loops/prompt.sh plan u --auto)"`,
    });
  });

  it("--carry-on: a continued prd or plan session gets the carry-on prompt; a fresh one keeps its resume prompt", () => {
    const choose = (branch, conversation, record = { managed: true }) =>
      chooseCommand({
        dir: `/w/.loops/${branch.replace("/", "-").replace(/^prd-/, "")}`,
        branch,
        conversation,
        runThrough: false,
        record,
        wrapper: SESSION_SH,
        carryOn: true,
      });
    expect(choose("prd/t", true).command).toBe(
      `${W} --managed -- --continue --remote-control prd-t '${carryOnPrompt("prd", "t").replace(/'/g, "'\\''")}'`,
    );
    expect(carryOnPrompt("prd", "t")).toMatch(
      /usage limit, and the limit has now reset\. .*pnpm prd land --resume/,
    );
    expect(choose("plan/u", true).command).toContain(
      `--continue --remote-control plan-u '${carryOnPrompt("plan", "u")}'`,
    );
    expect(choose("prd/t", false).command).toBe(
      `${W} --managed -- --remote-control prd-t "$(scripts/loops/prompt.sh orchestrator t --resume)"`,
    );
    expect(choose("prd/t", true, { managed: true, rotating: true }).mode).toBe("fresh");
  });

  it("names an absolute session.sh outside the worktree, the opener's own by default", () => {
    const dir = "/w/.loops/old";
    const { command } = chooseCommand({ dir, branch: "prd/old", conversation: true, runThrough: false });
    const wrapper = /&& (\S+\/session\.sh) prd-old/.exec(command)?.[1];
    expect(wrapper).toBe(fileURLToPath(new URL("./session.sh", import.meta.url)));
    expect(wrapper.startsWith("/")).toBe(true);
    expect(wrapper.startsWith(dir)).toBe(false);
    const quoted = chooseCommand({
      dir,
      branch: "prd/old",
      conversation: true,
      runThrough: false,
      wrapper: "/my repo/scripts/loops/session.sh",
    });
    expect(quoted.command).toContain("&& '/my repo/scripts/loops/session.sh' prd-old");
  });

  it("refuses a worktree that isn't a PRD or a planner", () => {
    expect(() =>
      chooseCommand({
        dir: "/w/.loops/t-1",
        branch: "slice/t/1",
        conversation: false,
        runThrough: false,
        wrapper: SESSION_SH,
      }),
    ).toThrow(/only prd\/, plan\/ and hotfix\/ worktrees/);
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
      tabLine(
        "auto",
        "prd-auto --auto",
        '--remote-control prd-auto "$(scripts/loops/prompt.sh orchestrator auto --resume --auto)"',
      ),
    );
    const script = tabScript();
    expect(script).toMatch(/tell application "iTerm2"/);
    expect(script).toMatch(/if not quiet then activate/);
    expect(script).toMatch(/set newTab to \(create tab with default profile\)/);
    expect(script).toMatch(/tell newSession[\s\S]*write text cmd/);
    expect(script).not.toMatch(/current session of current window/);
    expect(tabArgs().slice(0, 4)).toEqual(["-", tabCommand(), "prd-auto", "0"]);
  });

  it("opens in the background: no activate, the earlier tab reselected, the command written to the new tab", () => {
    const out = ok(["auto", "--background"]);
    expect(out).toMatch(/Opened prd-auto in a new background iTerm2 tab/);
    expect(tabArgs()[3]).toBe("1");
    const script = tabScript();
    // The only activate is behind the quiet flag the background sets.
    expect(script.match(/activate/g)).toEqual(["activate"]);
    expect(script).toMatch(/if not quiet then activate/);
    expect(script).toMatch(/set previousTab to current tab of theWindow/);
    expect(script).toMatch(/tell previousTab to select/);
    expect(script).toMatch(/set newSession to current session of newTab/);
    expect(script).toMatch(/tell newSession\s+set name to tabTitle\s+write text cmd/);
    // "title" is a session property in iTerm2: a variable of that name breaks "set name"
    expect(script).not.toMatch(/set title to/);
  });

  it("falls back when iTerm2 has no current window: the first window, else a new one (B-468)", () => {
    ok(["auto", "--background"]);
    const script = tabScript();
    // current window is missing value when iTerm2 is hidden, minimised or has no key window.
    expect(script).toMatch(/try\s+set theWindow to current window\s+end try/);
    expect(script).toMatch(
      /if theWindow is missing value then\s+try\s+set theWindow to first window\s+end try\s+end if/,
    );
    // Its tab is addressed only once a window is in hand, and never fails the open.
    const inWindow = script.slice(script.indexOf("if theWindow is not missing value then"));
    expect(script.indexOf("if theWindow is not missing value then")).toBeLessThan(
      script.indexOf("current tab of theWindow"),
    );
    expect(inWindow).toMatch(/try\s+set previousTab to current tab of theWindow\s+end try/);
    expect(script).toMatch(
      /if quiet and previousTab is not missing value then\s+try\s+tell previousTab to select/,
    );
    // No usable window, or no tab made in it: a new window, and the command goes to its session.
    expect(script).toMatch(
      /if newSession is missing value then\s+set newWindow to \(create window with default profile\)\s+set newSession to current session of newWindow\s+end if\s+tell newSession/,
    );
    expect(script).not.toMatch(/current (tab|session) of current window/);
    expect(script).not.toMatch(/count of windows/);
  });

  it("opens any command line in a tab with --command, exec'd so the tab closes with it", () => {
    ok(["--command", "cd /x && scripts/loops/rotate-into.sh prd-t 42", "--title", "prd-t", "--background"]);
    expect(tabArgs().slice(1, 4)).toEqual([
      "cd /x && exec scripts/loops/rotate-into.sh prd-t 42",
      "prd-t",
      "1",
    ]);
    ok(["--command", "echo hi", "--title", "x"]);
    expect(tabCommand()).toBe("exec echo hi");
    expect(open(["auto", "--command", "echo hi"]).stderr).toMatch(/a worktree or --command, not both/);
    const printed = ok(["--command", "echo hi", "--print"]);
    expect(printed).toContain("  echo hi");
  });

  it("reads the session's record: run-through carried over, a rotation reopened fresh", () => {
    writeRecord("prd-asks", { pid: 1, auto: true, ended: "2026-11-21T00:00:00Z" });
    ok(["asks"]);
    expect(tabCommand()).toBe(
      tabLine(
        "asks",
        "prd-asks --auto",
        '--remote-control prd-asks "$(scripts/loops/prompt.sh orchestrator asks --resume --auto)"',
      ),
    );
    saveConversation("plan-v");
    writeRecord("plan-v", { pid: 1, rotating: true });
    expect(ok(["plan-v"])).toMatch(/a fresh session with the resume prompt/);
    expect(tabCommand()).toBe(
      tabLine("plan-v", "plan-v", '--model opus --remote-control plan-v "$(scripts/loops/prompt.sh plan v)"'),
    );
    rmSync(join(projects, projectFolder(join(loops, "plan-v"))), { recursive: true, force: true });
  });

  it("reopens a managed, run-through planner as one: --managed and the --auto plan prompt", () => {
    writeRecord("plan-v", { pid: 1, auto: true, managed: true, ended: "2026-11-21T00:00:00Z" });
    ok(["plan-v"]);
    expect(tabCommand()).toBe(
      tabLine(
        "plan-v",
        "plan-v --auto --managed",
        '--model opus --remote-control plan-v "$(scripts/loops/prompt.sh plan v --auto)"',
      ),
    );
  });

  it("--carry-on reaches the opener's choice: the saved conversation continues with the carry-on prompt", () => {
    writeRecord("plan-v", { pid: 1, auto: true, managed: true, ended: "2026-11-21T00:00:00Z" });
    saveConversation("plan-v");
    try {
      ok(["plan-v", "--carry-on"]);
      expect(tabCommand()).toContain(
        "--continue --remote-control plan-v 'This session stopped on a usage limit",
      );
      ok(["plan-v"]);
      expect(tabCommand()).toMatch(/--continue --remote-control plan-v$/);
    } finally {
      rmSync(join(projects, projectFolder(join(loops, "plan-v"))), { recursive: true, force: true });
    }
  });

  it("reopens a design row's planner on Fable, fresh or continued, and any other on opus", () => {
    mkdirSync(join(main, "plans"), { recursive: true });
    const table = (flags) =>
      `# Backlog\n\n## PRDs\n\n| PRD | Flags | After | Hot files | Doc and notes |\n| --- | --- | --- | --- | --- |\n| \`v\` | ${flags} | — | — | — |\n`;
    writeFileSync(join(main, "plans/backlog.md"), table("design"));
    try {
      ok(["plan-v"]);
      expect(tabCommand()).toContain('--model fable --remote-control plan-v "$(');
      saveConversation("plan-v");
      ok(["plan-v"]);
      expect(tabCommand()).toContain("--model fable --continue --remote-control plan-v");
      writeFileSync(join(main, "plans/backlog.md"), table("—"));
      ok(["plan-v"]);
      expect(tabCommand()).toContain("--model opus --continue --remote-control plan-v");
    } finally {
      rmSync(join(main, "plans/backlog.md"), { force: true });
      rmSync(join(projects, projectFolder(join(loops, "plan-v"))), { recursive: true, force: true });
    }
  });

  it("leaves --auto off when _Status_ doesn't record run-through", () => {
    ok(["asks"]);
    expect(tabCommand()).toMatch(/session\.sh prd-asks -- .*prompt\.sh orchestrator asks --resume\)"$/);
  });

  it("continues the saved conversation when there is one, under the same name", () => {
    saveConversation("asks");
    const out = ok(["asks"]);
    expect(out).toMatch(/continuing its saved conversation/);
    expect(tabCommand()).toBe(tabLine("asks", "prd-asks", "--continue --remote-control prd-asks"));
  });

  it("ignores a projects folder with no transcript in it", () => {
    mkdirSync(join(projects, projectFolder(join(loops, "plan-v"))), { recursive: true });
    ok(["plan-v"]);
    expect(tabCommand()).toBe(
      tabLine("plan-v", "plan-v", '--model opus --remote-control plan-v "$(scripts/loops/prompt.sh plan v)"'),
    );
  });

  it("prints the command without iTerm2, and with --print", () => {
    const out = ok(["auto"], { CARETOOK_ITERM_APP: join(root, "no-such-app") });
    expect(out).toMatch(/iTerm2 isn't here/);
    expect(out).toContain(
      `  cd ${join(loops, "auto")} && ${join(main, "scripts/loops/session.sh")} prd-auto --auto -- --remote-control prd-auto "$(scripts/loops/prompt.sh orchestrator auto --resume --auto)"`,
    );
    saveConversation("auto");
    expect(ok(["auto", "--print"])).toContain(
      `  cd ${join(loops, "auto")} && ${join(main, "scripts/loops/session.sh")} prd-auto --auto -- --continue --remote-control prd-auto`,
    );
    expect(calls()).not.toMatch(/osascript/);
  });

  it("refuses a slice, a missing worktree and unknown options", () => {
    expect(open(["auto-1"]).stderr).toMatch(/only prd\/, plan\/ and hotfix\/ worktrees have sessions/);
    expect(open(["nope"]).stderr).toMatch(/no worktree nope/);
    expect(open(["auto", "--bogus"]).stderr).toMatch(/unknown option --bogus/);
    expect(open([]).stderr).toMatch(/usage: pnpm prd open/);
    expect(calls()).not.toMatch(/osascript/);
  });
});
