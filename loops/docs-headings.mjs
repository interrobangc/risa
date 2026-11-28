// docs-headings.mjs: a project's role additions name the generic docs' ## headings
// (an additions section merges into the one it names) and continue the last
// section, so a release that adds, renames, removes or moves one says so. For each
// loops/docs/*.md, its ## headings and its last section's heading against the newest
// v* tag reachable from HEAD: each change needs a line under CHANGELOG.md's
// `## Unreleased` heading naming the doc's file (`loop.md`) and the heading. No tag
// (a shallow checkout, a new repo) passes. Run as a script it prints each change no
// line names and exits 1.
//   node loops/docs-headings.mjs
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { headingsOf } from "./doc.mjs";

const DOCS = "loops/docs";

/** @param {string} root @param {string[]} args */
const git = (root, ...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });

/**
 * The newest v* tag reachable from HEAD, or undefined.
 * @param {string} root
 */
export function latestTag(root) {
  const r = git(root, "tag", "-l", "v*", "--merged", "HEAD", "--sort=-v:refname");
  return r.status === 0 ? r.stdout.split("\n").find(Boolean) : undefined;
}

/**
 * A doc's ## headings and its last heading (any level).
 * @param {string} markdown
 */
const outline = (markdown) => {
  const heads = headingsOf(markdown.split("\n")).filter((h) => h !== undefined);
  return { sections: heads.filter((h) => h.level === 2).map((h) => h.text), last: heads.at(-1)?.text };
};

/** The items of a not in b's longest common subsequence with it. @param {string[]} a @param {string[]} b */
const outOfOrder = (a, b) => {
  const n = a.length;
  const m = b.length;
  const len = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      len[i][j] = a[i] === b[j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
  const kept = new Set();
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) {
      kept.add(a[i]);
      i++;
      j++;
    } else if (len[i + 1][j] >= len[i][j + 1]) i++;
    else j++;
  }
  return a.filter((h) => !kept.has(h));
};

/**
 * The heading changes between two versions of a doc: each with the headings a
 * CHANGELOG line may name for it (any one does) and what changed.
 * @param {string} before
 * @param {string} after
 * @returns {{ headings: string[], what: string }[]}
 */
export function headingDiff(before, after) {
  const a = outline(before);
  const b = outline(after);
  const changes = [];
  for (const h of a.sections)
    if (!b.sections.includes(h)) changes.push({ headings: [h], what: `"${h}" is gone` });
  for (const h of b.sections)
    if (!a.sections.includes(h)) changes.push({ headings: [h], what: `"${h}" is new` });
  const common = b.sections.filter((h) => a.sections.includes(h));
  const was = a.sections.filter((h) => b.sections.includes(h));
  for (const h of outOfOrder(common, was)) changes.push({ headings: [h], what: `"${h}" moved` });
  if (a.last !== undefined && b.last !== undefined && a.last !== b.last)
    changes.push({ headings: [b.last, a.last], what: `the last section is "${b.last}" (was "${a.last}")` });
  return changes;
}

/**
 * The lines under CHANGELOG.md's `## Unreleased` heading (none without one).
 * @param {string} root
 */
export function unreleasedLines(root) {
  const file = join(root, "CHANGELOG.md");
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n");
  const heads = headingsOf(lines);
  const start = heads.findIndex((h) => h?.level === 2 && /^unreleased$/i.test(h.text));
  if (start < 0) return [];
  const end = heads.findIndex((h, i) => i > start && h !== undefined && h.level <= 2);
  return lines.slice(start + 1, end < 0 ? undefined : end).filter((l) => l.trim());
}

/**
 * The heading changes since the newest tag that no unreleased CHANGELOG line names,
 * one line each; none without a tag.
 * @param {string} root the repo
 * @returns {string[]}
 */
export function unloggedHeadingChanges(root) {
  const tag = latestTag(root);
  if (!tag) return [];
  const tagged = git(root, "ls-tree", "--name-only", `${tag}:${DOCS}`);
  const now = existsSync(join(root, DOCS)) ? readdirSync(join(root, DOCS)) : [];
  const names = [...new Set([...(tagged.status === 0 ? tagged.stdout.split("\n") : []), ...now])]
    .filter((f) => f.endsWith(".md"))
    .sort();
  const logged = unreleasedLines(root);
  const out = [];
  for (const name of names) {
    const old = git(root, "show", `${tag}:${DOCS}/${name}`);
    const before = old.status === 0 ? old.stdout : "";
    const file = join(root, DOCS, name);
    const after = existsSync(file) ? readFileSync(file, "utf8") : "";
    for (const c of headingDiff(before, after)) {
      const named = logged.some((l) => l.includes(name) && c.headings.some((h) => l.includes(h)));
      if (!named)
        out.push(
          `${DOCS}/${name}: ${c.what} since ${tag}; no CHANGELOG.md line under "## Unreleased" names ${name} and "${c.headings[0]}"`,
        );
    }
  }
  return out;
}

const isMain = () => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const out = unloggedHeadingChanges(root);
  if (out.length) {
    for (const line of out) console.log(line);
    process.exit(1);
  }
  console.log("docs headings: every generic role doc's heading change since the last tag is in CHANGELOG.md");
}
