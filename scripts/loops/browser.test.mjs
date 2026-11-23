// browser.sh's watchdog, caps, retry and trimmed output, with fake Playwright
// Test specs in a throwaway repo (run with the real config, reporter and
// fixtures, and this repo's node_modules). Its leases and flakes log are moved
// into the temp dir, so these never take one of the machine's real browser leases.
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BROWSER = new URL("./browser.sh", import.meta.url).pathname;

// Fake specs: they import the real fixtures (smoke mode lives there) and never
// open a browser. `pid` files let a test see that a killed run's worker is gone.
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
  specbusy: [
    `import { writeFileSync } from "node:fs";`,
    `import { test } from "./fixtures.mjs";`,
    `test("busy", async () => {`,
    `  writeFileSync(process.env.FAKE_STATE + "/specbusy.pid", String(process.pid));`,
    `  for (let i = 0; i < 300; i++) { console.log("tick " + i); await new Promise((r) => setTimeout(r, 200)); }`,
    `});`,
  ].join("\n"),
  specsilent: [
    `import { test } from "./fixtures.mjs";`,
    `test("silent", async () => { await new Promise((r) => setTimeout(r, 80_000)); });`,
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

// check, cap, never-exits, e2e
const MANIFEST = `# check cap never-exits e2e
specpass   30  no   yes
specfail   30  no   yes
specbusy    4  no   no
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
    writeFileSync(join(checks, `${name}.spec.mjs`), `${src}\n`);
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
    // Generous, so a loaded machine's slow Node start isn't silence; the silent
    // check's test sets 2.
    CARETOOK_BROWSER_SILENCE: "10",
    CARETOOK_BROWSER_PAUSE: "0",
    CARETOOK_BROWSER_BUSY: "100000",
    CARETOOK_BROWSER_SUITE: "",
    CARETOOK_BROWSER_SUITE_CAP: "",
    CARETOOK_BROWSER_RETRY: "1",
    FAKE_STATE: join(root, "state"),
  };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const run = (args, extra = {}) => {
  const started = Date.now();
  const r = spawnSync("bash", [BROWSER, ...args], { cwd: repo, env: { ...env, ...extra }, encoding: "utf8" });
  return { out: `${r.stdout}${r.stderr}`, status: r.status, secs: (Date.now() - started) / 1000 };
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
  it("prints everything with --verbose, and releases its lease", () => {
    const { out, status } = run(["--verbose", "specpass"]);
    expect(status).toBe(0);
    expect(out).toMatch(/^PASS core /m);
    expect(out).toMatch(/Released browser lease/);
  });

  // The manifest's columns: the cap (2) is "kills a spec at its cap", e2e (4) is
  // "a suite"; never-exits (3) is this one.
  it("stops a never-exiting check after its last line, as the manifest says", () => {
    // Read wrong, the spec would sit silent until a TIMEOUT.
    const { out, status } = run(["--no-retry", "--verbose", "spechang"]);
    expect(status).toBe(0);
    expect(out).toMatch(/stopped 2s after its last line, as expected for spechang\.spec\.mjs: 1\/1 passed/);
    expect(out).toMatch(/^■ spechang\.spec\.mjs: pass/m);
  });

  it("lets --timeout override the manifest's cap", () => {
    const { out } = run(["--no-retry", "--timeout", "1", "specbusy"]);
    expect(out).toMatch(/^TIMEOUT \(killed at its 1s --timeout\)$/m);
  });

  it("releases its lease before it exits when it's TERMed mid-check", async () => {
    const child = spawn("bash", [BROWSER, "--no-retry", "specsilent"], { cwd: repo, env, stdio: "ignore" });
    const exited = new Promise((r) => child.once("exit", (code) => r(code)));
    const end = Date.now() + 30_000;
    while (leasesLeft().length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    expect(leasesLeft()).toEqual(["1"]);
    child.kill("SIGTERM");
    expect(await exited).toBe(143);
    expect(leasesLeft()).toEqual([]);
  });
});

describe("one spec", SLOW, () => {
  it("passes a clean spec through Playwright Test, printing only its ▶ and ■ lines", () => {
    const { out, status } = run(["specpass"]);
    expect(status).toBe(0);
    expect(out).toMatch(/^▶ specpass\.spec\.mjs .* cap 30s/m);
    expect(out).toMatch(/^■ specpass\.spec\.mjs: pass \(exit 0\)/m);
    expect(out.trim().split("\n")).toHaveLength(2);
    expect(leasesLeft()).toEqual([]);
  });

  it("logs a PASS line per test and step, and the tally", () => {
    const { out } = run(["--verbose", "specpass"]);
    expect(out).toMatch(/^· {2}core › a step \(/m);
    expect(out).toMatch(/^PASS core \(/m);
    expect(out).toMatch(/^PASS extra \(/m);
    expect(out).toMatch(/^2\/2 passed$/m);
  });

  it("shows FAIL lines with their errors, and doesn't retry a plain failure (a call log's timeout isn't contention)", () => {
    const { out, status } = run(["specfail"]);
    expect(status).toBe(1);
    expect(out).toMatch(/^✗ broken › a soft step\n {2}Error: soft/m);
    expect(out).toMatch(/^FAIL broken\n {2}Error: soft[\s\S]* {2}Error: the number/m);
    expect(out).not.toMatch(/PASS fine/);
    expect(out).toMatch(/not retried: the failure doesn't look like contention/);
    expect(out).toMatch(/^■ specfail\.spec\.mjs: FAIL \(exit 1\)/m);
  });

  it("runs only @smoke tests in smoke mode, and says which it skipped", () => {
    const { out, status } = run(["--smoke", "--verbose", "specpass"]);
    expect(status).toBe(0);
    expect(out).toMatch(/· smoke$/m);
    expect(out).toMatch(/^PASS core /m);
    expect(out).toMatch(/^SKIP extra \(smoke\)$/m);
    expect(out).toMatch(/^1\/1 passed$/m);
  });

  it("kills a spec at its cap, worker and all, and retries it once", () => {
    const { out, status } = run(["specbusy"]);
    expect(status).toBe(124);
    expect(out.match(/^TIMEOUT \(killed at its 4s cap\)$/gm)).toHaveLength(2);
    expect(out).not.toMatch(/tick/);
    const pidFile = join(env.FAKE_STATE, "specbusy.pid");
    expect(existsSync(pidFile)).toBe(true);
    expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
    expect(leasesLeft()).toEqual([]);
  });

  it("kills a silent spec at the silence limit", () => {
    const { out, status, secs } = run(["--no-retry", "specsilent"], { CARETOOK_BROWSER_SILENCE: "5" });
    expect(status).toBe(124);
    expect(out).toMatch(/^TIMEOUT \(silent: no output for 5s\)$/m);
    expect(secs).toBeLessThan(40);
  });

  it("records a spec's pass on the retry as FLAKY", () => {
    const { out, status } = run(["specflaky"]);
    expect(status).toBe(0);
    expect(out).toMatch(/^FAIL flaky\n {2}Error: timed out waiting for x/m);
    expect(out).toMatch(/^■ specflaky\.spec\.mjs: FLAKY/m);
    expect(readFileSync(env.CARETOOK_BROWSER_FLAKES, "utf8")).toMatch(/\tspecflaky\.spec\.mjs\t/);
  });
});

describe("a suite", SLOW, () => {
  it("runs the manifest's e2e checks in order, then a table", () => {
    const { out, status } = run(["--suite"]);
    expect(status).toBe(1);
    expect(out).toMatch(/Running 2 checks \(suite cap 1m00s\): specpass specfail/);
    expect(out).toMatch(/^specpass\.spec\.mjs +pass /m);
    expect(out).toMatch(/^specfail\.spec\.mjs +FAIL /m);
    expect(out).toMatch(/1\/2 passed/);
  });

  it("stops at the suite cap and lists the rest as not run", () => {
    const { out, status } = run(["--suite"], {
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
