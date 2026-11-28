#!/usr/bin/env node
// A slice's fields from its plan: the line under a slice heading such as
//
//   ## Slice 3: Backlog write safety
//
//   Stack: no · Reads: docs/loops.md, docs/domain/sync.md · Tests: unit, e2e:invites
//
// Fields are separated by "·", ";" or "|"; names are case-insensitive. A missing
// field gets its default (no stack, nothing extra to read, no tests named) and a
// warning, as does a malformed one. An optional `Blocked by: slice 3` (or `3`,
// `1, 2`, `none`) names the slices this one waits for, and an optional
// `Check: loops/x.test.mjs` the one test file the slice's narrow check runs,
// and an optional `Model: opus|sonnet` the model its agent runs on (opus when
// left out; any other model is an error, and the command exits 1); leaving any
// of them out is fine here (check-plan.mjs's planBudget warns on a missing
// Check). (`doc planner`.)
//
//   node slice-fields.mjs <n> [plan-file]   (the plan on stdin when no file)
//     prints "Stack: …", "Reads: …", "Tests: …" and "Model: …", warnings on stderr
//   node slice-fields.mjs <n> [plan-file] --get stack|reads|tests|check|model
//     prints one field's value only (stack: yes or no; model: opus or sonnet)
// A slice's body is also read for line-number anchors (`file.mjs ~158`,
// `:231`), which go stale on hot files: `lineAnchors` finds them, and
// `anchors` (anchors.mjs) warns on each.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const FIELDS = ["stack", "reads", "tests"];
/** Known fields a slice may leave out without a warning. */
export const OPTIONAL_FIELDS = ["blocked by", "check", "model"];
/** The models a slice may run on, the default first (haiku is a helper's, never a slice's). */
export const MODELS = ["opus", "sonnet"];
/** What `--get` prints. */
const GETS = [...FIELDS, "check", "model"];
const KNOWN = [...FIELDS, ...OPTIONAL_FIELDS];
const HEADING = /^#{2,4}\s+Slice\s+(\d+)\b/i;
const FIELD = /^([A-Za-z]+(?:\s+[A-Za-z]+)*)\s*:\s*(.*)$/;
const fieldName = (raw) => raw.toLowerCase().replace(/\s+/g, " ");

/** Split on commas outside parentheses: "a (b, c), d" → ["a (b, c)", "d"]. */
export function splitList(text) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s && s.toLowerCase() !== "none");
}

/** Is this line a fields line (it starts with a known field name and a colon)? */
export function isFieldsLine(line) {
  const m = FIELD.exec(line.trim());
  return !!m && KNOWN.includes(fieldName(m[1]));
}

/**
 * Parse one fields line. Returns the raw values found (lowercased names) and
 * warnings for unknown names and repeats.
 */
export function parseFieldsLine(line) {
  const values = {};
  const warnings = [];
  for (const part of line.trim().split(/\s*[·;|]\s*/)) {
    if (!part) continue;
    const m = FIELD.exec(part);
    if (!m) {
      warnings.push(`can't read "${part}" (expected Name: value)`);
      continue;
    }
    const name = fieldName(m[1]);
    if (!KNOWN.includes(name)) warnings.push(`unknown field "${m[1]}"`);
    else if (name in values) warnings.push(`${m[1]} is given twice; using the first`);
    else values[name] = m[2].trim();
  }
  return { values, warnings };
}

/**
 * The fields of slice `n` in a plan's text.
 * → { found, stack: boolean, reads: string[], readsText, tests: string[], blockedBy: number[],
 *     check: string[], model: "opus"|"sonnet", given: string[], missing: string[],
 *     warnings: string[], errors: string[] }
 * `given` names the fields the slice's fields line gives (lowercased).
 * `found` is false when the plan has no such slice heading. Defaults apply to
 * anything missing or malformed, and each such case adds a warning; an
 * unknown Model is an error instead (the model stays opus).
 */
