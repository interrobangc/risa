// The load gate: the pure decision (load-gate.mjs), its CLI, and the scripts
// that wait on it or warn (new.sh slice, pnpm prd start, pnpm prd status)
// against a throwaway repo with the stub stack hook and fake pnpm, lsof and nvm, and a stubbed
// load (a file the tests write), so the real machine's load never matters.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadGate, parseLoad, readLoadGate, sayGate, stateOf } from "./load-gate.mjs";
import { stubHookConfig } from "./config-fixture.mjs";

const HERE = new URL(".", import.meta.url).pathname;

describe("loadGate", () => {
  it("is busy above the threshold and not at it", () => {
    expect(loadGate({ load: 20.01, cores: 10 }).busy).toBe(true);
    expect(loadGate({ load: 20, cores: 10 }).busy).toBe(false);
    expect(loadGate({ load: 3, cores: 10 }).busy).toBe(false);
  });

  it("defaults to twice the core count", () => {
    expect(loadGate({ load: 1, cores: 10 })).toMatchObject({ threshold: 20, setting: false });
    expect(loadGate({ load: 1, cores: 4 }).threshold).toBe(8);
    expect(loadGate({ load: 9, cores: 4 }).busy).toBe(true);
    expect(loadGate({ load: 9, cores: 16 }).busy).toBe(false);
  });

  it("takes RISA_LOAD_BUSY over the default, and ignores one that isn't a positive number", () => {
    const env = { RISA_LOAD_BUSY: "30" };
    expect(loadGate({ load: 25, cores: 10, env })).toMatchObject({
      busy: false,
      threshold: 30,
      setting: true,
    });
    expect(loadGate({ load: 31, cores: 10, env }).busy).toBe(true);
    expect(loadGate({ load: 25, cores: 10, env: { RISA_LOAD_BUSY: "5.5" } }).threshold).toBe(5.5);
    for (const bad of ["lots", "0", "-3", ""])
      expect(loadGate({ load: 1, cores: 10, env: { RISA_LOAD_BUSY: bad } }).threshold).toBe(20);
  });

  it("is never busy with RISA_LOAD_GATE=off", () => {
    const g = loadGate({ load: 999, cores: 1, env: { RISA_LOAD_GATE: "off" } });
    expect(g).toMatchObject({ busy: false, off: true });
    expect(stateOf(g)).toBe("off");
  });

  it("isn't busy when the load can't be read", () => {
    for (const load of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const g = loadGate({ load, cores: 1 });
      expect(g).toMatchObject({ busy: false, load: null });
      expect(stateOf(g)).toBe("unread");
    }
  });
});

describe("parseLoad", () => {
  it("takes the 5-minute field, or a lone number", () => {
    expect(parseLoad("1.5 2.5 3.5\n")).toBe(2.5);
    expect(parseLoad("{ 1.5 2.5 3.5 }")).toBe(2.5);
    expect(parseLoad("0.52, 0.58, 0.59")).toBe(0.58);
    expect(parseLoad("7")).toBe(7);
  });
  it("reads nothing from junk", () => {
    for (const t of ["", "  \n", "high", "1 two 3", "-1 -1 -1"]) expect(parseLoad(t)).toBeNull();
  });
});

describe("readLoadGate and the words", () => {
  let dir;
  beforeAll(() => (dir = realpathSync(mkdtempSync(join(tmpdir(), "load-gate-")))));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads RISA_LOAD_FILE, and a missing file is unread", () => {
    writeFileSync(join(dir, "load"), "1 9 1\n");
    const env = { RISA_LOAD_FILE: join(dir, "load"), RISA_LOAD_BUSY: "4" };
    expect(readLoadGate(env)).toMatchObject({ busy: true, load: 9, threshold: 4 });
    expect(readLoadGate({ ...env, RISA_LOAD_FILE: join(dir, "none") })).toMatchObject({
      busy: false,
      load: null,
    });
  });

  it("says the load against the threshold", () => {
    expect(sayGate(loadGate({ load: 3.25, cores: 10 }))).toBe(
      "load gate: 5-minute load 3.25 against 20 (twice 10 cores): not busy",
    );
    expect(sayGate(loadGate({ load: 31, cores: 10, env: { RISA_LOAD_BUSY: "30" } }), {})).toBe(
      "load gate: 5-minute load 31 over 30 (RISA_LOAD_BUSY): BUSY, checks and slice starts wait up to 600s",
    );
    expect(sayGate(loadGate({ load: 1, cores: 2, env: { RISA_LOAD_GATE: "off" } }))).toMatch(/off/);
    expect(sayGate(loadGate({ load: null, cores: 2 }))).toMatch(/can't read the load; not busy/);
  });

  it("the CLI prints one line for scripts, and --json", () => {
    writeFileSync(join(dir, "load"), "1 9 1\n");
    const env = {
      ...process.env,
      RISA_LOAD_FILE: join(dir, "load"),
      RISA_LOAD_BUSY: "4",
      RISA_LOAD_GATE: "",
    };
    const cli = (...a) => spawnSync("node", [join(HERE, "load-gate.mjs"), ...a], { env, encoding: "utf8" });
    expect(cli().stdout).toMatch(/^busy 9 4 \d+\n$/);
    expect(JSON.parse(cli("--json").stdout)).toMatchObject({ state: "busy", load: 9, threshold: 4 });
    expect(cli("--say").stdout).toMatch(/BUSY/);
    expect(cli("--nope").status).toBe(2);
  });
});

