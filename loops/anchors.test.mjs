// pnpm prd anchors (anchors.mjs): a plan's file and symbol anchors against the base.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anchorsOf, asPath, checkAnchors, codeSpans, mergedSlices } from "./anchors.mjs";

const CLI = new URL("./anchors.mjs", import.meta.url).pathname;

/** A base of these files and contents, nothing ignored but under .loops/. */
function fakeBase(/** @type {Record<string, string>} */ files) {
  return {
    files: Object.keys(files),
    read: (/** @type {string} */ p) => files[p] ?? null,
    ignored: (/** @type {string} */ p) => p.startsWith(".loops/"),
  };
}

const base = fakeBase({
  "scripts/loops/land.sh": "land_branch() {\n  :\n}\n",
  "scripts/loops/slice-fields.mjs": "export function sliceFields() {}\nexport const FIELDS = [];\n",
  "scripts/loops/prompts/slice.sh": "fields_cli=x\n",
  "src/app/root.tsx": "export function HydrateFallback() { return null; }\n",
});

const plan = (/** @type {string} */ body, n = 1) =>
  `# Plan\n\n## Status\n\n## Wave 1\n\n### Slice ${n}: thing\n\n${body}\n`;

describe("codeSpans and asPath", () => {
  it("reads backticked spans and keeps only path-like ones", () => {
    expect(codeSpans("a `x` b ``y`` c").map((s) => s.text)).toEqual(["x", "y"]);
    const tops = new Set(["scripts", "src"]);
    expect(asPath("scripts/loops/", tops)).toBe("scripts/loops");
    expect(asPath("slice-fields.mjs", tops)).toBe("slice-fields.mjs");
    for (const not of [
      "prd/fixes-tooling",
      "slice/<topic>/<n>",
      "pnpm prd anchors",
      "--base",
      "d.errors",
      "e2e:invites",
    ])
      expect(asPath(not, tops)).toBeNull();
  });
});

describe("anchorsOf", () => {
  const tops = new Set(["scripts"]);
  it("attaches symbols beside a path, and a list of them, but not ones further on", () => {
    const { symbols } = anchorsOf(
      "`scripts/loops/land.sh`'s `land_branch`, `other` and `third`; then `notMine`.\n`land.sh` (`a`), returns `b`",
      tops,
    );
    expect(symbols).toEqual([
      { path: "scripts/loops/land.sh", symbol: "land_branch" },
      { path: "scripts/loops/land.sh", symbol: "other" },
      { path: "scripts/loops/land.sh", symbol: "third" },
      { path: "land.sh", symbol: "a" },
    ]);
  });

  it("marks paths and symbols the slice creates", () => {
    const { paths, symbols } = anchorsOf(
      "A new `scripts/loops/anchors.mjs` and `scripts/loops/anchors.test.mjs`; `scripts/x.mjs` (new); `scripts/loops/land.sh` gains a new `fn`.",
      tops,
    );
    expect(paths.map((p) => [p.path, p.isNew])).toEqual([
      ["scripts/loops/anchors.mjs", true],
      ["scripts/loops/anchors.test.mjs", true],
      ["scripts/x.mjs", true],
      ["scripts/loops/land.sh", false],
    ]);
    expect(symbols).toEqual([]);
  });
});

describe("mergedSlices", () => {
  it("reads merge SHAs and done states from the plan's and history's tables", () => {
    const status =
      "| Slice | Item | State | Merge |\n| --- | --- | --- | --- |\n| 1 | B-1 | merged (opus) | abc1234 |\n| 2 | B-2 | started | |\n| 3 | B-3 | landed | |";
    const other =
      "| Slice | Wave | State | Merge into `prd/x` (slice commits) |\n| - | - | - | - |\n| 4 | 1 | planned | — |\n| 5 | 1 | ok | `deadbeef` (`1234567`) |";
    expect([...mergedSlices([status, other])].sort()).toEqual([1, 3, 5]);
  });
});

