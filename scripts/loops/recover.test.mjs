// `pnpm prd recover --dry-run` (recover.sh, inventory-facts.mjs, inventory.mjs)
// against a throwaway repo with these scripts copied in, real git worktrees, and
// fake docker and lsof on PATH: nothing here touches real containers, slots or
// worktrees, and the dry run must change nothing on disk.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const HERE = new URL(".", import.meta.url).pathname;
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
const DEAD_PID = "999999"; // above macOS's and Linux's default pid_max

// Projects in FAKE_RUNNING have a running container; every caretook-loop* project has a stopped one.
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
case $1 in
  info) [[ -z \${FAKE_DOCKER_DOWN:-} ]] || exit 1 ;;
  ps)
    proj=$(printf '%s\\n' "$@" | sed -n 's/^label=com.docker.compose.project=//p')
    if [[ " \${FAKE_RUNNING:-} " == *" $proj "* ]]; then echo "id-$proj"
    elif [[ "$*" == *-aq* && $proj == caretook-loop* ]]; then echo "id-$proj"; fi ;;
  inspect) echo "false 2026-11-19T10:00:00.000Z" ;;
  *) exit 3 ;;
esac
exit 0
`;
const FAKE_LSOF = `#!/usr/bin/env bash
echo "lsof $*" >> "$FAKE_LOG"
for p in \${FAKE_LISTEN:-}; do [[ "$*" == *"TCP:$p "* ]] && { echo 4242; exit 0; }; done
exit 1
`;

let root, main, loops, log, env;
const recover = (args = [], extra = {}) =>
  spawnSync("bash", [join(main, "scripts/loops/prd.sh"), "recover", ...args], {
    cwd: main,
    encoding: "utf8",
    env: { ...env, ...extra },
  });
const okRecover = (args, extra) => {
  const r = recover(args, extra);
  if (r.status !== 0) throw new Error(`recover ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};
const json = (extra) => JSON.parse(okRecover(["--dry-run", "--json"], extra));
const steps = (inv) => inv.actions.map((a) => (a.target ? `${a.step} ${a.target}` : a.step));
const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");

/** Every path under DIR with its size and mtime (and a directory's entries). */
function snapshot(dir, out = new Map()) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (p === log) continue;
    const st = lstatSync(p);
    out.set(p, `${st.isDirectory() ? "d" : "f"} ${st.size} ${st.mtimeMs}`);
    if (st.isDirectory()) snapshot(p, out);
  }
  return out;
}

const worktree = (name, branch, from) =>
  git(main, "worktree", "add", "-q", "-b", branch, join(loops, name), from);
const stackEnv = (name, slot) => {
  const dir = join(loops, name);
  writeFileSync(join(dir, ".env"), `CARETOOK_STACK=caretook-loop${slot}\n`);
  mkdirSync(join(dir, "apps/web"), { recursive: true });
  writeFileSync(join(dir, "apps/web/.env"), `BETTER_AUTH_URL="x"\nWEB_PORT=6${slot}73\n`);
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "recover-test-")));
  main = join(root, "repo");
  loops = join(main, ".loops");
  log = join(root, "calls.log");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  writeFileSync(join(bin, "lsof"), FAKE_LSOF);
  for (const f of ["docker", "lsof"]) chmodSync(join(bin, f), 0o755);
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_LOG: log,
    TRUNK: "dev",
    CARETOOK_FREE_GB: "50",
    CARETOOK_MIN_FREE_GB: "",
    CARETOOK_LEASE_ROOT: "",
    CARETOOK_SHARED_TEST_PROJECT: "",
  };

  execFileSync("git", ["init", "-q", "-b", "dev", main]);
  for (const [k, v] of [
    ["user.email", "test@example.com"],
    ["user.name", "Test"],
    ["commit.gpgsign", "false"],
  ])
    git(main, "config", k, v);
  mkdirSync(join(main, "scripts/loops"), { recursive: true });
  for (const f of readdirSync(HERE).filter((f) => f.endsWith(".sh") || f.endsWith(".mjs")))
    copyFileSync(join(HERE, f), join(main, "scripts/loops", f));
  writeFileSync(join(main, ".gitignore"), ".loops/\n.env\n.env.*\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "chore: init");
  git(main, "branch", "prd/t");

  // t: the PRD (stack, server port); t-1: merged; t-2: active (stack); t-3: stackless and dirty;
  // t-4: merged and dirty; plan-u: a planner.
  git(main, "worktree", "add", "-q", join(loops, "t"), "prd/t");
  stackEnv("t", 1);
  for (const n of [1, 2, 3, 4]) {
    worktree(`t-${n}`, `slice/t/${n}`, "prd/t");
    writeFileSync(join(loops, `t-${n}`, `s${n}.txt`), `slice ${n}\n`);
    git(join(loops, `t-${n}`), "add", ".");
    git(join(loops, `t-${n}`), "commit", "-q", "-m", `feat(t): slice ${n}`);
  }
  for (const n of [1, 4])
    git(join(loops, "t"), "merge", "-q", "--no-ff", "-m", `feat(t): slice ${n}`, `slice/t/${n}`);
  stackEnv("t-2", 2);
  writeFileSync(join(loops, "t-3", "wip.txt"), "uncommitted\n");
  writeFileSync(join(loops, "t-4", "wip.txt"), "uncommitted\n");
  worktree("plan-u", "plan/u", "dev");

  // Locks: a live and a stale slot lease, a dead queue ticket, the start lock.
  mkdirSync(join(loops, ".slots/1"), { recursive: true });
  writeFileSync(join(loops, ".slots/1/name"), "t\n");
  mkdirSync(join(loops, ".slots/9"), { recursive: true });
  writeFileSync(join(loops, ".slots/9/name"), "gone-7\n");
  mkdirSync(join(loops, ".queue"));
  writeFileSync(join(loops, ".queue", `100-${DEAD_PID}-x`), `${DEAD_PID}\n`);
  mkdirSync(join(loops, ".prd-start.lock"));
}, 60_000); // dozens of git commands, slow when pnpm check runs beside it
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => rmSync(log, { force: true }));

