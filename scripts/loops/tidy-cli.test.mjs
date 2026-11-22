// pnpm prd tidy (tidy-cli.mjs) against a throwaway repo and .loops with these
// scripts copied in, and fake docker, lsof, osascript, pnpm, nvm and backlog:
// nothing here touches real containers, volumes, sessions, the asks queue, a
// real claude or GitHub.
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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = new URL(".", import.meta.url).pathname;
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();

const PLAN = `# Plan: T

## Slice 1: Merged

Stack: no · Reads: none · Tests: unit

## Slice 2: Merged, then dirty

Stack: no · Reads: none · Tests: unit

## Slice 3: Active

Stack: no · Reads: none · Tests: unit
`;

// A running shared test Postgres (container c1) whose databases are
// FAKE_DBS (only for the listing query), and FAKE_VOLUMES as the dangling volumes.
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
case "$1 $2" in
  "ps -q") [[ "$*" == *caretook-shared-test* && "$*" == *postgres* ]] && echo c1 ;;
  "exec c1") [[ "$*" == *psql* && "$*" == *LIKE* ]] && printf '%s\\n' $FAKE_DBS ;;
  "volume ls") printf '%s\\n' "$FAKE_VOLUMES" ;;
esac
exit 0
`;
// The backlog's list --json and prd list --json: nothing finished, no rows.
const FAKE_BACKLOG = 'console.log("[]");\n';

let root, main, loops, log, asks, sessions, leases, env;
const tidy = (args = []) =>
  spawnSync(process.execPath, [join(main, "scripts/loops/tidy-cli.mjs"), ...args], {
    cwd: main,
    encoding: "utf8",
    env,
  });
const ok = (args) => {
  const r = tidy(args);
  if (r.status !== 0) throw new Error(`tidy ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};
