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

describe("inbox", () => {
  const INBOX = `# Inbox

Add a line under a heading.

- not under a heading, ignored

## Bugs

- Login link can be clicked twice (B-1)
- The timeline jumps when I scroll
  It happens on my phone.
  Only in cards view.

## Change requests
* Bigger day headers

## Big plans
- Medication tracking

## Random thoughts
- Dark mode?

### Deeper heading
- ignored too

\`\`\`
## Bugs
- inside a code fence
\`\`\`
`;

  it("finds bullets under ## headings, with their type, details and tag", () => {
    const entries = fmt.parseInbox(INBOX);
    expect(entries.map((e) => [e.type, e.text, e.id])).toEqual([
      ["bug", "Login link can be clicked twice", "B-1"],
      ["bug", "The timeline jumps when I scroll", null],
      ["change", "Bigger day headers", null],
      ["plan", "Medication tracking", null],
      ["feature", "Dark mode?", null],
    ]);
    expect(entries[1].details).toBe("It happens on my phone.\nOnly in cards view.");
    expect(fmt.newInboxEntries(INBOX)).toHaveLength(4);
  });

  it("maps headings to types", () => {
    expect(fmt.typeForHeading("BUGS:")).toBe("bug");
    expect(fmt.typeForHeading("Feature requests")).toBe("feature");
    expect(fmt.typeForHeading("Questions")).toBe("question");
    expect(fmt.typeForHeading("Something else")).toBe("feature");
  });

  it("tags a line in place, leaving every other line as it was", () => {
    const line = fmt.parseInbox(INBOX)[1].line;
    const out = fmt.tagInboxLine(INBOX, line, "B-7");
    expect(out.split("\n")[line]).toBe("- The timeline jumps when I scroll (B-7)");
    expect(out.replace(" (B-7)", "")).toBe(INBOX);
    expect(fmt.newInboxEntries(out)).toHaveLength(3);
  });

  it("shortens long bullets to a title", () => {
    const long = "word ".repeat(40).trim();
    const title = fmt.titleFromBullet(long);
    expect(title.length).toBeLessThanOrEqual(101);
    expect(title.endsWith("…")).toBe(true);
    expect(fmt.titleFromBullet("short  one")).toBe("short one");
  });
});

describe("archive and doctor helpers", () => {
  const item = (title, notes = "") => ({
    id: "B-1",
    type: "bug",
    title,
    status: "inbox",
    prd: "",
    owner: "",
    commit: "",
    notes,
  });
  const entry = (text, details = "") => ({ line: 0, type: "bug", text, details, id: "B-1" });

  it("removes tagged bullets with their details, and nothing else", () => {
    const text =
      "# Inbox\n\n## Bugs\n\n- One (B-1)\n  detail\n\n  more detail\n- Two (B-2)\n- Three\n  its detail\n\n## Other\n\n- Four (B-1x)\n";
    expect(fmt.removeInboxEntries(text, ["B-1", "B-3"])).toBe(
      "# Inbox\n\n## Bugs\n\n- Two (B-2)\n- Three\n  its detail\n\n## Other\n\n- Four (B-1x)\n",
    );
    expect(fmt.removeInboxEntries(text, [])).toBe(text);
  });

  it("leaves an emptied section and the end of the file formatted", () => {
    const text = "# Inbox\n\n## Bugs\n\n- One (B-1)\n  detail\n\n## Questions\n\n- Two (B-2)\n";
    expect(fmt.removeInboxEntries(text, ["B-1", "B-2"])).toBe("# Inbox\n\n## Bugs\n\n## Questions\n");
  });

  it("tells whether a title came from a bullet", () => {
    expect(fmt.titleFromEntry(entry("Dates overflow on phones"), item("Dates overflow on phones"))).toBe(
      true,
    );
    // Retitled by an agent, sharing words with the bullet.
    expect(
      fmt.titleFromEntry(
        entry("Login link allows clicking multiple times while already loading login flow... very slow."),
        item("Sign-in can be submitted again while it's loading, and the first load is slow"),
      ),
    ).toBe(true);
    // Quoted by ingest's note.
    expect(
      fmt.titleFromEntry(
        entry("Some long thing"),
        item("Other words", "- d (x): From the inbox: Some long thing"),
      ),
    ).toBe(true);
    // The B-106 case.
    expect(
      fmt.titleFromEntry(
        entry("Browser testing without a timeout keeps causing hung processes."),
        item("Turning email invites off also blocks staff owner invites from /admin"),
      ),
    ).toBe(false);
  });

  it("reads the summary rows as written, and the ones render would write", () => {
    const b = fmt.parse("# B\n\n## Items\n\n### B-2 · bug · Two\n\n- status: inbox\n");
    const text = fmt.render(b);
    expect(fmt.summaryRows(text)).toEqual(fmt.expectedSummaryRows(b));
    expect(fmt.summaryRows(text).map((r) => r.id)).toEqual(["B-2"]);
  });

  it("keeps duplicate ids only when lenient, and skips reserved ids", () => {
    const dup = "# B\n\n## Items\n\n### B-1 · bug · A\n\n### B-1 · bug · B\n";
    expect(() => fmt.parse(dup)).toThrow(/B-1 appears twice/);
    expect(fmt.duplicateIds(fmt.parse(dup, { lenient: true }).items)).toEqual(["B-1"]);
    expect(fmt.nextId({ preamble: "", items: [item("x")], reserved: ["B-7", "B-3"] })).toBe("B-8");
  });
});
