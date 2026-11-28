// check-budget.mjs: the check's budget and silence limit from the passing runs
// of its mode and branch kind. Fictional runs only.
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkBudget, describeBudget, hardLimit } from "./check-budget.mjs";

const HERE = new URL(".", import.meta.url).pathname;

let n = 0;
/** A run: seconds, then what differs from a passing slice check on a slice branch at load 10. */
const run = (seconds, extra = {}) => ({
  start: new Date(Date.UTC(2026, 10, 1) + n++ * 60_000).toISOString(),
  worktree: "wt",
  branch: "slice/fictional/1",
  mode: "slice",
  reason: "",
  seconds,
  loadStart: 10,
  loadEnd: 10,
  exit: 0,
  ...extra,
});
const runs = (secs, extra) => secs.map((s) => run(s, extra));
const query = { mode: "slice", branch: "slice/other/3", load: 10, ceiling: 1200 };

describe("checkBudget", () => {
  it("is twice the median when that is the larger", () => {
    // median 400 → 800; slowest 500 × 1.2 = 600
    const b = checkBudget(runs([300, 400, 400, 450, 500]), query);
    expect(b).toMatchObject({ budget: 800, samples: 5, medianSeconds: 400, slowestSeconds: 500, scale: 1 });
    expect(b.from).toBe("history");
  });

  it("is the slowest passing run plus 20% when that is the larger", () => {
    // median 320 → 640; slowest 900 × 1.2 = 1080
    expect(checkBudget(runs([300, 310, 320, 330, 900]), query).budget).toBe(1080);
  });

  it("counts only passing runs of the same mode and branch kind, the last 20", () => {
    const mixed = [
      ...runs([100, 100, 100, 100, 100]), // older: pushed out by the last 20
      ...runs(Array(20).fill(400)),
      ...runs([5000, 5000], { exit: 1 }), // failed
      ...runs([5000, 5000], { mode: "quick" }),
      ...runs([5000, 5000], { branch: "prd/fictional" }),
      ...runs([5000], { exit: 124 }), // stopped
    ];
    const b = checkBudget(mixed, query);
    expect(b).toMatchObject({ samples: 20, medianSeconds: 400, slowestSeconds: 400, budget: 800 });
  });

  it("keeps branch kinds apart: a prd check learns from prd branches", () => {
    const all = [...runs(Array(5).fill(300)), ...runs(Array(5).fill(450), { branch: "prd/x" })];
    expect(checkBudget(all, { ...query, branch: "prd/fictional" }).medianSeconds).toBe(450);
    expect(checkBudget(all, { ...query, branch: "slice/a/1" }).medianSeconds).toBe(300);
    // dev, main and bare names are one kind
    const other = runs(Array(5).fill(350), { branch: "dev" });
    expect(checkBudget(other, { ...query, branch: "main" }).samples).toBe(5);
  });

  it("scales up for a load above the samples' usual one, never down, at most three times", () => {
    const base = runs(Array(5).fill(400)); // median 400 → 800, at load 10
    expect(checkBudget(base, { ...query, load: 15 })).toMatchObject({ scale: 1.5, budget: 1200 });
    expect(checkBudget(base, { ...query, load: 12.5, ceiling: 5000 })).toMatchObject({
      scale: 1.25,
      budget: 1000,
    });
    expect(checkBudget(base, { ...query, load: 2 })).toMatchObject({ scale: 1, budget: 800 });
    expect(checkBudget(base, { ...query, load: 90, ceiling: 9000 })).toMatchObject({
      scale: 3,
      budget: 2400,
    });
    expect(checkBudget(base, { ...query, load: null }).scale).toBe(1);
  });

  it("scales the silence limit the same way", () => {
    const base = runs(Array(5).fill(400));
    expect(checkBudget(base, { ...query, silence: 480 }).silence).toBe(480);
    expect(checkBudget(base, { ...query, silence: 480, load: 20 }).silence).toBe(960);
    // no history: against a load of 15
    expect(checkBudget([], { ...query, silence: 480, load: 30 }).silence).toBe(960);
  });

  it("never goes under the floor", () => {
    expect(checkBudget(runs([60, 60, 70, 80, 90]), query).budget).toBe(600);
    expect(checkBudget(runs([60, 60, 70, 80, 90]), { ...query, floor: 300 }).budget).toBe(300);
  });

  it("never goes over the hard limit, even when the floor would", () => {
    expect(checkBudget(runs([900, 1000, 1100, 1200, 1300]), query).budget).toBe(1200);
    expect(checkBudget(runs([60, 60, 70, 80, 90]), { ...query, ceiling: 2 }).budget).toBe(2);
  });

  it("uses the hard limit with under five samples", () => {
    const b = checkBudget(runs([100, 100, 100, 100]), query);
    expect(b).toMatchObject({ budget: 1200, samples: 4, from: "hard limit" });
    expect(checkBudget([], query)).toMatchObject({ budget: 1200, samples: 0, medianSeconds: null });
  });
});

