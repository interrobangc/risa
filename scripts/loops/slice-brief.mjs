#!/usr/bin/env node
// What a slice agent reads of its plan and PRD, embedded in its prompt
// (prompts/slice.sh) so it never reads the whole files (B-595):
//
//   - the intro of the wave the slice sits under (a "Wave N" heading above it);
//   - the plan's _Architectural decisions_, which every slice follows;
//   - the slice's own section, from its heading to the next of its level;
//   - from the PRD, what the section cites: a heading or a bold-led bullet it
//     (or the architecture) names in italics (_The skeptic store_), the
//     _Decisions_ rows whose bold lead it names or whose Source names one of
//     its backlog items, and the user stories it names (US 1, 2 to 4).
//     Uncited PRD text stays out; the agent opens the PRD only for a question.
//
// A plan with no PRD (a fixes topic) gets only the plan's parts.
//
//   node slice-brief.mjs <n> <topic> [--prd <file>]   (the plan on stdin)
//     prints the blocks, or nothing (exit 1) when the plan has no such slice
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { backlogIds } from "./config.mjs";

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const SLICE = /^Slice\s+(\d+)\b/i;

/** A name as cited and as headed: no backticks, case, trailing colon or stop. */
const norm = (s) =>
  s
    .replaceAll("`", "")
    .replace(/[\s:.]+$/, "")
    .trim()
    .toLowerCase();

/** The headings of a Markdown text, skipping fenced code: [{ at, level, text }]. */
export function headings(lines) {
  const out = [];
  let fenced = false;
  lines.forEach((line, at) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const m = !fenced && HEADING.exec(line);
    if (m) out.push({ at, level: m[1].length, text: m[2] });
  });
  return out;
}

/** The lines from heading h up to the next heading of its level or above. */
function sectionEnd(lines, hs, h) {
  const next = hs.find((o) => o.at > h.at && o.level <= h.level);
  return next ? next.at : lines.length;
}

const block = (lines, from, to) =>
  lines
    .slice(from, to)
    .join("\n")
    .replace(/^\s*\n/, "")
    .trimEnd();

/** Table rows without their alignment padding: a padded PRD table is mostly spaces. */
export const squeezeTables = (text) =>
  text
    .split("\n")
    .map((l) => (/^\s*\|/.test(l) ? l.replace(/ {2,}/g, " ").replace(/-{4,}/g, "---") : l))
    .join("\n");

/**
 * Slice n's section of a plan and what surrounds it.
 * → null, or { heading, text, wave: { name, intro } | null, architecture: text | null }
 */
export function sliceSection(planText, n) {
  const lines = planText.split(/\r?\n/);
  const hs = headings(lines);
  const h = hs.find((o) => o.level >= 2 && Number(SLICE.exec(o.text)?.[1]) === Number(n));
  if (!h) return null;
  const text = block(lines, h.at, sectionEnd(lines, hs, h));
  const parent = hs.filter((o) => o.at < h.at && o.level < h.level).at(-1);
  let wave = null;
  if (parent && /^Wave\b/i.test(parent.text)) {
    const firstSub = hs.find((o) => o.at > parent.at);
    const intro = block(lines, parent.at + 1, firstSub ? firstSub.at : lines.length);
    if (intro) wave = { name: parent.text, intro };
  }
  const arch = hs.find((o) => o.level === 2 && norm(o.text) === "architectural decisions");
  const architecture = arch ? block(lines, arch.at + 1, sectionEnd(lines, hs, arch)) || null : null;
  return { heading: h.text, text, wave, architecture };
}

/**
 * What a slice's section cites: italic names, user-story numbers and backlog ids.
 * @param {string} sectionText
 * @param {{ pattern: string }} [ids] the backlog's ids (default: this repo's config)
 */
