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
const TOP = execFileSync("git", ["-C", HERE, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

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

  it("runs from the top of the tool's checkout, its args after the command, and passes env on", () => {
    const env = {
      ...withHooks("echo", {
        stackStatus: 'printf "%s\\n" "top=$PWD" "mark=$HOOK_MARK"; printf "arg=%s\\n"',
      }),
    };
    env.HOOK_MARK = "m1";
    const r = runHook("stackStatus", ["a b", "c"], { env });
    expect(r.ok).toBe(true);
    expect(fact("top", r.out)).toBe(realpathSync(TOP));
    expect(fact("mark", r.out)).toBe("m1");
    expect(factList("arg", r.out)).toEqual(["a b", "c"]);
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
