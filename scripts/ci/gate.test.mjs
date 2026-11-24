import { describe, expect, it } from "vitest";
import { decideGate, needsBlame, verdictMeets, walkVerdicts } from "./gate.mjs";

const failing = { job: "unit", file: "a.test.ts", name: "fails" };
const placed = { ...failing, key: "k", brake: false };
const split = (over = {}) => ({ dev: [], branch: [], unknown: [], ...over });
const decide = (verdict, over = {}) =>
  decideGate({ verdict: { ranTier: "unit", ...verdict }, tier: "unit", branch: "b", touched: [], ...over });

describe("verdictMeets", () => {
  it("never takes a proof run's verdict", () => {
    expect(verdictMeets({ ranTier: "candidate", forcedFlake: "sign-in" }, "unit")).toBe(false);
  });

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

describe("walkVerdicts", () => {
  // History newest first: each commit's own change and its verdicts (ranTier → kind).
  const walk = (
    /** @type {{ sha: string, change: string | null, verdicts?: Record<string, string> }[]} */ history,
    tier = "components",
    touched = /** @type {string[]} */ ([]),
  ) => {
    const asked = /** @type {string[]} */ ([]);
    const result = walkVerdicts({
      commits: history.map((c) => c.sha),
      tier,
      touched,
      verdictAt: (sha, t) => {
        asked.push(`${sha}@${t}`);
        const c = history.find((h) => h.sha === sha);
        const hit = Object.entries(c?.verdicts ?? {}).find(([ran]) => verdictMeets({ ranTier: ran }, t));
        if (!hit) return { verdict: null, run: null };
        const [ranTier, kind] = hit;
        const flaky = kind === "flake" ? [{ file: "a.test.ts" }] : [];
        return { verdict: { commit: sha, ranTier, kind, flaky, runId: `${sha}-${ranTier}` }, run: null };
      },
      changeOf: (sha) => history.find((h) => h.sha === sha)?.change ?? null,
    });
    return { result, asked };
  };
  const wave = { sha: "wave", change: null, verdicts: { components: "green" } };

  it("takes the tip's own verdict", () => {
    const { result } = walk([{ sha: "tip", change: null, verdicts: { full: "green" } }]);
    expect(result).toMatchObject({ verdict: { commit: "tip" }, carried: null, need: "components" });
  });

  it("carries a verdict over docs and tooling commits and a tooling-only sync, with no rerun", () => {
    const { result } = walk([{ sha: "docs", change: "none" }, { sha: "sync", change: "none" }, wave]);
    expect(result).toMatchObject({ verdict: { commit: "wave" }, carried: null, need: "components" });
  });

  it("asks a sync that brought server code for an integration recheck, carrying the wave's green", () => {
    const { result } = walk([{ sha: "sync", change: "integration" }, wave]);
    expect(result).toMatchObject({
      verdict: null,
      carried: { verdict: { commit: "wave" } },
      need: "integration",
    });
  });

  it("takes a recheck on the tip or behind docs, never one older than the sync", () => {
    const tip = walk([
      { sha: "docs", change: "none", verdicts: { integration: "green" } },
      { sha: "sync", change: "integration" },
      wave,
    ]).result;
    expect(tip).toMatchObject({ verdict: { commit: "docs" }, carried: { verdict: { commit: "wave" } } });
    const behind = walk([
      { sha: "sync2", change: "unit" },
      { sha: "mid", change: "none", verdicts: { integration: "green" } },
      { sha: "sync", change: "integration" },
      wave,
    ]).result;
    expect(behind).toMatchObject({ verdict: null, need: "integration" });
  });

  it("needs the highest tier any sync since brought", () => {
    const { result } = walk([{ sha: "s2", change: "unit" }, { sha: "s1", change: "integration" }, wave]);
    expect(result?.need).toBe("integration");
  });

  it("asks for the sync's tier, with nothing carried, when it brought the wave's tier or more", () => {
    const { result } = walk([{ sha: "sync", change: "full" }, wave]);
    expect(result).toMatchObject({ verdict: null, carried: null, need: "full" });
  });

  it("carries a flake outside the branch's files, not one in them, nor a failure", () => {
    const flake = { ...wave, verdicts: { components: "flake" } };
    expect(walk([{ sha: "sync", change: "unit" }, flake]).result?.carried).not.toBeNull();
    const own = walk([{ sha: "sync", change: "unit" }, flake], "components", ["a.test.ts"]);
    expect(own.result).toMatchObject({ verdict: null, carried: null, need: "components" });
    const failed = walk([
      { sha: "sync", change: "unit" },
      { ...wave, verdicts: { components: "file" } },
    ]);
    expect(failed.result).toMatchObject({ verdict: null, carried: null, need: "components" });
  });

  it("stops at a commit no carry crosses", () => {
    const { result } = walk([{ sha: "sync", change: "unit" }, { sha: "code", change: null }, wave]);
    expect(result).toMatchObject({ verdict: null, carried: null, need: "components" });
  });

  it("reads GitHub's silence as null", () => {
    const result = walkVerdicts({
      commits: ["tip"],
      tier: "unit",
      touched: [],
      verdictAt: () => null,
      changeOf: () => "none",
    });
    expect(result).toBeNull();
  });
});
