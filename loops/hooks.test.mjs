// hooks.mjs, the project's hooks from Node, on configs written to a throwaway
// folder (RISA_CONFIG): an unset hook, where a hook runs and what it's given,
// and reading its facts; and that a project with no stackEngine or testDb hook
// has nothing for recover to start.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_CONFIG } from "./config-fixture.mjs";
import { fact, factList, runHook } from "./hooks.mjs";
import { collectFacts } from "./inventory-facts.mjs";
import { inventory } from "./inventory.mjs";

const HERE = new URL(".", import.meta.url).pathname;

let root;
/** A config like this repo's, with these hooks only; its path as RISA_CONFIG. */
const withHooks = (name, hooks) => {
  const raw = JSON.parse(readFileSync(FIXTURE_CONFIG, "utf8"));
  raw.hooks = hooks;
  const file = join(root, `${name}.json`);
  writeFileSync(file, JSON.stringify(raw));
  return { ...process.env, RISA_CONFIG: file };
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hooks-test-")));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("runHook", () => {
  it("gives 127, and says why, for a hook the config doesn't set", () => {
    const r = runHook("stackReady", ["x"], { env: withHooks("none", {}) });
    expect(r).toEqual({ status: 127, ok: false, out: "", err: "no hooks.stackReady in the config" });
  });

  it("runs from the config's folder when that is no checkout, its args after the command, and passes env on", () => {
    const env = {
      ...withHooks("echo", {
        stackStatus: 'printf "%s\\n" "top=$PWD" "mark=$HOOK_MARK"; printf "arg=%s\\n"',
      }),
    };
    env.HOOK_MARK = "m1";
    const r = runHook("stackStatus", ["a b", "c"], { env });
    expect(r.ok).toBe(true);
    expect(fact("top", r.out)).toBe(root);
    expect(fact("mark", r.out)).toBe("m1");
    expect(factList("arg", r.out)).toEqual(["a b", "c"]);
  });

  // B-846: the tool lives outside the project, so a stack hook runs from the top of
  // the project's main checkout (of the repo its config is in), never the tool's,
  // and never a worktree's, even when the config is the worktree's own (RISA-972).
  it("runs from the top of the main checkout the config is in, from Node and from lib.sh's stack_hook", () => {
    const project = join(root, "project");
    mkdirSync(join(project, "tools"), { recursive: true });
    execFileSync("git", ["init", "-q", project]);
    const raw = JSON.parse(readFileSync(FIXTURE_CONFIG, "utf8"));
    raw.hooks = { stackStatus: 'echo "top=$PWD"' };
    // A config below the top: the hook still runs from the top.
    writeFileSync(join(project, "tools/risa.json"), JSON.stringify(raw));
    const env = { ...process.env, RISA_CONFIG: join(project, "tools/risa.json"), RISA_MACHINE_CONFIG: "" };
    expect(fact("top", runHook("stackStatus", [], { env }).out)).toBe(project);
    const sh = execFileSync("bash", ["-c", `source "${join(HERE, "lib.sh")}" && stack_hook stackStatus`], {
      cwd: root,
      encoding: "utf8",
      env,
    });
    expect(fact("top", sh.trim())).toBe(project);

    // A worktree of the project with its own config: stack hooks still run from
    // the main checkout; run_hook (a non-stack hook) from the worktree's top.
    const git = (/** @type {string[]} */ ...a) =>
      execFileSync("git", ["-C", project, ...a], { stdio: "ignore" });
    git(
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@example.test",
      "commit",
      "-q",
      "--allow-empty",
      "--no-verify",
      "-m",
      "init",
    );
    const wt = join(root, "project-wt");
    git("worktree", "add", "-q", "-b", "wt", wt);
    raw.hooks = { stackStatus: 'echo "top=$PWD"', checkAreas: 'echo "top=$PWD"' };
    writeFileSync(join(wt, "risa.json"), JSON.stringify(raw));
    const wtEnv = { ...env, RISA_CONFIG: join(wt, "risa.json") };
    expect(fact("top", runHook("stackStatus", [], { env: wtEnv }).out)).toBe(project);
    const both = execFileSync(
      "bash",
      ["-c", `source "${join(HERE, "lib.sh")}" && stack_hook stackStatus && run_hook checkAreas`],
      { cwd: wt, encoding: "utf8", env: wtEnv },
    );
    expect(factList("top", both.trim())).toEqual([project, wt]);
  });

  // Under set -euo pipefail, git's failure in no checkout must still fall back.
  it("runs a stack hook from the config's folder when that is no checkout, under set -euo pipefail", () => {
    const env = withHooks("strict", { stackStatus: 'echo "top=$PWD"' });
    const sh = execFileSync(
      "bash",
      ["-c", `set -euo pipefail; source "${join(HERE, "lib.sh")}"; stack_hook stackStatus`],
      { cwd: root, encoding: "utf8", env },
    );
    expect(fact("top", sh.trim())).toBe(root);
  });

  it("gives a failing hook's exit status and its stderr", () => {
    const r = runHook("stackReady", [], {
      env: withHooks("fail", { stackReady: "echo half=1; echo boom >&2; exit 3" }),
    });
    expect(r).toEqual({ status: 3, ok: false, out: "half=1", err: "boom" });
  });
});

describe("fact and factList", () => {
  const out = "volume=a 1 x\nproject=p1\nvolume=b 2 y\nproject=p2\nempty=\nsummary=a=b";
  it("fact takes a key's last value, and nothing for none", () => {
    expect(fact("project", out)).toBe("p2");
    expect(fact("summary", out)).toBe("a=b");
    expect(fact("empty", out)).toBe("");
    expect(fact("missing", out)).toBe("");
    expect(fact("proj", out)).toBe("");
  });
  it("factList takes every value of a repeated key, in order", () => {
    expect(factList("volume", out)).toEqual(["a 1 x", "b 2 y"]);
    expect(factList("missing", out)).toEqual([]);
  });
});

describe("a project with no stack hooks", () => {
  it("has no engine to start and no test database to bring up", () => {
    const main = join(root, "main");
    mkdirSync(join(main, ".loops"), { recursive: true });
    const env = withHooks("stackless", {});
    const facts = collectFacts({ main, env });
    expect(facts.docker).toEqual({ running: true });
    expect(facts.testDb).toEqual({ running: true });
    const steps = inventory(facts).actions.map((a) => a.step);
    expect(steps).not.toContain("docker start");
    expect(steps).not.toContain("test-db up");
  });
});