export function citations(sectionText, ids = backlogIds()) {
  const names = new Set();
  for (const m of sectionText.matchAll(/(?<![\w`*])_([^_\n]+?)_(?![\w])/g)) names.add(norm(m[1]));
  const stories = new Set();
  for (const m of sectionText.matchAll(/\bUS\s+(\d+(?:\s*(?:,|and|to|–|-)\s*\d+)*)/g)) {
    const parts = m[1].split(/\s*(,|and|to|–|-)\s*/);
    for (let i = 0; i < parts.length; i += 2) {
      const a = Number(parts[i]);
      const sep = parts[i - 1];
      if (sep && sep !== "," && sep !== "and") {
        for (let k = Number(parts[i - 2]) + 1; k <= a; k++) stories.add(k);
      } else stories.add(a);
    }
  }
  const items = new Set(sectionText.match(new RegExp(`\\b${ids.pattern}\\b`, "g")) ?? []);
  return { names, stories: [...stories].sort((a, b) => a - b), items };
}

/**
 * The PRD's parts a section cites, in the PRD's order, none inside another.
 * → [{ label, text }]
 */
export function citedParts(prdText, cites) {
  const lines = prdText.split(/\r?\n/);
  const hs = headings(lines);
  const picked = [];
  const inside = (at) => picked.some((p) => p.range && at >= p.range[0] && at < p.range[1]);

  // Headings it names, whole.
  for (const h of hs) {
    if (h.level < 2 || !cites.names.has(norm(h.text)) || inside(h.at)) continue;
    const end = sectionEnd(lines, hs, h);
    picked.push({ at: h.at, range: [h.at, end], label: `_${h.text}_`, text: block(lines, h.at, end) });
  }

  // The Decisions table's rows it names or its items source, with the header.
  const dec = hs.find((o) => o.level === 2 && norm(o.text) === "decisions");
  if (dec && !inside(dec.at)) {
    const end = sectionEnd(lines, hs, dec);
    const table = [];
    for (let i = dec.at + 1; i < end; i++) if (/^\s*\|/.test(lines[i])) table.push(i);
    const rows = table.slice(2).filter((i) => {
      const lead = /^\s*\|\s*\*\*(.+?)\*\*/.exec(lines[i]);
      if (lead && cites.names.has(norm(lead[1]))) return true;
      const source = lines[i].split("|")[3] ?? "";
      return [...cites.items].some((id) => new RegExp(`\\b${id}\\b`).test(source));
    });
    if (rows.length) {
      const text = [table[0], table[1], ...rows].map((i) => lines[i]).join("\n");
      picked.push({ at: rows[0], label: "_Decisions_ rows", text });
      for (const i of rows) picked.push({ range: [i, i + 1] });
    }
  }

  // Bold-led bullets or paragraphs it names: "- **The brief:** …", "**Asking** …".
  lines.forEach((line, at) => {
    const m = /^(\s*)(?:[-*]\s+)?\*\*(.+?)\*\*/.exec(line);
    if (!m || /^\s*\|/.test(line) || !cites.names.has(norm(m[2])) || inside(at)) return;
    let end = at + 1;
    // Its continuation: the non-blank lines indented deeper than it.
    while (end < lines.length && lines[end].trim() && /^\s*/.exec(lines[end])[0].length > m[1].length) end++;
    picked.push({
      at,
      range: [at, end],
      label: `_${m[2].replace(/[:.]$/, "")}_`,
      text: block(lines, at, end),
    });
  });

  // The user stories it names.
  const us = hs.find((o) => o.level === 2 && norm(o.text) === "user stories");
  if (us && cites.stories.length && !inside(us.at)) {
    const end = sectionEnd(lines, hs, us);
    const rows = [];
    for (let i = us.at + 1; i < end; i++) {
      const m = /^(\d+)\.\s/.exec(lines[i]);
      if (m && cites.stories.includes(Number(m[1]))) rows.push(lines[i]);
    }
    if (rows.length)
      picked.push({ at: us.at, label: `user stories ${cites.stories.join(", ")}`, text: rows.join("\n") });
  }

  return picked
    .filter((p) => p.label)
    .sort((a, b) => a.at - b.at)
    .map(({ label, text }) => ({ label, text: squeezeTables(text) }));
}

/** The blocks slice.sh embeds, or null when the plan has no such slice. */
export function sliceBrief({ planText, prdText, n, topic }) {
  const s = sliceSection(planText, n);
  if (!s) return null;
  const plan = `plans/${topic}-plan.md`;
  const out = [];
  const add = (label, text) => out.push(`----- ${label}\n${text}`);
  if (s.wave) add(`${plan}: ${s.wave.name}, its intro`, s.wave.intro);
  if (s.architecture) add(`${plan}: _Architectural decisions_`, s.architecture);
  add(`${plan}: slice ${n}'s section`, s.text);
  if (prdText) {
    // The section's citations, plus the names the architecture cites for every slice.
    const cites = citations(s.text);
    for (const name of citations(s.architecture ?? "").names) cites.names.add(name);
    for (const p of citedParts(prdText, cites)) add(`plans/${topic}-prd.md: ${p.label}`, p.text);
  }
  out.push("----- end");
  return `${out.join("\n\n")}\n`;
}

function main(argv) {
  const args = [...argv];
  let prd = null;
  const pi = args.indexOf("--prd");
  if (pi >= 0) {
    prd = args[pi + 1];
    args.splice(pi, 2);
  }
  const [n, topic] = args;
  if (!n || !/^\d+$/.test(n) || !topic) {
    process.stderr.write("usage: slice-brief.mjs <n> <topic> [--prd <file>]  (the plan on stdin)\n");
    return 2;
  }
  const planText = readFileSync(0, "utf8");
  let prdText = "";
  if (prd) {
    try {
      prdText = readFileSync(prd, "utf8");
    } catch {
      prdText = "";
    }
  }
  const brief = sliceBrief({ planText, prdText, n, topic });
  if (!brief) return 1;
  process.stdout.write(brief);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exitCode = main(process.argv.slice(2));
