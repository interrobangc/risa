#!/usr/bin/env node
// pnpm prd doc <role> [section]: a role's doc as a session reads it.
//
// Each role (loop, orchestrator, planner, …) has one generic doc, the core's, in
// docs/<role>.md beside this file. A project changes it through its config's
// roles group: `roles.<role>.additions` (a file printed after the generic doc) or
// `roles.<role>.replacement` (a file printed instead of it). With a section, only
// that heading's text: the heading line through the line before the next heading
// of its level or higher, from the merged doc.
//
// Exit 2 on an unknown role or section, a named file that is missing, or a role
// that names both. Every prompt and core file names a role's doc through this
// command, never by its path.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig } from "./config.mjs";

/** The core's generic role docs. */
export const GENERIC_DIR = fileURLToPath(new URL("./docs", import.meta.url));

export class DocError extends Error {}

const read = (file, what) => {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") throw new DocError(`${what} is missing (${file})`);
    throw e;
  }
};

/**
 * The roles there are: the config's, and the core's generic docs.
 * @param {Record<string, any>} config
 * @param {string} [genericDir]
 */
export function knownRoles(config, genericDir = GENERIC_DIR) {
  let generic = [];
  try {
    generic = readdirSync(genericDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return [...new Set([...Object.keys(config.roles ?? {}), ...generic])].sort();
}

/**
 * The heading's text in a Markdown doc (ATX headings outside code fences), or
 * undefined when it has none. A fence closes only on its own marker (the same
 * character, at least as long, nothing after it); a heading's closing #s don't
 * count. The first heading with the text wins, at any level, and its section
 * runs to the next heading at that level or above.
 * @param {string} markdown
 * @param {string} heading the heading's text, without its #s
 */
export function sectionOf(markdown, heading) {
  const lines = markdown.split("\n");
  /** @type {string | undefined} the open fence's marker */
  let fence;
  /** @type {{ level: number, text: string } | undefined}[] */
  const heads = lines.map((l) => {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(l);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = undefined;
      return undefined;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (open) {
      fence = open[1];
      return undefined;
    }
    const m = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/.exec(l);
    if (!m) return undefined;
    const text = (m[2] ?? "").replace(/(^|\s+)#+$/, "").trim();
    return { level: m[1].length, text };
  });
  const start = heads.findIndex((h) => h?.text === heading.trim());
  if (start < 0) return undefined;
  const level = /** @type {{ level: number }} */ (heads[start]).level;
  const end = heads.findIndex((h, i) => i > start && h !== undefined && h.level <= level);
  return lines
    .slice(start, end < 0 ? undefined : end)
    .join("\n")
    .replace(/\n*$/, "\n");
}

/**
 * A role's doc: the generic one, then the additions; or the replacement alone.
 * @param {string} role
 * @param {{ config: Record<string, any>, root: string, section?: string, genericDir?: string }} opts
 */
export function roleDoc(role, { config, root, section, genericDir = GENERIC_DIR }) {
  const entry = config.roles?.[role] ?? {};
  if (entry.replacement && entry.additions)
    throw new DocError(`the ${role} role names both a replacement and additions; keep one`);
  const roles = knownRoles(config, genericDir);
  if (!roles.includes(role))
    throw new DocError(`no role "${role}" (the roles: ${roles.join(", ") || "none"})`);
  let text;
  if (entry.replacement) {
    text = read(join(root, entry.replacement), `the ${role} role's replacement, ${entry.replacement},`);
  } else {
    text = read(join(genericDir, `${role}.md`), `the ${role} role's generic doc`);
    if (entry.additions) {
      const additions = read(
        join(root, entry.additions),
        `the ${role} role's additions, ${entry.additions},`,
      );
      text = `${text.replace(/\n*$/, "\n")}\n${additions}`;
    }
  }
  if (!section) return text;
  const part = sectionOf(text, section);
  if (part === undefined) throw new DocError(`the ${role} doc has no section "${section}"`);
  return part;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [role, ...rest] = process.argv.slice(2);
  try {
    const { config, root } = loadConfig();
    if (!role || role === "help" || role === "--help") {
      process.stderr.write(
        `usage: prd doc <role> [section]\n  the roles: ${knownRoles(config).join(", ")}\n`,
      );
      process.exit(2);
    }
    process.stdout.write(roleDoc(role, { config, root, section: rest.join(" ") || undefined }));
  } catch (e) {
    if (!(e instanceof DocError || e instanceof ConfigError)) throw e;
    process.stderr.write(`prd doc: ${e instanceof ConfigError ? e.problems.join("; ") : e.message}\n`);
    process.exit(2);
  }
}
