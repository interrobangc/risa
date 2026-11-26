// A three-way merge of the inbox (plans/inbox.md here), entry by entry. Pure and total: it never
// fails and never writes conflict markers. `prd dev-sync` (scripts/loops/
// lib.sh) runs it as a command:
//
//   node scripts/backlog/inbox-merge.mjs <base-file> <ours-file> <theirs-file>
//
// which prints the merged text on stdout and its notes on stderr.
//
// An entry is a bullet with its indented detail lines, known by its text without
// the tag (whitespace folded). The rules:
//   - added on either side: kept, once when both added it;
//   - removed on one side and untouched on the other: removed (changed on the
//     other: kept, so nothing the other side wrote is lost);
//   - a tag added on either side stays; two different tags are two filed items,
//     so each keeps a bullet;
//   - reworded on one side: that wording; on both: both are kept;
//   - moved to another heading on one side: it moves;
//   - new entries from `theirs` go to the end of their section;
//   - text outside the lists comes from `ours`.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { IDS, parseInbox } from "./format.mjs";

const TAG = new RegExp(`\\s\\(${IDS.lookupPattern}\\)\\s*$`);
/** A reworded bullet shares at least this share of its words, and two of them. */
const REWORD_OVERLAP = 0.5;

/**
 * @typedef {object} Entry
 * @property {number} line where its bullet starts
 * @property {number} end the line after its last detail
 * @property {string} key its text without the tag, whitespace folded
 * @property {string | null} tag
 * @property {string} bullet its first line, without the tag
 * @property {string[]} details its detail lines, as written
 * @property {string} heading the "## " line it sits under
 */

const fold = (/** @type {string} */ s) => s.replace(/\s+/g, " ").trim();

/** @param {string} text */
function parse(text) {
  const lines = text.split("\n");
  /** @type {string[]} */
  const headingAt = [];
  let heading = "";
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^## /.test(line)) heading = line.trim();
    headingAt[i] = heading;
  });
  const entries = parseInbox(text).map((e) => {
    let last = e.line;
    for (let i = e.line + 1; i < lines.length; i++) {
      if (/^\s+\S/.test(lines[i])) last = i;
      else if (lines[i].trim() !== "") break;
    }
    return /** @type {Entry} */ ({
      line: e.line,
      end: last + 1,
      key: fold(e.text),
      tag: e.id,
      bullet: lines[e.line].replace(TAG, "").trimEnd(),
      details: lines.slice(e.line + 1, last + 1),
      heading: headingAt[e.line],
    });
  });
  return { lines, entries };
}

