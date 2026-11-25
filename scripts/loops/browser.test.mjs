// browser.sh's watchdog, caps, retry and trimmed output, with fake Playwright
// Test specs in a throwaway repo (run with the real config, reporter and
// fixtures, and this repo's node_modules). Its leases and flakes log are moved
// into the temp dir, so these never take one of the machine's real browser leases.
// Each run is its own process group, and afterEach kills every group a test
// started, so a test that fails, throws or times out leaves nothing running; the
// fake specs also end themselves once this test process is gone (B-704).
import { spawn, spawnSync, execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { FORCED_LINE } from "../ci/browser-job.mjs";

const BROWSER = new URL("./browser.sh", import.meta.url).pathname;

// Fake specs: they import the real fixtures (smoke mode lives there) and never
// open a browser. `pid` files let a test see that a killed run's worker is gone.
// Each ends with GUARD: it exits once FAKE_PARENT (this test process, unless a
// test names another) is gone, so an interrupted run (Ctrl-C, a killed Vitest
// worker) can't leave a fixture running for days, as B-704's silent one did.
const GUARD = [
  `const fakeParent = Number(process.env.FAKE_PARENT);`,
  `if (fakeParent) setInterval(() => { try { process.kill(fakeParent, 0); } catch { process.exit(1); } }, 250).unref();`,
].join("\n");
const SPECS = {
  specpass: [
    `import { expect, test } from "./fixtures.mjs";`,
    `test("core", { tag: "@smoke" }, async () => {`,
    `  await test.step("a step", () => expect(1).toBe(1));`,
    `});`,
    `test("extra", () => expect(2).toBe(2));`,
  ].join("\n"),
  specfail: [
    `import { expect, test } from "./fixtures.mjs";`,
    `test("fine", () => {});`,
    `test("broken", async () => {`,
    `  console.log("  - waiting for something with timeout 10000ms");`,
    `  await test.step("a soft step", () => expect.soft(2, "soft").toBe(3));`,
    `  expect(1, "the number").toBe(2);`,
    `});`,
  ].join("\n"),
  // One line per attempt in specbusy.pids: the worker's pid (the retry's is the second).
  specbusy: [
    `import { appendFileSync } from "node:fs";`,
    `import { test } from "./fixtures.mjs";`,
    `test("busy", async () => {`,
    `  appendFileSync(process.env.FAKE_STATE + "/specbusy.pids", process.pid + "\\n");`,
    `  for (let i = 0; i < 300; i++) { console.log("tick " + i); await new Promise((r) => setTimeout(r, 200)); }`,
    `});`,
  ].join("\n"),
  specsilent: [
    `import { writeFileSync } from "node:fs";`,
    `import { test } from "./fixtures.mjs";`,
    `test("silent", async () => {`,
    `  writeFileSync(process.env.FAKE_STATE + "/specsilent.pid", String(process.pid));`,
    `  await new Promise((r) => setTimeout(r, 80_000));`,
    `});`,
  ].join("\n"),
  specflaky: [
    `import { existsSync, writeFileSync } from "node:fs";`,
    `import { test } from "./fixtures.mjs";`,
    `test("flaky", () => {`,
    `  const f = process.env.FAKE_STATE + "/specflaky";`,
    `  if (!existsSync(f)) { writeFileSync(f, "1"); throw new Error("timed out waiting for x"); }`,
    `});`,
  ].join("\n"),
  // Prints its last line and then never exits: browser.sh stops it (never-exits yes).
  spechang: [
    `import { test } from "./fixtures.mjs";`,
    `test("hang", async () => {`,
    `  console.log("1/1 passed");`,
    `  await new Promise((r) => setTimeout(r, 60_000));`,
    `});`,
  ].join("\n"),
  specslow: [
    `import { test } from "./fixtures.mjs";`,
    `test("slow", async () => {`,
    `  for (let i = 0; i < 240; i++) { console.log("tick " + i); await new Promise((r) => setTimeout(r, 250)); }`,
    `});`,
  ].join("\n"),
};

// check, cap, never-exits, e2e. specbusy's cap counts Node's and Playwright's
// start as well as the spec: at a load of 47 that start took over 4 s (B-446:
// neither attempt reached the spec), so 15 leaves room for a loaded machine.
const MANIFEST = `# check cap never-exits e2e
specpass   30  no   yes
specfail   30  no   yes
specbusy   15  no   no
specsilent 90  no   no
specflaky  30  no   no
spechang   30  yes  no
specslow   60  no   no
`;

let root, repo, env;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "browser-test-")));
  repo = join(root, "repo");
  const checks = join(repo, "scripts/browser-checks");
  mkdirSync(checks, { recursive: true });
  mkdirSync(join(repo, "scripts/loops"), { recursive: true });
  for (const [name, src] of Object.entries(SPECS))
    writeFileSync(join(checks, `${name}.spec.mjs`), `${src}\n${GUARD}\n`);
  for (const file of ["playwright.config.mjs", "reporter.mjs", "fixtures.mjs"])
    cpSync(new URL(`../browser-checks/${file}`, import.meta.url), join(checks, file));
  symlinkSync(new URL("../../node_modules", import.meta.url).pathname, join(repo, "node_modules"));
  writeFileSync(join(repo, "scripts/loops/checks"), MANIFEST);
  writeFileSync(join(repo, ".nvmrc"), `${process.versions.node.split(".")[0]}\n`);
  execFileSync("git", ["init", "-q", repo]);
  mkdirSync(join(root, "state"));
  env = {
    ...process.env,
    PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
    CARETOOK_BROWSER_LEASES: join(root, "leases"),
    CARETOOK_BROWSER_FLAKES: join(root, "flakes.log"),
    CARETOOK_RUN_LOG: join(root, "run-log.jsonl"),
    // Generous, so a loaded machine's slow Node start isn't silence; the silent
    // check's test sets 2.
    CARETOOK_BROWSER_SILENCE: "10",
    CARETOOK_BROWSER_PAUSE: "0",
    CARETOOK_BROWSER_BUSY: "100000",
    CARETOOK_BROWSER_SUITE: "",
    CARETOOK_BROWSER_SUITE_CAP: "",
    CARETOOK_BROWSER_RETRY: "1",
    // A one-spec run never consults the load gate; off, so a suite's doesn't wait
    // on the real machine's load either (the busy-gate test sets it back).
    CARETOOK_LOAD_GATE: "off",
    FAKE_STATE: join(root, "state"),
    FAKE_PARENT: String(process.pid),
  };
});