describe("checkBudget with the steps the check will run (RISA-1073)", () => {
  /** Times for steps, `{ step: seconds }`, as the log's stepTimes. */
  const times = (o) => Object.entries(o).map(([step, seconds]) => ({ step, seconds }));
  // Fast slice runs of the project's check alone, then slower ones that ran the tooling step too.
  const fast = runs([12, 14, 15, 15, 16, 18], { stepTimes: times({ check: 14 }) });
  const slow = runs([300, 320, 340, 360, 400], { stepTimes: times({ check: 15, tooling: 300 }) });
  const log = [...fast, ...slow];

  it("gives a check that will run the tooling step a budget from the runs that ran it", () => {
    const b = checkBudget(log, { ...query, steps: ["check", "tooling"] });
    // median 340 → 680; slowest 400 × 1.2 = 480
    expect(b).toMatchObject({ samples: 5, medianSeconds: 340, budget: 680, from: "history" });
    expect(b.steps).toEqual(["check", "tooling"]);
  });

  it("keeps the fast budget for a check without it", () => {
    const b = checkBudget(log, { ...query, steps: ["check"] });
    expect(b).toMatchObject({ samples: 6, medianSeconds: 15, budget: 600, from: "history" });
  });

  it("matches steps in any order, leaving a project hook's own step names out", () => {
    const own = runs([200, 200, 210, 220, 230], { stepTimes: times({ lint: 9, check: 20, tooling: 150 }) });
    const b = checkBudget(own, { ...query, steps: ["tooling", "check"] });
    expect(b).toMatchObject({ samples: 5, medianSeconds: 210 });
  });

  it("falls back to the hard limit with too few runs of those steps, as before", () => {
    const few = [...fast, ...slow.slice(0, 4)];
    expect(checkBudget(few, { ...query, steps: ["check", "tooling"] })).toMatchObject({
      budget: 1200,
      samples: 4,
      from: "hard limit",
    });
    // runs logged before check-hook.sh timed its own steps (only `tooling`, or none) match no check's
    const old = [
      ...runs(Array(5).fill(15)),
      ...runs(Array(5).fill(14), { stepTimes: times({ tooling: 0 }) }),
    ];
    expect(checkBudget(old, { ...query, steps: ["check", "tooling"] }).samples).toBe(0);
    expect(checkBudget(old, { ...query, steps: ["static", "unit", "tooling"] }).samples).toBe(0);
  });

  it("counts runs of any steps when none are given", () => {
    expect(checkBudget(log, query)).toMatchObject({ samples: 11, steps: null });
    expect(checkBudget(log, { ...query, steps: [] }).samples).toBe(11);
  });

  it("names the steps in its line", () => {
    const at = { mode: "slice", branch: "slice/x/1" };
    expect(describeBudget(checkBudget(log, { ...query, steps: ["check", "tooling"] }), at)).toMatch(
      /^Check budget 11m20s \(from 5 passing slice runs on slice branches that ran check, tooling, median 5m40s/,
    );
    expect(describeBudget(checkBudget([], { ...query, steps: ["check", "tooling"] }), at)).toMatch(
      /the hard limit: 0 passing slice run\(s\) on slice branches that ran check, tooling, under the 5 it needs/,
    );
  });
});

describe("hardLimit", () => {
  it("is 20 minutes for slice and quick checks, 40 for full, or RISA_CHECK_LIMIT", () => {
    expect(hardLimit("slice", {})).toBe(1200);
    expect(hardLimit("quick", {})).toBe(1200);
    expect(hardLimit("full", {})).toBe(2400);
    expect(hardLimit("full", { RISA_CHECK_LIMIT: "90" })).toBe(90);
    expect(hardLimit("full", { RISA_CHECK_LIMIT: "soon" })).toBe(2400);
  });
});

describe("describeBudget", () => {
  it("says where the budget came from", () => {
    const at = { mode: "slice", branch: "slice/x/1" };
    expect(describeBudget(checkBudget(runs(Array(5).fill(400)), { ...query, load: 15 }), at)).toBe(
      "Check budget 20m00s (from 5 passing slice runs on slice branches, median 6m40s, slowest 6m40s, ×1.50 for the load); silence limit 12m00s.",
    );
    expect(describeBudget(checkBudget([], query), at)).toMatch(
      /^Check budget 20m00s \(the hard limit: 0 passing slice run\(s\) on slice branches, under the 5 it needs\)/,
    );
  });
});

describe("check-budget.mjs CLI", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "check-budget-")));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const cli = (args, env = {}) =>
    spawnSync("node", [join(HERE, "check-budget.mjs"), ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        RISA_CHECK_LIMIT: "",
        RISA_CHECK_SILENCE: "",
        RISA_CHECK_BUDGET_FLOOR: "",
        ...env,
      },
    });

  it("prints the two limits, then the description, from the log", () => {
    const log = join(root, "log");
    const line = (secs) =>
      ["2026-11-01T10:00:00Z", "wt", "prd/x", "full", "", secs, "10", "10", "0"].join("\t");
    writeFileSync(log, [700, 800, 800, 900, 1000].map(line).join("\n") + "\n");
    const r = cli(["--mode", "full", "--branch", "prd/y", "--log", log, "--load", "10"]);
    expect(r.status).toBe(0);
    const [limits, said] = r.stdout.trim().split("\n");
    expect(limits).toBe("1600 480");
    expect(said).toMatch(/^Check budget 26m40s \(from 5 passing full runs on prd branches/);
  });

  it("learns only from runs of the steps --steps names", () => {
    const log = join(root, "steps-log");
    const line = (secs, steps) =>
      [
        "2026-11-01T10:00:00Z",
        "wt",
        "slice/x/1",
        "slice",
        "",
        secs,
        "10",
        "10",
        "0",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "ok",
        steps,
      ].join("\t");
    const fast = [12, 14, 15, 15, 16].map((s) => line(s, "check:12"));
    const slow = [300, 320, 340, 360, 400].map((s) => line(s, "check:14,tooling:290"));
    writeFileSync(log, [...fast, ...slow].join("\n") + "\n");
    const at = (steps) =>
      cli(["--mode", "slice", "--branch", "slice/y/2", "--log", log, "--load", "10", "--steps", steps])
        .stdout.trim()
        .split("\n");
    expect(at("check,tooling")[0]).toBe("680 480");
    expect(at("check")[0]).toBe("600 480");
    // no steps: all ten count, and the fast ones hold it at the floor
    expect(at("")).toEqual([
      "600 480",
      expect.stringMatching(/\(from 10 passing slice runs on slice branches, median/),
    ]);
  });

  it("falls back to the hard limit with no log, and takes the settings from env", () => {
    const r = cli(["--mode", "quick", "--branch", "dev", "--log", join(root, "none"), "--load", "1"], {
      RISA_CHECK_LIMIT: "300",
      RISA_CHECK_SILENCE: "60",
    });
    expect(r.stdout.split("\n")[0]).toBe("300 60");
  });
});
