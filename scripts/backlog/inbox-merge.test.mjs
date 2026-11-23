import { describe, expect, it } from "vitest";

import { parseInbox } from "./format.mjs";
import { mergeInbox } from "./inbox-merge.mjs";

const doc = (bugs = [], features = []) =>
  [
    "# Inbox",
    "",
    "Intro.",
    "",
    "## Bugs",
    "",
    ...(bugs.length ? [...bugs, ""] : []),
    "## Feature requests",
    "",
    ...(features.length ? [...features, ""] : []),
  ].join("\n");

/** The merge, checked for what must hold of every result. */
function merged(base, ours, theirs) {
  const { text, notes } = mergeInbox(base, ours, theirs);
  expect(text).not.toMatch(/^(<{7}|={7}|>{7})/m);
  const keys = parseInbox(text).map((e) => `${e.text}|${e.id}`);
  expect(new Set(keys).size).toBe(keys.length);
  return { text, notes, entries: parseInbox(text) };
}
const texts = (r) => r.entries.map((e) => e.text);

describe("mergeInbox", () => {
  const base = doc(["- Login fails on Safari", "- Timeline jumps on scroll"]);

  it("keeps an entry added on either side", () => {
    const r = merged(
      base,
      doc(["- Login fails on Safari", "- Timeline jumps on scroll", "- Mine"]),
      doc(["- Login fails on Safari", "- Timeline jumps on scroll", "- Theirs"]),
    );
    expect(texts(r)).toEqual(["Login fails on Safari", "Timeline jumps on scroll", "Mine", "Theirs"]);
  });

  it("keeps an entry both sides added once", () => {
    const both = doc(["- Login fails on Safari", "- Timeline jumps on scroll", "- Same idea"]);
    const other = doc(["- Same  idea", "- Login fails on Safari", "- Timeline jumps on scroll"]);
    expect(texts(merged(base, both, other)).filter((t) => t.startsWith("Same"))).toHaveLength(1);
  });

  it("removes an entry removed on one side and untouched on the other", () => {
    const r = merged(
      base,
      doc(["- Timeline jumps on scroll"]),
      doc(["- Login fails on Safari", "- Timeline jumps on scroll", "- New"]),
    );
    expect(texts(r)).toEqual(["Timeline jumps on scroll", "New"]);
  });

  it("keeps an entry removed on one side and changed on the other", () => {
    const r = merged(
      base,
      doc(["- Timeline jumps on scroll"]),
      doc(["- Login fails on Safari (B-4)", "- Timeline jumps on scroll"]),
    );
    expect(r.entries.find((e) => e.text === "Login fails on Safari")?.id).toBe("B-4");
  });

  it("keeps a tag from one side while the other adds a neighbour", () => {
    const r = merged(
      base,
      doc(["- Login fails on Safari (B-7)", "- Timeline jumps on scroll"]),
      doc(["- Login fails on Safari", "- A neighbour", "- Timeline jumps on scroll"]),
    );
    expect(r.entries.find((e) => e.text === "Login fails on Safari")?.id).toBe("B-7");
    expect(texts(r)).toContain("A neighbour");
  });

  it("keeps both bullets when one line was filed twice", () => {
    const r = merged(
      base,
      doc(["- Login fails on Safari (B-7)", "- Timeline jumps on scroll"]),
      doc(["- Login fails on Safari (B-8)", "- Timeline jumps on scroll"]),
    );
    expect(r.entries.filter((e) => e.text === "Login fails on Safari").map((e) => e.id)).toEqual([
      "B-7",
      "B-8",
    ]);
    expect(r.notes.join()).toContain("filed twice");
  });

  it("takes a rewording from one side", () => {
    const r = merged(
      base,
      doc(["- Login fails on Safari", "- Timeline jumps when I scroll"]),
      doc(["- Login fails on Safari", "- Timeline jumps on scroll", "- Other"]),
    );
    expect(texts(r)).toEqual(["Login fails on Safari", "Timeline jumps when I scroll", "Other"]);
  });

  it("follows a filed entry's rewording by its tag", () => {
    const tagged = doc(["- Old words here (B-3)"]);
    const r = merged(tagged, doc(["- Completely different (B-3)"]), doc(["- Old words here (B-3)", "- X"]));
    expect(texts(r)).toEqual(["Completely different", "X"]);
  });

  it("keeps both wordings when both sides reworded it", () => {
    const r = merged(
      base,
      doc(["- Login fails on Safari", "- Timeline jumps when I scroll"]),
      doc(["- Login fails on Safari", "- Timeline jumps during a scroll"]),
    );
    expect(texts(r)).toEqual([
      "Login fails on Safari",
      "Timeline jumps when I scroll",
      "Timeline jumps during a scroll",
    ]);
    expect(r.notes.join()).toContain("both kept");
  });

  it("moves an entry to the heading one side moved it to", () => {
    const r = merged(
      base,
      doc(["- Timeline jumps on scroll"], ["- Login fails on Safari"]),
      doc(["- Login fails on Safari (B-9)", "- Timeline jumps on scroll"]),
    );
    const moved = r.entries.find((e) => e.text === "Login fails on Safari");
    expect(moved).toMatchObject({ type: "feature", id: "B-9" });
    expect(r.text.match(/Login fails/g)).toHaveLength(1);
  });

  it("keeps details with their bullet, through a move and a tag", () => {
    const start = doc(["- With details", "  First detail.", "  Second detail.", "- Other"]);
    const r = merged(
      start,
      doc(["- Other"], ["- With details", "  First detail.", "  Second detail."]),
      doc(["- With details (B-2)", "  First detail.", "  Second detail.", "- Other"]),
    );
    expect(r.entries.find((e) => e.id === "B-2")).toMatchObject({
      type: "feature",
      details: "First detail.\nSecond detail.",
    });
  });

  it("puts theirs' new entries at the end of their section, in an empty one too", () => {
    const r = merged(
      base,
      doc(["- Login fails on Safari", "- Timeline jumps on scroll", "- Mine"]),
      doc(["- Login fails on Safari", "- Timeline jumps on scroll"], ["- A feature"]),
    );
    expect(r.text).toBe(
      doc(["- Login fails on Safari", "- Timeline jumps on scroll", "- Mine"], ["- A feature"]),
    );
  });

  it("adds a heading only theirs has", () => {
    const r = merged(base, doc(["- Login fails on Safari"]), `${base}## Chores\n\n- Tidy up\n`);
    expect(r.text).toContain("## Chores\n\n- Tidy up\n");
    expect(texts(r)).toContain("Tidy up");
  });

  it("takes the text outside the lists from ours", () => {
    const mine = doc(["- Login fails on Safari", "- Timeline jumps on scroll"]).replace(
      "Intro.",
      "My intro.",
    );
    const r = merged(base, mine, doc(["- Login fails on Safari"]).replace("Intro.", "Their intro."));
    expect(r.text).toContain("My intro.");
    expect(r.text).not.toContain("Their intro.");
  });

  it("leaves one blank line where a section's last entry went", () => {
    const r = merged(doc(["- Gone"], ["- Stay"]), doc(["- Gone"], ["- Stay", "- Mine"]), doc([], ["- Stay"]));
    expect(r.text).toBe(doc([], ["- Stay", "- Mine"]));
  });

  it("returns the changed side when only one side changed", () => {
    const changed = doc(["- Whatever (B-1)"]);
    expect(mergeInbox(base, base, changed).text).toBe(changed);
    expect(mergeInbox(base, changed, base).text).toBe(changed);
    expect(mergeInbox(base, changed, changed).text).toBe(changed);
  });
});
