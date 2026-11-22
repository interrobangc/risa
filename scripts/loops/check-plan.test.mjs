import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALWAYS_RUN, planCheck, planToolingLint, tooBroad } from "./check-plan.mjs";

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
    expect(plan.alwaysRun).toEqual([]);
  });

  it("keeps a plain app diff quick, with the always-run list", () => {
    const plan = planCheck(["apps/web/app/routes/a.tsx", "docs/x.md"], "quick");
    expect(plan).toMatchObject({ mode: "quick", reason: "", tooling: false });
    expect(plan.alwaysRun).toEqual(ALWAYS_RUN);
  });

  it("returns the always-run list for quick only, never twice", () => {
    expect(planCheck(["apps/web/a.ts"], "full").alwaysRun).toEqual([]);
    expect(new Set(ALWAYS_RUN).size).toBe(ALWAYS_RUN.length);
  });

  it.each([
    "scripts/loops/prd.sh",
    "scripts/backlog/b.mjs",
    ".githooks/commit-msg",
    "scripts/hooks.test.mjs",
  ])("joins the tooling tests for %s", (file) => {
    expect(planCheck([file], "quick").tooling).toBe(true);
    expect(planCheck([file], "full").tooling).toBe(true);
  });

  it("leaves the tooling tests out of an app diff", () => {
    expect(planCheck(["apps/web/app/a.ts", "scripts/deploy/x.mjs"], "quick").tooling).toBe(false);
  });

  it("handles an empty diff", () => {
    expect(planCheck([], "quick")).toMatchObject({ mode: "quick", tooling: false });
    expect(planCheck([], "full")).toMatchObject({ mode: "full", tooling: false });
  });

  it("names a forced full even when the asked mode is full", () => {
    expect(planCheck(["pnpm-lock.yaml"], "full").mode).toBe("full");
  });

  it("every always-run path exists", () => {
    for (const path of ALWAYS_RUN) expect(existsSync(join(ROOT, path)), path).toBe(true);
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

describe("tooBroad", () => {
  it("warns above half only", () => {
    expect(tooBroad(51, 100)).toBe(true);
    expect(tooBroad(50, 100)).toBe(false);
    expect(tooBroad(0, 0)).toBe(false);
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

  it("a quick check on a tooling diff joins the tooling tests and lists the always-run files", () => {
    const [mode, , tooling, always] = cli("quick", ["scripts/loops/prd.sh"]);
    expect([mode, tooling]).toEqual(["quick", "1"]);
    expect(always.split(" ")).toEqual(ALWAYS_RUN);
  });
});
