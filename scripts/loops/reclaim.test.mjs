// pnpm prd reclaim (reclaim.sh) against a throwaway repo with these scripts
// copied in, the stack hooks on the sample project's stub (its leftovers in its
// state), and fake du, lsof, pnpm and nvm on PATH: nothing here touches real
// containers, volumes, images, worktrees or the disk.
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
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stubHookConfig } from "./config-fixture.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();

const PLAN = `# Plan: T

## Slice 1: Active

Stack: no · Reads: none · Tests: unit

## Slice 3: Merged

Stack: no · Reads: none · Tests: unit

## Slice 5: Merged, then dirty

Stack: no · Reads: none · Tests: unit
`;

// The stub's leftovers (stack-hook.sh): ID KB why. sample-loop7_data is the
// active slice's project's, so the stub leaves it out.
const LEFTOVERS = [
  "volume=sample-loop9_data 12500 dangling; no worktree uses sample-loop9",
  "volume=sample-loop7_data 3000 dangling; no worktree uses sample-loop7",
  "volume=abc123 21 dangling, anonymous",
  "image=sha256img 120000 dangling image",
  "kept=volume sample_data: the main checkout's",
].join("\n");

let config;
let root, main, loops, log, env;
const sh = (args = [], opts = {}) =>
  spawnSync("bash", [join(main, "scripts/loops/reclaim.sh"), ...args], {
    cwd: main,
    encoding: "utf8",
    env: { ...env, ...opts.env },
    input: opts.input ?? "",
  });
