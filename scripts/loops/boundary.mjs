// The boundary lint: the line between the core (the tool that will move out of
// this repo) and the project (what stays). It works both ways:
//   project-env      a project variable (the project's NAME_ prefix) in a core file
//   project-name     the project's name in a core file
//   app-path         one of the project's own folders (the config's
//                    boundary.appPaths) in a core file
//   core-to-project  a core file reaching a project file
//   project-to-core  a project file, anywhere in the repo, reaching a core file
//   host-call        osascript or launchctl in a core file's code, or a run of
//                    claude, codex or gh (in JS the name as a whole string, not
//                    compared; in shell the name where a command starts, outside
//                    quotes and here-documents), other than the host layer's
//                    (HOST, host.mjs), the tests' and fixtures' (which stub them)
//                    and this lint's; and the same files naming Claude Code's own
//                    (its config folder, CLAUDE_CONFIG_DIR, .claude.json, the
//                    session settings files) or reading its hook and status line
//                    input's fields (transcript_path, rate_limits, …) in code
// The two reach rules see every form, and a finding names its form:
//   import    a JS import, dynamic import or require; a shell `source` or `.`
//   --import  a path handed to Node's --import
//   spawn     a path that is run: after node, bash, sh, exec or a spawn call, or
//             first on a shell command
//   path      any other path, in a string or in code
//
// Who owns what is the manifest (boundary.manifest, beside this file): every
// file under ROOTS, one `<path> <owner>` line each, sorted, owner `core` or
// `project`. Every other file in the repo is the project's. The move reads the
// manifest too (its `core` lines are what `git filter-repo` keeps).
//
// What is let through is the allowlist (boundary.allowlist): one
// `<path> <rule> <count>` line per file and rule, sorted, with an optional
// `# why` after it. The count is exact: more findings than it fails, and so do
// fewer (the line must shrink with the code), so the list only goes down. A slice
// edits only the lines of the files it changes.
//
// How it reads a file:
// - The two names rules read every character of a core file, comments too.
// - The path rules (app-path and the reach rules) read code and strings, not
//   comments. In a regular expression `\/` and `\.` read as `/` and `.`.
// - A path is resolved from the repo's root, from the file's own folder
//   (`./x`, `../ci/x`, `$here/x`, a bare `x.mjs`) and, for `loops/…`, `backlog/…`,
//   `ci/…` and `project/…`, from scripts/ (a test project's root). A folder or a
//   glob stands for every file under it: a project file naming one that holds any
//   core file reaches the core; a core file reaches the project only through a
//   folder or glob that holds nothing but project files (its own folder may hold
//   project files until they move out).
// - It can't see a path built from pieces (`join(here, "..", "ci")`), a bare name
//   with no extension (`"checks"`), or one inside a pattern's group
//   (`/^scripts\/(loops|ci)\//`).
// - A project file is read when it is code or config (not Markdown, not a plan).
//
//   node boundary.mjs           what the lint refuses; exit 1 on any
//   node boundary.mjs --all     every finding, allowed or not
//   node boundary.mjs --write   rewrite the allowlist's counts to what is found
//                               (to shrink it; a new line in it needs a reason)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";

/** The folders the manifest covers. */
export const ROOTS = ["scripts/loops", "scripts/backlog", "scripts/ci", "scripts/project", ".githooks"];
export const OWNERS = ["core", "project"];
export const RULES = [
  "app-path",
  "core-to-project",
  "host-call",
  "project-env",
  "project-name",
  "project-to-core",
];
export const FORMS = ["import", "--import", "spawn", "path"];

