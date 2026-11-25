// The project config (risa.json): the loader and its errors, `config get`, and
// lib.sh's config_get, which starts Node once however many values a script reads.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  CONFIG_NAME,
  ConfigError,
  backlogIds,
  branchKinds,
  SHAPE,
  configPath,
  configProblems,
  flatten,
  getValue,
  loadConfig,
  toolCommands,
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
    const paths = [...Object.values(config.paths).flat(), ...(config.boundary?.appPaths ?? [])];
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
      expect(type, key).toMatch(
        /^(slug|text|command|path|branch|prefix|heading|item|idPrefix|version)(\[\])?\??$/,
      );
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
    ["backlog.idPrefix", (c) => (c.backlog.idPrefix = "b-"), "backlog.idPrefix: must be an id prefix"],
    ["backlog.idPrefix", (c) => delete c.backlog.idPrefix, "backlog.idPrefix: missing"],
    ["paths.tooling", (c) => (c.paths.tooling = "tools"), "paths.tooling: must be a list"],
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

describe("backlogIds", () => {
  it("builds the ids from the config's prefix: this repo's, and another's", () => {
    const here = backlogIds();
    expect(here.prefix).toBe(`${loadConfig({ path: FILE }).config.backlog.idPrefix}-`);
    const risa = backlogIds(changed((c) => (c.backlog.idPrefix = "RISA")));
    expect(risa).toMatchObject({ prefix: "RISA-", pattern: "RISA-\\d+" });
    expect(risa.id(772)).toBe("RISA-772");
    expect(risa.num("RISA-772")).toBe(772);
    expect(risa.normalize("12")).toBe("RISA-12");
    expect(risa.normalize("risa-12")).toBe("RISA-12");
    expect([
      risa.is("RISA-1"),
      risa.is("risa-1"),
      risa.is("B-1"),
      risa.is("RISA-"),
      risa.is("XRISA-1"),
    ]).toEqual([true, true, false, false, false]);
    expect(new RegExp(`\\((${risa.pattern})\\)`).exec("a line (RISA-9)")?.[1]).toBe("RISA-9");
    expect(risa.formerPrefix).toBeNull();
    expect(risa.lookupPattern).toBe(risa.pattern);
  });

  it("reads a former prefix's ids as its own, and makes none with it", () => {
    const risa = backlogIds(
      changed((c) => {
        c.backlog.idPrefix = "RISA";
        c.backlog.formerIdPrefix = "B";
      }),
    );
    expect(risa).toMatchObject({ prefix: "RISA-", pattern: "RISA-\\d+", formerPrefix: "B-" });
    expect(["B-772", "b-772", "RISA-772", "772"].map(risa.normalize)).toEqual(Array(4).fill("RISA-772"));
    expect([risa.is("B-1"), risa.is("b-1"), risa.is("XB-1"), risa.is("B-")]).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(risa.num("B-9")).toBe(9);
    expect(risa.id(9)).toBe("RISA-9");
    expect("B-1 RISA-2 XB-3 C-4".match(new RegExp(`\\b${risa.lookupPattern}\\b`, "g"))).toEqual([
      "B-1",
      "RISA-2",
    ]);
  });

  it("allows the prefixes the loader allows, and refuses the rest with one clear line", () => {
    const line = "backlog.idPrefix: must be an id prefix (capitals: B, RISA)";
    for (const p of ["B", "RISA", "R2"]) {
      const c = changed((c) => {
        c.backlog.idPrefix = p;
        c.backlog.zoneOverflowItem = `${p}-750`;
      });
      expect(configProblems(c), p).toEqual([]);
      expect(backlogIds(c).id(1)).toBe(`${p}-1`);
    }
    for (const p of ["b", "2R", "B-", "RI SA", ""]) {
      const c = changed((c) => (c.backlog.idPrefix = p));
      expect(configProblems(c), p).toEqual([line]);
      expect(() => backlogIds(c), p).toThrow(new ConfigError([line]));
    }
    expect(configProblems(changed((c) => (c.backlog.zoneOverflowItem = "R2X-750")))).toEqual([]);
    expect(configProblems(changed((c) => (c.backlog.zoneOverflowItem = "2R-750")))).toEqual([
      "backlog.zoneOverflowItem: must be a backlog id (B-12)",
    ]);
    expect(configProblems(changed((c) => (c.backlog.formerIdPrefix = c.backlog.idPrefix)))).toEqual([
      "backlog.formerIdPrefix: must differ from backlog.idPrefix",
    ]);
    expect(configProblems(changed((c) => (c.backlog.formerIdPrefix = "b")))).toEqual([
      "backlog.formerIdPrefix: must be an id prefix (capitals: B, RISA)",
    ]);
    expect(() => backlogIds(changed((c) => (c.backlog.formerIdPrefix = "b-")))).toThrow(
      "backlog.formerIdPrefix: must be an id prefix",
    );
  });
});

