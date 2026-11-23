// `pnpm prd ci`, the tiers and the verdict, against a fake git and gh: the ref
// for each tier, reuse and re-push, the wait's exit codes, when the ref goes,
// and what reads as unknown.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  EXIT,
  exitFor,
  main,
  narrowedCommit,
  parseRunArgs,
  requestRun,
  latestVerdict,
  verdictLines,
} from "./ci.mjs";
import { TIERS, ciRefName, jobsFor, narrowedJobs, parseCiRef, planOutputs } from "./tiers.mjs";
import { buildVerdict, mergeSummaries, summarizeVitest } from "./verdict.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const REF = "ci/unit/slice-t-2";
const green = { version: 1, commit: SHA, runId: "7", tier: "unit", kind: "green", failed: { jobs: [] } };
const running = {
  databaseId: 7,
  headSha: SHA,
  headBranch: REF,
  workflowName: "CI",
  status: "in_progress",
  createdAt: "2026-11-22T10:00:00Z",
  url: "https://example.test/7",
};

/** A fake world: the ref's SHA, the runs, each run's state and verdict. */
function world({
  at = "",
  runs = [],
  afterPush = [running],
  view = { status: "completed", conclusion: "success" },
  verdict = green,
  reachable = true,
} = {}) {
  const calls = /** @type {string[]} */ ([]);
  let pushed = false;
  /** @type {string[]} */ const lines = [];
  let clock = 0;
  const io = {
    git(/** @type {string[]} */ args) {
      calls.push(`git ${args.join(" ")}`);
      if (args[0] === "ls-remote")
        return reachable ? { ok: true, out: at ? `${at}\trefs/heads/${REF}` : "" } : { ok: false, out: "" };
      if (args[0] === "push") {
        pushed = !args.at(-1)?.startsWith(":");
        return { ok: true, out: "" };
      }
      if (args[0] === "branch") return { ok: true, out: "slice/t/2" };
      if (args[0] === "rev-parse") return { ok: true, out: SHA };
      return { ok: false, out: "" };
    },
    gh(/** @type {string[]} */ args) {
      calls.push(`gh ${args.join(" ")}`);
      if (!reachable) return { ok: false, out: "" };
      if (args[1] === "list")
        return { ok: true, out: JSON.stringify(pushed ? [...afterPush, ...runs] : runs) };
      if (args[1] === "view") return { ok: true, out: JSON.stringify(view) };
      if (args[1] === "download") {
        if (!verdict) return { ok: false, out: "" };
        writeFileSync(join(args[args.indexOf("--dir") + 1], "verdict.json"), JSON.stringify(verdict));
        return { ok: true, out: "" };
      }
      return { ok: false, out: "" };
    },
    sleep: async (/** @type {number} */ ms) => {
      clock += ms;
    },
    now: () => clock,
    log: (/** @type {string} */ l) => lines.push(l),
    pollMs: 1000,
  };
  const pushes = () => calls.filter((c) => c.startsWith("git push"));
  return { io, calls, lines, pushes };
}

const request = (/** @type {any} */ w, waitMin = /** @type {number | null} */ (5)) =>
  requestRun({ tier: "unit", branch: "slice/t/2", sha: SHA, waitMin }, w.io);

describe("the tiers", () => {
  it("name a ref for each tier", () => {
    expect(TIERS.map((t) => ciRefName(t, "slice/test-gates/2"))).toEqual([
      "ci/static/slice-test-gates-2",
      "ci/unit/slice-test-gates-2",
      "ci/integration/slice-test-gates-2",
      "ci/components/slice-test-gates-2",
      "ci/full/slice-test-gates-2",
    ]);
    expect(parseCiRef("ci/unit/slice-t-2")).toEqual({ tier: "unit", name: "slice-t-2" });
    expect(parseCiRef("ci/nope/x")).toBeNull();
    expect(() => ciRefName("nope", "x")).toThrow(/unknown tier/);
  });

  it("include the ones before, and full adds the build job", () => {
    expect(jobsFor("static")).toEqual({ jobs: ["static"], ranTier: "static" });
    expect(jobsFor("unit").jobs).toEqual(["static", "unit"]);
    expect(jobsFor("components").jobs).toEqual([
      "static",
      "unit",
      "integration",
      "components-1",
      "components-2",
    ]);
    expect(jobsFor("full")).toEqual({
      jobs: ["static", "unit", "integration", "components-1", "components-2", "build"],
      ranTier: "full",
    });
  });

  it("give the plan job no integration on a unit run", () => {
    expect(planOutputs("ci/unit/x")).toEqual([
      "tier=unit",
      "static=true",
      "unit=true",
      "integration=false",
      "components=false",
      "full=false",
      "components2=false",
      "narrowed=false",
    ]);
    expect(planOutputs("ci/components/x")).toContain("components=true");
    expect(planOutputs("ci/components/x")).toContain("full=false");
    expect(planOutputs("ci/full/x")).toContain("full=true");
    expect(() => planOutputs("dev")).toThrow(/not a ci/);
  });
});

