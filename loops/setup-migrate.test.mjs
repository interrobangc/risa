// risa config migrate (loops/setup.mjs) on a source git doesn't track: a git-ignored rule
// file, or an untracked one git status hides (status.showUntrackedFiles=no). Migrate
// refuses before it moves or stages anything, and runs as before once the file is
// tracked. Throwaway repos in the OS temp dir; the machine config is a temp file.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CONFIG_DIR, CONFIG_FILE, CONFIG_NAME } from "./config.mjs";
import { SAMPLE_CONFIG, makeRepo } from "./sample-project/repo.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const RISA = join(HERE, "../bin/risa");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "setup-migrate-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const machine = join(tmp, "machine.json");
writeFileSync(machine, JSON.stringify({ repos: [] }));
const { RISA_CONFIG: _c, RISA_CONFIG_FOUND: _f, RISA_MAIN: _m, ...base } = process.env;
const env = { ...base, RISA_MACHINE_CONFIG: machine };

const git = (/** @type {string} */ cwd, /** @type {string[]} */ ...a) =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (/** @type {string} */ root, /** @type {string} */ msg) =>
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", msg);
const run = (/** @type {string} */ cwd, /** @type {string[]} */ args) =>
  spawnSync(RISA, args, { cwd, encoding: "utf8", env });

// A sample config in the risa.json form naming its quarantine list by key (a rule file
// migrate moves).
const oldConfig = join(tmp, "old-config", CONFIG_NAME);
const raw = JSON.parse(readFileSync(SAMPLE_CONFIG, "utf8"));
raw.paths.quarantine = "tools/quarantine.txt";
delete raw.paths.checkPlanRules;
mkdirSync(join(tmp, "old-config", "tools"), { recursive: true });
writeFileSync(oldConfig, `${JSON.stringify(raw, null, 2)}\n`);
writeFileSync(
  join(tmp, "old-config", "tools/tiers.json"),
  readFileSync(join(HERE, "sample-project/tools/tiers.json")),
);
const QUARANTINE = "tools/quarantine.txt";

/** A repo whose quarantine list is git-ignored, so never committed. */
const ignoredRepo = () => {
  const root = mkdtempSync(join(tmp, "ignored-"));
  makeRepo(root, {
    config: oldConfig,
    files: { ".gitignore": `.loops/\n${QUARANTINE}\n`, [QUARANTINE]: "flaky.test.mjs\n" },
  });
  return root;
};

/** A repo whose quarantine list is untracked, with git status hiding untracked files. */
const hiddenRepo = () => {
  const root = mkdtempSync(join(tmp, "hidden-"));
  makeRepo(root, { config: oldConfig, files: { [QUARANTINE]: "flaky.test.mjs\n" } });
  git(root, "rm", "-q", "--cached", "--", QUARANTINE);
  commit(root, "chore: untrack the quarantine list");
  git(root, "config", "status.showUntrackedFiles", "no");
  return root;
};

describe("risa config migrate with an untracked source", () => {
  const cases = /** @type {const} */ ([
    ["a git-ignored rule file", ignoredRepo, /tools\/quarantine\.txt \(ignored\): not tracked/],
    [
      "an untracked one under status.showUntrackedFiles=no",
      hiddenRepo,
      /tools\/quarantine\.txt: not tracked/,
    ],
  ]);

  it.each(cases)(
    "refuses %s, moving and staging nothing, then migrates once it's tracked",
    (_w, make, line) => {
      const root = make();
      expect(git(root, "status", "--porcelain")).toBe("");
      for (const args of [
        ["config", "migrate", "--dry-run"],
        ["config", "migrate"],
      ]) {
        const r = run(root, args);
        expect(r.status).toBe(2);
        expect(r.stdout).toBe("");
        expect(r.stderr).toMatch(line);
        expect(r.stderr).toMatch(/track it .* or move it by hand/);
        expect(r.stderr.trim().split("\n")).toHaveLength(1);
        expect(existsSync(join(root, CONFIG_NAME))).toBe(true);
        expect(existsSync(join(root, QUARANTINE))).toBe(true);
        expect(existsSync(join(root, CONFIG_DIR))).toBe(false);
        expect(git(root, "diff", "--cached", "--name-status")).toBe("");
      }

      git(root, "add", "-f", "--", QUARANTINE);
      commit(root, "chore: track the quarantine list");
      const r = run(root, ["config", "migrate"]);
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`moved ${CONFIG_NAME} → ${CONFIG_DIR}/${CONFIG_FILE}`);
      expect(r.stdout).toContain(`moved ${QUARANTINE} → ${CONFIG_DIR}/quarantine.txt`);
      expect(git(root, "diff", "--cached", "--name-status").split("\n")).toEqual(
        expect.arrayContaining([
          expect.stringMatching(new RegExp(`^R\\d+\\t${CONFIG_NAME}\\t${CONFIG_DIR}/${CONFIG_FILE}$`)),
          expect.stringMatching(new RegExp(`^R\\d+\\t${QUARANTINE}\\t${CONFIG_DIR}/quarantine\\.txt$`)),
        ]),
      );
    },
  );
});
