// The sample project: a project config (risa.json, beside this file) that is not
// this repo's, and a throwaway repo built on it, for the core's tests. Its names
// differ from this repo's wherever the tooling reads them through the config (the
// tool's commands, paths, role docs, the trunk, the branch prefixes (topic/,
// part/, draft/, quick/), the id prefix, the project's commands).
//
//   makeRepo(main, { config, files })   a git repo at `main`: the tool's scripts
//     (scripts/loops), the config as its risa.json, the data files it names that sit
//     beside it (the tier data, the check plan's rules: tools/ here), the script its
//     check hook runs when it sits beside it (tools/check.sh), the files given
//     (path → text), one commit on the config's trunk. The scripts find the config at its root, so
//     a test runs them with RISA_CONFIG unset.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_NAME } from "../config.mjs";

const LOOPS = fileURLToPath(new URL("..", import.meta.url));

/** The sample project's config. */
export const SAMPLE_CONFIG = fileURLToPath(new URL(`./${CONFIG_NAME}`, import.meta.url));

/**
 * @param {string} main where the repo goes (made if missing)
 * @param {{ config?: string, files?: Record<string, string> }} [opts]
 * @returns {Record<string, any>} the repo's config
 */
export function makeRepo(main, { config = SAMPLE_CONFIG, files = {} } = {}) {
  const parsed = JSON.parse(readFileSync(config, "utf8"));
  mkdirSync(main, { recursive: true });
  cpSync(LOOPS, join(main, "scripts/loops"), { recursive: true });
  copyFileSync(config, join(main, CONFIG_NAME));
  const hookScript = parsed.hooks?.check?.split(" ")[0];
  for (const rel of [parsed.paths.tierData, parsed.paths.checkPlanRules, hookScript]) {
    const from = rel && join(dirname(config), rel);
    if (!from || !existsSync(from)) continue;
    mkdirSync(dirname(join(main, rel)), { recursive: true });
    copyFileSync(from, join(main, rel));
  }
  for (const [path, text] of Object.entries({ ".gitignore": ".loops/\n", ...files })) {
    mkdirSync(dirname(join(main, path)), { recursive: true });
    writeFileSync(join(main, path), text);
  }
  const git = (/** @type {string[]} */ ...a) => execFileSync("git", ["-C", main, ...a], { stdio: "pipe" });
  git("init", "-q", "-b", parsed.branches.trunk);
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "chore: init");
  return parsed;
}