/** The lint's own data, which names both sides and is never read as code. */
export const MANIFEST = "scripts/loops/boundary.manifest";
export const ALLOWLIST = "scripts/loops/boundary.allowlist";
/** The host layer: the one core file that calls the machine's own commands. */
export const HOST = "scripts/loops/host.mjs";
/** The machine's commands only the host layer calls. */
const HOST_CALL = /(?<![\w.-])(?:osascript|launchctl)(?![\w.-])/g;
const SELF = "scripts/loops/boundary.mjs";
/** The CLIs only the host layer runs: in JS a whole string, not after a comparison. */
const CLI_JS = /(?<![=!]=\s*)(["'`])(claude|codex|gh)\1/g;
/** …in shell, the command a line, pipe, list, subshell or keyword starts. */
const CLI_SHELL =
  /(?:^|[;&|({!]|\b(?:then|do|else|elif|if|while|until|time|exec))\s*(claude|codex|gh)(?![\w.-])/g;
/** Claude Code's files and its hook input's fields: only the host layer names them, in code. */
const CLAUDE_FILES = new RegExp(
  String.raw`(?<![\w.-])(?:\.claude(?:\.json)?|CLAUDE_CONFIG_DIR|(?:context|inbox)-settings\.json)(?![\w-])` +
    String.raw`|(?<!\w)(?:hook_event_name|session_id|transcript_path|agent_transcript_path|agent_id|agent_type` +
    String.raw`|tool_name|tool_input|tool_use_id|rate_limits|used_percentage|resets_at|error_details` +
    String.raw`|five_hour|seven_day|spend_limit|used_usd|limit_usd)(?!\w)`,
  "g",
);
const callsHost = (/** @type {string} */ path) =>
  path !== HOST && path !== SELF && !/(\.test\.[a-z]+|-fixture\.mjs)$/.test(path);

const inRoots = (path) => ROOTS.some((root) => path.startsWith(`${root}/`));
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param {string} text the manifest
 * @returns {{ owners: Map<string, string>, problems: string[] }}
 */
export function parseManifest(text) {
  const owners = new Map();
  const problems = [];
  let last = "";
  text.split("\n").forEach((line, i) => {
    if (!line.trim() || line.startsWith("#")) return;
    const at = `${MANIFEST}:${i + 1}`;
    const [path, owner, ...rest] = line.split(" ");
    if (!path || !owner || rest.length || !OWNERS.includes(owner))
      return problems.push(`${at}: not \`<path> core|project\`: ${line}`);
    if (!inRoots(path)) problems.push(`${at}: ${path} is outside ${ROOTS.join(", ")}`);
    if (owners.has(path)) problems.push(`${at}: ${path} is listed twice`);
    else if (path < last) problems.push(`${at}: ${path} is out of order (sorted, one file a line)`);
    last = path;
    owners.set(path, owner);
  });
  return { owners, problems };
}

/**
 * The manifest against the files: every file under ROOTS has a line, and every line a file.
 * @param {Map<string, string>} owners
 * @param {string[]} files every file in the repo
 * @returns {string[]} problems
 */
export function manifestProblems(owners, files) {
  const have = new Set(files.filter(inRoots));
  return [
    ...[...have]
      .filter((f) => !owners.has(f))
      .map((f) => `${MANIFEST}: no line for ${f}: add \`${f} core\` or \`${f} project\``),
    ...[...owners.keys()]
      .filter((f) => !have.has(f))
      .map((f) => `${MANIFEST}: ${f} is no file: delete its line`),
  ].sort(byText);
}

/**
 * @param {string} text the allowlist
 * @returns {{ allowed: Map<string, { count: number, why: string }>, problems: string[] }} keyed `<path> <rule>`
 */
export function parseAllowlist(text) {
  const allowed = new Map();
  const problems = [];
  let last = "";
  text.split("\n").forEach((line, i) => {
    if (!line.trim() || line.startsWith("#")) return;
    const at = `${ALLOWLIST}:${i + 1}`;
    const m = /^(\S+) (\S+) (\d+)(?: # (.+))?$/.exec(line);
    if (!m || !RULES.includes(m[2]) || Number(m[3]) < 1)
      return problems.push(`${at}: not \`<path> <rule> <count>\` (rules: ${RULES.join(", ")}): ${line}`);
    const key = `${m[1]} ${m[2]}`;
    if (allowed.has(key)) problems.push(`${at}: ${key} is listed twice`);
    else if (key < last) problems.push(`${at}: ${key} is out of order (sorted by path, then rule)`);
    last = key;
    allowed.set(key, { count: Number(m[3]), why: m[4] ?? "" });
  });
  return { allowed, problems };
}

const JS = /\.(mjs|cjs|js|jsx|ts|tsx|mts|cts)$/;
const HASH = /\.(ya?ml|toml|txt|env)$/;
const READ = /\.(mjs|cjs|js|jsx|ts|tsx|mts|cts|sh|json|ya?ml|toml|txt)$/;

/**
 * How a file's comments are written: js, shell, hash (`#` lines) or none.
 * @param {string} path
 * @param {string} text
 */
export function language(path, text) {
  if (JS.test(path)) return "js";
  const bang = text.startsWith("#!") ? text.slice(0, text.indexOf("\n")) : "";
  if (/\.sh$/.test(path) || /\b(ba|z)?sh\b/.test(bang)) return "shell";
  if (/\bnode\b/.test(bang)) return "js";
  if (HASH.test(path) || !/\.[A-Za-z0-9]+$/.test(posix.basename(path))) return "hash";
  return "none";
}

/** Whether the lint reads this project file: code and config, not prose. */
export const readsProjectFile = (path) =>
  path !== "pnpm-lock.yaml" &&
  !/^(plans|docs|to-test)\//.test(path) &&
  (READ.test(path) || !/\.[A-Za-z0-9]+$/.test(posix.basename(path)));

/** A regex literal may start after one of these (else `/` divides). */
const BEFORE_REGEX = /(^|[(,=:[!&|?{};+\-*%<>~^]|\b(return|typeof|case|of|in|do|else|void|yield|await))\s*$/;

/** JS with its comments blanked (same length, same lines); strings and regexes kept. */
function jsCode(text) {
  const out = text.split("");
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  /** A stack of what encloses the position: "`" a template, a number the brace depth of a `${`. */
  const stack = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const top = stack[stack.length - 1];
    if (top === "`") {
      if (c === "\\") i += 2;
      else if (c === "`") {
        stack.pop();
        i++;
      } else if (c === "$" && text[i + 1] === "{") {
        stack.push(0);
        i += 2;
      } else i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      blank(i, end < 0 ? n : end);
      i = end < 0 ? n : end;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      blank(i, end < 0 ? n : end + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < n && text[i] !== c && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "`") {
      stack.push("`");
      i++;
    } else if (c === "/" && BEFORE_REGEX.test(text.slice(Math.max(0, i - 12), i))) {
      let k = i + 1;
      let inClass = false;
      while (k < n && text[k] !== "\n" && (inClass || text[k] !== "/")) {
        if (text[k] === "\\") k++;
        else if (text[k] === "[") inClass = true;
        else if (text[k] === "]") inClass = false;
        k++;
      }
      i = text[k] === "/" ? k + 1 : i + 1;
    } else {
      if (typeof top === "number") {
        if (c === "{") stack[stack.length - 1] = top + 1;
        else if (c === "}" && top === 0) stack.pop();
        else if (c === "}") stack[stack.length - 1] = top - 1;
      }
      i++;
    }
  }
  return out.join("");
}

/** Shell with its comments blanked; quotes and here-documents kept whole. */
function shellCode(text) {
  const lines = text.split("\n");
  /** @type {"" | "'" | '"'} */
  let quote = "";
  let heredoc = null;
  const pending = [];
  return lines
    .map((line) => {
      if (heredoc) {
        if ((heredoc.tabs ? line.replace(/^\t+/, "") : line) === heredoc.word)
          heredoc = pending.shift() ?? null;
        return line;
      }
      let out = "";
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote === "'") {
          if (c === "'") quote = "";
        } else if (c === "\\") {
          out += c + (line[i + 1] ?? "");
          i++;
          continue;
        } else if (quote === '"') {
          if (c === '"') quote = "";
        } else if (c === "'" || c === '"') quote = c;
        else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
          out += " ".repeat(line.length - i);
          break;
        } else if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<" && line[i - 1] !== "<") {
          const m = /^<<(-?)\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line.slice(i));
          // Unquoted, a here-document's word is in capitals here (`1 << n` is arithmetic).
          if (m && (m[2] || /^[A-Z_][A-Z0-9_]*$/.test(m[3])))
            pending.push({ tabs: m[1] === "-", word: m[3] });
        }
        out += c;
      }
      if (!quote && pending.length) heredoc = pending.shift();
      return out;
    })
    .join("\n");
}

/**
 * Shell as its commands read: comments, quoted text and here-documents blanked
 * (same length, same lines), a `$(…)` inside double quotes kept as code.
 * @param {string} text
 */
export function shellCommands(text) {
  /** @type {"" | "'" | '"'} */
  let quote = "";
  /** Each open `$(` inside double quotes: its depth of other parentheses. */
  const subs = [];
  let heredoc = null;
  const pending = [];
  return text
    .split("\n")
    .map((line) => {
      if (heredoc) {
        if ((heredoc.tabs ? line.replace(/^\t+/, "") : line) === heredoc.word)
          heredoc = pending.shift() ?? null;
        return " ".repeat(line.length);
      }
      let out = "";
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote === "'") {
          if (c === "'") quote = "";
          out += " ";
        } else if (c === "\\") {
          out += quote ? "  " : c + (line[i + 1] ?? "");
          i++;
        } else if (quote === '"') {
          if (c === "$" && line[i + 1] === "(") {
            subs.push(0);
            quote = "";
            out += "$(";
            i++;
          } else {
            if (c === '"') quote = "";
            out += " ";
          }
        } else if (c === "'" || c === '"') {
          quote = c;
          out += " ";
        } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
          out += " ".repeat(line.length - i);
          break;
        } else {
          if (subs.length && c === "(") subs[subs.length - 1]++;
          else if (subs.length && c === ")") {
            if (subs[subs.length - 1] === 0) {
              subs.pop();
              quote = '"';
              out += c;
              continue;
            }
            subs[subs.length - 1]--;
          } else if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<" && line[i - 1] !== "<") {
            const m = /^<<(-?)\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line.slice(i));
            if (m && (m[2] || /^[A-Z_][A-Z0-9_]*$/.test(m[3])))
              pending.push({ tabs: m[1] === "-", word: m[3] });
          }
          out += c;
        }
      }
      if (!quote && pending.length) heredoc = pending.shift();
      return out;
    })
    .join("\n");
}