const words = (/** @type {string} */ key) => new Set(key.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** The share of words two texts have in common, or 0 under two shared words. */
function overlap(/** @type {string} */ a, /** @type {string} */ b) {
  const x = words(a);
  const y = words(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared < 2 ? 0 : shared / (x.size + y.size - shared);
}

const tagsAgree = (/** @type {Entry} */ a, /** @type {Entry} */ b) => !a.tag || !b.tag || a.tag === b.tag;

/**
 * Which entry of `side` each base entry became: the same text and tag, then the
 * same tag (reworded), then the same text (tagged), then the closest wording.
 * @param {Entry[]} base @param {Entry[]} side @returns {Map<Entry, Entry>}
 */
function follow(base, side) {
  /** @type {Map<Entry, Entry>} */
  const found = new Map();
  const free = new Set(side);
  /** @param {(b: Entry, e: Entry) => boolean} same */
  const pass = (same) => {
    for (const b of base) {
      if (found.has(b)) continue;
      const e = [...free].find((x) => same(b, x));
      if (!e) continue;
      found.set(b, e);
      free.delete(e);
    }
  };
  pass((b, e) => b.key === e.key && b.tag === e.tag);
  pass((b, e) => b.tag !== null && b.tag === e.tag);
  pass((b, e) => b.key === e.key && tagsAgree(b, e));
  const close = base
    .filter((b) => !found.has(b))
    .flatMap((b) =>
      [...free].filter((e) => tagsAgree(b, e)).map((e) => ({ b, e, score: overlap(b.key, e.key) })),
    )
    .filter((c) => c.score >= REWORD_OVERLAP)
    .sort((x, y) => y.score - x.score);
  for (const { b, e } of close) {
    if (found.has(b) || !free.has(e)) continue;
    found.set(b, e);
    free.delete(e);
  }
  return found;
}

/**
 * One entry of the result.
 * @typedef {object} Merged
 * @property {string} key
 * @property {string | null} tag
 * @property {string} bullet
 * @property {string[]} details
 * @property {string} heading
 * @property {Entry | null} place the entry of `ours` whose position it keeps
 */

const sameDetails = (/** @type {string[]} */ a, /** @type {string[]} */ b) =>
  a.length === b.length && a.every((l, i) => l.trim() === b[i].trim());
const untouched = (/** @type {Entry} */ e, /** @type {Entry} */ b) =>
  e.key === b.key && e.tag === b.tag && e.heading === b.heading && sameDetails(e.details, b.details);

/** @param {Entry} e @param {boolean} isOurs @returns {Merged} */
const carried = (e, isOurs) => ({
  key: e.key,
  tag: e.tag,
  bullet: e.bullet,
  details: e.details,
  heading: e.heading,
  place: isOurs ? e : null,
});

/** The details of both sides: one side's change, or ours then theirs' new lines. */
function mergeDetails(/** @type {Entry} */ b, /** @type {Entry} */ o, /** @type {Entry} */ t) {
  if (sameDetails(o.details, b.details)) return t.details;
  if (sameDetails(t.details, b.details)) return o.details;
  const have = new Set(o.details.map((l) => l.trim()));
  return [...o.details, ...t.details.filter((l) => !have.has(l.trim()))];
}

/**
 * An entry both sides still have.
 * @param {Entry} b @param {Entry} o @param {Entry} t @param {string[]} notes @returns {Merged[]}
 */
function mergeEntry(b, o, t, notes) {
  const heading = o.heading !== b.heading ? o.heading : t.heading;
  const details = mergeDetails(b, o, t);
  const tag = o.tag ?? t.tag;
  const place = heading === o.heading ? o : null;
  const reworded = o.key !== t.key && o.key !== b.key && t.key !== b.key;
  const worded = o.key === b.key ? t : o;
  /** @type {Merged[]} */
  const out = [{ key: worded.key, tag, bullet: worded.bullet, details, heading, place }];
  if (reworded) {
    notes.push(`reworded on both sides, both kept: "${o.key}" and "${t.key}"`);
    out.push({ key: t.key, tag: null, bullet: t.bullet, details: t.details, heading, place: null });
  }
  if (o.tag && t.tag && o.tag !== t.tag) {
    notes.push(`"${o.key}" was filed twice, as ${o.tag} and ${t.tag}: both kept`);
    out.push({ key: t.key, tag: t.tag, bullet: t.bullet, details: t.details, heading, place: null });
  }
  return out;
}

/** Each entry once: the same text and tag, or the same text with one untagged. @param {Merged[]} all */
function once(all) {
  /** @type {Merged[]} */
  const out = [];
  for (const m of all) {
    const kept = out.find((k) => k.key === m.key && (!k.tag || !m.tag || k.tag === m.tag));
    if (!kept) {
      out.push(m);
      continue;
    }
    kept.tag ??= m.tag;
    kept.place ??= m.place;
    if (!kept.details.length) kept.details = m.details;
  }
  return out;
}

const render = (/** @type {Merged} */ m) => [`${m.bullet}${m.tag ? ` (${m.tag})` : ""}`, ...m.details];

/**
 * `ours`, with its entries replaced by the merged ones and the rest of theirs at
 * the end of each section.
 * @param {ReturnType<typeof parse>} doc @param {Merged[]} merged @returns {string}
 */
function layOut(doc, merged) {
  /** @type {Map<Entry, Merged>} */
  const at = new Map();
  /** @type {Map<string, Merged[]>} */
  const added = new Map();
  for (const m of merged) {
    if (m.place && m.place.heading === m.heading) at.set(m.place, m);
    else added.set(m.heading, [...(added.get(m.heading) ?? []), m]);
  }
  const startOf = new Map(doc.entries.map((e) => [e.line, e]));
  /** The document in parts, each headed by a "## " line of ours (the first by none). */
  /** @type {{ heading: string, items: ({ line: string } | { entry: Entry })[] }[]} */
  const parts = [{ heading: "", items: [] }];
  let fence = false;
  for (let i = 0; i < doc.lines.length; i++) {
    const line = doc.lines[i];
    const entry = startOf.get(i);
    if (entry) {
      parts.at(-1)?.items.push({ entry });
      i = entry.end - 1;
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^## /.test(line)) parts.push({ heading: line.trim(), items: [{ line }] });
    else parts.at(-1)?.items.push({ line });
  }

  /** @type {string[]} */
  const out = [];
  for (const { heading, items } of parts) {
    const extra = (heading && added.get(heading)) || [];
    if (heading) added.delete(heading);
    const lastEntry = items.findLastIndex((x) => "entry" in x);
    // A removal's blank line goes with it (two become one, as Prettier would);
    // every other line of ours stays as written.
    let removed = false;
    const push = (/** @type {{ line: string } | { entry: Entry }} */ x) => {
      if ("line" in x) {
        if (!(removed && x.line.trim() === "" && out.at(-1)?.trim() === "")) out.push(x.line);
        removed = false;
        return;
      }
      const m = at.get(x.entry);
      if (m) out.push(...render(m));
      removed = !m;
    };
    if (!extra.length) items.forEach(push);
    else if (lastEntry >= 0) {
      items.slice(0, lastEntry + 1).forEach(push);
      extra.forEach((m) => out.push(...render(m)));
      items.slice(lastEntry + 1).forEach(push);
    } else {
      // An empty section: the heading, a blank line, its entries, then the rest.
      const [head, ...rest] = items;
      let blanks = 0;
      while (blanks < rest.length && "line" in rest[blanks] && rest[blanks].line.trim() === "") blanks++;
      push(head);
      out.push("");
      extra.forEach((m) => out.push(...render(m)));
      out.push("");
      rest.slice(blanks).forEach(push);
    }
  }
  // A heading only the other side has goes at the end, in its order.
  for (const [heading, extra] of added) {
    while (out.length && out.at(-1) === "") out.pop();
    out.push("", heading, "");
    extra.forEach((m) => out.push(...render(m)));
    out.push("");
  }
  return out.join("\n");
}

/**
 * Merge three copies of the inbox. Never fails, never writes conflict markers.
 * @param {string} base the common ancestor @param {string} ours @param {string} theirs
 * @returns {{ text: string, notes: string[] }}
 */
export function mergeInbox(base, ours, theirs) {
  const [b, o, t] = [base, ours, theirs].map((s) => s.replace(/\r\n/g, "\n"));
  if (o === t || t === b) return { text: o, notes: [] };
  if (o === b) return { text: t, notes: [] };
  const [bd, od, td] = [b, o, t].map(parse);
  const inOurs = follow(bd.entries, od.entries);
  const inTheirs = follow(bd.entries, td.entries);
  /** @type {string[]} */
  const notes = [];
  /** @type {Merged[]} */
  const merged = [];
  for (const e of bd.entries) {
    const mine = inOurs.get(e);
    const other = inTheirs.get(e);
    if (mine && other) merged.push(...mergeEntry(e, mine, other, notes));
    else if (mine && !untouched(mine, e)) merged.push(carried(mine, true));
    else if (other && !untouched(other, e)) merged.push(carried(other, false));
  }
  const seenOurs = new Set(inOurs.values());
  const seenTheirs = new Set(inTheirs.values());
  merged.push(...od.entries.filter((e) => !seenOurs.has(e)).map((e) => carried(e, true)));
  merged.push(...td.entries.filter((e) => !seenTheirs.has(e)).map((e) => carried(e, false)));
  return { text: layOut(od, once(merged)), notes };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [basePath, oursPath, theirsPath] = process.argv.slice(2);
  if (!theirsPath) {
    console.error("usage: inbox-merge.mjs <base-file> <ours-file> <theirs-file>");
    process.exit(2);
  }
  const { text, notes } = mergeInbox(
    readFileSync(basePath, "utf8"),
    readFileSync(oursPath, "utf8"),
    readFileSync(theirsPath, "utf8"),
  );
  for (const n of notes) console.error(`inbox merge: ${n}`);
  process.stdout.write(text);
}
