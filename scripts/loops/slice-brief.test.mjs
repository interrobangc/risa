// The slice brief (what a slice prompt embeds of its plan and PRD), through
// its exports and its command line. The prompt itself: prompt.test.mjs.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { citations, citedParts, sliceBrief, sliceSection, squeezeTables } from "./slice-brief.mjs";

const CLI = new URL("./slice-brief.mjs", import.meta.url).pathname;

const plan = `# Plan: P

## Status

Slice 2 is next.

## Wave 1

Wave one's intro.

### Slice 1: First

Stack: no · Reads: none · Tests: unit

#### Notes

Slice one's notes stay with it.

\`\`\`md
## Slice 2: not a heading, it's fenced
\`\`\`

### Slice 2: Second

Slice two's text.

## Slice 3: Outside any wave

Slice three's text.
`;

describe("sliceSection", () => {
  it("runs from the heading to the next of its level, deeper headings and fences included", () => {
    const s = sliceSection(plan, 1);
    expect(s.heading).toBe("Slice 1: First");
    expect(s.text).toMatch(/^### Slice 1: First\n/);
    expect(s.text).toContain("Slice one's notes stay with it.");
    expect(s.text).toContain("## Slice 2: not a heading, it's fenced");
    expect(s.text).not.toContain("Slice two's text");
    expect(s.wave).toEqual({ name: "Wave 1", intro: "Wave one's intro." });
    expect(s.architecture).toBeNull();
  });

  it("finds the real heading, not a fenced one, and no wave outside one", () => {
    expect(sliceSection(plan, 2).text).toBe("### Slice 2: Second\n\nSlice two's text.");
    expect(sliceSection(plan, 3).wave).toBeNull();
    expect(sliceSection(plan, 9)).toBeNull();
  });

  it("carries the plan's architectural decisions", () => {
    const s = sliceSection("# P\n\n## Architectural decisions\n\n- One rule.\n\n## Slice 1: A\n\nText.\n", 1);
    expect(s.architecture).toBe("- One rule.");
  });
});

describe("citations", () => {
  it("reads italic names, story numbers and ranges, and backlog ids", () => {
    const c = citations(
      "Build the PRD's _The `design` flag_ and _Asking:_ (B-12, B-7). **User stories:** US 1, 3 to 5 and 8.",
    );
    expect([...c.names]).toEqual(["the design flag", "asking"]);
    expect(c.stories).toEqual([1, 3, 4, 5, 8]);
    expect([...c.items]).toEqual(["B-12", "B-7"]);
  });

  it("ignores snake_case words and code", () => {
    expect([...citations("the `care_recipient` table and CARETOOK_X_Y").names]).toEqual([]);
  });
});

describe("citedParts", () => {
  const prd = `# PRD

## Decisions

| Decision          | Why | Source   |
| ----------------- | --- | -------- |
| **Kept:** a rule  | x   | assumed  |
| Another rule      | y   | item B-3 |

## The store

Store text.

### Inside it

- **Nested** bullet, inside a cited heading.

## Implementation decisions

- **Asking:** asks first.
  and its second line.
- **Other:** not cited.
`;

  it("embeds a cited heading whole, cited bullets with their lines, and no part twice", () => {
    const parts = citedParts(prd, citations("_The store_, _Nested_ and _Asking_"));
    expect(parts.map((p) => p.label)).toEqual(["_The store_", "_Asking_"]);
    expect(parts[0].text).toContain("- **Nested** bullet");
    expect(parts[1].text).toBe("- **Asking:** asks first.\n  and its second line.");
  });

  it("embeds the decision rows cited by lead or by item, with the header, squeezed", () => {
    const [rows] = citedParts(prd, citations("_Kept_ (B-3)"));
    expect(rows.label).toBe("_Decisions_ rows");
    expect(rows.text).toBe(
      "| Decision | Why | Source |\n| --- | --- | --- |\n| **Kept:** a rule | x | assumed |\n| Another rule | y | item B-3 |",
    );
    expect(citedParts(prd, citations("nothing cited"))).toEqual([]);
  });

  it("the whole table when _Decisions_ is cited", () => {
    const parts = citedParts(prd, citations("the PRD's _Decisions_ (B-3)"));
    expect(parts.map((p) => p.label)).toEqual(["_Decisions_"]);
  });
});

describe("sliceBrief and the command line", () => {
  it("labels each block and ends with an end line", () => {
    const out = sliceBrief({ planText: plan, prdText: "", n: 1, topic: "P" });
    expect(out).toMatch(/^----- plans\/P-plan\.md: Wave 1, its intro\nWave one's intro\.\n\n/);
    expect(out).toContain("----- plans/P-plan.md: slice 1's section\n### Slice 1: First");
    expect(out.endsWith("----- end\n")).toBe(true);
  });

  it("prints the brief, or exits 1 for a missing slice", () => {
    const ok = spawnSync("node", [CLI, "2", "P"], { input: plan, encoding: "utf8" });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("Slice two's text.");
    const missing = spawnSync("node", [CLI, "9", "P"], { input: plan, encoding: "utf8" });
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    expect(spawnSync("node", [CLI, "x"], { input: "", encoding: "utf8" }).status).toBe(2);
  });

  it("squeezes only table rows", () => {
    expect(squeezeTables("a  b\n|  a   |  ------ |")).toBe("a  b\n| a | --- |");
  });
});
