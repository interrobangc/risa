import { describe, expect, it } from "vitest";
import { formatSummary, parseLog, prdOf, summarize } from "./check-times.mjs";

const line = (start, branch, mode, secs, exit, run = "", all = "") =>
  [start, "wt", branch, mode, "why", secs, "10.0", "12.0", exit, run, all].join("\t");

describe("check log summary", () => {
  it("an empty log has no runs", () => {
    const s = summarize("");
    expect(s).toMatchObject({ runs: 0, failures: 0, skipped: 0, byMode: {}, byPrd: {} });
    expect(formatSummary(s)).toBe("Checks: none recorded");
  });

  const log = [
    line("2026-11-20T10:00:00Z", "slice/alpha/1", "full", 600, 0),
    line("2026-11-21T10:00:00Z", "slice/alpha/2", "full", 840, 1),
    line("2026-11-21T11:00:00Z", "prd/beta", "quick", 120, 0, "12", "500"),
    line("2026-11-21T12:00:00Z", "slice/alpha/1", "quick", 60, 0, "3", "500"),
  ].join("\n");

  it("groups a mixed log by mode and by PRD", () => {
    const s = summarize(log);
    expect(s.runs).toBe(4);
    expect(s.failures).toBe(1);
    expect(s.totalMinutes).toBeCloseTo(27);
    expect(s.medianMinutes).toBeCloseTo(6); // median of 60, 120, 600, 840 s
    expect(s.byMode.full).toMatchObject({ runs: 2, failures: 1 });
    expect(s.byMode.full.medianMinutes).toBeCloseTo(12);
    expect(s.byMode.quick).toMatchObject({ runs: 2, failures: 0 });
    expect(s.byPrd.alpha.runs).toBe(3);
    expect(s.byPrd.beta.runs).toBe(1);
    const out = formatSummary(s);
    expect(out).toContain("By mode:");
    expect(out).toContain("By PRD:");
  });

  it("--since leaves out earlier runs", () => {
    const s = summarize(log, { since: "2026-11-21" });
    expect(s.runs).toBe(3);
    expect(s.byMode.full.runs).toBe(1);
    expect(formatSummary(s, { since: "2026-11-21" })).toContain("since 2026-11-21");
    expect(() => summarize(log, { since: "nonsense" })).toThrow(/since/);
  });

  it("skips and counts a malformed line", () => {
    const text = `${log}\nnot a log line\n2026-11-21T12:00:00Z\twt\tb\tfull\twhy\tabc\t1\t1\t0\n`;
    const s = summarize(text);
    expect(s.runs).toBe(4);
    expect(s.skipped).toBe(2);
    expect(formatSummary(s)).toContain("2 malformed lines skipped");
  });

  it("parses the test-file fields, empty for a full run", () => {
    const { runs } = parseLog(log);
    expect(runs[0]).toMatchObject({ filesRun: null, filesAll: null, exit: 0 });
    expect(runs[2]).toMatchObject({ filesRun: 12, filesAll: 500, loadStart: 10, loadEnd: 12 });
  });

  it("parses the seconds waited for the load, none on a line from before the gate", () => {
    const { runs, skipped } = parseLog(
      `${line("2026-11-21T12:00:00Z", "prd/beta", "full", 60, 0)}\t95\n${log}`,
    );
    expect(skipped).toBe(0);
    expect(runs[0]).toMatchObject({ seconds: 60, loadWaited: 95 });
    expect(runs[1].loadWaited).toBeNull();
  });

  it("names a PRD from the branch, else the worktree", () => {
    expect(prdOf({ branch: "slice/x/3", worktree: "x-3" })).toBe("x");
    expect(prdOf({ branch: "prd/x", worktree: "x" })).toBe("x");
    expect(prdOf({ branch: "", worktree: "odd" })).toBe("odd");
  });
});
