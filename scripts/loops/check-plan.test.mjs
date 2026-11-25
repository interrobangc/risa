import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  declaredStatus,
  keepsVerdict,
  parseArgs,
  planCheck,
  planToolingLint,
  proposeTier,
  syncTier,
} from "./check-plan.mjs";

const ROOT = join(import.meta.dirname, "../..");

describe("planCheck", () => {
  it.each([
    "packages/data/src/db/migrations/0042_x.sql",
    "packages/data/scripts/seed.ts",
    "powersync/sync-config.yaml",
    "pnpm-lock.yaml",
    "package.json",
    "vitest.config.ts",
  ])("a quick check on %s stays quick", (file) => {
    expect(planCheck(["apps/web/app/a.ts", file], "quick")).toMatchObject({ mode: "quick" });
    expect(planCheck(["apps/web/app/a.ts", file], "slice")).toMatchObject({ mode: "slice" });
  });

  it("keeps a plain app diff quick, with no test files of its own", () => {
    const plan = planCheck(["apps/web/app/routes/a.tsx", "docs/x.md"], "quick");
    expect(plan).toEqual({ mode: "quick", tooling: false, ownTests: [] });
  });

  it.each(["slice", "quick"])("names the diff's own integration and component tests (%s)", (asked) => {
    const plan = planCheck(
      [
        "packages/api/src/syncTodos.int.test.ts",
        "apps/web/app/routes/a.browser.test.tsx",
        "apps/web/app/routes/a.tsx",
        "apps/web/app/lib/a.test.ts",
        "scripts/browser-checks/a.spec.mjs",
        "packages/api/src/syncTodos.int.test.ts",
      ],
      asked,
    );
    expect(plan.mode).toBe(asked);
    expect(plan.ownTests).toEqual([
      "packages/api/src/syncTodos.int.test.ts",
      "apps/web/app/routes/a.browser.test.tsx",
    ]);
  });

  it("a full check names no test files", () => {
    expect(planCheck(["apps/web/app/routes/a.browser.test.tsx"], "full").ownTests).toEqual([]);
  });

  it.each([
    "scripts/loops/prd.sh",
    "scripts/backlog/b.mjs",
    ".githooks/commit-msg",
    "scripts/hooks.test.mjs",
    "risa.json",
    "scripts/project/a.mjs",
  ])("joins the tooling tests for %s", (file) => {
    expect(planCheck([file], "slice").tooling).toBe(true);
    expect(planCheck([file], "quick").tooling).toBe(true);
    expect(planCheck([file], "full").tooling).toBe(true);
  });

  it("leaves the tooling tests out of an app diff", () => {
    expect(planCheck(["apps/web/app/a.ts", "scripts/deploy/x.mjs"], "quick").tooling).toBe(false);
  });

  it("handles an empty diff", () => {
    expect(planCheck([], "slice")).toMatchObject({ mode: "slice", tooling: false, ownTests: [] });
    expect(planCheck([], "quick")).toMatchObject({ mode: "quick", tooling: false, ownTests: [] });
    expect(planCheck([], "full")).toMatchObject({ mode: "full", tooling: false });
  });
});

describe("proposeTier", () => {
  it.each([
    [["docs/a.md", "plans/b.md", "AGENTS.md"], "none"],
    [["scripts/loops/prd.sh", "scripts/backlog/b.mjs", ".githooks/commit-msg"], "none"],
    [["scripts/project/a.mjs", "scripts/project/a.test.mjs", "scripts/project/rules.json"], "none"],
    [["packages/data/src/seed-notes.md"], "none"],
    [["scripts/loops/browser.sh"], "integration"],
    [["scripts/loops/lib.sh", "docs/a.md"], "integration"],
    [["scripts/browser-checks/a.spec.mjs"], "integration"],
    [["apps/web/app/a.tsx"], "components"],
    [["packages/api/src/a.ts"], "integration"],
    [["packages/api/src/a.ts", "apps/web/app/a.tsx"], "components"],
    [["packages/data/src/db/migrations/0042_x.sql"], "full"],
    [["packages/data/scripts/seed.ts"], "full"],
    [["powersync/sync-config.yaml"], "full"],
    [["pnpm-lock.yaml"], "full"],
    [["apps/web/package.json"], "full"],
    [["vitest.config.ts"], "full"],
    [[".github/workflows/ci.yml"], "full"],
    [["scripts/ci/ci.mjs"], "full"],
    [["eslint.config.js"], "full"],
    [["apps/web/app/a.tsx", "pnpm-lock.yaml"], "full"],
    [[], "none"],
  ])("%j proposes %s", (files, tier) => {
    expect(proposeTier(files).tier).toBe(tier);
  });

  it("names the file behind the proposal", () => {
    const { reason } = proposeTier(["docs/a.md", "packages/data/src/db/migrations/0042_x.sql"]);
    expect(reason).toContain("a migration");
    expect(reason).toContain("0042_x.sql");
  });
});