const filedAsks = () => (existsSync(asks) ? readdirSync(asks).filter((f) => f.endsWith(".json")) : []);
const lease = () => join(leases, "check", "1");
const old = (p) => utimesSync(p, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tidy-test-")));
  main = join(root, "repo");
  loops = join(main, ".loops");
  log = join(root, "calls.log");
  asks = join(root, "asks");
  sessions = join(root, "sessions");
  leases = join(root, "leases");
  const bin = join(root, "bin");
  const nvm = join(root, "nvm");
  mkdirSync(bin);
  mkdirSync(nvm);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  writeFileSync(join(bin, "pnpm"), '#!/usr/bin/env bash\necho "pnpm $*" >> "$FAKE_LOG"\n');
  writeFileSync(join(bin, "osascript"), '#!/usr/bin/env bash\necho "osascript $*" >> "$FAKE_LOG"\n');
  writeFileSync(join(bin, "claude"), '#!/usr/bin/env bash\necho "claude $*" >> "$FAKE_LOG"\n');
  // No process listens or works anywhere.
  writeFileSync(join(bin, "lsof"), "#!/usr/bin/env bash\nexit 1\n");
  for (const f of ["docker", "pnpm", "osascript", "claude", "lsof"]) chmodSync(join(bin, f), 0o755);
  writeFileSync(join(nvm, "nvm.sh"), "nvm() { :; }\n");
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    NVM_DIR: nvm,
    FAKE_LOG: log,
    TRUNK: "dev",
    CARETOOK_CLAUDE_BIN: join(bin, "claude"),
    CARETOOK_ASKS_DIR: asks,
    CARETOOK_ASK_NOTIFY: "",
    CARETOOK_SESSIONS_DIR: sessions,
    CARETOOK_SESSION: "",
    CARETOOK_LEASE_ROOT: leases,
    CARETOOK_SHARED_TEST_PORT: "",
    CARETOOK_SHARED_TEST_PROJECT: "",
    FAKE_DBS: "caretook_test_t_3 caretook_test_gone",
    FAKE_VOLUMES: "caretook-loop9_data\tcaretook-loop9\nother_db\tother",
  };

  execFileSync("git", ["init", "-q", "-b", "dev", main]);
  for (const [k, v] of [
    ["user.email", "test@example.com"],
    ["user.name", "Test"],
    ["commit.gpgsign", "false"],
  ])
    git(main, "config", k, v);
  mkdirSync(join(main, "scripts/loops"), { recursive: true });
  mkdirSync(join(main, "scripts/backlog"), { recursive: true });
  for (const f of readdirSync(HERE).filter((f) => /\.(sh|mjs)$/.test(f) && !f.endsWith(".test.mjs")))
    copyFileSync(join(HERE, f), join(main, "scripts/loops", f));
  writeFileSync(join(main, "scripts/backlog/backlog.mjs"), FAKE_BACKLOG);
  writeFileSync(join(main, ".gitignore"), ".loops/\n.env\n.env.*\nnode_modules/\n");
  mkdirSync(join(main, "plans"));
  writeFileSync(join(main, "plans/t-plan.md"), PLAN);
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "chore: init");
  git(main, "branch", "prd/t");

  const run = (...a) =>
    execFileSync("bash", [join(main, "scripts/loops/new.sh"), ...a], { env, stdio: "pipe" });
  for (const n of ["1", "2", "3"]) run("slice", "t", n);
  // Slices 1 and 2 are merged into prd/t; 2 then picks up uncommitted work.
  const prd = join(root, "prd-t");
  git(main, "worktree", "add", "-q", prd, "prd/t");
  for (const n of ["1", "2"]) {
    const dir = join(loops, `t-${n}`);
    writeFileSync(join(dir, `work-${n}.txt`), "done\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", `feat(t): slice ${n}`);
    git(prd, "merge", "--no-ff", "-q", "-m", `feat(t): merge slice ${n}`, `slice/t/${n}`);
  }
  writeFileSync(join(loops, "t-2", "work-2.txt"), "more, not committed\n");
  // Slice 3 is active: a commit, not merged.
  writeFileSync(join(loops, "t-3", "work-3.txt"), "wip\n");
  git(join(loops, "t-3"), "add", ".");
  git(join(loops, "t-3"), "commit", "-q", "-m", "feat(t): slice 3 so far");
  // An unmerged branch with no worktree.
  git(main, "branch", "slice/t/9", "slice/t/3");
  // A dead check lease, taken an hour ago.
  mkdirSync(lease(), { recursive: true });
  writeFileSync(join(lease(), "name"), "pid=999999\nworktree=t-3\ncheck=pnpm check\n");
  old(lease());
  // A browser-hang log from last month.
  mkdirSync(join(loops, ".browser-hangs"), { recursive: true });
  writeFileSync(join(loops, ".browser-hangs", "t-ui-1.log"), "hung\n");
  const month = new Date(Date.now() - 30 * 86400_000);
  utimesSync(join(loops, ".browser-hangs", "t-ui-1.log"), month, month);
  // An ended session record whose worktree is gone.
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    join(sessions, "prd-gone.json"),
    JSON.stringify({
      pid: 999998,
      kind: "prd",
      topic: "gone",
      started: "2026-01-01T00:00:00Z",
      ended: "2026-01-01T01:00:00Z",
    }),
  );
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("tidy (no --yes)", () => {
  it("lists the safe, ask and kept findings and changes nothing", () => {
    const out = ok([]);
    expect(out).toMatch(/^ {2}worktree +t-1 \(slice\/t\/1 is merged into prd\/t\)$/m);
    expect(out).toMatch(/^ {2}lease +.*check\/1 \(lease t-3: pnpm check: pid 999999 is gone\)$/m);
    expect(out).toMatch(/^ {2}record +prd-gone \(ended, and its worktree gone is gone\)$/m);
    expect(out).toMatch(
      /^ {2}branch +slice\/t\/9 \(no worktree, not merged into prd\/t: kept, never deleted\)$/m,
    );
    expect(out).toMatch(/^Kept:\n {2}worktree +t-2 \(.*uncommitted changes\)$/m);
    expect(out).toMatch(/^ {2}test-db +caretook_test_gone \(no worktree owns it\)$/m);
    expect(out).toMatch(/^ {2}volume +caretook-loop9_data \(dangling; no worktree uses caretook-loop9\)$/m);
    expect(out).toMatch(/^ {2}hang-log +.*t-ui-1\.log \(30 days old\)$/m);
    expect(out).not.toMatch(/t-3 \(|caretook_test_t_3|other_db/);
    expect(out).toMatch(/Nothing changed\. pnpm prd tidy --yes removes the safe ones\./);

    for (const n of ["t-1", "t-2", "t-3"]) expect(existsSync(join(loops, n))).toBe(true);
    expect(existsSync(lease())).toBe(true);
    expect(existsSync(join(sessions, "prd-gone.json"))).toBe(true);
    expect(filedAsks()).toEqual([]);
    expect(existsSync(join(loops, ".browser-hangs", "t-ui-1.log"))).toBe(true);
    expect(readFileSync(log, "utf8")).not.toMatch(/dropdb|volume rm/);
  });

  it("--json gives the same lists", () => {
    const { safe, ask, kept } = JSON.parse(ok(["--json"]));
    expect(safe.map((f) => f.kind)).toEqual(["worktree", "record", "lease", "test-db", "volume", "hang-log"]);
    expect(ask.map((f) => f.target)).toEqual(["slice/t/9"]);
    expect(kept.map((f) => f.target)).toEqual(["t-2"]);
  });
});

describe("tidy --yes", () => {
  it("removes the merged slice worktree, the dead lease and the ended record; keeps the rest; files one report", () => {
    const out = ok(["--yes"]);
    expect(out).toMatch(/^removed worktree t-1$/m);
    expect(existsSync(join(loops, "t-1"))).toBe(false);
    expect(git(main, "branch", "--list", "slice/t/1")).toBe("");
    expect(existsSync(lease())).toBe(false);
    expect(existsSync(join(sessions, "prd-gone.json"))).toBe(false);

    // The dirty worktree, the active one and the unmerged branch stay.
    expect(readFileSync(join(loops, "t-2", "work-2.txt"), "utf8")).toMatch(/not committed/);
    expect(existsSync(join(loops, "t-3"))).toBe(true);
    expect(git(main, "branch", "--list", "slice/t/9")).toMatch(/slice\/t\/9/);

    // One report ask, with no PushNotification line (only questions push).
    const filed = filedAsks();
    expect(filed).toHaveLength(1);
    const ask = JSON.parse(readFileSync(join(asks, filed[0]), "utf8"));
    expect(ask.kind).toBe("report");
    expect(ask.topic).toBe("tidy");
    expect(ask.text).toMatch(/branch slice\/t\/9: no worktree, not merged/);
    expect(out).not.toMatch(/^Now send a PushNotification/m);

    // Through the (fake) Docker: the orphan database and the dangling volume only.
    const calls = readFileSync(log, "utf8");
    expect(calls).toMatch(/^docker exec c1 dropdb -U caretook --if-exists --force caretook_test_gone$/m);
    expect(calls).not.toMatch(/dropdb .*caretook_test_t_3/);
    expect(calls.match(/^docker volume rm .*/gm)).toEqual(["docker volume rm caretook-loop9_data"]);
    expect(existsSync(join(loops, ".browser-hangs", "t-ui-1.log"))).toBe(false);
    expect(calls).not.toMatch(/^claude /m);
  });

  it("files no report when nothing is left to ask about", () => {
    git(main, "branch", "-D", "slice/t/9");
    rmSync(asks, { recursive: true, force: true });
    const out = ok(["--yes"]);
    expect(out).toMatch(/Nothing to ask about: no report filed\./);
    expect(filedAsks()).toEqual([]);
    expect(existsSync(join(loops, "t-2"))).toBe(true);
  });
});
