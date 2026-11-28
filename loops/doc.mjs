#!/usr/bin/env node
// prd doc <role> [section]: a role's doc as a session reads it.
//
// Each role (loop, orchestrator, planner, …) has one generic doc, the core's, in
// docs/<role>.md beside this file. A project changes it through its config's
// roles group: `roles.<role>.additions` (a file merged into the generic doc) or
// `roles.<role>.replacement` (a file printed instead of it). An additions section
// whose ## heading is one of the generic doc's ## headings goes at the end of that
// section; the rest follow the generic doc's last line (mergeAdditions). One
// that opens with an HTML comment (`<!-- … -->`, a pointer for someone reading the
// file itself) has it left out. With a section, only that heading's text: the
// heading line through the line before the next heading of its level or higher,
// from the merged doc. The tool's own commands are `{{prd}}` and `{{backlog}}` in the
// generic docs, filled from the config's tool names (the additions may use them too).
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

/** An additions file's opening HTML comment, with the blank lines after it. */
const LEADING_COMMENT = /^<!--[\s\S]*?-->[ \t]*\n(\s*\n)*/;

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
 * Each line's ATX heading (level and text), or undefined for a line that is none:
 * fenced lines never are. A fence closes only on its own marker (the same
 * character, at least as long, nothing after it); a heading's closing #s don't count.
 * @param {string[]} lines
 * @returns {({ level: number, text: string } | undefined)[]}
 */
export function headingsOf(lines) {
  /** @type {string | undefined} the open fence's marker */
  let fence;
  return lines.map((l) => {
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
}

/**
 * A doc cut at its # and ## headings: the part before the first, then one part
 * per heading, each with its ## heading's text (none for a # part or the first).
 * @param {string} markdown
 * @returns {{ heading?: string, lines: string[] }[]}
 */
const partsOf = (markdown) => {
  const lines = markdown.split("\n");
  const heads = headingsOf(lines);
  /** @type {{ heading?: string, lines: string[] }[]} */
  const parts = [{ lines: [] }];
  lines.forEach((l, i) => {
    const h = heads[i];
    if (h && h.level <= 2) parts.push({ heading: h.level === 2 ? h.text : undefined, lines: [] });
    parts[parts.length - 1].lines.push(l);
  });
  return parts;
};

/**
 * The generic doc with the additions merged in: an additions ## section whose
 * heading is one of the generic doc's ## headings has its body put at the end of
 * that section; the rest (the part before any heading, the sections matching
 * none) follow the generic doc's last line, in their order.
 * @param {string} generic
 * @param {string} additions
 */
export function mergeAdditions(generic, additions) {
  const target = partsOf(generic);
  const byHeading = new Map();
  for (const p of target)
    if (p.heading !== undefined && !byHeading.has(p.heading)) byHeading.set(p.heading, p);
  /** @type {string[][]} */
  const rest = [];
  let merged = false;
  for (const part of partsOf(additions)) {
    const into = part.heading === undefined ? undefined : byHeading.get(part.heading);
    if (!into) {
      rest.push(part.lines);
      continue;
    }
    merged = true;
    const body = part.lines
      .slice(1)
      .join("\n")
      .replace(/^\s*\n/, "")
      .replace(/\s*$/, "");
    if (!body) continue;
    const text = into.lines.join("\n");
    const end = text.replace(/\n*$/, "");
    into.lines = `${end}\n\n${body}${text.slice(end.length)}`.split("\n");
  }
  const out = target
    .map((p) => p.lines)
    .flat()
    .join("\n");
  if (!merged) return `${generic.replace(/\n*$/, "\n")}\n${additions}`;
  const left = rest
    .flat()
    .join("\n")
    .replace(/^\s*\n/, "");
  return left.trim() ? `${out.replace(/\n*$/, "\n")}\n${left.replace(/\n*$/, "\n")}` : out;
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
  const heads = headingsOf(lines);
  const start = heads.findIndex((h) => h?.text === heading.trim());
  if (start < 0) return undefined;
  const level = /** @type {{ level: number }} */ (heads[start]).level;
  const end = heads.findIndex((h, i) => i > start && h !== undefined && h.level <= level);
  return lines
    .slice(start, end < 0 ? undefined : end)
    .join("\n")
    .replace(/\n*$/, "\n");
}

/** The generic docs' placeholders for the tool's own commands: `{{prd}}` and `{{backlog}}`. */
export const NAME_PLACEHOLDER = /\{\{(prd|backlog)\}\}/g;

/**
 * A doc with the config's command names (tool.prd, tool.backlog) in place of its placeholders;
 * a config without them leaves the placeholders.
 * @param {string} text
 * @param {Record<string, any>} config
 */
export const fillNames = (text, config) =>
  text.replace(NAME_PLACEHOLDER, (m, name) => config.tool?.[name] ?? m);

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
      text = mergeAdditions(text, additions.replace(LEADING_COMMENT, ""));
    }
  }
  text = fillNames(text, config);
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
