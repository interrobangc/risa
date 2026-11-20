// pnpm prd reclaim (reclaim.sh) against a throwaway repo with these scripts
// copied in, and fake docker, du, lsof, pnpm and nvm on PATH: nothing here
// touches real containers, volumes, images, worktrees or the disk.
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

// What `docker system df -v --format …` prints: name, size, links, labels.
const VOLUMES = [
  "caretook-loop9_data 12.5MB 0 com.docker.compose.project=caretook-loop9,com.docker.compose.volume=data",
  "caretook-loop7_data 3MB 0 com.docker.compose.project=caretook-loop7,com.docker.compose.volume=data",
  "caretook_data 5MB 0 com.docker.compose.project=caretook,com.docker.compose.volume=data",
  "caretook-shared-test_data 1MB 0 com.docker.compose.project=caretook-shared-test",
  "other_db 1GB 0 com.docker.compose.project=other,com.docker.compose.volume=db",
  "named-by-hand 2MB 0 ",
  "abc123 21.03kB 0 com.docker.volume.anonymous=",
  "linked 1MB 1 com.docker.compose.project=caretook-loop9",
].join("\n");

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
case $1 in
  info) [[ -z \${FAKE_DOCKER_DOWN:-} ]] || exit 1 ;;
  system) echo "$FAKE_VOLUMES" ;;
  images) echo "sha256img 120MB" ;;
