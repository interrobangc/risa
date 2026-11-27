// The disk guard (lib.sh: free_gb, require_disk, disk_line) and its callers:
// new.sh for a stacked worktree, stack.sh up, browser.sh's check build, and the
// status line. A throwaway repo with these scripts copied in, fake pnpm, lsof
// and df, the stack hooks on the sample project's stub, and RISA_FREE_GB
// standing in for the real reading: nothing here touches real containers,
// slots, worktrees or the disk.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
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
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stubHookConfig } from "./config-fixture.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();

const PLAN = `# Plan: T

## Slice 1: Stackless

Stack: no · Reads: none · Tests: unit

## Slice 2: Needs a stack

Stack: yes · Reads: none · Tests: unit
`;

// df -Pk: 12 GB available (12 * 1024 * 1024 KB).
const FAKE_DF = `#!/usr/bin/env bash
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "/dev/fake 999999999 1 12582912 1% /"
`;

let root, main, loops, log, env;
const sh = (script, args = [], opts = {}) =>
  spawnSync("bash", [join(main, "loops", script), ...args], {
    cwd: opts.cwd ?? main,
    encoding: "utf8",
    env: { ...env, ...opts.env },
    input: "",
  });
const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
const leases = () => (existsSync(join(loops, ".slots")) ? readdirSync(join(loops, ".slots")) : []);
const LOW = { RISA_FREE_GB: "9" };
const ROOMY = { RISA_FREE_GB: "10" };

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "disk-test-")));
  main = join(root, "repo");
  loops = join(main, ".loops");
  log = join(root, "calls.log");
  const bin = join(root, "bin");
  const nvm = join(root, "nvm");
  mkdirSync(bin);
  mkdirSync(nvm);
  writeFileSync(join(bin, "pnpm"), '#!/usr/bin/env bash\necho "pnpm $*" >> "$FAKE_LOG"\n');
  writeFileSync(join(bin, "lsof"), "#!/usr/bin/env bash\nexit 1\n");
  writeFileSync(join(bin, "df"), FAKE_DF);
  for (const f of ["pnpm", "lsof", "df"]) chmodSync(join(bin, f), 0o755);
  writeFileSync(join(nvm, "nvm.sh"), "nvm() { :; }\n");
  env = {
    ...process.env,
    PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
    NVM_DIR: nvm,
    FAKE_LOG: log,
    TRUNK: "dev",
    RISA_FREE_GB: "",
    RISA_MIN_FREE_GB: "",
    RISA_LEASE_ROOT: join(root, "leases"),
    RISA_BROWSER_LEASES: join(root, "leases/browser"),
    RISA_BROWSER_FLAKES: join(root, "flakes.log"),
    RISA_BROWSER_BUSY: "100000",
    RISA_BROWSER_SILENCE: "10",
    SAMPLE_STACK_STATE: join(root, "stack-state"),
    SAMPLE_STACK_LOG: log,
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
    (f) => f.endsWith(".sh") || f === "slice-fields.mjs" || f === "config.mjs",
  ))
    copyFileSync(join(HERE, f), join(main, "loops", f));
  // The stack hooks (serve among them, which browser.sh calls to start and build
  // the check server) on the sample project's stub, logging to FAKE_LOG.
  env.RISA_CONFIG = stubHookConfig(main);
  // The checks manifest, which the fixture names none of: this test's own (paths.checksManifest).
  const raw = JSON.parse(readFileSync(env.RISA_CONFIG, "utf8"));
  raw.paths.checksManifest = "tools/checks";
  writeFileSync(env.RISA_CONFIG, `${JSON.stringify(raw, null, 2)}\n`);
  // The manifest, where the config puts it (paths.checksManifest).
  const manifest = join(main, JSON.parse(readFileSync(env.RISA_CONFIG, "utf8")).paths.checksManifest);
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(manifest, "# check cap never-exits e2e\nclean 20 no yes\n");
  // The check, for the sample's browser hook (stubHookConfig points it there).
  mkdirSync(join(main, "tools/browser-checks"), { recursive: true });
  writeFileSync(
    join(main, "tools/browser-checks/clean.mjs"),
    'console.log("PASS clean (1ms)\\n1/1 passed");\n',
  );
  writeFileSync(join(main, ".nvmrc"), `${process.versions.node.split(".")[0]}\n`);
  writeFileSync(join(main, ".gitignore"), ".loops/\n.env\n.env.*\n.postgres/\n");
  mkdirSync(join(main, "plans"));
  writeFileSync(join(main, "plans/t-plan.md"), PLAN);
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "chore: init");
  git(main, "branch", "prd/t");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => rmSync(log, { force: true }));

const refused = (r, what) => {
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain(`Refusing ${what}: only 9 GB free`);
  expect(r.stderr).toMatch(/under the 10 GB line \(RISA_MIN_FREE_GB\)/);
  expect(r.stderr).toMatch(/pnpm prd reclaim/);
};

