// The check plan's engine on the sample project's rules (sample-project/tools/):
// this repo's own rules are its data, tested beside it (scripts/project/).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CheckPlanRulesError,
  checkPlan,
  checkPlanFor,
  checkPlanRulesProblems,
  parseArgs,
} from "./check-plan.mjs";
import { CONFIG_NAME, loadConfig } from "./config.mjs";
import { SAMPLE_CONFIG } from "./sample-project/repo.mjs";

const HERE = import.meta.dirname;
const CLI = join(HERE, "check-plan.mjs");
const SAMPLE = loadConfig({ path: SAMPLE_CONFIG });
const RULES = JSON.parse(readFileSync(join(SAMPLE.root, SAMPLE.config.paths.checkPlanRules), "utf8"));
const plan = checkPlanFor(SAMPLE);
const { planCheck, proposeTier, keepsVerdict, syncTier, declaredStatus, planToolingLint, riskyKind } = plan;

/** The sample with CI's two lists set, as a project with them has. */
const withLists = checkPlanFor({
  ...SAMPLE,
  config: {
    ...SAMPLE.config,
    paths: { ...SAMPLE.config.paths, brakeList: "ci/brakes.txt", quarantine: "ci/q.txt" },
  },
});

describe("the sample's rules", () => {
  it("load", () => {
    expect(checkPlanRulesProblems(RULES, ["lint", "test", "e2e"])).toEqual([]);
    expect(plan.PROPOSED_TIERS).toEqual(["none", "lint", "test", "e2e"]);
  });

  it("change the answers from this repo's", () => {
    // The same diffs, another project's rules: its tiers, its paths, its reasons.
    expect(proposeTier(["web/a.js"])).toEqual({ tier: "test", reason: "web code (web/a.js)" });
    expect(checkPlan().proposeTier(["web/a.js"]).reason).toBe("a file no rule covers (web/a.js)");
    expect(proposeTier(["lock.json"]).tier).toBe("e2e");
    expect(checkPlan().proposeTier(["lock.json"]).tier).toBe("full");
    expect(planCheck(["web/a.slow.test.js"], "slice").ownTests).toEqual(["web/a.slow.test.js"]);
    expect(checkPlan().planCheck(["web/a.slow.test.js"], "slice").ownTests).toEqual([]);
  });
});

describe("planCheck", () => {
  it.each(["db/migrations/1.sql", "lock.json", "package.json"])("a quick check on %s stays quick", (file) => {
    expect(planCheck(["web/a.js", file], "quick")).toMatchObject({ mode: "quick" });
    expect(planCheck(["web/a.js", file], "slice")).toMatchObject({ mode: "slice" });
  });

  it("keeps a plain diff quick, with no test files of its own", () => {
    expect(planCheck(["web/a.js", "docs/x.md"], "quick")).toEqual({
      mode: "quick",
      tooling: false,
      ownTests: [],
    });
  });

  it.each(["slice", "quick"])(
    "names the diff's own tests, once each, by the rules' pattern (%s)",
    (asked) => {
      const plan = planCheck(
        ["server/a.slow.test.js", "web/a.js", "web/a.test.js", "server/a.slow.test.js"],
        asked,
      );
      expect(plan).toEqual({ mode: asked, tooling: false, ownTests: ["server/a.slow.test.js"] });
    },
  );

  it("a full check names no test files", () => {
    expect(planCheck(["web/a.slow.test.js"], "full").ownTests).toEqual([]);
  });

  it.each([
    ["scripts/loops/prd.sh", "the core's own folder"],
    ["scripts/backlog/b.mjs", "the core's own folder"],
    ["tools/x.sh", "the config's paths.tooling"],
    ["Makefile", "the rules' tooling"],
  ])("joins the tooling tests for %s (%s)", (file) => {
    for (const asked of /** @type {const} */ (["slice", "quick", "full"]))
      expect(planCheck([file], asked).tooling).toBe(true);
  });

  it("leaves the tooling tests out of other diffs", () => {
    expect(planCheck(["web/a.js", "Makefile.local", "toolsx/a"], "quick").tooling).toBe(false);
  });

  it("handles an empty diff", () => {
    expect(planCheck([], "slice")).toEqual({ mode: "slice", tooling: false, ownTests: [] });
    expect(planCheck([], "full")).toEqual({ mode: "full", tooling: false, ownTests: [] });
  });
});

