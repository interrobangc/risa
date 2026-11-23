import { describe, expect, it } from "vitest";
import { BacklogError } from "./format.mjs";
import * as reg from "./registry.mjs";

// The table before the registry (fictional rows), which the tooling refuses.
const OLD = [
  "# Backlog tracker",
  "",
  "Intro.",
  "",
  "## PRDs",
  "",
  "Which PRDs exist, what each depends on.",
  "",
  "| PRD | Doc | Depends on | Hot files |",
  "| --- | --- | ---------- | --------- |",
  "| `alpha` | [PRD](alpha-prd.md), [plan](alpha-plan.md): **done** (`1234abcd`, PR #3) | — | none now |",
  "| `beta` | [PRD](beta-prd.md): **done** except going live: slice 7 is the user's | (none) | none now |",
  "| `gamma` | to write (B-9) | `alpha` in `dev` (last item B-2) | `scripts/loops/`, the a\\|b form |",
  "| `delta` | [plan](delta-plan.md): **done**; B-40 waits on the user | — | varies by slice; none now |",
  "",
  "After the table.",
].join("\n");

// The registry's shape, with one row to be replaced.
const NEW = [
  "# Backlog tracker",
  "",
  "## PRDs",
  "",
  "| PRD | Flags | After | Hot files | Doc and notes |",
  "| --- | ----- | ----- | --------- | ------------- |",
  "| `x` | — | — | — | — |",
  "",
  "After the table.",
].join("\n");

const row = (topic, o = {}) => ({ topic, flags: [], after: [], hot: [], notes: "", ...o });
const topics = (rows) => rows.map((r) => r.topic);

describe("parseRegistry", () => {
  it("reads the old prose table as old (and refuses its rows), and no table as none", () => {
    const r = reg.parseRegistry(OLD);
    expect(r.format).toBe("old");
    expect(r.format === "old" && r.rows.map((o) => o.topic)).toEqual(["alpha", "beta", "gamma", "delta"]);
    expect(r.format === "old" && r.rows[2].hot).toBe("`scripts/loops/`, the a|b form");
    expect(reg.parseRegistry("# Backlog\n\nNo table.").format).toBe("none");
    expect(() => reg.rowsOf(OLD)).toThrow(
      /old prose form \(PRD \| Doc \| Depends on \| Hot files\); the tooling reads only the registry's columns \(PRD \| Flags \| After \| Hot files \| Doc and notes\)/,
    );
  });

  it("refuses a header it doesn't know", () => {
    expect(() => reg.parseRegistry("## PRDs\n\n| Name | What |\n| - | - |\n| a | b |")).toThrow(BacklogError);
  });
});

describe("the table round trip", () => {
  const rows = [
    row("one", { flags: ["standing", "hold"], hot: ["scripts/loops/", "a.ts"], notes: "fixes | pipes" }),
    row("two", { after: ["one"], notes: "[plan](two-plan.md)" }),
    row("three"),
  ];
  const preamble = reg.withRows(NEW, rows);

  it("writes and reads back the same rows in the same order", () => {
    expect(reg.rowsOf(preamble)).toEqual(rows);
    expect(reg.withRows(preamble, reg.rowsOf(preamble))).toBe(preamble);
  });

  it("writes — for empty cells and code spans for topics and paths", () => {
    expect(preamble).toContain("| `one` | standing, hold | — | `scripts/loops/`, `a.ts` | fixes \\| pipes |");
    expect(preamble).toContain("| `three` | — | — | — | — |");
  });
});

