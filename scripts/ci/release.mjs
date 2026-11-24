// What the release tier adds to a verdict, pure: the three browser suite runs read
// as one result, and the second zone's failures. Imports no package: the verdict job
// runs with no install.
//
// Repeat runs: a check that fails in every run is a failure; one that fails in some
// (a run's own rerun pass counts as passing there) is a flake; one a run never
// reached, or a run with no report, proves nothing and reads as infra.
import { findingKey } from "./filing.mjs";
import { isQuarantined } from "./lists.mjs";

/** Each suite run is its own job, since one job's limit holds one suite. */
export const BROWSER_RUNS = /** @type {const} */ (["browser", "browser-2", "browser-3"]);
export const ZONE_JOBS = /** @type {const} */ (["zone-components-1", "zone-components-2", "zone-browser"]);
export const MAX_ZONE_FILINGS = 10;
/** Where second-zone failures past the cap are noted. */
export const ZONE_OVERFLOW_ITEM = "B-750";
const MAX_TITLE = 100;
const MAX_OVERFLOW_NAMES = 20;

const parse = (/** @type {string | undefined} */ text) => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * The three runs as the one `browser` job the verdict reads.
 * @param {Record<string, { result?: string, outputs?: Record<string, string> } | undefined>} needs
 */
export function combineRepeats(needs) {
  const runs = BROWSER_RUNS.map((job) => {
    const summary = parse(needs[job]?.outputs?.failures);
    if (!summary?.reported || !Array.isArray(summary.checks)) return null;
    return new Map(
      summary.checks.map((/** @type {{ check: string, result: string }} */ c) => [c.check, c.result]),
    );
  });
  const names = [...new Set(runs.flatMap((run) => (run ? [...run.keys()] : [])))];
  if (!names.length)
    return BROWSER_RUNS.every((job) => needs[job]?.result === "success")
      ? { result: "success" }
      : { result: "failure", outputs: {} };

  /** @type {string[]} */ const files = [];
  /** @type {string[]} */ const still = [];
  /** @type {string[]} */ const notRun = [];
  const checks = names.map((check) => {
    const results = runs.map((run) => /** @type {string} */ (run?.get(check) ?? "not-run"));
    const file = `scripts/browser-checks/${check}.spec.mjs`;
    let result = "flake";
    if (results.includes("not-run")) result = "not-run";
    else if (results.every((r) => r === "pass")) result = "pass";
    else if (results.every((r) => r === "fail")) result = "fail";
    if (result === "not-run") notRun.push(check);
    else if (result !== "pass") files.push(file);
    if (result === "fail") still.push(file);
    return { check, result, runs: results };
  });
  const summary = {
    reported: true,
    total: names.length,
    files,
    tests: [],
    truncated: false,
    rerun: files.length ? { files: still, tests: [] } : null,
    quarantined: [],
    notRun,
    checks,
  };
  return {
    result: still.length || notRun.length ? "failure" : "success",
    outputs: { started: "true", failures: JSON.stringify(summary) },
  };
}

/**
 * The second zone's result: the files still failing after their rerun, less those
 * failing only on quarantined tests, and the jobs that proved nothing.
 * @param {Record<string, { result?: string, outputs?: Record<string, string> } | undefined>} needs
 * @param {{ zone: string, mode: string, quarantine?: { file: string, name: string, item: string }[] }} setting
 */
export function summarizeZone(needs, { zone, mode, quarantine = [] }) {
  /** @type {Set<string>} */ const files = new Set();
  /** @type {string[]} */ const infra = [];
  let truncated = false;
  for (const job of ZONE_JOBS) {
    const need = needs[job];
    const summary = parse(need?.outputs?.failures);
    truncated ||= !!summary?.truncated;
    const failing = /** @type {string[]} */ (summary?.rerun?.files ?? summary?.files ?? []);
    /** @type {{ file: string, name: string }[]} */ const tests =
      summary?.rerun?.tests ?? summary?.tests ?? [];
    const own = failing.filter((file) => {
      const named = tests.filter((t) => t.file === file);
      return !named.length || named.some((t) => !isQuarantined(quarantine, t.file, t.name));
    });
    for (const file of own) files.add(file);
    if (summary?.notRun?.length || (need?.result !== "success" && !failing.length)) infra.push(job);
  }
  return { zone, mode, files: [...files].sort(), infra, truncated };
}

const shortTitle = (/** @type {string} */ text) =>
  text.length > MAX_TITLE ? `…${text.slice(text.length - MAX_TITLE + 1)}` : text;

/**
 * The backlog findings of a report-mode verdict: one per test file, the first
 * MAX_ZONE_FILINGS in sorted order, and the rest as one note. A file's key doesn't
 * change between runs and `once` marks the commit, so a rerun of the same commit
 * adds no item and no note.
 * @param {any} verdict
 * @param {{ url?: string }} [from]
 */
export function zoneFindings(verdict, { url } = {}) {
  const z = verdict?.secondZone;
  if (!z || z.mode !== "report" || !z.files.length) return [];
  const commit = String(verdict.commit).slice(0, 8);
  const where = `${commit}${url ? ` in ${url}` : ""}`;
  const files = [...new Set(/** @type {string[]} */ (z.files))].sort();
  /** @type {any[]} */
  const findings = files.slice(0, MAX_ZONE_FILINGS).map((file) => {
    const once = `[ci-zone ${commit}]`;
    return {
      key: findingKey({ file, name: `second zone ${z.zone}` }),
      title: shortTitle(`CI: ${file} fails in ${z.zone}`),
      prd: "fixes-bug",
      once,
      note: `${once} Fails in ${z.zone} on ${where}; reported, not blocking.`,
      quarantine: null,
    };
  });
  const rest = files.slice(MAX_ZONE_FILINGS);
  if (rest.length) {
    const once = `[ci-zone-overflow ${commit}]`;
    const names = rest.slice(0, MAX_OVERFLOW_NAMES).join(", ");
    const more = rest.length > MAX_OVERFLOW_NAMES ? ` and ${rest.length - MAX_OVERFLOW_NAMES} more` : "";
    findings.push({
      key: `zone-overflow-${commit}`,
      item: ZONE_OVERFLOW_ITEM,
      once,
      title: "",
      prd: "fixes-bug",
      note: `${once} ${rest.length} more test file(s) fail in ${z.zone} on ${where}, past the cap of ${MAX_ZONE_FILINGS}: ${names}${more}.`,
      quarantine: null,
    });
  }
  return findings;
}
