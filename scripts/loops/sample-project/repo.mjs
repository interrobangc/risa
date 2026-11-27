// The sample project: a project config (risa.json, beside this file) that is not
// this repo's, and a throwaway repo built on it, for the core's tests. Its names
// differ from this repo's wherever the tooling reads them through the config (the
// tool's commands, paths, role docs, the trunk, the branch prefixes (topic/,
// part/, draft/, quick/), the id prefix, the project's commands).
//
//   makeRepo(main, { config, files })   a git repo at `main`: the tool's scripts
//     (scripts/loops, without its tests, goldens and this checkout's boundary
//     manifest and allowlist), the config as its risa.json, the data files it names that sit
//     beside it (the tier data, the check plan's rules: tools/ here), the scripts its
//     hooks run when they sit beside it (tools/check.sh, tools/browser-hook.sh…), the files given
//     (path → text), one commit on the config's trunk. The scripts find the config at its root, so
//     a test runs them with RISA_CONFIG unset.
//   sampleData()   the files the sample config names that makeRepo doesn't write, so
//     that the project-data check (project-check.mjs) passes on its repo: give them
//     as `files`, with the core's two readers in scripts/ci the check imports.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_NAME } from "../config.mjs";

const LOOPS = fileURLToPath(new URL("..", import.meta.url));

/** The sample project's config. */
export const SAMPLE_CONFIG = fileURLToPath(new URL(`./${CONFIG_NAME}`, import.meta.url));

/**
 * The sample project's data that makeRepo doesn't copy (path → text), and the core's
 * readers in scripts/ci the project-data check imports: with them as `files`, the
 * check passes on the repo.
 * @returns {Record<string, string>}
 */
export function sampleData() {
  const role = (/** @type {string} */ name) => `# The ${name} role\n\nThe sample's own.\n`;
  return {
    "work/backlog.md": "# Backlog\n",
    "work/inbox.md": "# Inbox\n",
    "work/archive.md": "# Archive\n",
    "work/plans/fixes-rules.md": "# Fixes rules\n\nA fix wave takes small fixes.\n",
    "GUIDE.md": "# Guide\n",
    "handbook/taste.md":
      "# Taste\n\n- **Default on silence:** a recommendation stands. Never (`--waits`): money, data (2026-01-01)\n",
    "handbook/roles/backlog.md": role("backlog"),
    "handbook/roles/hotfix.md": role("hotfix"),
    "handbook/roles/slice.md": role("slice"),
    "handbook/roles/lead.md": role("lead"),
    "handbook/roles/planner.md":
      "## What to ask\n\nAsk what changes the plan.\n\n**Unattended** runs take the defaults.\n\n" +
      "## The skeptic pass\n\nA skeptic reads the plan first.\n",
    "handbook/roles/recovery.md": role("recovery"),
    "tools/checks": "smoke 60 no\n",
    "tools/check-areas": "* -\n",
    "scripts/ci/tier-data.mjs": readFileSync(join(LOOPS, "../ci/tier-data.mjs"), "utf8"),
    "scripts/ci/ci-lists.mjs": readFileSync(join(LOOPS, "../ci/ci-lists.mjs"), "utf8"),
  };
}

/**
 * @param {string} main where the repo goes (made if missing)
 * @param {{ config?: string, files?: Record<string, string> }} [opts]
 * @returns {Record<string, any>} the repo's config
 */
export function makeRepo(main, { config = SAMPLE_CONFIG, files = {} } = {}) {
  const parsed = JSON.parse(readFileSync(config, "utf8"));
  mkdirSync(main, { recursive: true });
  // The scripts alone: no tests or prompt goldens, which no copied script reads, and
  // not the boundary's manifest and allowlist, which describe this checkout.
  cpSync(LOOPS, join(main, "scripts/loops"), {
    recursive: true,
    filter: (src) =>
      !src.endsWith(".test.mjs") &&
      !src.endsWith("golden.txt") &&
      !/\/boundary\.(manifest|allowlist)$/.test(src),
  });
  copyFileSync(config, join(main, CONFIG_NAME));
  // A hook's script: its command's first word, or the one after bash or node.
  const hookScripts = Object.values(parsed.hooks ?? {}).map((/** @type {string} */ c) => {
    const words = c.split(" ");
    return ["bash", "node"].includes(words[0] ?? "") ? words[1] : words[0];
  });
  for (const rel of [parsed.paths.tierData, parsed.paths.checkPlanRules, ...hookScripts]) {
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
