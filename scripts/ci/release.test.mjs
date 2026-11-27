// The release tier's filing: a report-mode verdict's second-zone failures as
// findings, capped and safe to rerun. The core's half; the verdict that carries
// them is the project's (release-jobs.test.mjs).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MANIFEST, parseManifest } from "../loops/boundary.mjs";
import { backlogIds } from "../loops/config.mjs";
import { applyFindings } from "./filing.mjs";
import { MAX_ZONE_FILINGS, ciFailureTopic, zoneFindings, zoneOverflowItem } from "./release.mjs";

// The checkout (or a standalone copy) the core's files sit in: the manifest is the core's.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SHA = "c".repeat(40);
const ZONE = "Pacific/Auckland";
const OVERFLOW = /** @type {string} */ (zoneOverflowItem());
const testFiles = (/** @type {number} */ n) =>
  Array.from({ length: n }, (_, i) => `src/t${String(i).padStart(2, "0")}.browser.test.tsx`);

describe("second-zone filing", () => {
  const withFiles = (/** @type {number} */ n, commit = SHA) => ({
    commit,
    secondZone: { zone: ZONE, mode: "report", files: testFiles(n) },
  });
  function backlog() {
    const b = {
      items: [{ id: OVERFLOW, title: "zones", status: "triaged", notes: "" }],
      archived: [],
    };
    let next = 900;
    const write = {
      add: (/** @type {any} */ f) => {
        const item = { id: backlogIds().id(next++), title: f.title, status: "triaged", notes: f.note };
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
    expect(zoneFindings(withFiles(1), { topic: "fixes-ci" }).map((f) => f.prd)).toEqual(["fixes-ci"]);
    expect(ciFailureTopic({ backlog: { ciFailureTopic: "fixes-ci" } })).toBe("fixes-ci");
    // No topic set: CI refuses to file, and a verdict with nothing to file still reads.
    expect(() => ciFailureTopic({ backlog: {} })).toThrow(/sets no backlog\.ciFailureTopic/);
    expect(new Set(findings.map((f) => f.key)).size).toBe(2);
  });

  it("caps a run at 10 and notes the rest on the zone item", () => {
    const findings = zoneFindings(withFiles(13));
    expect(findings.filter((f) => !f.item)).toHaveLength(MAX_ZONE_FILINGS);
    const over = findings.filter((f) => f.item);
    expect(over).toHaveLength(1);
    expect(over[0].item).toBe(OVERFLOW);
    expect(over[0].note).toContain("3 more test file(s)");
    expect(over[0].note).toContain(testFiles(13)[12]);
  });

  it("files nothing on block, or with no failures", () => {
    const blocked = { commit: SHA, secondZone: { zone: ZONE, mode: "block", files: ["a"] } };
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

  it("names the overflow's item from the config, and notes nothing with none", () => {
    expect(OVERFLOW).toMatch(new RegExp(`^${backlogIds().pattern}$`));
    expect(zoneOverflowItem({ backlog: { idPrefix: "X" } })).toBeNull();
    const findings = zoneFindings(withFiles(13), { overflowItem: null });
    expect(findings).toHaveLength(MAX_ZONE_FILINGS);
    expect(findings.filter((f) => f.item)).toEqual([]);
    expect(zoneFindings(withFiles(13), { overflowItem: "X-9" }).at(-1).item).toBe("X-9");
  });

  it("says when the overflow's item is gone", () => {
    const { b, write } = backlog();
    b.items = [];
    expect(applyFindings(b, null, zoneFindings(withFiles(11)), write).missed).toEqual([OVERFLOW]);
  });
});

describe("the core's CI modules", () => {
  it("name no backlog id: the overflow's item is the config's", () => {
    const { owners } = parseManifest(readFileSync(join(ROOT, MANIFEST), "utf8"));
    const core = [...owners]
      .filter(([path, owner]) => owner === "core" && /^scripts\/ci\/[^/]+\.mjs$/.test(path))
      .map(([path]) => path)
      .filter((path) => !path.endsWith(".test.mjs"));
    expect(core).toContain("scripts/ci/release.mjs");
    const id = new RegExp(`\\b${backlogIds().pattern}\\b`);
    expect(core.filter((path) => id.test(readFileSync(join(ROOT, path), "utf8")))).toEqual([]);
  });
});