describe("edits", () => {
  const rows = [row("a"), row("b"), row("c")];

  it("adds at the end, or where it's told", () => {
    expect(topics(reg.addRow(rows, "d", []))).toEqual(["a", "b", "c", "d"]);
    expect(topics(reg.addRow(rows, "d", [], { first: true }))).toEqual(["d", "a", "b", "c"]);
    expect(topics(reg.addRow(rows, "d", [], { before: "b" }))).toEqual(["a", "d", "b", "c"]);
    expect(topics(reg.addRow(rows, "d", [], { after: "b" }))).toEqual(["a", "b", "d", "c"]);
    expect(reg.addRow(rows, "d", ["flags=standing,hold", "notes=waits"])[3]).toEqual(
      row("d", { flags: ["standing", "hold"], notes: "waits" }),
    );
    expect(() => reg.addRow(rows, "a", [])).toThrow(/already a PRD row/);
    expect(() => reg.addRow(rows, "Bad topic", [])).toThrow(/isn't a topic/);
    expect(() => reg.addRow(rows, "d", [], { after: "zz" })).toThrow(/no PRD row "zz"/);
  });

  it("sets flags, after, hot and notes, and — clears", () => {
    const [, b] = reg.updateRow(rows, "b", ["flags=hold", "after=a, c", "hot=`x/`,y.ts", "notes=hi there"]);
    expect(b).toEqual(
      row("b", { flags: ["hold"], after: ["a", "c"], hot: ["x/", "y.ts"], notes: "hi there" }),
    );
    const cleared = reg.setRow(b, ["flags=—", "after=", "hot=—", "notes=—"]);
    expect(cleared).toEqual(row("b"));
    expect(() => reg.updateRow(rows, "b", ["flags=paused"])).toThrow(/unknown flag paused/);
    expect(() => reg.updateRow(rows, "b", ["after=b"])).toThrow(/after itself/);
    expect(() => reg.updateRow(rows, "b", ["owner=me"])).toThrow(/can't set "owner"/);
    expect(() => reg.updateRow(rows, "b", ["oops"])).toThrow(/isn't key=value/);
    expect(() => reg.updateRow(rows, "zz", ["flags=hold"])).toThrow(/no PRD row/);
    expect(() => reg.updateRow(rows, "b", [])).toThrow(/usage/);
  });

  it("moves in all four forms", () => {
    expect(topics(reg.moveRow(rows, "c", { first: true }))).toEqual(["c", "a", "b"]);
    expect(topics(reg.moveRow(rows, "a", { last: true }))).toEqual(["b", "c", "a"]);
    expect(topics(reg.moveRow(rows, "c", { before: "b" }))).toEqual(["a", "c", "b"]);
    expect(topics(reg.moveRow(rows, "a", { after: "b" }))).toEqual(["b", "a", "c"]);
    expect(() => reg.moveRow(rows, "a", { after: "a" })).toThrow(/next to itself/);
    expect(() => reg.moveRow(rows, "a", { before: "zz" })).toThrow(/no PRD row "zz"/);
    expect(() => reg.moveRow(rows, "zz", { first: true })).toThrow(/no PRD row "zz"/);
  });
});

describe("stateOf", () => {
  const facts = {
    plans: new Set(["planned", "held", "running"]),
    worktrees: new Set(["running", "held-running"]),
    waiting: new Map([["fixes-a", 2]]),
  };
  const cases = [
    [row("finished", { flags: ["done"] }), "done"],
    [row("running"), "running"],
    [row("held-running", { flags: ["hold"] }), "running"],
    [row("held", { flags: ["hold"] }), "hold"],
    [row("planned"), "planned"],
    [row("unwritten"), "to-write"],
    [row("fixes-a", { flags: ["standing"] }), "planned"],
    [row("fixes-b", { flags: ["standing"] }), "idle"],
    [row("fixes-c", { flags: ["standing", "hold"] }), "hold"],
  ];
  it.each(cases)("%o is %s", (r, state) => expect(reg.stateOf(r, facts)).toBe(state));
});

describe("findings", () => {
  const problems = (rows, items = []) => reg.findings(rows, items).map((f) => `${f.id}: ${f.problem}`);

  it("finds nothing in a sound table", () => {
    expect(
      problems([row("a"), row("b", { after: ["a"] })], [{ id: "B-1", status: "triaged", prd: "a" }]),
    ).toEqual([]);
  });

  it("accepts the design flag: set, listed, and no finding", () => {
    const set = reg.setRow(row("a"), ["flags=design,hold"]);
    expect(set.flags).toEqual(["design", "hold"]);
    expect(problems([set])).toEqual([]);
    expect(reg.plannerModel(set)).toBe("fable");
    expect(reg.plannerModel(row("b"))).toBe("opus");
    expect(reg.plannerModel(undefined)).toBe("opus");
  });

  it("finds an After topic with no row, and an unknown flag", () => {
    expect(problems([row("a", { after: ["ghost"], flags: ["paused"] })])).toEqual([
      'a: has an unknown flag "paused" (flags: hold, done, standing, alone, design)',
      'a: comes after "ghost", which has no row in the PRD table',
    ]);
  });

  it("finds each cycle once, from the topic first in the table", () => {
    const rows = [
      row("a", { after: ["c"] }),
      row("b", { after: ["a"] }),
      row("c", { after: ["b"] }),
      row("d", { after: ["d"] }),
    ];
    expect(problems(rows)).toEqual([
      "a: is in a cycle of After: a → c → b → a",
      "d: is in a cycle of After: d → d",
    ]);
  });

  it("finds waiting items with no row, and waiting items on a done topic", () => {
    const items = [
      { id: "B-1", status: "triaged", prd: "ghost" },
      { id: "B-2", status: "in-progress", prd: "ghost" },
      { id: "B-3", status: "triaged", prd: "old" },
      { id: "B-4", status: "landed", prd: "old" },
      { id: "B-5", status: "dropped", prd: "nowhere" },
      { id: "B-6", status: "inbox", prd: "" },
    ];
    expect(problems([row("old", { flags: ["done"] })], items)).toEqual([
      "ghost: has 2 waiting items (B-1, B-2) but no row in the PRD table",
      "B-3: is triaged, but its topic old is done",
    ]);
  });

  it("finds a topic with two rows", () => {
    expect(problems([row("a"), row("a")])).toEqual(["a: has more than one row in the PRD table"]);
  });

  it("is never fixable", () => {
    expect(reg.findings([row("a", { after: ["x"] })], []).every((f) => f.fixable === false)).toBe(true);
  });
});
