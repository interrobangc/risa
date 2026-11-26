// time-gate.mjs: each verdict, the quiet rule, unarmed fails, a breach's lines,
// the gates' data and the CLI. Fictional file names and times only.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { DEFAULT_LIMITS, gatesFrom, gatesProblems, measureForMode } from "../ci/tier-data.mjs";
import { parseTimed, runCli, timeGate } from "./time-gate.mjs";

const HERE = new URL(".", import.meta.url).pathname;

const armed = { aim: 300, cutoff: 360, armed: true };
const unarmed = { ...armed, armed: false };
const quiet = { start: 4, end: 6, cores: 10 };
const files = (n) =>
  Array.from({ length: n }, (_, i) => ({ name: `lib/fictional-${i}.test.ts`, seconds: i + 1 }));

describe("timeGate", () => {
  it("is ok at the aim and under it, in one line naming the measure and the seconds", () => {
    for (const seconds of [120, 300]) {
      const r = timeGate({ measure: "unit", seconds, limits: armed, slowest: files(3) });
      expect(r.verdict).toBe("ok");
      expect(r.lines).toHaveLength(1);
    }
    expect(timeGate({ measure: "unit", seconds: 300, limits: armed }).lines[0]).toBe(
      "Time gate unit: 5m00s (300 s); aim 5m00s, cutoff 6m00s: ok.",
    );
  });

  it("warns past the aim and up to the cutoff, armed or not", () => {
    for (const limits of [armed, unarmed])
      for (const seconds of [301, 360]) {
        const r = timeGate({ measure: "components", seconds, limits });
        expect(r.verdict).toBe("warn");
        expect(r.lines[0]).toMatch(/^Time gate components: .*WARN, \d+ s past the aim\.$/);
      }
  });

  it("fails past the cutoff when armed", () => {
    const r = timeGate({ measure: "unit", seconds: 390, limits: armed });
    expect(r.verdict).toBe("fail");
    expect(r.lines[0]).toBe(
      "Time gate unit: 6m30s (390 s); aim 5m00s, cutoff 6m00s: FAIL, 30 s past the cutoff.",
    );
  });

  it("warns past the cutoff when not armed, and says so", () => {
    const r = timeGate({ measure: "unit", seconds: 390, limits: unarmed });
    expect(r).toMatchObject({ verdict: "warn", armed: false });
    expect(r.lines[0]).toContain("WARN, 30 s past the cutoff, not armed.");
  });

  it("names at most the ten slowest files, slowest first", () => {
    const r = timeGate({ measure: "unit", seconds: 400, limits: armed, slowest: files(14) });
    const listed = r.lines.filter((l) => l.includes("lib/fictional-"));
    expect(listed).toHaveLength(10);
    expect(listed[0]).toMatch(/14 s {2}lib\/fictional-13\.test\.ts$/);
    expect(listed[9]).toMatch(/5 s {2}lib\/fictional-4\.test\.ts$/);
    expect(r.lines).toContain("  slowest files:");
  });

  it("names the steps it was given, slowest first, with the files", () => {
    const r = timeGate({
      measure: "quick",
      seconds: 420,
      limits: armed,
      loads: quiet,
      steps: [
        { name: "static", seconds: 90 },
        { name: "tooling", seconds: 250 },
        { name: "unit", seconds: 80 },
      ],
      slowest: files(2),
    });
    expect(r.verdict).toBe("fail");
    expect(r.lines[1]).toBe("  steps: tooling 250 s, static 90 s, unit 80 s");
    expect(r.lines.slice(2)).toEqual([
      "  slowest files:",
      "       2 s  lib/fictional-1.test.ts",
      "       1 s  lib/fictional-0.test.ts",
    ]);
  });

  it("judges the local measure only when the start and the end are quiet", () => {
    const at = (start, end) =>
      timeGate({ measure: "quick", seconds: 400, limits: armed, loads: { start, end, cores: 10 } });
    expect(at(10, 10).verdict).toBe("fail"); // at most the core count is quiet
    for (const [start, end] of [
      [10.1, 4],
      [4, 25],
      [null, 4],
      [4, undefined],
    ]) {
      const r = at(start, end);
      expect(r).toMatchObject({ verdict: "unjudged", quiet: false });
      expect(r.lines).toHaveLength(1);
      expect(r.lines[0]).toMatch(
        /^Time gate quick: 6m40s \(400 s\).*: not judged \(load .* quiet is at most 10 on 10 cores\)\.$/,
      );
    }
    expect(at(25, 4).lines[0]).toContain("load 25 at the start, 4 at the end");
    expect(at(null, 4).lines[0]).toContain("load unread at the start");
  });

  it("is unjudged with no loads at all, and scales the quiet load per core", () => {
    expect(timeGate({ measure: "quick", seconds: 100, limits: armed }).verdict).toBe("unjudged");
    const loads = { start: 15, end: 15, cores: 10, perCore: 1.5 };
    expect(timeGate({ measure: "quick", seconds: 100, limits: armed, loads }).verdict).toBe("ok");
  });

  it("never judges a CI measure on load", () => {
    const loads = { start: 99, end: 99, cores: 2 };
    const r = timeGate({ measure: "unit", seconds: 100, limits: armed, loads });
    expect(r).toMatchObject({ verdict: "ok", quiet: null });
  });
});

