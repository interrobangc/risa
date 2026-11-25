// The project config (risa.json): the loader and its errors, `config get`, and
// lib.sh's config_get, which starts Node once however many values a script reads.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  CONFIG_NAME,
  ConfigError,
  SHAPE,
  configPath,
  configProblems,
  flatten,
  getValue,
  loadConfig,
} from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const FILE = join(ROOT, CONFIG_NAME);
const tmp = mkdtempSync(join(tmpdir(), "config-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** This repo's config with one change made to a copy. */
const changed = (change) => {
  const raw = JSON.parse(readFileSync(FILE, "utf8"));
  change(raw);
  return raw;
};
const env = (extra = {}) => ({ ...process.env, RISA_CONFIG: FILE, ...extra });
const cli = (args, extra) =>
  spawnSync(process.execPath, [join(HERE, "config.mjs"), ...args], { encoding: "utf8", env: env(extra) });
const bash = (script, extra) =>
  spawnSync("bash", ["-c", `source "${join(HERE, "lib.sh")}" && ${script}`], {
    cwd: ROOT,
    encoding: "utf8",
    env: env(extra),
  });

describe("the loader", () => {
  it("accepts this repo's config, and every path in it exists", () => {
    const { config, root, path } = loadConfig({ path: FILE });
    expect(path).toBe(FILE);
    expect(config.name).toMatch(/^[a-z]/);
    expect(config.branches.trunk).toBe("dev");
    const paths = [...Object.values(config.paths), ...(config.boundary?.appPaths ?? [])];
    for (const p of paths) expect(existsSync(join(root, p)), p).toBe(true);
  });

  it("keeps the file where RISA_CONFIG says, else at the root of this checkout", () => {
    expect(configPath({})).toBe(FILE);
    expect(configPath({ RISA_CONFIG: "/x/sample.json" })).toBe("/x/sample.json");
  });

  it("gives the shape one line per key, each with a known type", () => {
    const keys = SHAPE.map(([key]) => key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const [key, type] of SHAPE)
      expect(type, key).toMatch(/^(slug|text|command|path|branch|prefix|heading|item|version)(\[\])?\??$/);
  });

  it.each([
    ["name", (c) => delete c.name, "name: missing"],
    ["name", (c) => (c.name = "Care Took"), "name: must be a lowercase name"],
    ["risaVersion", (c) => (c.risaVersion = "soon"), "risaVersion: must be a version"],
    ["tool.prd", (c) => delete c.tool.prd, "tool.prd: missing"],
    ["tool.prd", (c) => (c.tool.prd = ""), "tool.prd: must be a command"],
    ["tool.backlog", (c) => (c.tool.backlog = "a\nb"), "tool.backlog: must be a command"],
    ["paths.backlog", (c) => delete c.paths.backlog, "paths.backlog: missing"],
    ["paths.inbox", (c) => (c.paths.inbox = "/abs/inbox.md"), "paths.inbox: must be a path"],
    ["paths.archive", (c) => (c.paths.archive = "../archive.md"), "paths.archive: must be a path"],
    ["paths.plans", (c) => (c.paths.plans = "plans/"), "paths.plans: must be a path"],
    ["paths.docs", (c) => (c.paths.docs = 7), "paths.docs: must be a path"],
    ["paths.agentsDoc", (c) => (c.paths.agentsDoc = null), "paths.agentsDoc: must be a path"],
    ["paths.tierData", (c) => (c.paths.tierData = "a b"), "paths.tierData: must be a path"],
    ["an unknown key", (c) => (c.paths.backlgo = "x"), "paths.backlgo: unknown key"],
    ["an unknown group", (c) => (c.extras = { a: 1 }), "extras: unknown key"],
    [
      "roles",
      (c) => (c.roles = { loop: { additions: "a.md", replacement: "b.md" } }),
      "roles.loop: give additions or a replacement, not both",
    ],
    [
      "roles.*.additions",
      (c) => (c.roles = { loop: { additions: "" } }),
      "roles.loop.additions: must be a path",
    ],
    ["roles.*", (c) => (c.roles = { loop: { extra: "a.md" } }), "roles.loop.extra: unknown key"],
    ["branches.trunk", (c) => (c.branches.trunk = "de v"), "branches.trunk: must be a branch name"],
    ["branches.protected", (c) => (c.branches.protected = "main"), "branches.protected: must be a list"],
    ["branches.protected", (c) => (c.branches.protected = []), "branches.protected: must be a list"],
    [
      "branches.protected",
      (c) => (c.branches.protected = ["main", ""]),
      "branches.protected.1: must be a branch name",
    ],
    [
      "branches.protected",
      (c) => (c.branches.protected = ["main", "main"]),
      "branches.protected: lists a value twice",
    ],
    [
      "branches.protected",
      (c) => (c.branches.protected = ["dev"]),
      "branches.protected: must not list the trunk",
    ],
    [
      "branches.prefixes.prd",
      (c) => (c.branches.prefixes.prd = "prd"),
      "branches.prefixes.prd: must be a branch prefix",
    ],
    [
      "branches.prefixes",
      (c) => (c.branches.prefixes.plan = "prd/"),
      "branches.prefixes: two kinds share a prefix",
    ],
    [
      "branches.prefixes.hotfix",
      (c) => delete c.branches.prefixes.hotfix,
      "branches.prefixes.hotfix: missing",
    ],
    [
      "backlog.prdsHeading",
      (c) => (c.backlog.prdsHeading = "PRDs"),
      "backlog.prdsHeading: must be a Markdown heading",
    ],
    [
      "backlog.zoneOverflowItem",
      (c) => (c.backlog.zoneOverflowItem = "750"),
      "backlog.zoneOverflowItem: must be a backlog id",
    ],
    ["commands.check", (c) => delete c.commands.check, "commands.check: missing"],
    ["commands.install", (c) => (c.commands.install = ["pnpm"]), "commands.install: must be a command"],
    ["commands.quickCheck", (c) => (c.commands.quickCheck = " x "), "commands.quickCheck: must be a command"],
    [
      "testProjects.tooling",
      (c) => (c.testProjects = { tooling: "a" }),
      "testProjects.tooling: must be a list",
    ],
    ["hooks.check", (c) => (c.hooks = { check: 1 }), "hooks.check: must be a command"],
    ["hooks", (c) => (c.hooks = { stakUp: "x" }), "hooks.stakUp: unknown key"],
    ["boundary.appPaths", (c) => (c.boundary.appPaths = ["web/"]), "boundary.appPaths.0: must be a path"],
  ])("rejects a wrong %s", (_key, change, problem) => {
    const problems = configProblems(changed(change));
    expect(problems.join("\n")).toContain(problem);
    expect(problems).toHaveLength(1);
  });

  it("reports every problem at once, each naming its field", () => {
    const problems = configProblems(changed((c) => ((c.name = 1), delete c.commands.check, (c.nope = true))));
    expect(problems).toEqual([
      "name: must be a lowercase name (letters, digits and hyphens)",
      "nope: unknown key",
      "commands.check: missing",
    ]);
    expect(configProblems([])).toEqual(["the file must hold one JSON object"]);
    const flat = configProblems(changed((c) => (c.tool = "pnpm")));
    expect(flat).toEqual(["tool: must be a group of keys", "tool.prd: missing", "tool.backlog: missing"]);
  });

  it("accepts each optional key, set", () => {
    const full = changed((c) => {
      c.risaVersion = "1.2.3";
      Object.assign(c.paths, {
        tierData: "scripts/project/tiers.json",
        checkPlanRules: "scripts/project/rules.json",
      });
      c.roles = {
        loop: { additions: "docs/agents/loop.md" },
        planner: { replacement: "docs/agents/planner.md" },
      };
      Object.assign(c.commands, { quickCheck: "pnpm check:quick", projectTests: "pnpm test:project" });
      c.testProjects = { tooling: ["tooling:unit", "scripts:unit"], browserHarness: "tooling:browser" };
      c.hooks = Object.fromEntries(
        SHAPE.filter(([k]) => k.startsWith("hooks.")).map(([k]) => [k.slice(6), "bash x.sh"]),
      );
    });
    expect(configProblems(full)).toEqual([]);
    expect(getValue(full, "roles.loop.additions")).toEqual({ known: true, value: "docs/agents/loop.md" });
    expect(getValue(full, "roles.loop.replacement")).toEqual({ known: true });
    expect(getValue(full, "testProjects.tooling").value).toEqual(["tooling:unit", "scripts:unit"]);
    expect(getValue(full, "roles")).toEqual({ known: false });
  });

  it("throws one ConfigError for a missing file, bad JSON or a wrong field, naming the file", () => {
    const missing = join(tmp, "none.json");
    expect(() => loadConfig({ path: missing })).toThrow(
      `${missing}: no project config (${CONFIG_NAME}) there`,
    );
    const bad = join(tmp, "bad.json");
    writeFileSync(bad, "{ nope");
    expect(() => loadConfig({ path: bad })).toThrow(/bad\.json: not JSON/);
    writeFileSync(bad, JSON.stringify(changed((c) => (c.branches.trunk = ""))));
    let error;
    try {
      loadConfig({ env: { RISA_CONFIG: bad } });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.problems).toEqual([`${bad}: branches.trunk: must be a branch name`]);
  });
});

describe("config get", () => {
  const { config } = loadConfig({ path: FILE });
  const keys = SHAPE.map(([key]) => key).filter((key) => !key.includes("*"));

  it("prints what the loader holds, for every key of the shape", () => {
    for (const key of keys) {
      const { value } = getValue(config, key);
      const r = cli(["get", key]);
      if (value === undefined)
        expect([key, r.status, r.stderr.trim()]).toEqual([key, 1, `${CONFIG_NAME}: ${key} is not set`]);
      else expect([key, r.status, r.stdout]).toEqual([key, 0, `${[value].flat().join("\n")}\n`]);
    }
  });

  it("exits 2 on a key the shape doesn't have, a config that doesn't load, and a wrong call", () => {
    expect(cli(["get", "paths.nope"])).toMatchObject({
      status: 2,
      stderr: `${CONFIG_NAME}: no key paths.nope\n`,
    });
    const r = cli(["get", "name"], { RISA_CONFIG: join(tmp, "none.json") });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no project config");
    expect(cli([]).status).toBe(2);
    expect(cli(["get"]).status).toBe(2);
    expect(cli(["check"])).toMatchObject({ status: 0, stdout: "" });
  });

  it("dumps every set value as key=value, a list one item a line", () => {
    const lines = cli(["dump"]).stdout.trimEnd().split("\n");
    expect(lines).toEqual(flatten(config).map(([k, v]) => `${k}=${v}`));
    expect(lines).toContain("branches.protected.0=main");
    expect(lines).toContain("backlog.prdsHeading=## PRDs");
  });

  it("gives bash the same values through lib.sh's config_get", () => {
    const set = keys.filter((key) => getValue(config, key).value !== undefined);
    const r = bash(`for k in ${set.join(" ")}; do echo "<$k>"; config_get "$k"; done`);
    expect(r.stderr).toBe("");
    const want = set.map((key) => `<${key}>\n${[getValue(config, key).value].flat().join("\n")}\n`).join("");
    expect(r.stdout).toBe(want);
  });

  it("fails in bash, with a line, on a key with no value", () => {
    const r = bash('config_get hooks.check; echo "rc=$?"; v=$(config_get paths.nope) || echo "none"');
    expect(r.stdout).toBe("rc=1\nnone\n");
    expect(r.stderr).toBe(
      `${CONFIG_NAME}: no value for hooks.check\n${CONFIG_NAME}: no value for paths.nope\n`,
    );
  });

  it("takes lib.sh's trunk from the config, and TRUNK still wins", () => {
    expect(bash('echo "$trunk"').stdout).toBe(`${config.branches.trunk}\n`);
    expect(bash('echo "$trunk"', { TRUNK: "other" }).stdout).toBe("other\n");
    const sample = join(tmp, "sample.json");
    writeFileSync(sample, JSON.stringify(changed((c) => (c.branches.trunk = "trunk"))));
    expect(bash('echo "$trunk"', { RISA_CONFIG: sample }).stdout).toBe("trunk\n");
  });

  it("stops a script that sources lib.sh when the config doesn't load", () => {
    const r = bash("echo reached", { RISA_CONFIG: join(tmp, "none.json") });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("lib.sh: the project config didn't load");
  });

  it("starts Node once for the config, however many values a script reads", () => {
    const bin = mkdtempSync(join(tmp, "bin-"));
    const starts = join(bin, "starts");
    writeFileSync(
      join(bin, "node"),
      `#!/bin/bash\necho "$*" >> "${starts}"\nexec "${process.execPath}" "$@"\n`,
    );
    chmodSync(join(bin, "node"), 0o755);
    const r = bash(
      'config_get name; a=$(config_get tool.prd); b=$(config_get branches.protected); config_load; (config_get paths.plans); echo "$a|$trunk"',
      { PATH: `${bin}:${process.env.PATH}` },
    );
    expect(r.stdout).toBe(
      `${config.name}\n${config.paths.plans}\n${config.tool.prd}|${config.branches.trunk}\n`,
    );
    const lines = readFileSync(starts, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/config\.mjs dump$/);
  });
});