export function sliceFields(planText, n) {
  const lines = planText.split(/\r?\n/);
  const result = {
    found: false,
    stack: false,
    reads: [],
    readsText: "",
    tests: [],
    blockedBy: [],
    check: [],
    model: MODELS[0],
    given: [],
    missing: [],
    warnings: [],
    errors: [],
  };
  const at = lines.findIndex((l) => {
    const m = HEADING.exec(l);
    return !!m && Number(m[1]) === Number(n);
  });
  if (at < 0) {
    result.missing = [...FIELDS];
    result.warnings.push(`no "Slice ${n}" heading in the plan`);
    return result;
  }
  result.found = true;

  // The fields line(s): the first non-blank lines under the heading that start
  // with a field name. Anything else ends the search.
  const values = {};
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (!isFieldsLine(line)) break;
    const parsed = parseFieldsLine(line);
    result.warnings.push(...parsed.warnings);
    for (const [k, v] of Object.entries(parsed.values)) if (!(k in values)) values[k] = v;
  }

  if ("stack" in values) {
    const v = values.stack.toLowerCase();
    if (v === "yes" || v === "no") result.stack = v === "yes";
    else result.warnings.push(`Stack must be yes or no, not "${values.stack}"; using no`);
  }
  if ("reads" in values) {
    result.readsText = values.reads;
    result.reads = splitList(values.reads);
  }
  if ("tests" in values) {
    result.tests = splitList(values.tests);
    if (!result.tests.length) result.warnings.push("Tests is empty");
  }
  if ("blocked by" in values) {
    for (const item of splitList(values["blocked by"])) {
      const m = /^(?:slices?\s+)?(\d+)$/i.exec(item);
      if (m) result.blockedBy.push(Number(m[1]));
      else if (!/^nothing$/i.test(item))
        result.warnings.push(`Blocked by takes slice numbers, not "${item}"`);
    }
  }
  if ("check" in values) result.check = splitList(values.check);
  if ("model" in values) {
    const v = values.model.toLowerCase();
    if (MODELS.includes(v)) result.model = /** @type {"opus"|"sonnet"} */ (v);
    else result.errors.push(`Model must be ${MODELS.join(" or ")}, not "${values.model}"`);
  }
  result.given = Object.keys(values);
  result.missing = FIELDS.filter((f) => !(f in values));
  for (const f of result.missing) result.warnings.push(`no ${f[0].toUpperCase()}${f.slice(1)} field`);
  return result;
}

const EXTS = "mjs|cjs|js|jsx|ts|tsx|mts|cts|md|mdx|json|jsonc|ya?ml|sh|bash|sql|css|html|txt|toml|svg|png";
/** A backticked word ending in one of these extensions names a file (anchors.mjs too). */
export const FILE_EXT = new RegExp(`\\.(?:${EXTS})$`);
const FILE_WORD = `[\\w./-]*\\.(?:${EXTS})\\b`;
/** A file name, maybe backticked, then ~158, :231, line 158 or #L158. */
const ANCHOR_AFTER_FILE = new RegExp(
  `(${FILE_WORD})\`?(?:\\s*~\\s*\\d+|:\\d+|#L\\d+|,?\\s+(?:at\\s+|near\\s+)?lines?\\s+~?\\d+)`,
  "g",
);
/** A code span that is only a line number: `~158`, `:231`, `L158`, `line 158`. */
const ANCHOR_SPAN = /`(?:~\s*\d+|:\d+(?:-\d+)?|L\d+|lines?\s+\d+)`/g;

/**
 * The line-number anchors in a slice's text (`file.mjs ~158`, `` `:231` ``,
 * `file.mjs line 40`), as written. A plain number in prose (`~120k`, `3 files`)
 * is not one.
 */
export function lineAnchors(/** @type {string} */ text) {
  const found = [];
  for (const re of [ANCHOR_AFTER_FILE, ANCHOR_SPAN])
    for (const m of text.matchAll(re)) found.push({ at: m.index, text: m[0] });
  return found.sort((a, b) => a.at - b.at).map((f) => f.text);
}