describe("recover --dry-run", () => {
  it("classifies every worktree", () => {
    const got = Object.fromEntries(json().worktrees.map((w) => [w.name, w.class]));
    expect(got).toEqual({
      "plan-u": "plan",
      t: "prd",
      "t-1": "merged",
      "t-2": "active",
      "t-3": "stackless",
      "t-4": "merged",
    });
  });

  it("after a cold boot: stale locks, test Postgres, active stacks, prd servers, gc offers, sessions", () => {
    expect(steps(json())).toEqual([
      `clear-lock ${join(loops, ".slots/9")}`,
      `clear-lock ${join(loops, ".queue", `100-${DEAD_PID}-x`)}`,
      `clear-lock ${join(loops, ".prd-start.lock")}`,
      "test-db up",
      "stack up t",
      "stack up t-2",
      "serve t",
      "offer-gc t-1",
      "offer-gc t-4",
      "open-session t",
      "open-session plan-u",
    ]);
  });

  it("marks the dirty merged slice and keeps the live slot lease", () => {
    const inv = json();
    expect(inv.actions.find((a) => a.target === "t-4")).toMatchObject({ step: "offer-gc", dirty: true });
    expect(inv.locks.live.map((l) => l.path)).toEqual([join(loops, ".slots/1")]);
  });

  it("with Docker down, starts it first", () => {
    const inv = json({ FAKE_DOCKER_DOWN: "1" });
    expect(steps(inv)[0]).toBe("docker start");
    expect(calls()).not.toMatch(/docker ps/);
  });

  it("with everything up, has only gc offers and sessions besides the locks", () => {
    const inv = json({
      FAKE_RUNNING: "caretook-loop1 caretook-loop2 caretook-shared-test",
      FAKE_LISTEN: "6173",
    });
    expect(inv.actions.filter((a) => a.step !== "clear-lock").map((a) => a.step)).toEqual([
      "offer-gc",
      "offer-gc",
      "open-session",
      "open-session",
    ]);
    expect(inv.worktrees.find((w) => w.name === "t")).toMatchObject({ containersUp: 1, serverRunning: true });
  });

  it("leaves the start lock alone while a queue.sh is alive, and clears a stale backlog lock", () => {
    const ticket = join(loops, ".queue", `200-${process.pid}-y`);
    const backlogLock = join(main, ".git", "caretook-backlog.lock");
    writeFileSync(ticket, `${process.pid}\n`);
    mkdirSync(backlogLock);
    try {
      let inv = json();
      expect(inv.locks.live.map((l) => l.kind)).toEqual(
        expect.arrayContaining(["start", "ticket", "backlog"]),
      );
      expect(steps(inv)).not.toContain(`clear-lock ${join(loops, ".prd-start.lock")}`);
      const old = (Date.now() - 120_000) / 1000;
      utimesSync(backlogLock, old, old);
      inv = json();
      expect(steps(inv)).toContain(`clear-lock ${backlogLock}`);
    } finally {
      rmSync(ticket);
      rmSync(backlogLock, { recursive: true });
    }
  });

  it("follows a down record, and says it would delete it", () => {
    const record = join(loops, ".down.json");
    writeFileSync(
      record,
      JSON.stringify({ at: "2026-11-19T20:00:00Z", stacks: ["t-2"], servers: [], testDb: false }),
    );
    try {
      const inv = json();
      expect(steps(inv).filter((s) => !s.startsWith("clear-lock"))).toEqual([
        "stack up t-2",
        "offer-gc t-1",
        "offer-gc t-4",
        "open-session t",
        "open-session plan-u",
        `delete-down-record ${record}`,
      ]);
      expect(existsSync(record)).toBe(true);
    } finally {
      rmSync(record);
    }
  });

  it("flags low disk", () => {
    const inv = json({ CARETOOK_FREE_GB: "3", CARETOOK_MIN_FREE_GB: "5" });
    expect(inv.disk).toEqual({ freeGb: 3, minGb: 5, low: true });
    expect(okRecover(["--dry-run"], { CARETOOK_FREE_GB: "3" })).toMatch(
      /disk: 3 GB free \(line: 10 GB\) · LOW/,
    );
  });

  it("changes nothing on disk, and only asks docker and lsof", () => {
    const before = snapshot(root);
    const text = okRecover(["--dry-run"]);
    expect(text).toMatch(/^NAME\s+CLASS/);
    expect(text).toMatch(/ 4\. test-db up/);
    expect(text).toMatch(/Dry run: nothing was changed\.$/m);
    okRecover(["--dry-run", "--json"]);
    expect(snapshot(root)).toEqual(before);
    const docker = calls()
      .split("\n")
      .filter((l) => l.startsWith("docker "))
      .map((l) => l.split(" ")[1]);
    expect(new Set(docker)).toEqual(new Set(["info", "ps", "inspect"]));
  });

  it("refuses to run the actions without --dry-run (not built yet), and unknown options", () => {
    const r = recover([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/only --dry-run/);
    expect(recover(["--bogus"]).stderr).toMatch(/unknown option --bogus/);
  });

  it("is listed in pnpm prd help", () => {
    const r = spawnSync("bash", [join(main, "scripts/loops/prd.sh"), "help"], { encoding: "utf8", env });
    expect(r.stdout).toMatch(/recover --dry-run \[--json\]/);
  });
});
