// The machine config: one JSON file outside every repo, in the user's home beside
// Risa's releases (~/.risa/machine.json), listing the repos Risa works in on this
// machine. This module is its loader and the only code that knows its shape;
// lib.sh's find_repo and work_switch call it, and only when the file is there.
//
//   {
//     "flavor": "starfleet",
//     "repos": [
//       { "path": "/Users/me/git/app", "work": true },
//       { "path": "/Users/me/git/risa", "work": false,
//         "claudeConfigDir": { "orchestrator": "/Users/me/.claude-work" } }
//     ]
//   }
//
// Each repo: `path` (its main checkout, absolute), `work` (the work switch:
// whether the dispatcher and start, queue, plan and slice may start work there)
// and `claudeConfigDir` (the Claude Code config folder its sessions use: one
// absolute path, or one per role). Unknown keys are errors, so a typo can't hide.
// `flavor` (optional, top level): the flavor pack the machine's sessions wear,
// one of flavor.mjs's FLAVORS (`starfleet`, the default, or `none`).
//
// The work switch. No machine config: on everywhere (today's behaviour). With one:
// the repo's `work`, else off for the tool's own repo (its risa.json says
// `tool.self`) and on for every other, so a machine that runs Risa from a release
// spends nothing on Risa's own backlog until it is turned on. RISA_WORK_SELF=1
// turns it on for the process that has it (and what it starts), whatever the file
// says. Reads (status, the backlog, asks, notices, doc) never ask the switch.
//
// Where it lives: RISA_MACHINE_CONFIG (a path; empty: no machine config, which the
// tests use), else ~/.risa/machine.json. lib.sh reads the same variable to see
// whether the file is there before it starts Node.
//
// The git floor: GIT_FLOOR, which `git init -b` needs. `machine.mjs check` (the
// install's last step) and the Vitest global setup (test-global-setup.mjs) refuse an
// older git with gitFloorLine's one line; risa's other commands don't check.
//
//   node machine.mjs check                  the git floor, then loads it; prints each
//                                           problem; exit 2 on any
//   node machine.mjs repo --cwd <dir>       the main checkout of DIR's repo when the
//                                           file lists it, then its project config's
//                                           path (configFor: DIR's checkout's own
//                                           config in either form, else the main
//                                           checkout's); exit 1 when it doesn't; 2,
//                                           one line, when a checkout has both forms
//   node machine.mjs work --main <m> [--who <cmd>]   exit 0 when the switch is on;
//                                           off: one line naming the switch and the
//                                           variable on stderr, exit 3
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_NAME, ConfigError, configIn, loadConfig } from "./config.mjs";
import { FLAVORS } from "./flavor.mjs";

/** The file's name, and its folder under the home: here and in lib.sh's machine_file. */
export const MACHINE_NAME = "machine.json";
export const MACHINE_DIR = ".risa";
/** The variable that turns the switch on for one process. */
export const WORK_VAR = "RISA_WORK_SELF";

/** The oldest git Risa and its tests run on: `git init -b` needs it. */
export const GIT_FLOOR = "2.28";

/** The major.minor `git --version` printed, or null when it isn't one. @param {string} text */
const gitVersionOf = (text) => {
  const m = /^git version (\d+)\.(\d+)/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
};

/**
 * Whether `git --version`'s output names a git under GIT_FLOOR; an unreadable one is.
 * @param {string} versionText
 */
export function gitTooOld(versionText) {
  const v = gitVersionOf(versionText);
  if (!v) return true;
  const [fMajor, fMinor] = GIT_FLOOR.split(".").map(Number);
  return v[0] < fMajor || (v[0] === fMajor && v[1] < fMinor);
}

/**
 * The one line refusing the git on ENV's PATH, or null when it meets the floor.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
export function gitFloorLine(env = process.env) {
  let text;
  try {
    text = execFileSync("git", ["--version"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return `git: no git runs here; Risa needs git ${GIT_FLOOR} or newer`;
  }
  if (!gitTooOld(text)) return null;
  const v = text.trim().split("\n")[0];
  return gitVersionOf(text)
    ? `git: ${v.replace(/^git version /, "")} is older than ${GIT_FLOOR}; Risa needs git ${GIT_FLOOR} or newer (git init -b)`
    : `git: \`git --version\` printed "${v}", not a version; Risa needs git ${GIT_FLOOR} or newer`;
}

/** A problem with the machine config: `problems` has one line per field. */
export class MachineConfigError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(problems.join("\n"));
    this.name = "MachineConfigError";
    this.problems = problems;
  }
}

/** @param {unknown} v */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** @param {unknown} v */
const absPath = (v) => typeof v === "string" && isAbsolute(v) && !/[\n\r\t]/.test(v);
const ROLE = /^[a-z][a-z0-9-]*$/;

