// risa config migrate and risa init (loops/setup.mjs), through bin/risa, on temp repos
// (makeRepo's, or a bare git repo): the move to the .risa folder form and a new
// project's files, each refusal exiting 2 with one line and changing nothing. Every
// machine config here is a temp file, none the machine's.
import { execFileSync, spawnSync } from "node:child_process";
import {
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
import { afterAll, describe, expect, it } from "vitest";
import { tiersFrom } from "../ci/tier-data.mjs";
import { checkPlanFor } from "./check-plan.mjs";
import { CONFIG_DIR, CONFIG_FILE, CONFIG_NAME, loadConfig } from "./config.mjs";
import { SAMPLE_CONFIG, makeRepo } from "./sample-project/repo.mjs";
import { initFiles, migratePlan } from "./setup.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const RISA = join(HERE, "../bin/risa");
const CONFIG_CLI = join(HERE, "config.mjs");
const BACKLOG = join(HERE, "../backlog/backlog.mjs");
const CHECK_PLAN = join(HERE, "check-plan.mjs");
const CHECK_HOOK = join(HERE, "check-hook.sh");
const PROJECT_CHECK = join(HERE, "project-check.mjs");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "setup-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const machine = join(tmp, "machine.json");
writeFileSync(machine, JSON.stringify({ repos: [] }));
const { RISA_CONFIG: _c, RISA_CONFIG_FOUND: _f, RISA_MAIN: _m, ...base } = process.env;
const env = { ...base, RISA_MACHINE_CONFIG: machine };

const git = (/** @type {string} */ cwd, /** @type {string[]} */ ...a) =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const run = (/** @type {string} */ cwd, /** @type {string[]} */ args, extra = {}) =>
  spawnSync(RISA, args, { cwd, encoding: "utf8", env: { ...env, ...extra } });
/** The repo's state: status, staged names, HEAD, and every file's text under the root. */
const state = (/** @type {string} */ root) =>
  [
    git(root, "status", "--porcelain", "--untracked-files=all"),
    git(root, "diff", "--cached", "--name-status"),
    git(root, "rev-list", "--all", "--count"),
    git(root, "ls-files", "--others", "--cached", "--exclude-standard"),
  ].join("\n---\n");
const configCheck = (/** @type {string} */ root) =>
  spawnSync("node", [CONFIG_CLI, "check"], {
    cwd: root,
    encoding: "utf8",
    env: { ...env, RISA_CONFIG: join(root, CONFIG_DIR) },
  });

// A sample config in the risa.json form naming its tier data and quarantine by key (the
// two to move), a brake list whose file is missing (kept), and risa.json as tooling.
const oldConfig = join(tmp, "old-config", CONFIG_NAME);
const raw = JSON.parse(readFileSync(SAMPLE_CONFIG, "utf8"));
raw.paths.quarantine = "tools/quarantine.txt";
raw.paths.brakeList = "tools/brake-list.txt";
raw.paths.tooling = ["tools", CONFIG_NAME];
delete raw.paths.checkPlanRules;
mkdirSync(join(tmp, "old-config", "tools"), { recursive: true });
writeFileSync(oldConfig, `${JSON.stringify(raw, null, 2)}\n`);
writeFileSync(
  join(tmp, "old-config", "tools/tiers.json"),
  readFileSync(join(HERE, "sample-project/tools/tiers.json")),
);
const oldRepo = () => {
  const root = mkdtempSync(join(tmp, "old-"));
  makeRepo(root, { config: oldConfig, files: { "tools/quarantine.txt": "flaky.test.mjs\n" } });
  return root;
};

describe("risa config migrate", () => {
  it("plans the moves and the new config, keeping a key whose file is missing", () => {
    const plan = migratePlan({
      root: "/r",
      raw,
      exists: (rel) => ["tools/tiers.json", "tools/quarantine.txt"].includes(rel),
    });
    expect(plan.moves).toEqual([
      [CONFIG_NAME, `${CONFIG_DIR}/${CONFIG_FILE}`],
      ["tools/tiers.json", `${CONFIG_DIR}/tiers.json`],
      ["tools/quarantine.txt", `${CONFIG_DIR}/quarantine.txt`],
    ]);
    const paths = JSON.parse(plan.text).paths;
    expect(paths.tierData).toBeUndefined();
    expect(paths.quarantine).toBeUndefined();
    expect(paths.brakeList).toBe("tools/brake-list.txt");
    expect(paths.tooling).toEqual(["tools", CONFIG_DIR]);
    expect(plan.text.endsWith("}\n")).toBe(true);
    expect(plan.text).toContain('\n  "paths": {\n    "backlog"');
  });

  it("moves the config and the named files into the folder, staged, not committed", () => {
    const root = oldRepo();
    const r = run(root, ["config", "migrate"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`moved ${CONFIG_NAME} → ${CONFIG_DIR}/${CONFIG_FILE}`);
    expect(r.stdout).toContain(`moved tools/tiers.json → ${CONFIG_DIR}/tiers.json`);
    expect(r.stdout).toContain(`moved tools/quarantine.txt → ${CONFIG_DIR}/quarantine.txt`);
    expect(r.stdout).toMatch(/git commit -m/);
    expect(git(root, "rev-list", "--all", "--count")).toBe("1");
    expect(git(root, "status", "--porcelain")).toBe(
      [
        `R  ${CONFIG_NAME} -> ${CONFIG_DIR}/${CONFIG_FILE}`,
        `R  tools/quarantine.txt -> ${CONFIG_DIR}/quarantine.txt`,
        `R  tools/tiers.json -> ${CONFIG_DIR}/tiers.json`,
      ].join("\n"),
    );
    const text = readFileSync(join(root, CONFIG_DIR, CONFIG_FILE), "utf8");
    const moved = JSON.parse(text);
    expect(moved.paths.tierData).toBeUndefined();
    expect(moved.paths.quarantine).toBeUndefined();
    expect(moved.paths.brakeList).toBe("tools/brake-list.txt");
    expect(moved.paths.tooling).toEqual(["tools", CONFIG_DIR]);
    expect(text).toBe(`${JSON.stringify(moved, null, 2)}\n`);
    // The loader finds the two by their default names.
    const loaded = loadConfig({ path: join(root, CONFIG_DIR, CONFIG_FILE) });
    expect(loaded.root).toBe(root);
    expect(loaded.config.paths.tierData).toBe(`${CONFIG_DIR}/tiers.json`);
    expect(loaded.config.paths.quarantine).toBe(`${CONFIG_DIR}/quarantine.txt`);
    expect(readFileSync(join(root, loaded.config.paths.quarantine), "utf8")).toBe("flaky.test.mjs\n");
    const check = configCheck(root);
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
  });

  it("--dry-run prints the moves and changes nothing", () => {
    const root = oldRepo();
    const before = state(root);
    const r = run(root, ["config", "migrate", "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`would move tools/tiers.json → ${CONFIG_DIR}/tiers.json`);
    expect(r.stdout).toContain("nothing changed");
    expect(state(root)).toBe(before);
    expect(existsSync(join(root, CONFIG_DIR))).toBe(false);
  });

  const refusals = /** @type {const} */ ([
    ["outside a repo", () => mkdtempSync(join(tmp, "bare-")), /not in a git repo/],
    [
      "with no risa.json",
      () => {
        const root = mkdtempSync(join(tmp, "none-"));
        git(root, "init", "-q", "-b", "main");
        return root;
      },
      /no risa\.json/,
    ],
    [
      "with the folder present",
      () => {
        const root = oldRepo();
        mkdirSync(join(root, CONFIG_DIR));
        writeFileSync(join(root, CONFIG_DIR, "note.txt"), "x\n");
        return root;
      },
      /already there/,
    ],
    [
      "with a moved file dirty",
      () => {
        const root = oldRepo();
        writeFileSync(join(root, "tools/quarantine.txt"), "other.test.mjs\n");
        return root;
      },
      /tools\/quarantine\.txt: uncommitted/,
    ],
  ]);
  it.each(refusals)("refuses %s: exit 2, one line, nothing changed", (_what, make, line) => {
    const root = make();
    const inRepo = existsSync(join(root, ".git"));
    const before = inRepo ? state(root) : "";
    const r = run(root, ["config", "migrate"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(line);
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    if (inRepo) expect(state(root)).toBe(before);
  });
});

describe("risa init", () => {
  const fresh = () => {
    const root = mkdtempSync(join(tmp, "new-"));
    git(root, "init", "-q", "-b", "trunk");
    return root;
  };
  const args = ["init", "--name", "acme", "--trunk", "trunk", "--check", "make check"];

  it("writes a config that loads, and a backlog the backlog tool reads", () => {
    const root = fresh();
    const r = run(root, args);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    for (const rel of Object.keys(initFiles({ name: "acme" })))
      expect(existsSync(join(root, rel))).toBe(true);
    expect(r.stdout).toContain(JSON.stringify({ path: root, work: true }));
    expect(r.stdout).toMatch(/git commit -m/);
    expect(git(root, "rev-list", "--all", "--count")).toBe("0");
    const check = configCheck(root);
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
    const { config } = loadConfig({ path: join(root, CONFIG_DIR, CONFIG_FILE) });
    expect(config.backlog.idPrefix).toBe("ACME");
    expect(config.branches.trunk).toBe("trunk");
    expect(config.commands.check).toBe("make check");
    expect(config.hooks.check).toBe("sh -c 'make check' check");
    expect(config.paths.tooling).toEqual([CONFIG_DIR]);
    const backlog = (/** @type {string[]} */ ...a) =>
      spawnSync("node", [BACKLOG, ...a], {
        cwd: root,
        encoding: "utf8",
        env: { ...env, RISA_CONFIG: join(root, CONFIG_DIR) },
      });
    for (const a of [["list"], ["doctor"], ["prd", "list"]]) {
      const b = backlog(...a);
      expect(b.stderr, a.join(" ")).toBe("");
      expect(b.status, a.join(" ")).toBe(0);
    }
  });

  it("writes a check risa check can run: the planner's rules, the tier data, the check hook", () => {
    const root = fresh();
    // The check prints the arguments it got: none, whatever check-hook.sh appends.
    const check = `node -e 'console.log("args:", JSON.stringify(process.argv.slice(1)))'`;
    expect(run(root, ["init", "--name", "acme", "--check", check]).status).toBe(0);
    const at = { ...env, RISA_CONFIG: join(root, CONFIG_DIR) };
    expect(configCheck(root).status).toBe(0);
    const project = loadConfig({ path: join(root, CONFIG_DIR, CONFIG_FILE) });
    expect(project.config.paths.tierData).toBe(`${CONFIG_DIR}/tiers.json`);
    expect(project.config.paths.checkPlanRules).toBe(`${CONFIG_DIR}/check-plan.json`);
    const tiers = tiersFrom(JSON.parse(readFileSync(join(root, project.config.paths.tierData), "utf8")));
    expect(tiers.TIERS).toEqual(["check"]);
    expect(tiers.narrowedJobs(["src/a.c"])).toEqual(["check"]);
    expect(tiers.ciRefName("check", "slice/x/1")).toBe("ci/check/slice-x-1");
    const plan = checkPlanFor(project);
    expect(plan.proposeTier(["src/a.c"])).toEqual({
      tier: "check",
      reason: "a file no rule covers (src/a.c)",
    });
    expect(plan.planCheck(["src/a.integration.test.js", "src/a.c"], "slice")).toMatchObject({
      mode: "slice",
      ownTests: ["src/a.integration.test.js"],
    });
    // The planner's CLI as prd.sh runs it: no "sets no" refusal.
    const planned = spawnSync("node", [CHECK_PLAN, "--mode", "slice"], {
      cwd: root,
      encoding: "utf8",
      env: at,
      input: "src/a.c\n",
    });
    expect(planned.stderr).toBe("");
    expect(planned.stdout.split("\n")[0]).toBe("slice");
    // The check hook as check-hook.sh runs it, mode, base and own test files appended.
    const hooked = spawnSync("bash", [CHECK_HOOK, "slice", "HEAD", "0", "a.integration.test.js"], {
      cwd: root,
      encoding: "utf8",
      env: at,
    });
    expect(hooked.stderr).toBe("");
    expect(hooked.status).toBe(0);
    expect(hooked.stdout).toContain("args: []");
  });

  it("writes a repo the project-data check passes straight after init", () => {
    const root = fresh();
    // The repo's own agents doc: init names it, never writes it.
    writeFileSync(join(root, "AGENTS.md"), "# Acme: agents\n");
    const r = run(root, args);
    expect(r.status).toBe(0);
    for (const rel of ["docs/preferences.md", "docs/planner.md", "plans/fixes-rules.md"])
      expect(r.stdout).toContain(`wrote ${rel}`);
    expect(r.stdout).not.toMatch(/kept|no role names|add them/);
    expect(r.stdout).toContain("git add .risa plans docs");
    const checked = spawnSync("node", [PROJECT_CHECK], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, RISA_CONFIG: join(root, CONFIG_DIR) },
    });
    expect(checked.stdout + checked.stderr).toBe("project-check: ok\n");
    expect(checked.status).toBe(0);
  });

  it("keeps the brief's docs already there, overwriting nothing, and names the steps they need", () => {
    const root = fresh();
    const ours = {
      "docs/preferences.md": "# Ours\n\nNo never list here.\n",
      "docs/notes.md": "# Notes\n",
      "plans/fixes-rules.md": "# Our fixes rules\n",
    };
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, "plans"));
    for (const [rel, text] of Object.entries(ours)) writeFileSync(join(root, rel), text);
    const r = run(root, args);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    for (const [rel, text] of Object.entries(ours)) expect(readFileSync(join(root, rel), "utf8")).toBe(text);
    expect(r.stdout).toContain("kept docs/preferences.md (already there)");
    expect(r.stdout).toContain("kept plans/fixes-rules.md (already there)");
    expect(r.stdout).toContain("wrote docs/planner.md");
    expect(r.stdout).toMatch(/docs\/preferences\.md \(paths\.preferences\) has no never list/);
    expect(r.stdout).toMatch(/docs\/notes\.md: no role names it/);
    // A kept doc that reads for the brief needs no step.
    const good = fresh();
    mkdirSync(join(good, "docs"));
    const prefs = initFiles({ name: "acme", date: "2026-01-02" })["docs/preferences.md"] ?? "";
    writeFileSync(join(good, "docs/preferences.md"), prefs);
    const g = run(good, args);
    expect(g.status).toBe(0);
    expect(g.stdout).toContain("kept docs/preferences.md (already there)");
    expect(g.stdout).not.toMatch(/never list|no role names/);
    expect(readFileSync(join(good, "docs/preferences.md"), "utf8")).toBe(prefs);
  });

  it("a failing --check fails the check hook", () => {
    const root = fresh();
    expect(run(root, ["init", "--name", "acme", "--check", "exit 3"]).status).toBe(0);
    const hooked = spawnSync("bash", [CHECK_HOOK, "quick", "HEAD", "0"], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, RISA_CONFIG: join(root, CONFIG_DIR) },
    });
    expect(hooked.status).toBe(3);
  });

  it.each(
    /** @type {const} */ ([
      ["a second run", (/** @type {string} */ root) => run(root, args)],
      [
        "a repo with risa.json",
        (/** @type {string} */ root) => writeFileSync(join(root, CONFIG_NAME), "{}\n"),
      ],
      [
        "a repo with plans/backlog.md",
        (/** @type {string} */ root) => {
          mkdirSync(join(root, "plans"));
          writeFileSync(join(root, "plans/backlog.md"), "# Ours\n");
        },
      ],
    ]),
  )("refuses %s: exit 2, one line, nothing changed", (_what, setUp) => {
    const root = fresh();
    setUp(root);
    const before = state(root);
    const r = run(root, args);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(state(root)).toBe(before);
  });

  it("refuses a bad --name with the loader's line, writing nothing", () => {
    const root = fresh();
    const r = run(root, ["init", "--name", "acme_corp"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^risa init: \.risa\/config\.json: name: must be a lowercase name/);
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(existsSync(join(root, CONFIG_DIR))).toBe(false);
  });
});
