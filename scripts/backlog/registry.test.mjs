import { describe, expect, it } from "vitest";
import { BacklogError } from "./format.mjs";
import * as reg from "./registry.mjs";

// Today's shape (fictional rows): a done row, a "done except" row, a to-write row with prose.
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

const row = (topic, o = {}) => ({ topic, flags: [], after: [], hot: [], notes: "", ...o });
const topics = (rows) => rows.map((r) => r.topic);

describe("parseRegistry", () => {
  it("reads today's table as old, and no table as none", () => {
    const r = reg.parseRegistry(OLD);
    expect(r.format).toBe("old");
    expect(r.format === "old" && r.rows.map((o) => o.topic)).toEqual(["alpha", "beta", "gamma", "delta"]);
    expect(r.format === "old" && r.rows[2].hot).toBe("`scripts/loops/`, the a|b form");
    expect(reg.parseRegistry("# Backlog\n\nNo table.").format).toBe("none");
    expect(() => reg.rowsOf(OLD)).toThrow(/isn't migrated yet: run pnpm backlog prd migrate/);
  });

  it("refuses a header it doesn't know", () => {
    expect(() => reg.parseRegistry("## PRDs\n\n| Name | What |\n| - | - |\n| a | b |")).toThrow(BacklogError);
  });
});

describe("migrate", () => {
  const { preamble, count } = reg.migrate(OLD);
  const rows = reg.rowsOf(preamble);

  it("keeps every row in its order, with only done from the doc cell", () => {
    expect(count).toBe(4);
    expect(topics(rows)).toEqual(["alpha", "beta", "gamma", "delta"]);
    expect(rows.map((r) => r.flags)).toEqual([["done"], [], [], []]);
    expect(rows.every((r) => !r.after.length && !r.hot.length)).toBe(true);
  });

  it("keeps the old prose at the end of the notes, unless it said nothing", () => {
    expect(rows[0].notes).toBe("[PRD](alpha-prd.md), [plan](alpha-plan.md): **done** (`1234abcd`, PR #3)");
    expect(rows[1].notes).toBe("[PRD](beta-prd.md): **done** except going live: slice 7 is the user's");
    expect(rows[2].notes).toBe(
      "to write (B-9) · Depends on: `alpha` in `dev` (last item B-2) · Hot files: `scripts/loops/`, the a|b form",
    );
    expect(rows[3].notes).toBe(
      "[plan](delta-plan.md): **done**; B-40 waits on the user · Hot files: varies by slice; none now",
    );
  });

  it("rewrites the section's intro, keeps the rest of the preamble, and refuses a second run", () => {
    expect(
      preamble.startsWith("# Backlog tracker\n\nIntro.\n\n## PRDs\n\n" + reg.INTRO + "\n\n| PRD | Flags |"),
    ).toBe(true);
    expect(preamble).not.toContain("Which PRDs exist");
    expect(preamble.endsWith("|\n\nAfter the table.")).toBe(true);
    expect(() => reg.migrate(preamble)).toThrow(/already migrated/);
  });

  it("says done only for **done** with at most a parenthesis after it", () => {
    expect(reg.saysDone("[PRD](x.md): **done**")).toBe(true);
    expect(reg.saysDone("[PRD](x.md): **done** (`abc`)")).toBe(true);
    expect(reg.saysDone("**done** except going live")).toBe(false);
    expect(reg.saysDone("**done**, all 6 slices in dev")).toBe(false);
    expect(reg.saysDone("**Done 2026-11-20**: all in dev")).toBe(false);
    expect(reg.saysDone("to write")).toBe(false);
  });
});

describe("the table round trip", () => {
  const rows = [
    row("one", { flags: ["standing", "hold"], hot: ["scripts/loops/", "a.ts"], notes: "fixes | pipes" }),
    row("two", { after: ["one"], notes: "[plan](two-plan.md)" }),
    row("three"),
  ];
  const preamble = reg.withRows(reg.migrate(OLD).preamble, rows);

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

  it("finds an After topic with no row, and an unknown flag", () => {
    expect(problems([row("a", { after: ["ghost"], flags: ["paused"] })])).toEqual([
      'a: has an unknown flag "paused" (flags: hold, done, standing, alone)',
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
