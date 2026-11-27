#!/usr/bin/env node
// prd project-check: the project's own data, loaded through the core's readers. The
// core's tests run on the sample and fixture projects, never on the project the
// tool serves; this command checks that project's files instead. One line per
// problem, each naming its file (relative to the project's root):
//
//   every path the config names (paths, boundary.appPaths) exists
//   the tier data passes tierDataProblems (scripts/ci/tier-data.mjs)
//   the check plan's rules load (check-plan.mjs), on the project's tiers
//   the quarantine and brake lists parse, the quarantine with the project's ids
//   every role entry's file exists, and every .md beside the preferences doc but
//     itself is a role's file (additions or replacement)
//   the skeptic brief's rules read (skeptics.mjs's readRules: the never list found)
//   each measure of the gates' data runs through the time gate (time-gate.mjs)
//   the boundary lint passes on the tree, when the project has a manifest
//
//   node project-check.mjs    the configured project (RISA_CONFIG, else risa.json)
//
// Exit 0 with one `project-check: ok` line; 1 with the lines and a count; 2 for a
// config that doesn't load. `pnpm test:tooling` and the check's tooling step run it
// first (tooling-tests.mjs, check-tooling.mjs).
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tierDataProblems, tiersFrom } from "../ci/tier-data.mjs";
import { parseQuarantine } from "../ci/ci-lists.mjs";
import { MANIFEST, lintRepo } from "./boundary.mjs";
import { CheckPlanRulesError, checkPlanFor, checkPlanRulesProblems } from "./check-plan.mjs";
import { backlogIds, loadConfigOrExit } from "./config.mjs";
import { DocError, roleDoc } from "./doc.mjs";
import { SkepticError, readRules } from "./skeptics.mjs";
import { timeGate } from "./time-gate.mjs";

const COMMENT = /^\s*(#|$)/;
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
 * @param {{ config: Record<string, any>, root: string }} project a loaded config
 * @returns {string[]}
 */
export function projectProblems({ config, root }) {
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

  // The boundary lint, when the project has a manifest.
  if (exists(MANIFEST)) {
    try {
      problems.push(...lintRepo(root).failures.map((f) => `boundary lint: ${f}`));
    } catch (e) {
      problems.push(`${MANIFEST}: the boundary lint didn't run (${fromRoot(message(e))})`);
    }
  }
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
  if (process.argv.length > 2) {
    console.error("usage: project-check.mjs (no arguments: the configured project)");
    process.exit(2);
  }
  const problems = projectProblems(loadConfigOrExit("project-check"));
  if (!problems.length) console.log("project-check: ok");
  else {
    console.log(problems.join("\n"));
    console.log(`project-check: ${problems.length} problem(s) in the project's data`);
    process.exit(1);
  }
}
