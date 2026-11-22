import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planCheck, planToolingLint } from "./check-plan.mjs";

const ROOT = join(import.meta.dirname, "../..");

describe("planCheck", () => {
  it.each([
    ["packages/data/src/db/migrations/0042_x.sql", "a migration"],
    ["packages/data/scripts/seed.ts", "seeds"],
    ["powersync/sync-config.yaml", "the sync config"],
    ["pnpm-lock.yaml", "the lockfile"],
    ["package.json", "a package.json"],
    ["apps/web/package.json", "a package.json"],
    ["vitest.config.ts", "the Vitest config"],
  ])("forces a full check for %s", (file, what) => {
    const plan = planCheck(["apps/web/app/a.ts", file], "quick");
    expect(plan.mode).toBe("full");
    expect(plan.reason).toContain(what);
    expect(plan.reason).toContain(file);
    expect(plan.ownTests).toEqual([]);
    // A slice hand-off is never forced: the orchestrator's checks cover the rest.
    expect(planCheck(["apps/web/app/a.ts", file], "slice")).toMatchObject({ mode: "slice", reason: "" });
  });

  it("keeps a plain app diff quick, with no test files of its own", () => {
    const plan = planCheck(["apps/web/app/routes/a.tsx", "docs/x.md"], "quick");
    expect(plan).toEqual({ mode: "quick", reason: "", tooling: false, ownTests: [] });
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

  it("names a forced full even when the asked mode is full", () => {
    expect(planCheck(["pnpm-lock.yaml"], "full").mode).toBe("full");
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

  it("a quick check asked on a migration diff is a full one, with its reason", () => {
    const [mode, reason, tooling, always] = cli("quick", ["packages/data/src/db/migrations/0009_a.sql"]);
    expect(mode).toBe("full");
    expect(reason).toContain("a migration");
    expect([tooling, always]).toEqual(["0", ""]);
  });

  it("a quick check on a tooling diff joins the tooling tests and lists the diff's own test files", () => {
    const [mode, , tooling, own] = cli("quick", ["scripts/loops/prd.sh", "packages/api/src/a.int.test.ts"]);
    expect([mode, tooling, own]).toEqual(["quick", "1", "packages/api/src/a.int.test.ts"]);
  });

  it("a slice check asked on a migration diff stays a slice check", () => {
    const [mode, reason] = cli("slice", ["packages/data/src/db/migrations/0009_a.sql"]);
    expect([mode, reason]).toEqual(["slice", ""]);
  });

  it("an unknown mode is a full check", () => {
    expect(cli("other", ["apps/web/app/a.ts"])[0]).toBe("full");
  });
});
