// Whether a changed package.json changed only its `scripts` field (B-572). Such
// a change forces neither a full check (check-plan.mjs) nor the browser lean set
// (check-areas.mjs). Anything this can't prove is scripts-only still forces them.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PACKAGE_JSON = /(^|\/)package\.json$/;

/** The manifest without `scripts`, as text, or null when it isn't a JSON object. */
function withoutScripts(text) {
  if (typeof text !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  delete parsed.scripts;
  // Text, not a deep compare: key order is meaningful (`exports` conditions).
  return JSON.stringify(parsed);
}

/**
 * Whether two versions of a package.json differ in `scripts` alone. Pure.
 * @param {string | null | undefined} base the text at the base (null: added)
 * @param {string | null | undefined} head the text at the head (null: deleted)
 * @returns {boolean} false for an added, deleted or unparseable file
 */
export function scriptsOnlyChange(base, head) {
  const before = withoutScripts(base);
  return before !== null && before === withoutScripts(head);
}

const atRef = (repo, ref, file) => {
  try {
    return execFileSync("git", ["-C", repo, "show", `${ref}:${file}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
};

const onDisk = (repo, file) => {
  try {
    return readFileSync(join(repo, file), "utf8");
  } catch {
    return null;
  }
};

/**
 * Both versions of each changed package.json.
 * @param {string[]} changed files changed against the base
 * @param {{ repo: string, base?: string, head?: string }} from no base reads
 *   nothing (so every package.json still forces); no head reads the working tree
 * @returns {Map<string, { base: string | null, head: string | null }>}
 */
export function readPackages(changed, { repo, base, head }) {
  const packages = new Map();
  if (!base) return packages;
  for (const file of changed)
    if (PACKAGE_JSON.test(file))
      packages.set(file, {
        base: atRef(repo, base, file),
        head: head ? atRef(repo, head, file) : onDisk(repo, file),
      });
  return packages;
}

/**
 * The package.json files among `packages` that changed only their scripts.
 * @param {Map<string, { base: string | null, head: string | null }>} packages
 * @returns {Set<string>}
 */
export const scriptsOnlyFiles = (packages) =>
  new Set([...packages].filter(([, v]) => scriptsOnlyChange(v.base, v.head)).map(([file]) => file));
