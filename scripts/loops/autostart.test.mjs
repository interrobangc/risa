// pnpm prd autostart (autostart.mjs) with a stub launchctl, a temp LaunchAgents
// folder, a temp HOME and stub tools: nothing here touches the real
// ~/Library/LaunchAgents or launchd.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jobPath, LABEL, pathOf, plist } from "./autostart.mjs";

const HERE = new URL(".", import.meta.url).pathname;

describe("the plist", () => {
  it("runs the main checkout's watchdog every five minutes, keeping its children, with the full path", () => {
    const text = plist({ main: "/Users/someone/repo", path: "/n/bin:/t/bin:/usr/bin" });
    expect(text).toMatch(/<key>Label<\/key>\s*<string>com\.caretook\.prd-watchdog<\/string>/);
    expect(text).toMatch(
      /<array>\s*<string>\/bin\/bash<\/string>\s*<string>\/Users\/someone\/repo\/scripts\/loops\/prd\.sh<\/string>\s*<string>watchdog<\/string>\s*<\/array>/,
    );
    expect(text).toMatch(/<key>AbandonProcessGroup<\/key>\s*<true\/>/);
    expect(text).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(text).toMatch(/<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
    expect(text).toMatch(/<key>LimitLoadToSessionType<\/key>\s*<string>Aqua<\/string>/);
    expect(text).toMatch(/<key>WorkingDirectory<\/key>\s*<string>\/Users\/someone\/repo<\/string>/);
    expect(pathOf(text)).toBe("/n/bin:/t/bin:/usr/bin");
  });
  it("escapes what XML needs", () => {
    expect(pathOf(plist({ main: "/a&b", path: "/x<y>&z" }))).toBe("/x<y>&z");
    expect(plist({ main: "/a&b", path: "/p" })).toContain("<string>/a&amp;b</string>");
  });
  it("puts node's folder first, then each tool's once, then the system's", () => {
    expect(jobPath("/nvm/v24/bin", ["/usr/local/bin", null, "/usr/local/bin", "/opt/gh"])).toBe(
      "/nvm/v24/bin:/usr/local/bin:/opt/gh:/usr/bin:/bin:/usr/sbin:/sbin",
    );
  });
});

describe("pnpm prd autostart (stub launchctl)", () => {
  let root, agents, main, tools, env, calls, loadedFile;
  const run = (cmd, extra = {}) =>
    spawnSync(process.execPath, [join(HERE, "autostart.mjs"), cmd, "--main", main], {
      encoding: "utf8",
      env: { ...env, ...extra },
    });
  const file = () => join(agents, `${LABEL}.plist`);
  const launchctlCalls = () =>
    existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : [];
  const stub = (dir, name, body) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "autostart-test-"));
    agents = join(root, "LaunchAgents");
    main = join(root, "main");
    mkdirSync(join(main, ".loops"), { recursive: true });
    calls = join(root, "launchctl.log");
    loadedFile = join(root, "loaded");
    // launchctl: logs each call; `print` answers while bootstrapped; bootout of nothing fails.
    stub(
      join(root, "sbin"),
      "launchctl",
      `echo "$*" >> "${calls}"
case $1 in
  bootstrap) [ -f "$3" ] || exit 5; touch "${loadedFile}" ;;
  bootout) [ -f "${loadedFile}" ] || exit 3; rm -f "${loadedFile}" ;;
  print) [ -f "${loadedFile}" ] ;;
esac`,
    );
    tools = join(root, "tools");
    for (const t of ["docker", "gh", "git", "claude", "osascript", "pnpm"]) stub(tools, t, "exit 0");
    stub(join(root, "node24"), "node", "echo v24.9.0");
    env = {
      ...process.env,
      HOME: join(root, "home"),
      PATH: `${tools}:/usr/bin:/bin`,
      RISA_LAUNCH_AGENTS_DIR: agents,
      RISA_LAUNCHCTL: join(root, "sbin/launchctl"),
      RISA_NODE_BIN: join(root, "node24/node"),
      RISA_USAGE_DIR: join(main, ".loops/.usage"),
    };
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => rmSync(calls, { force: true }));

  it("refuses to run under a test without the temp folder and stub", () => {
    const r = run("status", { RISA_LAUNCH_AGENTS_DIR: "", VITEST: "true" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/a test must set RISA_LAUNCH_AGENTS_DIR and RISA_LAUNCHCTL/);
  });

  it("install writes a valid plist with the full path and loads it", () => {
    const r = run("install");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^Installed .*com\.caretook\.prd-watchdog\.plist: the watchdog runs at login/m);
    const text = readFileSync(file(), "utf8");
    expect(pathOf(text)).toBe(`${join(root, "node24")}:${tools}:/usr/bin:/bin:/usr/sbin:/sbin`);
    expect(text).toContain(`<string>${join(main, "scripts/loops/prd.sh")}</string>`);
    expect(text).toMatch(/<key>AbandonProcessGroup<\/key>\s*<true\/>/);
    if (existsSync("/usr/bin/plutil"))
      expect(spawnSync("/usr/bin/plutil", ["-lint", "-s", file()]).status).toBe(0);
    const uid = process.getuid();
    expect(launchctlCalls()).toEqual([`print gui/${uid}/${LABEL}`, `bootstrap gui/${uid} ${file()}`]);
  });

  it("is idempotent: a second install reloads the same plist, one job", () => {
    const before = readFileSync(file(), "utf8");
    const r = run("install");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^Reloaded /);
    expect(readFileSync(file(), "utf8")).toBe(before);
    expect(readdirSync(agents)).toEqual([`${LABEL}.plist`]);
    const uid = process.getuid();
    expect(launchctlCalls()).toEqual([
      `print gui/${uid}/${LABEL}`,
      `bootout gui/${uid}/${LABEL}`,
      `bootstrap gui/${uid} ${file()}`,
    ]);
  });

  it("status says it's loaded and every tool resolves", () => {
    const r = run("status");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/autostart: installed \(.*\), loaded/);
    expect(r.stdout).toMatch(/node: .*node24\/node \(v24\.9\.0\)/);
    expect(r.stdout).toContain(`claude: ${join(tools, "claude")}`);
  });

  it("status names a tool that doesn't resolve on the job's PATH", () => {
    rmSync(join(tools, "claude"));
    try {
      const r = run("status");
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/claude: doesn't resolve on the job's PATH/);
      expect(r.stdout).toContain(`gh: ${join(tools, "gh")}`);
    } finally {
      stub(tools, "claude", "exit 0");
    }
  });

  it("install says which tools it couldn't find", () => {
    const r = run("install", { PATH: `${join(root, "sbin")}:/usr/bin:/bin` });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^Not found on this PATH, so not on the job's: .*\bclaude\b/m);
    expect(run("status", { PATH: "/usr/bin:/bin" }).status).toBe(1);
    expect(run("install").status).toBe(0); // back to the full path
  });

  it("status shows a stay-down mark", () => {
    writeFileSync(
      join(main, ".loops/.stay-down.json"),
      JSON.stringify({ at: "2026-11-24T10:00:00Z", why: "profiling" }),
    );
    try {
      expect(run("status").stdout).toMatch(/stay-down since 2026-11-24T10:00:00Z \(profiling\)/);
    } finally {
      rmSync(join(main, ".loops/.stay-down.json"));
    }
  });

  it("remove unloads it and leaves nothing behind", () => {
    const r = run("remove");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Removed the watchdog's LaunchAgent/);
    expect(readdirSync(agents)).toEqual([]);
    expect(existsSync(loadedFile)).toBe(false);
    expect(launchctlCalls()).toContain(`bootout gui/${process.getuid()}/${LABEL}`);
    expect(run("remove").stdout).toMatch(/No watchdog LaunchAgent was installed/);
    const s = run("status");
    expect(s.status).toBe(1);
    expect(s.stdout).toMatch(/autostart: not installed/);
  });
});
