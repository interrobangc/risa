// The release tier: repeat runs read as one result, the second zone's two modes,
// and filing that is capped and safe to rerun.
import { describe, expect, it } from "vitest";

import { summarizeBrowser } from "./browser-job.mjs";
import { applyFindings } from "./filing.mjs";
import { releasePasses } from "./gate.mjs";
import { parseBrakeList } from "./lists.mjs";
import { MAX_ZONE_FILINGS, ZONE_OVERFLOW_ITEM, combineRepeats, zoneFindings } from "./release.mjs";
import { jobsFor, planOutputs } from "./tiers.mjs";
import { buildVerdict } from "./verdict.mjs";
import { SECOND_ZONE, SECOND_ZONE_MODE, secondZoneEnv, testZone } from "./zones.mjs";

const SHA = "c".repeat(40);
const CHECKS = ["sign-in", "roundtrip"];
const spec = (/** @type {string} */ c) => `scripts/browser-checks/${c}.spec.mjs`;
const row = (/** @type {string} */ check, /** @type {string} */ verdict) => [
  check,
  { check, verdict, retried: false },
];
/** One suite run through the real summary: [sign-in, roundtrip] as runner verdicts. */
function suite(/** @type {string} */ a, /** @type {string} */ b, rerun = /** @type {string[]} */ ([])) {
  const first = new Map(/** @type {any} */ ([row("sign-in", a), row("roundtrip", b)]));
  const again = new Map(/** @type {any} */ (rerun.map((c) => row(c, "pass"))));
  const summary = summarizeBrowser(CHECKS, first, again);
  const failed = summary.rerun?.files.length || summary.notRun.length;
  return {
    result: failed ? "failure" : "success",
    outputs: { started: "true", failures: JSON.stringify(summary) },
  };
}
const PASS = () => suite("pass", "pass");
const baseNeeds = () =>
  /** @type {Record<string, any>} */ (
    Object.fromEntries(["plan", ...jobsFor("release").jobs].map((j) => [j, { result: "success" }]))
  );
const runs = (/** @type {any} */ a, /** @type {any} */ b, /** @type {any} */ c) => ({
  ...baseNeeds(),
  browser: a,
  "browser-2": b,
  "browser-3": c,
});
const verdict = (/** @type {Record<string, any>} */ needs, extra = {}) =>
  buildVerdict({
    commit: SHA,
    runId: "1",
    tier: "release",
    needs,
    brakes: parseBrakeList("check:roundtrip\n"),
    ...extra,
  });
const zoneFail = (/** @type {string[]} */ files) => ({
  result: "failure",
  outputs: {
    failures: JSON.stringify({ reported: true, total: 9, files, tests: [], truncated: false, rerun: null }),
  },
});
const testFiles = (/** @type {number} */ n) =>
  Array.from({ length: n }, (_, i) => `apps/web/app/t${String(i).padStart(2, "0")}.browser.test.tsx`);

describe("the release tier", () => {
  it("adds separate suite runs and the second zone after candidate", () => {
    expect(jobsFor("release").jobs.slice(-6)).toEqual([
      "browser",
      "browser-2",
      "browser-3",
      "zone-components-1",
      "zone-components-2",
      "zone-browser",
    ]);
    expect(planOutputs("ci/candidate/x")).toContain("release=false");
    expect(planOutputs("ci/release/x")).toContain("release=true");
    expect(planOutputs("ci/release/x", ["scripts/ci/ci.test.mjs"])).toContain("release=false");
  });

  it("moves a job to the one second zone", () => {
    expect(secondZoneEnv()).toEqual({ CARETOOK_TEST_ZONE: SECOND_ZONE, TZ: SECOND_ZONE });
    expect(testZone({})).toBe("America/Los_Angeles");
    expect(testZone({ CARETOOK_TEST_ZONE: SECOND_ZONE })).toBe(SECOND_ZONE);
    expect(SECOND_ZONE_MODE).toBe("report");
  });
});

describe("repeat runs", () => {
  it("are green when every run passes", () => {
    expect(verdict(runs(PASS(), PASS(), PASS())).kind).toBe("green");
  });

  it("block on a check failing in all three", () => {
    const bad = () => suite("FAIL", "pass");
    const v = verdict(runs(bad(), bad(), bad()));
    expect(v.kind).toBe("file");
    expect(v.afterRerun?.files).toEqual([spec("sign-in")]);
  });

  it("read failing in some as a flake that passes the gate", () => {
    const v = verdict(runs(suite("FAIL", "pass"), PASS(), PASS()));
    expect(v.kind).toBe("flake");
    expect(v.flaky).toEqual([{ job: "browser", file: spec("sign-in"), name: null, brake: false }]);
    expect(releasePasses(v, "release", SHA).pass).toBe(true);
  });

  it("count a pass on a run's own rerun as passing there", () => {
    const rerunPass = suite("FAIL", "pass", ["sign-in"]);
    const bad = () => suite("FAIL", "pass");
    expect(verdict(runs(bad(), rerunPass, bad())).kind).toBe("flake");
  });

  it("refuse a brake-list flake at the gate, and brake when it fails in all", () => {
    const v = verdict(runs(suite("pass", "FAIL"), PASS(), PASS()));
    expect(v.kind).toBe("flake");
    expect(releasePasses(v, "release", SHA).pass).toBe(false);
    const bad = () => suite("pass", "FAIL");
    expect(verdict(runs(bad(), bad(), bad())).kind).toBe("brake");
  });

  it("read a run with no report, or a check never reached, as infra", () => {
    expect(verdict(runs(PASS(), { result: "failure" }, PASS())).kind).toBe("infra");
    expect(verdict(runs(PASS(), suite("pass", "NOT-RUN"), PASS())).kind).toBe("infra");
    expect(combineRepeats({ browser: { result: "cancelled" } })).toEqual({ result: "failure", outputs: {} });
  });
});

