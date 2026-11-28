// A project's setup: moving its config into the .risa folder, and starting a new one.
// Both run on a repo no config may load for yet, so bin/risa routes them here before
// prd.sh. Neither commits: each prints the commit to make.
//
//   node setup.mjs config migrate [--dry-run]
//       In the repo's main checkout: git mv risa.json to .risa/config.json and each of
//       RULE_FILES' data files a paths key names (when the file exists) to its default
//       name there, drop those keys (the loader finds them by name), turn a tooling
//       entry for a moved file into .risa, write the config (two-space indent, final
//       newline) and stage it. One line per move, then the commit. --dry-run: the same
//       lines, nothing changed. Exit 2 with one line, changing nothing: outside a repo,
//       no risa.json, the .risa folder there, a config that doesn't load, a moved file
//       dirty or untracked.
//   node setup.mjs init --name <slug> [--trunk <branch>] [--check <command>]
//       Writes .risa/config.json (Risa's defaults for the rest: paths under plans/, the
//       id prefix from the name, no-op commands, a check hook running --check), the
//       folder's tier data and check plan rules (one tier, `check`, that every file asks
//       for), the backlog (its PRDs table, empty), the inbox and the archive. Prints the
//       machine config line and the commit. Exit 2
//       with one line, writing nothing: outside a repo, a config in either form there,
//       a file it would write already there, a value the loader refuses.
//
// migratePlan and initFiles are the pure halves (no file system, no git), for tests.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR,
  CONFIG_FILE,
  CONFIG_NAME,
  ConfigError,
  RULE_FILES,
  configIn,
  configProblems,
} from "./config.mjs";

/** The folder form's config, from the repo's root. */
const FOLDER_CONFIG = `${CONFIG_DIR}/${CONFIG_FILE}`;

/** A refusal: one line, exit 2, nothing changed. */
class Refusal extends Error {}

/** @param {Record<string, any>} raw */
const json = (raw) => `${JSON.stringify(raw, null, 2)}\n`;

/** TEXT as one sh word, single-quoted. @param {string} text */
const shQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

/** A RULE_FILES file's path in the folder, by its key. @param {string} key */
const ruleFile = (key) => `${CONFIG_DIR}/${RULE_FILES.find(([k]) => k === key)?.[1]}`;

/**
 * What migrate does to a risa.json repo: the moves (from → to, from the root) and the
 * new config's text. A key naming a missing file stays, unmoved.
 * @param {{ root: string, raw: Record<string, any>, exists?: (rel: string) => boolean }} opts
 *   EXISTS: whether a path from the root is there (default: the file system)
 * @returns {{ moves: [string, string][], dropped: string[], text: string }}
 */
export function migratePlan({ root, raw, exists = (rel) => existsSync(join(root, rel)) }) {
  /** @type {[string, string][]} */
  const moves = [[CONFIG_NAME, FOLDER_CONFIG]];
  const paths = { ...raw.paths };
  /** @type {string[]} */
  const dropped = [];
  for (const [key, name] of RULE_FILES) {
    const from = paths[key];
    if (typeof from !== "string" || !exists(from)) continue;
    moves.push([from, `${CONFIG_DIR}/${name}`]);
    delete paths[key];
    dropped.push(`paths.${key}`);
  }
  const moved = new Set(moves.map(([from]) => from));
  if (Array.isArray(paths.tooling))
    paths.tooling = [...new Set(paths.tooling.map((p) => (moved.has(p) ? CONFIG_DIR : p)))];
  return { moves, dropped, text: json({ ...raw, paths }) };
}

/**
 * The files init writes (path from the root → text): the folder's config, its tier data
 * and check plan rules (by RULE_FILES' names, so the loader finds them), and the backlog,
 * inbox and archive under plans/. The check hook runs CHECK through sh, which drops the
 * mode, base and test files check-hook.sh appends.
 * @param {{ name: string, trunk?: string, check?: string }} opts
 * @returns {Record<string, string>}
 */