esac
exit 0
`;

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
    .filter((l) => / (volume|image) rm /.test(l));
const put = (...p) => {
  mkdirSync(join(...p), { recursive: true });
  writeFileSync(join(...p, "f"), "x\n");
};

// The caches reclaim frees in a .loops worktree, and the main checkout's copies
// it must keep.
const CACHES = ["apps/web/build", "node_modules/.vite", "apps/web/node_modules/.vite"];

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "reclaim-test-")));
  main = join(root, "repo");
  loops = join(main, ".loops");
  log = join(root, "calls.log");
  const bin = join(root, "bin");
  const nvm = join(root, "nvm");
  mkdirSync(bin);
  mkdirSync(nvm);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  writeFileSync(join(bin, "pnpm"), '#!/usr/bin/env bash\necho "pnpm $*" >> "$FAKE_LOG"\n');
  // Listening only on FAKE_LISTEN's port.
  writeFileSync(
    join(bin, "lsof"),
    '#!/usr/bin/env bash\n[[ -n ${FAKE_LISTEN:-} && "$*" == *":$FAKE_LISTEN "* ]] && { echo 4242; exit 0; }\nexit 1\n',
  );
  // 2 MB for anything.
  writeFileSync(join(bin, "du"), '#!/usr/bin/env bash\nprintf "2048\\t%s\\n" "${@: -1}"\n');
  for (const f of ["docker", "pnpm", "lsof", "du"]) chmodSync(join(bin, f), 0o755);
  writeFileSync(join(nvm, "nvm.sh"), "nvm() { :; }\n");
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    NVM_DIR: nvm,
    FAKE_LOG: log,
    FAKE_VOLUMES: VOLUMES,
    TRUNK: "dev",
    CARETOOK_FREE_GB: "42",
    CARETOOK_MIN_FREE_GB: "",
    CARETOOK_SHARED_TEST_PORT: "",
    CARETOOK_SHARED_TEST_PROJECT: "",
    CARETOOK_LEASE_ROOT: join(root, "leases"),
  };

  execFileSync("git", ["init", "-q", "-b", "dev", main]);
  for (const [k, v] of [
    ["user.email", "test@example.com"],
    ["user.name", "Test"],
    ["commit.gpgsign", "false"],
  ])
    git(main, "config", k, v);
  mkdirSync(join(main, "scripts/loops"), { recursive: true });
  for (const f of readdirSync(HERE).filter((f) => f.endsWith(".sh") || f === "slice-fields.mjs"))
    copyFileSync(join(HERE, f), join(main, "scripts/loops", f));
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
  writeFileSync(join(loops, "t-5", "work-5.txt"), "more, not committed\n");
  // Slice 1 is active, with a stack named caretook-loop7 (its volume is in use).
  writeFileSync(join(loops, "t-1", ".env"), "CARETOOK_STACK=caretook-loop7\n");
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
    expect(out).toMatch(/^ {2}build +2\.0 MB +t-1\/apps\/web\/build /m);
    expect(out).toMatch(/^ {2}vite +2\.0 MB +t-1\/node_modules\/\.vite /m);
    expect(out).toMatch(/^ {2}vite +2\.0 MB +t-1\/apps\/web\/node_modules\/\.vite /m);
    expect(out).toMatch(
      /^ {2}volume +12\.2 MB +caretook-loop9_data \(dangling; no worktree uses caretook-loop9\)$/m,
    );
    expect(out).toMatch(/^ {2}volume +21 KB +abc123 \(dangling, anonymous\)$/m);
    expect(out).toMatch(/^ {2}image +117\.2 MB +sha256img /m);
    expect(out).toMatch(/^ {2}total +137\.4 MB in 7 item\(s\)$/m);

    expect(out).toMatch(/t-5: merged, but has uncommitted changes/);
    expect(out).toMatch(/volume caretook-loop7_data: caretook-loop7 is still in use/);
    expect(out).toMatch(/volume caretook_data: caretook is still in use/);
    expect(out).toMatch(/volume caretook-shared-test_data: caretook-shared-test is still in use/);
    expect(out).toMatch(/2 dangling volume\(s\) of other Compose projects/);
    for (const v of ["other_db", "named-by-hand", "linked"])
      expect(out).not.toMatch(new RegExp(`\\b${v}\\b`));
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
    writeFileSync(join(loops, "t-1", "apps/web/.env"), "WEB_PORT=6999\n");
    const out = ok(["--list"], { env: { FAKE_LISTEN: "6999" } });
    rmSync(join(loops, "t-1", "apps/web/.env"));
    expect(out).toMatch(/t-1: its server is running, so its caches stay/);
    expect(out).not.toMatch(/^ {2}(build|vite) /m);
  });

  it("skips Docker when it isn't running", () => {
    const out = ok(["--list"], { env: { FAKE_DOCKER_DOWN: "1" } });
    expect(out).toMatch(/Docker isn't running: volumes and images not checked/);
    expect(out).not.toMatch(/^ {2}(volume|image) /m);
    expect(out).toMatch(/^ {2}worktree /m);
  });
});

describe("reclaim --yes", () => {
  it("frees what it listed, and keeps the rest", () => {
    const out = ok(["--yes"]);
    expect(out).toMatch(/^Freed 137\.4 MB\.$/m);

    // The merged worktree and its branch; not the dirty one.
    expect(existsSync(join(loops, "t-3"))).toBe(false);
    expect(git(main, "branch", "--list", "slice/t/3")).toBe("");
    expect(existsSync(join(loops, "t-5", "work-5.txt"))).toBe(true);
    expect(readFileSync(join(loops, "t-5", "work-5.txt"), "utf8")).toMatch(/not committed/);

    // Only the dangling caretook-loop volume nobody uses, the anonymous one and the image.
    expect(removals()).toEqual([
      "docker volume rm caretook-loop9_data",
      "docker volume rm abc123",
      "docker image rm sha256img",
    ]);

    // .loops caches go; the main checkout's stay; the active worktree stays.
    for (const c of CACHES) {
      expect(existsSync(join(loops, "t-1", c)), c).toBe(false);
      expect(existsSync(join(main, c)), c).toBe(true);
    }
    expect(existsSync(join(loops, "t-1"))).toBe(true);
  });

  it("then has only Docker's (still faked) dangling items left", () => {
    const out = ok(["--list"]);
    expect(out).not.toMatch(/^ {2}(worktree|build|vite) /m);
    expect(out).toMatch(/t-5: merged, but has uncommitted changes/);
  });
});
