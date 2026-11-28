// ship.mjs: the pure next-phase decision and report text, and `prd ship` through
// prd.sh on a throwaway repo whose config's ship hooks are a stub script (it
// prints facts and records its calls). RISA_SHIPS_DIR, RISA_ASKS_DIR and HOME are
// temp folders and there's no machine config: nothing tags, pushes or touches the
// real .loops or ~/.risa.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_CONFIG } from "./config-fixture.mjs";
import { loadConfig } from "./config.mjs";
import { nextPhases, PHASES, reportText, takeLock } from "./ship.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const AT = "2026-11-28T10:00:00.000Z";
const phase = (name, extra = {}) => ({ name, ok: true, at: AT, facts: [], tail: [], ...extra });

describe("nextPhases", () => {
  const failedAtSmoke = {
    version: "1.2.3",
    startedAt: AT,
    phases: [phase("check"), phase("ship"), phase("smoke", { ok: false, tail: ["boom"] })],
    doneAt: null,
  };
  const finished = {
    version: "1.2.3",
    startedAt: AT,
    phases: ["check", "ship", "smoke", "notify"].map((n) => phase(n)),
    doneAt: AT,
  };

  it("runs every phase, in order, with no record", () => {
    expect(PHASES.map((p) => [p.name, p.hook])).toEqual([
      ["check", "shipCheck"],
      ["ship", "ship"],
      ["smoke", "shipSmoke"],
      ["notify", "shipNotify"],
    ]);
    expect(nextPhases(null)).toEqual({ kept: [], run: ["check", "ship", "smoke", "notify"] });
  });

  it("resumes a failed record at the phase that failed", () => {
    expect(nextPhases(failedAtSmoke)).toEqual({
      kept: failedAtSmoke.phases.slice(0, 2),
      run: ["smoke", "notify"],
    });
  });

  it("--from drops that phase's result and every later one", () => {
    expect(nextPhases(failedAtSmoke, { from: "ship" })).toEqual({
      kept: failedAtSmoke.phases.slice(0, 1),
      run: ["ship", "smoke", "notify"],
    });
  });

  it("refuses a finished record, and --from notify runs notify again", () => {
    expect(nextPhases(finished)).toEqual({ refused: expect.stringMatching(/1\.2\.3 is shipped/) });
    expect(nextPhases(finished, { from: "notify" })).toEqual({
      kept: finished.phases.slice(0, 3),
      run: ["notify"],
    });
  });

  it("refuses an unknown phase, and a --from past a phase that hasn't passed", () => {
    expect(nextPhases(null, { from: "deploy" })).toEqual({
      refused: expect.stringMatching(/no phase deploy/),
    });
    expect(nextPhases(failedAtSmoke, { from: "notify" })).toEqual({
      refused: "--from notify: smoke hasn't passed yet",
    });
  });
});

describe("reportText", () => {
  const project = { name: "fixture", cmd: "risa" };
  it("names each phase, the hooks' facts and a skipped phase for a finished ship", () => {
    const text = reportText(
      {
        version: "1.2.3",
        startedAt: AT,
        phases: [
          phase("check", { facts: ["tip=abc"] }),
          phase("ship", { facts: ["tag=v1.2.3", "commit=def"] }),
          phase("smoke", { skipped: true }),
          phase("notify", { facts: ["notified=a (0.1.0)", "notified=b (0.2.0)"] }),
        ],
        doneAt: AT,
      },
      project,
    );
    expect(text).toBe(
      [
        "fixture 1.2.3 shipped.",
        "- check: ok: tip=abc",
        "- ship: ok: tag=v1.2.3, commit=def",
        "- smoke: skipped (no hooks.shipSmoke)",
        "- notify: ok: notified=a (0.1.0), notified=b (0.2.0)",
        "Skipped: smoke.",
      ].join("\n"),
    );
  });

  it("names the failed phase, its tail and the resume command for a failed ship", () => {
    const text = reportText(
      {
        version: "1.2.3",
        startedAt: AT,
        phases: [
          phase("check", { facts: ["tip=abc"] }),
          phase("ship", { ok: false, tail: ["push refused", "exit 1"] }),
        ],
        doneAt: null,
      },
      project,
    );
    expect(text).toBe(
      [
        "fixture 1.2.3: the ship stopped at ship.",
        "- check: ok: tip=abc",
        "- ship: failed",
        "ship's last lines:",
        "  push refused",
        "  exit 1",
        "Resume: risa ship 1.2.3",
      ].join("\n"),
    );
  });
});