export function initFiles({ name, trunk = "main", check = "true" }) {
  const idPrefix = String(name)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const config = {
    name,
    tool: { prd: "risa", backlog: "risa backlog" },
    paths: {
      backlog: "plans/backlog.md",
      inbox: "plans/inbox.md",
      archive: "plans/backlog-archive.md",
      plans: "plans",
      docs: "docs",
      agentsDoc: "AGENTS.md",
      tooling: [CONFIG_DIR],
    },
    branches: { trunk, prefixes: { prd: "prd/", slice: "slice/", plan: "plan/", hotfix: "hotfix/" } },
    backlog: { prdsHeading: "## PRDs", idPrefix },
    commands: {
      install: "true",
      check,
      typecheck: "true",
      typegen: "true",
      datastoreStart: "true",
      datastoreReset: "true",
      datastoreSeed: "true",
    },
    hooks: { check: `sh -c ${shQuote(check)} check` },
  };
  // One tier, `check`: CI's one job runs the project's check, on `ci/<tier>/<branch>` refs.
  const tiers = {
    tiers: ["check"],
    jobs: { check: ["check"] },
    fileGroups: [{ group: "check", pattern: "*", tier: "check" }],
    narrowedTiers: ["check"],
    browserCheck: "browser-checks/*.spec.js",
    narrowedFile: ".risa-narrowed.json",
    forcedFlakeFile: ".risa-force-flake.json",
    refPrefix: "ci/",
  };
  // Every file no rule covers asks for the suite's tier: here, the one tier.
  const checkPlan = {
    ownTests: "\\.(integration|component)\\.test\\.[^/]+$",
    suite: { tier: "check", rules: [] },
  };
  const summary = [
    "## Summary",
    "",
    "<!-- Generated by `risa backlog` on every write: don't edit this table by hand. -->",
    "",
    "| Id | Type | Status | PRD | Owner | Title |",
    "| -- | ---- | ------ | --- | ----- | ----- |",
  ];
  const backlog = [
    "# Backlog",
    "",
    "Agents keep this file through `risa backlog`; you review it. Add new things in [inbox.md](inbox.md).",
    "",
    "## PRDs",
    "",
    "The PRD registry: row order is the priority. Edit it only with `risa backlog prd`.",
    "",
    "| PRD | Flags | After | Hot files | Doc and notes |",
    "| --- | ----- | ----- | --------- | ------------- |",
    "",
    ...summary,
    "",
    "## Items",
    "",
  ];
  const inbox = [
    "# Inbox",
    "",
    "Add anything here: one line per item, under the heading that fits. Agents file each line into the backlog ([backlog.md](backlog.md)) and add its id.",
    "",
    "## Bugs",
    "",
    "## Features",
    "",
  ];
  const archive = [
    "# Backlog archive",
    "",
    "Finished items, moved here from [backlog.md](backlog.md) by `risa backlog archive`. Don't edit it by hand.",
    "",
    "## Items",
    "",
  ];
  return {
    [FOLDER_CONFIG]: json(config),
    [ruleFile("tierData")]: json(tiers),
    [ruleFile("checkPlanRules")]: json(checkPlan),
    [config.paths.backlog]: backlog.join("\n"),
    [config.paths.inbox]: inbox.join("\n"),
    [config.paths.archive]: archive.join("\n"),
  };
}

/** @param {string} cwd @param {string[]} args */
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** The repo's root and main checkout, or a Refusal outside one. @param {string} cwd */
function repoOf(cwd) {
  try {
    const root = git(cwd, "rev-parse", "--show-toplevel");
    const main =
      git(cwd, "worktree", "list", "--porcelain")
        .split("\n")[0]
        ?.replace(/^worktree /, "") ?? root;
    return { root, main };
  } catch {
    throw new Refusal(`${cwd}: not in a git repo`);
  }
}

/** The loader's problems as one line, or a Refusal naming them. @param {string} file @param {unknown} raw */
function mustLoad(file, raw) {
  const problems = configProblems(raw);
  if (problems.length) throw new Refusal(problems.map((p) => `${file}: ${p}`).join("; "));
}

/**
 * `config migrate`, in CWD's repo. Returns the lines to print.
 * @param {{ cwd?: string, dryRun?: boolean }} [opts]
 * @returns {string[]}
 */
