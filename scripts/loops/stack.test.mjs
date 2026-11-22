// Stacks, test databases and gc (new.sh, stack.sh, rm.sh, ls.sh, gc.sh,
// test-db.sh) against a throwaway repo with these scripts copied in, and fake
// docker, pnpm, lsof and nvm on PATH: nothing here touches real containers,
// slots or worktrees.
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
import { workerDatabaseName } from "../../packages/data/src/db/testDatabase.ts";

const HERE = new URL(".", import.meta.url).pathname;
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();

const PLAN = `# Plan: T

## Slice 1: Stackless

Stack: no · Reads: none · Tests: integration

## Slice 2: Needs a stack

Stack: yes · Reads: none · Tests: unit

## Slice 3: To be merged

Stack: no · Reads: none · Tests: unit

## Slice 4: No fields
`;

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
case $1 in
  ps)
    if [[ "$*" == *caretook-shared-test* ]]; then [[ -z \${FAKE_SHARED_ID:-} ]] || echo "$FAKE_SHARED_ID"
    elif [[ "$*" == *-aq* ]]; then [[ -z \${FAKE_STACK_IDS:-} ]] || echo "$FAKE_STACK_IDS"; fi ;;
  inspect) [[ -z \${FAKE_INSPECT:-} ]] || echo "$FAKE_INSPECT" ;;
  exec) [[ "$*" != *psql* ]] || printf '%s\n' "\${FAKE_PSQL:-0}" ;;
esac
exit 0
`;

let root, main, loops, log, env;
const sh = (script, args = [], opts = {}) =>
  spawnSync("bash", [join(main, "scripts/loops", script), ...args], {
    cwd: opts.cwd ?? main,
    encoding: "utf8",
    env: { ...env, ...opts.env },
    input: opts.input ?? "",
  });
const ok = (script, args, opts) => {
  const r = sh(script, args, opts);
  if (r.status !== 0) throw new Error(`${script} ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};
const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
const leases = () => (existsSync(join(loops, ".slots")) ? readdirSync(join(loops, ".slots")) : []);
const read = (...p) => readFileSync(join(...p), "utf8");

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "stack-test-")));
  main = join(root, "repo");
  loops = join(main, ".loops");
  log = join(root, "calls.log");
  const bin = join(root, "bin");
  const nvm = join(root, "nvm");
  mkdirSync(bin);
  mkdirSync(nvm);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  writeFileSync(join(bin, "pnpm"), '#!/usr/bin/env bash\necho "pnpm $*" >> "$FAKE_LOG"\n');
  writeFileSync(join(bin, "lsof"), "#!/usr/bin/env bash\nexit 1\n");
  for (const f of ["docker", "pnpm", "lsof"]) chmodSync(join(bin, f), 0o755);
  writeFileSync(join(nvm, "nvm.sh"), "nvm() { :; }\n");
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    NVM_DIR: nvm,
    FAKE_LOG: log,
    TRUNK: "dev",
    CARETOOK_SHARED_TEST_PORT: "",
    CARETOOK_GC_STOPPED_HOURS: "",
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
  writeFileSync(join(main, ".gitignore"), ".loops/\n.env\n.env.*\n.postgres/\n");
  mkdirSync(join(main, "plans"));
  writeFileSync(join(main, "plans/t-plan.md"), PLAN);
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "chore: init");
  git(main, "branch", "prd/t");
  // The main checkout's env files, which a stack copies its secrets from.
  mkdirSync(join(main, "packages/data"), { recursive: true });
  mkdirSync(join(main, "apps/web"), { recursive: true });
  writeFileSync(join(main, "packages/data/.env"), 'DATABASE_URL="x"\nSEED_USER_PASSWORD="pw-fictional"\n');
  writeFileSync(join(main, "apps/web/.env"), 'BETTER_AUTH_URL="x"\nCRON_SECRET="s"\n');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => rmSync(log, { force: true }));

