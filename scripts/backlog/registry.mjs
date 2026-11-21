// The PRD registry: the "## PRDs" table in plans/backlog.md's preamble. Pure:
// no git, no file system (backlog.mjs gathers the facts and writes).
//
//   | PRD     | Flags          | After           | Hot files               | Doc and notes |
//   | ------- | -------------- | --------------- | ----------------------- | ------------- |
//   | `topic` | hold, standing | `other`, `more` | `scripts/loops/`, `x.ts` | any Markdown  |
//
// Row order is the priority. A row stores only what git can't say: its flags
// (FLAGS, or —), the topics it comes after, its hot files (repo path prefixes,
// which may name files not made yet) and notes. Whether a topic is to write,
// planned, running or idle is worked out by stateOf, never stored.
//
// Today's table (PRD, Doc, Depends on, Hot files: prose) is "old": migrate()
// reshapes it once, mechanically, keeping every row in its order.

import { BacklogError } from "./format.mjs";

/** hold: waits on the user; done: finished; standing: never finishes, runs while it has waiting items; alone: nothing else runs beside it. */
export const FLAGS = ["hold", "done", "standing", "alone"];
/** The worked-out states, as `prd list` prints them. */
export const STATES = ["to-write", "planned", "running", "idle", "hold", "done"];
/** Item statuses that mean "still to do" for a topic (doctor's "waiting items"). */
export const WAITING = ["inbox", "triaged", "in-progress"];

export const SECTION = "## PRDs";
const HEADER = ["PRD", "Flags", "After", "Hot files", "Doc and notes"];
const NONE = "—";

/** What the section says above a migrated table. */
export const INTRO = [
  "The PRD registry: **row order is the priority**. Edit it only with `pnpm backlog prd` (`add`, `set`, `move`); `pnpm backlog prd list` shows each topic's state (to-write, planned, running, idle, hold, done), worked out from git and the items. At most three PRD orchestrators run at once.",
  "",
  "`Flags`: `hold` (waits on the user), `done`, `standing` (never finishes; runs while it has waiting items), `alone` (nothing else runs beside it). `After`: the topics it comes after. `Hot files`: repo path prefixes it shares.",
].join("\n");

/**
 * @typedef {{ topic: string, flags: string[], after: string[], hot: string[], notes: string }} Row
 * @typedef {{ topic: string, doc: string, depends: string, hot: string }} OldRow
 * @typedef {{ format: "none" } | { format: "old", rows: OldRow[] } | { format: "new", rows: Row[] }} Registry
 */

// ---- cells ------------------------------------------------------------------

/** "| a | b \| c |" → ["a", "b | c"]. @param {string} line */
export const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

const isSeparator = (line) => /^\|(\s*:?-+:?\s*\|)+\s*$/.test(line.trim());
const unquote = (s) =>
  s
    .trim()
    .replace(/^`+|`+$/g, "")
    .trim();

/** "`a`, `b`" or "a,b" → ["a", "b"]; "—", "-" or "" → []. @param {string} cell */
export function parseList(cell) {
  const t = cell.trim();
  if (!t || t === NONE || t === "-") return [];
  return t
    .split(",")
    .map(unquote)
    .filter((s) => s && s !== NONE);
}

const escape = (s) => s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
const codeList = (xs) => (xs.length ? xs.map((x) => `\`${x}\``).join(", ") : NONE);

/** @param {Row} r */
const rowLine = (r) =>
  `| \`${r.topic}\` | ${r.flags.length ? r.flags.join(", ") : NONE} | ${codeList(r.after)} | ${codeList(r.hot)} | ${escape(r.notes) || NONE} |`;

/** The table's lines for `rows`, in order. @param {Row[]} rows */
export const renderTable = (rows) => [
  `| ${HEADER.join(" | ")} |`,
  `| ${HEADER.map((h) => "-".repeat(h.length)).join(" | ")} |`,
  ...rows.map(rowLine),
];

// ---- the section in the preamble ---------------------------------------------

