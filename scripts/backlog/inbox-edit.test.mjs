import { describe, expect, it } from "vitest";
import { addEntry, findEntries, headingFor, moveEntry, removeEntry, rewordEntry } from "./inbox-edit.mjs";
import { parseInbox } from "./format.mjs";

const INBOX = [
  "# Inbox",
  "",
  "Add anything here.",
  "",
  "## Bugs/Nits",
  "",
  "- Sign-in link works twice (B-1)",
  "- Timeline jumps on scroll",
  "  on the phone",
  "",
  "## Change requests",
  "",
  "## Feature requests",
  "",
  "- Dark mode for the calendar",
  "  and the timeline",
  "- Dark mode for the settings",
  "",
  "## Questions",
  "",
].join("\n");

describe("addEntry", () => {
  it("puts the bullet at the end of its section, after the last bullet's details", () => {
    const out = addEntry(INBOX, "bug", "Doses  list   empty", "seen twice\nby a viewer");
    expect(out).toContain(
      "- Timeline jumps on scroll\n  on the phone\n- Doses list empty\n  seen twice\n  by a viewer\n\n## Change requests",
    );
    expect(parseInbox(out).find((e) => e.text === "Doses list empty")?.type).toBe("bug");
  });

  it("fills an empty section with one blank line on each side", () => {
    const out = addEntry(INBOX, "change", "Bigger buttons");
    expect(out).toContain("## Change requests\n\n- Bigger buttons\n\n## Feature requests");
  });

  it("fills an empty last section and keeps the final newline", () => {
    const out = addEntry(INBOX, "question", "Why is it slow?");
    expect(out.endsWith("## Questions\n\n- Why is it slow?\n")).toBe(true);
  });

  it("adds a section for a type with none", () => {
    const out = addEntry(INBOX, "chore", "Tidy the scripts");
    expect(out.endsWith("## Questions\n\n## Chores\n\n- Tidy the scripts\n")).toBe(true);
    expect(headingFor(out, "chore")).toBe("Chores");
    expect(headingFor(INBOX, "bug")).toBe("Bugs/Nits");
  });

  it("refuses an empty line, an id and an unknown type", () => {
    expect(() => addEntry(INBOX, "bug", "  ")).toThrow(/what should the line say/);
    expect(() => addEntry(INBOX, "bug", "Filed already (B-9)")).toThrow(/no id/);
    expect(() => addEntry(INBOX, "wish", "x")).toThrow(/type must be one of/);
  });
});

describe("findEntries", () => {
  it("finds bullets holding the words, case and spacing folded, tag left out", () => {
    expect(findEntries(INBOX, "TIMELINE  jumps").map((e) => e.text)).toEqual(["Timeline jumps on scroll"]);
    expect(findEntries(INBOX, "link works twice")[0].id).toBe("B-1");
    expect(findEntries(INBOX, "dark mode")).toHaveLength(2);
    expect(findEntries(INBOX, "nothing like it")).toEqual([]);
  });

  it("prefers the bullet whose whole text the words are", () => {
    const text = addEntry(INBOX, "feature", "Dark mode");
    expect(findEntries(text, "dark mode").map((e) => e.text)).toEqual(["Dark mode"]);
  });
});

describe("moveEntry", () => {
  it("moves a bullet with its details, and tidies the blank lines it leaves", () => {
    const [e] = findEntries(INBOX, "for the calendar");
    const out = moveEntry(INBOX, e.line, "bug");
    expect(out).toContain(
      "- Timeline jumps on scroll\n  on the phone\n- Dark mode for the calendar\n  and the timeline\n\n## Change requests",
    );
    expect(out).toContain("## Feature requests\n\n- Dark mode for the settings\n\n## Questions");
    const entries = parseInbox(out);
    expect(entries).toHaveLength(parseInbox(INBOX).length);
    expect(entries.find((x) => x.text === "Dark mode for the calendar")?.details).toBe("and the timeline");
  });

  it("leaves an emptied section with one blank line", () => {
    const [e] = findEntries(INBOX, "timeline jumps");
    const out = moveEntry(INBOX, e.line, "question");
    expect(out).toContain("- Sign-in link works twice (B-1)\n\n## Change requests");
    expect(out.endsWith("## Questions\n\n- Timeline jumps on scroll\n  on the phone\n")).toBe(true);
  });
});

describe("rewordEntry", () => {
  it("rewords the bullet in place, keeping its details unless new ones are given", () => {
    const [e] = findEntries(INBOX, "for the calendar");
    let out = rewordEntry(INBOX, e.line, "Dark  mode for   the agenda");
    expect(out).toContain(
      "## Feature requests\n\n- Dark mode for the agenda\n  and the timeline\n- Dark mode for the settings",
    );
    out = rewordEntry(INBOX, e.line, e.text, "only at night\n\nand on the phone");
    expect(out).toContain(
      "- Dark mode for the calendar\n  only at night\n  and on the phone\n- Dark mode for the settings",
    );
    out = rewordEntry(INBOX, e.line, e.text, "");
    expect(out).toContain("- Dark mode for the calendar\n- Dark mode for the settings");
    expect(parseInbox(out)).toHaveLength(parseInbox(INBOX).length);
  });

  it("refuses an empty line and an id", () => {
    const [e] = findEntries(INBOX, "timeline jumps");
    expect(() => rewordEntry(INBOX, e.line, "  ")).toThrow(/what should the line say/);
    expect(() => rewordEntry(INBOX, e.line, "Jumps (B-3)")).toThrow(/leave out the \(B-n\)/);
  });
});

describe("removeEntry", () => {
  it("removes a bullet with its details, and tidies the blank lines it leaves", () => {
    const [e] = findEntries(INBOX, "for the calendar");
    const out = removeEntry(INBOX, e.line);
    expect(out).toContain("## Feature requests\n\n- Dark mode for the settings\n\n## Questions");
    expect(out).not.toContain("and the timeline");
    expect(parseInbox(out)).toHaveLength(parseInbox(INBOX).length - 1);
  });

  it("leaves an emptied section with one blank line, and the file's end tidy", () => {
    const [e] = findEntries(INBOX, "timeline jumps");
    expect(removeEntry(INBOX, e.line)).toContain("- Sign-in link works twice (B-1)\n\n## Change requests");
    const last = `${INBOX}- Last one\n  its detail\n`;
    const [l] = findEntries(last, "last one");
    expect(removeEntry(last, l.line).endsWith("## Questions\n")).toBe(true);
  });
});
