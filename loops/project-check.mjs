#!/usr/bin/env node
// project-check: the project's own data, loaded through the core's readers. The
// core's tests run on the sample and fixture projects, never on the project the
// tool serves; this command checks that project's files instead. One line per
// problem, each naming its file (relative to the project's root):
//
//   every path the config names (paths, boundary.appPaths) exists
//   the tier data passes tierDataProblems (ci/tier-data.mjs)
//   the check plan's rules load (check-plan.mjs), on the project's tiers
//   the quarantine and brake lists parse, the quarantine with the project's ids
//   every role entry's file exists, and every .md beside the preferences doc but
//     itself is a role's file (additions or replacement)
//   the skeptic brief's rules read (skeptics.mjs's readRules: the never list found)
//   each measure of the gates' data runs through the time gate (time-gate.mjs)
//   the prompt golden the config names (paths.promptGolden) matches the prompts
//     rendered on the project's config (prompt-render.mjs)
//   the shared names (config.mjs's sharedNames: the lock, the markers, the launchd
//     label, the CI status context) come from a name they can carry, and lib.sh
//     builds the same ones in bash
//
//   node project-check.mjs                 the configured project (RISA_CONFIG, else risa.json)
//   node project-check.mjs --write-golden  rewrite that golden from the prompts rendered
//                                          now, after a deliberate prompt change (review its diff)
//
// Exit 0 with one `project-check: ok` line; 1 with the lines and a count; 2 for a
// config that doesn't load or an unknown argument. `pnpm test:tooling` and the check's tooling step run it
// first (tooling-tests.mjs, check-tooling.mjs).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tierDataProblems, tiersFrom } from "../ci/tier-data.mjs";
import { parseQuarantine } from "../ci/ci-lists.mjs";
import { CheckPlanRulesError, checkPlanFor, checkPlanRulesProblems } from "./check-plan.mjs";
import { CONFIG_NAME, backlogIds, configIn, loadConfigOrExit, sharedNames } from "./config.mjs";
import { DocError, roleDoc } from "./doc.mjs";
import { renderPrompts } from "./prompt-render.mjs";
import { SkepticError, readRules } from "./skeptics.mjs";
import { timeGate } from "./time-gate.mjs";

const COMMENT = /^\s*(#|$)/;
const HERE = dirname(fileURLToPath(import.meta.url));
// A name a file in the git dir, a launchd label and a commit status context can all carry.
const SHARED_NAME = /^[a-z0-9][a-z0-9-]*$/;
// The shared names lib.sh builds, in the order bashSharedNames prints them.
const BASH_NAMES = /** @type {const} */ (["checked", "unsyncedMerge", "backlogLock"]);

/**
 * The shared names lib.sh builds on the config at PATH (checked, unsyncedMerge,
 * backlogLock), from ROOT (a git repo); null when the bash side didn't run.
 * @param {string} path @param {string} root
 * @returns {Record<string, string> | null}
 */
export function bashSharedNames(path, root) {
  const r = spawnSync(
    "bash",
    [
      "-c",
      `source "${join(HERE, "lib.sh")}" && source "${join(HERE, "unsynced.sh")}" && ` +
        'basename "$(checked_file .)" && basename "$(unsynced_marker .)" && echo "$project_name-backlog.lock"',
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, RISA_CONFIG: path } },
  );
  const lines = r.stdout.trim().split("\n");
  if (r.status !== 0 || lines.length !== BASH_NAMES.length) return null;
  return Object.fromEntries(BASH_NAMES.map((k, i) => [k, lines[i] ?? ""]));
}

/**
 * What is wrong with the project's shared names: a name they can't carry, or bash's
 * (BASH, from bashSharedNames) differing from Node's.
 * @param {Record<string, any>} config @param {Record<string, string> | null} bash
 * @returns {string[]}
 */