describe("the reading", () => {
  const lib = (body, extra = {}) =>
    spawnSync("bash", ["-c", `source loops/lib.sh; ${body}`], {
      cwd: main,
      encoding: "utf8",
      env: { ...env, ...extra },
    });

  it("reads whole GB free from df on the main checkout's volume", () => {
    expect(lib("free_gb").stdout.trim()).toBe("12");
  });

  it("takes RISA_FREE_GB over df, and RISA_MIN_FREE_GB as the line", () => {
    expect(lib("free_gb", { RISA_FREE_GB: "3.7" }).stdout.trim()).toBe("3");
    expect(lib("min_free_gb").stdout.trim()).toBe("10");
    expect(lib("min_free_gb", { RISA_MIN_FREE_GB: "25" }).stdout.trim()).toBe("25");
    expect(lib("min_free_gb", { RISA_MIN_FREE_GB: "lots" }).status).not.toBe(0);
  });

  it("allows exactly the line, refuses under it, and moves with RISA_MIN_FREE_GB", () => {
    expect(lib("require_disk x", ROOMY).status).toBe(0);
    expect(lib("require_disk x", LOW).status).not.toBe(0);
    expect(lib("require_disk x", { RISA_FREE_GB: "9", RISA_MIN_FREE_GB: "5" }).status).toBe(0);
    expect(lib("require_disk x", { RISA_FREE_GB: "12", RISA_MIN_FREE_GB: "20" }).status).not.toBe(0);
    // The real df reading (12 GB) against a 20 GB line.
    expect(lib("require_disk x", { RISA_MIN_FREE_GB: "20" }).stderr).toMatch(/only 12 GB free/);
  });
});

describe("new.sh", () => {
  it("refuses a stacked worktree below the line, before leasing a slot or making it", () => {
    const r = sh("new.sh", ["slice", "t", "2"], { env: LOW });
    refused(r, "a new stack for t-2");
    expect(existsSync(join(loops, "t-2"))).toBe(false);
    expect(leases()).toEqual([]);
    expect(calls()).not.toMatch(/pnpm install/);
  });

  it("refuses under a raised line too", () => {
    const r = sh("new.sh", ["slice", "t", "2"], {
      env: { RISA_FREE_GB: "40", RISA_MIN_FREE_GB: "50" },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/only 40 GB free.*under the 50 GB line/);
  });

  it("never refuses a stackless worktree", () => {
    const r = sh("new.sh", ["slice", "t", "1"], { env: { RISA_FREE_GB: "1" } });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(loops, "t-1"))).toBe(true);
  });

  it("makes a stacked worktree at the line", () => {
    const r = sh("new.sh", ["slice", "t", "2"], { env: ROOMY });
    expect(r.status, r.stderr).toBe(0);
    expect(leases()).toEqual(["1"]);
    expect(calls()).toMatch(/^stack up t-2 --slot 1 /m);
  });
});

describe("stack.sh up", () => {
  it("refuses below the line and changes nothing", () => {
    const dir = join(loops, "t-1");
    const r = sh("stack.sh", ["up"], { cwd: dir, env: LOW });
    refused(r, "a stack for t-1");
    expect(existsSync(join(dir, ".sample-stack"))).toBe(false);
    expect(leases()).toEqual(["1"]);
    expect(calls()).not.toMatch(/^stack up/m);
  });

  it("refuses to restart a stopped stack below the line, and starts it above", () => {
    const dir = join(loops, "t-2");
    refused(sh("stack.sh", ["up"], { cwd: dir, env: LOW }), "a stack for t-2");
    const r = sh("stack.sh", ["up"], { cwd: dir, env: { RISA_FREE_GB: "9", RISA_MIN_FREE_GB: "8" } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/already has a stack/);
    expect(calls()).toMatch(/^stack up t-2 /m);
  });
});

describe("browser.sh's check build", () => {
  // t-2 has a stack (a WEB_PORT), so its checks run against a check build.
  const browser = (extra) => sh("browser.sh", ["clean"], { cwd: join(loops, "t-2"), env: extra });

  it("refuses the build below the line, and runs no check", () => {
    const r = browser(LOW);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("Refusing a check build: only 9 GB free");
    expect(r.stderr).toMatch(/pnpm prd reclaim/);
    expect(calls()).not.toMatch(/serve/);
    expect(r.stdout).not.toMatch(/■ clean/);
  });

  it("builds and runs the check at the line", { timeout: 60_000 }, () => {
    const r = browser(ROOMY);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(calls()).toMatch(/serve t-2 --built/);
    expect(r.stdout).toMatch(/■ clean\.mjs: pass/);
  });
});

describe("pnpm prd status", () => {
  it("prints the disk line, flagged when low", () => {
    const ok = sh("ls.sh", [], { env: { RISA_FREE_GB: "120" } });
    expect(ok.stdout).toMatch(/^disk: 120 GB free \(line 10 GB\)$/m);
    const low = sh("ls.sh", [], { env: LOW });
    expect(low.stdout).toMatch(
      /^disk: 9 GB free \(line 10 GB\) · LOW: new stacks and check builds are refused: pnpm prd reclaim$/m,
    );
  });
});

// new.sh runs the project's commands from the config, and names branches by its
// prefixes: a sample config with other ones changes what runs. The stack's own
// migrate and seed are the stackUp hook's.
describe("new.sh through the config", () => {
  it("runs the config's install, hooks install and stack hook, on the config's branch", () => {
    const raw = JSON.parse(readFileSync(env.RISA_CONFIG, "utf8"));
    Object.assign(raw.commands, {
      install: "pnpm i --offline",
      hooksInstall: 'echo hooks-install >> "$FAKE_LOG"',
    });
    raw.branches.prefixes.hotfix = "quick/";
    const sample = join(root, "sample.json");
    writeFileSync(sample, JSON.stringify(raw));
    const r = sh("new.sh", ["--stack", "hotfix", "q"], { env: { ...ROOMY, RISA_CONFIG: sample } });
    expect(r.status, r.stderr).toBe(0);
    expect(calls()).toMatch(
      /^hooks-install\nstack down hotfix-q --base dev\ntest-db use hotfix-q\npnpm i --offline\nstack up hotfix-q --slot \d+ --base dev\n/m,
    );
    expect(calls()).not.toMatch(/pnpm install/);
    expect(git(join(loops, "hotfix-q"), "branch", "--show-current")).toBe("quick/q");
  });
});
