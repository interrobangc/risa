// The slice fields parser, through its exports and its command line.
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  formatFields,
  lineAnchors,
  mergedSlices,
  sliceFields,
  sliceSections,
  splitList,
} from "./slice-fields.mjs";

const CLI = new URL("./slice-fields.mjs", import.meta.url).pathname;

const plan = `# Plan: Example

## Status

Slice 1 is ready.

## Slice 1: Everything given

Stack: yes · Reads: docs/loops.md, AGENTS.md (all of it, once) · Tests: unit, e2e:invites

**What to build:** …

## Slice 2: Nothing given

**What to build:** …

## Slice 3: Some given, other separators

Reads: handbook/sync.md; tests: component

## Slice 4: Malformed

Stack: maybe · Colour: blue · Tests:

## Slice 5: Fields after the text are not fields

Some text first.

Stack: yes

## Slice 6: Blocked by

Stack: no · Reads: none · Tests: unit · Blocked by: slice 3, 4

## Slice 7: Blocked by, other forms

Stack: no · Tests: unit · blocked  BY: none · Colour: blue

## Slice 8: Blocked by, malformed

Blocked by: 2, later · Stack: no · Reads: none · Tests: unit

## Slice 10: Check

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/x.test.mjs

## Slice 13: Sonnet

Stack: no · Reads: none · Tests: unit · Check: loops/y.test.mjs · Model: Sonnet

## Slice 14: Haiku is a helper's model

Stack: no · Reads: none · Tests: unit · Model: haiku

## Slice 12: Two digits

Stack: no | Reads: none | Tests: integration
`;

describe("sliceFields", () => {
  it("reads all three fields", () => {
    const f = sliceFields(plan, 1);
    expect(f).toMatchObject({
      found: true,
      stack: true,
      reads: ["docs/loops.md", "AGENTS.md (all of it, once)"],
      readsText: "docs/loops.md, AGENTS.md (all of it, once)",
      tests: ["unit", "e2e:invites"],
      missing: [],
      warnings: [],
    });
  });

  it("defaults every missing field, with a warning each", () => {
    const f = sliceFields(plan, 2);
    expect(f).toMatchObject({ found: true, stack: false, reads: [], tests: [] });
    expect(f.missing).toEqual(["stack", "reads", "tests"]);
    expect(f.warnings).toEqual(["no Stack field", "no Reads field", "no Tests field"]);
  });

  it("accepts ; and | separators and any case", () => {
    const f = sliceFields(plan, 3);
    expect(f).toMatchObject({ stack: false, reads: ["handbook/sync.md"], tests: ["component"] });
    expect(f.missing).toEqual(["stack"]);
    expect(sliceFields(plan, 12)).toMatchObject({
      stack: false,
      reads: [],
      tests: ["integration"],
      missing: [],
    });
  });

  it("warns about malformed fields and falls back to the defaults", () => {
    const f = sliceFields(plan, 4);
    expect(f.stack).toBe(false);
    expect(f.tests).toEqual([]);
    expect(f.warnings).toEqual(
      expect.arrayContaining([
        'unknown field "Colour"',
        'Stack must be yes or no, not "maybe"; using no',
        "Tests is empty",
        "no Reads field",
      ]),
    );
  });

  it("knows Blocked by, parses its value and still warns on an unknown field", () => {
    const f = sliceFields(plan, 6);
    expect(f).toMatchObject({ stack: false, tests: ["unit"], blockedBy: [3, 4], missing: [], warnings: [] });
    const g = sliceFields(plan, 7);
    expect(g.blockedBy).toEqual([]);
    expect(g.warnings).toEqual(['unknown field "Colour"', "no Reads field"]);
    expect(sliceFields(plan, 1).blockedBy).toEqual([]);
  });

  it("warns on a Blocked by that isn't slice numbers, and starts a fields line with it", () => {
    const f = sliceFields(plan, 8);
    expect(f).toMatchObject({ tests: ["unit"], blockedBy: [2], missing: [] });
    expect(f.warnings).toEqual(['Blocked by takes slice numbers, not "later"']);
  });

  it("knows Check: the fields parse complete, with its file", () => {
    const f = sliceFields(plan, 10);
    expect(f).toMatchObject({ check: ["loops/x.test.mjs"], missing: [], warnings: [] });
    expect(f.given).toEqual(["stack", "reads", "tests", "blocked by", "check"]);
    expect(sliceFields(plan, 1)).toMatchObject({ check: [], given: ["stack", "reads", "tests"] });
  });

  it("knows Model: sonnet parses, no field reads opus, any other model is an error", () => {
    expect(sliceFields(plan, 13)).toMatchObject({ model: "sonnet", warnings: [], errors: [] });
    expect(sliceFields(plan, 1)).toMatchObject({ model: "opus", errors: [] });
    const f = sliceFields(plan, 14);
    expect(f).toMatchObject({ model: "opus", warnings: [] });
    expect(f.errors).toEqual(['Model must be opus or sonnet, not "haiku"']);
  });

  it("only reads fields directly under the heading", () => {
    const f = sliceFields(plan, 5);
    expect(f.stack).toBe(false);
    expect(f.missing).toEqual(["stack", "reads", "tests"]);
  });

  it("says when the slice isn't in the plan", () => {
    const f = sliceFields(plan, 9);
    expect(f.found).toBe(false);
    expect(f.warnings).toEqual(['no "Slice 9" heading in the plan']);
    // "Slice 1" doesn't match "Slice 12", nor the other way round
    expect(sliceFields(plan, 12).found).toBe(true);
  });

  it("formats the fields for the loop's prompt", () => {
    expect(formatFields(sliceFields(plan, 1))).toBe(
      "Stack: yes\nReads: docs/loops.md, AGENTS.md (all of it, once)\nTests: unit, e2e:invites\nModel: opus",
    );
    expect(formatFields(sliceFields(plan, 2))).toBe(
      "Stack: no\nReads: nothing besides AGENTS.md\nTests: none named\nModel: opus",
    );
  });
});

