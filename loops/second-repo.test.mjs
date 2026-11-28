// The second repo, end to end (RISA-797): a fresh fictional repo that isn't Node
// (a Makefile is its toolchain), with its own trunk (`trunk`) and branch prefixes
// (topic/, part/, draft/, quick/), run from `risa init` to a landing through this
// checkout's bin/risa, as a project that installs Risa would. Offline and hermetic:
// a bare origin, a temp machine config listing the repo (RISA_MACHINE_CONFIG), a
// temp HOME (no ~/.risa), no RISA_CONFIG or CLAUDE_CONFIG_DIR, a `gh` stub that
// knows the repo's trunk and prefixes (second-repo-gh.sh), a claude stub that
// opens nothing (RISA_CLAUDE_BIN), and the land seam (RISA_PR_THROWAWAY: the
// topic has "throwaway" in its name), which stops before the merge.
//
// The onboarding a user does after init is the test's too: the folder's two CI
// lists (init writes the tier data, the check plan's rules, the check hook and the
// skeptic brief's docs) and the repo's own prefixes. A second case builds the same repo on risa.json, its rule files
// under tools/, migrates it (`risa config migrate`) and runs the same check.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONFIG_DIR, CONFIG_FILE, CONFIG_NAME, RULE_FILES } from "./config.mjs";
import { initFiles } from "./setup.mjs";

const LOOPS = dirname(fileURLToPath(import.meta.url));
const RISA = join(LOOPS, "..", "bin", "risa");
const TOPIC = "throwaway-ledger";
const TRUNK = "trunk";
const PREFIXES = { prd: "topic/", slice: "part/", plan: "draft/", hotfix: "quick/" };
const PRD_BRANCH = `${PREFIXES.prd}${TOPIC}`;
const SLICE_BRANCH = `${PREFIXES.slice}${TOPIC}/1`;
const INIT = ["--name", "ledger", "--trunk", TRUNK, "--check", "make check"];
// Each case runs dozens of git commands, a check and a landing: generous under load.
const LONG = 240_000;

// init's own files: the config, its tier data and check plan rules, the backlog's three,
// the skeptic brief's docs.
const INIT_FILES = initFiles({ name: "ledger", trunk: TRUNK, check: "make check" });
const TIERS = JSON.parse(INIT_FILES[`${CONFIG_DIR}/tiers.json`] ?? "{}");
// The two CI lists init leaves to the user, by RULE_FILES' default names.
const LISTS = {
  "brake-list.txt": "# The ledger's brake list: one glob or check:<name> a line.\n",
  "quarantine.txt": "# The ledger's quarantine: none yet.\n",
};
/** Each rule file's text by its default name: init's two, then the two lists. */
const RULES = {
  ...Object.fromEntries(
    RULE_FILES.map(([, name]) => [name, INIT_FILES[`${CONFIG_DIR}/${name}`]]).filter(([, t]) => t),
  ),
  ...LISTS,
};

let root, repo, origin, env;
const prdDir = () => join(repo, ".loops", TOPIC);
const sliceDir = () => join(repo, ".loops", `${TOPIC}-1`);

/** CMD ARGS in CWD with the test's environment (and EXTRA): the result, its exit unchecked. */
const run = (cmd, args, cwd, extra = {}) =>
  spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...env, ...extra } });
/** Like run, but the step must exit 0; its stdout. */
const ok = (cmd, args, cwd, extra = {}) => {
  const r = run(cmd, args, cwd, extra);
  expect(r.status, `${cmd} ${args.join(" ")}\n${r.stdout}${r.stderr}`).toBe(0);
  return r.stdout;
};
const risa = (args, cwd = repo, extra = {}) => ok(RISA, args, cwd, extra);
const git = (cwd, ...args) => ok("git", args, cwd).trim();
/** Write FILES (path from DIR → text). */
const write = (dir, files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
};
/** The config file at PATH, changed by CHANGE. */
const editJson = (path, change) => {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  change(raw);
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
};

/** The user's own edit after init: the repo's prefixes. */
const onboard = (/** @type {Record<string, any>} */ c) => {
  c.branches.prefixes = PREFIXES;
};