// The process groups this file's runs started (each run's bash leads its own).
const groups = new Set();
const groupAlive = (g) => {
  try {
    process.kill(-g, 0);
    return true;
  } catch {
    return false;
  }
};
const pidAlive = (p) => {
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
};
const killGroups = () => {
  for (const g of groups) {
    try {
      process.kill(-g, "SIGKILL");
    } catch {
      // already gone
    }
  }
  groups.clear();
};
// A run killed outright (as the interrupt tests do) can't release its lease:
// drop the leases too, so the next test starts with none held.
afterEach(() => {
  killGroups();
  rmSync(env.CARETOOK_BROWSER_LEASES, { recursive: true, force: true });
});
afterAll(() => {
  killGroups();
  rmSync(root, { recursive: true, force: true });
});

/** Waits for `ok()`, polling, for at most `ms`; returns its last answer. */
const until = async (ok, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return ok();
};

// start ARGS → browser.sh in its own process group; `done` resolves once it has
// exited and its output pipes have closed.
const start = (args, extra = {}) => {
  const child = spawn("bash", [BROWSER, ...args], {
    cwd: repo,
    env: { ...env, ...extra },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  groups.add(child.pid);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
  child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
  const done = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ stdout, stderr, status: code ?? signal })),
  );
  return { child, done };
};
const run = async (args, extra = {}) => {
  const started = Date.now();
  const { stdout, stderr, status } = await start(args, extra).done;
  return { out: `${stdout}${stderr}`, stdout, stderr, status, secs: (Date.now() - started) / 1000 };
};
const leasesLeft = () => {
  try {
    return readdirSync(env.CARETOOK_BROWSER_LEASES).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
};

// Each run sources nvm and starts Node; under `pnpm check` that is slow.
const SLOW = { timeout: 90_000 };

describe("a check's run", SLOW, () => {
  it("prints everything with --verbose, and releases its lease", async () => {
    const { out, status } = await run(["--verbose", "specpass"]);
    expect(status).toBe(0);
    expect(out).toMatch(/^PASS core /m);
    expect(out).toMatch(/Released browser lease/);
  });

  // The manifest's columns: the cap (2) is "kills a spec at its cap", e2e (4) is
  // "a suite"; never-exits (3) is this one.
  it("stops a never-exiting check after its last line, as the manifest says", async () => {
    // Read wrong, the spec would sit silent until a TIMEOUT.
    const { out, status } = await run(["--no-retry", "--verbose", "spechang"]);
    expect(status).toBe(0);
    expect(out).toMatch(/stopped 2s after its last line, as expected for spechang\.spec\.mjs: 1\/1 passed/);
    expect(out).toMatch(/^■ spechang\.spec\.mjs: pass/m);
  });

  it("lets --timeout override the manifest's cap", async () => {
    const { out } = await run(["--no-retry", "--timeout", "1", "specbusy"]);
    expect(out).toMatch(/^TIMEOUT \(killed at its 1s --timeout\)$/m);
  });

  it("releases its lease before it exits when it's TERMed mid-check", async () => {
    const { child, done } = start(["--no-retry", "specsilent"]);
    await until(() => leasesLeft().length > 0, 30_000);
    expect(leasesLeft()).toEqual(["1"]);
    child.kill("SIGTERM");
    expect((await done).status).toBe(143);
    expect(leasesLeft()).toEqual([]);
  });

  it("stops its check, worker and all, when it's TERMed while the check runs", async () => {
    const pidFile = join(env.FAKE_STATE, "specsilent.pid");
    rmSync(pidFile, { force: true });
    const { child, done } = start(["--no-retry", "specsilent"], { CARETOOK_BROWSER_SILENCE: "60" });
    expect(await until(() => existsSync(pidFile), 60_000)).toBe(true);
    const worker = Number(readFileSync(pidFile, "utf8"));
    child.kill("SIGTERM");
    expect((await done).status).toBe(143);
    expect(await until(() => !pidAlive(worker))).toBe(true);
    // Nothing of the run is left in its group (the output filter included).
    expect(await until(() => !groupAlive(child.pid))).toBe(true);
  });
});

describe("a run that's interrupted or throws", SLOW, () => {
  // B-704: an interrupted run left the silent fixture's group (browser.sh's
  // output filter and Playwright's runner) alive for days, in a deleted temp repo.
  it("leaves no fixture behind when the test process that started it is killed", async () => {
    const pidFile = join(env.FAKE_STATE, "specsilent.pid");
    rmSync(pidFile, { force: true });
    // A stand-in for an interrupted Vitest worker: it starts the run (in its own
    // group, as this file does) and is then killed outright, with no cleanup.
    const wrapper = spawn(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("node:child_process");
         const c = spawn("bash", process.argv.slice(1), { detached: true, stdio: ["ignore", "pipe", "pipe"],
           env: { ...process.env, FAKE_PARENT: String(process.pid) } });
         c.stdout.resume(); c.stderr.resume();
         console.log(c.pid);
         setInterval(() => {}, 1000);`,
        BROWSER,
        "--no-retry",
        "specsilent",
      ],
      // Silence and cap far off: only the fixture's own parent check can end it in time.
      { cwd: repo, env: { ...env, CARETOOK_BROWSER_SILENCE: "600" }, stdio: ["ignore", "pipe", "inherit"] },
    );
    const group = Number(await new Promise((r) => wrapper.stdout.once("data", (d) => r(String(d).trim()))));
    groups.add(group);
    expect(await until(() => existsSync(pidFile), 60_000)).toBe(true);
    const worker = Number(readFileSync(pidFile, "utf8"));
    wrapper.kill("SIGKILL");
    expect(await until(() => !pidAlive(worker))).toBe(true);
    expect(await until(() => !groupAlive(group), 30_000)).toBe(true);
  });

  it("leaves no fixture's group alive when a test throws mid-run (afterEach kills it)", async () => {
    const pidFile = join(env.FAKE_STATE, "specsilent.pid");
    rmSync(pidFile, { force: true });
    let group = 0;
    const midRun = async () => {
      group = start(["--no-retry", "specsilent"], { CARETOOK_BROWSER_SILENCE: "600" }).child.pid;
      await until(() => existsSync(pidFile), 60_000);
      throw new Error("mid-run");
    };
    await expect(midRun()).rejects.toThrow("mid-run");
    const worker = Number(readFileSync(pidFile, "utf8"));
    // Nothing stopped it: the run is still going when the test fails.
    expect(groupAlive(group) && pidAlive(worker)).toBe(true);
    killGroups(); // what afterEach does after every test
    expect(await until(() => !pidAlive(worker))).toBe(true);
    expect(await until(() => !groupAlive(group))).toBe(true);
  });
});

describe("one spec", SLOW, () => {
  // The lines that matter, not a count (B-573: a third line under load, never
  // captured; not the load gate's, which a one-spec run never reaches). The
  // output is in each message, so a failure says what any stray line was.
  const cleanSpec = (out, status) => {
    expect(status, out).toBe(0);
    const lines = out.trim().split("\n");
    expect(lines[0], out).toMatch(/^▶ specpass\.spec\.mjs .* cap 30s/);
    expect(
      lines.filter((l) => l.startsWith("■ ")),
      out,
    ).toEqual([expect.stringMatching(/^■ specpass\.spec\.mjs: pass \(exit 0\)/)]);
    // Trimmed: none of the log's own lines (verbose's PASS, steps, tally).
    expect(out, out).not.toMatch(/^(PASS|SKIP|·|Running \d|\d+\/\d+ passed)/m);
    expect(
      lines.filter((l) => l.startsWith("▶ ")),
      out,
    ).toHaveLength(1);
  };

  it("passes a clean spec through Playwright Test, printing only its ▶ and ■ lines", async () => {
    const { out, status } = await run(["specpass"]);
    cleanSpec(out, status);
    expect(leasesLeft()).toEqual([]);
  });

  it("prints the same for a clean spec with the load gate busy (one spec never waits on it)", async () => {
    const loadFile = join(root, "busy-load");
    writeFileSync(loadFile, "99 99 99\n");
    const busy = {
      CARETOOK_LOAD_GATE: "",
      CARETOOK_LOAD_FILE: loadFile,
      CARETOOK_LOAD_BUSY: "1",
      CARETOOK_LOAD_WAIT: "1",
      CARETOOK_LOAD_POLL: "1",
    };
    const one = await run(["specpass"], busy);
    cleanSpec(one.out, one.status);
    expect(one.out).not.toMatch(/busy|load dropped|Gave up waiting for the load/);
    // The gate is busy: a suite (which does wait on it) says so.
    const suite = await run(["--suite"], { ...busy, CARETOOK_BROWSER_SUITE: "specpass" });
    expect(suite.out).toMatch(/^The machine is busy \(5-minute load 99, over 1\)/m);
    expect(suite.out).toMatch(/^Gave up waiting for the load after \d+s/m);
  });

  it("logs a PASS line per test and step, and the tally", async () => {
    const { out } = await run(["--verbose", "specpass"]);
    expect(out).toMatch(/^· {2}core › a step \(/m);
    expect(out).toMatch(/^PASS core \(/m);
    expect(out).toMatch(/^PASS extra \(/m);
    expect(out).toMatch(/^2\/2 passed$/m);
  });

  it("shows FAIL lines with their errors, and doesn't retry a plain failure (a call log's timeout isn't contention)", async () => {
    const { out, status } = await run(["specfail"]);
    expect(status).toBe(1);
    expect(out).toMatch(/^✗ broken › a soft step\n {2}Error: soft/m);
    expect(out).toMatch(/^FAIL broken\n {2}Error: soft[\s\S]* {2}Error: the number/m);
    expect(out).not.toMatch(/PASS fine/);
    expect(out).toMatch(/not retried: the failure doesn't look like contention/);
    expect(out).toMatch(/^■ specfail\.spec\.mjs: FAIL \(exit 1\)/m);
  });

  it("runs only @smoke tests in smoke mode, and says which it skipped", async () => {
    const { out, status } = await run(["--smoke", "--verbose", "specpass"]);
    expect(status).toBe(0);
    expect(out).toMatch(/· smoke$/m);
    expect(out).toMatch(/^PASS core /m);
    expect(out).toMatch(/^SKIP extra \(smoke\)$/m);
    expect(out).toMatch(/^1\/1 passed$/m);
  });

  // The cap counts Node's and Playwright's start (see MANIFEST), so this runs
  // with each Node process held 2.5 s at start, which alone is past the old 4 s
  // cap; the waits that follow are on events (a worker's pid gone), not a sleep.
  it("kills a spec at its cap, worker and all, and retries it once", { timeout: 150_000 }, async () => {
    const pids = join(env.FAKE_STATE, "specbusy.pids");
    rmSync(pids, { force: true });
    const slow = join(root, "slow-start.mjs");
    writeFileSync(slow, "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);\n");
    const { out, status } = await run(["specbusy"], {
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${slow}`.trim(),
      CARETOOK_BROWSER_SILENCE: "60",
    });
    expect(status, out).toBe(124);
    expect(out.match(/^TIMEOUT \(killed at its 15s cap\)$/gm), out).toHaveLength(2);
    expect(out).toMatch(/^↻ retrying specbusy\.spec\.mjs once/m);
    expect(out).not.toMatch(/tick/);
    // Both attempts reached the spec (the second line is the retry's), and both workers are gone.
    const workers = readFileSync(pids, "utf8").trim().split("\n").map(Number);
    expect(workers, out).toHaveLength(2);
    for (const w of workers) expect(await until(() => !pidAlive(w)), `worker ${w}`).toBe(true);
    expect(leasesLeft()).toEqual([]);
  });

  it("kills a silent spec at the silence limit", async () => {
    const { out, status, secs } = await run(["--no-retry", "specsilent"], { CARETOOK_BROWSER_SILENCE: "5" });
    expect(status).toBe(124);
    expect(out).toMatch(/^TIMEOUT \(silent: no output for 5s\)$/m);
    expect(secs).toBeLessThan(40);
  });

  it("records a spec's pass on the retry as FLAKY", async () => {
    const { out, status } = await run(["specflaky"]);
    expect(status).toBe(0);
    expect(out).toMatch(/^FAIL flaky\n {2}Error: timed out waiting for x/m);
    expect(out).toMatch(/^■ specflaky\.spec\.mjs: FLAKY/m);
    expect(readFileSync(env.CARETOOK_BROWSER_FLAKES, "utf8")).toMatch(/\tspecflaky\.spec\.mjs\t/);
  });
});