export function sharedNameProblems(config, bash) {
  if (!SHARED_NAME.test(String(config.name ?? "")))
    return [
      `${CONFIG_NAME}: name: ${JSON.stringify(config.name)} can't carry the shared names (a-z, 0-9 and -)`,
    ];
  if (!bash) return [`${CONFIG_NAME}: the shared names: lib.sh didn't run on the config`];
  const node = sharedNames(config);
  return BASH_NAMES.filter((k) => bash[k] !== node[k]).map(
    (k) =>
      `${CONFIG_NAME}: the shared names: ${k} is ${JSON.stringify(bash[k])} in bash (lib.sh), ${JSON.stringify(node[k])} in Node`,
  );
}
const message = (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e));

/**
 * A JSON file's value, or the line saying why it doesn't read.
 * @param {string} root @param {string} rel @param {string} what
 * @returns {{ data: unknown } | { problem: string }}
 */
const readJson = (root, rel, what) => {
  try {
    return { data: JSON.parse(readFileSync(join(root, rel), "utf8")) };
  } catch (e) {
    return { problem: `${rel}: can't read ${what} (${message(e)})` };
  }
};

/** A file's non-comment lines, each with its line number. @param {string} text */
const listLines = (text) =>
  text
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !COMMENT.test(line));

/**
 * What is wrong with the project's own data: one line per problem, none when it all loads.
 * @param {{ config: Record<string, any>, root: string, path?: string }} project a loaded
 *   config (its path, for the prompt golden's render: the root's config, in either form
 *   (configIn), when left out; both forms there throw its ConfigError)
 * @returns {string[]}
 */
