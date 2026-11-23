import { describe, expect, it } from "vitest";
import { decideGate, needsBlame, verdictMeets } from "./gate.mjs";

const failing = { job: "unit", file: "a.test.ts", name: "fails" };
const placed = { ...failing, key: "k", brake: false };
const split = (over = {}) => ({ dev: [], branch: [], unknown: [], ...over });
const decide = (verdict, over = {}) =>
  decideGate({ verdict: { ranTier: "unit", ...verdict }, tier: "unit", branch: "b", touched: [], ...over });

describe("verdictMeets", () => {
  it.each([
    [{ ranTier: "components" }, "components", true],
    [{ ranTier: "full" }, "components", true],
    [{ ranTier: "integration" }, "components", false],
    [{ ranTier: "integration", tier: "full" }, "full", false],
    [{ tier: "full" }, "unit", false],
    [{ ranTier: "full", narrowed: true }, "unit", false],
    [{ ranTier: "nonsense" }, "unit", false],
    [null, "unit", false],
  ])("%j for %s: %s", (verdict, tier, met) => {
    expect(verdictMeets(verdict, tier)).toBe(met);
  });
});

describe("decideGate", () => {
  it("green lands", () => {
    expect(decide({ kind: "green" })).toMatchObject({ land: true, code: 0, fileFlakes: false });
  });

  it("a flake outside the branch's files lands and is filed", () => {
    const flaky = [{ file: "other.test.ts", name: "x" }];
    expect(decide({ kind: "flake", flaky })).toMatchObject({ land: true, fileFlakes: true });
  });

  it("a flake in a touched file refuses, naming it, before any blame", () => {
    const verdict = { kind: "file", flaky: [{ file: "a.test.ts", name: "x" }] };
    expect(needsBlame(verdict, ["a.test.ts"])).toBe(false);
    const out = decide(verdict, { touched: ["a.test.ts"] });
    expect(out).toMatchObject({ land: false, code: 2 });
    expect(out.lines.join("\n")).toContain("a.test.ts: x");
  });

  it.each([
    ["infra", 4],
    ["something-new", 5],
  ])("%s refuses with how to retry", (kind, code) => {
    const out = decide({ kind });
    expect(out).toMatchObject({ land: false, code });
    expect(out.lines.join("\n")).toContain("pnpm prd ci run unit --ref b --wait");
  });

  it("file lands when every failure is dev's, and files its flakes", () => {
    const blamed = { code: 0, split: split({ dev: [placed] }), ids: new Map([["k", "B-7"]]) };
    const flaky = [{ file: "other.test.ts", name: "x" }];
    expect(decide({ kind: "file", flaky }, { blamed })).toMatchObject({ land: true, fileFlakes: true });
  });

  it("file refuses naming the branch's failures", () => {
    const blamed = { code: 2, split: split({ branch: [placed] }), ids: new Map() };
    const out = decide({ kind: "file" }, { blamed });
    expect(out).toMatchObject({ land: false, code: 2 });
    expect(out.lines.join("\n")).toContain("a.test.ts: fails");
  });

  it("blame's unknown is a refusal, never dev's", () => {
    const blamed = {
      code: 5,
      split: split({ dev: [placed], unknown: [placed] }),
      ids: new Map([["k", "B-7"]]),
    };
    expect(decide({ kind: "file" }, { blamed })).toMatchObject({ land: false, code: 5 });
  });

  it("no blame result refuses", () => {
    expect(decide({ kind: "file" })).toMatchObject({ land: false, code: 5 });
  });

  it("an exit 0 with nothing placed on dev refuses", () => {
    const blamed = { code: 0, split: split(), ids: new Map() };
    expect(decide({ kind: "brake" }, { blamed })).toMatchObject({ land: false, code: 5 });
  });

  it("a dev failure with no filed item refuses", () => {
    const blamed = { code: 0, split: split({ dev: [placed] }), ids: new Map() };
    expect(decide({ kind: "file" }, { blamed })).toMatchObject({ land: false, code: 5 });
  });

  describe("a brake", () => {
    const brake = { job: [], tests: [failing], files: [] };
    const blamed = { code: 0, split: split({ dev: [placed] }), ids: new Map([["k", "B-7"]]) };

    it("refuses naming dev's item, reading brake-ness from the branch's verdict", () => {
      const out = decide({ kind: "brake", brake }, { blamed });
      expect(out).toMatchObject({ land: false, code: 1 });
      expect(out.lines.join("\n")).toContain("(B-7)");
    });

    it("lands with --fixes naming that item", () => {
      expect(decide({ kind: "brake", brake }, { blamed, fixes: ["B-7"] }).land).toBe(true);
    });

    it("another item doesn't clear it", () => {
      expect(decide({ kind: "brake", brake }, { blamed, fixes: ["B-8"] }).land).toBe(false);
    });

    it("a brake job with no file", () => {
      const job = { job: "static", key: "j", brake: false };
      const out = decide(
        { kind: "brake", brake: { jobs: ["static"], tests: [], files: [] } },
        { blamed: { code: 0, split: split({ dev: [job] }), ids: new Map([["j", "B-9"]]) } },
      );
      expect(out).toMatchObject({ land: false, code: 1 });
      expect(out.lines.join("\n")).toContain("the static job (B-9)");
    });
  });
});
