// exports.test.mjs: the parts a project imports by the package's name (package.json
// `exports`), each import in a child node run from the repo root, where Node resolves
// the package's own name; and the docs budget, as a module and as a script.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { BUDGETS, overBudget } from "./docs-budget.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

/** Runs an ES module snippet in a child node from the repo root. */
const node = (/** @type {string} */ code) =>
  spawnSync("node", ["--input-type=module", "-e", code], { cwd: ROOT, encoding: "utf8" });

const temps = /** @type {string[]} */ ([]);
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "risa-exports-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the package's exports", () => {
  it("risa/ci/ci-runs.mjs gives VERDICT_VERSION and isVerdict", () => {
    const r = node(
      'const m = await import("risa/ci/ci-runs.mjs");' +
        "console.log(JSON.stringify([m.VERDICT_VERSION, typeof m.isVerdict]));",
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([1, "function"]);
  });

  it("risa/loops/docs-budget.mjs gives BUDGETS, writes nothing and exits 0", () => {
    const r = node('const m = await import("risa/loops/docs-budget.mjs"); globalThis.b = m.BUDGETS;');
    expect(r).toMatchObject({ status: 0, stdout: "", stderr: "" });
    const keys = node(
      'const m = await import("risa/loops/docs-budget.mjs"); process.stdout.write(JSON.stringify(m.BUDGETS));',
    );
    expect(JSON.parse(keys.stdout)).toEqual(BUDGETS);
  });

  it("risa/ci/verdict.fixtures/* names a fixture isVerdict accepts", () => {
    const r = node(
      'import { existsSync, readFileSync } from "node:fs";' +
        'import { fileURLToPath } from "node:url";' +
        'const { isVerdict } = await import("risa/ci/ci-runs.mjs");' +
        'const file = fileURLToPath(import.meta.resolve("risa/ci/verdict.fixtures/candidate-green.json"));' +
        'console.log(JSON.stringify([file, existsSync(file), isVerdict(JSON.parse(readFileSync(file, "utf8")))]));',
    );
    expect(r.stderr).toBe("");
    const [file, exists, valid] = JSON.parse(r.stdout);
    expect(file).toBe(join(ROOT, "ci", "verdict.fixtures", "candidate-green.json"));
    expect(exists).toBe(true);
    expect(valid).toBe(true);
  });
});

describe("overBudget", () => {
  it("names a doc over its budget and a doc with no budget", () => {
    const dir = temp();
    writeFileSync(join(dir, "machinery.md"), "x".repeat(BUDGETS["machinery.md"] + 1));
    writeFileSync(join(dir, "inbox.md"), "within");
    writeFileSync(join(dir, "stray.md"), "no budget");
    writeFileSync(join(dir, "notes.txt"), "not a doc");
    expect(overBudget(dir, "docs")).toEqual([
      `docs/machinery.md: ${BUDGETS["machinery.md"] + 1} B, over its ${BUDGETS["machinery.md"]} B`,
      "docs/stray.md: no budget (add one to loops/docs-budget.mjs)",
    ]);
  });

  it("finds none in loops/docs", () => {
    expect(overBudget(join(HERE, "docs"))).toEqual([]);
  });
});

describe("docs-budget.mjs as a script", () => {
  /** A copy of the script beside its own docs folder, holding the given docs. */
  const script = (/** @type {Record<string, string>} */ docs) => {
    const dir = temp();
    copyFileSync(join(HERE, "docs-budget.mjs"), join(dir, "docs-budget.mjs"));
    mkdirSync(join(dir, "docs"));
    for (const [name, text] of Object.entries(docs)) writeFileSync(join(dir, "docs", name), text);
    return spawnSync("node", [join(dir, "docs-budget.mjs")], { cwd: dir, encoding: "utf8" });
  };

  it("exits 1 with the lines on an over-budget doc", () => {
    const r = script({ "orchestration.md": "x".repeat(BUDGETS["orchestration.md"] + 1) });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(
      `loops/docs/orchestration.md: ${BUDGETS["orchestration.md"] + 1} B, over its ${BUDGETS["orchestration.md"]} B\n`,
    );
  });

  it("exits 0 with its one line otherwise", () => {
    const r = script({ "orchestration.md": "within" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("docs budget: every generic role doc is within its budget\n");
  });
});
