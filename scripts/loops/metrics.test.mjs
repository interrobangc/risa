// metrics.mjs: the summary, flake rate, find rate and usual time from fictional
// fixture logs (old flake and check lines included), malformed lines counted and
// skipped, and --since. The CLI reads only the temp files it's given.
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { branchKind, checkName, formatSummary, loadData, summarize, usualTime } from "./metrics.mjs";

const ev = (time, kind, fields = {}) => JSON.stringify({ time, kind, topic: "garden", ...fields });
const RUN_LOG = [
  // Two finished slices (one resumed: counted from its first start), one running.
  ev("2026-03-01T10:00:00Z", "slice-start", { name: "garden-1", branch: "slice/garden/1" }),
  ev("2026-03-01T10:30:00Z", "slice-start", { name: "garden-2", branch: "slice/garden/2" }),
  ev("2026-03-01T11:00:00Z", "slice-end", { name: "garden-1", branch: "slice/garden/1", merged: true }),
  ev("2026-03-01T11:10:00Z", "slice-start", { name: "garden-2", branch: "slice/garden/2" }),
  ev("2026-03-01T13:30:00Z", "slice-end", { name: "garden-2", branch: "slice/garden/2", merged: false }),
  ev("2026-03-02T09:00:00Z", "slice-start", { name: "garden-3", branch: "slice/garden/3" }),
  // Landings: two landed (pr 10 min, local 2 min), one refused.
  ev("2026-03-01T14:00:00Z", "land-start", { branch: "prd/garden", path: "pr" }),
  ev("2026-03-01T14:10:00Z", "land-end", {
    branch: "prd/garden",
    path: "pr",
    exit: 0,
    landed: true,
    seconds: 600,
  }),
  ev("2026-03-02T08:00:00Z", "land-end", {
    branch: "prd/garden",
    path: "pr",
    exit: 1,
    landed: false,
    seconds: 5,
  }),
  ev("2026-03-02T08:30:00Z", "land-end", {
    branch: "hotfix/fence",
    topic: "fence",
    path: "local",
    exit: 0,
    landed: true,
    seconds: 120,
  }),
  // Browser results: roundtrip 1 flaky of 3; sign-in 1 pass; a not-run doesn't count.
  ev("2026-03-01T12:00:00Z", "browser", { check: "roundtrip", result: "pass" }),
  ev("2026-03-01T12:10:00Z", "browser", { check: "roundtrip", result: "flaky", retried: true }),
  ev("2026-03-02T12:00:00Z", "browser", { check: "roundtrip", result: "fail" }),
  ev("2026-03-02T12:05:00Z", "browser", { check: "sign-in", result: "pass" }),
  ev("2026-03-02T12:06:00Z", "browser", { check: "ui", result: "not-run" }),
  // Codex: head a findings (polled twice), head b clean, head c carried, head d out of credits.
  ev("2026-03-01T15:00:00Z", "codex", {
    pr: 7,
    head: "aaa",
    answer: "review",
    state: "findings",
    findings: 2,
  }),
  ev("2026-03-01T15:05:00Z", "codex", {
    pr: 7,
    head: "aaa",
    answer: "review",
    state: "findings",
    findings: 2,
  }),
  ev("2026-03-01T15:20:00Z", "codex", { pr: 7, head: "aaa", answer: "review", state: "clean", findings: 0 }),
  ev("2026-03-02T15:00:00Z", "codex", { pr: 7, head: "bbb", answer: "review", state: "clean", findings: 0 }),
  ev("2026-03-02T15:30:00Z", "codex", {
    pr: 7,
    head: "ccc",
    answer: "review",
    state: "clean",
    carried: "bbb",
  }),
  ev("2026-03-02T16:00:00Z", "codex", {
    pr: 8,
    head: "ddd",
    answer: "out-of-credits",
    state: "out-of-credits",
  }),
  "not json at all",
  JSON.stringify({ kind: "browser" }),
  "",
].join("\n");