describe("a proof run's forced failure", SLOW, () => {
  it("fails a real spec on its first line, as a plain FAIL the runner doesn't call contention", async () => {
    const spec = join(repo, "scripts/browser-checks/specforced.spec.mjs");
    writeFileSync(spec, `${FORCED_LINE}${SPECS.specpass}\n`);
    try {
      const { out, status } = await run(["specforced"]);
      expect(status).not.toBe(0);
      expect(out).toMatch(/^■ specforced\.spec\.mjs: FAIL/m);
      expect(out).toContain("not retried");
    } finally {
      rmSync(spec);
    }
  });
});

describe("a suite", SLOW, () => {
  it("appends each check's result for CI's browser job", async () => {
    const results = join(root, "results.tsv");
    await run(["--suite", "--no-retry"], { CARETOOK_BROWSER_RESULTS: results });
    expect(readFileSync(results, "utf8")).toBe("specpass\tpass\t0\nspecfail\tFAIL\t0\n");
  });

  it("runs the manifest's e2e checks in order, then a table", async () => {
    const { out, status } = await run(["--suite"]);
    expect(status).toBe(1);
    expect(out).toMatch(/Running 2 checks \(suite cap 1m00s\): specpass specfail/);
    expect(out).toMatch(/^specpass\.spec\.mjs +pass /m);
    expect(out).toMatch(/^specfail\.spec\.mjs +FAIL /m);
    expect(out).toMatch(/1\/2 passed/);
  });

  it("stops at the suite cap and lists the rest as not run", async () => {
    const { out, status } = await run(["--suite"], {
      CARETOOK_BROWSER_SUITE: "specpass specslow specpass",
      CARETOOK_BROWSER_SUITE_CAP: "15",
    });
    expect(status).toBe(1);
    expect(out).toMatch(/^TIMEOUT \(killed at its ([1-9]|1[0-5])s suite cap\)$/m);
    expect(out).toMatch(/not retried: the suite cap is reached/);
    expect(out).toMatch(/^specslow\.spec\.mjs +TIMEOUT /m);
    expect(out).toMatch(/^specpass\.spec\.mjs +NOT-RUN /m);
    expect(out).toMatch(/1\/3 passed, 1 not run \(suite cap 0m15s reached\)/);
    expect(leasesLeft()).toEqual([]);
  });
});

