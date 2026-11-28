// The Node callers find a repo's config in either form (RISA-796): the machine
// config's checkout choice (machine.mjs repo), the project-data check's default path
// and the skeptic's rules reader, on a sample repo in the .risa folder form and one in
// the risa.json form. Every machine config here is a temp file; none is the machine's.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CONFIG_DIR, CONFIG_FILE, CONFIG_NAME, loadConfig } from "./config.mjs";
import { projectProblems } from "./project-check.mjs";
import { SAMPLE_CONFIG, makeRepo, sampleData } from "./sample-project/repo.mjs";
import { readRules } from "./skeptics.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "config-folder-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const { RISA_CONFIG: _, ...env } = process.env;
const git = (/** @type {string} */ cwd, /** @type {string[]} */ ...a) =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const FORMS = /** @type {const} */ ([
  { form: "the .risa folder", folder: true, rel: join(CONFIG_DIR, CONFIG_FILE) },
  { form: "risa.json", folder: false, rel: CONFIG_NAME },
]);

describe.each(FORMS)("a repo with its config in $form form", ({ folder, rel }) => {
  // The main checkout, a worktree with its own config (the committed one), and a
  // worktree whose config was removed: it reads the main checkout's.
  const main = mkdtempSync(join(tmp, "repo-"));
  makeRepo(main, { folder, files: sampleData() });
  const own = `${main}-own`;
  const bare = `${main}-bare`;
  git(main, "worktree", "add", "-q", "-b", "own", own);
  git(main, "worktree", "add", "-q", "-b", "bare", bare);
  rmSync(join(bare, rel));
  const machine = join(tmp, `machine-${folder}.json`);
  writeFileSync(machine, JSON.stringify({ repos: [{ path: main }] }));
  const repo = (/** @type {string} */ cwd) =>
    spawnSync(process.execPath, [join(HERE, "machine.mjs"), "repo", "--cwd", cwd], {
      encoding: "utf8",
      env: { ...env, RISA_MACHINE_CONFIG: machine },
    });

  it("machine.mjs repo prints the main checkout and the config: the worktree's own, else the main's", () => {
    expect(repo(main)).toMatchObject({ status: 0, stdout: `${main}\n${join(main, rel)}\n` });
    expect(repo(own)).toMatchObject({ status: 0, stdout: `${main}\n${join(own, rel)}\n` });
    expect(repo(bare)).toMatchObject({ status: 0, stdout: `${main}\n${join(main, rel)}\n` });
  });

  it("the project-data check passes, from its CLI and with the default path", () => {
    const cli = spawnSync(process.execPath, [join(main, "loops/project-check.mjs")], {
      cwd: main,
      encoding: "utf8",
      env,
    });
    expect(cli).toMatchObject({ status: 0, stdout: "project-check: ok\n" });
    const { config, root } = loadConfig({ path: join(main, rel) });
    expect(root).toBe(main);
    expect(projectProblems({ config, root })).toEqual([]);
  });

  it("readRules(root) reads the rules through the repo's own config", () => {
    expect(readRules(main).neverList).toBe("money, data");
  });
});

describe("a checkout with both forms", () => {
  it("machine.mjs repo stops with one line naming both; readRules throws the loader's error", () => {
    const main = mkdtempSync(join(tmp, "both-"));
    makeRepo(main, { folder: true, files: sampleData() });
    copyFileSync(SAMPLE_CONFIG, join(main, CONFIG_NAME));
    const machine = join(tmp, "machine-both.json");
    writeFileSync(machine, JSON.stringify({ repos: [{ path: main }] }));
    const r = spawnSync(process.execPath, [join(HERE, "machine.mjs"), "repo", "--cwd", main], {
      encoding: "utf8",
      env: { ...env, RISA_MACHINE_CONFIG: machine },
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      `machine.mjs: ${join(main, CONFIG_DIR, CONFIG_FILE)} and ${join(main, CONFIG_NAME)}: two project configs; keep one\n`,
    );
    expect(() => readRules(main)).toThrow("two project configs");
  });
});