// The check log: fifteen fields now, nine to twelve in older lines.
const check = (start, branch, mode, seconds, exit, flaky = "", fields = 15) =>
  [
    start,
    branch.replace(/\//g, "-"),
    branch,
    mode,
    "why",
    seconds,
    "1.0",
    "1.0",
    exit,
    "",
    "",
    "0",
    "",
    "",
    flaky,
  ]
    .slice(0, fields)
    .join("\t");
const CHECK_LOG = [
  check("2026-03-01T09:00:00Z", "slice/garden/1", "slice", 120, 0),
  check("2026-03-01T09:30:00Z", "slice/garden/1", "slice", 240, 0, "a.test.mjs"),
  check("2026-03-01T10:00:00Z", "slice/garden/2", "slice", 600, 1),
  check("2026-03-02T09:00:00Z", "prd/garden", "quick", 900, 0),
  check("2026-03-02T10:00:00Z", "prd/garden", "quick", 300, 0, "", 12),
  check("2026-02-20T10:00:00Z", "prd/garden", "full", 1800, 0, "", 9),
  "2026-03-01\tbroken line",
].join("\n");

// The flake log: an old line (<check>.mjs), a newer one (<check>.spec.mjs), a bad one.
const FLAKE_LOG = [
  "2026-02-25 16:07\tgarden-1\troundtrip.mjs\tload 8→9, TIMEOUT\t/tmp/x.log",
  "2026-03-02 13:14\tgarden-2\troundtrip.spec.mjs\tload 60→70, Timeout 30000ms\t/tmp/y.log",
  "2026-03-02 13:20\tgarden-2\tphase2.spec.mjs\tload 50→51, timed out\t/tmp/z.log",
  "yesterday\tgarden-2\tphase2.spec.mjs",
].join("\n");

const data = loadData({ runLog: RUN_LOG, checkLog: CHECK_LOG, flakeLog: FLAKE_LOG });

describe("summarize", () => {
  const s = summarize(data);

  it("counts and skips malformed lines in each log", () => {
    expect(s.skipped).toEqual({ runLog: 2, checkLog: 1, flakeLog: 1 });
  });

  it("gives slice durations: count, median, slowest, running", () => {
    expect(s.slices).toMatchObject({
      count: 2,
      merged: 1,
      running: 1,
      medianMinutes: (60 + 180) / 2,
      slowestMinutes: 180,
      slowest: "garden-2",
    });
  });

  it("gives landing durations over the landed ones, the rest counted apart", () => {
    expect(s.landings).toMatchObject({
      count: 2,
      medianMinutes: 6,
      slowestMinutes: 10,
      slowest: "prd/garden",
      notLanded: 1,
    });
  });

  it("gives check times by mode, over passing runs", () => {
    expect(s.checks.byMode.slice).toEqual({
      runs: 3,
      passed: 2,
      testFailures: 1,
      budgetStops: 0,
      silenceStops: 0,
      timeBreaches: 0,
      medianMinutes: 3,
      slowestMinutes: 4,
    });
    expect(s.checks.byMode.quick).toMatchObject({ runs: 2, medianMinutes: 10, slowestMinutes: 15 });
    expect(s.checks.byMode.full).toMatchObject({ runs: 1 });
  });

  it("counts the checks' test failures, budget stops, silence stops and time breaches apart", () => {
    // Eighteen-field lines: one of each kind, and a passing one whose unarmed gate warned.
    const run = (branch, mode, exit, breach = "", verdict = "") =>
      [...check("2026-03-03T10:00:00Z", branch, mode, 60, exit).split("\t"), breach, verdict, ""].join("\t");
    const t = summarize(
      loadData({
        checkLog: [
          run("slice/garden/4", "slice", 1),
          run("slice/garden/4", "slice", 124, "budget"),
          run("prd/fence", "quick", 124, "silence"),
          run("prd/fence", "quick", 125, "", "fail"),
          run("prd/fence", "quick", 0, "", "warn"),
        ].join("\n"),
      }),
    );
    const one = { testFailures: 1, budgetStops: 1, silenceStops: 1, timeBreaches: 1 };
    expect(t.checks.overall).toMatchObject({ runs: 5, passed: 1, ...one });
    expect(t.checks.byMode.slice).toMatchObject({
      testFailures: 1,
      budgetStops: 1,
      silenceStops: 0,
      timeBreaches: 0,
    });
    expect(t.checks.byMode.quick).toMatchObject({
      testFailures: 0,
      budgetStops: 0,
      silenceStops: 1,
      timeBreaches: 1,
    });
    expect(t.checks.byPrd.garden).toMatchObject({ runs: 2, testFailures: 1, budgetStops: 1 });
    expect(t.checks.byPrd.fence).toMatchObject({ runs: 3, silenceStops: 1, timeBreaches: 1 });
    const out = formatSummary(t);
    expect(out).toMatch(/runs tests budget silence time +median m/);
    expect(out).toMatch(/\n {2}all +5 +1 +1 +1 +1 /);
    expect(out).toContain(" by mode:");
    expect(out).toContain(" by PRD:");
  });

  it("gives the flake rate by check and overall; old check lines count for neither", () => {
    expect(s.flakes.byCheck["check slice"]).toEqual({ runs: 3, flaky: 1, rate: 1 / 3 });
    // One quick line has the field, the other (twelve fields) doesn't; the full one is nine.
    expect(s.flakes.byCheck["check quick"]).toEqual({ runs: 1, flaky: 0, rate: 0 });
    expect(s.flakes.byCheck["check full"]).toBeUndefined();
    expect(s.flakes.byCheck["browser roundtrip"]).toEqual({ runs: 3, flaky: 1, rate: 1 / 3, recorded: 2 });
    expect(s.flakes.byCheck["browser sign-in"]).toEqual({ runs: 1, flaky: 0, rate: 0, recorded: 0 });
    // Only in the flake log: history, no rate.
    expect(s.flakes.byCheck["browser phase2"]).toEqual({ runs: 0, flaky: 0, rate: null, recorded: 1 });
    expect(s.flakes.byCheck["browser ui"]).toBeUndefined();
    expect(s.flakes.overall).toEqual({ runs: 8, flaky: 2, rate: 2 / 8 });
  });

  it("gives Codex's find rate once per head, carried and out-of-credits apart", () => {
    expect(s.codex).toEqual({
      reviewedHeads: 2,
      withFindings: 1,
      findRate: 0.5,
      carried: 1,
      outOfCredits: 1,
    });
  });

  it("honours --since", () => {
    const t = summarize(data, { since: "2026-03-02" });
    expect(t.slices).toMatchObject({ count: 0, running: 1 });
    expect(t.landings).toMatchObject({ count: 1, slowest: "hotfix/fence", notLanded: 1 });
    expect(Object.keys(t.checks.byMode)).toEqual(["quick"]);
    expect(t.flakes.byCheck["browser roundtrip"]).toEqual({ runs: 1, flaky: 0, rate: 0, recorded: 1 });
    expect(t.flakes.byCheck["check slice"]).toBeUndefined();
    expect(t.codex).toMatchObject({ reviewedHeads: 1, withFindings: 0, carried: 1, outOfCredits: 1 });
    expect(() => summarize(data, { since: "not a date" })).toThrow(/--since/);
  });

  it("formats the summary, and an empty one", () => {
    const text = formatSummary(s);
    expect(text).toContain(
      "Slices: 2 done (1 merged), median 120.0 m, slowest 180.0 m (garden-2); 1 running",
    );
    expect(text).toContain(
      "Landings: 2 landed, median 6.0 m, slowest 10.0 m (prd/garden); 1 refused or failed",
    );
    expect(text).toMatch(/browser roundtrip +3 +1 +33\.3% +2/);
    expect(text).toMatch(/overall +8 +2 +25\.0%/);
    expect(text).toContain(
      "Codex: 2 heads reviewed, 1 with findings (50.0%); 1 clean carried over a dev merge",
    );
    expect(text).toContain("out of credits on 1 head (not counted)");
    expect(text).toContain("Malformed lines skipped: run log 2, check log 1, flake log 1");
    const empty = formatSummary(summarize(loadData({})));
    expect(empty).toContain("Slices: none finished yet; 0 running");
    expect(empty).toContain("Codex: 0 heads reviewed, 0 with findings (-)");
    expect(empty).not.toContain("Malformed");
  });
});

describe("usualTime", () => {
  it("checks: passing runs by mode and branch kind", () => {
    expect(usualTime(data, { kind: "check", mode: "slice", branchKind: "slice" })).toEqual({
      samples: 2,
      medianSeconds: 180,
      slowestSeconds: 240,
    });
    expect(usualTime(data, { kind: "check", mode: "quick", branchKind: "prd" })).toMatchObject({
      samples: 2,
    });
    expect(usualTime(data, { kind: "check", mode: "quick", branchKind: "slice" })).toEqual({
      samples: 0,
      medianSeconds: null,
      slowestSeconds: null,
    });
  });

  it("takes only the last samples", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      check(
        `2026-03-01T${String(i % 24).padStart(2, "0")}:00:${String(i).padStart(2, "0")}Z`,
        "slice/g/1",
        "slice",
        (i + 1) * 10,
        0,
      ),
    ).join("\n");
    const u = usualTime(loadData({ checkLog: many }), { kind: "check", mode: "slice", last: 20 });
    expect(u.samples).toBe(20);
  });

  it("slices and landings", () => {
    expect(usualTime(data, { kind: "slice" })).toEqual({
      samples: 2,
      medianSeconds: 7200,
      slowestSeconds: 10800,
    });
    expect(usualTime(data, { kind: "landing", branchKind: "prd" })).toEqual({
      samples: 1,
      medianSeconds: 600,
      slowestSeconds: 600,
    });
    expect(usualTime(data, { kind: "landing", mode: "local" })).toMatchObject({
      samples: 1,
      medianSeconds: 120,
    });
    expect(() => usualTime(data, { kind: "nap" })).toThrow(/unknown kind/);
  });

  it("names branch kinds and checks", () => {
    expect(["slice/a/1", "prd/a", "plan/a", "hotfix/a", "dev"].map(branchKind)).toEqual([
      "slice",
      "prd",
      "plan",
      "hotfix",
      "other",
    ]);
    expect(
      ["roundtrip.mjs", "roundtrip.spec.mjs", "scripts/browser-checks/roundtrip.spec.mjs", "roundtrip"].map(
        checkName,
      ),
    ).toEqual(["roundtrip", "roundtrip", "roundtrip", "roundtrip"]);
  });
});

