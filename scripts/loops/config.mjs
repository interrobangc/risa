// The project config: risa.json at the root of the repo the tooling works on.
// Everything a repo tells the tooling about itself is in that one file: its name,
// what the tool's commands are called, its paths, branches, commands and hooks.
// This module is the only code that knows where the file lives. Node code calls
// loadConfig(); bash reads it through lib.sh's config_get, which runs `dump`
// here once per process and answers every later question from that copy.
//
//   node config.mjs get <key>   one value (a list: one item per line). Exit 1 when
//                               the key is optional and not set, 2 on a key the
//                               shape doesn't have or a config that doesn't load.
//   node config.mjs dump        every set value, one `key=value` line each (a
//                               list: key.0, key.1, …), for lib.sh
//   node config.mjs check       loads it; prints each problem; exit 2 on any
//
// Where it lives: RISA_CONFIG (a path; tests and sample projects set it), else
// risa.json at the root of the checkout this file is in.
//
// The shape is SHAPE below, one line per key, so two slices never edit the same
// line. A key ending in `?` is optional: the slice that builds what reads it
// sets it in risa.json. An unknown key is an error, so a typo can't hide.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The file's name, here and nowhere else. */
export const CONFIG_NAME = "risa.json";

/** An id prefix (B, RISA, R2): the loader's type and backlogIds both test it with this. */
const ID_PREFIX = /^[A-Z][A-Z0-9]*$/;

/** @param {unknown} v */
const oneLine = (v) => typeof v === "string" && /^\S(.*\S)?$/.test(v) && !/[\n\r\t]/.test(v);

/**
 * The value types: what each accepts, as a test and the words an error uses.
 * @type {Record<string, { ok: (v: unknown) => boolean, want: string }>}
 */
const TYPES = {
  slug: {
    ok: (v) => typeof v === "string" && /^[a-z][a-z0-9-]*$/.test(v),
    want: "a lowercase name (letters, digits and hyphens)",
  },
  text: { ok: oneLine, want: "one line of text" },
  command: { ok: oneLine, want: "a command (one line)" },
  path: {
    ok: (v) =>
      typeof v === "string" &&
      v !== "" &&
      !/[\s\\]/.test(v) &&
      v.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    want: "a path from the repo's root (no leading or trailing slash, no `.` or `..`)",
  },
  branch: {
    ok: (v) => typeof v === "string" && /^[A-Za-z0-9][\w.-]*(\/[\w.-]+)*$/.test(v),
    want: "a branch name",
  },
  prefix: {
    ok: (v) => typeof v === "string" && /^[a-z][a-z0-9-]*\/$/.test(v),
    want: "a branch prefix ending in a slash",
  },
  heading: {
    ok: (v) => oneLine(v) && /^#+ \S/.test(String(v)),
    want: "a Markdown heading (`## …`)",
  },
  item: {
    ok: (v) => typeof v === "string" && /^[^-]+-\d+$/.test(v) && ID_PREFIX.test(v.split("-")[0] ?? ""),
    want: "a backlog id (B-12)",
  },
  idPrefix: {
    ok: (v) => typeof v === "string" && ID_PREFIX.test(v),
    want: "an id prefix (capitals: B, RISA)",
  },
  flag: { ok: (v) => typeof v === "boolean", want: "true or false" },
  version: {
    ok: (v) => typeof v === "string" && /^\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(v),
    want: "a version (1.2.3)",
  },
};

/**
 * The whole shape: a key, then its type. `?` after the type: optional. `[]`: a list
 * of that type, not empty, no repeats. `*` in a key: any lowercase name (a role).
 * Keep it one line per key, in the order risa.json lists them.
 * @type {[string, string][]}
 */
