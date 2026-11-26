// browser.sh, the gate around a project's browser runner: its watchdog, caps,
// retry, trimmed output, lease and --changed, on the sample project (its browser
// hook, tools/browser-hook.sh, runs fake checks: Node scripts that print a
// runner's lines). Its leases and flakes log are moved into the temp dir, so these
// never take one of the machine's real browser leases. Each run is its own process
// group, and afterEach kills every group a test started, so a test that fails,
// throws or times out leaves nothing running; the fake checks also end themselves
// once this test process is gone (B-704). A project's own runner and checks have
// their own tests.
import { spawn } from "node:child_process";
import {
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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { makeRepo } from "./sample-project/repo.mjs";

// The repo's own copy (makeRepo's), so it reads the sample's config.
let BROWSER;

// Fake checks: they print what a runner would and never open a browser. `pid`
// files let a test see that a killed run's worker is gone. Each starts with GUARD
// (before any top-level await): it exits once FAKE_PARENT (this test process, unless a test names another) is
// gone, so an interrupted run (Ctrl-C, a killed Vitest worker) can't leave a
// fixture running for days, as B-704's silent one did.
const GUARD = [
  `const fakeParent = Number(process.env.FAKE_PARENT);`,
  `if (fakeParent) setInterval(() => { try { process.kill(fakeParent, 0); } catch { process.exit(1); } }, 250).unref();`,
].join("\n");
const SPECS = {
  specpass: [
    `const smoke = process.env.SMOKE === "1";`,
    `console.log("·  core › a step (1ms)");`,
    `console.log("PASS core (2ms)");`,
    `console.log(smoke ? "SKIP extra (smoke)" : "PASS extra (1ms)");`,
    `console.log(smoke ? "1/1 passed" : "2/2 passed");`,
  ].join("\n"),
  specfail: [
    `console.log("PASS fine (1ms)");`,
    `console.log("  - waiting for something with timeout 10000ms");`,
    `console.log("✗ broken › a soft step\\n  Error: soft");`,
    `console.log("FAIL broken\\n  Error: soft\\n  Error: the number");`,
    `console.log("1/2 passed");`,
    `process.exitCode = 1;`,
  ].join("\n"),
  // One line per attempt in specbusy.pids: the worker's pid (the retry's is the second).
  specbusy: [
    `import { appendFileSync } from "node:fs";`,
    `appendFileSync(process.env.FAKE_STATE + "/specbusy.pids", process.pid + "\\n");`,
    `for (let i = 0; i < 300; i++) { console.log("tick " + i); await new Promise((r) => setTimeout(r, 200)); }`,
  ].join("\n"),
  specsilent: [
    `import { writeFileSync } from "node:fs";`,
    `writeFileSync(process.env.FAKE_STATE + "/specsilent.pid", String(process.pid));`,
    `await new Promise((r) => setTimeout(r, 80_000));`,
  ].join("\n"),
  specflaky: [
    `import { existsSync, writeFileSync } from "node:fs";`,
    `const f = process.env.FAKE_STATE + "/specflaky";`,
    `if (!existsSync(f)) { writeFileSync(f, "1"); console.log("FAIL flaky\\n  Error: timed out waiting for x\\n0/1 passed"); process.exit(1); }`,
    `console.log("PASS flaky (1ms)\\n1/1 passed");`,
  ].join("\n"),
  // Prints its last line and then never exits: browser.sh stops it (never-exits yes).
  spechang: [`console.log("1/1 passed");`, `await new Promise((r) => setTimeout(r, 60_000));`].join("\n"),
  specslow: [
    `for (let i = 0; i < 240; i++) { console.log("tick " + i); await new Promise((r) => setTimeout(r, 250)); }`,
  ].join("\n"),
};

// check, cap, never-exits, e2e. specbusy's cap counts Node's start as well as the
// check: at a load of 47 a start took over 4 s (B-446), so 15 leaves room for a
// loaded machine.
const MANIFEST = `# check cap never-exits e2e
specpass   30  no   yes
specfail   30  no   yes
specbusy   15  no   no
specsilent 90  no   no
specflaky  30  no   no
spechang   30  yes  no
specslow   60  no   no
`;

// The sample's check-areas hook reads these (tools/check-areas.sh): first match wins.
const RULES = `db/*      @suite
web/a*    specflaky specpass
docs/*    -
gone/*    specgone
`;

let root, repo, env;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "browser-test-")));
  repo = join(root, "repo");
  const files = {
    "tools/checks": MANIFEST,
    "tools/check-areas/rules": RULES,
    ".nvmrc": `${process.versions.node.split(".")[0]}\n`,
  };
  for (const [name, src] of Object.entries(SPECS))
    files[`tools/browser-checks/${name}.mjs`] = `${GUARD}\n${src}\n`;
  makeRepo(repo, { files });
  BROWSER = join(repo, "scripts/loops/browser.sh");
  mkdirSync(join(root, "state"));
  const { RISA_CONFIG: _, ...rest } = process.env;
  env = {
    ...rest,
    PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
    RISA_BROWSER_LEASES: join(root, "leases"),
    RISA_BROWSER_FLAKES: join(root, "flakes.log"),
    RISA_RUN_LOG: join(root, "run-log.jsonl"),
    // Generous, so a loaded machine's slow Node start isn't silence; the silent
    // check's test sets 2.
    RISA_BROWSER_SILENCE: "10",
    RISA_BROWSER_PAUSE: "0",
    RISA_BROWSER_BUSY: "100000",
    RISA_BROWSER_SUITE: "",
    RISA_BROWSER_SUITE_CAP: "",
    RISA_BROWSER_RETRY: "1",
    // A one-check run never consults the load gate; off, so a suite's doesn't wait
    // on the real machine's load either (the busy-gate test sets it back).
    RISA_LOAD_GATE: "off",
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
  rmSync(env.RISA_BROWSER_LEASES, { recursive: true, force: true });
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
    return readdirSync(env.RISA_BROWSER_LEASES).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
};