/** The ledger before Risa: a Makefile project, its agents doc, one commit on trunk, pushed. */
function makeLedger() {
  execFileSync("git", ["init", "-q", "--bare", "-b", TRUNK, origin]);
  execFileSync("git", ["init", "-q", "-b", TRUNK, repo]);
  git(repo, "remote", "add", "origin", origin);
  write(repo, {
    ".gitignore": ".loops/\nto-test/\n",
    Makefile: 'check:\n\t@test -f README.md && echo "make check: ok"\n',
    "README.md": "# Ledger\n\nA fictional ledger, kept with make.\n",
    "AGENTS.md": "# Ledger: agents\n\nRun `make check` before handing off.\n",
  });
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "chore: start the ledger");
  git(repo, "push", "-q", "origin", TRUNK);
}

/** The config check and the project-data check, on the repo's own config. */
function checkConfig() {
  const at = { RISA_CONFIG: join(repo, CONFIG_DIR) };
  expect(ok("node", [join(LOOPS, "config.mjs"), "where", repo], repo).trim()).toBe(
    join(repo, CONFIG_DIR, CONFIG_FILE),
  );
  ok("node", [join(LOOPS, "config.mjs"), "check"], repo, at);
  expect(ok("node", [join(LOOPS, "project-check.mjs")], repo, at)).toContain("project-check: ok");
}

