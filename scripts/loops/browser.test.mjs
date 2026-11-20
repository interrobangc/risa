// browser.sh's watchdog, caps, retry and trimmed output, with fake checks in a
// throwaway repo. Its leases and flakes log are moved into the temp dir, so
// these never take one of the machine's real browser leases.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import {
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BROWSER = new URL("./browser.sh", import.meta.url).pathname;

// Each fake check is a tiny Node script; `state` is a file it can use to act
// differently on its retry.
const FAKES = {
  clean: `for (let i = 1; i <= 5; i++) console.log("PASS step " + i);\nconsole.log("5/5 passed");`,
  failing: [
    `console.log("PASS one");`,
    `console.log("FAIL two  (wanted 2, got 3)");`,
    `console.log("  detail line");`,
    `console.log("PASS three");`,
    `console.log("2/3 passed");`,
    `process.exit(1);`,
  ].join("\n"),
  crashing: `console.log("PASS one");\nthrow new Error("boom");`,
  quiet: `console.log("PASS one");\nconsole.log("something odd");\nprocess.exit(2);`,
  silent: `console.log("PASS started");\nsetInterval(() => {}, 1000);`,
  busy: `let i = 0;\nsetInterval(() => console.log("PASS tick " + i++), 200);`,
  flaky: [
    `import { existsSync, writeFileSync } from "node:fs";`,
    `const f = process.env.FAKE_STATE + "/flaky";`,
    `if (!existsSync(f)) {`,
    `  writeFileSync(f, "1");`,
    `  console.log("step: timed out waiting for x\\n[step] at /app\\n  (no errors reported)");`,
    `  process.exit(1);`,
    `}`,
    `console.log("1/1 passed");`,
  ].join("\n"),
  lingering: `console.log("PASS a");\nconsole.log("2/2 passed");\nsetInterval(() => {}, 1000);`,
  slow: `let i = 0;\nconst t = setInterval(() => { console.log("PASS " + i++); if (i > 32) { clearInterval(t); console.log("done"); } }, 250);`,
};

// check, usual, cap, never-exits, e2e
const MANIFEST = `# check usual cap never-exits e2e
clean      1  20  no   yes
failing    1  20  no   yes
crashing   1  20  no   no
quiet      1  20  no   no
silent     1  60  no   no
busy       1   2  no   no
flaky      1  20  no   no
lingering  1  20  yes  no
slow       1  20  no   no
`;

let root, repo, env;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "browser-test-")));
  repo = join(root, "repo");
  const checks = join(repo, "scripts/browser-checks");
  mkdirSync(checks, { recursive: true });
  mkdirSync(join(repo, "scripts/loops"), { recursive: true });
  for (const [name, src] of Object.entries(FAKES)) writeFileSync(join(checks, `${name}.mjs`), `${src}\n`);
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

