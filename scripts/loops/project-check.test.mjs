// project-check.mjs, the project-data check, on the sample project: a repo with
// every file the sample config names passes; with one thing broken, it names that
// one thing on one line, its file first.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.mjs";
import { projectProblems } from "./project-check.mjs";
import { SAMPLE_CONFIG, makeRepo, sampleData } from "./sample-project/repo.mjs";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "project-check-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SAMPLE = JSON.parse(readFileSync(SAMPLE_CONFIG, "utf8"));
const TIERS = JSON.parse(readFileSync(join(SAMPLE_CONFIG, "../tools/tiers.json"), "utf8"));

/**
 * A sample repo with the check's data, changed: files added or replaced (null: left out).
 * @param {Record<string, string | null>} [change]
 */
const repo = (change = {}) => {
  const main = mkdtempSync(join(tmp, "repo-"));
  const files = Object.fromEntries(
    Object.entries({ ...sampleData(), ...change }).filter(([, text]) => text !== null),
  );
  makeRepo(main, { files: /** @type {Record<string, string>} */ (files) });
  return main;
};
const problems = (/** @type {string} */ main) =>
  projectProblems(loadConfig({ path: join(main, "risa.json") }));
const withPaths = (/** @type {Record<string, string>} */ paths) =>
  JSON.stringify({ ...SAMPLE, paths: { ...SAMPLE.paths, ...paths } });

describe("the project-data check", () => {
  it("passes on a sample repo with every file its config names", () => {
    expect(problems(repo())).toEqual([]);
  });

  it("names a path the config names that is missing", () => {
    expect(problems(repo({ "work/inbox.md": null }))).toEqual(["work/inbox.md: missing (paths.inbox)"]);
  });

  it("names a tier data problem", () => {
    const { refPrefix: _, ...broken } = TIERS;
    expect(problems(repo({ "tools/tiers.json": JSON.stringify(broken) }))).toEqual([
      "tools/tiers.json: refPrefix: missing",
    ]);
  });

  it("names a check plan rule that doesn't load", () => {
    const rules = JSON.parse(readFileSync(join(SAMPLE_CONFIG, "../tools/check-plan-rules.json"), "utf8"));
    rules.suite.tier = "nightly";
    const [line, ...more] = problems(repo({ "tools/check-plan-rules.json": JSON.stringify(rules) }));
    expect(more).toEqual([]);
    expect(line).toMatch(/^tools\/check-plan-rules\.json: suite\.tier: not a tier/);
  });

  it("names a quarantine line that doesn't parse with the project's ids, and a brake list line", () => {
    const main = repo({
      "risa.json": withPaths({ quarantine: "tools/quarantine.txt", brakeList: "tools/brakes.txt" }),
      "tools/quarantine.txt": "# flaky\na.test.mjs\tit works\tSAM-1\nb.test.mjs\tit works\tB-1\n",
      "tools/brakes.txt": "# brakes\nweb/**\ncheck:smoke\n",
    });
    expect(problems(main)).toEqual([
      "tools/quarantine.txt:3: quarantine: a line needs <file><TAB><test name><TAB><SAM-n>: b.test.mjs\tit works\tB-1",
    ]);
    writeFileSync(join(main, "tools/brakes.txt"), "web/** db/**\n");
    expect(problems(main)).toContain("tools/brakes.txt:1: not one glob or check:<name>: web/** db/**");
  });

  it("names a doc beside the preferences that no role names, and a role's missing file", () => {
    expect(problems(repo({ "handbook/extra.md": "# Extra\n" }))).toEqual([
      "handbook/extra.md: no role names it (roles.<role>.additions or replacement)",
    ]);
    expect(problems(repo({ "handbook/roles/lead.md": null }))).toEqual([
      "handbook/roles/lead.md: missing (roles.orchestrator.replacement)",
    ]);
  });

  it("names a preferences doc with no never list", () => {
    expect(problems(repo({ "handbook/taste.md": "# Taste\n\nNothing here.\n" }))).toEqual([
      "handbook/taste.md: the skeptic brief: handbook/taste.md has no never list to brief from",
    ]);
  });

  it("runs the boundary lint when the project has a manifest", () => {
    const found = problems(repo({ "scripts/loops/boundary.manifest": "not a line\n" }));
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((l) => l.startsWith("boundary lint: "))).toBe(true);
    expect(found).toContain(
      "boundary lint: scripts/loops/boundary.manifest:1: not `<path> core|project`: not a line",
    );
  });
});

describe("project-check.mjs", () => {
  const { RISA_CONFIG: _, ...env } = process.env;
  const cli = (/** @type {string} */ main) =>
    spawnSync(process.execPath, [join(main, "scripts/loops/project-check.mjs")], {
      cwd: main,
      encoding: "utf8",
      env,
    });

  it("prints ok and exits 0 on the repo's own config, else the lines, a count and exit 1", () => {
    const good = cli(repo());
    expect(good).toMatchObject({ status: 0, stdout: "project-check: ok\n" });
    const bad = cli(repo({ "work/inbox.md": null }));
    expect(bad.status).toBe(1);
    expect(bad.stdout).toBe(
      "work/inbox.md: missing (paths.inbox)\nproject-check: 1 problem(s) in the project's data\n",
    );
  });
});