export const SHAPE = [
  // The project's name. The names shared between worktrees are built from it.
  ["name", "slug"],
  // The Risa version this repo expects (set at the move).
  ["risaVersion", "version?"],
  // What the tool's own commands are called here.
  ["tool.prd", "command"],
  ["tool.backlog", "command"],
  // True only in the tool's own repo: its work switch is off by default (machine.mjs).
  ["tool.self", "flag?"],
  // Paths, from the repo's root.
  ["paths.backlog", "path"],
  ["paths.inbox", "path"],
  ["paths.archive", "path"],
  ["paths.plans", "path"],
  ["paths.docs", "path"],
  ["paths.agentsDoc", "path"],
  ["paths.preferences", "path?"],
  // The project's own prompt golden: the core's prompt test renders every prompt on this
  // config and holds it to that file.
  ["paths.promptGolden", "path?"],
  ["paths.browserChecks", "path?"],
  ["paths.checksManifest", "path?"],
  ["paths.checkAreas", "path?"],
  ["paths.brakeList", "path?"],
  ["paths.quarantine", "path?"],
  ["paths.tierData", "path?"],
  ["paths.checkPlanRules", "path?"],
  // The project's tooling files and folders: a change only to these, Markdown and the tool's own
  // folders needs no check.
  ["paths.tooling", "path[]"],
  // A role's doc: additions read after the generic doc, or a replacement of it.
  ["roles.*.additions", "path?"],
  ["roles.*.replacement", "path?"],
  // Branches.
  ["branches.trunk", "branch"],
  ["branches.protected", "branch[]"],
  ["branches.prefixes.prd", "prefix"],
  ["branches.prefixes.slice", "prefix"],
  ["branches.prefixes.plan", "prefix"],
  ["branches.prefixes.hotfix", "prefix"],
  // The backlog file's own facts.
  ["backlog.prdsHeading", "heading"],
  // Backlog ids are <idPrefix>-<n> (B-12); backlogIds below builds the rest from it.
  ["backlog.idPrefix", "idPrefix"],
  // A prefix the project's ids had before (B, for items moved in from another project): a lookup
  // reads B-772 as RISA-772; new ids, headings and tags keep idPrefix.
  ["backlog.formerIdPrefix", "idPrefix?"],
  ["backlog.zoneOverflowItem", "item?"],
  // The topic CI files its failures under (the release tier's and dev's, ci blame and zone-file).
  ["backlog.ciFailureTopic", "slug?"],
  // The project's commands that the tool runs.
  ["commands.install", "command"],
  ["commands.check", "command"],
  ["commands.quickCheck", "command?"],
  ["commands.projectTests", "command?"],
  ["commands.typecheck", "command"],
  ["commands.typegen", "command"],
  // Commands the prompts name: the tooling tests (else the check), the log (else git's) and
  // the docs' size budget (else none).
  ["commands.toolingTests", "command?"],
  ["commands.log", "command?"],
  ["commands.docBudget", "command?"],
  // Formats the files named after it in place; the slice prompt has a slice run it on its
  // changed files before a check (none: no such line).
  ["commands.format", "command?"],
  ["commands.datastoreStart", "command"],
  ["commands.datastoreReset", "command"],
  ["commands.datastoreSeed", "command"],
  // Turns on the repo's git hooks in a new worktree (none: the tool sets no hooks).
  ["commands.hooksInstall", "command?"],
  // The env file a stack keeps the dev server's port in (WEB_PORT), which the slice prompt names.
  ["stack.portEnv", "path?"],
  // The test projects the tool's own test runner names.
  ["testProjects.tooling", "text[]?"],
  ["testProjects.browserHarness", "text?"],
  // The project's scripts that the tool calls.
  ["hooks.check", "command?"],
  ["hooks.stackUp", "command?"],
  ["hooks.stackDown", "command?"],
  ["hooks.stackStatus", "command?"],
  ["hooks.stackReady", "command?"],
  ["hooks.stackStop", "command?"],
  ["hooks.stackStart", "command?"],
  ["hooks.stackEngine", "command?"],
  ["hooks.stackLeftovers", "command?"],
  ["hooks.serve", "command?"],
  ["hooks.testDb", "command?"],
  ["hooks.lease", "command?"],
  ["hooks.browser", "command?"],
  ["hooks.checkAreas", "command?"],
  ["hooks.docBudget", "command?"],
  // How to try a landing and what the main checkout needs after one (ready.sh, land.sh).
  ["hooks.landing", "command?"],
  // The Claude Code config folder this project's sessions use (absolute, or ~/…; none: Claude
  // Code's default). RISA_CLAUDE_CONFIG_DIR and the machine config come first (host.mjs).
  ["claude.configDir", "text?"],
  // The boundary lint: the project's own folders, which no core file may name.
  ["boundary.appPaths", "path[]?"],
];

/** A problem with the config: `problems` has one line per field. */
export class ConfigError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(problems.join("\n"));
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/** @param {unknown} v */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** @param {string} spec a SHAPE type */
const parseType = (spec) => {
  const optional = spec.endsWith("?");
  const bare = optional ? spec.slice(0, -1) : spec;
  const list = bare.endsWith("[]");
  return { optional, list, type: TYPES[list ? bare.slice(0, -2) : bare] };
};

/** Whether the key's parts are the first parts of the shape's pattern (`*`: any name). */
const partsMatch = (want, have) =>
  have.every((part, i) => (want[i] === "*" ? TYPES.slug.ok(part) : want[i] === part));

