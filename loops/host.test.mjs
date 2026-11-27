// The host layer (host.mjs): tabs, notifications, launchd and the CLIs, each
// against a stub osascript, launchctl, claude, codex or gh that records its
// arguments (never the real ones), and Node in a made-up nvm folder.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "./config-fixture.mjs";
import { agentTranscript } from "./context.mjs";
import {
  CONFIG_DIR_VAR,
  claudeAccount,
  claudeChoiceFor,
  claudeConfigDir,
  claudeEnv,
  claudeEnvPrefix,
  claudeInput,
  claudeProjects,
  claudeState,
  hasConversation,
  settingsFor,
} from "./host.mjs";
import { readUsage, runStatusLine } from "./usage.mjs";
import {
  CLAUDE,
  CODEX,
  GH,
  HOST_TOOLS,
  NO_TABS,
  canOpenTabs,
  claudeBin,
  claudeName,
  gh,
  itermApp,
  launchd,
  notify,
  nvmNode,
  onPath,
} from "./host.mjs";

const HOST = new URL("./host.mjs", import.meta.url).pathname;

let root, bin, empty, iterm, log, env;
const stub = (/** @type {string} */ name, /** @type {string} */ body) => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
const logged = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
const tab = (/** @type {string[]} */ args, extra = {}) =>
  spawnSync(process.execPath, [HOST, "tab", ...args], { encoding: "utf8", env: { ...env, ...extra } });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "host-test-"));
  bin = join(root, "bin");
  empty = join(root, "empty");
  mkdirSync(empty);
  iterm = join(root, "iTerm.app");
  mkdirSync(bin);
  mkdirSync(iterm);
  log = join(root, "calls");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(log, { force: true });
  // osascript: each argument on a line, then the script from stdin; $FAIL is its exit.
  stub("osascript", `printf '%s\\n' "$@" >> "${log}"\ncat >> "${log}"\nexit \${FAIL:-0}`);
  env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, RISA_ITERM_APP: iterm };
});