describe("branchKinds", () => {
  it("reads this repo's branches, and another's prefixes", () => {
    const here = branchKinds();
    expect(here.prefixes).toEqual(loadConfig({ path: FILE }).config.branches.prefixes);
    const other = branchKinds(
      changed((c) => {
        c.branches.trunk = "trunk";
        c.branches.protected = ["live"];
        c.branches.prefixes = { prd: "topic/", slice: "part/", plan: "draft/", hotfix: "quick/" };
      }),
    );
    expect(["topic/x", "part/x/2", "draft/x", "quick/x", "prd/x", "trunk"].map(other.kindOf)).toEqual([
      "prd",
      "slice",
      "plan",
      "hotfix",
      null,
      null,
    ]);
    expect([other.is("part/x/2", "slice"), other.is("slice/x/2", "slice")]).toEqual([true, false]);
    expect(other.branch("prd", "x")).toBe("topic/x");
    expect(other.branch("slice", "x", 2)).toBe("part/x/2");
    expect([other.sliceOf("part/x/2"), other.sliceOf("part/x"), other.sliceOf("part/x/2/3")]).toEqual([
      { topic: "x", n: "2" },
      null,
      null,
    ]);
    expect(["part/x/2", "topic/y", "quick/z/w", "slice/q/1", undefined].map(other.topicOf)).toEqual([
      "x",
      "y",
      "z",
      "",
      "",
    ]);
    expect([other.parentOf("part/x/2"), other.parentOf("topic/x")]).toEqual(["topic/x", "trunk"]);
    expect([other.nameOf("quick/a/b", "hotfix"), other.nameOf("topic/a", "hotfix")]).toEqual(["a/b", null]);
    expect(other.kept).toEqual(["trunk", "live"]);
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
    const r = bash('config_get hooks.stackUp; echo "rc=$?"; v=$(config_get paths.nope) || echo "none"');
    expect(r.stdout).toBe("rc=1\nnone\n");
    expect(r.stderr).toBe(
      `${CONFIG_NAME}: no value for hooks.stackUp\n${CONFIG_NAME}: no value for paths.nope\n`,
    );
  });

  it("takes lib.sh's trunk from the config, and TRUNK still wins", () => {
    expect(bash('echo "$trunk"').stdout).toBe(`${config.branches.trunk}\n`);
    expect(bash('echo "$trunk"', { TRUNK: "other" }).stdout).toBe("other\n");
    const sample = join(tmp, "sample.json");
    writeFileSync(sample, JSON.stringify(changed((c) => (c.branches.trunk = "trunk"))));
    expect(bash('echo "$trunk"', { RISA_CONFIG: sample }).stdout).toBe("trunk\n");
  });

  it("takes lib.sh's other names from the config: prefixes, files, exempt paths", () => {
    const sample = join(tmp, "names.json");
    writeFileSync(
      sample,
      JSON.stringify(
        changed((c) => {
          c.name = "acme";
          c.branches.protected = ["live"];
          c.branches.prefixes = { prd: "topic/", slice: "part/", plan: "draft/", hotfix: "quick/" };
          Object.assign(c.paths, { backlog: "todo/list.md", inbox: "todo/in.md", archive: "todo/old.md" });
          c.paths.tooling = ["tools", "acme.json"];
          delete c.paths.brakeList;
          c.paths.quarantine = "lists/q.txt";
        }),
      ),
    );
    const r = bash(
      [
        'echo "$project_name"',
        "parent_of part/x/3",
        "parent_of topic/x",
        "pr_branch x",
        "land_dir draft/y",
        'echo "${backlog_files[*]}|${ci_lists[*]}"',
        'printf \'a\\ntodo/in.md\\nlists/q.txt\\n\' | not_files "${backlog_files[@]}" "${ci_lists[@]}"',
        'for f in tools/a.sh acme.json acmexjson toolsx/a scripts/loops/x.sh docs/a.md app.ts; do grep -qE "$exempt_re" <<< "$f" && echo "exempt $f"; done',
      ].join("; "),
      { RISA_CONFIG: sample },
    );
    expect(r.stderr).toBe("");
    expect(r.stdout.replaceAll(`${ROOT}/.loops`, "$loops").replace(/^.*\.loops/m, "$loops")).toBe(
      [
        "acme",
        "topic/x",
        "dev",
        "topic/x",
        "$loops/plan-y",
        "todo/list.md todo/in.md todo/old.md|lists/q.txt",
        "a",
        "exempt tools/a.sh",
        "exempt acme.json",
        "exempt scripts/loops/x.sh",
        "exempt docs/a.md",
        "",
      ].join("\n"),
    );
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

// The tool's names for its own commands, the project's commands it runs, and how
// a command finds its repo: lib.sh's tool_command, project_command, run_project
// and find_repo, and config.mjs's toolCommands.
describe("commands through the config", () => {
  const sample = join(tmp, "commands.json");
  writeFileSync(
    sample,
    JSON.stringify(
      changed((c) => {
        c.tool = { prd: "risa", backlog: "risa backlog" };
        c.commands.typegen = "echo gen";
        c.commands.install = "printf '%s|' install";
        delete c.commands.hooksInstall;
        c.backlog.idPrefix = "RISA";
      }),
    ),
  );

  it("names the tool's own commands as configured, in Node and in bash", () => {
    const { config } = loadConfig({ path: FILE });
    expect(toolCommands()).toEqual({ prd: config.tool.prd, backlog: config.tool.backlog });
    expect(toolCommands(loadConfig({ path: sample }).config)).toEqual({
      prd: "risa",
      backlog: "risa backlog",
    });
    expect(bash("tool_command prd; tool_command backlog").stdout).toBe(
      `${config.tool.prd}\n${config.tool.backlog}\n`,
    );
    expect(bash("tool_command prd; tool_command backlog", { RISA_CONFIG: sample }).stdout).toBe(
      "risa\nrisa backlog\n",
    );
  });

  it("runs the configured command with its arguments, and 127 for one the config doesn't set", () => {
    const r = bash(
      'project_command typegen; run_project typegen "a b" c; run_project install x "y z"; echo; ' +
        'run_project hooksInstall; echo "rc=$?"; echo "$backlog_id_prefix"',
      { RISA_CONFIG: sample },
    );
    expect(r.stdout).toBe("echo gen\ngen a b c\ninstall|x|y z|\nrc=127\nRISA-\n");
    expect(r.stderr).toBe(`${CONFIG_NAME}: no value for commands.hooksInstall\n`);
  });

  it("runs a hook from the top of the checkout it is called in, with its arguments and stdin", () => {
    const hooked = join(tmp, "hooks.json");
    writeFileSync(
      hooked,
      JSON.stringify(changed((c) => (c.hooks = { checkAreas: "pwd; cat; printf '%s|'" }))),
    );
    const repo = realpathSync(mkdtempSync(join(tmp, "hook-repo-")));
    execFileSync("git", ["init", "-q", repo]);
    mkdirSync(join(repo, "a", "b"), { recursive: true });
    const r = spawnSync(
      "bash",
      [
        "-c",
        `source "${join(HERE, "lib.sh")}" && echo in | run_hook checkAreas resolve "x y"; ` +
          'run_hook docBudget land; echo "rc=$?"',
      ],
      { cwd: join(repo, "a", "b"), encoding: "utf8", env: env({ RISA_CONFIG: hooked }) },
    );
    expect(r.stdout).toBe(`${repo}\nin\nresolve|x y|rc=127\n`);
    expect(r.stderr).toBe(`${CONFIG_NAME}: no value for hooks.docBudget\n`);
  });

  it("finds the repo's main checkout and its .loops, from the main checkout and from a worktree", () => {
    const repo = realpathSync(mkdtempSync(join(tmp, "repo-")));
    const g = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: "pipe" });
    g("init", "-q", "-b", "dev");
    g("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init");
    g("worktree", "add", "-q", "-b", "prd/x", join(repo, ".loops", "x"));
    const found = (dir) => bash(`find_repo "${dir}" && echo "$main|$loops"`).stdout;
    expect(found(repo)).toBe(`${repo}|${repo}/.loops\n`);
    expect(found(join(repo, ".loops", "x"))).toBe(`${repo}|${repo}/.loops\n`);
    const r = bash(`find_repo "${tmp}"; echo "rc=$? <$main>"`);
    expect(r.stdout).toBe("rc=1 <>\n");
    // With no directory, the repo this tooling is in: today's answer, the first worktree.
    const first = execFileSync("git", ["-C", HERE, "worktree", "list", "--porcelain"], { encoding: "utf8" })
      .split("\n")[0]
      .replace(/^worktree /, "");
    expect(bash('echo "$main|$loops"; find_repo && echo "$main"').stdout).toBe(
      `${first}|${first}/.loops\n${first}\n`,
    );
  });
});
