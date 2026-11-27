// The machine config (machine.mjs): its loader, the work switch, and the bash
// side (lib.sh's find_repo and work_switch, prd.sh's refusals). Every machine
// config here is a temp file named by RISA_MACHINE_CONFIG; none is the machine's own.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "./config-fixture.mjs";
import {
  MachineConfigError,
  claudeConfigDirOf,
  loadMachineConfig,
  machineConfigPath,
  machineProblems,
  repoEntry,
  workOffLine,
  workSwitch,
} from "./machine.mjs";

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