const PACKAGE = '{\n  "name": "a",\n  "scripts": { "x": "1" }\n}\n';

// --changed --list against the real manifest and check-areas.d/, in a throwaway
// repo with a stub file per check (the selection only, nothing runs).
describe("--changed with the real map", SLOW, () => {
  let real;
  const realFile = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
  const lean = () =>
    realFile("./checks")
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"))
      .map((l) => l.split(/\s+/))
      .filter((f) => f[3] === "yes")
      .map((f) => f[0]);
  const changed = (files) => {
    execFileSync("git", ["-C", real, "clean", "-qfd", "apps", "packages"]);
    for (const f of files) {
      mkdirSync(dirname(join(real, f)), { recursive: true });
      writeFileSync(join(real, f), "// changed\n");
    }
    const r = spawnSync("bash", [BROWSER, "--changed", "--base", "HEAD", "--list"], {
      cwd: real,
      env,
      encoding: "utf8",
    });
    return { out: `${r.stdout}${r.stderr}`, status: r.status };
  };

  beforeAll(() => {
    real = join(root, "real");
    const checks = join(real, "scripts/browser-checks");
    mkdirSync(checks, { recursive: true });
    mkdirSync(join(real, "scripts/loops"), { recursive: true });
    writeFileSync(join(real, "scripts/loops/checks"), realFile("./checks"));
    cpSync(new URL("./check-areas.d", import.meta.url), join(real, "scripts/loops/check-areas.d"), {
      recursive: true,
    });
    // The resolver runs from the checkout's top through the config's checkAreas hook, so
    // the throwaway repo carries the project's scripts too.
    cpSync(join(dirname(BROWSER), "..", "project"), join(real, "scripts", "project"), {
      recursive: true,
      filter: (src) => !src.endsWith(".test.mjs"),
    });
    for (const line of realFile("./checks").split("\n"))
      if (line.trim() && !line.startsWith("#"))
        writeFileSync(join(checks, `${line.split(/\s+/)[0]}.spec.mjs`), "\n");
    writeFileSync(join(real, ".nvmrc"), `${process.versions.node.split(".")[0]}\n`);
    mkdirSync(join(real, "packages/data"), { recursive: true });
    writeFileSync(join(real, "packages/data/package.json"), PACKAGE);
    execFileSync("git", ["init", "-q", real]);
    execFileSync("git", ["-C", real, "add", "."]);
    execFileSync("git", [
      "-C",
      real,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-qm",
      "base",
    ]);
  });

  it("leaves out the lean set for a scripts-only package.json and keeps it for any other change", () => {
    const file = "packages/data/package.json";
    execFileSync("git", ["-C", real, "clean", "-qfd", "apps", "packages"]);
    const list = (text) => {
      writeFileSync(join(real, file), text);
      const r = spawnSync("bash", [BROWSER, "--changed", "--base", "HEAD", "--list"], {
        cwd: real,
        env,
        encoding: "utf8",
      });
      return `${r.stdout}${r.stderr}`;
    };
    try {
      const scriptsOnly = list(PACKAGE.replace('"x": "1"', '"x": "2"'));
      expect(scriptsOnly).toMatch(/packages\/data\/package\.json +- \(scripts only\)$/m);
      expect(scriptsOnly).toMatch(/No browser checks needed for these changes\./);
      const other = list(PACKAGE.replace('"name": "a"', '"name": "b"'));
      expect(other).toMatch(/packages\/data\/package\.json +@suite$/m);
      expect(other).toMatch(/needs the whole lean set/);
    } finally {
      execFileSync("git", ["-C", real, "checkout", "-q", "--", file]);
    }
  });

  it("selects no end-to-end check for a timeline-only change (component tests cover it)", () => {
    const { out, status } = changed([
      "apps/web/app/routes/app/groups/timeline/TimelineEntryRow.tsx",
      "apps/web/app/routes/app/groups/timeline/TimelineEntryCard.tsx",
      "apps/web/app/routes/app/groups/timeline/TodayCard.tsx",
      "apps/web/app/routes/app/groups/timeline/timelineLayout.browser.test.tsx",
    ]);
    expect(status).toBe(0);
    expect(out).toMatch(/TimelineEntryRow\.tsx +-$/m);
    expect(out).toMatch(/No browser checks needed for these changes\./);
  });

  it("maps a lib module, a device query and a screen through the area rules and fallbacks", () => {
    const { out, status } = changed([
      "apps/web/app/lib/timeline/exampleRule.ts",
      "apps/web/app/lib/timeline/exampleRule.test.ts",
      "apps/web/app/lib/timeline/timeline.sync.ts",
      "apps/web/app/routes/app/groups/settings/members/MembersList.tsx",
    ]);
    expect(status).toBe(0);
    expect(out).toMatch(/lib\/timeline\/exampleRule\.ts +- \(unit-tested\)$/m);
    expect(out).toMatch(/lib\/timeline\/exampleRule\.test\.ts +-$/m);
    expect(out).toMatch(/lib\/timeline\/timeline\.sync\.ts +phase2 roundtrip$/m);
    expect(out).toMatch(/MembersList\.tsx +app-shell$/m);
    expect(out).toMatch(/^Checks needed: phase2 roundtrip app-shell$/m);
  });

  it("needs nothing for a check the change deletes (its screens moved to component tests)", () => {
    const gone = "scripts/browser-checks/phase2.spec.mjs";
    execFileSync("git", ["-C", real, "clean", "-qfd", "apps", "packages"]);
    rmSync(join(real, gone));
    try {
      const r = spawnSync("bash", [BROWSER, "--changed", "--base", "HEAD", "--list"], {
        cwd: real,
        env,
        encoding: "utf8",
      });
      const out = `${r.stdout}${r.stderr}`;
      expect(r.status).toBe(0);
      expect(out).toMatch(/phase2\.spec\.mjs +- \(deleted\)$/m);
      expect(out).not.toMatch(/skipping phase2/);
      expect(out).toMatch(/No browser checks needed for these changes\./);
    } finally {
      execFileSync("git", ["-C", real, "checkout", "--", gone]);
    }
  });

  it("runs the lean set for a migration, plus an unmoved area's own check, in manifest order", () => {
    const { out, status } = changed([
      "packages/data/src/db/migrations/0099_example.sql",
      "apps/web/app/routes/account/join/route.tsx",
    ]);
    expect(status).toBe(0);
    const set = lean();
    expect(set).toContain("sign-in");
    expect(set).not.toContain("groups");
    const all = realFile("./checks")
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"))
      .map((l) => l.split(/\s+/)[0]);
    const want = all.filter((c) => set.includes(c) || c === "groups");
    expect(out).toMatch(new RegExp(`^Checks needed: ${want.join(" ")}$`, "m"));
  });
});

describe("the run log", SLOW, () => {
  it("records a pass, a flaky pass and a failure, each with its result", async () => {
    const log = join(root, "results-run-log.jsonl");
    const state = join(root, "results-state");
    mkdirSync(state);
    const extra = { CARETOOK_RUN_LOG: log, FAKE_STATE: state };
    expect((await run(["specpass"], extra)).status).toBe(0);
    expect((await run(["specflaky"], extra)).status).toBe(0);
    expect((await run(["--no-retry", "specfail"], extra)).status).not.toBe(0);
    const events = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(events.map((e) => [e.kind, e.check, e.result, e.retried])).toEqual([
      ["browser", "specpass", "pass", false],
      ["browser", "specflaky", "flaky", true],
      ["browser", "specfail", "fail", false],
    ]);
    for (const e of events) {
      expect(e.mode).toBe("one");
      expect(e.seconds).toBeGreaterThanOrEqual(0);
    }
  });
});