describe("keepsVerdict", () => {
  it.each([
    [["docs/a.md"], true],
    [["scripts/loops/prd.sh", "plans/a.md"], true],
    [["scripts/ci/quarantine.txt", "scripts/ci/brake-list.txt"], true],
    [["scripts/loops/browser.sh"], false],
    [["scripts/ci/ci.mjs"], false],
    [["apps/web/app/a.tsx"], false],
  ])("%j: %s", (files, kept) => {
    expect(keepsVerdict(files)).toBe(kept);
  });
});

describe("syncTier", () => {
  it.each([
    [["docs/a.md", "scripts/backlog/backlog.mjs"], [], "none"],
    // fixes-bug 82a3cf1b: dev brought lib.sh, and the carry broke on it
    [["scripts/loops/lib.sh", "scripts/loops/land.sh", "plans/backlog.md"], ["apps/web/a.tsx"], "none"],
    [["scripts/loops/lib.sh"], ["scripts/loops/lib.sh"], "integration"],
    [["scripts/ci/quarantine.txt"], [], "none"],
    [["packages/data/src/a.ts", "docs/a.md"], [], "integration"],
    [["apps/web/a.tsx"], [], "components"],
    [["pnpm-lock.yaml"], [], "full"],
  ])("brought %j, the branch touched %j: %s", (brought, touched, tier) => {
    expect(syncTier(brought, touched).tier).toBe(tier);
  });
});

describe("declaredStatus", () => {
  it.each([
    ["components", undefined, "ok"],
    ["components", "components", "ok"],
    ["components", "full", "ok"],
    ["components", "integration", "below"],
    ["components", "none", "refused"],
    ["none", "none", "ok"],
    ["none", "unit", "ok"],
  ])("proposal %s, declared %s: %s", (proposed, declared, status) => {
    expect(declaredStatus(proposed, declared)).toBe(status);
  });
});

describe("proposeTier on a package.json's contents", () => {
  const manifest = (fields) => `${JSON.stringify({ name: "a", version: "1.0.0", ...fields }, null, 2)}\n`;
  const plan = (file, base, head, others = []) =>
    proposeTier([...others, file], new Map([[file, { base, head }]]));

  it.each([
    ["added", manifest({}), manifest({ scripts: { dev: "vite" } })],
    ["edited", manifest({ scripts: { dev: "vite" } }), manifest({ scripts: { dev: "vite --host" } })],
    ["removed", manifest({ scripts: { dev: "vite" } }), manifest({})],
    ["a lifecycle hook", manifest({ scripts: {} }), manifest({ scripts: { postinstall: "node x.mjs" } })],
  ])("a scripts-only change asks for nothing: %s", (_, base, head) => {
    expect(plan("package.json", base, head).tier).toBe("none");
    expect(plan("packages/data/package.json", base, head).tier).toBe("none");
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
  ])("proposes full: %s", (_, base, head) => {
    const forced = plan("apps/web/package.json", base, head);
    expect(forced.tier).toBe("full");
    expect(forced.reason).toContain("a package.json");
  });

  it("proposes full for a package.json whose contents it wasn't given", () => {
    expect(proposeTier(["package.json"], new Map()).tier).toBe("full");
  });

  it("a scripts-only change beside a lockfile change still proposes full", () => {
    const forced = plan("package.json", manifest({}), manifest({ scripts: { a: "x" } }), ["pnpm-lock.yaml"]);
    expect(forced.tier).toBe("full");
    expect(forced.reason).toContain("the lockfile");
  });

  it("one scripts-only package.json doesn't excuse another that changed more", () => {
    const packages = new Map([
      ["package.json", { base: manifest({}), head: manifest({ scripts: { a: "x" } }) }],
      ["apps/web/package.json", { base: manifest({}), head: manifest({ private: true }) }],
    ]);
    const forced = proposeTier(["package.json", "apps/web/package.json"], packages);
    expect(forced.tier).toBe("full");
    expect(forced.reason).toContain("apps/web/package.json");
  });
});

describe("planToolingLint", () => {
  it("lints and formats the changed tooling files of a tooling-only diff", () => {
    const plan = planToolingLint([
      "scripts/loops/prd.sh",
      "scripts/backlog/b.mjs",
      ".githooks/commit-msg",
      "scripts/hooks.test.mjs",
      "scripts/loops/README.md",
    ]);
    expect(plan.eslint).toEqual(["scripts/backlog/b.mjs", "scripts/hooks.test.mjs"]);
    expect(plan.prettier).toEqual([
      "scripts/loops/prd.sh",
      "scripts/backlog/b.mjs",
      ".githooks/commit-msg",
      "scripts/hooks.test.mjs",
    ]);
  });

  it("lints and formats the project's own scripts (scripts/project/)", () => {
    expect(
      planToolingLint(["scripts/project/a.mjs", "scripts/project/rules.json", "scripts/project/a.md"]),
    ).toEqual({
      eslint: ["scripts/project/a.mjs"],
      prettier: ["scripts/project/a.mjs", "scripts/project/rules.json"],
    });
  });

  it("puts no lint step on a Markdown-only diff", () => {
    expect(planToolingLint(["docs/agents/loop.md", "scripts/loops/notes.md", "AGENTS.md"])).toEqual({
      eslint: [],
      prettier: [],
    });
  });

  it("leaves app files to pnpm check", () => {
    expect(planToolingLint(["apps/web/app/a.ts", "scripts/deploy/x.mjs"]).prettier).toEqual([]);
  });
});