describe("new.sh slice", () => {
  it("makes a Stack: no slice stackless, with its own test database", () => {
    const out = ok("new.sh", ["slice", "t", "1"]);
    expect(out).toMatch(/Stack: no/);
    const dir = join(loops, "t-1");
    expect(existsSync(join(dir, ".env"))).toBe(false);
    expect(read(dir, ".env.loop")).toBe("SLOT=\nBASE_BRANCH=prd/t\n");
    const testEnv = read(dir, "packages/data/.env.test.local");
    expect(testEnv).toMatch(/localhost:5436\/caretook_test_t_1"/);
    expect(testEnv).toMatch(/^PG_TEST_PORT=5436$/m);
    expect(testEnv).toMatch(/^SHARED_TEST_DB=1$/m);
    expect(leases()).toEqual([]);
    expect(calls()).toMatch(/pnpm install --frozen-lockfile/);
    expect(calls()).not.toMatch(/datastore/);
    expect(calls()).not.toMatch(/docker/);
  });

  it("gives a Stack: yes slice a slot and a stack, and no test container of its own", () => {
    const out = ok("new.sh", ["slice", "t", "2"]);
    expect(out).toMatch(/Stack: yes/);
    const dir = join(loops, "t-2");
    expect(read(dir, ".env")).toMatch(/^CARETOOK_STACK=caretook-loop1$/m);
    expect(read(dir, ".env.loop")).toMatch(/^SLOT=1$/m);
    expect(read(dir, ".env.loop")).toMatch(/^SEED_USER_PASSWORD=/m);
    expect(read(dir, "apps/web/.env")).toMatch(/^WEB_PORT=6173$/m);
    expect(read(dir, "packages/data/.env.test.local")).toMatch(/caretook_test_t_2"/);
    expect(leases()).toEqual(["1"]);
    expect(calls()).toMatch(/pnpm datastore:start\n/);
    expect(calls()).not.toMatch(/start:test/);
  });

  it("treats missing fields as no stack, and honours --stack", () => {
    ok("new.sh", ["slice", "t", "4"]);
    expect(existsSync(join(loops, "t-4", ".env"))).toBe(false);
    ok("rm.sh", ["t-4"]);
    ok("new.sh", ["--stack", "slice", "t", "4"]);
    expect(read(loops, "t-4", ".env")).toMatch(/caretook-loop2/);
    ok("rm.sh", ["t-4"]);
    expect(leases()).toEqual(["1"]);
  });
});

describe("stack up and down", () => {
  it("adds a stack to a stackless worktree, then removes all of it", () => {
    const dir = join(loops, "t-1");
    const up = ok("stack.sh", ["up"], { cwd: dir });
    expect(up).toMatch(/Stack up for t-1 \(slot 2/);
    expect(read(dir, ".env")).toMatch(/^CARETOOK_STACK=caretook-loop2$/m);
    expect(read(dir, ".env.loop")).toMatch(/^SLOT=2$/m);
    expect(leases().sort()).toEqual(["1", "2"]);
    expect(calls()).toMatch(/pnpm datastore:start/);

    const down = ok("stack.sh", ["down", "t-1"]);
    expect(down).toMatch(/caretook-loop2 removed, slot released/);
    expect(calls()).toMatch(/docker compose -p caretook-loop2 down --remove-orphans/);
    expect(calls()).toMatch(/docker ps -aq --filter label=com.docker.compose.project=caretook-loop2-test/);
    expect(calls()).not.toMatch(/compose -p caretook-loop1/);
    for (const f of [".env", "packages/data/.env", "apps/web/.env"])
      expect(existsSync(join(dir, f)), f).toBe(false);
    expect(read(dir, ".env.loop")).toBe("SLOT=\nBASE_BRANCH=prd/t\n");
    expect(read(dir, "packages/data/.env.test.local")).toMatch(/caretook_test_t_1/);
    expect(leases()).toEqual(["1"]);
  });

  it("never runs Compose on a worktree without a stack (that would be the main checkout's project)", () => {
    expect(ok("stack.sh", ["down", "t-1"])).toMatch(/has no stack/);
    expect(calls()).not.toMatch(/docker compose/);
  });
});

describe("rm.sh", () => {
  it("drops the worktree's test database when the shared server runs", () => {
    ok("new.sh", ["slice", "t", "5"]);
    rmSync(log, { force: true });
    ok("rm.sh", ["t-5"], { env: { FAKE_SHARED_ID: "c0ffee" } });
    expect(calls()).toMatch(/docker exec c0ffee dropdb -U caretook --if-exists --force caretook_test_t_5/);
    expect(calls()).not.toMatch(/docker compose/);
    expect(existsSync(join(loops, "t-5"))).toBe(false);
  });

  it("drops its integration workers' databases too", () => {
    ok("new.sh", ["slice", "t", "6"]);
    rmSync(log, { force: true });
    // What the shared server answers for the worker copies: t-6's three, t-60's
    // one, and t-6-w1's own database, which isn't a copy of t-6's (B-405).
    const copies = [1, 2, 3].map((n) => workerDatabaseName("caretook_test_t_6", n));
    const psql = [...copies, workerDatabaseName("caretook_test_t_60", 1), "caretook_test_t_6_w1"];
    const out = ok("rm.sh", ["t-6"], { env: { FAKE_SHARED_ID: "c0ffee", FAKE_PSQL: psql.join("\n") } });
    expect(out).toMatch(/dropped test database caretook_test_t_6 and 3 worker copies/);
    const drops = calls().match(/dropdb .*/g) ?? [];
    expect(drops.map((d) => d.split(" ").at(-1)).sort()).toEqual(["caretook_test_t_6", ...copies].sort());
    expect(existsSync(join(loops, "t-6"))).toBe(false);
  });

  it("skips the drop when the shared server isn't running", () => {
    ok("new.sh", ["slice", "t", "5"]);
    rmSync(log, { force: true });
    ok("rm.sh", ["t-5"]);
    expect(calls()).not.toMatch(/dropdb/);
  });

  it("removes the worktree's session record and leaves the others", () => {
    ok("new.sh", ["plan", "r"]);
    const sessions = join(loops, ".sessions");
    mkdirSync(sessions, { recursive: true });
    for (const n of ["plan-r", "prd-other"]) writeFileSync(join(sessions, `${n}.json`), '{"pid":1}\n');
    ok("rm.sh", ["plan-r"]);
    expect(existsSync(join(sessions, "plan-r.json"))).toBe(false);
    expect(existsSync(join(sessions, "prd-other.json"))).toBe(true);
  });
});

describe("status and gc", () => {
  const merge = () => {
    const dir = join(loops, "t-3");
    writeFileSync(join(dir, "work.txt"), "done\n");
    git(dir, "add", "work.txt");
    git(dir, "commit", "-q", "-m", "feat(t): work");
    const prd = join(root, "prd-t");
    if (!existsSync(prd)) git(main, "worktree", "add", "-q", prd, "prd/t");
    git(prd, "merge", "--no-ff", "-q", "-m", "feat(t): merge slice 3", "slice/t/3");
  };

  it("flags a merged slice, not a fresh one, and gc removes it only after a yes", () => {
    ok("new.sh", ["slice", "t", "3"]);
    expect(ok("ls.sh", [])).not.toMatch(/merged:/);
    merge();
    const status = ok("ls.sh", []);
    expect(status).toMatch(/merged: t-3 \(slice\/t\/3 is merged into prd\/t\): pnpm prd gc/);
    expect(status).not.toMatch(/merged: t-1/);
    expect(status).toMatch(/shared test Postgres: not running/);

    expect(ok("gc.sh", ["--list"])).toMatch(/^remove {6}t-3 /m);
    expect(ok("gc.sh", [], { input: "n\n" })).toMatch(/Nothing changed/);
    expect(existsSync(join(loops, "t-3"))).toBe(true);

    const out = ok("gc.sh", [], { input: "y\n", env: { FAKE_SHARED_ID: "c0ffee" } });
    expect(out).toMatch(/Cleaned up 1/);
    expect(existsSync(join(loops, "t-3"))).toBe(false);
    expect(git(main, "branch", "--list", "slice/t/3")).toBe("");
    expect(calls()).toMatch(/dropdb -U caretook --if-exists --force caretook_test_t_3/);
    expect(existsSync(join(loops, "t-1"))).toBe(true);
  });

  it("flags a stack stopped for over a day, and gc takes it down but keeps the worktree", () => {
    const stopped = { FAKE_STACK_IDS: "abc", FAKE_INSPECT: "false 2020-01-02T03:04:05.123456789Z" };
    expect(ok("ls.sh", [], { env: stopped })).toMatch(
      /stopped stack: t-2 \(caretook-loop1 stopped \d+d ago\)/,
    );
    const running = { FAKE_STACK_IDS: "abc", FAKE_INSPECT: "true 0001-01-01T00:00:00Z" };
    expect(ok("ls.sh", [], { env: running })).not.toMatch(/stopped stack/);
    const recent = { FAKE_STACK_IDS: "abc", FAKE_INSPECT: `false ${new Date().toISOString()}` };
    expect(ok("ls.sh", [], { env: recent })).not.toMatch(/stopped stack/);

    expect(ok("gc.sh", ["--list"], { env: running })).toMatch(/Nothing to clean up/);
    const out = ok("gc.sh", ["--yes"], { env: stopped });
    expect(out).toMatch(/^stack down {2}t-2 /m);
    expect(calls()).toMatch(/docker compose -p caretook-loop1 down/);
    expect(existsSync(join(loops, "t-2"))).toBe(true);
    expect(existsSync(join(loops, "t-2", ".env"))).toBe(false);
    expect(leases()).toEqual([]);
  });
});

describe("test-db.sh", () => {
  it("names databases for worktrees, and refuses to drop without a name", () => {
    expect(ok("test-db.sh", ["name", "Orchestration-5"]).trim()).toBe("caretook_test_orchestration_5");
    expect(ok("test-db.sh", ["name", "x".repeat(80)]).trim()).toHaveLength(63);
    expect(sh("test-db.sh", ["drop"]).status).not.toBe(0);
  });

  it("use points an older worktree's tests at its shared database", () => {
    const f = join(loops, "t-1", "packages/data/.env.test.local");
    writeFileSync(f, 'DATABASE_URL="postgresql://caretook:password@localhost:1/caretook"\nPG_TEST_PORT=1\n');
    expect(ok("test-db.sh", ["use"], { cwd: join(loops, "t-1") })).toMatch(/caretook_test_t_1/);
    expect(read(f)).toMatch(/localhost:5436\/caretook_test_t_1"/);
  });

  it("lists each worktree database with its worker copies, and orphaned copies", () => {
    const gone = workerDatabaseName("caretook_test_gone", 1);
    const psql = [
      "caretook_test_a_1",
      "caretook_test_a_10",
      // An old-style copy lists as a database: tidy decides its owner by name.
      "caretook_test_a_1_w3",
      workerDatabaseName("caretook_test_a_1", 1),
      workerDatabaseName("caretook_test_a_1", 2),
      gone,
    ].join("\n");
    expect(ok("test-db.sh", ["list"], { env: { FAKE_SHARED_ID: "c0ffee", FAKE_PSQL: psql } })).toBe(
      "caretook_test_a_1 (+2 worker copies)\ncaretook_test_a_10\ncaretook_test_a_1_w3\n" +
        `${gone} (worker copy, its database is gone)\n`,
    );
    // tidy drops such an orphan by name.
    ok("test-db.sh", ["drop-db", gone], { env: { FAKE_SHARED_ID: "c0ffee", FAKE_PSQL: "" } });
    expect(calls()).toContain(`dropdb -U caretook --if-exists --force ${gone}`);
  });

  it("down stops only the shared project", () => {
    ok("test-db.sh", ["down"]);
    expect(calls().trim()).toBe("docker compose -p caretook-shared-test down --remove-orphans");
  });
});