describe("the second zone", () => {
  const failing = () => ({ ...baseNeeds(), "zone-components-1": zoneFail(["a.browser.test.tsx"]) });

  it("on report can't fail the verdict and names the files", () => {
    const v = verdict(failing());
    expect(v.kind).toBe("green");
    expect(v.secondZone).toMatchObject({ mode: "report", zone: SECOND_ZONE, files: ["a.browser.test.tsx"] });
  });

  it("on report isn't failed by a job that died", () => {
    const v = verdict({ ...baseNeeds(), "zone-browser": { result: "failure" } });
    expect(v.kind).toBe("green");
    expect(v.secondZone?.infra).toEqual(["zone-browser"]);
  });

  it("on block fails the verdict", () => {
    expect(verdict(failing(), { zoneMode: "block" }).kind).toBe("file");
  });

  it("ignores a file failing only on quarantined tests", () => {
    const failures = JSON.stringify({
      reported: true,
      total: 2,
      files: ["q.browser.test.tsx"],
      tests: [{ file: "q.browser.test.tsx", name: "listed" }],
      truncated: false,
      rerun: null,
    });
    const needs = { ...baseNeeds(), "zone-components-2": { result: "failure", outputs: { failures } } };
    const quarantine = [{ file: "q.browser.test.tsx", name: "listed", item: "B-1" }];
    expect(verdict(needs, { quarantine }).secondZone?.files).toEqual([]);
  });
});

describe("second-zone filing", () => {
  const withFiles = (/** @type {number} */ n, commit = SHA) => ({
    commit,
    secondZone: { zone: SECOND_ZONE, mode: "report", files: testFiles(n) },
  });
  function backlog() {
    const b = {
      items: [{ id: ZONE_OVERFLOW_ITEM, title: "zones", status: "triaged", notes: "" }],
      archived: [],
    };
    let next = 900;
    const write = {
      add: (/** @type {any} */ f) => {
        const item = { id: `B-${next++}`, title: f.title, status: "triaged", notes: f.note };
        b.items.push(item);
        return item;
      },
      note: (/** @type {any} */ item, /** @type {string} */ text) => {
        item.notes += `\n${text}`;
      },
    };
    return { b, write };
  }

  it("files one item per test file, in fixes-bug", () => {
    const findings = zoneFindings(withFiles(2));
    expect(findings.map((f) => f.prd)).toEqual(["fixes-bug", "fixes-bug"]);
    expect(new Set(findings.map((f) => f.key)).size).toBe(2);
  });

  it("caps a run at 10 and notes the rest on the zone item", () => {
    const findings = zoneFindings(withFiles(13));
    expect(findings.filter((f) => !f.item)).toHaveLength(MAX_ZONE_FILINGS);
    const over = findings.filter((f) => f.item);
    expect(over).toHaveLength(1);
    expect(over[0].item).toBe("B-750");
    expect(over[0].note).toContain("3 more test file(s)");
    expect(over[0].note).toContain(testFiles(13)[12]);
  });

  it("files nothing on block, or with no failures", () => {
    const blocked = { commit: SHA, secondZone: { zone: SECOND_ZONE, mode: "block", files: ["a"] } };
    expect(zoneFindings(blocked)).toEqual([]);
    expect(zoneFindings(withFiles(0))).toEqual([]);
    expect(zoneFindings({ commit: SHA, secondZone: null })).toEqual([]);
  });

  it("writes nothing new on a rerun of the same commit", () => {
    const { b, write } = backlog();
    applyFindings(b, null, zoneFindings(withFiles(12)), write);
    const before = JSON.stringify(b.items);
    expect(b.items).toHaveLength(11);
    const again = applyFindings(b, null, zoneFindings(withFiles(12)), write);
    expect(JSON.stringify(b.items)).toBe(before);
    expect(again.filed.filter((f) => f.created)).toEqual([]);
  });

  it("adds one note, and no item, for a later commit", () => {
    const { b, write } = backlog();
    applyFindings(b, null, zoneFindings(withFiles(1)), write);
    applyFindings(b, null, zoneFindings(withFiles(1, "d".repeat(40))), write);
    expect(b.items).toHaveLength(2);
    expect(b.items[1]?.notes.match(/\[ci-zone /g)).toHaveLength(2);
  });

  it("says when the overflow's item is gone", () => {
    const { b, write } = backlog();
    b.items = [];
    expect(applyFindings(b, null, zoneFindings(withFiles(11)), write).missed).toEqual(["B-750"]);
  });
});