/**
 * The problems with a parsed machine config, one line per field; none when valid.
 * @param {unknown} raw what JSON.parse gave
 * @returns {string[]}
 */
export function machineProblems(raw) {
  if (!isObject(raw)) return ["the file must hold one JSON object"];
  const top = /** @type {Record<string, unknown>} */ (raw);
  /** @type {string[]} */
  const problems = [];
  for (const k of Object.keys(top)) if (!["repos", "flavor"].includes(k)) problems.push(`${k}: unknown key`);
  if ("flavor" in top && !FLAVORS.includes(/** @type {string} */ (top.flavor)))
    problems.push(`flavor: must be one of ${FLAVORS.join(", ")}`);
  if (!Array.isArray(top.repos)) {
    problems.push("repos: must be a list of repos ({ path, work?, claudeConfigDir? })");
    return problems;
  }
  /** @type {Set<string>} */
  const seen = new Set();
  top.repos.forEach((repo, i) => {
    const at = `repos.${i}`;
    if (!isObject(repo))
      return void problems.push(`${at}: must be an object ({ path, work?, claudeConfigDir? })`);
    const r = /** @type {Record<string, unknown>} */ (repo);
    for (const k of Object.keys(r))
      if (!["path", "work", "claudeConfigDir"].includes(k)) problems.push(`${at}.${k}: unknown key`);
    if (!absPath(r.path)) problems.push(`${at}.path: must be an absolute path (the repo's main checkout)`);
    else if (seen.has(resolve(String(r.path)))) problems.push(`${at}.path: lists ${r.path} twice`);
    else seen.add(resolve(String(r.path)));
    if ("work" in r && typeof r.work !== "boolean") problems.push(`${at}.work: must be true or false`);
    if ("claudeConfigDir" in r) {
      const c = r.claudeConfigDir;
      if (isObject(c)) {
        const roles = Object.entries(/** @type {Record<string, unknown>} */ (c));
        if (!roles.length) problems.push(`${at}.claudeConfigDir: names no role`);
        for (const [role, dir] of roles)
          if (!ROLE.test(role)) problems.push(`${at}.claudeConfigDir.${role}: must be a role's name`);
          else if (!absPath(dir)) problems.push(`${at}.claudeConfigDir.${role}: must be an absolute path`);
      } else if (!absPath(c))
        problems.push(
          `${at}.claudeConfigDir: must be an absolute path, or one per role ({ "orchestrator": … })`,
        );
    }
  });
  return problems;
}

/**
 * Where the machine config is, or null when RISA_MACHINE_CONFIG is set empty (none).
 * @param {Record<string, string | undefined>} [env]
 */
export function machineConfigPath(env = process.env) {
  if (env.RISA_MACHINE_CONFIG !== undefined)
    return env.RISA_MACHINE_CONFIG ? resolve(env.RISA_MACHINE_CONFIG) : null;
  return join(env.HOME || homedir(), MACHINE_DIR, MACHINE_NAME);
}

/**
 * @typedef {{ path: string, work?: boolean, claudeConfigDir?: string | Record<string, string> }} MachineRepo
 * @typedef {{ repos: MachineRepo[], path: string, flavor?: string }} Machine
 */

/**
 * The machine config, checked; null when there is none (no file, or
 * RISA_MACHINE_CONFIG empty). Throws a MachineConfigError naming every problem.
 * @param {{ path?: string | null, env?: Record<string, string | undefined> }} [opts]
 * @returns {Machine | null}
 */
export function loadMachineConfig({ path, env = process.env } = {}) {
  const file = path === undefined ? machineConfigPath(env) : path;
  if (!file) return null;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null;
    throw new MachineConfigError([
      `${file}: can't read the machine config (${e instanceof Error ? e.message : e})`,
    ]);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new MachineConfigError([`${file}: not JSON (${e instanceof Error ? e.message : e})`]);
  }
  const problems = machineProblems(raw);
  if (problems.length) throw new MachineConfigError(problems.map((p) => `${file}: ${p}`));
  return { repos: raw.repos, path: file, ...(raw.flavor ? { flavor: raw.flavor } : {}) };
}

/** A path with its symlinks resolved, when it exists. @param {string} p */
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * The machine config's entry for the repo whose main checkout is MAIN, or null.
 * @param {Machine | null} machine @param {string} main
 * @returns {MachineRepo | null}
 */
export function repoEntry(machine, main) {
  if (!machine) return null;
  const want = real(main);
  return machine.repos.find((r) => real(r.path) === want) ?? null;
}

