#!/usr/bin/env node
// pnpm prd status-trim: keep a plan's _Status_ short by moving finished-wave
// history into plans/<topic>-history.md (B-598). An orchestrator runs it after
// each landing, once the docs are folded, and commits both files.
//
//   node status-trim.mjs <topic> [--dry-run] [--base <ref>] [--repo <dir>] [--date YYYY-MM-DD]
//       Moves out of plans/<topic>-plan.md's _Status_:
//         - every hand-off paragraph (its bold lead says hand-off or hand-over)
//           but the latest (the newest date in its lead, then the highest wave
//           it names, then the last in the file);
//         - for a fixes-<cat> plan, the paragraphs led by "Wave <n>" of a
//           landed wave, and the slice table's rows of landed waves (a row
//           whose merge SHA is in dev, or with no SHA and not in flight).
//       A list right after a moved paragraph that ends in ":" moves with it.
//       A fixes plan's slice table keeps its header and separator even when
//       every row moves out, and a _Status_ that lost its table (a hand-written
//       idle hand-over, B-807) gets an empty one back, in the history's columns
//       or SLICE_COLUMNS.
//       The landing mode, other paragraphs, lists and open rows stay. The
//       history file gets a "## Trimmed <date>" section at its top (newest
//       first: paragraphs, then the rows in a table of the plan's columns),
//       and _Status_ a one-line pointer to it. Both files go through Prettier.
//       A rerun with nothing to move changes nothing.
//       A wave has landed when its rows with a merge SHA all are in --base
//       (default: dev or origin/dev) and it has one, or a later wave has.
//       Waves come from the plan's "## Wave <n>" headings over its "### Slice
//       <n>" ones (or a Wave column). --dry-run prints what would move.
//   node status-trim.mjs <topic> --next [--repo <dir>]
//       Prints the next slice number: one past the highest in the plan and
//       its history (headings and table rows), so a trim never reuses one.
//
// Pure parts (trimStatus, nextSlice, statusBytes) take text; the CLI reads and
// writes the files and asks git. `pnpm docs:budget` (doc-budget.mjs) warns
// when a running topic's _Status_ passes STATUS_WARN_BYTES.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Past this many bytes, a plan's _Status_ draws a warning. */
export const STATUS_WARN_BYTES = 6 * 1024;

const STATUS = /^## Status[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m;
const SLICE_HEADING = /^#{2,4}\s+Slice\s+(\d+)\b/i;
const WAVE_HEADING = /^##\s+Wave\s+(\d+)\b/i;
/** A fixes plan's slice table columns, when neither the plan nor its history has a table. */
export const SLICE_COLUMNS = ["Slice", "Item", "State", "Merge"];
/** A State still in flight: such a row stays even in a landed wave. */
const IN_FLIGHT = /^(not started|started|ready|blocked|waiting|in progress|running|held|queued)\b/i;

/** Where the _Status_ body sits in the text, or null. */
function statusAt(/** @type {string} */ text) {
  const m = STATUS.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length - m[1].length;
  return { start, end: start + m[1].length, body: m[1] };
}

/** The _Status_ section's size in bytes (0 when it has none). */
export function statusBytes(/** @type {string} */ text) {
  const at = statusAt(text);
  return at ? Buffer.byteLength(at.body) : 0;
}

/** Blank-line separated blocks; a fenced block stays whole. */
export function splitBlocks(/** @type {string} */ body) {
  const blocks = [];
  let cur = [];
  let fence = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && line.trim() === "") {
      if (cur.length) blocks.push(cur.join("\n"));
      cur = [];
    } else cur.push(line);
  }
  if (cur.length) blocks.push(cur.join("\n"));
  return blocks;
}

/** "| a | b |" → ["a", "b"]. */
const cells = (/** @type {string} */ line) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
const isTable = (/** @type {string} */ b) => b.split("\n").every((l) => l.trim().startsWith("|"));
const isList = (/** @type {string} */ b) => /^\s*([-*+]|\d+\.)\s/.test(b);
const isSliceTable = (/** @type {string} */ b) =>
  isTable(b) && /^slice$/i.test(cells(b.split("\n")[0])[0] ?? "");
/** A paragraph's bold lead ("**Hand-off (…).**" → "Hand-off (…)."), or "". */
const leadOf = (/** @type {string} */ b) => /^\*\*(.+?)\*\*/.exec(b)?.[1] ?? "";
const isHandOff = (/** @type {string} */ lead) => /\bhand-?(off|over)\b/i.test(lead);
const isLandingMode = (/** @type {string} */ lead) => /landing mode/i.test(lead);
const firstSha = (/** @type {string} */ cell) => /\b[0-9a-f]{4,40}\b/.exec(cell)?.[0] ?? null;

