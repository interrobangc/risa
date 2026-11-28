// new.sh slice reads the slice's section from the committed plan on the prd/ tip: a
// slice whose heading is only in the working tree's plan is refused, no branch made
// (RISA-1015); once committed it starts, and a topic with no plan file starts as
// before. A throwaway repo with the stub stack hook and fake pnpm, lsof and nvm.
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
  const newSlice = (topic, n) => {
    const r = spawnSync("bash", [join(main, "loops/new.sh"), "slice", topic, String(n)], {
      cwd: main,
      env,
      encoding: "utf8",
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
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

  it("starts a slice of a topic with no plan file, as before", () => {
    const r = newSlice("u", 1);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("plan: slice 1 says Stack: no");
    expect(existsSync(join(loops, "u-1"))).toBe(true);
  });
});