describe("the gates' data", () => {
  it("loads with its defaults: all three measures unarmed, quiet at the core count", () => {
    const g = gatesFrom(undefined);
    expect(g.quietLoadPerCore).toBe(1);
    expect(Object.keys(g.measures)).toEqual(["unit", "components", "quick"]);
    for (const m of Object.values(g.measures)) expect(m).toEqual({ aim: 300, cutoff: 360, armed: false });
    expect(DEFAULT_LIMITS.armed).toBe(false);
    expect(measureForMode(g, "quick")).toBe("quick");
    expect(measureForMode(g, "slice")).toBe("quick");
    expect(measureForMode(g, "full")).toBeNull();
  });

  it("fills a partial entry's other fields with the defaults", () => {
    const g = gatesFrom({ measures: { unit: { armed: true }, quick: { modes: ["quick"] } } });
    expect(g.measures.unit).toEqual({ aim: 300, cutoff: 360, armed: true });
    expect(g.measures.components).toEqual({ aim: 300, cutoff: 360, armed: false });
    expect(measureForMode(g, "slice")).toBeNull();
  });

  it.each([
    [
      "an aim above its cutoff",
      { measures: { unit: { aim: 400, cutoff: 360 } } },
      "gates.measures.unit.aim: 400 s is above its cutoff (360 s)",
    ],
    [
      "an aim above the default cutoff",
      { measures: { components: { aim: 400 } } },
      "gates.measures.components.aim: 400 s is above",
    ],
    [
      "an unknown measure",
      { measures: { e2e: { aim: 1 } } },
      "gates.measures.e2e: unknown measure (unit, components, quick)",
    ],
    [
      "a measure's unknown key",
      { measures: { unit: { limit: 1 } } },
      "gates.measures.unit.limit: unknown key",
    ],
    [
      "seconds that aren't",
      { measures: { unit: { cutoff: "6m" } } },
      "gates.measures.unit.cutoff: must be seconds",
    ],
    [
      "an armed switch that isn't one",
      { measures: { quick: { armed: "yes" } } },
      "gates.measures.quick.armed: must be true or false",
    ],
    [
      "modes on a CI measure",
      { measures: { unit: { modes: ["quick"] } } },
      "gates.measures.unit.modes: only the local measure",
    ],
    ["empty modes", { measures: { quick: { modes: [] } } }, "gates.measures.quick.modes: must be a list"],
    ["a zero quiet load", { quietLoadPerCore: 0 }, "gates.quietLoadPerCore: must be a number above 0"],
    ["an unknown key", { arm: true }, "gates.arm: unknown key"],
    ["measures that aren't a group", { measures: [] }, "gates.measures: must be a group of keys"],
  ])("refuses %s, naming the field", (_what, gates, problem) => {
    const problems = gatesProblems(gates);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(problem);
    expect(() => gatesFrom(gates)).toThrow(problem);
  });

  it("refuses gates that aren't a group of keys", () => {
    expect(gatesProblems([])).toEqual(["gates: must be a group of keys (quietLoadPerCore, measures)"]);
    expect(gatesProblems(null)).toHaveLength(1);
  });
});

describe("parseTimed", () => {
  it("reads `<seconds> <name>` lines, names with spaces kept", () => {
    expect(parseTimed("# slowest\n12.5 lib/a.test.ts\n\n3 the tooling step\n")).toEqual([
      { seconds: 12.5, name: "lib/a.test.ts" },
      { seconds: 3, name: "the tooling step" },
    ]);
  });

  it("refuses a line with no seconds", () => {
    expect(() => parseTimed("lib/a.test.ts")).toThrow('not "<seconds> <name>": lib/a.test.ts');
    expect(() => parseTimed("-1 lib/a.test.ts")).toThrow(/not "<seconds> <name>"/);
  });
});