describe("mergedSlices", () => {
  it("reads merge SHAs and done states from any table with a Slice column", () => {
    const status =
      "| Slice | State | Merge |\n| - | - | - |\n| 1 | started | |\n| 2 | landed | |\n| 3 | | abc1234 |";
    expect([...mergedSlices([status])].sort()).toEqual([2, 3]);
  });
});

describe("splitList", () => {
  it("splits on commas outside parentheses and drops none", () => {
    expect(splitList("a (b, c), d ,, none")).toEqual(["a (b, c)", "d"]);
  });
});

describe("lineAnchors", () => {
  it("finds a line number beside a file, or alone in a code span", () => {
    expect(lineAnchors("Change `loops/file.mjs ~158`, then file.mjs:231 and `:231`.")).toEqual([
      "loops/file.mjs ~158",
      "file.mjs:231",
      "`:231`",
    ]);
    expect(lineAnchors("see `land.sh` line 40")).toEqual(["land.sh` line 40"]);
  });

  it("leaves plain numbers in prose alone", () => {
    expect(lineAnchors("Rotate past ~120k; 3 files in `land.sh`, port :5436, 10:30, slice 158.")).toEqual([]);
  });
});

describe("sliceSections", () => {
  it("gives each slice's body, to the next heading of its level or above", () => {
    const text =
      "## Wave 1\n\n### Slice 1: a\n\nx\n\n#### Notes\n\ny\n\n### Slice 2: b\n\nz\n\n## Wave 2\n\nw";
    expect(sliceSections(text).map((s) => [s.n, s.body.trim()])).toEqual([
      [1, "x\n\n#### Notes\n\ny"],
      [2, "z"],
    ]);
  });
});

describe("the command line", () => {
  it("prints the fields of a plan on stdin, with warnings on stderr", () => {
    const r = spawnSync("node", [CLI, "3"], { input: plan, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("Stack: no\nReads: handbook/sync.md\nTests: component\nModel: opus\n");
    expect(r.stderr).toBe("warning: slice 3: no Stack field\n");
  });

  it("prints one field with --get", () => {
    expect(execFileSync("node", [CLI, "1", "--get", "stack"], { input: plan, encoding: "utf8" })).toBe(
      "yes\n",
    );
    expect(execFileSync("node", [CLI, "1", "--get", "tests"], { input: plan, encoding: "utf8" })).toBe(
      "unit, e2e:invites\n",
    );
    const check = spawnSync("node", [CLI, "10", "--get", "check"], { input: plan, encoding: "utf8" });
    expect([check.stdout, check.stderr]).toEqual(["loops/x.test.mjs\n", ""]);
    expect(execFileSync("node", [CLI, "13", "--get", "model"], { input: plan, encoding: "utf8" })).toBe(
      "sonnet\n",
    );
  });

  it("refuses Model: haiku, naming opus and sonnet", () => {
    const r = spawnSync("node", [CLI, "14", "--get", "model"], { input: plan, encoding: "utf8" });
    expect([r.status, r.stdout]).toEqual([1, ""]);
    expect(r.stderr).toBe('error: slice 14: Model must be opus or sonnet, not "haiku"\n');
  });

  it("refuses a bad slice number", () => {
    const r = spawnSync("node", [CLI, "x"], { input: plan, encoding: "utf8" });
    expect(r.status).toBe(2);
  });
});