/** The shape's line for a key (a.b.c), or undefined. */
const shapeOf = (key) => {
  const have = key.split(".");
  return SHAPE.find(
    ([pattern]) => pattern.split(".").length === have.length && partsMatch(pattern.split("."), have),
  );
};

/** Whether some shape key lies under this one (so it is a group, not a value). */
const isGroup = (key) => {
  const have = key.split(".");
  return SHAPE.some(
    ([pattern]) => pattern.split(".").length > have.length && partsMatch(pattern.split("."), have),
  );
};

/**
 * Every value in the parsed file as [key, value], groups walked, lists kept whole.
 * @param {unknown} raw
 * @param {string} [prefix]
 * @returns {[string, unknown][]}
 */
function leaves(raw, prefix = "") {
  if (!isObject(raw)) return [[prefix, raw]];
  return Object.entries(/** @type {Record<string, unknown>} */ (raw)).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return isObject(v) && isGroup(key) ? leaves(v, key) : [[key, v]];
  });
}

/**
 * The problems with a parsed config, one line per field; none when it is valid.
 * @param {unknown} raw what JSON.parse gave
 * @returns {string[]}
 */
export function configProblems(raw) {
  if (!isObject(raw)) return ["the file must hold one JSON object"];
  /** @type {string[]} */
  const problems = [];
  const found = leaves(raw);
  const has = new Map(found);
  for (const [key, value] of found) {
    const line = shapeOf(key);
    if (!line) {
      problems.push(isGroup(key) ? `${key}: must be a group of keys` : `${key}: unknown key`);
      continue;
    }
    const { list, type } = parseType(line[1]);
    if (list) {
      if (!Array.isArray(value) || value.length === 0)
        problems.push(`${key}: must be a list of at least one: ${type.want}`);
      else {
        value.forEach((v, i) => {
          if (!type.ok(v)) problems.push(`${key}.${i}: must be ${type.want}`);
        });
        if (new Set(value).size !== value.length) problems.push(`${key}: lists a value twice`);
      }
    } else if (!type.ok(value)) problems.push(`${key}: must be ${type.want}`);
  }
  for (const [pattern, spec] of SHAPE)
    if (!parseType(spec).optional && !pattern.includes("*") && !has.has(pattern))
      problems.push(`${pattern}: missing`);
  // A role has additions or a replacement, never both.
  for (const [key] of found) {
    const role = /^roles\.([^.]+)\.additions$/.exec(key)?.[1];
    if (role && has.has(`roles.${role}.replacement`))
      problems.push(`roles.${role}: give additions or a replacement, not both`);
  }
  const trunk = has.get("branches.trunk");
  const guarded = has.get("branches.protected");
  if (Array.isArray(guarded) && guarded.includes(trunk))
    problems.push("branches.protected: must not list the trunk");
  const idPrefix = has.get("backlog.idPrefix");
  if (has.has("backlog.formerIdPrefix") && has.get("backlog.formerIdPrefix") === idPrefix)
    problems.push("backlog.formerIdPrefix: must differ from backlog.idPrefix");
  const prefixes = found.filter(([key]) => key.startsWith("branches.prefixes.")).map(([, v]) => v);
  if (new Set(prefixes).size !== prefixes.length)
    problems.push("branches.prefixes: two kinds share a prefix");
  return problems;
}

/**
 * Where the config is: RISA_CONFIG, else risa.json at the root of this checkout.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function configPath(env = process.env) {
  if (env.RISA_CONFIG) return resolve(env.RISA_CONFIG);
  return join(dirname(fileURLToPath(import.meta.url)), "../..", CONFIG_NAME);
}

/**
 * The config, checked. Throws a ConfigError naming every missing or wrong field.
 * @param {{ path?: string, env?: Record<string, string | undefined> }} [opts]
 * @returns {{ config: Record<string, any>, path: string, root: string }} the values,
 *   the file, and the repo root its paths start from
 */
export function loadConfig({ path, env = process.env } = {}) {
  const file = path ?? configPath(env);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new ConfigError([`${file}: no project config (${CONFIG_NAME}) there`]);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError([`${file}: not JSON (${e instanceof Error ? e.message : e})`]);
  }
  const problems = configProblems(raw);
  if (problems.length) throw new ConfigError(problems.map((p) => `${file}: ${p}`));
  return { config: raw, path: file, root: dirname(file) };
}

/**
 * loadConfig for a command: a config that doesn't load prints one `<who>: …` line
 * (every problem on it) and exits 2, never a Node stack at import.
 * @param {string} who the command's name, first on the line (backlog)
 * @param {{ path?: string, env?: Record<string, string | undefined> }} [opts]
 */