describe("tabs", () => {
  it("open where iTerm2 is and osascript is on the PATH, and nowhere else", () => {
    expect(itermApp({})).toBe("/Applications/iTerm.app");
    expect(canOpenTabs(env)).toBe(true);
    expect(canOpenTabs({ ...env, RISA_ITERM_APP: join(root, "nowhere") })).toBe(false);
    expect(canOpenTabs({ ...env, PATH: empty })).toBe(false);
    expect(onPath("osascript", env)).toBe(join(bin, "osascript"));
    expect(HOST_TOOLS).toEqual(["osascript"]);
  });

  it("write the line to a new tab through osascript, its script on stdin", () => {
    const r = tab(["exec claude", "prd-a", "1"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
    const [dash, line, title, background, ...script] = logged().split("\n");
    expect([dash, line, title, background]).toEqual(["-", "exec claude", "prd-a", "1"]);
    expect(script.join("\n")).toContain('tell application "iTerm2"');
    expect(script.join("\n")).toContain("write text cmd");
  });

  it("exit NO_TABS naming where iTerm2 was looked for, without calling osascript", () => {
    const r = tab(["exec claude", "prd-a", "0"], { RISA_ITERM_APP: join(root, "nowhere") });
    expect(r.status).toBe(NO_TABS);
    expect(r.stdout.trim()).toBe(join(root, "nowhere"));
    expect(logged()).toBe("");
  });

  it("pass osascript's failure on, never as NO_TABS", () => {
    expect(tab(["x", "t", "0"], { FAIL: "5" }).status).toBe(5);
    expect(tab(["x", "t", "0"], { FAIL: String(NO_TABS) }).status).toBe(1);
    expect(tab(["x", "t"]).status).toBe(2);
  });
});

describe("notify", () => {
  it("shows a notification through osascript, and nothing without it", async () => {
    expect(await notify("Title", "the text", 5, env)).toBe("ok");
    expect(logged()).toContain("display notification (item 2 of argv) with title (item 1 of argv)");
    expect(logged()).toContain("Title\nthe text\n");
    expect(await notify("Title", "the text", 5, { ...env, PATH: empty })).toBeNull();
  });

  it("reports a failing osascript", async () => {
    stub("osascript", "exit 2");
    expect(await notify("Title", "the text", 5, env)).toBe("exit 2");
  });
});

describe("launchd", () => {
  let agents, launchctl, loadedFile;
  beforeAll(() => {
    agents = join(root, "LaunchAgents");
    launchctl = join(bin, "launchctl");
    loadedFile = join(root, "loaded");
  });
  beforeEach(() => {
    rmSync(loadedFile, { force: true });
    stub(
      "launchctl",
      `echo "launchctl $*" >> "${log}"
case $1 in
  bootstrap) [ -f "$3" ] || { echo "no such file" >&2; exit 5; }; touch "${loadedFile}" ;;
  bootout) rm -f "${loadedFile}" ;;
  print) [ -f "${loadedFile}" ] ;;
esac`,
    );
  });

  it("refuses under a test without the temp folder and stub", () => {
    expect(() => launchd({ VITEST: "true", RISA_LAUNCHCTL: launchctl })).toThrow(
      /a test must set RISA_LAUNCH_AGENTS_DIR and RISA_LAUNCHCTL/,
    );
  });

  it("loads, asks about and unloads a job in the user's domain", () => {
    const l = launchd({ ...env, RISA_LAUNCH_AGENTS_DIR: agents, RISA_LAUNCHCTL: launchctl });
    const domain = `gui/${process.getuid?.() ?? 0}`;
    expect(l.dir).toBe(agents);
    expect(l.fileOf("com.example.job")).toBe(join(agents, "com.example.job.plist"));
    const file = join(root, "job.plist");
    writeFileSync(file, "<plist/>");
    expect(l.loaded("com.example.job")).toBe(false);
    expect(l.load(file)).toEqual({ ok: true, out: "" });
    expect(l.loaded("com.example.job")).toBe(true);
    l.unload("com.example.job");
    expect(l.loaded("com.example.job")).toBe(false);
    expect(l.load(join(root, "missing.plist"))).toEqual({
      ok: false,
      out: "launchctl bootstrap failed: no such file",
    });
    expect(logged().split("\n").filter(Boolean)).toEqual([
      `launchctl print ${domain}/com.example.job`,
      `launchctl bootstrap ${domain} ${file}`,
      `launchctl print ${domain}/com.example.job`,
      `launchctl bootout ${domain}/com.example.job`,
      `launchctl print ${domain}/com.example.job`,
      `launchctl bootstrap ${domain} ${join(root, "missing.plist")}`,
    ]);
  });
});

describe("the CLIs", () => {
  const cli = (/** @type {string[]} */ args, extra = {}, input = "") =>
    spawnSync(process.execPath, [HOST, ...args], { encoding: "utf8", input, env: { ...env, ...extra } });
  beforeEach(() => {
    // Each: its name and arguments to the log, stdin to stdout, $FAIL its exit.
    for (const name of ["gh", "codex", "claude", "claude-stub"])
      stub(name, `echo "${name} $*" >> "${log}"\ncat\nexit \${FAIL:-0}`);
  });

  it("name claude, codex and gh, claude as RISA_CLAUDE_BIN gives it", () => {
    expect([CLAUDE, CODEX, GH]).toEqual(["claude", "codex", "gh"]);
    expect(claudeBin({})).toBe("claude");
    expect(claudeBin({ RISA_CLAUDE_BIN: "/x/claude-stub" })).toBe("/x/claude-stub");
    expect(claudeName({ RISA_CLAUDE_BIN: "/x/claude-stub" })).toBe("claude-stub");
    expect(claudeName({})).toBe("claude");
  });

  it("run gh for its exit and trimmed stdout, stdin given or none", () => {
    const path = process.env.PATH;
    process.env.PATH = env.PATH;
    try {
      expect(gh(["pr", "list"], { input: "  out\n" })).toEqual({ ok: true, out: "out" });
      expect(gh(["api"], { cwd: root })).toEqual({ ok: true, out: "" });
    } finally {
      process.env.PATH = path;
    }
    expect(logged()).toBe("gh pr list\ngh api\n");
  });

  it("run each from the command line with this process's stdio and exit", () => {
    const r = cli(["gh", "pr", "view", "7"], {}, "in");
    expect([r.status, r.stdout]).toEqual([0, "in"]);
    expect(cli(["codex", "review"], { FAIL: "4" }).status).toBe(4);
    expect(cli(["claude", "-p", "ok"]).status).toBe(0);
    expect(cli(["claude", "-p", "ok"], { RISA_CLAUDE_BIN: join(bin, "claude-stub") }).status).toBe(0);
    expect(logged()).toBe("gh pr view 7\ncodex review\nclaude -p ok\nclaude-stub -p ok\n");
    const missing = cli(["gh", "x"], { PATH: empty });
    expect(missing.status).toBe(127);
    expect(missing.stderr).toMatch(/^host: gh: /);
  });
});

describe("Node", () => {
  let nvm;
  beforeAll(() => {
    nvm = join(root, "nvm");
    for (const v of ["v22.1.0", "v24.2.0", "v24.10.1", "v24.9.9", "v240.0.0"])
      mkdirSync(join(nvm, "versions/node", v, "bin"), { recursive: true });
    mkdirSync(join(nvm, "versions/node", "v24.11.0"));
  });

  it("finds nvm's newest installed Node of a version", () => {
    const at = (/** @type {string} */ v) => join(nvm, "versions/node", v, "bin");
    expect(nvmNode("24", { NVM_DIR: nvm })).toBe(at("v24.10.1"));
    expect(nvmNode("v24.9", { NVM_DIR: nvm })).toBe(at("v24.9.9"));
    expect(nvmNode("22.1.0", { NVM_DIR: nvm })).toBe(at("v22.1.0"));
    expect(nvmNode("20", { NVM_DIR: nvm })).toBeNull();
    expect(nvmNode("24", { NVM_DIR: join(root, "no-nvm") })).toBeNull();
  });

  it("prints its folder from the command line, exit 1 with none", () => {
    const run = (/** @type {string[]} */ args) =>
      spawnSync(process.execPath, [HOST, "node-dir", ...args], {
        encoding: "utf8",
        env: { ...env, NVM_DIR: nvm },
      });
    expect(run(["24"]).stdout).toBe(`${join(nvm, "versions/node/v24.10.1/bin")}\n`);
    expect(run(["20"]).status).toBe(1);
    expect(run([]).status).toBe(2);
  });
});

describe("Claude Code's files", () => {
  const HOST_CLI = (/** @type {string[]} */ args, extra = {}) =>
    spawnSync(process.execPath, [HOST, ...args], { encoding: "utf8", env: { ...env, ...extra } });
  let machine;
  beforeAll(() => {
    machine = join(root, "machine.json");
    writeFileSync(
      machine,
      JSON.stringify({
        repos: [
          { path: join(root, "per-role"), claudeConfigDir: { orchestrator: "/acct/work" } },
          { path: join(root, "one"), claudeConfigDir: "/acct/one" },
        ],
      }),
    );
    for (const d of ["per-role", "one"]) mkdirSync(join(root, d));
  });

  it("chooses the folder: the variable, then the machine config's, then risa.json's, else none", () => {
    expect(claudeConfigDir({ env: { [CONFIG_DIR_VAR]: "/a" }, machine: "/b", project: "/c" })).toEqual({
      dir: "/a",
      from: CONFIG_DIR_VAR,
    });
    expect(claudeConfigDir({ env: {}, machine: "/b", project: "/c" })?.dir).toBe("/b");
    // Folders for other roles only: Claude Code's default for this one, not risa.json's.
    expect(claudeConfigDir({ env: {}, machine: null, project: "/c" })?.dir).toBeNull();
    expect(claudeConfigDir({ env: { HOME: "/h" }, project: "~/.claude-x" })?.dir).toBe("/h/.claude-x");
    expect(claudeConfigDir({ env: {}, project: "relative" })).toBeNull();
    expect(claudeConfigDir({ env: {} })).toBeNull();
    expect(() => claudeConfigDir({ env: { [CONFIG_DIR_VAR]: "rel" } })).toThrow(/absolute/);
  });

  it("reads the machine config's entry for the repo, per role", () => {
    const e = { ...env, RISA_MACHINE_CONFIG: machine };
    const at = (/** @type {string} */ repo, /** @type {string} */ role) =>
      claudeChoiceFor({ main: join(root, repo), role, env: e });
    expect(at("per-role", "orchestrator")?.dir).toBe("/acct/work");
    expect(at("per-role", "backlog")).toEqual({ dir: null, from: "the machine config" });
    expect(at("one", "backlog")?.dir).toBe("/acct/one");
    expect(at("elsewhere", "orchestrator")).toBeNull();
    expect(claudeChoiceFor({ main: join(root, "one"), env: { ...e, [CONFIG_DIR_VAR]: "/v" } })?.dir).toBe(
      "/v",
    );
  });

  it("sets CLAUDE_CONFIG_DIR, unsets it for the default, and leaves it alone with nothing set", () => {
    const base = { CLAUDE_CONFIG_DIR: "/inherited", X: "1" };
    expect(claudeEnv(base, { dir: "/acct", from: "" })).toEqual({ CLAUDE_CONFIG_DIR: "/acct", X: "1" });
    expect(claudeEnv(base, { dir: null, from: "" })).toEqual({ X: "1" });
    expect(claudeEnv(base, null)).toEqual(base);
    expect(claudeEnvPrefix({ dir: "/my acct", from: "" })).toBe("CLAUDE_CONFIG_DIR='/my acct' ");
    expect(claudeEnvPrefix({ dir: null, from: "" })).toBe("env -u CLAUDE_CONFIG_DIR ");
    expect(claudeEnvPrefix(null)).toBe("");
  });

  it("gives every claude it starts the folder: the CLI's claude and session.sh's lines", () => {
    stub("claude-env", `echo "dir=\${CLAUDE_CONFIG_DIR-unset}" >> "${log}"`);
    const claude = { RISA_CLAUDE_BIN: join(bin, "claude-env") };
    expect(HOST_CLI(["claude", "-p"], { ...claude, [CONFIG_DIR_VAR]: "/acct" }).status).toBe(0);
    expect(HOST_CLI(["claude", "-p"], { ...claude, CLAUDE_CONFIG_DIR: "" }).status).toBe(0);
    expect(logged()).toBe("dir=/acct\ndir=\n");
    const lines = (/** @type {string} */ kind, extra = {}) =>
      HOST_CLI(["claude-session", kind, join(root, "per-role")], { RISA_MACHINE_CONFIG: machine, ...extra });
    expect(lines("prd").stdout).toBe(`CLAUDE_CONFIG_DIR=/acct/work\n${settingsFor("prd")}\n`);
    expect(lines("hotfix").stdout).toBe("CLAUDE_CONFIG_DIR\n\n");
    expect(lines("inbox", { RISA_MACHINE_CONFIG: "" }).stdout).toBe(`\n${settingsFor("inbox")}\n`);
    expect(settingsFor("plan")).toBe(settingsFor("prd"));
    expect(settingsFor("hotfix")).toBeNull();
    const bad = lines("prd", { [CONFIG_DIR_VAR]: "rel" });
    expect([bad.status, bad.stderr]).toEqual([2, expect.stringMatching(/absolute/)]);
  });

  it("reads the transcripts and the trusted folders from the folder in use", () => {
    expect(claudeProjects({ CLAUDE_CONFIG_DIR: "/acct" })).toBe("/acct/projects");
    expect(claudeState({ CLAUDE_CONFIG_DIR: "/acct" })).toBe("/acct/.claude.json");
    expect(claudeProjects({})).toMatch(/\/\.claude\/projects$/);
    const projects = claudeProjects({ CLAUDE_CONFIG_DIR: join(root, "acct") });
    mkdirSync(join(projects, "-w"), { recursive: true });
    writeFileSync(join(projects, "-w", "s.jsonl"), "{}\n");
    expect([hasConversation("/w", projects), hasConversation("/w", join(root, "other"))]).toEqual([
      true,
      false,
    ]);
    // The context watch sizes the transcript Claude Code names, so it follows the folder too.
    const transcript = join(root, "acct/projects/-w/s.jsonl");
    expect(agentTranscript({ agent_id: "a1", transcript_path: transcript })).toBe(
      join(root, "acct/projects/-w/s/subagents/agent-a1.jsonl"),
    );
  });

  it("reads Claude Code's input in one place", () => {
    const c = claudeInput(
      JSON.stringify({
        hook_event_name: "StopFailure",
        session_id: "s",
        error: "rate_limit",
        agent_id: "agent-x",
        rate_limits: { five_hour: { used_percentage: 40, resets_at: 9 } },
      }),
    );
    expect(c).toMatchObject({ event: "StopFailure", sessionId: "s", error: "rate_limit", agent: "x" });
    expect(c?.windows.fiveHour).toMatchObject({ percent: 40, resetsAt: 9 });
    expect([claudeInput("nope"), claudeInput("[]")]).toEqual([null, null]);
  });

  it("keeps each account's usage apart; with no folder set, one usage as before", () => {
    const usage = join(root, "usage");
    const now = Date.parse("2026-11-26T12:00:00Z");
    const input = (/** @type {number} */ p) =>
      JSON.stringify({ rate_limits: { five_hour: { used_percentage: p, resets_at: now / 1000 + 3600 } } });
    const at = (/** @type {Record<string, string>} */ e) => ({ RISA_USAGE_DIR: usage, ...e });
    runStatusLine(input(90), at({ RISA_SESSION_NAME: "prd-w", CLAUDE_CONFIG_DIR: "/acct/work" }), now);
    runStatusLine(input(20), at({ RISA_SESSION_NAME: "backlog" }), now);
    expect(claudeAccount({ CLAUDE_CONFIG_DIR: "/acct/work" })).toBe("/acct/work");
    expect(claudeAccount({})).toBeNull();
    const pct = (/** @type {Record<string, string>} */ e) =>
      readUsage(usage, { now, env: at(e) }).fiveHour?.percent;
    expect(pct({ CLAUDE_CONFIG_DIR: "/acct/work" })).toBe(90);
    expect(pct({})).toBe(20);
    expect(readUsage(usage, { now, env: at({}), account: "/acct/work" }).fiveHour?.percent).toBe(90);
  });
});