describe("the verdict", () => {
  const ok = { result: "success" };
  const base = { commit: SHA, runId: "1" };

  it("is green only when every job of the tier passed", () => {
    const v = buildVerdict({
      ...base,
      tier: "unit",
      needs: { plan: ok, static: ok, unit: ok, integration: { result: "skipped" } },
    });
    expect(v).toMatchObject({ version: 1, kind: "green", tier: "unit", ranTier: "unit", narrowed: false });
  });

  it("is file for a failed test job, naming the tests", () => {
    const failures = JSON.stringify({
      files: ["a.test.ts"],
      tests: [{ file: "a.test.ts", name: "breaks" }],
      truncated: false,
    });
    const v = buildVerdict({
      ...base,
      tier: "unit",
      needs: { plan: ok, static: ok, unit: { result: "failure", outputs: { failures } } },
    });
    expect(v.kind).toBe("file");
    expect(v.failed).toEqual({
      jobs: ["unit"],
      files: ["a.test.ts"],
      tests: [{ job: "unit", file: "a.test.ts", name: "breaks" }],
      truncated: false,
      unnamedJobs: [],
    });
    expect(
      buildVerdict({ ...base, tier: "unit", needs: { plan: ok, static: ok, unit: { result: "skipped" } } })
        .kind,
    ).toBe("infra");
    expect(
      buildVerdict({ ...base, tier: "static", needs: { plan: { result: "failure" } } }).failed.jobs,
    ).toEqual(["plan", "static"]);
  });

  it("waits for every job the tier ran: a full run needs its components and build", () => {
    const needs = {
      plan: ok,
      static: ok,
      unit: ok,
      integration: ok,
      "components-1": ok,
      "components-2": ok,
      build: ok,
    };
    expect(buildVerdict({ ...base, tier: "full", needs })).toMatchObject({
      kind: "green",
      tier: "full",
      ranTier: "full",
    });
    const noBuild = buildVerdict({
      ...base,
      tier: "full",
      needs: { ...needs, build: { result: "failure", outputs: { started: "true" } } },
    });
    expect(noBuild).toMatchObject({ kind: "brake", failed: { jobs: ["build"] } });
    const oneShard = { ...needs, "components-2": { result: "failure" } };
    expect(buildVerdict({ ...base, tier: "components", needs: oneShard })).toMatchObject({
      kind: "infra",
      failed: { jobs: ["components-2"] },
    });
    const skipped = { ...needs, build: { result: "skipped" } };
    expect(buildVerdict({ ...base, tier: "components", needs: skipped }).kind).toBe("green");
  });

  it("still prints what an older verdict left out", () => {
    const old = { kind: "green", tier: "full", commit: SHA, runId: "1", ranTier: "integration" };
    const lines = verdictLines({ ...old, notBuilt: ["components", "full"] }).join("\n");
    expect(lines).toMatch(/not built yet, so not run: components, full/);
  });

  it("summarizes a Vitest report, an import failure included", () => {
    const summary = summarizeVitest(
      {
        testResults: [
          {
            name: "/w/a.test.ts",
            status: "failed",
            assertionResults: [
              { status: "failed", fullName: " a breaks " },
              { status: "passed", fullName: "a works" },
            ],
          },
          { name: "/w/b.test.ts", status: "failed", assertionResults: [] },
          { name: "/w/c.test.ts", status: "passed", assertionResults: [{ status: "passed", fullName: "c" }] },
        ],
      },
      "/w",
    );
    expect(summary).toEqual({
      reported: true,
      total: 3,
      files: ["a.test.ts", "b.test.ts"],
      tests: [{ file: "a.test.ts", name: "a breaks" }],
      truncated: false,
    });
    expect(summarizeVitest(null, "/w").reported).toBe(false);
  });
});