export function loadConfigOrExit(who, opts) {
  try {
    return loadConfig(opts);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    process.stderr.write(`${who}: ${e.problems.join("; ")}\n`);
    process.exit(2);
  }
}

/**
 * The command Node was started on, by its file's name (open-session for
 * open-session.mjs), else FALLBACK: a module that loads the config at import
 * names its importer, not itself, on a broken config.
 * @param {string} fallback
 */
export const commandName = (fallback) =>
  (process.argv[1] ?? "")
    .split("/")
    .pop()
    ?.replace(/\.[cm]?js$/, "") || fallback;

/**
 * Every set value as `key=value` lines' pairs: a list gives key.0, key.1, ….
 * @param {Record<string, any>} config a valid config
 * @returns {[string, string][]}
 */
export function flatten(config) {
  return leaves(config).flatMap(([key, value]) =>
    Array.isArray(value) ? value.map((v, i) => [`${key}.${i}`, String(v)]) : [[key, String(value)]],
  );
}

/**
 * One key's value.
 * @param {Record<string, any>} config a valid config
 * @param {string} key a.b.c
 * @returns {{ known: boolean, value?: string | string[] }} `known` false: the shape
 *   has no such key; no `value`: optional and not set
 */
export function getValue(config, key) {
  if (!shapeOf(key)) return { known: false };
  let at = config;
  for (const part of key.split(".")) at = isObject(at) ? at[part] : undefined;
  if (at === undefined) return { known: true };
  return { known: true, value: Array.isArray(at) ? at.map(String) : String(at) };
}

/**
 * The backlog's ids, from the config's prefix: `<prefix>-<n>` (B-12, RISA-772).
 * The one place that knows their form; the backlog tools build every id, heading,
 * tag and lookup from it. With a former prefix (backlog.formerIdPrefix), a lookup
 * reads a former id as its own (B-772 is RISA-772); nothing new is made with it.
 * Throws a ConfigError on a prefix the loader would refuse.
 * @param {Record<string, any>} [config] a valid config (default: this repo's)
 */
export function backlogIds(config = loadConfig().config) {
  const { idPrefix, formerIdPrefix } = config.backlog ?? {};
  for (const [key, value] of [
    ["idPrefix", idPrefix],
    ["formerIdPrefix", formerIdPrefix],
  ])
    if ((key === "idPrefix" || value !== undefined) && !TYPES.idPrefix.ok(value))
      throw new ConfigError([`backlog.${key}: must be ${TYPES.idPrefix.want}`]);
  const prefix = `${idPrefix}-`;
  /** A regular expression's source for one id (the prefix is capitals and digits, nothing to escape). */
  const pattern = `${prefix}\\d+`;
  const whole = new RegExp(`^${pattern}$`, "i");
  /** An id with the former prefix (B-772 for RISA), any case; never when there is none. */
  const former = formerIdPrefix ? new RegExp(`^${formerIdPrefix}-(\\d+)$`, "i") : null;
  /** "12", "b-12" → "B-12"; a former id → this prefix's; anything else upper-cased. @param {string} s */
  const normalize = (s) => {
    if (/^\d+$/.test(s)) return `${prefix}${s}`;
    const old = former?.exec(s);
    return old ? `${prefix}${old[1]}` : s.toUpperCase();
  };
  return {
    /** "B-" */
    prefix,
    pattern,
    /** The former prefix's "B-", or null. */
    formerPrefix: formerIdPrefix ? `${formerIdPrefix}-` : null,
    /** A pattern's source that also finds former ids, for a lookup in text (normalize what it finds). */
    lookupPattern: formerIdPrefix ? `(?:${idPrefix}|${formerIdPrefix})-\\d+` : pattern,
    /** Whether `s` is an id, in any case ("b-12" too), or a former one. @param {string} s */
    is: (s) => whole.test(s) || !!former?.test(s),
    /** @param {number} n */
    id: (n) => `${prefix}${n}`,
    /** The id's number (a former id's too). @param {string} id */
    num: (id) => Number(normalize(id).slice(prefix.length)),
    normalize,
  };
}

/** The branch kinds, in the order a branch is matched against their prefixes. */
export const BRANCH_KINDS = /** @type {const} */ (["prd", "slice", "plan", "hotfix"]);

/** @type {Map<string, ReturnType<typeof makeBranches>>} this repo's (or RISA_CONFIG's), once per file */
const branchCache = new Map();