describe("checkAnchors", () => {
  it("passes a slice whose paths and symbols are on the base", () => {
    const r = checkAnchors({
      planText: plan(
        "Change `scripts/loops/land.sh` `land_branch` and `slice-fields.mjs` (`sliceFields`, `FIELDS`), in `scripts/loops/`; `prompts/slice.sh`; `.loops/.sessions/x.json`; `root.tsx`'s `HydrateFallback` returns `null`.",
      ),
      base,
    });
    expect(r).toEqual({ checked: [1], misses: [], warnings: [] });
  });

  it("names a missing path and a missing symbol", () => {
    const r = checkAnchors({
      planText: plan("Edit `scripts/loops/gone.mjs` `x` and `scripts/loops/land.sh` `land_tip`."),
      base,
    });
    expect(r.misses).toEqual([
      { slice: 1, kind: "path", path: "scripts/loops/gone.mjs" },
      { slice: 1, kind: "symbol", path: "scripts/loops/land.sh", symbol: "land_tip" },
    ]);
  });

  it("skips merged slices and warns on a line-number anchor", () => {
    const planText = `${plan("`scripts/loops/gone.mjs`")}\n### Slice 2: other\n\nSee \`land.sh ~158\`, 3 files.\n\n## Status\n\n| Slice | State | Merge |\n| - | - | - |\n| 1 | merged | abcdef1 |\n`;
    const r = checkAnchors({ planText, base });
    expect(r.checked).toEqual([2]);
    expect(r.misses).toEqual([]);
    expect(r.warnings).toEqual([
      { slice: 2, text: 'line-number anchor "land.sh ~158": name the file and function instead' },
    ]);
  });
});

describe("the command line", () => {
  /** @type {string} */
  let repo;
  const git = (/** @type {string[]} */ ...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "anchors-"));
    git("init", "-q", "-b", "dev");
    mkdirSync(join(repo, "scripts"));
    writeFileSync(join(repo, "scripts/a.mjs"), "export function here() {}\n");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base");
    mkdirSync(join(repo, "plans"));
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("exits 0 whether or not an anchor is missing, naming each miss", () => {
    writeFileSync(join(repo, "plans/t-plan.md"), plan("`scripts/a.mjs` `here`"));
    let r = spawnSync("node", [CLI, "t", "--repo", repo], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("anchors ok on dev (slices 1)\n");
    writeFileSync(join(repo, "plans/t-plan.md"), plan("`scripts/a.mjs` `gone` and `scripts/b.mjs`"));
    r = spawnSync("node", [CLI, "t", "--repo", repo, "--base", "dev"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("slice 1: `scripts/b.mjs` is not on dev\n");
    expect(r.stdout).toContain("slice 1: `gone` is not in `scripts/a.mjs` on dev\n");
  });

  it("prints an unmerged slice's unknown Model after the anchor lines and exits 1", () => {
    const withModel = (/** @type {string} */ m) =>
      plan(`Stack: no · Reads: x.md · Tests: unit · Model: ${m}\n\n\`scripts/a.mjs\` \`here\``);
    writeFileSync(join(repo, "plans/t-plan.md"), withModel("haiku"));
    let r = spawnSync("node", [CLI, "t", "--repo", repo], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("anchors ok on dev (slices 1)\n");
    expect(r.stderr).toMatch(/^error: slice 1: .*opus.*sonnet.*"haiku"$/m);
    writeFileSync(join(repo, "plans/t-plan.md"), withModel("sonnet"));
    r = spawnSync("node", [CLI, "t", "--repo", repo], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("anchors ok on dev (slices 1)\n");
    expect(r.stderr).not.toMatch(/error/);
  });

  it("refuses a missing plan or ref with exit 2", () => {
    expect(spawnSync("node", [CLI, "nope", "--repo", repo]).status).toBe(2);
    writeFileSync(join(repo, "plans/t-plan.md"), plan("x"));
    expect(spawnSync("node", [CLI, "t", "--repo", repo, "--base", "no-such"]).status).toBe(2);
    expect(spawnSync("node", [CLI]).status).toBe(2);
  });
});