describe("the CLI", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "metrics-")));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const files = {
    run: join(dir, "run.jsonl"),
    check: join(dir, "check.log"),
    flake: join(dir, "flakes.log"),
  };
  writeFileSync(files.run, RUN_LOG);
  writeFileSync(files.check, CHECK_LOG);
  writeFileSync(files.flake, FLAKE_LOG);
  const cli = (...args) =>
    spawnSync(
      "node",
      [
        new URL("./metrics.mjs", import.meta.url).pathname,
        "--run-log",
        files.run,
        "--check-log",
        files.check,
        "--flake-log",
        files.flake,
        ...args,
      ],
      { encoding: "utf8" },
    );

  it("prints the summary, or JSON, with --since", () => {
    let r = cli();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Run metrics\n");
    r = cli("--json", "--since", "2026-03-02");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ since: "2026-03-02", landings: { count: 1 } });
  });

  it("refuses an unknown argument and a bad date; a missing log is empty", () => {
    expect(cli("--nope").status).toBe(1);
    expect(cli("--since", "soon").stderr).toContain("--since");
    const r = spawnSync(
      "node",
      [new URL("./metrics.mjs", import.meta.url).pathname, "--run-log", join(dir, "none")],
      {
        encoding: "utf8",
        env: { ...process.env, RISA_CHECK_LOG: "", RISA_BROWSER_FLAKES: "" },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Checks:\n  none recorded");
  });
});
