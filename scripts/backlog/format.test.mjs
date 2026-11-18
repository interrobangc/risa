import { describe, expect, it } from "vitest";
import * as fmt from "./format.mjs";

const DOC = `# Backlog

Intro text.

## PRDs

| PRD | State |
| --- | ----- |

## Summary

stale table

## Items

### B-2 · feature · Infinite scroll
- status: triaged
- prd: timeline-polish

Some notes.

- 2026-11-17 (dev keeper): a note line

### B-1 · bug · Sign-in | twice
- status: inbox
- owner:
`;

describe("parse and render", () => {
  it("keeps the preamble, regenerates the summary, and sorts items by id", () => {
    const b = fmt.parse(DOC);
    expect(b.preamble).toContain("## PRDs");
    expect(b.preamble).not.toContain("stale table");
    expect(b.items.map((i) => i.id)).toEqual(["B-2", "B-1"]);
    expect(b.items[0]).toMatchObject({
      type: "feature",
      status: "triaged",
      prd: "timeline-polish",
      owner: "",
    });
    expect(b.items[0].notes).toBe("Some notes.\n\n- 2026-11-17 (dev keeper): a note line");

    const out = fmt.render(b);
    expect(out.indexOf("### B-1")).toBeLessThan(out.indexOf("### B-2"));
    expect(out).toContain("| B-1 | bug | inbox |  |  | Sign-in \\| twice |");
    expect(out).not.toContain("stale table");
  });

  it("round-trips: rendering a parsed render changes nothing", () => {
    const once = fmt.render(fmt.parse(DOC));
    expect(fmt.render(fmt.parse(once))).toBe(once);
  });

  it("refuses a file without an Items heading, or a duplicate id", () => {
    expect(() => fmt.parse("# Backlog\n")).toThrow(fmt.BacklogError);
    expect(() => fmt.parse("## Items\n### B-1 · bug · a\n### B-1 · bug · b\n")).toThrow(/twice/);
  });

  it("reads a note line that looks like a field as a note once the fields have ended", () => {
    const b = fmt.parse("## Items\n### B-1 · bug · a\n- status: inbox\n\ntext\n- owner: not a field\n");
    expect(b.items[0].owner).toBe("");
    expect(b.items[0].notes).toBe("text\n- owner: not a field");
  });
});

describe("changes", () => {
  const ctx = { by: "prd/x", date: "2026-11-17" };

  it("adds with the next id, triaged when it has a PRD", () => {
    const b = fmt.parse(DOC);
    const it = fmt.add(b, { type: "bug", title: "  New  ", prd: "quick-fixes", ...ctx });
    expect(it).toMatchObject({ id: "B-3", title: "New", status: "triaged" });
    expect(fmt.add(b, { type: "question", title: "Q", ...ctx }).status).toBe("inbox");
    expect(() => fmt.add(b, { type: "nope", title: "x", ...ctx })).toThrow(/type/);
  });

  it("lets the first claim win", () => {
    const b = fmt.parse(DOC);
    const it = fmt.find(b, "1");
    fmt.claim(it, "prd/a", false);
    expect(it).toMatchObject({ owner: "prd/a", status: "in-progress" });
    expect(() => fmt.claim(it, "prd/b", false)).toThrow(/already claimed by prd\/a/);
    fmt.claim(it, "prd/a", false); // the owner again is fine
    fmt.claim(it, "prd/b", true);
    expect(it.owner).toBe("prd/b");
    fmt.release(it);
    expect(it).toMatchObject({ owner: "", status: "triaged" });
  });

  it("validates set", () => {
    const it = fmt.find(fmt.parse(DOC), "B-1");
    fmt.setField(it, "status", "dropped");
    expect(it.status).toBe("dropped");
    expect(() => fmt.setField(it, "status", "done")).toThrow(/status/);
    expect(() => fmt.setField(it, "id", "B-9")).toThrow(/can't set/);
  });

  it("derives statuses from containment, leaving manual ones alone", () => {
    const it = { ...fmt.find(fmt.parse(DOC), "B-1"), commit: "abc", status: "ready" };
    expect(fmt.derive(it, { dev: false, staging: false, main: false })).toBe("ready");
    expect(fmt.derive(it, { dev: true, staging: false, main: false })).toBe("landed");
    expect(fmt.derive(it, { dev: true, staging: true, main: false })).toBe("staging");
    expect(fmt.derive(it, { dev: true, staging: true, main: true })).toBe("live");
    expect(fmt.derive({ ...it, status: "dropped" }, { dev: true, staging: true, main: true })).toBe(
      "dropped",
    );
    expect(fmt.derive({ ...it, commit: "" }, { dev: true, staging: true, main: true })).toBe("ready");
  });
});
