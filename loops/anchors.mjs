#!/usr/bin/env node
// prd anchors: a plan's file and symbol anchors, checked against the base
// before the first slice starts (B-874). A plan written ahead of its PRD names
// files and functions that may have moved since; the orchestrator runs this at
// PRD start and fixes the plan's misses (`prd doc orchestrator`).
//
//   node anchors.mjs <topic> [--base <ref>] [--repo <dir>] [--plans <dir>]
//     For every slice not yet merged (its row in the plan's or history's
//     tables has a merge SHA, or a State of merged, landed or done):
//       - each backticked repo path in its body exists on <ref> (default dev,
//         else origin/dev): a word with a file extension (`slice-fields.mjs`;
//         a bare name or a path's tail, `prompts/slice.sh`, matches any file it
//         ends), or one with a slash whose first part is a top-level entry
//         (`loops/`);
//       - each backticked symbol beside a path (`path` `fn`, `path` (`fn`),
//         `path`: `fn`, `fn2`) is found in that file (a plain text search).
//     A path the slice creates is marked so: "a new `x.mjs`", "adds `x.mjs`",
//     "`x.mjs` (new)". Gitignored paths, placeholders (`<topic>`, `*`) and
//     words with spaces are not anchors. Line-number anchors (`file.mjs ~158`)
//     are warnings (slice-fields.mjs lineAnchors): name the function instead.
//     Also each unmerged slice's budget (check-plan.mjs planBudget: its Build
//     files, its Check field, a Check file shared within a wave), as warnings.
//     Prints each miss and warning. It only warns: exit 0 with or without
//     misses (it never stops a PRD start), 2 on a usage error.
//
// Pure parts (codeSpans, anchorsOf, mergedSlices, checkAnchors) take text and
// a view of the base's files; the CLI reads the plan and asks git.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FILE_EXT, lineAnchors, mergedSlices, sliceSections } from "./slice-fields.mjs";
import { planBudget } from "./check-plan.mjs";

/** The backticked spans of one line: { text, start, end } (end is past the closing tick). */
export function codeSpans(/** @type {string} */ line) {
  const out = [];
  const re = /(`+)([^`]+?)\1(?!`)/g;
  for (const m of line.matchAll(re))
    out.push({ text: m[2].trim(), start: m.index, end: m.index + m[0].length });
  return out;
}

const IDENT = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;
const NEW_BEFORE = /\b(?:new|adds?|creates?)\b[^`).;]{0,16}$/i;
const NEW_AFTER = /^\s*\(new\b/i;
const LIST_GAP = /^\s*(?:,|and|or|,\s*and|,\s*or|\/)?\s*$/;
/** The gap between a path and the first symbol beside it: short, no sentence end or closing bracket. */
const SYMBOL_GAP = /^[^.;!?)]{0,24}$/;
/** Words that look like identifiers but name no symbol. */
const NOT_SYMBOLS = new Set(["null", "undefined", "true", "false", "yes", "no", "none"]);

/**
 * A backticked word as a repo path, or null. `tops` holds the base's
 * top-level entries.
 */