/** `#` comments blanked: a `#` that starts a line or follows a space. */
const hashCode = (text) =>
  text
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, (m) => " ".repeat(m.length)))
    .join("\n");

/**
 * What the path rules read: the file with its comments blanked, line for line.
 * @param {string} path
 * @param {string} text
 */
export function codeOf(path, text) {
  const lang = language(path, text);
  return lang === "js"
    ? jsCode(text)
    : lang === "shell"
      ? shellCode(text)
      : lang === "hash"
        ? hashCode(text)
        : text;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A glob as a pattern: two stars and a slash are any folders (or none), two stars anything,
// one star anything but a slash.
const globRe = (glob) =>
  new RegExp(
    `^${glob
      .split(/(\*\*\/|\*\*|\*)/)
      .map((part) =>
        part === "**/" ? "(?:.*/)?" : part === "**" ? ".*" : part === "*" ? "[^/]*" : escapeRe(part),
      )
      .join("")}(/.*)?$`,
  );

/**
 * What a path stands for: the file itself, or every file under a folder or matching a glob.
 * @param {string[]} files every file the lint knows
 * @returns {(path: string) => { any: boolean, exact: boolean, hit: string[] }} for a path from the repo's root
 */
function reacher(files) {
  const names = new Set(files);
  const folders = new Set(
    files.flatMap((f) => f.split("/").map((_, i, parts) => parts.slice(0, i).join("/"))),
  );
  const seen = new Map();
  return (path) => {
    let got = seen.get(path);
    if (!got) {
      const hit = path.includes("*")
        ? files.filter((f) => globRe(path).test(f))
        : names.has(path)
          ? [path]
          : folders.has(path)
            ? files.filter((f) => f.startsWith(`${path}/`))
            : [];
      got = { any: hit.length > 0, exact: names.has(path), hit };
      seen.set(path, got);
    }
    return got;
  };
}

/** The paths a token may mean, from the repo's root. */
function candidates(token, file, before) {
  let t = token.replace(/\.+$/, "");
  // `$bin/x.sh`: the token starts at the variable's name.
  if (before === "$" && t.includes("/")) t = t.slice(t.indexOf("/"));
  const anchored = /^\.{0,2}\//.test(t);
  const rel = t.replace(/^(\.\/|\/)+/, "");
  if (!/[A-Za-z0-9]/.test(rel)) return [];
  const out = new Set();
  if (!rel.startsWith("../")) {
    out.add(rel);
    if (/^(loops|backlog|ci|project)\/./.test(rel)) out.add(`scripts/${rel}`);
  }
  // From the file's own folder: `./x`, `../x`, `$here/x`, `a/b` or a bare `x.mjs`; a glob only when anchored.
  if (anchored || (!rel.includes("*") && (rel.includes("/") || /\.[A-Za-z0-9]+$/.test(rel)))) {
    const joined = posix.normalize(posix.join(posix.dirname(file), rel));
    if (!joined.startsWith("..")) out.add(joined);
  }
  // A path must reach into a folder under scripts/ or a manifest root: the repo's root and
  // scripts/ themselves aren't anyone's file.
  return [...out]
    .map((p) => p.replace(/\/+$/, ""))
    .filter((p) => /^scripts\/[^/]/.test(p) || ROOTS.some((root) => p === root || p.startsWith(`${root}/`)));
}

const RUNNER = /\b(node|bash|sh|zsh|exec|spawn\w*|exec\w+|fork)\b[^;|]*$/;
const SHELL_FIRST = /(^|&&|\|\||[;|(`]|\b(then|do|else|if|while|time)\s|!\s)\s*(\w+=\S*\s+)*["']?\$?\{?$/;

/** The form of a reference, from what stands before it on its line. */
function formOf(before, lang) {
  if (/--import\b[^;|&]*$/.test(before)) return "--import";
  if (lang === "js" && /\b(from|import|require)\s*\(?\s*["'`]$/.test(before)) return "import";
  if (lang !== "js" && /^\s*(source|\.)\s/.test(before)) return "import";
  if (RUNNER.test(before) || (lang === "shell" && SHELL_FIRST.test(before))) return "spawn";
  return "path";
}

/**
 * @typedef {{ file: string, line: number, rule: string, form: string | null, text: string }} Finding
 */

/**
 * Every place the files cross the line.
 * @param {object} input
 * @param {Map<string, string>} input.files path → text, the files to read
 * @param {Map<string, string>} input.owners path → `core` or `project`, for every file a
 *   path may reach (the manifest's, and the project's other files under scripts/)
 * @param {{ names: string[], envPrefixes: string[], appPaths: string[] }} input.project
 * @param {string[]} [input.data] files that are data, not code: the path rules skip them
 * @returns {Finding[]} sorted by file, line and rule
 */
export function findings({ files, owners, project, data = [] }) {
  const reach = reacher([...owners.keys()]);
  const ownerOf = (path) => owners.get(path) ?? "project";
  const envRe = project.envPrefixes.length
    ? new RegExp(`(?<![A-Za-z0-9])(?:${project.envPrefixes.map(escapeRe).join("|")})[A-Z0-9_]*`, "g")
    : null;
  const nameRe = project.names.length
    ? new RegExp(`[\\w@./-]*(?:${project.names.map(escapeRe).join("|")})[\\w./-]*`, "gi")
    : null;
  const appRe = project.appPaths.length
    ? new RegExp(`(?<![\\w.-])(?:${project.appPaths.map(escapeRe).join("|")})/[\\w.@*/-]*`, "g")
    : null;
  /** @type {Finding[]} */
  const out = [];
  for (const [file, text] of files) {
    if (file === MANIFEST || file === ALLOWLIST) continue;
    const core = ownerOf(file) === "core";
    const paths = !data.includes(file);
    const lang = language(file, text);
    const raw = text.split("\n");
    const code = codeOf(file, text).split("\n");
    const runs = core && callsHost(file) ? cliRuns(lang, text, code) : [];
    for (let i = 0; i < raw.length; i++) {
      const add = (rule, form, found) => out.push({ file, line: i + 1, rule, form, text: found });
      if (core) {
        let rest = raw[i];
        if (envRe)
          rest = rest.replace(envRe, (m) => {
            add("project-env", null, m);
            return " ".repeat(m.length);
          });
        if (nameRe) for (const m of rest.matchAll(nameRe)) add("project-name", null, m[0]);
      }
      if (!paths) continue;
      const line = (code[i] ?? "").replace(/\\([/.-])/g, "$1");
      if (core && appRe)
        for (const m of line.matchAll(appRe)) add("app-path", null, m[0].replace(/\/+$/, "/"));
      if (core && callsHost(file)) for (const m of line.matchAll(HOST_CALL)) add("host-call", null, m[0]);
      if (core && callsHost(file) && (lang === "js" || lang === "shell"))
        for (const m of line.matchAll(CLAUDE_FILES)) add("host-call", null, m[0]);
      for (const cli of runs[i] ?? []) add("host-call", null, cli);
      for (const m of line.matchAll(/[\w.*\-/]+/g)) {
        const before = line.slice(0, m.index);
        const reached = candidates(m[0], file, before.slice(-1)).filter((path) => {
          const { any, exact, hit } = reach(path);
          if (!any) return false;
          const sides = new Set(hit.map(ownerOf));
          // A folder or glob: the core reaches the project only when all of it is the project's.
          if (core) return exact ? sides.has("project") : !sides.has("core");
          return sides.has("core");
        });
        if (reached.length && !reached.includes(file))
          add(core ? "core-to-project" : "project-to-core", formOf(before, lang), reached[0]);
      }
    }
  }
  return out.sort((a, b) => byText(a.file, b.file) || a.line - b.line || byText(a.rule, b.rule));
}

/**
 * The CLIs each line runs (the host-call rule's claude, codex and gh), by line.
 * @param {string} lang
 * @param {string} text
 * @param {string[]} code the lines with comments blanked
 * @returns {string[][]}
 */
function cliRuns(lang, text, code) {
  if (lang === "js") return code.map((l) => [...l.matchAll(CLI_JS)].map((m) => m[2]));
  if (lang === "shell")
    return shellCommands(text)
      .split("\n")
      .map((l) => [...l.matchAll(CLI_SHELL)].map((m) => m[1]));
  return [];
}

/** A finding as one line: file, line, rule, form, and what was found. */
export const findingLine = (f) => `${f.file}:${f.line}: ${f.rule}${f.form ? ` (${f.form})` : ""}: ${f.text}`;

/**
 * The findings against the allowlist.
 * @param {Finding[]} found
 * @param {Map<string, { count: number, why: string }>} allowed
 * @returns {string[]} what fails, one line each; none when the lint passes
 */
export function refused(found, allowed) {
  const groups = new Map();
  for (const f of found) {
    const key = `${f.file} ${f.rule}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const out = [];
  for (const key of [...new Set([...groups.keys(), ...allowed.keys()])].sort(byText)) {
    const have = groups.get(key) ?? [];
    const may = allowed.get(key)?.count ?? 0;
    if (have.length > may) {
      out.push(
        may
          ? `${key}: ${have.length} found, the allowlist has ${may}: one is new (take it out, don't raise the count)`
          : `${key}: ${have.length} found, none allowed`,
        ...have.map((f) => `  ${findingLine(f)}`),
      );
    } else if (have.length < may)
      out.push(
        `${key}: ${have.length} found, the allowlist has ${may}: ` +
          (have.length ? `lower its count to ${have.length}` : "delete its line") +
          ` in ${ALLOWLIST}`,
      );
  }
  return out;
}