/**
 * Each slice's heading number and body (the heading to the next heading of its
 * level or above), in plan order.
 */
export function sliceSections(/** @type {string} */ planText) {
  const lines = planText.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i]);
    if (!m) continue;
    const level = /^#+/.exec(lines[i])[0].length;
    const ends = (/** @type {string} */ l) => {
      const h = /^(#+)\s/.exec(l);
      return !!h && h[1].length <= level;
    };
    let j = i + 1;
    while (j < lines.length && !ends(lines[j])) j++;
    out.push({ n: Number(m[1]), heading: lines[i], body: lines.slice(i + 1, j).join("\n") });
    i = j - 1;
  }
  return out;
}

const SHA = /\b[0-9a-f]{7,40}\b/;
const DONE_STATE = /^\s*(?:merged|landed|done)\b/i;

/**
 * The rows of a plan's (or its history's) tables that have a Slice column, each
 * as { slice, cells } with cells keyed by the lowercased column name.
 */
export function sliceRows(/** @type {string} */ text) {
  const rows = [];
  let cols = null;
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s*\|/.test(line)) {
      cols = null;
      continue;
    }
    const cells = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
    if (!cols) {
      cols = cells.map((c) => c.toLowerCase());
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const slice = /^\d+$/.exec(cells[cols.indexOf("slice")] ?? "");
    if (!slice) continue;
    rows.push({
      slice: Number(slice[0]),
      cells: Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""])),
    });
  }
  return rows;
}

/** The slice numbers a plan's (or its history's) tables mark merged (anchors.mjs, check-plan.mjs). */
export function mergedSlices(/** @type {string[]} */ texts) {
  const merged = new Set();
  for (const text of texts)
    for (const { slice, cells } of sliceRows(text)) {
      const merge = Object.keys(cells).find((c) => c.startsWith("merge"));
      if ((merge && SHA.test(cells[merge])) || DONE_STATE.test(cells.state ?? "")) merged.add(slice);
    }
  return merged;
}

/** The four lines prompt.sh prints. */
export function formatFields(f) {
  return [
    `Stack: ${f.stack ? "yes" : "no"}`,
    `Reads: ${f.readsText || "nothing besides AGENTS.md"}`,
    `Tests: ${f.tests.length ? f.tests.join(", ") : "none named"}`,
    `Model: ${f.model}`,
  ].join("\n");
}

function main(argv) {
  const args = [...argv];
  let get = null;
  const gi = args.indexOf("--get");
  if (gi >= 0) {
    get = args[gi + 1];
    args.splice(gi, 2);
    if (!GETS.includes(get)) {
      process.stderr.write(`--get takes ${GETS.join(", ")}\n`);
      return 2;
    }
  }
  const [n, file] = args;
  if (!n || !/^\d+$/.test(n)) {
    process.stderr.write(`usage: slice-fields.mjs <n> [plan-file] [--get ${GETS.join("|")}]\n`);
    return 2;
  }
  const text = readFileSync(file ?? 0, "utf8");
  const f = sliceFields(text, n);
  for (const w of f.warnings) process.stderr.write(`warning: slice ${n}: ${w}\n`);
  for (const e of f.errors) process.stderr.write(`error: slice ${n}: ${e}\n`);
  if (f.errors.length) return 1;
  if (get === "stack") process.stdout.write(`${f.stack ? "yes" : "no"}\n`);
  else if (get === "reads") process.stdout.write(`${f.readsText}\n`);
  else if (get === "tests") process.stdout.write(`${f.tests.join(", ")}\n`);
  else if (get === "check") process.stdout.write(`${f.check.join(", ")}\n`);
  else if (get === "model") process.stdout.write(`${f.model}\n`);
  else process.stdout.write(`${formatFields(f)}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exitCode = main(process.argv.slice(2));
