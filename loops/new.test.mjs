// new.sh slice reads the slice's section from the committed plan on the prd/ tip: a
// slice whose heading is only in the working tree's plan is refused, no branch made
// (RISA-1015); once committed it starts, and a topic with no plan file starts as
// before. prd.sh's <command> --help prints that command's usage and its new.sh
// wrappers refuse an unknown flag, making nothing (RISA-1086). A throwaway repo with the stub stack hook and fake pnpm, lsof and nvm.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stubHookConfig } from "./config-fixture.mjs";

const HERE = new URL(".", import.meta.url).pathname;

const PLAN = `# Plan: T

## Slice 1: First

Stack: no · Reads: none · Tests: unit
`;
const SLICE_2 = `
## Slice 2: Second

Stack: no · Reads: none · Tests: unit · Check: loops/x.test.mjs
`;

describe("new.sh slice and the committed plan", () => {
  let root, main, loops, env;
  const git = (cwd, ...a) =>
    execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
  const newSh = (...args) => {
    const r = spawnSync("bash", [join(main, "loops/new.sh"), ...args], {
      cwd: main,
      env,
      encoding: "utf8",
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const newSlice = (topic, n) => newSh("slice", topic, String(n));
  const prdSh = (...args) => {
    const r = spawnSync("bash", [join(main, "loops/prd.sh"), ...args], {
      cwd: main,
      env,
      encoding: "utf8",
    });
    return { status: r.status, stdout: r.stdout, out: `${r.stdout}${r.stderr}` };
  };
  const heads = () => git(main, "for-each-ref", "--format=%(refname:short)", "refs/heads/");
  const loopsDirs = () => (existsSync(loops) ? readdirSync(loops).sort() : []);
  const branch = (b) => git(main, "branch", "--list", b);

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "new-sh-")));
    main = join(root, "repo");
    loops = join(main, ".loops");
    const bin = join(root, "bin");
    const nvm = join(root, "nvm");
    mkdirSync(bin);
    mkdirSync(nvm);
    writeFileSync(join(bin, "pnpm"), "#!/usr/bin/env bash\nexit 0\n");
    writeFileSync(join(bin, "lsof"), "#!/usr/bin/env bash\nexit 1\n");
    for (const f of ["pnpm", "lsof"]) chmodSync(join(bin, f), 0o755);
    writeFileSync(join(nvm, "nvm.sh"), "nvm() { :; }\n");
    env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      SAMPLE_STACK_STATE: join(root, "stack-state"),
      NVM_DIR: nvm,
      TRUNK: "dev",
      RISA_FREE_GB: "100",
      RISA_MIN_FREE_GB: "",
      RISA_MAX_PRDS: "",
      RISA_LOAD_GATE: "off",
      RISA_LEASE_ROOT: join(root, "leases"),
      RISA_USAGE_DIR: join(root, "usage"),
      RISA_SESSIONS_DIR: "",
      RISA_USAGE_WATCH: "",
      RISA_USAGE_DRAIN: "",
      RISA_USAGE_STOP: "",
      RISA_USAGE_STALE_MIN: "",
    };
    execFileSync("git", ["init", "-q", "-b", "dev", main]);
    for (const [k, v] of [
      ["user.email", "test@example.com"],
      ["user.name", "Test"],
      ["commit.gpgsign", "false"],
    ])
      git(main, "config", k, v);
    mkdirSync(join(main, "loops"), { recursive: true });
    for (const f of readdirSync(HERE).filter(
      (f) => f.endsWith(".sh") || (f.endsWith(".mjs") && !f.endsWith(".test.mjs")),
    ))
      copyFileSync(join(HERE, f), join(main, "loops", f));
    env.RISA_CONFIG = stubHookConfig(main);
    writeFileSync(join(main, ".gitignore"), ".loops/\n.env\n.env.*\n.postgres/\n");
    mkdirSync(join(main, "plans"));
    writeFileSync(join(main, "plans/t-plan.md"), PLAN);
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", "chore: init");
    git(main, "branch", "prd/t");
    git(main, "branch", "prd/u");
    git(main, "checkout", "-q", "prd/t");
    mkdirSync(join(main, "db"), { recursive: true });
    mkdirSync(join(main, "web"), { recursive: true });
    writeFileSync(join(main, "db/.env"), 'DATABASE_URL="x"\nSEED_USER_PASSWORD="pw-fictional"\n');
    writeFileSync(join(main, "web/.env"), 'BETTER_AUTH_URL="x"\nCRON_SECRET="s"\n');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("refuses a slice whose section is only in the working tree's plan, then starts it once committed", () => {
    writeFileSync(join(main, "plans/t-plan.md"), PLAN + SLICE_2);
    let r = newSlice("t", 2);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(
      'refused: slice t-2: no "Slice 2" section in the committed plan (prd/t:plans/t-plan.md); commit the plan first',
    );
    expect(branch("slice/t/2")).toBe("");
    expect(existsSync(join(loops, "t-2"))).toBe(false);

    git(main, "commit", "-q", "-am", "docs: plan slice 2");
    r = newSlice("t", 2);
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toContain("refused");
    expect(branch("slice/t/2")).not.toBe("");
    expect(existsSync(join(loops, "t-2"))).toBe(true);
  });

  it("refuses a topic that starts with a dash, making no worktree and no branch (RISA-1070)", () => {
    const before = { heads: heads(), dirs: loopsDirs() };
    for (const [kind, topic] of [
      ["plan", "--help"],
      ["plan", "-x"],
      ["prd", "-a"],
    ]) {
      const r = newSh(kind, topic);
      expect(r.status, r.out).not.toBe(0);
      expect(r.out).toContain(
        `refused: topic "${topic}": lowercase letters, digits and dashes, starting with a letter or digit`,
      );
    }
    expect(heads()).toBe(before.heads);
    expect(loopsDirs()).toEqual(before.dirs);
  });

  it("starts a plan worktree for a valid topic, as before", () => {
    const r = newSh("plan", "v-1");
    expect(r.status, r.out).toBe(0);
    expect(branch("plan/v-1")).not.toBe("");
    expect(existsSync(join(loops, "plan-v-1"))).toBe(true);
  });

  it("starts a slice of a topic with no plan file, as before", () => {
    const r = newSlice("u", 1);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("plan: slice 1 says Stack: no");
    expect(existsSync(join(loops, "u-1"))).toBe(true);
  });

  it("prints a command's usage for <command> --help or -h, making nothing (RISA-1086)", () => {
    const before = { heads: heads(), dirs: loopsDirs() };
    for (const [args, line] of [
      [["plan", "--help"], /^ {4}plan <topic> \[--open\]/m],
      [["slice", "-h"], /^ {4}slice <topic> <n> /m],
      [["land", "--help"], /^ {4}land <topic> \[-m subject\]/m],
    ]) {
      const r = prdSh(...args);
      expect(r.status, r.out).toBe(0);
      expect(r.stdout).toMatch(line);
      // Only that command's lines, not the whole text.
      expect(r.stdout).not.toContain("See what's going on");
      expect(r.out).not.toContain("refused");
    }
    expect(heads()).toBe(before.heads);
    expect(loopsDirs()).toEqual(before.dirs);
  });

  it("refuses an unknown flag to plan, start, slice and hotfix, making nothing (RISA-1086)", () => {
    const before = { heads: heads(), dirs: loopsDirs() };
    for (const [args, flag] of [
      [["plan", "--bogus", "topic"], "--bogus"],
      [["start", "-x"], "-x"],
      [["slice", "t", "3", "--stack"], "--stack"],
      [["hotfix", "h-1", "--nope"], "--nope"],
    ]) {
      const r = prdSh(...args);
      expect(r.status, r.out).not.toBe(0);
      expect(r.out).toContain(`${args[0]}: unknown flag ${flag}`);
      expect(r.out).toMatch(new RegExp(`^ {4}${args[0]} <`, "m"));
    }
    expect(heads()).toBe(before.heads);
    expect(loopsDirs()).toEqual(before.dirs);
  });

  it("keeps risa help and a valid plan <topic> as before (RISA-1086)", () => {
    let r = prdSh("help");
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toContain("See what's going on");
    expect(r.stdout).toMatch(/^ {4}land <topic>/m);
    r = prdSh("plan", "w-1");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("Start its planning session");
    expect(branch("plan/w-1")).not.toBe("");
    expect(existsSync(join(loops, "plan-w-1"))).toBe(true);
  });
});
