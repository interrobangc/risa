// The machine config (machine.mjs): its loader, the work switch, and the bash
// side (lib.sh's find_repo and work_switch, prd.sh's refusals). Every machine
// config here is a temp file named by RISA_MACHINE_CONFIG; none is the machine's own.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_CONFIG } from "./config-fixture.mjs";
import {
  GIT_FLOOR,
  MachineConfigError,
  claudeConfigDirOf,
  configFor,
  gitTooOld,
  loadMachineConfig,
  machineConfigPath,
  machineProblems,
  repoEntry,
  workOffLine,
  workSwitch,
} from "./machine.mjs";
import { checkGit } from "./test-global-setup.mjs";

const HERE = new URL(".", import.meta.url).pathname;
/** This repo's main checkout, as lib.sh finds it. */
const MAIN = execFileSync("git", ["-C", HERE, "worktree", "list", "--porcelain"], { encoding: "utf8" })
  .split("\n")[0]
  .replace(/^worktree /, "");

let tmp = "";
let n = 0;
beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "machine-")));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A machine config file holding RAW (an object is written as JSON); its path. */
const machineFile = (/** @type {unknown} */ raw) => {
  const f = join(tmp, `machine-${n++}.json`);
  writeFileSync(f, typeof raw === "string" ? raw : JSON.stringify(raw));
  return f;
};

const SELF = { tool: { self: true } };

describe("configFor", () => {
  const has = (/** @type {string[]} */ files) => (/** @type {string} */ p) => files.includes(p);

  it("gives the checkout's own risa.json when it has one, else the main checkout's", () => {
    expect(
      configFor({ top: "/r/.loops/x", main: "/r", exists: has(["/r/.loops/x/risa.json", "/r/risa.json"]) }),
    ).toBe("/r/.loops/x/risa.json");
    expect(configFor({ top: "/r/.loops/x", main: "/r", exists: has(["/r/risa.json"]) })).toBe("/r/risa.json");
    expect(configFor({ top: "/r", main: "/r", exists: has(["/r/risa.json"]) })).toBe("/r/risa.json");
  });
});
const OTHER = { tool: {} };

describe("the loader", () => {
  it("lives in ~/.risa, or where RISA_MACHINE_CONFIG says; empty means none", () => {
    expect(machineConfigPath({ HOME: "/h" })).toBe("/h/.risa/machine.json");
    expect(machineConfigPath({ HOME: "/h", RISA_MACHINE_CONFIG: "/x/m.json" })).toBe("/x/m.json");
    expect(machineConfigPath({ HOME: "/h", RISA_MACHINE_CONFIG: "" })).toBeNull();
    expect(loadMachineConfig({ env: { RISA_MACHINE_CONFIG: "" } })).toBeNull();
    expect(loadMachineConfig({ path: join(tmp, "none.json") })).toBeNull();
  });

  it("takes a list of repos with a work switch and a Claude config folder", () => {
    const f = machineFile({
      repos: [
        { path: "/a", work: true },
        { path: "/b", work: false, claudeConfigDir: "/c" },
        { path: "/d", claudeConfigDir: { orchestrator: "/o", default: "/x" } },
      ],
    });
    const m = loadMachineConfig({ path: f });
    expect(m?.repos).toHaveLength(3);
    expect(repoEntry(m, "/b")?.work).toBe(false);
    expect(repoEntry(m, "/nowhere")).toBeNull();
    expect(claudeConfigDirOf(repoEntry(m, "/b"), "loop")).toBe("/c");
    expect(claudeConfigDirOf(repoEntry(m, "/d"), "orchestrator")).toBe("/o");
    expect(claudeConfigDirOf(repoEntry(m, "/d"), "loop")).toBe("/x");
    expect(claudeConfigDirOf(repoEntry(m, "/a"), "loop")).toBeNull();
  });

  it("names every problem, one line per field, with the file", () => {
    expect(machineProblems([])).toEqual(["the file must hold one JSON object"]);
    expect(machineProblems({ repo: [] })).toEqual([
      "repo: unknown key",
      "repos: must be a list of repos ({ path, work?, claudeConfigDir? })",
    ]);
    expect(
      machineProblems({
        repos: [
          { path: "rel", work: "yes", extra: 1 },
          { path: "/a", claudeConfigDir: "c" },
          { path: "/a", claudeConfigDir: { Bad: "/x", loop: "y" } },
          "x",
        ],
      }),
    ).toEqual([
      "repos.0.extra: unknown key",
      "repos.0.path: must be an absolute path (the repo's main checkout)",
      "repos.0.work: must be true or false",
      'repos.1.claudeConfigDir: must be an absolute path, or one per role ({ "orchestrator": … })',
      "repos.2.path: lists /a twice",
      "repos.2.claudeConfigDir.Bad: must be a role's name",
      "repos.2.claudeConfigDir.loop: must be an absolute path",
      "repos.3: must be an object ({ path, work?, claudeConfigDir? })",
    ]);
    const bad = machineFile({ repos: [{ path: "rel" }] });
    expect(() => loadMachineConfig({ path: bad })).toThrow(MachineConfigError);
    expect(() => loadMachineConfig({ path: bad })).toThrow(`${bad}: repos.0.path: must be an absolute path`);
    expect(() => loadMachineConfig({ path: machineFile("{") })).toThrow(/: not JSON/);
  });
});