export function migrate({ cwd = process.cwd(), dryRun = false } = {}) {
  const { root } = repoOf(cwd);
  if (existsSync(join(root, CONFIG_DIR)))
    throw new Refusal(`${CONFIG_DIR}/ is already there: nothing to migrate`);
  const file = join(root, CONFIG_NAME);
  if (!existsSync(file)) throw new Refusal(`no ${CONFIG_NAME} at ${root}`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Refusal(`${CONFIG_NAME}: not JSON (${e instanceof Error ? e.message : e})`);
  }
  mustLoad(CONFIG_NAME, raw);
  const plan = migratePlan({ root, raw });
  const froms = plan.moves.map(([from]) => from);
  // -z: NUL-ended `XY name` entries; untrimmed, so a leading space of XY stays.
  const dirty = execFileSync("git", ["-C", root, "status", "--porcelain", "-z", "--", ...froms], {
    encoding: "utf8",
  });
  if (dirty) {
    const names = dirty
      .split("\0")
      .filter(Boolean)
      .map((l) => l.slice(3));
    throw new Refusal(`${names.join(", ")}: uncommitted or untracked; commit them first`);
  }
  const lines = plan.moves.map(([from, to]) => `${dryRun ? "would move" : "moved"} ${from} → ${to}`);
  lines.push(
    ...plan.dropped.map((key) => `${dryRun ? "would drop" : "dropped"} ${key} (found by its name now)`),
  );
  if (dryRun) return [...lines, "nothing changed (--dry-run)"];
  mkdirSync(join(root, CONFIG_DIR), { recursive: true });
  for (const [from, to] of plan.moves) git(root, "mv", from, to);
  writeFileSync(join(root, FOLDER_CONFIG), plan.text);
  git(root, "add", FOLDER_CONFIG);
  return [...lines, `staged; commit it: git commit -m "chore: move the risa config into ${CONFIG_DIR}/"`];
}

/**
 * `init`, in CWD's repo. Returns the lines to print.
 * @param {{ cwd?: string, name?: string, trunk?: string, check?: string }} opts
 * @returns {string[]}
 */
export function init({ cwd = process.cwd(), name, trunk, check }) {
  if (name === undefined) throw new Refusal("--name <slug> is required");
  const { root, main } = repoOf(cwd);
  let found;
  try {
    found = configIn(root);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    throw new Refusal(e.message);
  }
  if (found) throw new Refusal(`${found}: a project config is already there`);
  const files = initFiles({ name, trunk, check });
  mustLoad(FOLDER_CONFIG, JSON.parse(files[FOLDER_CONFIG] ?? "{}"));
  const there = Object.keys(files).filter((rel) => existsSync(join(root, rel)));
  if (there.length) throw new Refusal(`${there.join(", ")}: already there; init writes only new files`);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const config = JSON.parse(files[FOLDER_CONFIG] ?? "{}");
  const missing = [config.paths.agentsDoc, config.paths.docs].filter((rel) => !existsSync(join(root, rel)));
  return [
    ...Object.keys(files).map((rel) => `wrote ${rel}`),
    ...(missing.length
      ? [
          `the config names ${missing.join(" and ")} (paths.agentsDoc, paths.docs): add them, or change those paths`,
        ]
      : []),
    `add this repo to ~/.risa/machine.json's repos: ${JSON.stringify({ path: main, work: true })}`,
    `then commit: git add ${[...new Set(Object.keys(files).map((rel) => rel.split("/")[0]))].join(" ")} && git commit -m "chore: start risa"`,
  ];
}

const USAGE =
  "usage: risa config migrate [--dry-run] | risa init --name <slug> [--trunk <branch>] [--check <command>]";

/**
 * The CLI: the lines to print and the exit code.
 * @param {string[]} argv @param {string} [cwd]
 * @returns {{ out: string[], err: string[], code: number }}
 */
export function cli(argv, cwd = process.cwd()) {
  const [verb, ...rest] = argv;
  const who = verb === "config" ? "risa config migrate" : "risa init";
  try {
    if (verb === "config" && rest[0] === "migrate" && rest.slice(1).every((a) => a === "--dry-run"))
      return { out: migrate({ cwd, dryRun: rest.includes("--dry-run") }), err: [], code: 0 };
    if (verb === "init") {
      /** @type {Record<string, string>} */
      const flags = {};
      for (let i = 0; i < rest.length; i += 2) {
        const flag = rest[i] ?? "";
        const value = rest[i + 1];
        if (!["--name", "--trunk", "--check"].includes(flag) || value === undefined)
          return { out: [], err: [USAGE], code: 2 };
        flags[flag.slice(2)] = value;
      }
      return { out: init({ cwd, ...flags }), err: [], code: 0 };
    }
    return { out: [], err: [USAGE], code: 2 };
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    return { out: [], err: [`${who}: ${e.message}`], code: 2 };
  }
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
  const { out, err, code } = cli(process.argv.slice(2));
  for (const line of out) console.log(line);
  for (const line of err) console.error(line);
  process.exit(code);
}