describe("prd ship", () => {
  let root, repo, stub;
  let ships, asks, log;

  /** Writes the repo's config with these ship hooks (stub phases), unset ones left out. */
  const configure = (/** @type {string[]} */ hooks = ["shipCheck", "ship", "shipSmoke", "shipNotify"]) => {
    const raw = JSON.parse(readFileSync(FIXTURE_CONFIG, "utf8"));
    raw.hooks = Object.fromEntries(hooks.map((h) => [h, `bash ${stub} ${h}`]));
    writeFileSync(join(repo, "risa.json"), JSON.stringify(raw, null, 2));
  };
  const env = (/** @type {Record<string, string>} */ extra = {}) => ({
    ...process.env,
    RISA_CONFIG: join(repo, "risa.json"),
    RISA_CONFIG_FOUND: "",
    RISA_MACHINE_CONFIG: join(root, "no-machine.json"),
    RISA_SHIPS_DIR: ships,
    RISA_ASKS_DIR: asks,
    HOME: join(root, "home"),
    STUB_LOG: log,
    STUB_FAIL: "",
    STUB_PEEK: "",
    STUB_PEEK_OUT: join(root, "peek.json"),
    ...extra,
  });
  const ship = (/** @type {string[]} */ args, /** @type {Record<string, string>} */ extra = {}) =>
    spawnSync("bash", [join(HERE, "prd.sh"), "ship", ...args], {
      cwd: repo,
      encoding: "utf8",
      env: env(extra),
    });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  const reports = () =>
    existsSync(asks)
      ? readdirSync(asks)
          .filter((f) => /^a\d+\.json$/.test(f))
          .map((f) => JSON.parse(readFileSync(join(asks, f), "utf8")))
      : [];
  const record = (v) => JSON.parse(readFileSync(join(ships, `${v}.json`), "utf8"));

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ship-test-")));
    repo = join(root, "repo");
    mkdirSync(repo);
    mkdirSync(join(root, "home"));
    execFileSync("git", ["init", "-q", repo]);
    stub = join(root, "stub.sh");
    // The stub: records "<hook> <arg> <RISA_SHIP_VERSION>", prints a fact, fails as asked.
    writeFileSync(
      stub,
      [
        "hook=$1; shift",
        'echo "$hook $1 $RISA_SHIP_VERSION" >> "$STUB_LOG"',
        'echo "ran $hook"',
        'echo "fact_$hook=$1"',
        'if [[ $STUB_PEEK == "$hook" ]]; then cp "$RISA_SHIPS_DIR/$1.json" "$STUB_PEEK_OUT"; fi',
        'if [[ $STUB_FAIL == "$hook" ]]; then echo "$hook broke" >&2; exit 4; fi',
        "",
      ].join("\n"),
    );
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => {
    ships = mkdtempSync(join(root, "ships-"));
    asks = mkdtempSync(join(root, "asks-"));
    log = join(mkdtempSync(join(root, "log-")), "calls");
    configure();
  });

  it("a config with the four ship hooks loads", () => {
    const { config } = loadConfig({ path: join(repo, "risa.json") });
    expect(Object.keys(config.hooks)).toEqual(["shipCheck", "ship", "shipSmoke", "shipNotify"]);
  });

  it("runs the four hooks in order with the version, exits 0 and files one report", () => {
    const r = ship(["1.2.3"]);
    expect(r.status, r.stderr).toBe(0);
    expect(calls()).toEqual([
      "shipCheck 1.2.3 1.2.3",
      "ship 1.2.3 1.2.3",
      "shipSmoke 1.2.3 1.2.3",
      "shipNotify 1.2.3 1.2.3",
    ]);
    expect(r.stdout).toMatch(
      /ship 1\.2\.3: check \(hooks\.shipCheck\)\nran shipCheck\nfact_shipCheck=1\.2\.3\n/,
    );
    const filed = reports();
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ kind: "report", topic: "ship" });
    expect(filed[0].text).toContain("fixture 1.2.3 shipped.");
    expect(filed[0].text).toContain("- ship: ok: fact_ship=1.2.3");
    expect(record("1.2.3").doneAt).toBeTruthy();
    expect(existsSync(join(ships, ".lock"))).toBe(false);
  });

  it("prints skipped for a missing shipSmoke and names it in the report", () => {
    configure(["shipCheck", "ship", "shipNotify"]);
    const r = ship(["1.2.3"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^smoke: skipped$/m);
    expect(calls()).toEqual(["shipCheck 1.2.3 1.2.3", "ship 1.2.3 1.2.3", "shipNotify 1.2.3 1.2.3"]);
    expect(reports()[0].text).toContain("- smoke: skipped (no hooks.shipSmoke)");
  });

  it("exits 2 before any hook with no hooks.ship, or a bad version", () => {
    configure(["shipCheck", "shipSmoke", "shipNotify"]);
    const none = ship(["1.2.3"]);
    expect(none.status).toBe(2);
    expect(none.stderr).toContain("no hooks.ship");
    configure();
    const bad = ship(["v1.2"]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("isn't a version");
    expect(ship([]).status).toBe(2);
    expect(calls()).toEqual([]);
    expect(reports()).toEqual([]);
  });

  it("a failing shipSmoke exits 1 with a failure report, and a re-run calls only smoke and notify", () => {
    const r = ship(["1.2.3"], { STUB_FAIL: "shipSmoke" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("shipSmoke broke");
    const [report] = reports();
    expect(report.text).toContain("the ship stopped at smoke");
    expect(report.text).toContain("  shipSmoke broke");
    expect(report.text).toContain("Resume: pnpm prd ship 1.2.3");
    expect(record("1.2.3").doneAt).toBeNull();
    writeFileSync(log, "");
    const again = ship(["1.2.3"]);
    expect(again.status, again.stderr).toBe(0);
    expect(calls()).toEqual(["shipSmoke 1.2.3 1.2.3", "shipNotify 1.2.3 1.2.3"]);
    expect(reports()).toHaveLength(2);
  });

  it("refuses a finished version with 2, and --from notify notifies again", () => {
    expect(ship(["1.2.3"]).status).toBe(0);
    writeFileSync(log, "");
    const r = ship(["1.2.3"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("1.2.3 is shipped");
    expect(calls()).toEqual([]);
    const n = ship(["1.2.3", "--from", "notify"]);
    expect(n.status, n.stderr).toBe(0);
    expect(calls()).toEqual(["shipNotify 1.2.3 1.2.3"]);
  });

  it("--dry-run runs only shipCheck, writing no record and filing no report", () => {
    const r = ship(["1.2.3", "--dry-run"]);
    expect(r.status, r.stderr).toBe(0);
    expect(calls()).toEqual(["shipCheck 1.2.3 1.2.3"]);
    expect(readdirSync(ships)).toEqual([]);
    expect(reports()).toEqual([]);
    expect(ship(["1.2.3", "--dry-run"], { STUB_FAIL: "shipCheck" }).status).toBe(1);
    expect(reports()).toEqual([]);
  });

  it("refuses with 2 while another ship holds the lock, for any version, and takes over a dead one's", async () => {
    const live = spawn("sleep", ["30"]);
    try {
      writeFileSync(join(ships, ".lock"), `${live.pid} 1.2.3\n`);
      for (const v of ["1.2.3", "1.2.4"]) {
        const r = ship([v]);
        expect(r.status).toBe(2);
        expect(r.stderr).toContain(`a ship of 1.2.3 is running (pid ${live.pid})`);
      }
      expect(calls()).toEqual([]);
    } finally {
      live.kill();
    }
    const dead = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(ships, ".lock"), `${dead} 1.2.3\n`);
    const r = ship(["1.2.4"]);
    expect(r.status, r.stderr).toBe(0);
    expect(calls()).toHaveLength(4);
    expect(existsSync(join(ships, ".lock"))).toBe(false);
  });

  it("writes the rewound record before the first hook it reruns", () => {
    const peek = join(root, "peek.json");
    expect(ship(["1.2.3"], { STUB_FAIL: "shipSmoke" }).status).toBe(1);
    // --from ship on a record failed at smoke: the ship hook sees no ship result there.
    expect(ship(["1.2.3", "--from", "ship"], { STUB_PEEK: "ship" }).status).toBe(0);
    const during = JSON.parse(readFileSync(peek, "utf8"));
    expect(during.phases.map((p) => p.name)).toEqual(["check"]);
    expect(during.doneAt).toBeNull();
    // --from notify on the finished record: notify sees no notify result and no doneAt.
    expect(ship(["1.2.3", "--from", "notify"], { STUB_PEEK: "shipNotify" }).status).toBe(0);
    const again = JSON.parse(readFileSync(peek, "utf8"));
    expect(again.phases.map((p) => p.name)).toEqual(["check", "ship", "smoke"]);
    expect(again.doneAt).toBeNull();
    expect(record("1.2.3").doneAt).toBeTruthy();
  });

  it("refuses an empty or unparsable lock instead of taking it over", () => {
    for (const text of ["", "garbage\n"]) {
      writeFileSync(join(ships, ".lock"), text);
      const r = ship(["1.2.3"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("names no pid");
      expect(readFileSync(join(ships, ".lock"), "utf8")).toBe(text);
      expect(takeLock(ships, "1.2.3")).toMatchObject({ ok: false });
    }
    expect(calls()).toEqual([]);
  });

  it("gives the lock to one of many racers, its content whole as soon as it exists", async () => {
    const shipUrl = new URL("./ship.mjs", import.meta.url).href;
    // Each racer takes the lock, or reports why not; a holder keeps it a moment.
    const code = `import { takeLock } from ${JSON.stringify(shipUrl)};
      const r = takeLock(process.argv[1], "1.2." + process.pid);
      console.log(JSON.stringify(r));
      if (r.ok) setTimeout(() => {}, 1500);`;
    const racers = Array.from(
      { length: 12 },
      () =>
        new Promise((resolve) => {
          const c = spawn("node", ["--input-type=module", "-e", code, ships], { env: env() });
          let out = "";
          c.stdout.on("data", (d) => (out += d));
          c.on("exit", () => resolve(JSON.parse(out.trim())));
        }),
    );
    const results = await Promise.all(racers);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((r) => !r.ok)) expect(r.why).toMatch(/is running \(pid \d+\)/);
  }, 30_000);
});
