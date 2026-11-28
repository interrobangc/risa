// The entry points' main guard (is-main.mjs, RISA-1048): a script run through a
// symlink (as pnpm links a project's node_modules to the real .pnpm path) is
// still the main module, and an entry point run that way does its work.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isMain } from "./is-main.mjs";

const HELPER = fileURLToPath(new URL("./is-main.mjs", import.meta.url));
const HELPER_URL = new URL("./is-main.mjs", import.meta.url).href;
const BUDGET = fileURLToPath(new URL("./check-budget.mjs", import.meta.url));

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "is-main-"));
  symlinkSync(HELPER, join(dir, "is-main.mjs"));
  symlinkSync(BUDGET, join(dir, "check-budget.mjs"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("isMain", () => {
  it("is true for the module's real path", () => {
    expect(isMain(HELPER_URL, HELPER)).toBe(true);
  });

  it("is true for a symlink to the module", () => {
    expect(isMain(HELPER_URL, join(dir, "is-main.mjs"))).toBe(true);
  });

  it("is false for another script", () => {
    expect(isMain(HELPER_URL, BUDGET)).toBe(false);
  });

  it("is false with no script argument, or one that doesn't exist", () => {
    expect(isMain(HELPER_URL, undefined)).toBe(false);
    expect(isMain(HELPER_URL, "")).toBe(false);
    expect(isMain(HELPER_URL, join(dir, "missing.mjs"))).toBe(false);
  });
});

describe("an entry point run through a symlink", () => {
  it("does its work instead of exiting 0 silently", () => {
    const r = spawnSync(
      process.execPath,
      [join(dir, "check-budget.mjs"), "--mode", "slice", "--branch", "slice/sample/1"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    const [first, second] = r.stdout.split("\n");
    expect(first).toMatch(/^\d+ \d+$/);
    expect(second).toMatch(/^Check budget /);
  });
});