// Each run starts Node a few times; under `pnpm check` that is slow.
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
    expect(out).toMatch(/stopped 2s after its last line, as expected for spechang\.mjs: 1\/1 passed/);
    expect(out).toMatch(/^■ spechang\.mjs: pass/m);
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
    const { child, done } = start(["--no-retry", "specsilent"], { RISA_BROWSER_SILENCE: "60" });
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
  // output filter and the check) alive for days, in a deleted temp repo.
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
      { cwd: repo, env: { ...env, RISA_BROWSER_SILENCE: "600" }, stdio: ["ignore", "pipe", "inherit"] },
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
      group = start(["--no-retry", "specsilent"], { RISA_BROWSER_SILENCE: "600" }).child.pid;
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
    expect(lines[0], out).toMatch(/^▶ specpass\.mjs .* cap 30s/);
    expect(
      lines.filter((l) => l.startsWith("■ ")),
      out,
    ).toEqual([expect.stringMatching(/^■ specpass\.mjs: pass \(exit 0\)/)]);
    // Trimmed: none of the log's own lines (verbose's PASS, steps, tally).
    expect(out, out).not.toMatch(/^(PASS|SKIP|·|Running \d|\d+\/\d+ passed)/m);
    expect(
      lines.filter((l) => l.startsWith("▶ ")),
      out,
    ).toHaveLength(1);
  };

  it("passes a clean check through the hook, printing only its ▶ and ■ lines", async () => {
    const { out, status } = await run(["specpass"]);
    cleanSpec(out, status);
    expect(leasesLeft()).toEqual([]);
  });

  it("prints the same for a clean spec with the load gate busy (one spec never waits on it)", async () => {
    const loadFile = join(root, "busy-load");
    writeFileSync(loadFile, "99 99 99\n");
    const busy = {
      RISA_LOAD_GATE: "",
      RISA_LOAD_FILE: loadFile,
      RISA_LOAD_BUSY: "1",
      RISA_LOAD_WAIT: "1",
      RISA_LOAD_POLL: "1",
    };
    const one = await run(["specpass"], busy);
    cleanSpec(one.out, one.status);
    expect(one.out).not.toMatch(/busy|load dropped|Gave up waiting for the load/);
    // The gate is busy: a suite (which does wait on it) says so.
    const suite = await run(["--suite"], { ...busy, RISA_BROWSER_SUITE: "specpass" });
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
    expect(out).toMatch(/^■ specfail\.mjs: FAIL \(exit 1\)/m);
  });

  it("runs only @smoke tests in smoke mode, and says which it skipped", async () => {
    const { out, status } = await run(["--smoke", "--verbose", "specpass"]);
    expect(status).toBe(0);
    expect(out).toMatch(/· smoke$/m);
    expect(out).toMatch(/^PASS core /m);
    expect(out).toMatch(/^SKIP extra \(smoke\)$/m);
    expect(out).toMatch(/^1\/1 passed$/m);
  });

  // The cap counts Node's start (see MANIFEST), so this runs
  // with each Node process held 2.5 s at start, which alone is past the old 4 s
  // cap; the waits that follow are on events (a worker's pid gone), not a sleep.
  it("kills a spec at its cap, worker and all, and retries it once", { timeout: 150_000 }, async () => {
    const pids = join(env.FAKE_STATE, "specbusy.pids");
    rmSync(pids, { force: true });
    const slow = join(root, "slow-start.mjs");
    writeFileSync(slow, "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);\n");
    const { out, status } = await run(["specbusy"], {
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${slow}`.trim(),
      RISA_BROWSER_SILENCE: "60",
    });
    expect(status, out).toBe(124);
    expect(out.match(/^TIMEOUT \(killed at its 15s cap\)$/gm), out).toHaveLength(2);
    expect(out).toMatch(/^↻ retrying specbusy\.mjs once/m);
    expect(out).not.toMatch(/tick/);
    // Both attempts reached the spec (the second line is the retry's), and both workers are gone.
    const workers = readFileSync(pids, "utf8").trim().split("\n").map(Number);
    expect(workers, out).toHaveLength(2);
    for (const w of workers) expect(await until(() => !pidAlive(w)), `worker ${w}`).toBe(true);
    expect(leasesLeft()).toEqual([]);
  });

  it("kills a silent spec at the silence limit", async () => {
    const { out, status, secs } = await run(["--no-retry", "specsilent"], { RISA_BROWSER_SILENCE: "5" });
    expect(status).toBe(124);
    expect(out).toMatch(/^TIMEOUT \(silent: no output for 5s\)$/m);
    expect(secs).toBeLessThan(40);
  });

  it("records a spec's pass on the retry as FLAKY", async () => {
    const { out, status } = await run(["specflaky"]);
    expect(status).toBe(0);
    expect(out).toMatch(/^FAIL flaky\n {2}Error: timed out waiting for x/m);
    expect(out).toMatch(/^■ specflaky\.mjs: FLAKY/m);
    expect(readFileSync(env.RISA_BROWSER_FLAKES, "utf8")).toMatch(/\tspecflaky\.mjs\t/);
  });
});

describe("a suite", SLOW, () => {
  it("appends each check's result for CI's browser job", async () => {
    const results = join(root, "results.tsv");
    await run(["--suite", "--no-retry"], { RISA_BROWSER_RESULTS: results });
    expect(readFileSync(results, "utf8")).toBe("specpass\tpass\t0\nspecfail\tFAIL\t0\n");
  });

  it("runs the manifest's e2e checks in order, then a table", async () => {
    const { out, status } = await run(["--suite"]);
    expect(status).toBe(1);
    expect(out).toMatch(/Running 2 checks \(suite cap 1m00s\): specpass specfail/);
    expect(out).toMatch(/^specpass\.mjs +pass /m);
    expect(out).toMatch(/^specfail\.mjs +FAIL /m);
    expect(out).toMatch(/1\/2 passed/);
  });

  it("stops at the suite cap and lists the rest as not run", async () => {
    const { out, status } = await run(["--suite"], {
      RISA_BROWSER_SUITE: "specpass specslow specpass",
      RISA_BROWSER_SUITE_CAP: "15",
    });
    expect(status).toBe(1);
    expect(out).toMatch(/^TIMEOUT \(killed at its ([1-9]|1[0-5])s suite cap\)$/m);
    expect(out).toMatch(/not retried: the suite cap is reached/);
    expect(out).toMatch(/^specslow\.mjs +TIMEOUT /m);
    expect(out).toMatch(/^specpass\.mjs +NOT-RUN /m);
    expect(out).toMatch(/1\/3 passed, 1 not run \(suite cap 0m15s reached\)/);
    expect(leasesLeft()).toEqual([]);
  });
});

// --changed --list through the sample's check-areas hook (tools/check-areas.sh and
// RULES): what the gate makes of its answers.
describe("--changed", SLOW, () => {
  const list = async (files) => {
    for (const f of files) {
      mkdirSync(dirname(join(repo, f)), { recursive: true });
      writeFileSync(join(repo, f), "changed\n");
    }
    try {
      return await run(["--changed", "--base", "HEAD", "--list"]);
    } finally {
      for (const f of files) rmSync(join(repo, f.split("/")[0]), { recursive: true, force: true });
    }
  };

  it("lists each file's checks and the checks needed, in the manifest's order", async () => {
    const { out, status } = await list(["web/a.ts", "docs/x.md"]);
    expect(status, out).toBe(0);
    expect(out).toMatch(/^Changed since HEAD \([0-9a-f]+\): 2 file\(s\)$/m);
    expect(out).toMatch(/^ {2}web\/a\.ts +specflaky specpass$/m);
    expect(out).toMatch(/^ {2}docs\/x\.md +-$/m);
    expect(out).toMatch(/^Checks needed: specpass specflaky$/m);
    expect(leasesLeft()).toEqual([]);
  });

  it("adds the lean set for @suite, warns about an unmapped file with the hook's default, and skips a check the tree hasn't", async () => {
    const { out, status } = await list(["db/0099.sql", "other/x.txt", "gone/a.txt"]);
    expect(status, out).toBe(0);
    expect(out).toMatch(/needs the whole lean set/);
    expect(out).toMatch(/^No rule in tools\/check-areas\/ for: other\/x\.txt$/m);
    expect(out).toMatch(/^ {2}\(running specpass for them; add a rule\)$/m);
    expect(out).toMatch(/^\(skipping specgone: not in this tree\)$/m);
    expect(out).toMatch(/^Checks needed: specpass specfail$/m);
  });

  it("needs nothing when no file needs a check", async () => {
    const { out, status } = await list(["docs/y.md"]);
    expect(status, out).toBe(0);
    expect(out).toMatch(/No browser checks needed for these changes\./);
  });
});

describe("the hook's run", SLOW, () => {
  it("gets the check's name and the extra args after --", async () => {
    const log = join(root, "hook.log");
    const { status } = await run(["specpass", "a.mjs"], { SAMPLE_BROWSER_LOG: log });
    expect(status).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("run specpass a.mjs\n");
  });

  it("names the checks it has when asked for one it hasn't", async () => {
    const { out, status } = await run(["nosuch"]);
    expect(status).not.toBe(0);
    expect(out).toMatch(/no check nosuch \(the browser hook lists: spec/);
  });
});

describe("the run log", SLOW, () => {
  it("records a pass, a flaky pass and a failure, each with its result", async () => {
    const log = join(root, "results-run-log.jsonl");
    const state = join(root, "results-state");
    mkdirSync(state);
    const extra = { RISA_RUN_LOG: log, FAKE_STATE: state };
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