/** Where the section and its table sit in the preamble's lines. @param {string[]} lines */
function locate(lines) {
  const start = lines.findIndex((l) => l.trim() === SECTION);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##? /.test(l));
  if (end < 0) end = lines.length;
  const tableStart = lines.findIndex((l, i) => i > start && i < end && l.trim().startsWith("|"));
  if (tableStart < 0) return { start, end, tableStart: -1, tableEnd: -1 };
  let tableEnd = tableStart;
  while (tableEnd < end && lines[tableEnd].trim().startsWith("|")) tableEnd++;
  return { start, end, tableStart, tableEnd };
}

/** @param {string} preamble @returns {Registry} */
export function parseRegistry(preamble) {
  const lines = preamble.replace(/\r\n/g, "\n").split("\n");
  const at = locate(lines);
  if (!at || at.tableStart < 0) return { format: "none" };
  const [head, ...body] = lines.slice(at.tableStart, at.tableEnd);
  const header = cells(head);
  const rows = body.filter((l) => !isSeparator(l)).map(cells);
  if (header.join("|") === HEADER.join("|"))
    return {
      format: "new",
      rows: rows.map(([topic = "", flags = "", after = "", hot = "", notes = ""]) => ({
        topic: unquote(topic),
        flags: parseList(flags),
        after: parseList(after),
        hot: parseList(hot),
        notes: notes === NONE ? "" : notes,
      })),
    };
  if (header[0] === "PRD" && header[1] === "Doc")
    return {
      format: "old",
      rows: rows.map(([topic = "", doc = "", depends = "", hot = ""]) => ({
        topic: unquote(topic),
        doc,
        depends,
        hot,
      })),
    };
  throw new BacklogError(`the "${SECTION}" table's header isn't one this tool knows: ${head.trim()}`);
}

/**
 * The preamble with the section's table replaced by `rows` (and, with
 * `intro`, the text between the heading and the table replaced by it).
 * @param {string} preamble @param {Row[]} rows @param {{ intro?: string }} [opts]
 */
export function withRows(preamble, rows, opts = {}) {
  const lines = preamble.replace(/\r\n/g, "\n").split("\n");
  const at = locate(lines);
  if (!at || at.tableStart < 0) throw new BacklogError(`plans/backlog.md has no "${SECTION}" table`);
  const before =
    opts.intro === undefined
      ? lines.slice(0, at.tableStart)
      : [...lines.slice(0, at.start + 1), "", opts.intro, ""];
  return [...before, ...renderTable(rows), ...lines.slice(at.tableEnd)].join("\n");
}

/** The new-format rows, or an error that says to migrate. @param {string} preamble */
export function rowsOf(preamble) {
  const reg = parseRegistry(preamble);
  if (reg.format === "new") return reg.rows;
  if (reg.format === "old")
    throw new BacklogError("the PRD table isn't migrated yet: run pnpm backlog prd migrate");
  throw new BacklogError(`plans/backlog.md has no "${SECTION}" table`);
}

// ---- the migration -------------------------------------------------------------

/** Prose that says nothing: "—", "(none)", "none now". */
const empty = (s) => /^(—|-|\(none\)|none|none now)?$/i.test(s.trim());

/**
 * `done` only when the doc cell says **done** and nothing more than a
 * parenthesis (a commit, a PR) after it: "**done** except …", "**done**;
 * B-40 waits on the user" and "**Done 2026-11-20**" stay —.
 * @param {string} doc
 */
export const saysDone = (doc) => {
  const m = /\*\*done\*\*/.exec(doc);
  return !!m && /^\s*(\([^)]*\))?\s*\.?\s*$/.test(doc.slice(m.index + m[0].length));
};

/** One old row as a registry row: the doc cell, then the old prose, in the notes. @param {OldRow} o @returns {Row} */
export function migrateRow(o) {
  const notes = [
    o.doc.trim(),
    ...(empty(o.depends) ? [] : [`Depends on: ${o.depends.trim()}`]),
    ...(empty(o.hot) ? [] : [`Hot files: ${o.hot.trim()}`]),
  ]
    .filter(Boolean)
    .join(" · ");
  return { topic: o.topic, flags: saysDone(o.doc) ? ["done"] : [], after: [], hot: [], notes };
}