describe("the CLI", () => {
  const io = (/** @type {Record<string, string>} */ reads = {}, gates = gatesFrom(undefined)) => ({
    gates: () => gates,
    read: (/** @type {string} */ f) => {
      if (!(f in reads)) throw new Error("no such file");
      return /** @type {string} */ (reads[f]);
    },
    cores: () => 8,
  });

  it("prints the verdict, then the lines", () => {
    const r = runCli(
      ["--measure", "unit", "--seconds", "390", "--slowest", "s.txt"],
      io({ "s.txt": "200 lib/land.test.ts\n" }),
    );
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([
      "warn",
      "Time gate unit: 6m30s (390 s); aim 5m00s, cutoff 6m00s: WARN, 30 s past the cutoff, not armed.",
      "  slowest files:",
      "     200 s  lib/land.test.ts",
      "",
    ]);
  });

  it("judges the local measure on the loads and the cores given, else this machine's cores", () => {
    const quick = ["--measure", "quick", "--seconds", "200", "--load-start", "7", "--load-end", "8"];
    expect(runCli(quick, io()).out.split("\n")[0]).toBe("ok");
    expect(runCli([...quick, "--cores", "4"], io()).out.split("\n")[0]).toBe("unjudged");
    expect(runCli(["--measure", "quick", "--seconds", "200"], io()).out).toMatch(/^unjudged\n/);
  });

  it("finds the measure for a check mode, and judges none for a mode no measure covers", () => {
    const quiet = ["--seconds", "400", "--load-start", "1", "--load-end", "1"];
    for (const mode of ["quick", "slice"])
      expect(runCli(["--mode", mode, ...quiet], io()).out).toMatch(/^warn\nTime gate quick: /);
    expect(runCli(["--mode", "full", ...quiet], io())).toEqual({ code: 0, out: "", err: "" });
    const r = runCli(["--mode", "quick", "--measure", "quick", ...quiet], io());
    expect(r).toMatchObject({ code: 2 });
    expect(r.err).toContain("--measure or --mode, not both");
  });

  it("gives one JSON object with --json, an armed fail included", () => {
    const gates = gatesFrom({ measures: { components: { armed: true } } });
    const r = runCli(["--measure", "components", "--seconds", "400", "--json"], io({}, gates));
    expect(JSON.parse(r.out)).toMatchObject({
      measure: "components",
      seconds: 400,
      verdict: "fail",
      armed: true,
    });
  });

  it.each([
    [["--seconds", "1"], "--measure must be one of unit, components, quick"],
    [["--measure", "e2e", "--seconds", "1"], "--measure must be one of"],
    [["--measure", "unit"], "--seconds must be a number"],
    [["--measure", "unit", "--seconds", "soon"], "--seconds must be a number"],
    [["--measure", "unit", "--seconds", "1", "--fast"], "unknown or incomplete argument --fast"],
    [["--measure", "unit", "--seconds", "1", "--slowest", "none.txt"], "--slowest none.txt: no such file"],
    [
      ["--measure", "unit", "--seconds", "1", "--steps", "bad.txt"],
      '--steps bad.txt: not "<seconds> <name>"',
    ],
  ])("exits 2 for %j", (argv, why) => {
    const r = runCli(argv, io({ "bad.txt": "static" }));
    expect(r).toMatchObject({ code: 2, out: "" });
    expect(r.err).toContain(`time-gate: ${why}`);
  });

  it("exits 2 with one line for broken gates' data", () => {
    const broken = { ...io(), gates: () => gatesFrom({ measures: { unit: { aim: 999 } } }) };
    const r = runCli(["--measure", "unit", "--seconds", "1"], broken);
    expect(r).toMatchObject({ code: 2 });
    expect(r.err).toBe("time-gate: gates.measures.unit.aim: 999 s is above its cutoff (360 s)\n");
  });

  it("runs as a command on this repo's gates' data", () => {
    const r = spawnSync("node", [HERE + "time-gate.mjs", "--measure", "unit", "--seconds", "100"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^ok\nTime gate unit: 1m40s \(100 s\); aim 5m00s, cutoff 6m00s: ok\.\n$/);
  });
});