/**
 * The Claude Code config folder the entry names for ROLE (its own, else `default`),
 * or for every role; null when it names none. For the host module (slice 7).
 * @param {MachineRepo | null} entry @param {string} [role]
 */
export function claudeConfigDirOf(entry, role) {
  const c = entry?.claudeConfigDir;
  if (!c) return null;
  if (typeof c === "string") return c;
  return (role && c[role]) || c.default || null;
}

/**
 * The work switch for the repo whose main checkout is MAIN.
 * @param {{ main: string, config?: Record<string, any>, machine?: Machine | null,
 *   env?: Record<string, string | undefined> }} facts the repo's risa.json values
 *   (default: loadConfig's) and the machine config (default: loadMachineConfig's)
 * @returns {{ on: boolean, why: string }} why: what decided it, in words
 */
export function workSwitch({ main, config, machine, env = process.env }) {
  if (env[WORK_VAR] === "1") return { on: true, why: `${WORK_VAR}=1 turns it on for this process` };
  const m = machine === undefined ? loadMachineConfig({ env }) : machine;
  if (!m) return { on: true, why: "no machine config: on" };
  const entry = repoEntry(m, main);
  if (typeof entry?.work === "boolean")
    return { on: entry.work, why: `"work": ${entry.work} for ${main} in ${m.path}` };
  const self = (config ?? loadConfig({ env }).config).tool?.self === true;
  return self
    ? {
        on: false,
        why: `off by default for the tool's own repo (${main}): set "work": true for it in ${m.path}`,
      }
    : { on: true, why: `on by default (${m.path} sets no "work" for ${main})` };
}

/**
 * The one line a command that would start work prints when the switch is off.
 * @param {string} who the command (start, queue, plan, slice, dispatch)
 * @param {{ why: string }} sw
 */
export const workOffLine = (who, sw) =>
  `${who}: the work switch is off (${sw.why}); ${WORK_VAR}=1 turns it on for one shell or session`;

/** The main checkout of the repo DIR is in, or null outside one. @param {string} dir */
function mainOf(dir) {
  try {
    const out = execFileSync("git", ["-C", dir, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n")[0]?.replace(/^worktree /, "") || null;
  } catch {
    return null;
  }
}

/**
 * The project config a checkout reads: its own when it has one, in either form (a
 * worktree's, so a branch's config change shows there), else the main checkout's;
 * with neither, the main checkout's risa.json (the path the loader then names).
 * @param {{ top: string, main: string, exists?: (path: string) => boolean,
 *   find?: (dir: string) => string | null }} facts TOP, the checkout's root; MAIN, the
 *   repo's main checkout; FIND, a checkout's config (config.mjs configIn, which throws
 *   a ConfigError on both forms); EXISTS, a test's stand-in for the disk, which sees
 *   the risa.json form only
 */
export function configFor({ top, main, exists, find }) {
  const own = (/** @type {string} */ dir) =>
    exists?.(join(dir, CONFIG_NAME)) ? join(dir, CONFIG_NAME) : null;
  const look = find ?? (exists ? own : configIn);
  return look(top) ?? look(main) ?? join(main, CONFIG_NAME);
}

/** The root of the checkout DIR is in, or null outside one. @param {string} dir */
function topOf(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Exits 2 with one `machine.mjs: …` line on a machine config that doesn't load. */
function loadOrExit() {
  try {
    return loadMachineConfig();
  } catch (e) {
    if (!(e instanceof MachineConfigError)) throw e;
    process.stderr.write(`machine config: ${e.problems.join("; ")}\n`);
    process.exit(2);
  }
}

const isMain = () => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  const [verb, ...args] = process.argv.slice(2);
  /** @param {string} name */
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const usage = () => {
    console.error("usage: machine.mjs check | repo --cwd <dir> | work --main <main> [--who <cmd>]");
    process.exit(2);
  };
  if (verb === "check") {
    const git = gitFloorLine();
    if (git) {
      console.error(git);
      process.exit(2);
    }
    loadOrExit();
  } else if (verb === "repo") {
    const cwd = opt("--cwd") ?? usage();
    const m = loadOrExit();
    const main = mainOf(cwd);
    const entry = main ? repoEntry(m, main) : null;
    if (!entry || !main) process.exit(1);
    try {
      console.log(`${main}\n${configFor({ top: topOf(cwd) ?? main, main })}`);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      process.stderr.write(`machine.mjs: ${e.problems.join("; ")}\n`);
      process.exit(2);
    }
  } else if (verb === "work") {
    const main = opt("--main") ?? usage();
    const m = loadOrExit();
    const sw = workSwitch({ main, machine: m });
    if (!sw.on) {
      console.error(workOffLine(opt("--who") ?? "work", sw));
      process.exit(3);
    }
  } else usage();
}