/** Today's table reshaped: the same rows in the same order. @param {string} preamble */
export function migrate(preamble) {
  const reg = parseRegistry(preamble);
  if (reg.format === "new") throw new BacklogError("the PRD table is already migrated");
  if (reg.format === "none") throw new BacklogError(`plans/backlog.md has no "${SECTION}" table`);
  return { preamble: withRows(preamble, reg.rows.map(migrateRow), { intro: INTRO }), count: reg.rows.length };
}

// ---- the worked-out state --------------------------------------------------------

/**
 * @typedef {{ plans: Set<string>, worktrees: Set<string>, waiting: Map<string, number> }} Facts
 *   plans: topics with plans/<topic>-plan.md on dev; worktrees: topics with a
 *   prd/<topic> worktree; waiting: triaged items per topic
 */

/**
 * A topic's state. `done` first; then `running` (a hand start of a held topic
 * still runs); then `hold`; then a standing topic is `planned` while it has
 * triaged items and `idle` without; any other is `planned` once its plan is
 * on dev, else `to-write`.
 * @param {Row} row @param {Facts} facts
 */
export function stateOf(row, facts) {
  if (row.flags.includes("done")) return "done";
  if (facts.worktrees.has(row.topic)) return "running";
  if (row.flags.includes("hold")) return "hold";
  if (row.flags.includes("standing")) return (facts.waiting.get(row.topic) ?? 0) > 0 ? "planned" : "idle";
  return facts.plans.has(row.topic) ? "planned" : "to-write";
}

// ---- edits ----------------------------------------------------------------------

const TOPIC = /^[a-z0-9][a-z0-9-]*$/;
/** @param {string} t */
export function checkTopic(t) {
  if (!TOPIC.test(t ?? ""))
    throw new BacklogError(`"${t ?? ""}" isn't a topic (lowercase letters, digits, -)`);
}

const indexOf = (rows, topic) => {
  const i = rows.findIndex((r) => r.topic === topic);
  if (i < 0) throw new BacklogError(`no PRD row "${topic}" (pnpm backlog prd list)`);
  return i;
};

/**
 * @typedef {{ first: true } | { last: true } | { before: string } | { after: string }} Position
 */

/** `row` put into `rows` at `pos`; a new array. @param {Row[]} rows @param {Row} row @param {Position} pos */
function insert(rows, row, pos) {
  const out = [...rows];
  if ("first" in pos) out.unshift(row);
  else if ("last" in pos) out.push(row);
  else if ("before" in pos) out.splice(indexOf(out, pos.before), 0, row);
  else out.splice(indexOf(out, pos.after) + 1, 0, row);
  return out;
}

/**
 * Apply "key=value" pairs (flags, after, hot: comma-separated, — or empty
 * clears; notes: text) to a copy of `row`.
 * @param {Row} row @param {string[]} pairs @returns {Row}
 */
export function setRow(row, pairs) {
  const r = { ...row };
  for (const p of pairs) {
    const eq = p.indexOf("=");
    if (eq < 1) throw new BacklogError(`"${p}" isn't key=value`);
    const key = p.slice(0, eq);
    const value = p.slice(eq + 1);
    if (key === "notes") r.notes = value.trim() === NONE ? "" : value.trim();
    else if (key === "flags") {
      const flags = [...new Set(parseList(value))];
      const bad = flags.filter((f) => !FLAGS.includes(f));
      if (bad.length) throw new BacklogError(`unknown flag ${bad.join(", ")} (flags: ${FLAGS.join(", ")})`);
      r.flags = flags;
    } else if (key === "after") {
      const after = [...new Set(parseList(value))];
      after.forEach(checkTopic);
      if (after.includes(r.topic)) throw new BacklogError(`${r.topic} can't come after itself`);
      r.after = after;
    } else if (key === "hot") r.hot = [...new Set(parseList(value))];
    else throw new BacklogError(`can't set "${key}" (use flags, after, hot or notes)`);
  }
  return r;
}

/** A new row. @param {Row[]} rows @param {string} topic @param {string[]} pairs @param {Position} pos */
export function addRow(rows, topic, pairs, pos = { last: true }) {
  checkTopic(topic);
  if (rows.some((r) => r.topic === topic)) throw new BacklogError(`there's already a PRD row "${topic}"`);
  return insert(rows, setRow({ topic, flags: [], after: [], hot: [], notes: "" }, pairs), pos);
}