/** Every slice number the text names: slice headings and rows of slice tables. */
function sliceNumbers(/** @type {string} */ text) {
  const out = [];
  let inTable = false;
  for (const line of text.split("\n")) {
    const h = SLICE_HEADING.exec(line);
    if (h) out.push(Number(h[1]));
    if (!line.trim().startsWith("|")) {
      inTable = false;
      continue;
    }
    const c = cells(line);
    if (!inTable) inTable = /^slice$/i.test(c[0] ?? "");
    else if (/^\d+$/.test(c[0] ?? "")) out.push(Number(c[0]));
  }
  return out;
}

/** The next slice number: one past the highest in the plan and its history. */
export function nextSlice(/** @type {string} */ planText, historyText = "") {
  return Math.max(0, ...sliceNumbers(planText), ...sliceNumbers(historyText)) + 1;
}

/** slice → wave, from "## Wave <n>" headings over slice headings. */
function wavesOf(/** @type {string} */ planText) {
  const map = new Map();
  let wave = null;
  for (const line of planText.split("\n")) {
    const w = WAVE_HEADING.exec(line);
    if (w) wave = Number(w[1]);
    else if (/^##\s/.test(line) && !SLICE_HEADING.test(line)) wave = null;
    const s = SLICE_HEADING.exec(line);
    if (s && wave !== null) map.set(Number(s[1]), wave);
  }
  return map;
}

/**
 * The newest-first key of a hand-off: [date, highest wave named, position].
 * @param {string} lead @param {number} pos
 */
function rankOf(lead, pos) {
  const date = /\d{4}-\d{2}-\d{2}/.exec(lead)?.[0] ?? "";
  const waves = [...lead.matchAll(/\bwaves?\s+(\d+)/gi)].map((m) => Number(m[1]));
  return [date, waves.length ? Math.max(...waves) : -1, pos];
}
const newer = (/** @type {any[]} */ a, /** @type {any[]} */ b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

/**
 * Trim a plan's _Status_.
 * @param {string} planText
 * @param {{ topic: string, historyText?: string, isLanded?: (sha: string) => boolean, date?: string }} opts
 * @returns {{ plan: string, history: string, paragraphs: number, rows: number, landedWaves: number[], restored: boolean }}
 */
export function trimStatus(planText, { topic, historyText = "", isLanded = () => false, date = "" }) {
  const unchanged = {
    plan: planText,
    history: historyText,
    paragraphs: 0,
    rows: 0,
    landedWaves: /** @type {number[]} */ ([]),
    restored: false,
  };
  const at = statusAt(planText);
  if (!at) return unchanged;
  const fixes = topic.startsWith("fixes-");
  const blocks = splitBlocks(at.body);
  const moved = new Set();

  // Hand-offs: all but the latest.
  const handOffs = blocks
    .map((b, i) => ({ i, lead: leadOf(b) }))
    .filter((x) => x.lead && isHandOff(x.lead) && !isLandingMode(x.lead));
  let latest = null;
  for (const h of handOffs) {
    const r = rankOf(h.lead, h.i);
    if (!latest || newer(r, latest.r)) latest = { i: h.i, r };
  }
  for (const h of handOffs) if (h.i !== latest?.i) moved.add(h.i);

  // A fixes plan: landed waves' paragraphs and table rows.
  let tableIdx = fixes ? blocks.findIndex(isSliceTable) : -1;
  // A fixes plan's _Status_ always has its table: put back an empty one a hand edit dropped.
  const restored = fixes && tableIdx < 0;
  if (restored) {
    const old = splitBlocks(historyText).find(isSliceTable)?.split("\n").slice(0, 2);
    const cols = old ?? [
      `| ${SLICE_COLUMNS.join(" | ")} |`,
      `| ${SLICE_COLUMNS.map((c) => "-".repeat(c.length)).join(" | ")} |`,
    ];
    tableIdx = blocks.push(cols.join("\n")) - 1;
  }
  /** @type {string[]} */ let movedRows = [];
  let header = /** @type {string[]} */ ([]);
  /** @type {number[]} */ let landedWaves = [];
  if (tableIdx >= 0) {
    const lines = blocks[tableIdx].split("\n");
    header = lines.slice(0, 2);
    const head = cells(lines[0]);
    const stateCol = head.findIndex((c) => /^state$/i.test(c));
    const mergeCol = head.findIndex((c) => /^merge/i.test(c));
    const waveCol = head.findIndex((c) => /^wave$/i.test(c));
    const waveOf = wavesOf(planText);
    const rows = lines.slice(2).map((line) => {
      const c = cells(line);
      const slice = /^\d+$/.test(c[0] ?? "") ? Number(c[0]) : null;
      const wave = waveCol >= 0 && /^\d+$/.test(c[waveCol] ?? "") ? Number(c[waveCol]) : waveOf.get(slice);
      const sha = mergeCol >= 0 ? firstSha(c[mergeCol] ?? "") : null;
      const state = stateCol >= 0 ? (c[stateCol] ?? "").replace(/[*_`]/g, "").trim() : "";
      return { line, slice, wave: wave ?? null, sha, state, landed: sha ? isLanded(sha) : false };
    });
    const waves = [...new Set(rows.map((r) => r.wave).filter((w) => w !== null))].sort((a, b) => b - a);
    let later = false;
    const landed = new Set();
    for (const w of waves) {
      const withSha = rows.filter((r) => r.wave === w && r.sha);
      const own = withSha.length > 0 && withSha.every((r) => r.landed);
      if (own || later) landed.add(w);
      later ||= own;
    }
    landedWaves = [...landed].sort((a, b) => a - b);
    const goes = (/** @type {(typeof rows)[number]} */ r) =>
      r.slice !== null && landed.has(r.wave) && (r.sha ? r.landed : !IN_FLIGHT.test(r.state));
    movedRows = rows.filter(goes).map((r) => r.line);
    if (movedRows.length)
      blocks[tableIdx] = [...header, ...rows.filter((r) => !goes(r)).map((r) => r.line)].join("\n");
    blocks.forEach((b, i) => {
      const lead = leadOf(b);
      const w = /^Wave\s+(\d+)\b/i.exec(lead);
      if (w && landed.has(Number(w[1])) && i !== latest?.i && !isLandingMode(lead)) moved.add(i);
    });
  }

  // A list after a moved paragraph ending in ":" goes with it.
  for (let i = 1; i < blocks.length; i++) {
    if (!isList(blocks[i]) || moved.has(i)) continue;
    let owner = i - 1;
    while (owner > 0 && isList(blocks[owner]) && moved.has(owner)) owner--;
    if (moved.has(owner) && !isList(blocks[owner]) && /:\s*$/.test(blocks[owner])) moved.add(i);
  }

  if (!moved.size && !movedRows.length) {
    if (!restored) return { ...unchanged, landedWaves };
    const plan = `${planText.slice(0, at.start)}\n${blocks.join("\n\n")}\n\n${planText.slice(at.end).replace(/^\n+/, "")}`;
    return { ...unchanged, plan, landedWaves, restored };
  }

  const paras = [...moved]
    .sort((a, b) => a - b)
    .map((i) => ({ i, text: blocks[i], r: rankOf(leadOf(blocks[i]), i) }));
  // Newest first, a list staying after its paragraph: rank each run of lists by its owner.
  /** @type {{ r: any[], texts: string[] }[]} */
  const groups = [];
  for (const p of paras) {
    const last = groups.at(-1);
    if (isList(p.text) && last) last.texts.push(p.text);
    else groups.push({ r: p.r, texts: [p.text] });
  }
  groups.sort((a, b) => (newer(a.r, b.r) ? -1 : newer(b.r, a.r) ? 1 : 0));

  const pointer = `**History:** earlier hand-offs and landed waves' rows are in [\`plans/${topic}-history.md\`](${topic}-history.md) (\`pnpm prd status-trim\`).`;
  const kept = blocks.filter((_, i) => !moved.has(i));
  if (!kept.some((b) => b.includes(`${topic}-history.md`))) {
    const mode = kept.findIndex((b) => isLandingMode(leadOf(b)) || /^\*\*Landing mode/i.test(b));
    kept.splice(mode + 1, 0, pointer);
  }
  const plan = `${planText.slice(0, at.start)}\n${kept.join("\n\n")}\n\n${planText.slice(at.end).replace(/^\n+/, "")}`;

  const section = [`## Trimmed${date ? ` ${date}` : ""}`, ...groups.flatMap((g) => g.texts)];
  if (movedRows.length) {
    const bySlice = (/** @type {string} */ l) => Number(cells(l)[0]);
    section.push([...header, ...[...movedRows].sort((a, b) => bySlice(b) - bySlice(a))].join("\n"));
  }
  const intro =
    `# History: ${topic}\n\n` +
    `Finished-wave history moved out of [the plan](${topic}-plan.md)'s _Status_ by \`pnpm prd status-trim ${topic}\`, the newest trim first.`;
  const base = historyText.trim() ? historyText : `${intro}\n`;
  const first = /^## /m.exec(base);
  const history = first
    ? `${base.slice(0, first.index)}${section.join("\n\n")}\n\n${base.slice(first.index)}`
    : `${base.trimEnd()}\n\n${section.join("\n\n")}\n`;
  return { plan, history, paragraphs: moved.size, rows: movedRows.length, landedWaves, restored };
}

// ---- CLI -------------------------------------------------------------------------

const git = (/** @type {string} */ repo, /** @type {string[]} */ ...args) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

/** sha → whether it's in any of the refs (an unknown or ambiguous sha isn't). */
function landedIn(/** @type {string} */ repo, /** @type {string[]} */ refs) {
  const cache = new Map();
  return (/** @type {string} */ sha) => {
    if (!cache.has(sha)) {
      let yes = false;
      try {
        const full = git(repo, "rev-parse", "--verify", "-q", `${sha}^{commit}`);
        yes = refs.some((ref) => {
          try {
            git(repo, "merge-base", "--is-ancestor", full, ref);
            return true;
          } catch {
            return false;
          }
        });
      } catch {
        /* an unknown or ambiguous sha: not landed */
      }
      cache.set(sha, yes);
    }
    return cache.get(sha);
  };
}

async function format(/** @type {string} */ text, /** @type {string} */ file) {
  const prettier = await import("prettier");
  const config = (await prettier.resolveConfig(file)) ?? {};
  return prettier.format(text, { ...config, filepath: file });
}

const kb = (/** @type {number} */ n) => `${(n / 1024).toFixed(1)} KB`;

/** Runs the CLI; resolves to the exit code. */
export async function main(/** @type {string[]} */ argv, { out = console.log, err = console.error } = {}) {
  const args = [...argv];
  const opt = (/** @type {string} */ name) => {
    const i = args.indexOf(name);
    return i < 0 ? null : (args.splice(i, 2)[1] ?? "");
  };
  const flag = (/** @type {string} */ name) => {
    const i = args.indexOf(name);
    return i >= 0 && args.splice(i, 1).length > 0;
  };
  let repo = opt("--repo");
  const base = opt("--base");
  const date = opt("--date") ?? new Date().toISOString().slice(0, 10);
  const dry = flag("--dry-run");
  const next = flag("--next");
  const [topic, ...rest] = args;
  if (!topic || rest.length || !/^[a-z0-9][a-z0-9-]*$/.test(topic)) {
    err("usage: pnpm prd status-trim <topic> [--dry-run] [--base <ref>] [--next]");
    return 2;
  }
  if (!repo) {
    try {
      repo = git(process.cwd(), "rev-parse", "--show-toplevel");
    } catch {
      repo = process.cwd();
    }
  }
  const planFile = join(repo, "plans", `${topic}-plan.md`);
  const historyFile = join(repo, "plans", `${topic}-history.md`);
  if (!existsSync(planFile)) {
    err(`status-trim: no plans/${topic}-plan.md in ${repo}`);
    return 1;
  }
  const planText = readFileSync(planFile, "utf8");
  const historyText = existsSync(historyFile) ? readFileSync(historyFile, "utf8") : "";
  if (next) {
    out(String(nextSlice(planText, historyText)));
    return 0;
  }
  if (!statusAt(planText)) {
    err(`status-trim: plans/${topic}-plan.md has no ## Status section`);
    return 1;
  }
  const refs = base ? [base] : ["dev", "origin/dev"];
  const r = trimStatus(planText, { topic, historyText, isLanded: landedIn(repo, refs), date });
  const before = statusBytes(planText);
  if (!r.paragraphs && !r.rows && !r.restored) {
    out(`status-trim: nothing to move; _Status_ is ${kb(before)}`);
    if (before > STATUS_WARN_BYTES) out(`  still over ${kb(STATUS_WARN_BYTES)}: shorten what stays by hand`);
    return 0;
  }
  const plan = await format(r.plan, planFile);
  const history = await format(r.history, historyFile);
  const after = statusBytes(plan);
  const what = `${r.paragraphs} paragraph(s) and ${r.rows} row(s)`;
  const waves = r.landedWaves.length ? `; landed waves ${r.landedWaves.join(", ")}` : "";
  const table = `_Status_ has no slice table: ${dry ? "would put" : "put"} back an empty one`;
  if (!r.paragraphs && !r.rows) {
    if (dry) out(`status-trim (dry run): ${table}`);
    else {
      writeFileSync(planFile, plan);
      out(`status-trim: ${table}; commit the plan`);
    }
    return 0;
  }
  if (r.restored) out(`status-trim${dry ? " (dry run)" : ""}: ${table}`);
  if (dry) {
    out(`status-trim (dry run): would move ${what} to plans/${topic}-history.md${waves}`);
    out(`  _Status_ ${kb(before)} → ${kb(after)}`);
    return 0;
  }
  writeFileSync(planFile, plan);
  writeFileSync(historyFile, history);
  out(`status-trim: moved ${what} to plans/${topic}-history.md${waves}`);
  out(`  _Status_ ${kb(before)} → ${kb(after)}; commit both files`);
  if (after > STATUS_WARN_BYTES) out(`  still over ${kb(STATUS_WARN_BYTES)}: shorten what stays by hand`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exit(await main(process.argv.slice(2)));