describe("the work switch", () => {
  const machine = (/** @type {object[]} */ repos) => ({ repos: /** @type {any} */ (repos), path: "/m.json" });

  it("no machine config: on, as today, even in the tool's own repo", () => {
    expect(workSwitch({ main: "/r", config: SELF, machine: null, env: {} }).on).toBe(true);
  });

  it("the tool's own repo defaults off, every other on", () => {
    const m = machine([{ path: "/r" }]);
    const self = workSwitch({ main: "/r", config: SELF, machine: m, env: {} });
    expect(self).toEqual({
      on: false,
      why: `off by default for the tool's own repo (/r): set "work": true for it in /m.json`,
    });
    expect(workSwitch({ main: "/r", config: OTHER, machine: m, env: {} }).on).toBe(true);
    // A repo the file doesn't list follows the same defaults.
    expect(workSwitch({ main: "/s", config: SELF, machine: m, env: {} }).on).toBe(false);
    expect(workSwitch({ main: "/s", config: OTHER, machine: m, env: {} }).on).toBe(true);
  });

  it("the repo's own `work` wins over the default", () => {
    const m = machine([
      { path: "/r", work: true },
      { path: "/s", work: false },
    ]);
    expect(workSwitch({ main: "/r", config: SELF, machine: m, env: {} }).on).toBe(true);
    expect(workSwitch({ main: "/s", config: OTHER, machine: m, env: {} })).toEqual({
      on: false,
      why: '"work": false for /s in /m.json',
    });
  });

  it("RISA_WORK_SELF=1 turns it on for the process that has it", () => {
    const m = machine([{ path: "/r", work: false }]);
    expect(workSwitch({ main: "/r", config: SELF, machine: m, env: { RISA_WORK_SELF: "1" } }).on).toBe(true);
    expect(workSwitch({ main: "/r", config: SELF, machine: m, env: { RISA_WORK_SELF: "0" } }).on).toBe(false);
  });

  it("the refusal is one line naming the switch and the variable", () => {
    const line = workOffLine("start", { why: '"work": false for /r in /m.json' });
    expect(line).toBe(
      'start: the work switch is off ("work": false for /r in /m.json); RISA_WORK_SELF=1 turns it on for one shell or session',
    );
  });
});

