// Pure edits of plans/inbox.md for `pnpm backlog inbox add|move|edit|remove`: text in,
// text out. The origin writer (origin.mjs) applies them to origin/dev's copy.
//
// A bullet goes at the end of the first "## " section whose heading has its
// type (format.mjs's typeForHeading), after the last bullet's details; a type
// with no section gets one at the end of the file. A bullet is found by its
// words: the folded words are a part of its text (tag left out), and when
// several bullets hold them, the one whose whole text they are wins.
import { BacklogError, checkType, parseInbox, typeForHeading } from "./format.mjs";

/** The heading a new section gets, by type. */
const HEADING_FOR = {
  bug: "Bugs",
  change: "Changes",
  feature: "Features",
  plan: "Big plans",
  question: "Questions",
  chore: "Chores",
};
const TAG_AT_END = /\(B-\d+\)\s*$/;

const fold = (/** @type {string} */ s) => s.replace(/\s+/g, " ").trim();
const key = (/** @type {string} */ s) => fold(s).toLowerCase();

/**
 * Every "## " section: its heading line, the line after its last one, its type.
 * @param {string[]} lines
 */
function sections(lines) {
  /** @type {{ heading: number, end: number, type: string | null }[]} */
  const out = [];
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence || !/^#/.test(line)) return;
    if (out.length) out[out.length - 1].end = i;
    out.push({
      heading: i,
      end: lines.length,
      type: /^## /.test(line) ? typeForHeading(line.slice(3)) : null,
    });
  });
  return out;
}

/**
 * `block` (a bullet and its detail lines) at the end of `type`'s section.
 * @param {string} text @param {string} type @param {string[]} block
 */
function insert(text, type, block) {
  const lines = text.split("\n");
  let s = sections(lines).find((x) => x.type === type);
  if (!s) {
    while (lines.length && lines.at(-1) === "") lines.pop();
    lines.push("", `## ${HEADING_FOR[type]}`, "");
    s = { heading: lines.length - 2, end: lines.length, type };
  }
  let last = s.heading;
  for (let i = s.heading + 1; i < s.end; i++) if (lines[i].trim() !== "") last = i;
  if (last === s.heading) {
    // An empty section: its blank lines become one before the block and one after.
    lines.splice(s.heading + 1, s.end - s.heading - 1, "", ...block, "");
  } else {
    // A section's last line runs straight into the next heading: keep a blank between.
    const gap = last + 1 < lines.length && /^#/.test(lines[last + 1]) ? [""] : [];
    lines.splice(last + 1, 0, ...block, ...gap);
  }
  const out = lines.join("\n");
  return text.endsWith("\n") && !out.endsWith("\n") ? `${out}\n` : out;
}

/** Detail lines as the inbox writes them: folded, indented, blanks dropped. @param {string} details */
const detailLines = (details) =>
  details
    .split("\n")
    .map(fold)
    .filter(Boolean)
    .map((l) => `  ${l}`);

/**
 * A new bullet for `type`, with optional details (one line each).
 * @param {string} text @param {string} type @param {string} bullet @param {string} [details]
 */
export function addEntry(text, type, bullet, details = "") {
  checkType(type);
  const b = fold(bullet);
  if (!b) throw new BacklogError("what should the line say?");
  if (TAG_AT_END.test(b)) throw new BacklogError("a new line has no id: leave out the (B-n)");
  return insert(text, type, [`- ${b}`, ...detailLines(details)]);
}

/**
 * The bullets `words` find (see the header).
 * @param {string} text @param {string} words
 */
export function findEntries(text, words) {
  const want = key(words);
  if (!want) return [];
  const hits = parseInbox(text).filter((e) => key(e.text).includes(want));
  const exact = hits.filter((e) => key(e.text) === want);
  return exact.length === 1 ? exact : hits;
}

/** The lines [first, last] a bullet and its details take. @param {string[]} lines @param {number} line */
function span(lines, line) {
  let last = line;
  for (let i = line + 1; i < lines.length; i++) {
    if (/^\s+\S/.test(lines[i])) last = i;
    else if (lines[i].trim() !== "") break;
  }
  return last;
}

/**
 * `text` without the bullet at line `line` and its details, and the block it took.
 * @param {string} text @param {number} line
 */
function cut(text, line) {
  const lines = text.split("\n");
  const last = span(lines, line);
  const block = lines.slice(line, last + 1);
  const kept = lines.filter((_, i) => i < line || i > last);
  // Collapse the blank lines the removal leaves behind, as removeInboxEntries does.
  const tidy = kept.filter((l, i) => !(l.trim() === "" && i > 0 && kept[i - 1].trim() === ""));
  while (tidy.length > 1 && tidy.at(-1) === "" && tidy.at(-2) === "") tidy.pop();
  return { rest: tidy.join("\n"), block };
}

/**
 * The bullet at line `line` (with its details) moved to the end of `type`'s section.
 * @param {string} text @param {number} line @param {string} type
 */
export function moveEntry(text, line, type) {
  checkType(type);
  const { rest, block } = cut(text, line);
  return insert(rest, type, block);
}

/**
 * The bullet at line `line` reworded to `bullet`, in place; `details`, when
 * given, replace its detail lines ("" drops them), else they stay.
 * @param {string} text @param {number} line @param {string} bullet @param {string} [details]
 */
export function rewordEntry(text, line, bullet, details) {
  const b = fold(bullet);
  if (!b) throw new BacklogError("what should the line say?");
  if (TAG_AT_END.test(b)) throw new BacklogError("a line has no id: leave out the (B-n)");
  const lines = text.split("\n");
  const last = span(lines, line);
  const more = details === undefined ? lines.slice(line + 1, last + 1) : detailLines(details);
  lines.splice(line, last - line + 1, `- ${b}`, ...more);
  return lines.join("\n");
}

/**
 * The inbox without the bullet at line `line` and its details.
 * @param {string} text @param {number} line
 */
export function removeEntry(text, line) {
  return cut(text, line).rest;
}

/** The heading a type's bullets sit under in `text` (or would). @param {string} text @param {string} type */
export function headingFor(text, type) {
  const lines = text.split("\n");
  const s = sections(lines).find((x) => x.type === type);
  return s ? lines[s.heading].slice(3).trim() : HEADING_FOR[type];
}
