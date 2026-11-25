// What the release tier files, pure: a report-mode verdict's second-zone failures
// as backlog findings, for `ci zone-file` (ci-file.mjs) and the release gate. The
// project's half (release-jobs.mjs, beside its verdict) reads the release jobs into
// the verdict; this one reads only the verdict it wrote.
import { loadConfig } from "../loops/config.mjs";
import { findingKey } from "./filing.mjs";

export const MAX_ZONE_FILINGS = 10;
const MAX_TITLE = 100;
const MAX_OVERFLOW_NAMES = 20;

/**
 * Where second-zone failures past the cap are noted: the config's
 * backlog.zoneOverflowItem, or null (the rest go unnoted).
 * @param {any} [config]
 * @returns {string | null}
 */
export const zoneOverflowItem = (config = loadConfig().config) => config.backlog?.zoneOverflowItem ?? null;

/**
 * The topic CI's failures are filed under: the config's backlog.ciFailureTopic, or
 * "" (no topic) when it sets none.
 * @param {any} [config]
 * @returns {string}
 */
export const ciFailureTopic = (config = loadConfig().config) => config.backlog?.ciFailureTopic ?? "";

const shortTitle = (/** @type {string} */ text) =>
  text.length > MAX_TITLE ? `…${text.slice(text.length - MAX_TITLE + 1)}` : text;

/**
 * The backlog findings of a report-mode verdict: one per test file, the first
 * MAX_ZONE_FILINGS in sorted order, and the rest as one note. A file's key doesn't
 * change between runs and `once` marks the commit, so a rerun of the same commit
 * adds no item and no note.
 * @param {any} verdict
 * @param {{ url?: string, overflowItem?: string | null, topic?: string }} [from] overflowItem:
 *   zoneOverflowItem()'s; topic: ciFailureTopic()'s
 */
export function zoneFindings(
  verdict,
  { url, overflowItem = zoneOverflowItem(), topic = ciFailureTopic() } = {},
) {
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
      prd: topic,
      once,
      note: `${once} Fails in ${z.zone} on ${where}; reported, not blocking.`,
      quarantine: null,
    };
  });
  const rest = files.slice(MAX_ZONE_FILINGS);
  if (rest.length && overflowItem) {
    const once = `[ci-zone-overflow ${commit}]`;
    const names = rest.slice(0, MAX_OVERFLOW_NAMES).join(", ");
    const more = rest.length > MAX_OVERFLOW_NAMES ? ` and ${rest.length - MAX_OVERFLOW_NAMES} more` : "";
    findings.push({
      key: `zone-overflow-${commit}`,
      item: overflowItem,
      once,
      title: "",
      prd: topic,
      note: `${once} ${rest.length} more test file(s) fail in ${z.zone} on ${where}, past the cap of ${MAX_ZONE_FILINGS}: ${names}${more}.`,
      quarantine: null,
    });
  }
  return findings;
}