export function asPath(/** @type {string} */ text, /** @type {Set<string>} */ tops) {
  if (/[\s<>*{}$?[\]:"'|\\]/.test(text) || /^[-/~]/.test(text)) return null;
  const p = text.replace(/^\.\//, "");
  if (FILE_EXT.test(p)) return p;
  if (p.includes("/") && tops.has(p.split("/")[0])) return p.replace(/\/+$/, "");
  return null;
}

/**
 * A slice body's anchors: { paths: [{ path, isNew }], symbols: [{ path, symbol }] }.
 * A symbol belongs to the path it follows on the same line, across short gaps
 * (`path` plus `fn`, `path` (`fn`, `fn2`)).
 */
export function anchorsOf(/** @type {string} */ body, /** @type {Set<string>} */ tops) {
  const paths = [];
  const symbols = [];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    let owner = null; // the path symbols attach to
    let listed = 0; // symbols attached to it so far
    let prevEnd = 0;
    let prevNew = false;
    for (const span of codeSpans(line)) {
      const gap = line.slice(prevEnd, span.start);
      prevEnd = span.end;
      const path = asPath(span.text, tops);
      if (path) {
        const isNew =
          NEW_BEFORE.test(line.slice(0, span.start)) ||
          NEW_AFTER.test(line.slice(span.end)) ||
          (prevNew && LIST_GAP.test(gap));
        paths.push({ path, isNew });
        owner = isNew ? null : path;
        listed = 0;
        prevNew = isNew;
        continue;
      }
      prevNew = false;
      // The first symbol sits close after its path (`path`'s `fn`, `path` (`fn`);
      // more follow as a list (`fn`, `fn2` and `fn3`); anything else ends it.
      const beside = listed ? LIST_GAP.test(gap) : SYMBOL_GAP.test(gap.replace(/\bnew\s*$/i, ""));
      if (!owner || !beside || !IDENT.test(span.text) || NOT_SYMBOLS.has(span.text)) {
        owner = null;
        continue;
      }
      listed++;
      if (!/\bnew\s*$/i.test(gap)) symbols.push({ path: owner, symbol: span.text });
    }
  }
  return { paths, symbols };
}

export { mergedSlices };

/**
 * Check every unmerged slice's anchors.
 *   base: { files: string[], read(path) → text | null, ignored(path) → boolean }
 * → { checked: number[], misses: [{ slice, kind: "path" | "symbol", path, symbol? }],
 *     warnings: [{ slice, text }] }
 */
export function checkAnchors({ planText, historyText = "", base }) {
  const files = new Set(base.files);
  const tops = new Set(base.files.map((f) => f.split("/")[0]));
  const merged = mergedSlices([planText, historyText]);
  /**
   * The base's files a path names: itself, or, short of the full path (a bare
   * name, `prompts/x.sh`), every file it ends; a directory exists with none.
   */
  const resolve = (/** @type {string} */ p) => {
    if (files.has(p)) return { exists: true, files: [p] };
    const named = base.files.filter((f) => f.endsWith(`/${p}`));
    if (named.length) return { exists: true, files: named };
    const dir = base.files.some((f) => f.startsWith(`${p}/`) || f.includes(`/${p}/`));
    return { exists: dir, files: [] };
  };
  const checked = [];
  const misses = [];
  const warnings = [];
  for (const { n, body } of sliceSections(planText)) {
    if (merged.has(n)) continue;
    checked.push(n);
    for (const a of lineAnchors(body))
      warnings.push({ slice: n, text: `line-number anchor "${a}": name the file and function instead` });
    const { paths, symbols } = anchorsOf(body, tops);
    const missing = new Set();
    for (const { path, isNew } of paths) {
      if (isNew || missing.has(path) || resolve(path).exists || base.ignored(path)) continue;
      missing.add(path);
      misses.push({ slice: n, kind: "path", path });
    }
    const seen = new Set();
    for (const { path, symbol } of symbols) {
      const key = `${path} ${symbol}`;
      if (seen.has(key) || missing.has(path)) continue;
      seen.add(key);
      const r = resolve(path);
      if (!r.files.length) continue; // a directory, or ignored
      const word = symbol.replace(/\(\)$/, "").split(".").pop();
      const re = new RegExp(`(?<![\\w$])${word.replace(/\$/g, "\\$")}(?![\\w$])`);
      if (!r.files.some((f) => re.test(base.read(f) ?? "")))
        misses.push({ slice: n, kind: "symbol", path, symbol });
    }
  }
  return { checked, misses, warnings };
}

/** A view of `ref`'s files in `repo`, through git. */
export function gitBase(/** @type {string} */ repo, /** @type {string} */ ref) {
  const git = (/** @type {string[]} */ args) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  const files = git(["ls-tree", "-r", "--name-only", "-z", ref]).split("\0").filter(Boolean);
  const cache = new Map();
  return {
    files,
    read(/** @type {string} */ p) {
      if (!cache.has(p)) {
        const r = spawnSync("git", ["-C", repo, "show", `${ref}:${p}`], {
          encoding: "utf8",
          maxBuffer: 1 << 26,
        });
        cache.set(p, r.status === 0 ? r.stdout : null);
      }
      return cache.get(p);
    },
    ignored(/** @type {string} */ p) {
      return spawnSync("git", ["-C", repo, "check-ignore", "-q", "--no-index", p]).status === 0;
    },
  };
}

function refExists(/** @type {string} */ repo, /** @type {string} */ ref) {
  return spawnSync("git", ["-C", repo, "rev-parse", "--verify", "-q", `${ref}^{commit}`]).status === 0;
}

function main(/** @type {string[]} */ argv) {
  const usage = "usage: anchors.mjs <topic> [--base <ref>] [--repo <dir>] [--plans <dir>]";
  const opts = { base: "", repo: "", plans: "plans" };
  let topic = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const flag = /^--(base|repo|plans)$/.exec(a);
    if (flag) {
      const v = argv[++i];
      if (!v) return die(usage);
      opts[flag[1]] = v;
    } else if (a.startsWith("-") || topic) return die(usage);
    else topic = a;
  }
  if (!topic) return die(usage);
  const repo =
    opts.repo ||
    spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim() ||
    process.cwd();
  const planFile = join(repo, opts.plans, `${topic}-plan.md`);
  if (!existsSync(planFile)) return die(`anchors: no ${opts.plans}/${topic}-plan.md in ${repo}`, 2);
  const historyFile = join(repo, opts.plans, `${topic}-history.md`);
  let ref = opts.base;
  if (!ref) ref = refExists(repo, "dev") ? "dev" : "origin/dev";
  else if (!refExists(repo, ref) && refExists(repo, `origin/${ref}`)) ref = `origin/${ref}`;
  if (!refExists(repo, ref)) return die(`anchors: no ${ref} in ${repo}`, 2);
  const planText = readFileSync(planFile, "utf8");
  const historyText = existsSync(historyFile) ? readFileSync(historyFile, "utf8") : "";
  const r = checkAnchors({ planText, historyText, base: gitBase(repo, ref) });
  const budget = planBudget(planText, { merged: mergedSlices([planText, historyText]) });
  for (const w of [...r.warnings, ...budget.warnings])
    process.stderr.write(`warning: slice ${w.slice}: ${w.text}\n`);
  if (budget.warnings.length) process.stderr.write(`(budget: ${budget.wavesFrom})\n`);
  for (const m of r.misses)
    process.stdout.write(
      m.kind === "path"
        ? `slice ${m.slice}: \`${m.path}\` is not on ${ref}\n`
        : `slice ${m.slice}: \`${m.symbol}\` is not in \`${m.path}\` on ${ref}\n`,
    );
  const slices = r.checked.length ? `slices ${r.checked.join(", ")}` : "no unmerged slices";
  process.stdout.write(
    r.misses.length
      ? `${r.misses.length} anchor(s) missing on ${ref} (${slices}): fix the plan before the first slice\n`
      : `anchors ok on ${ref} (${slices})\n`,
  );
  return 0;
}

function die(/** @type {string} */ msg, code = 2) {
  process.stderr.write(`${msg}\n`);
  return code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exitCode = main(process.argv.slice(2));