/**
 * The allowlist's text for these findings: its leading comment and each line's `# why` kept.
 * @param {Finding[]} found
 * @param {string} old the allowlist now
 */
export function allowlistText(found, old) {
  const head = [];
  for (const line of old.split("\n")) {
    if (!line.startsWith("#")) break;
    head.push(line);
  }
  const { allowed } = parseAllowlist(old);
  const counts = new Map();
  for (const f of found) counts.set(`${f.file} ${f.rule}`, (counts.get(`${f.file} ${f.rule}`) ?? 0) + 1);
  const lines = [...counts.keys()].sort(byText).map((key) => {
    const why = allowed.get(key)?.why;
    return `${key} ${counts.get(key)}${why ? ` # ${why}` : ""}`;
  });
  return [...head, ...lines, ""].join("\n");
}

/**
 * The lint on a checkout: its files, manifest, allowlist and config.
 * @param {string} root the checkout
 * @returns {{ found: Finding[], problems: string[], failures: string[], allowlist: string }}
 */
export function lintRepo(root) {
  const listed = spawnSync(
    "git",
    ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (listed.status !== 0) throw new Error(`boundary: can't list the files in ${root}: ${listed.stderr}`);
  const all = listed.stdout.split("\0").filter((f) => f && existsSync(join(root, f)));
  const read = (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : "");
  const manifest = parseManifest(read(MANIFEST));
  const allowlist = read(ALLOWLIST);
  const { allowed, problems: listProblems } = parseAllowlist(allowlist);
  const owners = new Map(manifest.owners);
  for (const f of all) if (f.startsWith("scripts/") && !owners.has(f)) owners.set(f, "project");
  const files = new Map();
  for (const f of all) {
    const core = manifest.owners.get(f) === "core";
    if (!core && !readsProjectFile(f)) continue;
    const text = read(f);
    // A project file that names no tooling folder can't reach the core.
    if (core || /(loops|backlog|ci|project|githooks)\b/.test(text)) files.set(f, text);
  }
  const { config } = loadConfig({ path: join(root, "risa.json") });
  const found = findings({
    files,
    owners,
    project: {
      names: [config.name],
      envPrefixes: [`${config.name.toUpperCase().replace(/-/g, "_")}_`],
      appPaths: config.boundary?.appPaths ?? [],
    },
    // CI's two lists name flaky tests, core ones too, and change on the trunk at any time; at
    // the move those lines leave with the tests.
    data: [config.paths?.brakeList, config.paths?.quarantine].filter(Boolean),
  });
  const gone = [...allowed.keys()]
    .filter((key) => !all.includes(key.split(" ")[0]))
    .map((key) => `${ALLOWLIST}: ${key.split(" ")[0]} is no file: delete its line`);
  const problems = [
    ...manifest.problems,
    ...manifestProblems(manifest.owners, all),
    ...listProblems,
    ...gone,
  ];
  return { found, problems, failures: [...problems, ...refused(found, allowed)], allowlist };
}

const isMain = () => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  const flag = process.argv[2];
  if (process.argv.length > 3 || ![undefined, "--all", "--write"].includes(flag)) {
    console.error("usage: boundary.mjs [--all | --write]");
    process.exit(2);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const { found, failures, allowlist } = lintRepo(root);
  if (flag === "--all") console.log(found.map(findingLine).join("\n"));
  else if (flag === "--write") {
    writeFileSync(join(root, ALLOWLIST), allowlistText(found, allowlist));
    console.log(`boundary: ${ALLOWLIST} rewritten (${found.length} findings)`);
  } else {
    if (failures.length) console.log(failures.join("\n"));
    console.log(failures.length ? "boundary: the line is crossed" : `boundary: ok (${found.length} allowed)`);
    process.exit(failures.length ? 1 : 0);
  }
}