/** @param {Row[]} rows @param {string} topic @param {string[]} pairs */
export function updateRow(rows, topic, pairs) {
  const i = indexOf(rows, topic);
  if (!pairs.length) throw new BacklogError("usage: prd set <topic> flags=… after=… hot=… notes=…");
  return rows.map((r, j) => (j === i ? setRow(r, pairs) : r));
}

/** @param {Row[]} rows @param {string} topic @param {Position} pos */
export function moveRow(rows, topic, pos) {
  const row = rows[indexOf(rows, topic)];
  const anchor = "before" in pos ? pos.before : "after" in pos ? pos.after : null;
  if (anchor === topic) throw new BacklogError(`can't move ${topic} next to itself`);
  if (anchor !== null) indexOf(rows, anchor);
  return insert(
    rows.filter((r) => r !== row),
    row,
    pos,
  );
}

// ---- doctor -------------------------------------------------------------------------

/**
 * Cycles in the After graph, each once, as "a → b → a" (starting from the
 * topic that comes first in the table). @param {Row[]} rows
 */
export function cycles(rows) {
  const after = new Map(rows.map((r) => [r.topic, r.after]));
  const order = new Map(rows.map((r, i) => [r.topic, i]));
  const found = new Map();
  const state = new Map(); // 1: on the stack, 2: done
  const stack = [];
  const visit = (t) => {
    state.set(t, 1);
    stack.push(t);
    for (const n of after.get(t) ?? []) {
      if (!after.has(n)) continue; // unknown: its own finding
      if (state.get(n) === 1) {
        const loop = stack.slice(stack.indexOf(n));
        const startAt = loop.reduce(
          (m, x, i) => ((order.get(x) ?? 0) < (order.get(loop[m]) ?? 0) ? i : m),
          0,
        );
        const ordered = [...loop.slice(startAt), ...loop.slice(0, startAt)];
        const key = [...ordered].sort().join(" ");
        if (!found.has(key)) found.set(key, [...ordered, ordered[0]].join(" → "));
      } else if (!state.has(n)) visit(n);
    }
    stack.pop();
    state.set(t, 2);
  };
  for (const r of rows) if (!state.has(r.topic)) visit(r.topic);
  return [...found.values()];
}

/**
 * The registry's findings, in doctor's form (none fixable): a topic twice, an
 * unknown flag, an After topic with no row, a cycle, waiting items with no
 * row, a waiting item on a done topic.
 * @param {Row[]} rows @param {{ id: string, status: string, prd: string }[]} items
 * @returns {{ id: string, problem: string, fixable: false }[]}
 */
export function findings(rows, items) {
  /** @type {{ id: string, problem: string, fixable: false }[]} */
  const out = [];
  const add = (id, problem) => out.push({ id, problem, fixable: false });
  const topics = new Set(rows.map((r) => r.topic));
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.topic)) add(r.topic, "has more than one row in the PRD table");
    seen.add(r.topic);
    for (const f of r.flags)
      if (!FLAGS.includes(f)) add(r.topic, `has an unknown flag "${f}" (flags: ${FLAGS.join(", ")})`);
    for (const a of r.after)
      if (!topics.has(a)) add(r.topic, `comes after "${a}", which has no row in the PRD table`);
  }
  for (const c of cycles(rows)) add(c.split(" → ")[0], `is in a cycle of After: ${c}`);
  const waiting = items.filter((i) => i.prd && WAITING.includes(i.status));
  const orphans = new Map();
  for (const i of waiting) if (!topics.has(i.prd)) orphans.set(i.prd, [...(orphans.get(i.prd) ?? []), i.id]);
  for (const [topic, ids] of orphans)
    add(
      topic,
      `has ${ids.length} waiting item${ids.length === 1 ? "" : "s"} (${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ", …" : ""}) but no row in the PRD table`,
    );
  const done = new Set(rows.filter((r) => r.flags.includes("done")).map((r) => r.topic));
  for (const i of waiting) if (done.has(i.prd)) add(i.id, `is ${i.status}, but its topic ${i.prd} is done`);
  return out;
}