describe("check-plan.mjs CLI", () => {
  const cli = (mode, files) =>
    spawnSync("node", [join(ROOT, "scripts/loops/check-plan.mjs"), "--mode", mode], {
      input: files.join("\n"),
      encoding: "utf8",
    }).stdout.split("\n");

  it("a quick check asked on a migration diff stays quick", () => {
    const [mode, tooling, own] = cli("quick", ["packages/data/src/db/migrations/0009_a.sql"]);
    expect([mode, tooling, own]).toEqual(["quick", "0", ""]);
  });

  it("a quick check on a tooling diff joins the tooling tests and lists the diff's own test files", () => {
    const [mode, tooling, own] = cli("quick", ["scripts/loops/prd.sh", "packages/api/src/a.int.test.ts"]);
    expect([mode, tooling, own]).toEqual(["quick", "1", "packages/api/src/a.int.test.ts"]);
  });

  it("a slice check asked on a migration diff stays a slice check", () => {
    expect(cli("slice", ["packages/data/src/db/migrations/0009_a.sql"])[0]).toBe("slice");
  });

  it("an unknown mode is a full check", () => {
    expect(cli("other", ["apps/web/app/a.ts"])[0]).toBe("full");
  });

  it("--propose reads --base and --head from git, and without them any package.json proposes full", () => {
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
      spawnSync(
        "node",
        [
          join(ROOT, "scripts/loops/check-plan.mjs"),
          "--propose",
          "--repo",
          repo,
          "--base",
          base,
          "--head",
          head,
        ],
        { input: file, encoding: "utf8" },
      ).stdout.split("\n")[0];
    try {
      git("init", "-q");
      const file = "packages/a/package.json";
      const first = commit(file, '{"name":"a","scripts":{"x":"1"}}\n');
      const scripts = commit(file, '{"name":"a","scripts":{"x":"2"}}\n');
      const version = commit(file, '{"name":"a","version":"2.0.0","scripts":{"x":"2"}}\n');
      expect(withRefs(first, scripts, file)).toBe("none");
      expect(withRefs(scripts, version, file)).toBe("full");
      // With --base the diff is its own: what's piped in doesn't count.
      expect(withRefs(first, scripts, "")).toBe("none");
      expect(withRefs(first, first, file)).toBe("none");
      const bare = spawnSync("node", [join(ROOT, "scripts/loops/check-plan.mjs"), "--propose"], {
        input: file,
        encoding: "utf8",
      });
      expect(bare.stdout.split("\n")[0]).toBe("full");
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
      const child = spawn("node", [join(ROOT, "scripts/loops/check-plan.mjs"), ...args], {
        stdio: ["pipe", "pipe", "pipe"],
      });
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
      mkdirSync(join(repo, "apps/web"), { recursive: true });
      writeFileSync(join(repo, "apps/web/a.ts"), "export {};\n");
      git("add", ".");
      git("commit", "-qm", "app");
      const r = await openStdin(["--propose", "--repo", repo, "--base", "trunk"]);
      expect(r.code).toBe(0);
      const [tier, reason, status] = r.stdout.split("\n");
      expect(tier).toBe("components");
      expect(reason).toBe("app code (apps/web/a.ts)");
      expect(reason).not.toContain("no changes");
      expect(status).toBe("ok");
      const declared = await openStdin([
        "--propose",
        "--repo",
        repo,
        "--base",
        "trunk",
        "--head",
        "work",
        "--declared",
        "unit",
      ]);
      expect(declared.stdout.split("\n")[2]).toBe("below");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("--propose with a base git can't resolve exits 1", () => {
    const r = spawnSync(
      "node",
      [join(ROOT, "scripts/loops/check-plan.mjs"), "--propose", "--repo", ROOT, "--base", "no-such-ref-x"],
      { input: "", encoding: "utf8" },
    );
    expect(r.status).toBe(1);
  });

  it("--propose without --base still reads the changed files from stdin (propose_tier's old way)", () => {
    const r = spawnSync("node", [join(ROOT, "scripts/loops/check-plan.mjs"), "--propose"], {
      input: "apps/web/app/a.ts\ndocs/x.md\n",
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n").slice(0, 3)).toEqual(["components", "app code (apps/web/app/a.ts)", "ok"]);
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
