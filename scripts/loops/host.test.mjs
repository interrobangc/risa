// The host layer (host.mjs): tabs, notifications, launchd and the CLIs, each
// against a stub osascript, launchctl, claude, codex or gh that records its
// arguments (never the real ones), and Node in a made-up nvm folder.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, CARETOOK_ITERM_APP: iterm };
});

describe("tabs", () => {
  it("open where iTerm2 is and osascript is on the PATH, and nowhere else", () => {
    expect(itermApp({})).toBe("/Applications/iTerm.app");
    expect(canOpenTabs(env)).toBe(true);
    expect(canOpenTabs({ ...env, CARETOOK_ITERM_APP: join(root, "nowhere") })).toBe(false);
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
    const r = tab(["exec claude", "prd-a", "0"], { CARETOOK_ITERM_APP: join(root, "nowhere") });
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
    expect(() => launchd({ VITEST: "true", CARETOOK_LAUNCHCTL: launchctl })).toThrow(
      /a test must set CARETOOK_LAUNCH_AGENTS_DIR and CARETOOK_LAUNCHCTL/,
    );
  });

  it("loads, asks about and unloads a job in the user's domain", () => {
    const l = launchd({ ...env, CARETOOK_LAUNCH_AGENTS_DIR: agents, CARETOOK_LAUNCHCTL: launchctl });
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

  it("name claude, codex and gh, claude as CARETOOK_CLAUDE_BIN gives it", () => {
    expect([CLAUDE, CODEX, GH]).toEqual(["claude", "codex", "gh"]);
    expect(claudeBin({})).toBe("claude");
    expect(claudeBin({ CARETOOK_CLAUDE_BIN: "/x/claude-stub" })).toBe("/x/claude-stub");
    expect(claudeName({ CARETOOK_CLAUDE_BIN: "/x/claude-stub" })).toBe("claude-stub");
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
    expect(cli(["claude", "-p", "ok"], { CARETOOK_CLAUDE_BIN: join(bin, "claude-stub") }).status).toBe(0);
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