describe("proposeTier", () => {
  it.each([
    [["docs/a.md", "GUIDE.md"], "none", "docs and tooling only"],
    [["db/fixtures-notes.md"], "none", "docs and tooling only"],
    [["tools/x.sh", "Makefile", "scripts/loops/prd.sh"], "none", "docs and tooling only"],
    [["server/a.js"], "lint", "server code (server/a.js)"],
    [["web/a.js", "server/a.js"], "test", "web code (web/a.js)"],
    [["tools/harness/run.sh"], "test", "the browser harness (tools/harness/run.sh)"],
    [["e2e/a.spec.js"], "test", "the browser harness (e2e/a.spec.js)"],
    [["scripts/loops/lib.sh"], "test", "the browser harness (scripts/loops/lib.sh)"],
    [["db/migrations/1.sql"], "e2e", "a migration (db/migrations/1.sql)"],
    [["db/seed/FIXTURES.js"], "e2e", "the fixtures (db/seed/FIXTURES.js)"],
    [["web/package.json"], "e2e", "a package.json (web/package.json)"],
    [["web/a.js", "lock.json"], "e2e", "the lockfile (lock.json)"],
    [["other/a.js"], "e2e", "a file no rule covers (other/a.js)"],
    [[], "none", "no changes"],
  ])("%j proposes %s: %s", (files, tier, reason) => {
    expect(proposeTier(files)).toEqual({ tier, reason });
  });

  it("checks the suite's rules before the tier by path", () => {
    expect(proposeTier(["web/package.json"]).tier).toBe("e2e");
  });

  // A changed file named as a tooling folder is a symlink or gitlink in its place:
  // not in the folder, so not tooling (the old patterns wanted the slash too).
  it.each(["scripts/loops", "scripts/backlog", "tools"])(
    "a file at the folder path %s isn't tooling",
    (file) => {
      expect(proposeTier([file])).toEqual({ tier: "e2e", reason: `a file no rule covers (${file})` });
      expect(proposeTier([`${file}/x.sh`]).tier).not.toBe("e2e");
    },
  );
});

