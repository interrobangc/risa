// rm.sh keeps a topic's cost ledger (cost.mjs, RISA-560): against a throwaway repo
// with the loops scripts copied in (stack.test.mjs's rm fixtures, with no stack
// or testDb hooks) and a made-up transcript under RISA_CLAUDE_PROJECTS, rm of a
// prd/<t> worktree writes .loops/.cost/<t>.json first, a ledger it can't write
// is one line and no stop, and `risa cost <t> --json` reads the ledger once the
// transcripts are gone.
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.mjs";
import { FIXTURE_CONFIG, fixtureTierData, stubHookConfig } from "./config-fixture.mjs";
import { projectFolder } from "./host.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const PREFIX = `${loadConfig({ path: FIXTURE_CONFIG }).config.name.toUpperCase().replace(/-/g, "_")}_`;
const INHERITED = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith(PREFIX)));
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
const OPUS = "claude-opus-5-5";
const HAIKU = "claude-haiku-5-5";

/** An assistant line of message ID on BRANCH. */
const reply = (id, model, output, branch) =>
  JSON.stringify({
    type: "assistant",
    gitBranch: branch,
    message: {
      id,
      model,
      role: "assistant",
      usage: {
        input_tokens: 10,
        output_tokens: output,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 5,
      },
    },
  });

let root, main, loops, projects, env;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "rm-ledger-test-")));
  main = join(root, "repo");
  loops = join(main, ".loops");
  projects = join(root, "projects");
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(projects);
  writeFileSync(join(bin, "pnpm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  execFileSync("git", ["init", "-q", "-b", "dev", main]);
  for (const [k, v] of [
    ["user.email", "test@example.com"],
    ["user.name", "Test"],
    ["commit.gpgsign", "false"],
  ])
    git(main, "config", k, v);
  for (const d of ["loops", "backlog"]) {
    mkdirSync(join(main, d), { recursive: true });
    const from = join(HERE, "..", d);
    for (const f of readdirSync(from).filter((f) => /\.(mjs|sh)$/.test(f) && !f.includes(".test.")))
      copyFileSync(join(from, f), join(main, d, f));
  }
  // The sample config with no stack or testDb hooks: rm skips those steps.
  const config = stubHookConfig(main, { copy: true });
  const raw = JSON.parse(readFileSync(config, "utf8"));
  for (const h of Object.keys(raw.hooks)) if (/^stack|^testDb$/.test(h)) delete raw.hooks[h];
  writeFileSync(config, `${JSON.stringify(raw, null, 2)}\n`);
  const ciDir = join(HERE, "../ci");
  mkdirSync(join(main, "ci"), { recursive: true });
  for (const f of ["outstanding.mjs", "tier-data.mjs"]) copyFileSync(join(ciDir, f), join(main, "ci", f));
  fixtureTierData(main);
  writeFileSync(join(main, ".gitignore"), ".loops/\n.sample-*\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "chore: init");
  mkdirSync(loops);
  env = {
    ...INHERITED,
    PATH: `${bin}:${process.env.PATH}`,
    TRUNK: "dev",
    RISA_CONFIG: config,
    RISA_MACHINE_CONFIG: join(root, "no-machine.json"),
    RISA_CLAUDE_PROJECTS: projects,
    RISA_RUN_LOG: join(root, "run-log.jsonl"),
    RISA_SESSIONS_DIR: join(root, "sessions"),
    BACKLOG_BY: "",
  };
  delete env.RISA_MAIN;
  delete env.RISA_CONFIG_FOUND;
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const run = (script, args) => {
  const r = spawnSync("bash", [join(main, "loops", script), ...args], { cwd: main, encoding: "utf8", env });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
};

/** A prd/<topic> worktree with one session transcript of two messages (one streamed twice). */
const worktreeWithTranscript = (topic) => {
  git(main, "branch", `prd/${topic}`);
  git(main, "worktree", "add", "-q", join(loops, topic), `prd/${topic}`);
  const folder = join(projects, projectFolder(join(loops, topic)));
  mkdirSync(folder, { recursive: true });
  const b = `prd/${topic}`;
  writeFileSync(
    join(folder, "s1.jsonl"),
    [reply("m1", OPUS, 1, b), reply("m1", OPUS, 7, b), reply("m2", HAIKU, 3, b)].join("\n") + "\n",
  );
  return folder;
};

describe("rm.sh keeps the cost ledger (RISA-560)", () => {
  it("writes .loops/.cost/<t>.json with its rows before removing a prd/ worktree", () => {
    const folder = worktreeWithTranscript("t");
    const r = run("rm.sh", ["t"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toMatch(/cost ledger:/);
    expect(existsSync(join(loops, "t"))).toBe(false);
    const ledger = JSON.parse(readFileSync(join(loops, ".cost/t.json"), "utf8"));
    expect(ledger.topic).toBe("t");
    expect(ledger.rows).toEqual([
      { id: "m1", model: OPUS, input: 10, output: 7, cacheRead: 100, cacheWrite: 5, line: "orchestration" },
      { id: "m2", model: HAIKU, input: 10, output: 3, cacheRead: 100, cacheWrite: 5, line: "orchestration" },
    ]);

    // The transcripts go (Claude Code's cleanup): risa cost reads the ledger.
    rmSync(folder, { recursive: true, force: true });
    const cost = run("prd.sh", ["cost", "t", "--json"]);
    expect(cost.code, cost.out).toBe(0);
    const report = JSON.parse(cost.stdout);
    expect(report.files).toBe(0);
    expect(report.total).toEqual({
      messages: 2,
      models: {
        [OPUS]: { input: 10, output: 7, cacheRead: 100, cacheWrite: 5 },
        [HAIKU]: { input: 10, output: 3, cacheRead: 100, cacheWrite: 5 },
      },
    });
  });

  it("prints one line and still removes the worktree when the ledger can't be written", () => {
    worktreeWithTranscript("u");
    // A file where the ledger folder goes: nothing can be written under it.
    const costDir = join(loops, ".cost");
    const kept = existsSync(costDir) ? readdirSync(costDir) : [];
    rmSync(costDir, { recursive: true, force: true });
    writeFileSync(costDir, "not a folder\n");
    try {
      const r = run("rm.sh", ["u"]);
      expect(r.code, r.out).toBe(0);
      expect(r.out.match(/^cost ledger: .*$/gm)).toEqual([
        expect.stringMatching(/^cost ledger: \S.* \(rm goes on\)$/),
      ]);
      expect(existsSync(join(loops, "u"))).toBe(false);
    } finally {
      rmSync(costDir, { force: true });
    }
    expect(kept).toContain("t.json");
  });

  it("routes risa cost to the report, with a usage line", () => {
    const help = run("prd.sh", ["help"]);
    expect(help.stdout).toMatch(/^ {4}cost \[<topic>\] \[--json\] /m);
  });
});
