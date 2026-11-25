// The core's tier data reader, on a sample project's data: what it answers, and
// every shape it refuses.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { CONFIG_NAME, configPath } from "../loops/config.mjs";
import { TierDataError, tierData, tierDataProblems, tiersFrom } from "./tier-data.mjs";

const HERE = new URL(".", import.meta.url).pathname;
/** This repo's config, whose tier data path a test points at a broken file. */
const FIXTURE_CONFIG = configPath();

/** A sample project's tiers: three, other names, another ref prefix. */
const SAMPLE = {
  tiers: ["lint", "tests", "e2e"],
  jobs: { lint: ["lint"], tests: ["tests-1", "tests-2"], e2e: ["e2e"] },
  fileGroups: [
    { group: "e2e", pattern: "e2e/*.spec.ts", tier: "e2e" },
    { group: "slow", pattern: "*.slow.test.js", tier: "tests" },
    { group: "fast", pattern: "*", tier: "tests" },
  ],
  narrowedTiers: ["tests"],
  browserCheck: "e2e/*.spec.ts",
  narrowedFile: ".narrowed.json",
  forcedFlakeFile: ".ci/flake.json",
  refPrefix: "runs/ci/",
};

const changed = (/** @type {(d: any) => void} */ change) => {
  const d = structuredClone(SAMPLE);
  change(d);
  return d;
};

describe("tiersFrom", () => {
  const t = tiersFrom(SAMPLE);

  it("gives the tiers, their jobs and the marker files", () => {
    expect(t.TIERS).toEqual(["lint", "tests", "e2e"]);
    expect(t.TIER_JOBS.tests).toEqual(["tests-1", "tests-2"]);
    expect(t.isTier("tests")).toBe(true);
    expect(t.isTier("unit")).toBe(false);
    expect(t.NARROWED_FILE).toBe(".narrowed.json");
    expect(t.FORCED_FLAKE_FILE).toBe(".ci/flake.json");
  });

  it("runs a tier's jobs and every lower tier's", () => {
    expect(t.jobsFor("lint")).toEqual({ jobs: ["lint"], ranTier: "lint" });
    expect(t.jobsFor("e2e").jobs).toEqual(["lint", "tests-1", "tests-2", "e2e"]);
    expect(() => t.jobsFor("nope")).toThrow('unknown tier "nope" (lint, tests, e2e)');
  });

  it("puts a file in its first matching group, `*` crossing folders", () => {
    expect(t.fileGroup("e2e/sign-in.spec.ts")).toBe("e2e");
    expect(t.fileGroup("e2e/deep/x.spec.ts")).toBe("e2e");
    expect(t.fileGroup("lib/a/b.slow.test.js")).toBe("slow");
    expect(t.fileGroup("lib/a.test.js")).toBe("fast");
    expect(t.fileTier("e2e/x.spec.ts")).toBe("e2e");
    expect(t.fileTier("x.slow.test.js")).toBe("tests");
    // A pattern's dots are dots, not any character.
    expect(t.fileGroup("x.slowXtest.js")).toBe("fast");
  });

  it("puts a file name with a newline in a group too, never a TypeError", () => {
    expect(t.fileGroup("lib/a\nb.test.js")).toBe("fast");
    expect(t.fileGroup("lib/a\nb.slow.test.js")).toBe("slow");
    expect(t.fileTier("lib/a\nb.test.js")).toBe("tests");
  });

  it("names a browser check's spec and knows one", () => {
    expect(t.browserCheckFile("sign-in")).toBe("e2e/sign-in.spec.ts");
    expect(t.isBrowserCheckFile("e2e/sign-in.spec.ts")).toBe(true);
    expect(t.isBrowserCheckFile("e2e/sign-in.ts")).toBe(false);
    expect(t.isBrowserCheckFile("lib/e2e/x.spec.ts")).toBe(false);
  });

  it("starts a narrowed run's first job of each narrowed tier its files need", () => {
    expect(t.narrowedJobs(["a.test.js", "b.slow.test.js"])).toEqual(["tests-1"]);
    expect(t.narrowedJobs(["e2e/x.spec.ts"])).toEqual([]);
    expect(t.narrowedJobs([])).toEqual([]);
  });

  it("builds and reads a CI ref with the data's prefix", () => {
    expect(t.ciRefName("tests", "refs/heads/slice/t/2")).toBe("runs/ci/tests/slice-t-2");
    expect(() => t.ciRefName("nope", "x")).toThrow(/unknown tier/);
    expect(() => t.ciRefName("tests", "refs/heads/")).toThrow(/branch name/);
    expect(t.parseCiRef("runs/ci/tests/slice-t-2")).toEqual({ tier: "tests", name: "slice-t-2" });
    expect(t.parseCiRef("refs/heads/runs/ci/e2e/a/b")).toEqual({ tier: "e2e", name: "a/b" });
    expect(t.parseCiRef("runs/ci/nope/x")).toBeNull();
    expect(t.parseCiRef("ci/tests/x")).toBeNull();
    expect(t.parseCiRef("runsXci/tests/x")).toBeNull();
  });

  it("can't be changed by its callers", () => {
    expect(() => /** @type {any} */ (t.TIERS).push("x")).toThrow();
    expect(() => /** @type {any} */ (t.TIER_JOBS.lint).push("x")).toThrow();
  });
});

