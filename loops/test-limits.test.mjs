import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadScale } from "./check-budget.mjs";
import { BASE, scaledWait, testLimits, testLoad } from "./test-limits.mjs";

const CONFIG = new URL("../vitest.config.mjs", import.meta.url).href;
const root = mkdtempSync(join(tmpdir(), "risa-test-limits-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("testLimits", () => {
  it("keeps today's 20 s test and 10 s hook limits at a low or unread load", () => {
    expect(BASE).toEqual({ testTimeout: 20_000, hookTimeout: 10_000 });
    for (const load of [null, undefined, 0, 3, 15]) {
      expect(testLimits({ load })).toEqual({ testTimeout: 20_000, hookTimeout: 10_000, scale: 1 });
    }
    expect(testLimits()).toMatchObject({ testTimeout: 20_000, hookTimeout: 10_000 });
  });

  it("rises with the load as the check budget does, at most three times", () => {
    expect(testLimits({ load: 30 })).toEqual({ testTimeout: 40_000, hookTimeout: 20_000, scale: 2 });
    expect(testLimits({ load: 22.5 })).toMatchObject({ testTimeout: 30_000, hookTimeout: 15_000 });
    expect(testLimits({ load: 35 }).testTimeout).toBeGreaterThan(testLimits({ load: 20 }).testTimeout);
    expect(testLimits({ load: 200 })).toEqual({ testTimeout: 60_000, hookTimeout: 30_000, scale: 3 });
    for (const load of [10, 20, 35, 90]) expect(testLimits({ load }).scale).toBe(loadScale(load));
  });
});

describe("testLoad", () => {
  it("reads RISA_TEST_LOAD first, so the limits follow a given load, not the machine's", () => {
    expect(testLoad({ RISA_TEST_LOAD: "30" })).toBe(30);
    expect(testLoad({ RISA_TEST_LOAD: "1.0 33.5 20" })).toBe(33.5);
    expect(testLoad({ RISA_TEST_LOAD: "busy" })).toBeNull();
    expect(testLimits({ load: testLoad({ RISA_TEST_LOAD: "30" }) }).testTimeout).toBe(40_000);
  });

  it("else reads the load gate's reading (RISA_LOAD_FILE stands in for the OS)", () => {
    const file = join(root, "loadavg");
    writeFileSync(file, "{ 40.00 25.00 12.00 }");
    expect(testLoad({ RISA_LOAD_FILE: file })).toBe(25);
    expect(testLoad({ RISA_LOAD_FILE: join(root, "none") })).toBeNull();
  });
});

describe("scaledWait", () => {
  it("keeps a wait as it is at a low or unread load", () => {
    for (const load of [null, 0, 4, 15]) expect(scaledWait(10_000, { load })).toBe(10_000);
  });

  it("rises with the load by the limits' scale, at most three times", () => {
    expect(scaledWait(10_000, { load: 30 })).toBe(20_000);
    expect(scaledWait(5_000, { load: 22.5 })).toBe(7_500);
    expect(scaledWait(15_000, { load: 200 })).toBe(45_000);
    for (const load of [20, 35])
      expect(scaledWait(1_000, { load })).toBe(Math.round(1_000 * testLimits({ load }).scale));
  });

  it("reads the load through RISA_TEST_LOAD when none is given", () => {
    const was = process.env.RISA_TEST_LOAD;
    try {
      process.env.RISA_TEST_LOAD = "30";
      expect(scaledWait(10_000)).toBe(20_000);
      process.env.RISA_TEST_LOAD = "3";
      expect(scaledWait(10_000)).toBe(10_000);
    } finally {
      if (was === undefined) delete process.env.RISA_TEST_LOAD;
      else process.env.RISA_TEST_LOAD = was;
    }
  });

  // RISA-994: their waits failed under load on fixed clocks.
  it.each(["land-unsynced.test.mjs", "rotate.test.mjs"])("scales %s's waits", (file) => {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(src).toContain('import { BASE, scaledWait } from "./test-limits.mjs";');
    expect(src).toContain("vi.setConfig({ testTimeout: scaledWait(BASE.testTimeout)");
    expect(src).not.toMatch(/timeout: \d[\d_]*\b|\}, \d[\d_]*\);/);
  });
});

describe("vitest.config.mjs", () => {
  // In its own node, as vitest loads it: the config computes its limits once, on load.
  const limits = (load) => {
    const r = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { default: c } = await import(${JSON.stringify(CONFIG)});
         console.log(JSON.stringify(c.test.projects.map((p) => [p.test.name, p.test.testTimeout, p.test.hookTimeout])));`,
      ],
      { encoding: "utf8", env: { ...process.env, RISA_TEST_LOAD: load } },
    );
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  };

  it("gives every project today's limits at a low load and raised ones at a high load", () => {
    expect(limits("4")).toEqual([
      ["core:unit", 20_000, 10_000],
      ["tooling:unit", 20_000, 10_000],
      ["tooling:browser", 20_000, 10_000],
    ]);
    expect(limits("30")).toEqual([
      ["core:unit", 40_000, 20_000],
      ["tooling:unit", 40_000, 20_000],
      ["tooling:browser", 40_000, 20_000],
    ]);
  });
});