const ok = (args, opts) => {
  const r = sh(args, opts);
  if (r.status !== 0) throw new Error(`reclaim ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};
const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
const removals = () =>
  calls()
    .split("\n")
    .filter((l) => l.startsWith("stack leftovers remove "));
const put = (...p) => {
  mkdirSync(join(...p), { recursive: true });
  writeFileSync(join(...p, "f"), "x\n");
};

// The caches reclaim frees in a .loops worktree, and the main checkout's copies
// it must keep.
const CACHES = ["web/build", "node_modules/.vite", "web/app/node_modules/.vite"];

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "reclaim-test-")));
  main = join(root, "repo");
  loops = join(main, ".loops");
  log = join(root, "calls.log");
  const bin = join(root, "bin");
  const nvm = join(root, "nvm");
  mkdirSync(bin);
  mkdirSync(nvm);
  writeFileSync(join(bin, "pnpm"), '#!/usr/bin/env bash\necho "pnpm $*" >> "$FAKE_LOG"\n');
  // Listening only on FAKE_LISTEN's port.
  writeFileSync(
    join(bin, "lsof"),
    '#!/usr/bin/env bash\n[[ -n ${FAKE_LISTEN:-} && "$*" == *":$FAKE_LISTEN "* ]] && { echo 4242; exit 0; }\nexit 1\n',
  );
  // 2 MB for anything.
  writeFileSync(join(bin, "du"), '#!/usr/bin/env bash\nprintf "2048\\t%s\\n" "${@: -1}"\n');
  for (const f of ["pnpm", "lsof", "du"]) chmodSync(join(bin, f), 0o755);
  writeFileSync(join(nvm, "nvm.sh"), "nvm() { :; }\n");
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    NVM_DIR: nvm,
    FAKE_LOG: log,
    TRUNK: "dev",
    RISA_FREE_GB: "42",
    RISA_MIN_FREE_GB: "",
    RISA_LEASE_ROOT: join(root, "leases"),
    SAMPLE_STACK_STATE: join(root, "stack-state"),
    SAMPLE_STACK_LOG: log,
  };
  mkdirSync(env.SAMPLE_STACK_STATE);
  writeFileSync(join(env.SAMPLE_STACK_STATE, "leftovers"), `${LEFTOVERS}\n`);

  execFileSync("git", ["init", "-q", "-b", "dev", main]);
  for (const [k, v] of [
    ["user.email", "test@example.com"],
    ["user.name", "Test"],
    ["commit.gpgsign", "false"],
  ])
    git(main, "config", k, v);
  mkdirSync(join(main, "scripts/loops"), { recursive: true });
  for (const f of readdirSync(HERE).filter(
    (f) => f.endsWith(".sh") || ["slice-fields.mjs", "config.mjs", "host.mjs"].includes(f),
  ))
    copyFileSync(join(HERE, f), join(main, "scripts/loops", f));
  config = stubHookConfig(main);
  // The check build on the sample project's path, not the fixture config's own.
  const raw = JSON.parse(readFileSync(config, "utf8"));
  writeFileSync(config, JSON.stringify({ ...raw, stack: { ...raw.stack, checkBuild: "web/build" } }));
  env.RISA_CONFIG = config;
  mkdirSync(join(main, "scripts/ci"), { recursive: true });
  for (const f of ["outstanding.mjs", "tier-data.mjs", "tiers.json"])
    copyFileSync(join(HERE, "../ci", f), join(main, "scripts/ci", f));
  writeFileSync(join(main, ".gitignore"), ".loops/\n.env\n.env.*\n.postgres/\nnode_modules/\nbuild/\n");
  mkdirSync(join(main, "plans"));
  writeFileSync(join(main, "plans/t-plan.md"), PLAN);
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "chore: init");
  git(main, "branch", "prd/t");

  const run = (...a) =>
    execFileSync("bash", [join(main, "scripts/loops/new.sh"), ...a], { env, stdio: "pipe" });
  for (const n of ["1", "3", "5"]) run("slice", "t", n);
  // Slices 3 and 5 are merged into prd/t; 5 then picks up uncommitted work.
  const prd = join(root, "prd-t");
  git(main, "worktree", "add", "-q", prd, "prd/t");
  for (const n of ["3", "5"]) {
    const dir = join(loops, `t-${n}`);
    writeFileSync(join(dir, `work-${n}.txt`), "done\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", `feat(t): slice ${n}`);
    git(prd, "merge", "--no-ff", "-q", "-m", `feat(t): merge slice ${n}`, `slice/t/${n}`);
  }
  // Their wave has landed, so nothing holds them for a fix.
  git(main, "merge", "--no-ff", "-q", "-m", "feat(t): land the wave", "prd/t");
  writeFileSync(join(loops, "t-5", "work-5.txt"), "more, not committed\n");
  // Slice 1 is active, with a stack named sample-loop7 (its volume is in use).
  writeFileSync(join(loops, "t-1", ".sample-stack"), "project=sample-loop7\n");
  for (const c of CACHES) {
    put(loops, "t-1", c);
    put(main, c);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => rmSync(log, { force: true }));

describe("reclaim --list", () => {
  it("lists what can go, with sizes and a total, and changes nothing", () => {
    const out = ok(["--list"]);
    expect(out).toMatch(/^disk: 42 GB free \(line 10 GB\)$/m);
    expect(out).toMatch(/^ {2}worktree +2\.0 MB +t-3 \(slice\/t\/3 is merged into prd\/t\)$/m);
    expect(out).toMatch(/^ {2}build +2\.0 MB +t-1\/web\/build /m);
    expect(out).toMatch(/^ {2}vite +2\.0 MB +t-1\/node_modules\/\.vite /m);
    expect(out).toMatch(/^ {2}vite +2\.0 MB +t-1\/web\/app\/node_modules\/\.vite /m);
    expect(out).toMatch(
      /^ {2}volume +12\.2 MB +sample-loop9_data \(dangling; no worktree uses sample-loop9\)$/m,
    );
    expect(out).toMatch(/^ {2}volume +21 KB +abc123 \(dangling, anonymous\)$/m);
    expect(out).toMatch(/^ {2}image +117\.2 MB +sha256img /m);
    expect(out).toMatch(/^ {2}total +137\.4 MB in 7 item\(s\)$/m);

    expect(out).toMatch(/t-5: merged, but has uncommitted changes/);
    // The hook's kept= lines are kept; the active slice's project's volume isn't listed.
    expect(out).toMatch(/volume sample_data: the main checkout's/);
    expect(out).not.toMatch(/sample-loop7_data/);
    expect(calls()).toMatch(/^stack leftovers --all sample-loop7$/m);
    expect(out).not.toMatch(/t-5 \(/);

    expect(removals()).toEqual([]);
    for (const n of ["t-1", "t-3", "t-5"]) expect(existsSync(join(loops, n))).toBe(true);
    for (const c of CACHES) expect(existsSync(join(loops, "t-1", c))).toBe(true);
  });

  it("asks, and a no changes nothing", () => {
    const out = ok([], { input: "n\n" });
    expect(out).toMatch(/Nothing changed/);
    expect(removals()).toEqual([]);
    expect(existsSync(join(loops, "t-3"))).toBe(true);
  });

  it("keeps the caches of a worktree whose server is running", () => {
    const stack = join(loops, "t-1", ".sample-stack");
    writeFileSync(stack, "project=sample-loop7\nweb_port=6999\n");
    const out = ok(["--list"], { env: { FAKE_LISTEN: "6999" } });
    writeFileSync(stack, "project=sample-loop7\n");
    expect(out).toMatch(/t-1: its server is running, so its caches stay/);
    expect(out).not.toMatch(/^ {2}(build|vite) /m);
  });

  it("lists only the hook's kept line when the engine isn't running", () => {
    const down = join(env.SAMPLE_STACK_STATE, "engine-down");
    writeFileSync(down, "");
    const out = ok(["--list"]);
    rmSync(down);
    expect(out).toMatch(/the engine isn't running/);
    expect(out).not.toMatch(/^ {2}(volume|image) /m);
    expect(out).toMatch(/^ {2}worktree /m);
  });
});

// A config whose hooks are the stub's but for the named ones.
const configWith = (hooks) => {
  const c = JSON.parse(readFileSync(config, "utf8"));
  const file = join(root, `config-${Object.keys(hooks).join("-")}.json`);
  writeFileSync(file, JSON.stringify({ ...c, hooks: { ...c.hooks, ...hooks } }));
  return file;
};

describe("reclaim with a failing hook", () => {
  // Each would leave a project out of the ones in use, and its volumes would
  // look unused: reclaim stops instead, listing and removing nothing.
  it.each([
    ["the stack status hook fails", { stackStatus: "exit 3;" }, /stack status hook failed for t-\d/],
    ["the stack leftovers hook fails", { stackLeftovers: "exit 3;" }, /the stack leftovers hook failed/],
  ])("%s", (_, hooks, why) => {
    const r = sh(["--yes"], { env: { RISA_CONFIG: configWith(hooks) } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(why);
    expect(r.stdout).not.toMatch(/Can be freed|Freed/);
    expect(removals()).toEqual([]);
    for (const n of ["t-1", "t-3", "t-5"]) expect(existsSync(join(loops, n))).toBe(true);
    for (const c of CACHES) expect(existsSync(join(loops, "t-1", c))).toBe(true);
  });
});

describe("reclaim --yes", () => {
  it("keeps a merged slice whose wave hasn't landed", () => {
    const dir = join(loops, "t-8");
    git(main, "worktree", "add", "-q", "-b", "slice/t/8", dir, "prd/t");
    writeFileSync(join(dir, "work-8.txt"), "done\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "feat(t): slice 8");
    const prd = git(main, "worktree", "list", "--porcelain")
      .split("\n\n")
      .find((b) => b.includes("branch refs/heads/prd/t"))
      .match(/^worktree (.+)$/m)[1];
    git(prd, "merge", "--no-ff", "-q", "-m", "feat(t): merge slice 8", "slice/t/8");
    try {
      expect(ok(["--list"])).toMatch(/t-8: merged, but its wave hasn't landed/);
    } finally {
      git(main, "worktree", "remove", "--force", dir);
      git(prd, "reset", "-q", "--hard", "HEAD~1");
      git(main, "branch", "-q", "-D", "slice/t/8");
    }
  });

  it("frees what it listed, and keeps the rest", () => {
    const out = ok(["--yes"]);
    expect(out).toMatch(/^Freed 137\.4 MB\.$/m);

    // The merged worktree and its branch; not the dirty one.
    expect(existsSync(join(loops, "t-3"))).toBe(false);
    expect(git(main, "branch", "--list", "slice/t/3")).toBe("");
    expect(existsSync(join(loops, "t-5", "work-5.txt"))).toBe(true);
    expect(readFileSync(join(loops, "t-5", "work-5.txt"), "utf8")).toMatch(/not committed/);

    // Only the dangling sample-loop volume nobody uses, the anonymous one and the image.
    expect(removals()).toEqual([
      "stack leftovers remove volume sample-loop9_data",
      "stack leftovers remove volume abc123",
      "stack leftovers remove image sha256img",
    ]);

    // .loops caches go; the main checkout's stay; the active worktree stays.
    for (const c of CACHES) {
      expect(existsSync(join(loops, "t-1", c)), c).toBe(false);
      expect(existsSync(join(main, c)), c).toBe(true);
    }
    expect(existsSync(join(loops, "t-1"))).toBe(true);
  });

  it("then has nothing left but the dirty worktree", () => {
    const out = ok(["--list"]);
    expect(out).toMatch(/^Nothing to reclaim\.$/m);
    expect(out).toMatch(/t-5: merged, but has uncommitted changes/);
  });
});