describe("the bash side", () => {
  /** Runs SCRIPT in bash with lib.sh sourced, from CWD, with EXTRA in the environment. */
  const lib = (/** @type {string} */ script, /** @type {Record<string, string>} */ extra, cwd = HERE) =>
    spawnSync("bash", ["-c", `source ${join(HERE, "lib.sh")}\n${script}`], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, RISA_WORK_SELF: "", ...extra },
    });

  it("no machine config: find_repo gives this repo and work_switch lets everything through", () => {
    const r = lib('echo "$main"; work_switch start; echo reached', { RISA_MACHINE_CONFIG: "" });
    expect(r.stdout).toBe(`${MAIN}\nreached\n`);
    const gone = lib('echo "$main"; work_switch start; echo reached', {
      RISA_MACHINE_CONFIG: join(tmp, "none.json"),
    });
    expect(gone.stdout).toBe(`${MAIN}\nreached\n`);
  });

  it("work: false stops start (exit 3, one line), and RISA_WORK_SELF=1 lifts it for that process only", () => {
    const f = machineFile({ repos: [{ path: MAIN, work: false }] });
    const r = lib("work_switch start; echo reached", { RISA_MACHINE_CONFIG: f });
    expect(r.status).toBe(3);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      `start: the work switch is off ("work": false for ${MAIN} in ${f}); RISA_WORK_SELF=1 turns it on for one shell or session\n`,
    );
    const lifted = lib(
      "work_switch start; echo reached; (unset RISA_WORK_SELF; work_switch start; echo again)",
      {
        RISA_MACHINE_CONFIG: f,
        RISA_WORK_SELF: "1",
      },
    );
    expect(lifted.stdout).toBe("reached\n");
    expect(lifted.status).toBe(3);
  });

  it("pnpm prd start, queue, plan and slice refuse; status-like reads don't ask", () => {
    const f = machineFile({ repos: [{ path: MAIN, work: false }] });
    const env = { ...process.env, RISA_MACHINE_CONFIG: f, RISA_WORK_SELF: "" };
    for (const [cmd, ...args] of [
      ["start", "nope"],
      ["queue", "nope"],
      ["plan", "nope"],
      ["slice", "nope", "1"],
    ]) {
      const r = spawnSync("bash", [join(HERE, "prd.sh"), cmd, ...args], { cwd: HERE, encoding: "utf8", env });
      expect(r.status, cmd).toBe(3);
      expect(r.stderr, cmd).toMatch(new RegExp(`^${cmd}: the work switch is off .*RISA_WORK_SELF=1`, "m"));
    }
    const doc = spawnSync("bash", [join(HERE, "prd.sh"), "doc", "--help"], {
      cwd: HERE,
      encoding: "utf8",
      env,
    });
    expect(doc.stderr).not.toContain("work switch");
  });

  it("a bad machine config stops the command with the loader's line", () => {
    const f = machineFile({ repos: [{ path: "rel" }] });
    const r = lib("echo reached", { RISA_MACHINE_CONFIG: f });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(`machine config: ${f}: repos.0.path: must be an absolute path`);
  });

  it("find_repo takes the current directory's repo when the machine config lists it, with its risa.json", () => {
    const other = join(tmp, "other");
    mkdirSync(other, { recursive: true });
    execFileSync("git", ["init", "-q", other]);
    writeFileSync(join(other, "x"), "");
    const f = machineFile({ repos: [{ path: MAIN }, { path: other }] });
    const listed = spawnSync("node", [join(HERE, "machine.mjs"), "repo", "--cwd", other], {
      encoding: "utf8",
      env: { ...process.env, RISA_MACHINE_CONFIG: f },
    });
    expect(listed.stdout).toBe(`${other}\n${join(other, "risa.json")}\n`);
    const unlisted = spawnSync("node", [join(HERE, "machine.mjs"), "repo", "--cwd", tmp], {
      encoding: "utf8",
      env: { ...process.env, RISA_MACHINE_CONFIG: f },
    });
    expect(unlisted.status).toBe(1);
    // From this repo's directory, this repo (listed or not), and the fixture's config stays.
    const here = lib('echo "$main"', { RISA_MACHINE_CONFIG: f });
    expect(here.stdout).toBe(`${MAIN}\n`);
  });
});