/**
 * The branches' forms, from the config's trunk and prefixes: the one place in Node
 * that knows them (lib.sh's prd_prefix and the rest in bash). `prd/x`, `slice/x/2`,
 * `plan/x` and `hotfix/x` here; another project's prefixes give its own.
 * @param {Record<string, any>} [config] a valid config (default: this repo's, read once)
 */
export function branchKinds(config) {
  if (config) return makeBranches(config);
  const path = configPath();
  let made = branchCache.get(path);
  if (!made) branchCache.set(path, (made = makeBranches(loadConfig({ path }).config)));
  return made;
}

/** @param {Record<string, any>} config */
function makeBranches(config) {
  /** @type {Record<(typeof BRANCH_KINDS)[number], string>} */
  const prefixes = config.branches.prefixes;
  const trunk = /** @type {string} */ (config.branches.trunk);
  /** The branch's kind by its prefix, else null. @param {string | null | undefined} branch */
  const kindOf = (branch) => BRANCH_KINDS.find((k) => (branch ?? "").startsWith(prefixes[k])) ?? null;
  /** What follows the kind's prefix, or null when the branch isn't that kind. */
  const rest = (
    /** @type {string | null | undefined} */ branch,
    /** @type {(typeof BRANCH_KINDS)[number]} */ kind,
  ) => ((branch ?? "").startsWith(prefixes[kind]) ? (branch ?? "").slice(prefixes[kind].length) : null);
  /** A slice branch (<slice prefix><topic>/<n>) → { topic, n }, else null. @param {string | null | undefined} branch */
  const sliceOf = (branch) => {
    const m = /^([^/]+)\/([^/]+)$/.exec(rest(branch, "slice") ?? "");
    return m ? { topic: m[1], n: m[2] } : null;
  };
  return {
    trunk,
    prefixes,
    kindOf,
    /** Whether the branch has the kind's prefix. @param {string | null | undefined} branch @param {(typeof BRANCH_KINDS)[number]} kind */
    is: (branch, kind) => rest(branch, kind) !== null,
    /** The branch of a kind: branch("prd", "x") → "prd/x"; branch("slice", "x", 2) → "slice/x/2". */
    branch: (
      /** @type {(typeof BRANCH_KINDS)[number]} */ kind,
      /** @type {string} */ topic,
      /** @type {string | number} [n] */ n,
    ) => `${prefixes[kind]}${topic}${n === undefined ? "" : `/${n}`}`,
    /** The name after a kind's prefix (prd/x, plan/x, hotfix/x → x), else null. */
    nameOf: rest,
    sliceOf,
    /** The topic of any kind's branch (its first part after the prefix), else "". @param {string | null | undefined} branch */
    topicOf: (branch) => {
      const kind = kindOf(branch);
      return kind ? (/** @type {string} */ (rest(branch, kind)).split("/")[0] ?? "") : "";
    },
    /** lib.sh's parent_of: a slice → its PRD branch, anything else → the trunk. @param {string} branch */
    parentOf: (branch) => {
      const s = sliceOf(branch);
      return s ? `${prefixes.prd}${s.topic}` : trunk;
    },
    /** The trunk and the protected branches: never removed, never landed on by hand. */
    kept: [trunk, .../** @type {string[]} */ (config.branches.protected)],
  };
}

/**
 * What the tool's own commands are called in this repo (`pnpm prd` and `pnpm backlog`
 * here, `risa …` after the move): every prompt, hint and help line names them through
 * this (lib.sh's tool_command in bash).
 * @param {Record<string, any>} [config] a valid config (default: this repo's)
 * @returns {{ prd: string, backlog: string }}
 */
export function toolCommands(config = loadConfig().config) {
  return { prd: config.tool.prd, backlog: config.tool.backlog };
}

/** Whether this file is the script Node was started on (through any symlink). */
const isMain = () => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  const [verb, key] = process.argv.slice(2);
  if (!["get", "dump", "check"].includes(verb ?? "") || (verb === "get") !== (key !== undefined)) {
    console.error("usage: config.mjs get <key> | dump | check");
    process.exit(2);
  }
  let loaded;
  try {
    loaded = loadConfig();
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(e.message);
    process.exit(2);
  }
  if (verb === "dump") {
    for (const [k, v] of flatten(loaded.config)) console.log(`${k}=${v}`);
  } else if (verb === "get") {
    const got = getValue(loaded.config, key);
    if (!got.known) {
      console.error(`${CONFIG_NAME}: no key ${key}`);
      process.exit(2);
    }
    if (got.value === undefined) {
      console.error(`${CONFIG_NAME}: ${key} is not set`);
      process.exit(1);
    }
    console.log(Array.isArray(got.value) ? got.value.join("\n") : got.value);
  }
}