describe("tierDataProblems", () => {
  it("passes the sample", () => expect(tierDataProblems(SAMPLE)).toEqual([]));

  it.each([
    ["a missing key", (d) => delete d.refPrefix, "refPrefix: missing"],
    ["an unknown key", (d) => (d.extra = 1), "extra: unknown key"],
    ["repeated tiers", (d) => (d.tiers = ["a", "a"]), "tiers: must be a list of names"],
    ["a tier with no jobs", (d) => delete d.jobs.e2e, "jobs.e2e: missing"],
    ["jobs for no tier", (d) => (d.jobs.other = ["x"]), "jobs.other: not a tier"],
    ["an empty job list", (d) => (d.jobs.lint = []), "jobs.lint: must be a list of job names"],
    ["a group's unknown tier", (d) => (d.fileGroups[0].tier = "x"), "fileGroups.0.tier: not a tier"],
    ["a group's extra key", (d) => (d.fileGroups[1].why = "x"), "fileGroups.1.why: unknown key"],
    [
      "a group with no pattern",
      (d) => delete d.fileGroups[1].pattern,
      "fileGroups.1.pattern: must be a pattern",
    ],
    ["no catch-all group", (d) => d.fileGroups.pop(), "the last group must match every file"],
    ["a narrowed tier that isn't one", (d) => (d.narrowedTiers = ["x"]), "narrowedTiers: x is not a tier"],
    [
      "a check path with no `*`",
      (d) => (d.browserCheck = "e2e/x.ts"),
      "browserCheck: must be a path with one `*`",
    ],
    ["a marker with a `*`", (d) => (d.narrowedFile = "*.json"), "narrowedFile: must be a path"],
    ["a prefix with no slash", (d) => (d.refPrefix = "ci"), "refPrefix: must be a ref prefix"],
  ])("refuses %s", (_what, change, problem) => {
    const problems = tierDataProblems(changed(change));
    expect(problems.join("\n")).toContain(problem);
    expect(problems).toHaveLength(1);
  });

  it("refuses what isn't one object", () => {
    expect(tierDataProblems([])).toEqual(["the file must hold one JSON object"]);
    expect(tierDataProblems(null)).toEqual(["the file must hold one JSON object"]);
  });

  it("throws every problem at once, each naming the file", () => {
    const bad = changed((d) => (delete d.jobs, (d.refPrefix = "x")));
    expect(() => tiersFrom(bad, "t.json")).toThrow(TierDataError);
    expect(() => tiersFrom(bad, "t.json")).toThrow("t.json: jobs: missing\nt.json: refPrefix: must be");
  });
});

describe("tierDataOrExit", () => {
  it("gives a command one line and exit 2 for a broken tier file, never a stack", () => {
    const root = mkdtempSync(join(tmpdir(), "tier-data-exit-"));
    try {
      writeFileSync(join(root, "broken.json"), JSON.stringify({ ...SAMPLE, tiers: [] }));
      const config = JSON.parse(readFileSync(FIXTURE_CONFIG, "utf8"));
      config.paths = { ...config.paths, tierData: "broken.json" };
      writeFileSync(join(root, CONFIG_NAME), JSON.stringify(config));
      const r = spawnSync(
        "node",
        ["--input-type=module", "-e", `import(${JSON.stringify(HERE + "ci-args.mjs")})`],
        { encoding: "utf8", env: { ...process.env, RISA_CONFIG: join(root, CONFIG_NAME) } },
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/^ci: .*broken\.json: tiers: must be a list/);
      expect(r.stderr).not.toMatch(/\n\s+at /);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("tierData", () => {
  const root = mkdtempSync(join(tmpdir(), "tier-data-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("reads the file the config names, from the config's root, once", () => {
    writeFileSync(join(root, "sample.json"), JSON.stringify(SAMPLE));
    const project = { config: { paths: { tierData: "sample.json" } }, root };
    const t = tierData(project);
    expect(t.TIERS).toEqual(SAMPLE.tiers);
    writeFileSync(join(root, "sample.json"), "not json");
    expect(tierData(project)).toBe(t);
  });

  it("says so when the config names none, or the file doesn't read", () => {
    expect(() => tierData({ config: { paths: {} }, root })).toThrow(/sets no paths\.tierData/);
    expect(() => tierData({ config: { paths: { tierData: "none.json" } }, root })).toThrow(
      /none\.json: can't read the tier data/,
    );
    writeFileSync(join(root, "bad.json"), JSON.stringify({ ...SAMPLE, tiers: [] }));
    expect(() => tierData({ config: { paths: { tierData: "bad.json" } }, root })).toThrow(
      /bad\.json: tiers: must be a list/,
    );
  });

  it("reads this repo's, through its config", () => {
    expect(tierData().TIERS.length).toBeGreaterThan(0);
  });
});