export function projectProblems({ config, root, path = configIn(root) ?? root }) {
  /** @type {string[]} */
  const problems = [];
  const paths = config.paths ?? {};
  const rel = (/** @type {string} */ file) => relative(root, file) || file;
  // The core's errors name absolute paths: the line names it from the root.
  const fromRoot = (/** @type {string} */ text) => text.replaceAll(`${root}/`, "");
  const exists = (/** @type {string} */ p) => existsSync(join(root, p));

  // Every path the config names.
  for (const [key, value] of Object.entries(paths))
    for (const p of [value].flat()) if (!exists(p)) problems.push(`${p}: missing (paths.${key})`);
  for (const p of config.boundary?.appPaths ?? [])
    if (!exists(p)) problems.push(`${p}: missing (boundary.appPaths)`);

  // The tier data, and the gates' data through the time gate.
  /** @type {readonly string[] | undefined} */
  let tiers;
  if (paths.tierData && exists(paths.tierData)) {
    const read = readJson(root, paths.tierData, "the tier data");
    if ("problem" in read) problems.push(read.problem);
    else {
      const found = tierDataProblems(read.data);
      problems.push(...found.map((p) => `${paths.tierData}: ${p}`));
      if (!found.length) {
        const loaded = tiersFrom(read.data, paths.tierData);
        tiers = loaded.TIERS;
        const { measures, quietLoadPerCore } = loaded.GATES;
        for (const [measure, limits] of Object.entries(measures)) {
          const r = timeGate({
            measure,
            seconds: 0,
            limits,
            loads: { start: 0, end: 0, cores: 1, perCore: quietLoadPerCore },
          });
          if (r.verdict !== "ok")
            problems.push(`${paths.tierData}: gates.measures.${measure}: the time gate says ${r.verdict}`);
        }
      }
    }
  }

  // The check plan's rules, on the project's tiers when they load.
  if (paths.checkPlanRules && exists(paths.checkPlanRules)) {
    if (tiers) {
      try {
        checkPlanFor({ config, root });
      } catch (e) {
        if (!(e instanceof CheckPlanRulesError)) throw e;
        problems.push(...e.problems.map(fromRoot));
      }
    } else {
      const read = readJson(root, paths.checkPlanRules, "the check plan's rules");
      if ("problem" in read) problems.push(read.problem);
      else problems.push(...checkPlanRulesProblems(read.data).map((p) => `${paths.checkPlanRules}: ${p}`));
    }
  }

  // The CI lists: the quarantine with the project's ids, the brake list one glob a line.
  if (paths.quarantine && exists(paths.quarantine)) {
    const ids = backlogIds(config);
    for (const { line, n } of listLines(readFileSync(join(root, paths.quarantine), "utf8"))) {
      try {
        parseQuarantine(line, ids);
      } catch (e) {
        problems.push(`${paths.quarantine}:${n}: ${message(e)}`);
      }
    }
  }
  if (paths.brakeList && exists(paths.brakeList))
    for (const { line, n } of listLines(readFileSync(join(root, paths.brakeList), "utf8")))
      if (!/^\s*(check:[\w.-]+|[^\s:]+)\s*$/.test(line))
        problems.push(`${paths.brakeList}:${n}: not one glob or check:<name>: ${line.trim()}`);

  // The role docs: every entry's file, and every doc beside the preferences one is a role's.
  /** @type {string[]} */
  const roleFiles = [];
  for (const [role, entry] of Object.entries(config.roles ?? {})) {
    const kind = entry.replacement ? "replacement" : "additions";
    const file = entry[kind];
    if (!file) continue;
    roleFiles.push(file);
    if (!exists(file)) {
      problems.push(`${file}: missing (roles.${role}.${kind})`);
      continue;
    }
    try {
      roleDoc(role, { config, root });
    } catch (e) {
      if (!(e instanceof DocError)) throw e;
      problems.push(`${file}: ${fromRoot(e.message)} (roles.${role})`);
    }
  }
  if (paths.preferences && exists(paths.preferences)) {
    const folder = dirname(paths.preferences);
    const docs = readdirSync(join(root, folder)).filter((f) => f.endsWith(".md"));
    for (const f of docs) {
      const file = folder === "." ? f : `${folder}/${f}`;
      if (file !== paths.preferences && !roleFiles.includes(file))
        problems.push(`${file}: no role names it (roles.<role>.additions or replacement)`);
    }
  }

  // The skeptic brief's rules: the never list, the fixes rules, the planner's sections.
  try {
    readRules(root, config);
  } catch (e) {
    if (!(e instanceof SkepticError)) throw e;
    problems.push(`${paths.preferences ?? "paths.preferences"}: the skeptic brief: ${fromRoot(e.message)}`);
  }

  // The prompt golden: every prompt rendered on the project's config, byte for byte.
  if (paths.promptGolden && exists(paths.promptGolden)) {
    const golden = readFileSync(join(root, paths.promptGolden), "utf8");
    const rendered = renderPrompts(path);
    if (rendered !== golden) {
      const at = [...rendered].findIndex((c, i) => c !== golden[i]);
      const line = rendered
        .slice(0, at < 0 ? Math.min(rendered.length, golden.length) : at)
        .split("\n").length;
      problems.push(
        `${paths.promptGolden}:${line}: the prompts rendered on the project's config differ from the golden ` +
          "(after a deliberate prompt change: project-check.mjs --write-golden, then review its diff)",
      );
    }
  }
  // The shared names other worktrees, the watchdog and GitHub share.
  problems.push(...sharedNameProblems(config, bashSharedNames(path, root)));
  return problems.map((p) => (p.startsWith("/") ? rel(p) : p));
}

const isMain = () => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== "--write-golden")) {
    console.error("usage: project-check.mjs [--write-golden] (the configured project)");
    process.exit(2);
  }
  const project = loadConfigOrExit("project-check");
  if (args.length) {
    const golden = project.config.paths?.promptGolden;
    if (!golden) {
      console.error("project-check: the config names no prompt golden (paths.promptGolden)");
      process.exit(2);
    }
    writeFileSync(join(project.root, golden), renderPrompts(project.path));
    console.log(`project-check: wrote ${golden}`);
    process.exit(0);
  }
  const problems = projectProblems(project);
  if (!problems.length) console.log("project-check: ok");
  else {
    console.log(problems.join("\n"));
    console.log(`project-check: ${problems.length} problem(s) in the project's data`);
    process.exit(1);
  }
}