/** A PRD worktree and a slice worktree (no session), a change in the slice, its check. */
function sliceAndCheck() {
  risa(["start", TOPIC]);
  expect(git(prdDir(), "branch", "--show-current")).toBe(PRD_BRANCH);
  risa(["slice", TOPIC, "1"], prdDir());
  expect(git(sliceDir(), "branch", "--show-current")).toBe(SLICE_BRANCH);
  write(sliceDir(), { "src/export.c": "int main(void) { return 0; }\n" });
  git(sliceDir(), "add", "-A");
  git(sliceDir(), "commit", "-qm", `feat(${TOPIC}): export the ledger`);
  const out = risa(["check", "--quick", "slice hand-off"], sliceDir());
  expect(out).toContain("make check: ok");
  expect(out).toContain(`quick check passed`);
  expect(out).toContain(`(${SLICE_BRANCH})`);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "second-repo-")));
  repo = join(root, "ledger");
  origin = join(root, "origin.git");
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "home"));
  copyFileSync(join(LOOPS, "second-repo-gh.sh"), join(root, "bin", "gh"));
  writeFileSync(join(root, "bin", "claude-stub"), '#!/bin/sh\necho "no session in this test" >&2\nexit 1\n');
  for (const f of ["gh", "claude-stub"]) chmodSync(join(root, "bin", f), 0o755);
  writeFileSync(join(root, "machine.json"), JSON.stringify({ repos: [{ path: repo, work: true }] }));
  env = { ...process.env };
  // The repo's config is found from its checkout, never a pinned one; no account's dir.
  for (const name of ["RISA_CONFIG", "RISA_CONFIG_FOUND", "RISA_TEST_CONFIG", "CLAUDE_CONFIG_DIR"])
    delete env[name];
  Object.assign(env, {
    HOME: join(root, "home"),
    RISA_MACHINE_CONFIG: join(root, "machine.json"),
    RISA_CLAUDE_BIN: join(root, "bin", "claude-stub"),
    RISA_RUN_LOG: join(root, "run-log.jsonl"),
    RISA_LANDING_DIR: join(root, "landing"),
    RISA_NOTICES_DIR: join(root, "notices"),
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    GIT_AUTHOR_NAME: "T",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "T",
    GIT_COMMITTER_EMAIL: "t@example.com",
  });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a second repo, from risa init to a landing", () => {
  it(
    "inits, checks, files, works a slice, checks it and lands to the seam",
    () => {
      makeLedger();
      const init = risa(["init", ...INIT]);
      expect(init).toContain(`wrote ${CONFIG_DIR}/${CONFIG_FILE}`);
      for (const rel of Object.keys(INIT_FILES)) expect(init).toContain(`wrote ${rel}`);
      // The user's part: the two CI lists, their edits, the commit init names.
      write(join(repo, CONFIG_DIR), LISTS);
      editJson(join(repo, CONFIG_DIR, CONFIG_FILE), onboard);
      git(repo, "add", CONFIG_DIR, "plans", "docs");
      git(repo, "commit", "-qm", "chore: start risa");
      git(repo, "push", "-q", "origin", TRUNK);
      checkConfig();

      // The backlog: an item for the topic, and the topic's row.
      expect(risa(["backlog", "add", "feature", "A ledger export", "--prd", TOPIC])).toContain(
        "added LEDGER-1",
      );
      risa(["backlog", "prd", "add", TOPIC]);
      const items = JSON.parse(risa(["backlog", "list", "--prd", TOPIC, "--json"]));
      expect(items).toMatchObject([{ id: "LEDGER-1", title: "A ledger export", prd: TOPIC }]);
      expect(JSON.parse(risa(["backlog", "prd", "list", "--json"]))).toMatchObject([{ topic: TOPIC }]);

      sliceAndCheck();
      // The orchestrator's merge of the slice into its PRD branch.
      git(prdDir(), "merge", "-q", "--no-ff", "-m", `chore(${TOPIC}): merge slice 1`, SLICE_BRANCH);
      const tip = git(repo, "rev-parse", PRD_BRANCH);

      // The landing: an open PR whose head is the tip, Codex clean on it, CI green at its tier.
      writeFileSync(
        join(root, "verdict.json"),
        JSON.stringify({
          version: 1,
          commit: tip,
          runId: "11",
          tier: "check",
          ranTier: "check",
          kind: "green",
          flaky: [],
          brake: { jobs: [], tests: [], files: [] },
          failed: { tests: [], files: [], jobs: [] },
        }),
      );
      const codex = `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: tip, status: "completed" } })} -->`;
      const subject = `feat(${TOPIC}): export the ledger (LEDGER-1)`;
      const out = risa(["land", TOPIC, "-m", subject], repo, {
        RISA_PR_THROWAWAY: "1",
        GH_TRUNK: TRUNK,
        GH_PRD_PREFIX: PREFIXES.prd,
        GH_HEAD_REF: PRD_BRANCH,
        PR_HEAD: tip,
        PR_COMMENTS: JSON.stringify([
          {
            author: { login: "chatgpt-codex-connector" },
            body: codex,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ]),
        GH_RUN_PREFIX: TIERS.refPrefix,
        GH_CI_SHA: tip,
        GH_CI_TIER: "check",
        GH_CI_VERDICT: join(root, "verdict.json"),
        GH_LOG: join(root, "gh.log"),
      });
      expect(out).toContain("tier: tier check (proposed check: a file no rule covers (src/export.c))");
      expect(out).toContain(`codex: clean on ${tip.slice(0, 7)}`);
      expect(out).toContain(`check: CI green at check on ${tip.slice(0, 7)} (run 11)`);
      expect(out).toContain(
        `RISA_PR_THROWAWAY: every refusal passed; stopping before the merge. It would push ${TRUNK}`,
      );
      expect(out).toContain(`--match-head-commit ${tip}`);
      // Nothing went up: origin has only its trunk, where it was.
      expect(git(origin, "for-each-ref", "--format=%(refname)")).toBe(`refs/heads/${TRUNK}`);
      expect(readFileSync(join(root, "gh.log"), "utf8")).not.toContain("pr merge");
      // The backlog still shows the item with its topic.
      expect(JSON.parse(risa(["backlog", "list", "--json"]))).toMatchObject([{ id: "LEDGER-1", prd: TOPIC }]);
    },
    LONG,
  );

  it(
    "a risa.json copy of the same repo migrates and passes the same check",
    () => {
      makeLedger();
      // The same config on risa.json, its rule files under tools/ by paths keys.
      const plansFiles = Object.entries(INIT_FILES).filter(([rel]) => !rel.startsWith(`${CONFIG_DIR}/`));
      const raw = JSON.parse(INIT_FILES[`${CONFIG_DIR}/${CONFIG_FILE}`] ?? "{}");
      onboard(raw);
      raw.paths.tooling = [CONFIG_NAME];
      for (const [key, name] of RULE_FILES) raw.paths[key] = `tools/${name}`;
      write(repo, {
        ...Object.fromEntries(plansFiles),
        [CONFIG_NAME]: `${JSON.stringify(raw, null, 2)}\n`,
        ...Object.fromEntries(RULE_FILES.map(([, name]) => [`tools/${name}`, RULES[name] ?? ""])),
      });
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "chore: start risa");

      const out = risa(["config", "migrate"]);
      expect(out).toContain(`moved ${CONFIG_NAME} → ${CONFIG_DIR}/${CONFIG_FILE}`);
      for (const [, name] of RULE_FILES) expect(out).toContain(`moved tools/${name} → ${CONFIG_DIR}/${name}`);
      git(repo, "commit", "-qm", "chore: move the risa config into .risa/");
      const moved = JSON.parse(readFileSync(join(repo, CONFIG_DIR, CONFIG_FILE), "utf8"));
      for (const [key] of RULE_FILES) expect(moved.paths[key]).toBeUndefined();
      expect(moved.paths.tooling).toEqual([CONFIG_DIR]);
      checkConfig();
      sliceAndCheck();
    },
    LONG,
  );
});