describe("a job's reports", () => {
  const one = (/** @type {string} */ file) => ({
    reported: true,
    total: 1,
    files: [file],
    tests: [{ file, name: "breaks" }],
    truncated: false,
  });

  it("merge into one summary", () => {
    expect(mergeSummaries([one("a"), one("b")])).toEqual({
      reported: true,
      total: 2,
      files: ["a", "b"],
      tests: [
        { file: "a", name: "breaks" },
        { file: "b", name: "breaks" },
      ],
      truncated: false,
    });
  });

  it("say so when one is missing", () => {
    expect(mergeSummaries([one("a"), summarizeVitest(null, "/w")]).reported).toBe(false);
  });
});

describe("ci run", () => {
  it("parses its arguments", () => {
    expect(parseRunArgs(["unit"])).toEqual({
      tier: "unit",
      ref: null,
      waitMin: null,
      files: [],
    });
    expect(parseRunArgs(["full", "--ref", "prd/t", "--wait"])).toEqual({
      tier: "full",
      ref: "prd/t",
      waitMin: 30,
      files: [],
    });
    expect(parseRunArgs(["unit", "--wait", "5"]).waitMin).toBe(5);
    expect(() => parseRunArgs(["nope"])).toThrow(/needs a tier/);
    expect(() => parseRunArgs(["unit", "--bad"])).toThrow(/unknown argument/);
  });

  it("exits 0 on green and deletes the ref after the verdict", async () => {
    const w = world();
    expect(await request(w)).toBe(EXIT.green);
    expect(w.pushes()).toEqual([
      `git push --force-with-lease=refs/heads/${REF}: origin ${SHA}:refs/heads/${REF}`,
      `git push --force-with-lease=refs/heads/${REF}:${SHA} origin :refs/heads/${REF}`,
    ]);
    expect(w.lines.join("\n")).toMatch(/verdict: green/);
  });

  it("exits by kind on a failed verdict, and still deletes the ref", async () => {
    const w = world({
      verdict: { ...green, kind: "file", failed: { jobs: ["unit"], files: [], tests: [] } },
      view: { status: "completed", conclusion: "failure" },
    });
    expect(await request(w)).toBe(EXIT.file);
    expect(w.pushes().at(-1)).toContain(`origin :refs/heads/${REF}`);
  });

  it("exits 75 at the timeout and keeps the ref", async () => {
    const w = world({ view: { status: "in_progress" } });
    expect(await request(w, 1)).toBe(EXIT.timeout);
    expect(w.pushes()).toHaveLength(1);
    expect(w.lines.at(-1)).toMatch(/is kept/);
  });

  it("returns after the push without --wait, keeping the ref", async () => {
    const w = world();
    expect(await request(w, null)).toBe(EXIT.green);
    expect(w.pushes()).toHaveLength(1);
    expect(w.calls.some((c) => c.includes("run view"))).toBe(false);
  });

  it("reuses a live run when the ref is already at the commit", async () => {
    const w = world({ at: SHA, runs: [running], afterPush: [] });
    expect(await request(w)).toBe(EXIT.green);
    expect(w.pushes()).toEqual([
      `git push --force-with-lease=refs/heads/${REF}:${SHA} origin :refs/heads/${REF}`,
    ]);
    expect(w.lines[0]).toMatch(/already running/);
  });

  it("deletes and pushes again when the ref is at the commit with no live run", async () => {
    const done = { ...running, databaseId: 6, status: "completed", conclusion: "success" };
    const w = world({ at: SHA, runs: [done] });
    expect(await request(w)).toBe(EXIT.green);
    expect(w.pushes().slice(0, 2)).toEqual([
      `git push --force-with-lease=refs/heads/${REF}:${SHA} origin :refs/heads/${REF}`,
      `git push --force-with-lease=refs/heads/${REF}: origin ${SHA}:refs/heads/${REF}`,
    ]);
  });

  it("moves a ref at another commit, guarded by what it was", async () => {
    const w = world({ at: OTHER });
    await request(w);
    expect(w.pushes()[0]).toBe(
      `git push --force-with-lease=refs/heads/${REF}:${OTHER} origin ${SHA}:refs/heads/${REF}`,
    );
  });

  it.each([
    ["a cancelled run", { view: { status: "completed", conclusion: "cancelled" } }, /cancelled/],
    ["a run with no verdict", { verdict: null }, /no verdict/],
    ["a verdict for another commit", { verdict: { ...green, commit: OTHER } }, /another commit/],
  ])("reads %s as unknown and keeps the ref", async (_name, opts, why) => {
    const w = world(/** @type {any} */ (opts));
    expect(await request(w)).toBe(EXIT.unknown);
    expect(w.lines.at(-1)).toMatch(/^verdict: unknown/);
    expect(w.lines.at(-1)).toMatch(why);
    expect(w.pushes()).toHaveLength(1);
  });

  it("reads an unreachable GitHub as unknown and pushes nothing", async () => {
    const w = world({ reachable: false });
    expect(await request(w)).toBe(EXIT.unknown);
    expect(w.lines).toEqual(["verdict: unknown (GitHub can't be reached)"]);
    expect(w.pushes()).toEqual([]);
  });

  it("reads GitHub going away during the wait as unknown and keeps the ref", async () => {
    const w = world();
    const gh = w.io.gh;
    w.io.gh = (args) => (args[1] === "view" ? { ok: false, out: "" } : gh(args));
    expect(await request(w)).toBe(EXIT.unknown);
    expect(w.lines.at(-1)).toMatch(/can't be reached; the ref is kept/);
    expect(w.pushes()).toHaveLength(1);
  });

  it("finds runs without --workflow, which 404s off the default branch, and ignores other workflows", async () => {
    const w = world({ at: SHA, runs: [{ ...running, workflowName: "Deploy" }] });
    await request(w);
    expect(w.calls.some((c) => c.includes("--workflow"))).toBe(false);
    expect(w.lines[0]).not.toMatch(/already running/);
  });

  it("reads a push that starts no run as unknown", async () => {
    const w = world({ afterPush: [] });
    expect(await request(w)).toBe(EXIT.unknown);
    expect(w.lines.at(-1)).toMatch(/no run started/);
  });
});

describe("a narrowed run", () => {
  const NARROWED = "e".repeat(40);
  /** A git that builds the throwaway commit, on top of the fake world. */
  function narrowing(/** @type {any} */ opts = {}) {
    const w = world({
      afterPush: [{ ...running, headSha: NARROWED, headBranch: "x" }],
      verdict: {
        ...green,
        commit: NARROWED,
        target: SHA,
        narrowed: true,
        narrowedFiles: ["a.test.ts"],
      },
      ...opts,
    });
    const git = w.io.git;
    /** @type {Record<string, string>} */ const inputs = {};
    w.io.git = (args, input) => {
      if (input !== undefined) inputs[args[0] ?? ""] = input;
      const plumbing = {
        "cat-file": "",
        "hash-object": "blob1",
        "ls-tree": "100644 blob old\tREADME.md\n100644 blob stale\t.ci-narrowed.json",
        mktree: "tree1",
        "commit-tree": NARROWED,
      };
      const out = plumbing[/** @type {keyof typeof plumbing} */ (args[0])];
      if (out !== undefined) {
        w.calls.push(`git ${args.join(" ")}`);
        return { ok: true, out };
      }
      return git(args);
    };
    return { ...w, inputs };
  }

  it("parses --files", () => {
    expect(parseRunArgs(["unit", "--files", "a.test.ts", "b.test.ts", "--wait"])).toMatchObject({
      files: ["a.test.ts", "b.test.ts"],
      waitMin: 30,
    });
    expect(() => parseRunArgs(["unit", "--files"])).toThrow(/at least one/);
  });

  it("commits the list on top of the target and pushes it to its own ref", () => {
    const w = narrowing();
    expect(narrowedCommit({ tier: "unit", sha: SHA, files: ["a.test.ts"] }, w.io)).toBe(NARROWED);
    expect(JSON.parse(w.inputs["hash-object"] ?? "")).toEqual({ target: SHA, files: ["a.test.ts"] });
    expect(w.inputs.mktree).toBe("100644 blob old\tREADME.md\n100644 blob blob1\t.ci-narrowed.json\n");
    expect(w.calls.at(-1)).toContain(`commit-tree tree1 -p ${SHA}`);
  });

  it("runs on a ref of its own and prints that it is narrowed", async () => {
    const w = narrowing();
    expect(await main(["run", "unit", "--files", "a.test.ts", "--wait", "5"], w.io)).toBe(EXIT.green);
    const ref = `ci/unit/slice-t-2-narrowed-${NARROWED.slice(0, 8)}`;
    expect(w.pushes()[0]).toContain(`${NARROWED}:refs/heads/${ref}`);
    expect(w.lines.join("\n")).toMatch(/narrowed run of aaaaaaaa, never a gate: a\.test\.ts/);
  });

  it("refuses a file above the tier, a non-test file and a file the target lacks", () => {
    const w = narrowing();
    const commit = (/** @type {string} */ tier, /** @type {string} */ file) =>
      narrowedCommit({ tier, sha: SHA, files: [file] }, w.io);
    expect(() => commit("unit", "a.int.test.ts")).toThrow(/needs the integration tier/);
    expect(() => commit("integration", "a.browser.test.tsx")).toThrow(/needs the components tier/);
    expect(() => commit("unit", "README.md")).toThrow(/test files/);
    const gone = world();
    expect(() => narrowedCommit({ tier: "unit", sha: SHA, files: ["a.test.ts"] }, gone.io)).toThrow(
      /is not in/,
    );
  });

  it("starts only its files' jobs, the components in one", () => {
    expect(narrowedJobs(["a.test.ts", "b.browser.test.tsx"])).toEqual(["unit", "components-1"]);
    expect(narrowedJobs(["scripts/loops/browser.test.mjs"])).toEqual(["integration"]);
    const plan = planOutputs("ci/full/x", ["a.int.test.ts"]);
    expect(plan).toEqual([
      "tier=full",
      "static=false",
      "unit=false",
      "integration=true",
      "components=false",
      "full=false",
      "components2=false",
      "narrowed=true",
    ]);
  });

  it("is never printed as the branch's verdict", () => {
    const run = { ...running, status: "completed", conclusion: "success" };
    const w = world({ runs: [run], verdict: { ...green, narrowed: true, kind: "green" } });
    expect(latestVerdict({ sha: SHA }, w.io)).toBe(EXIT.unknown);
    expect(w.lines.join("\n")).not.toMatch(/verdict: green/);
  });
});

describe("the exit codes", () => {
  it.each([
    ["green", 0],
    ["brake", 1],
    ["file", 2],
    ["flake", 3],
    ["infra", 4],
    ["something new", 5],
    ["usage", 5],
    ["timeout", 5],
  ])("%s exits %i", (kind, code) => {
    expect(exitFor(kind)).toBe(code);
  });

  it.each([
    ["brake", EXIT.brake],
    ["flake", EXIT.flake],
    ["infra", EXIT.infra],
  ])("a %s verdict exits by its kind from --wait", async (kind, code) => {
    const w = world({ verdict: { ...green, kind } });
    expect(await request(w)).toBe(code);
  });

  it("keeps 75 for the timeout and 5 for unknown", () => {
    expect(EXIT.timeout).toBe(75);
    expect(EXIT.unknown).toBe(5);
  });
});

describe("ci [<branch>]", () => {
  const done = (/** @type {number} */ id, /** @type {string} */ at, extra = {}) => ({
    ...running,
    databaseId: id,
    status: "completed",
    conclusion: "success",
    createdAt: at,
    ...extra,
  });

  it("prints the latest verdict for the tip", () => {
    const w = world({ runs: [done(1, "2026-11-22T09:00:00Z"), done(2, "2026-11-22T10:00:00Z")] });
    expect(latestVerdict({ sha: SHA }, w.io)).toBe(EXIT.green);
    expect(w.calls.find((c) => c.includes("download"))).toContain("download 2 ");
  });

  it("skips a cancelled run and a narrowed verdict", () => {
    const w = world({ runs: [done(2, "2026-11-22T10:00:00Z", { conclusion: "cancelled" })] });
    expect(latestVerdict({ sha: SHA }, w.io)).toBe(EXIT.unknown);
    const n = world({ runs: [done(1, "2026-11-22T09:00:00Z")], verdict: { ...green, narrowed: true } });
    expect(latestVerdict({ sha: SHA }, n.io)).toBe(EXIT.unknown);
    expect(n.lines.at(-1)).toMatch(/no verdict/);
  });

  it("reads an unreachable GitHub as unknown", () => {
    const w = world({ reachable: false });
    expect(latestVerdict({ sha: SHA }, w.io)).toBe(EXIT.unknown);
    expect(w.lines).toEqual(["verdict: unknown (GitHub can't be reached)"]);
  });

  it("main uses the current branch", async () => {
    const w = world({ runs: [done(1, "2026-11-22T09:00:00Z")] });
    expect(await main([], w.io)).toBe(EXIT.green);
    expect(await main(["a", "b"], w.io)).toBe(EXIT.usage);
  });
});

describe("ci gate and ci file", () => {
  const FLAKE = { job: "unit", file: "apps/web/x.test.ts", name: "wobbles", brake: false };
  const ranUnit = { ...green, ranTier: "unit" };
  const finished = { ...running, status: "completed", conclusion: "success" };
  const gateArgs = ["gate", "slice/t/2", "--tier", "unit", "--base", OTHER];

  /** A world where the branch is one commit past OTHER and changed one app file. */
  const branchWorld = (/** @type {any} */ opts) => {
    const w = world(opts);
    const git = w.io.git;
    w.io.git = (/** @type {string[]} */ args) => {
      if (args[0] === "rev-list") {
        w.calls.push(`git ${args.join(" ")}`);
        return { ok: true, out: SHA };
      }
      if (args[0] === "diff") {
        w.calls.push(`git ${args.join(" ")}`);
        return { ok: true, out: "apps/web/b.ts" };
      }
      return git(args);
    };
    return w;
  };

  /** A world that records what `ci file` hands the backlog. */
  const filingWorld = (/** @type {any} */ verdict, pushed = true) => {
    const w = branchWorld({ verdict });
    /** @type {{ keys: string[], push: boolean }[]} */ const filings = [];
    Object.assign(w.io, {
      fileFindings(/** @type {{ key: string }[]} */ findings, /** @type {boolean} */ push) {
        filings.push({ keys: findings.map((f) => f.key), push });
        return { filed: findings.map((f) => ({ id: "B-77", created: true })), removed: [], pushed };
      },
    });
    return { ...w, filings };
  };
  const fileArgs = ["file", "slice/t/2", "--base", OTHER, "--run", "7"];
  const flaky = { ...ranUnit, kind: "flake", flaky: [FLAKE] };

  it("ci gate lands on a verdict it finds, requests nothing and writes the decision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-gate-"));
    try {
      const out = join(dir, "decision");
      const w = branchWorld({ runs: [finished], verdict: ranUnit });
      expect(await main([...gateArgs, "--out", out], w.io)).toBe(EXIT.green);
      expect(w.pushes()).toEqual([]);
      expect(readFileSync(out, "utf8")).toContain("land=1\nkind=green\nranTier=unit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ci gate requests the tier's run when the tip has no verdict", async () => {
    const w = branchWorld({ verdict: ranUnit });
    expect(await main(gateArgs, w.io)).toBe(EXIT.green);
    expect(w.pushes()[0]).toContain(`${SHA}:refs/heads/${REF}`);
    expect(w.lines.join("\n")).toContain("requesting one");
  });

  it("ci gate --peek requests nothing when the tip has no verdict", async () => {
    const w = branchWorld({ verdict: ranUnit });
    expect(await main([...gateArgs, "--peek"], w.io)).toBe(EXIT.unknown);
    expect(w.pushes()).toEqual([]);
    expect(w.lines).toEqual([`no unit verdict for ${SHA.slice(0, 8)}: the landing will request one`]);
  });

  it("ci gate --peek reports a failing verdict without blaming or requesting", async () => {
    const verdict = { ...ranUnit, kind: "file" };
    const w = branchWorld({ runs: [finished], verdict });
    expect(await main([...gateArgs, "--peek"], w.io)).toBe(EXIT.file);
    expect(w.pushes()).toEqual([]);
    expect(w.calls.filter((c) => c.includes("--branch"))).toEqual([]);
  });

  it("ci file --run reads that run, diffs against --base and pushes the quarantine", async () => {
    const w = filingWorld(flaky);
    expect(await main(fileArgs, w.io)).toBe(EXIT.green);
    expect(w.calls.some((c) => c.startsWith("gh run download 7 "))).toBe(true);
    expect(w.calls.some((c) => c.startsWith("gh run list"))).toBe(false);
    expect(w.calls).toContain(`git diff --name-only ${OTHER}...${SHA}`);
    expect(w.filings).toEqual([{ keys: [expect.any(String)], push: true }]);
  });

  it("ci file --no-push leaves the quarantine commit on local dev", async () => {
    const w = filingWorld(flaky, false);
    expect(await main([...fileArgs, "--no-push"], w.io)).toBe(EXIT.green);
    expect(w.filings[0]?.push).toBe(false);
  });

  it("ci file exits unknown when the quarantine push is refused", async () => {
    const w = filingWorld(flaky, false);
    expect(await main(fileArgs, w.io)).toBe(EXIT.unknown);
    expect(w.lines.at(-1)).toMatch(/wasn't pushed/);
  });

  it("ci file --run refuses a narrowed run and files nothing", async () => {
    const w = filingWorld({ ...flaky, narrowed: true });
    expect(await main(fileArgs, w.io)).toBe(EXIT.unknown);
    expect(w.filings).toEqual([]);
  });
});
