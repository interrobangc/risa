// The host layer (host.mjs): tabs, notifications and launchd, each against a
// stub osascript or launchctl that records its arguments (never the real ones).
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HOST_TOOLS, NO_TABS, canOpenTabs, itermApp, launchd, notify, onPath } from "./host.mjs";

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
