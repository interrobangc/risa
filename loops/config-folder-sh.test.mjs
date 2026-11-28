// The bash callers find a repo's config in either form (RISA-796): bin/risa's backlog
// route (backlog-config.sh: the main checkout's config, from the main checkout and a
// worktree), rm.sh's re-point of a config inside the worktree it removes to the main
// checkout's, and lib.sh's stack_hook from the repo root when the config is in no
// checkout. On a sample repo in the .risa folder form and one in the risa.json form;
// every machine config here is a temp file, none the machine's.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CONFIG_DIR, CONFIG_FILE, CONFIG_NAME } from "./config.mjs";
import { SAMPLE_CONFIG, makeRepo, sampleData } from "./sample-project/repo.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const RISA = join(HERE, "../bin/risa");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "config-folder-sh-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const { RISA_CONFIG: _c, RISA_CONFIG_FOUND: _f, RISA_MAIN: _m, ...env } = process.env;
const git = (/** @type {string} */ cwd, /** @type {string[]} */ ...a) =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// A standing topic's row with hot files (rm.sh clears them), and items with these titles.
const backlogText = (/** @type {string[]} */ ...titles) =>
  `# Backlog\n\n## Topics\n\n| PRD | Flags | After | Hot files | Doc and notes |\n| --- | ----- | ----- | --------- | ------------- |\n| \`fixes-x\` | standing | — | \`web/\` | a fixes wave |\n\n## Items\n\n${titles
    .map((t, i) => `### SAM-${i + 1} · bug · ${t}\n\n- status: triaged\n`)
    .join("\n")}`;

// The sample's data, with that backlog and an archive the registry reads.
const files = (/** @type {string[]} */ ...titles) => ({
  ...sampleData(),
  "work/backlog.md": backlogText(...titles),
  "work/archive.md": "# Archive\n\n## Items\n",
});

const FORMS = /** @type {const} */ ([
  { form: "the .risa folder", folder: true, rel: join(CONFIG_DIR, CONFIG_FILE) },
  { form: "risa.json", folder: false, rel: CONFIG_NAME },
]);

describe.each(FORMS)("a repo with its config in $form form", ({ folder, rel }) => {
  const main = mkdtempSync(join(tmp, "repo-"));
  makeRepo(main, { folder, files: files("First") });
  const machine = join(tmp, `machine-${folder}.json`);
  writeFileSync(machine, JSON.stringify({ repos: [{ path: main }] }));
  const run = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {object} */ opts) =>
    spawnSync(cmd, args, { encoding: "utf8", ...opts });

  it("risa backlog list reads the main checkout's backlog, from it and from a worktree", () => {
    const wt = `${main}-wt`;
    git(main, "worktree", "add", "-q", "-b", "wt", wt);
    // Only the main checkout's copy has the second item.
    writeFileSync(join(main, "work/backlog.md"), backlogText("First", "Second"));
    const list = (/** @type {string} */ cwd) =>
      run(RISA, ["backlog", "list", "--json"], { cwd, env: { ...env, RISA_MACHINE_CONFIG: machine } });
    for (const cwd of [main, wt]) {
      const r = list(cwd);
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).map((/** @type {{ id: string }} */ i) => i.id)).toEqual(["SAM-1", "SAM-2"]);
    }
  });

  // With no machine config, the backlog step after the removal (the repo's own copy of
  // the tool: makeRepo's loops/, and backlog/ beside it) takes RISA_CONFIG as rm.sh
  // left it: the hot files clear only when it names the main checkout's config.
  it("rm.sh re-points a config inside the worktree it removes to the main checkout's", () => {
    const repo = mkdtempSync(join(tmp, "rm-"));
    makeRepo(repo, { folder, files: files("First") });
    cpSync(join(HERE, "../backlog"), join(repo, "backlog"), {
      recursive: true,
      filter: (src) => !src.endsWith(".test.mjs"),
    });
    const dir = join(repo, ".loops/fixes-x");
    mkdirSync(join(repo, ".loops"), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", "topic/fixes-x", dir);
    const own = join(dir, rel);
    const who = {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    const r = run("bash", [join(repo, "loops/rm.sh"), "fixes-x"], {
      cwd: repo,
      env: {
        ...env,
        ...who,
        RISA_MACHINE_CONFIG: "",
        RISA_CONFIG: own,
        RISA_CONFIG_FOUND: own,
        RISA_RUN_LOG: join(tmp, "run-log.jsonl"),
      },
    });
    expect(r.stderr).not.toMatch(/no project config|couldn't clear/);
    expect(r.stdout).toMatch(/Cleared fixes-x's hot files/);
    expect(r.status).toBe(0);
    expect(readFileSync(join(repo, "work/backlog.md"), "utf8")).toMatch(
      /\| `fixes-x` \| standing \| — \| — \|/,
    );
  });

  it("stack_hook runs the hook from the repo root when the config is in no checkout", () => {
    const top = mkdtempSync(join(tmp, "no-checkout-"));
    const raw = JSON.parse(readFileSync(SAMPLE_CONFIG, "utf8"));
    raw.hooks = { stackStatus: 'echo "top=$PWD"' };
    mkdirSync(join(top, folder ? CONFIG_DIR : ""), { recursive: true });
    writeFileSync(join(top, rel), JSON.stringify(raw));
    const r = run(
      "bash",
      ["-c", `set -euo pipefail; source "${join(HERE, "lib.sh")}"; stack_hook stackStatus`],
      {
        cwd: tmp,
        env: { ...env, RISA_MACHINE_CONFIG: "", RISA_CONFIG: join(top, rel) },
      },
    );
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(`top=${top}\n`);
  });
});