// The scripts, in a throwaway repo.
const PLAN = `# Plan: T

## Slice 1: Stackless

Stack: no · Reads: none · Tests: unit
`;

describe("the scripts that wait or warn", () => {
  let root, main, loops, loadFile, env;
  const git = (cwd, ...a) =>
    execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
  // start: the script running, its output so far (out()) and its end (done).
  const start = (script, args, extra = {}) => {
    const child = spawn("bash", [join(main, "scripts/loops", script), ...args], {
      cwd: main,
      env: { ...env, ...extra },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const done = new Promise((resolve) => child.on("close", (status) => resolve({ status, out })));
    return { out: () => out, done };
  };
  const run = (script, args, extra = {}) => start(script, args, extra).done;
  // Wait on a state, never a fixed sleep (a loaded runner can take seconds to
  // get a script as far as its first load read).
  const until = async (ok, what, ms = 15_000) => {
    for (const t0 = Date.now(); !ok(); await new Promise((r) => setTimeout(r, 50)))
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
  };
  // The fake load is replaced whole (write aside, then rename): a plain
  // writeFileSync truncates first, and a script reading in that moment saw an
  // empty file, read it as "can't read the load" (never busy) and went ahead
  // ("load dropped to -"): B-744.
  const setLoad = (text) => {
    writeFileSync(`${loadFile}.tmp`, text);
    renameSync(`${loadFile}.tmp`, loadFile);
  };
  const busy = () => setLoad("9 9 9\n");
  const quiet = () => setLoad("1 1 1\n");
  const fresh = (name) => {
    rmSync(join(loops, name), { recursive: true, force: true });
    git(main, "worktree", "prune");
  };

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "load-gate-sh-")));
    main = join(root, "repo");
    loops = join(main, ".loops");
    loadFile = join(root, "load");
    quiet();
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
      RISA_LOAD_FILE: loadFile,
      RISA_LOAD_BUSY: "4",
      RISA_LOAD_POLL: "0.2",
      RISA_LOAD_WAIT: "",
      RISA_LOAD_GATE: "",
      RISA_LEASES: "",
      RISA_LEASE_ROOT: join(root, "leases"),
    };
    execFileSync("git", ["init", "-q", "-b", "dev", main]);
    for (const [k, v] of [
      ["user.email", "test@example.com"],
      ["user.name", "Test"],
      ["commit.gpgsign", "false"],
    ])
      git(main, "config", k, v);
    mkdirSync(join(main, "scripts/loops"), { recursive: true });
    for (const f of readdirSync(HERE).filter(
      (f) => f.endsWith(".sh") || f === "slice-fields.mjs" || f === "config.mjs" || f === "load-gate.mjs",
    ))
      copyFileSync(join(HERE, f), join(main, "scripts/loops", f));
    // The stack and test DB hooks: the sample project's stub.
    env.RISA_CONFIG = stubHookConfig(main);
    writeFileSync(join(main, ".gitignore"), ".loops/\n.env\n.env.*\n.postgres/\n");
    mkdirSync(join(main, "plans"));
    writeFileSync(join(main, "plans/t-plan.md"), PLAN);
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", "chore: init");
    git(main, "branch", "prd/t");
    mkdirSync(join(main, "packages/data"), { recursive: true });
    mkdirSync(join(main, "apps/web"), { recursive: true });
    writeFileSync(join(main, "packages/data/.env"), 'DATABASE_URL="x"\nSEED_USER_PASSWORD="pw-fictional"\n');
    writeFileSync(join(main, "apps/web/.env"), 'BETTER_AUTH_URL="x"\nCRON_SECRET="s"\n');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  // Each slice start cleans up in a finally: a leftover t-1 would fail every
  // later start ("already exists"), so one failure took the whole block down.
  it("a slice start waits while busy and starts when the load drops", async () => {
    busy();
    try {
      const s = start("new.sh", ["slice", "t", "1"]);
      await until(() => /waiting up to/.test(s.out()), "the busy line");
      expect(existsSync(join(loops, "t-1"))).toBe(false);
      quiet();
      const r = await s.done;
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(
        /machine is busy \(5-minute load 9, over 4\): waiting up to 600s before slice t-1/,
      );
      expect(r.out).toMatch(/load dropped to 1 \(threshold 4\) after \d+s: starting slice t-1/);
      expect(existsSync(join(loops, "t-1"))).toBe(true);
    } finally {
      quiet();
      fresh("t-1");
    }
  });

  it("a slice start goes ahead after the bounded wait and says so", async () => {
    busy();
    try {
      const r = await run("new.sh", ["slice", "t", "1"], { RISA_LOAD_WAIT: "1" });
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(
        /Gave up waiting for the load after \d+s \(still 9, over 4\): starting slice t-1 anyway/,
      );
      expect(existsSync(join(loops, "t-1"))).toBe(true);
    } finally {
      quiet();
      fresh("t-1");
    }
  });

  it("a slice start waits for nothing with RISA_LOAD_GATE=off or RISA_LEASES=off", async () => {
    busy();
    try {
      for (const extra of [{ RISA_LOAD_GATE: "off" }, { RISA_LEASES: "off" }]) {
        try {
          const t0 = Date.now();
          const r = await run("new.sh", ["slice", "t", "1"], { ...extra, RISA_LOAD_WAIT: "30" });
          expect(r.status, r.out).toBe(0);
          expect(r.out).not.toMatch(/busy/);
          expect(Date.now() - t0).toBeLessThan(15_000);
        } finally {
          fresh("t-1");
        }
      }
    } finally {
      quiet();
    }
  });

  it("is off in the tooling tests' shared env (vitest.config.ts), so their slice starts never poll", async () => {
    expect(process.env.RISA_LOAD_GATE).toBe("off");
    busy();
    try {
      const t0 = Date.now();
      const r = await run("new.sh", ["slice", "t", "1"], {
        RISA_LOAD_GATE: process.env.RISA_LOAD_GATE,
        RISA_LOAD_WAIT: "30",
      });
      expect(r.status, r.out).toBe(0);
      expect(r.out).not.toMatch(/busy/);
      expect(Date.now() - t0).toBeLessThan(15_000);
    } finally {
      quiet();
      fresh("t-1");
    }
  });

  it("pnpm prd start only warns", async () => {
    busy();
    const r = await run("prd.sh", ["start", "w"], { RISA_LOAD_WAIT: "30" });
    quiet();
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/Warning: the machine is busy \(5-minute load 9, over 4\); starting w anyway/);
    expect(r.out).not.toMatch(/waiting up to/);
    expect(existsSync(join(loops, "w"))).toBe(true);
  });

  it("pnpm prd status prints the load against the threshold", async () => {
    busy();
    let r = await run("prd.sh", ["status"]);
    expect(r.out).toContain(
      "load gate: 5-minute load 9 over 4 (RISA_LOAD_BUSY): BUSY, checks and slice starts wait up to 600s",
    );
    quiet();
    r = await run("prd.sh", ["status"]);
    expect(r.out).toContain("load gate: 5-minute load 1 against 4 (RISA_LOAD_BUSY): not busy");
  });

  it("pnpm prd start and status default to a cap of four, and RISA_MAX_PRDS overrides it", async () => {
    fresh("w");
    for (const n of ["c1", "c2", "c3"])
      git(main, "worktree", "add", "-q", "-b", `prd/${n}`, join(loops, n), "dev");
    expect((await run("prd.sh", ["status"])).out).toContain("PRD worktrees: 3 of 4");
    const low = await run("prd.sh", ["start", "e"], { RISA_MAX_PRDS: "3" });
    expect(low.status).toBe(1);
    expect(low.out).toContain("already 3 PRD worktrees (cap 3;");
    const fourth = await run("prd.sh", ["start", "d"]);
    expect(fourth.status, fourth.out).toBe(0);
    expect(existsSync(join(loops, "d"))).toBe(true);
    expect((await run("prd.sh", ["status"])).out).toContain("PRD worktrees: 4 of 4");
    const fifth = await run("prd.sh", ["start", "e"]);
    expect(fifth.status).toBe(1);
    expect(fifth.out).toContain("already 4 PRD worktrees (cap 4;");
    expect((await run("prd.sh", ["status"], { RISA_MAX_PRDS: "5" })).out).toContain("PRD worktrees: 4 of 5");
    for (const n of ["c1", "c2", "c3", "d"]) fresh(n);
  });

  it("a stored --cap (.loops/.prd-cap) wins over RISA_MAX_PRDS for start and status", async () => {
    fresh("w");
    for (const n of ["k1", "k2"]) git(main, "worktree", "add", "-q", "-b", `prd/${n}`, join(loops, n), "dev");
    writeFileSync(join(loops, ".prd-cap"), "2\n");
    try {
      expect((await run("prd.sh", ["status"], { RISA_MAX_PRDS: "5" })).out).toContain(
        "PRD worktrees: 2 of 2 (pnpm prd dispatch --cap)",
      );
      const third = await run("prd.sh", ["start", "e"], { RISA_MAX_PRDS: "5" });
      expect(third.status).toBe(1);
      expect(third.out).toContain("already 2 PRD worktrees (cap 2; from pnpm prd dispatch --cap:");
      writeFileSync(join(loops, ".prd-cap"), "junk\n");
      expect((await run("prd.sh", ["status"], { RISA_MAX_PRDS: "5" })).out).toContain(
        "PRD worktrees: 2 of 5 (RISA_MAX_PRDS)",
      );
    } finally {
      rmSync(join(loops, ".prd-cap"), { force: true });
      for (const n of ["k1", "k2"]) fresh(n);
    }
  });
});