describe("reading the tier data", () => {
  it("waits until it is asked for: a broken tier file fails no import, and the CLI says so in one line", () => {
    const root = mkdtempSync(join(tmpdir(), "check-plan-tiers-"));
    try {
      const config = JSON.parse(readFileSync(SAMPLE_CONFIG, "utf8"));
      for (const rel of [config.paths.checkPlanRules, config.paths.tierData]) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        copyFileSync(join(SAMPLE.root, rel), join(root, rel));
      }
      writeFileSync(join(root, config.paths.tierData), "not json");
      writeFileSync(join(root, CONFIG_NAME), JSON.stringify(config));
      const env = { ...process.env, RISA_CONFIG: join(root, CONFIG_NAME) };
      const load = spawnSync("node", ["--input-type=module", "-e", `await import(${JSON.stringify(CLI)})`], {
        encoding: "utf8",
        env,
      });
      expect(load.stderr).toBe("");
      expect(load.status).toBe(0);
      const r = spawnSync("node", [CLI, "--mode", "slice"], { input: "web/a.js\n", encoding: "utf8", env });
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/^check-plan: .*tiers\.json: can't read the tier data/);
      expect(r.stderr.trim().split("\n")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("keepsVerdict and syncTier", () => {
  it.each([
    [["docs/a.md"], true],
    [["tools/x.sh", "work/plans/a.md"], true],
    [["tools/harness/run.sh"], false],
    [["web/a.js"], false],
  ])("keepsVerdict %j: %s", (files, kept) => {
    expect(keepsVerdict(files)).toBe(kept);
  });

  it("keeps a verdict over CI's two lists, when the config names them", () => {
    expect(withLists.keepsVerdict(["ci/q.txt", "ci/brakes.txt"])).toBe(true);
    expect(keepsVerdict(["ci/q.txt"])).toBe(false);
  });

  it.each([
    [["docs/a.md", "tools/x.sh"], [], "none"],
    [["tools/harness/run.sh", "work/backlog.md"], ["web/a.js"], "none"],
    [["tools/harness/run.sh"], ["tools/harness/run.sh"], "test"],
    [["server/a.js"], [], "lint"],
    [["lock.json"], [], "e2e"],
  ])("syncTier: brought %j, the branch touched %j: %s", (brought, touched, tier) => {
    expect(syncTier(brought, touched).tier).toBe(tier);
  });

  it("syncTier counts CI's two lists for nothing", () => {
    expect(withLists.syncTier(["ci/q.txt"], []).tier).toBe("none");
  });
});

describe("declaredStatus", () => {
  it.each([
    ["test", undefined, "ok"],
    ["test", "e2e", "ok"],
    ["test", "lint", "below"],
    ["test", "none", "refused"],
    ["none", "none", "ok"],
  ])("proposal %s, declared %s: %s", (proposed, declared, status) => {
    expect(declaredStatus(proposed, declared)).toBe(status);
  });
});

describe("riskyKind", () => {
  it.each([
    ["db/migrations/1.sql", "a migration"],
    ["web/package.json", "a package.json"],
    ["web/tsconfig.json", "a TypeScript config"],
    ["web/a.js", null],
    ["db/fixtures.md", null],
  ])("%s: %s", (file, kind) => {
    expect(riskyKind(file)).toBe(kind);
  });

  it("leaves CI's two lists off", () => {
    expect(withLists.riskyKind("ci/q.txt")).toBeNull();
    expect(withLists.isCiList("ci/brakes.txt")).toBe(true);
  });
});

describe("proposeTier on a package.json's contents", () => {
  const manifest = (fields) => `${JSON.stringify({ name: "a", version: "1.0.0", ...fields }, null, 2)}\n`;
  const propose = (file, base, head, others = []) =>
    proposeTier([...others, file], new Map([[file, { base, head }]]));

  it.each([
    ["added", manifest({}), manifest({ scripts: { dev: "vite" } })],
    ["edited", manifest({ scripts: { dev: "vite" } }), manifest({ scripts: { dev: "vite --host" } })],
    ["removed", manifest({ scripts: { dev: "vite" } }), manifest({})],
    ["a lifecycle hook", manifest({ scripts: {} }), manifest({ scripts: { postinstall: "node x.mjs" } })],
  ])("a scripts-only change asks for nothing: %s", (_, base, head) => {
    expect(propose("package.json", base, head).tier).toBe("none");
    expect(propose("web/package.json", base, head).tier).toBe("none");
  });

  it.each([
    ["a dependency", manifest({ dependencies: { a: "1.0.0" } }), manifest({ dependencies: { a: "1.0.1" } })],
    ["another field", manifest({ type: "module" }), manifest({ type: "commonjs" })],
    [
      "scripts and a field",
      manifest({ scripts: { a: "x" }, private: true }),
      manifest({ scripts: { a: "y" }, private: false }),
    ],
    [
      "the order of exports conditions",
      manifest({ exports: { import: "./a.mjs", default: "./a.cjs" } }),
      manifest({ exports: { default: "./a.cjs", import: "./a.mjs" } }),
    ],
    ["an added file", null, manifest({})],
    ["a deleted file", manifest({}), null],
    ["an unparseable base", "{ nope", manifest({})],
    ["an unparseable head", manifest({}), "{ nope"],
    ["a manifest that isn't an object", "[]", "[]"],
  ])("asks for the suite: %s", (_, base, head) => {
    expect(propose("web/package.json", base, head)).toEqual({
      tier: "e2e",
      reason: "a package.json (web/package.json)",
    });
  });

  it("asks for the suite for a package.json whose contents it wasn't given", () => {
    expect(proposeTier(["package.json"], new Map()).tier).toBe("e2e");
  });

  it("a scripts-only change beside a lockfile change still asks for the suite", () => {
    const forced = propose("package.json", manifest({}), manifest({ scripts: { a: "x" } }), ["lock.json"]);
    expect(forced).toEqual({ tier: "e2e", reason: "the lockfile (lock.json)" });
  });

  it("one scripts-only package.json doesn't excuse another that changed more", () => {
    const packages = new Map([
      ["package.json", { base: manifest({}), head: manifest({ scripts: { a: "x" } }) }],
      ["web/package.json", { base: manifest({}), head: manifest({ private: true }) }],
    ]);
    expect(proposeTier(["package.json", "web/package.json"], packages).reason).toContain("web/package.json");
  });
});

describe("planToolingLint", () => {
  it("lints and formats the changed tooling files", () => {
    expect(
      planToolingLint([
        "scripts/loops/prd.sh",
        "scripts/backlog/b.mjs",
        "tools/a.mjs",
        "Makefile",
        "tools/a.md",
      ]),
    ).toEqual({
      eslint: ["scripts/backlog/b.mjs", "tools/a.mjs"],
      prettier: ["scripts/loops/prd.sh", "scripts/backlog/b.mjs", "tools/a.mjs", "Makefile"],
    });
  });

  it("puts no lint step on a Markdown-only diff, and leaves other files to the check", () => {
    expect(planToolingLint(["GUIDE.md", "scripts/loops/notes.md"])).toEqual({ eslint: [], prettier: [] });
    expect(planToolingLint(["web/a.js"]).prettier).toEqual([]);
  });
});

describe("the rules file", () => {
  it.each([
    [(r) => delete r.ownTests, "ownTests: missing"],
    [(r) => delete r.suite, "suite: missing"],
    [(r) => (r.nope = 1), "nope: unknown key"],
    [(r) => (r.ownTests = "("), "ownTests: not a regular expression"],
    [(r) => (r.suite.tier = "full"), "suite.tier: not a tier (lint, test, e2e)"],
    [(r) => (r.suite.rules[0].flags = "g"), "suite.rules.0.match: flags: must be some of i, m, s, u"],
    [(r) => (r.suite.rules[0].why = ""), "suite.rules.0.why: must be one line of text"],
    [(r) => (r.suite.rules[0].tier = "e2e"), "suite.rules.0.tier: unknown key"],
    [(r) => delete r.byPath[0].tier, "byPath.0.tier: not a tier"],
    [(r) => (r.browserHarness.paths = ["/abs"]), "browserHarness.paths.0: must be a path"],
    [(r) => (r.tooling = "Makefile"), "tooling: must be a list of paths"],
    [(r) => (r.reachesCode = {}), "reachesCode: must be a list of { match, why }"],
  ])("names what is wrong: %s", (change, problem) => {
    const rules = structuredClone(RULES);
    change(rules);
    expect(checkPlanRulesProblems(rules, ["lint", "test", "e2e"]).join("\n")).toContain(problem);
  });

  it("refuses a config that names no rules file, or one that won't load", () => {
    const paths = SAMPLE.config.paths;
    const without = {
      ...SAMPLE,
      config: { ...SAMPLE.config, paths: { ...paths, checkPlanRules: undefined } },
    };
    expect(() => checkPlanFor(without)).toThrow(/sets no paths\.checkPlanRules/);
    const missing = {
      ...SAMPLE,
      config: { ...SAMPLE.config, paths: { ...paths, checkPlanRules: "nope.json" } },
    };
    expect(() => checkPlanFor(missing)).toThrow(CheckPlanRulesError);
  });

  it("a project with no browser harness never needs it", () => {
    const dir = mkdtempSync(join(tmpdir(), "check-plan-rules-"));
    try {
      const { browserHarness: _, ...rest } = RULES;
      writeFileSync(join(dir, "rules.json"), JSON.stringify(rest));
      copyFileSync(join(SAMPLE.root, SAMPLE.config.paths.tierData), join(dir, "tiers.json"));
      const bare = checkPlanFor({
        config: {
          ...SAMPLE.config,
          paths: { ...SAMPLE.config.paths, checkPlanRules: "rules.json", tierData: "tiers.json" },
        },
        root: dir,
      });
      expect(bare.needsBrowserHarness(["scripts/loops/browser.sh", "tools/harness/a"])).toBe(false);
      expect(bare.proposeTier(["scripts/loops/lib.sh"]).tier).toBe("none");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("check-plan.mjs CLI, on the sample project", () => {
  const env = { ...process.env, RISA_CONFIG: SAMPLE_CONFIG };
  const cli = (mode, files) =>
    spawnSync("node", [CLI, "--mode", mode], { input: files.join("\n"), encoding: "utf8", env }).stdout.split(
      "\n",
    );

  it("a quick check asked on a migration diff stays quick", () => {
    expect(cli("quick", ["db/migrations/1.sql"]).slice(0, 3)).toEqual(["quick", "0", ""]);
  });

  it("a quick check on a tooling diff joins the tooling tests and lists the diff's own test files", () => {
    expect(cli("quick", ["tools/x.sh", "web/a.slow.test.js"]).slice(0, 3)).toEqual([
      "quick",
      "1",
      "web/a.slow.test.js",
    ]);
  });

  it("says 2 when the browser harness joins", () => {
    expect(cli("slice", ["tools/harness/run.sh"]).slice(0, 2)).toEqual(["slice", "2"]);
  });

  it("an unknown mode is a full check", () => {
    expect(cli("other", ["web/a.js"])[0]).toBe("full");
  });

  it("--propose reads --base and --head from git, and without them any package.json asks for the suite", () => {
    const repo = mkdtempSync(join(tmpdir(), "check-plan-"));
    const git = (...args) =>
      execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        encoding: "utf8",
      }).trim();
    const commit = (file, text) => {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), text);
      git("add", ".");
      git("commit", "-qm", "c");
      return git("rev-parse", "HEAD");
    };
    const withRefs = (base, head, file) =>
      spawnSync("node", [CLI, "--propose", "--repo", repo, "--base", base, "--head", head], {
        input: file,
        encoding: "utf8",
        env,
      }).stdout.split("\n")[0];
    try {
      git("init", "-q");
      const file = "web/package.json";
      const first = commit(file, '{"name":"a","scripts":{"x":"1"}}\n');
      const scripts = commit(file, '{"name":"a","scripts":{"x":"2"}}\n');
      const version = commit(file, '{"name":"a","version":"2.0.0","scripts":{"x":"2"}}\n');
      expect(withRefs(first, scripts, file)).toBe("none");
      expect(withRefs(scripts, version, file)).toBe("e2e");
      // With --base the diff is its own: what's piped in doesn't count.
      expect(withRefs(first, scripts, "")).toBe("none");
      expect(withRefs(first, first, file)).toBe("none");
      const bare = spawnSync("node", [CLI, "--propose"], { input: file, encoding: "utf8", env });
      expect(bare.stdout.split("\n")[0]).toBe("e2e");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  /**
   * Runs the CLI with stdin left open (never written or closed), as a terminal's would be.
   * @param {string[]} args
   * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
   */
  const openStdin = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn("node", [CLI, ...args], { stdio: ["pipe", "pipe", "pipe"], env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`check-plan.mjs ${args.join(" ")} waited on stdin`));
      }, 10_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        child.stdin.destroy();
        resolve({ code, stdout, stderr });
      });
    });

  it("--base dev alone exits 2 at once with usage, stdin left open", async () => {
    const r = await openStdin(["--base", "dev"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("give --mode or --propose");
    expect(r.stderr).toContain("usage: check-plan.mjs");
    expect(r.stdout).toBe("");
  });

  it.each([[["--propose", "--nope"]], [["--mode", "quick", "--verbose"]], [["--propose", "--base"]]])(
    "%j exits 2 at once with stdin left open",
    async (args) => {
      const r = await openStdin(args);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("usage: check-plan.mjs");
    },
  );

  it("--propose --base on a repo with changes computes the diff itself, stdin left open", async () => {
    const repo = mkdtempSync(join(tmpdir(), "check-plan-"));
    const git = (...args) =>
      execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        encoding: "utf8",
      }).trim();
    try {
      git("init", "-q", "-b", "trunk");
      writeFileSync(join(repo, "README.md"), "a\n");
      git("add", ".");
      git("commit", "-qm", "base");
      git("checkout", "-qb", "work");
      mkdirSync(join(repo, "web"), { recursive: true });
      writeFileSync(join(repo, "web/a.js"), "export {};\n");
      git("add", ".");
      git("commit", "-qm", "web");
      const r = await openStdin(["--propose", "--repo", repo, "--base", "trunk"]);
      expect(r.code).toBe(0);
      expect(r.stdout.split("\n").slice(0, 3)).toEqual(["test", "web code (web/a.js)", "ok"]);
      const declared = await openStdin([
        "--propose",
        "--repo",
        repo,
        "--base",
        "trunk",
        "--head",
        "work",
        "--declared",
        "lint",
      ]);
      expect(declared.stdout.split("\n")[2]).toBe("below");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a declared tier the project doesn't have", () => {
    const r = spawnSync("node", [CLI, "--propose", "--declared", "full"], {
      input: "",
      encoding: "utf8",
      env,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown tier full (none, lint, test, e2e)");
  });

  it("--propose with a base git can't resolve exits 1", () => {
    const r = spawnSync("node", [CLI, "--propose", "--repo", HERE, "--base", "no-such-ref-x"], {
      input: "",
      encoding: "utf8",
      env,
    });
    expect(r.status).toBe(1);
  });

  it("--propose without --base still reads the changed files from stdin (propose_tier's old way)", () => {
    const r = spawnSync("node", [CLI, "--propose"], {
      input: "server/a.js\ndocs/x.md\n",
      encoding: "utf8",
      env,
    });
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n").slice(0, 3)).toEqual(["lint", "server code (server/a.js)", "ok"]);
  });
});

describe("parseArgs", () => {
  it("takes --mode with prd check's refs", () => {
    expect(parseArgs(["--mode", "slice", "--repo", "d", "--base", "b", "--head", "HEAD"])).toEqual({
      ok: true,
      propose: false,
      opts: { mode: "slice", repo: "d", base: "b", head: "HEAD" },
    });
  });

  it.each([
    [[], "give --mode or --propose"],
    [["--base", "dev"], "give --mode or --propose"],
    [["--propose", "--mode", "quick"], "don't go together"],
    [["--propose", "--frobnicate"], "unknown argument --frobnicate"],
    [["--propose", "dev"], "unknown argument dev"],
    [["--mode"], "--mode needs a value"],
    [["--propose", "--base", "--head", "x"], "--base needs a value"],
    [["--propose", "--head", "x"], "--head needs --base"],
  ])("%j is refused: %s", (argv, error) => {
    const r = parseArgs(argv);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toContain(error);
  });
});