describe("one check", SLOW, () => {
  it("passes a clean check, printing only its ▶ and ■ lines", () => {
    const { out, status } = run(["clean"]);
    expect(status).toBe(0);
    expect(out).toMatch(/^▶ clean\.mjs .* cap 20s/m);
    expect(out).toMatch(/^■ clean\.mjs: pass \(exit 0\)/m);
    expect(out).not.toMatch(/PASS step/);
    expect(out).not.toMatch(/browser lease/);
    expect(out.trim().split("\n")).toHaveLength(2);
    expect(leasesLeft()).toEqual([]);
  });

  it("prints everything with --verbose", () => {
    const { out, status } = run(["--verbose", "clean"]);
    expect(status).toBe(0);
    expect(out).toMatch(/PASS step 3/);
    expect(out).toMatch(/Released browser lease/);
  });

  it("shows FAIL lines with their block, and doesn't retry a plain failure", () => {
    const { out, status } = run(["failing"]);
    expect(status).toBe(1);
    expect(out).toMatch(/^FAIL two {2}\(wanted 2, got 3\)\n {2}detail line$/m);
    expect(out).not.toMatch(/PASS/);
    expect(out).toMatch(/not retried/);
    expect(out).toMatch(/^■ failing\.mjs: FAIL/m);
  });

  it("shows an uncaught error with its stack", () => {
    const { out, status } = run(["--no-retry", "crashing"]);
    expect(status).toBe(1);
    expect(out).toMatch(/^Error: boom\n {4}at /m);
    expect(out).not.toMatch(/PASS/);
  });

  it("shows the log's last lines for a failure that printed no FAIL line", () => {
    const { out, status } = run(["--no-retry", "quiet"]);
    expect(status).toBe(2);
    expect(out).toMatch(/the log's last lines\)\n {2}PASS one\n {2}something odd$/m);
  });

  it("kills a silent check at the silence limit, and retries it once", () => {
    const { out, status, secs } = run(["silent"], { CARETOOK_BROWSER_SILENCE: "2" });
    expect(status).toBe(124);
    expect(out.match(/^TIMEOUT \(silent: no output for 2s\)$/gm)).toHaveLength(2);
    expect(out).toMatch(/↻ retrying silent\.mjs once/);
    expect(secs).toBeLessThan(30);
    expect(leasesLeft()).toEqual([]);
  });

  it("kills a busy check at its cap, and retries it once", () => {
    const { out, status } = run(["busy"]);
    expect(status).toBe(124);
    expect(out.match(/^TIMEOUT \(killed at its 2s cap\)$/gm)).toHaveLength(2);
    expect(out).not.toMatch(/PASS tick/);
  });

  it("lets --timeout override the manifest's cap", () => {
    const { out } = run(["--no-retry", "--timeout", "1", "busy"]);
    expect(out).toMatch(/^TIMEOUT \(killed at its 1s --timeout\)$/m);
  });

  it("records a pass on the retry as FLAKY", () => {
    const { out, status } = run(["flaky"]);
    expect(status).toBe(0);
    expect(out).toMatch(/^step: timed out waiting for x\n\[step\] at \/app\n {2}\(no errors reported\)$/m);
    expect(out).toMatch(/^■ flaky\.mjs: FLAKY/m);
    expect(readFileSync(env.CARETOOK_BROWSER_FLAKES, "utf8")).toMatch(/\tflaky\.mjs\t/);
  });

  it("releases its lease before it exits when it's TERMed mid-check", async () => {
    const child = spawn("bash", [BROWSER, "--no-retry", "silent"], { cwd: repo, env, stdio: "ignore" });
    const exited = new Promise((r) => child.once("exit", (code) => r(code)));
    const end = Date.now() + 30_000;
    while (leasesLeft().length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    expect(leasesLeft()).toEqual(["1"]);
    child.kill("SIGTERM");
    expect(await exited).toBe(143);
    expect(leasesLeft()).toEqual([]);
  });

  it("stops a never-exiting check after its last line", () => {
    const { out, status } = run(["lingering"]);
    expect(status).toBe(0);
    expect(out).toMatch(/^■ lingering\.mjs: pass/m);
  });
});

describe("a suite", SLOW, () => {
  it("runs the manifest's e2e checks in order, then a table", () => {
    const { out, status } = run(["--suite"]);
    expect(status).toBe(1);
    expect(out).toMatch(/Running 2 checks \(suite cap 0m40s\): clean failing/);
    expect(out).toMatch(/^clean\.mjs +pass /m);
    expect(out).toMatch(/^failing\.mjs +FAIL /m);
    expect(out).toMatch(/1\/2 passed/);
  });

  it("stops at the suite cap and lists the rest as not run", () => {
    const { out, status } = run(["--suite"], {
      CARETOOK_BROWSER_SUITE: "clean slow clean",
      CARETOOK_BROWSER_SUITE_CAP: "4",
    });
    expect(status).toBe(1);
    expect(out).toMatch(/^TIMEOUT \(killed at its [1-4]s suite cap\)$/m);
    expect(out).toMatch(/not retried: the suite cap is reached/);
    expect(out).toMatch(/^slow\.mjs +TIMEOUT /m);
    expect(out).toMatch(/^clean\.mjs +NOT-RUN /m);
    expect(out).toMatch(/1\/3 passed, 1 not run \(suite cap 0m04s reached\)/);
    expect(leasesLeft()).toEqual([]);
  });
});

// --changed --list against the real manifest and check-areas, in a throwaway
// repo with a stub file per check (the selection only, nothing runs).
describe("--changed with the real map", SLOW, () => {
  let real;
  const realFile = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
  const lean = () =>
    realFile("./checks")
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"))
      .map((l) => l.split(/\s+/))
      .filter((f) => f[4] === "yes")
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
    for (const name of ["checks", "check-areas"])
      writeFileSync(join(real, "scripts/loops", name), realFile(`./${name}`));
    for (const line of realFile("./checks").split("\n"))
      if (line.trim() && !line.startsWith("#"))
        writeFileSync(join(checks, `${line.split(/\s+/)[0]}.mjs`), "\n");
    writeFileSync(join(real, ".nvmrc"), `${process.versions.node.split(".")[0]}\n`);
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

  it("selects no end-to-end check for a timeline-only change (component tests cover it)", () => {
    const { out, status } = changed([
      "apps/web/app/routes/app/groups/timeline/TimelineEntryRow.tsx",
      "apps/web/app/routes/app/groups/timeline/TimelineEntryCard.tsx",
      "apps/web/app/routes/app/groups/timeline/LatestVitals.tsx",
      "apps/web/app/routes/app/groups/timeline/timelineLayout.browser.test.tsx",
    ]);
    expect(status).toBe(0);
    expect(out).toMatch(/TimelineEntryRow\.tsx +-$/m);
    expect(out).toMatch(/No browser checks needed for these changes\./);
  });

  it("runs the lean set for a migration, plus an unmoved area's own check, in manifest order", () => {
    const { out, status } = changed([
      "packages/data/src/db/migrations/0099_example.sql",
      "apps/web/app/routes/app/groups/providers/ProviderForm.tsx",
    ]);
    expect(status).toBe(0);
    const set = lean();
    expect(set).toContain("sign-in");
    expect(set).not.toContain("providers");
    const all = realFile("./checks")
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"))
      .map((l) => l.split(/\s+/)[0]);
    const want = all.filter((c) => set.includes(c) || c === "providers");
    expect(out).toMatch(new RegExp(`^Checks needed: ${want.join(" ")}$`, "m"));
  });
});