describe("the bash side, in a worktree", () => {
  // A temp repo with the fixture project's files, listed in a temp machine config,
  // and two worktrees: one with its own risa.json (another backlog file and id
  // prefix, its own planner additions), one with none.
  let main = "",
    own = "",
    bare = "",
    mainCfg = "",
    ownCfg = "",
    f = "";
  const git = (/** @type {string} */ cwd, /** @type {string[]} */ ...a) =>
    execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const item = (/** @type {string} */ id) =>
    `\n### ${id} · bug · ${id}'s item\n\n- status: inbox\n- prd:\n- owner:\n- commit:\n`;
  beforeAll(() => {
    main = join(tmp, "wt-main");
    own = join(tmp, "wt-own");
    bare = join(tmp, "wt-bare");
    cpSync(dirname(FIXTURE_CONFIG), main, { recursive: true });
    writeFileSync(join(main, "plans/backlog.md"), `# Backlog\n\n## PRDs\n\n## Items\n${item("B-1")}`);
    writeFileSync(join(main, "plans/w-backlog.md"), `# Backlog\n\n## PRDs\n\n## Items\n${item("W-1")}`);
    execFileSync("git", ["init", "-q", "-b", "dev", main]);
    git(main, "config", "user.email", "test@example.com");
    git(main, "config", "user.name", "Test");
    git(main, "config", "commit.gpgsign", "false");
    git(main, "add", ".");
    git(main, "commit", "-q", "--no-verify", "-m", "init");
    git(main, "worktree", "add", "-q", "-b", "own", own);
    git(main, "worktree", "add", "-q", "-b", "bare", bare);
    mainCfg = join(main, "risa.json");
    ownCfg = join(own, "risa.json");
    const cfg = JSON.parse(readFileSync(mainCfg, "utf8"));
    cfg.backlog.idPrefix = "W";
    cfg.backlog.zoneOverflowItem = "W-750";
    cfg.paths.backlog = "plans/w-backlog.md";
    writeFileSync(ownCfg, JSON.stringify(cfg, null, 2));
    writeFileSync(join(own, "docs/planner.md"), "# The worktree's planner additions\n\nAsk the worktree.\n");
    rmSync(join(bare, "risa.json"));
    f = machineFile({ repos: [{ path: main }] });
  });

  /** Sources lib.sh from CWD with the config pair given ("" is unset); prints both. */
  const found = (/** @type {string} */ cwd, /** @type {string} */ config, /** @type {string} */ mark) =>
    spawnSync(
      "bash",
      ["-c", `source ${join(HERE, "lib.sh")}\necho "$RISA_CONFIG"; echo "\${RISA_CONFIG_FOUND:-}"`],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          RISA_MACHINE_CONFIG: f,
          RISA_WORK_SELF: "",
          RISA_CONFIG: config,
          RISA_CONFIG_FOUND: mark,
        },
      },
    );
  /** bin/risa from CWD with the config pair given. */
  const risa = (
    /** @type {string} */ cwd,
    /** @type {string} */ config,
    /** @type {string} */ mark,
    ...args
  ) =>
    spawnSync("bash", [join(HERE, "../bin/risa"), ...args], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        RISA_MACHINE_CONFIG: f,
        RISA_WORK_SELF: "",
        RISA_CONFIG: config,
        RISA_CONFIG_FOUND: mark,
        BACKLOG_BY: "",
      },
    });

  it("machine.mjs repo gives the worktree's own risa.json, else the main checkout's", () => {
    const repo = (/** @type {string} */ cwd) =>
      spawnSync("node", [join(HERE, "machine.mjs"), "repo", "--cwd", cwd], {
        encoding: "utf8",
        env: { ...process.env, RISA_MACHINE_CONFIG: f },
      }).stdout;
    expect(repo(own)).toBe(`${main}\n${ownCfg}\n`);
    expect(repo(join(own, "docs"))).toBe(`${main}\n${ownCfg}\n`);
    expect(repo(bare)).toBe(`${main}\n${mainCfg}\n`);
    expect(repo(main)).toBe(`${main}\n${mainCfg}\n`);
  });

  it("find_repo takes the worktree's config when none is set or the set one is the found mark; a pin stays", () => {
    expect(found(own, "", "").stdout).toBe(`${ownCfg}\n${ownCfg}\n`);
    // A session's inheritance: the pair the main checkout's shell found.
    expect(found(own, mainCfg, mainCfg).stdout).toBe(`${ownCfg}\n${ownCfg}\n`);
    // No mark: RISA_CONFIG was set by hand, a pin.
    expect(found(own, mainCfg, "").stdout).toBe(`${mainCfg}\n\n`);
    expect(found(own, FIXTURE_CONFIG, mainCfg).stdout).toBe(`${FIXTURE_CONFIG}\n${mainCfg}\n`);
    // A worktree without its own risa.json reads the main checkout's.
    expect(found(bare, "", "").stdout).toBe(`${mainCfg}\n${mainCfg}\n`);
    expect(found(main, "", "").stdout).toBe(`${mainCfg}\n${mainCfg}\n`);
  });

  it("risa backlog from the worktree reads the main checkout's config; a pin wins", () => {
    for (const pair of [mainCfg, ownCfg]) {
      const r = risa(own, pair, pair, "backlog", "list");
      expect(r.stderr).toBe("");
      expect(r.stdout).toContain("B-1");
      expect(r.stdout).not.toContain("W-1");
    }
    const pinned = risa(own, ownCfg, "", "backlog", "list");
    expect(pinned.stdout).toContain("W-1");
    expect(pinned.stdout).not.toContain("B-1");
  });

  it("risa doc planner from the worktree prints the worktree's planner additions", () => {
    const r = risa(own, mainCfg, mainCfg, "doc", "planner");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Ask the worktree.");
    expect(r.stdout).not.toContain("The fixture project's planner additions");
  });
});

