#!/usr/bin/env node
// A slice's fields from its plan: the line under a slice heading such as
//
//   ## Slice 3: Backlog write safety
//
//   Stack: no · Reads: docs/loops.md, docs/domain/sync.md · Tests: unit, e2e:invites
//
// Fields are separated by "·", ";" or "|"; names are case-insensitive. A missing
// field gets its default (no stack, nothing extra to read, no tests named) and a
// warning, as does a malformed one. (docs/agents/planner.md, _Slice fields_.)
//
//   node slice-fields.mjs <n> [plan-file]   (the plan on stdin when no file)
//     prints "Stack: …", "Reads: …" and "Tests: …", warnings on stderr
//   node slice-fields.mjs <n> [plan-file] --get stack|reads|tests
//     prints one field's value only (stack: yes or no)
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const FIELDS = ["stack", "reads", "tests"];
const HEADING = /^#{2,4}\s+Slice\s+(\d+)\b/i;
const FIELD = /^([A-Za-z]+)\s*:\s*(.*)$/;

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
  return !!m && FIELDS.includes(m[1].toLowerCase());
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
    const name = m[1].toLowerCase();
    if (!FIELDS.includes(name)) warnings.push(`unknown field "${m[1]}"`);
    else if (name in values) warnings.push(`${m[1]} is given twice; using the first`);
    else values[name] = m[2].trim();
  }
  return { values, warnings };
}

/**
 * The fields of slice `n` in a plan's text.
 * → { found, stack: boolean, reads: string[], readsText, tests: string[], missing: string[], warnings: string[] }
 * `found` is false when the plan has no such slice heading. Defaults apply to
 * anything missing or malformed, and each such case adds a warning.
 */
export function sliceFields(planText, n) {
  const lines = planText.split(/\r?\n/);
  const result = {
    found: false,
    stack: false,
    reads: [],
    readsText: "",
    tests: [],
    missing: [],
    warnings: [],
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
  result.missing = FIELDS.filter((f) => !(f in values));
  for (const f of result.missing) result.warnings.push(`no ${f[0].toUpperCase()}${f.slice(1)} field`);
  return result;
}

/** The three lines prompt.sh prints. */
export function formatFields(f) {
  return [
    `Stack: ${f.stack ? "yes" : "no"}`,
    `Reads: ${f.readsText || "nothing besides AGENTS.md"}`,
    `Tests: ${f.tests.length ? f.tests.join(", ") : "none named"}`,
  ].join("\n");
}

function main(argv) {
  const args = [...argv];
  let get = null;
  const gi = args.indexOf("--get");
  if (gi >= 0) {
    get = args[gi + 1];
    args.splice(gi, 2);
    if (!FIELDS.includes(get)) {
      process.stderr.write(`--get takes ${FIELDS.join(", ")}\n`);
      return 2;
    }
  }
  const [n, file] = args;
  if (!n || !/^\d+$/.test(n)) {
    process.stderr.write("usage: slice-fields.mjs <n> [plan-file] [--get stack|reads|tests]\n");
    return 2;
  }
  const text = readFileSync(file ?? 0, "utf8");
  const f = sliceFields(text, n);
  for (const w of f.warnings) process.stderr.write(`warning: slice ${n}: ${w}\n`);
  if (get === "stack") process.stdout.write(`${f.stack ? "yes" : "no"}\n`);
  else if (get === "reads") process.stdout.write(`${f.readsText}\n`);
  else if (get === "tests") process.stdout.write(`${f.tests.join(", ")}\n`);
  else process.stdout.write(`${formatFields(f)}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exitCode = main(process.argv.slice(2));