describe("the git floor", () => {
  /** An environment whose PATH starts at a stub `git` printing VERSION. */
  const stubGit = (/** @type {string} */ version) => {
    const dir = join(tmp, `git-${n++}`);
    mkdirSync(dir);
    writeFileSync(join(dir, "git"), `#!/bin/sh\necho "git version ${version}"\n`);
    chmodSync(join(dir, "git"), 0o755);
    return { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` };
  };
  const OLD = "git: 2.24.3 is older than 2.28; Risa needs git 2.28 or newer (git init -b)";

  it("2.28 is the floor; an older or unreadable version is too old", () => {
    expect(GIT_FLOOR).toBe("2.28");
    expect(gitTooOld("git version 2.24.3")).toBe(true);
    expect(gitTooOld("git version 2.27.9")).toBe(true);
    expect(gitTooOld("git version 1.99.0")).toBe(true);
    expect(gitTooOld("git version 2.28.0")).toBe(false);
    expect(gitTooOld("git version 2.56.1\n")).toBe(false);
    expect(gitTooOld("git version 2.39.3 (Apple Git-146)")).toBe(false);
    expect(gitTooOld("git version 3.0.0")).toBe(false);
    expect(gitTooOld("command not found")).toBe(true);
    expect(gitTooOld("")).toBe(true);
  });

  it("machine.mjs check refuses an old git with one line and exit 2, and takes 2.28", () => {
    const check = (/** @type {string} */ version) =>
      spawnSync(process.execPath, [join(HERE, "machine.mjs"), "check"], {
        encoding: "utf8",
        env: { ...stubGit(version), RISA_MACHINE_CONFIG: "" },
      });
    const old = check("2.24.3");
    expect(old.status).toBe(2);
    expect(old.stdout).toBe("");
    expect(old.stderr).toBe(`${OLD}\n`);
    const ok = check("2.28.0");
    expect(ok.status).toBe(0);
    expect(ok.stderr).toBe("");
  });

  it("the test run's global setup throws the one line on an old git and returns on 2.28", () => {
    expect(() => checkGit(stubGit("2.24.3"))).toThrow(new Error(OLD));
    expect(checkGit(stubGit("2.28.0"))).toBeUndefined();
  });
});
