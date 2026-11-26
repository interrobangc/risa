// `pnpm prd ci blame`, `ci file`, the infra rerun, the commit status and `ci status`,
// against a fake git, gh, backlog and board. Nothing here reaches a real one.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  HUNG_MESSAGE,
  devRunPlan,
  slicesNear,
  sortFlakes,
  splitFailures,
  verdictFailures,
} from "./blame.mjs";
import { EXIT, blame, ciStatus, fileFlakes, main, requestRun } from "./ci.mjs";
import { applyFindings, findingKey, keyMark, pruneQuarantine } from "./filing.mjs";
import { tierData } from "./tier-data.mjs";
import { sharedNames } from "../loops/config.mjs";

const SHA = "a".repeat(40);
const DEV = "d".repeat(40);
const NARROWED = "e".repeat(40);
const UNIT = "scripts/loops/a.test.mjs";
const UNIT2 = "scripts/loops/b.test.mjs";
const INT = "lib/x.int.test.ts";
const test1 = { job: "unit", file: UNIT, name: "one" };
const SPEC = tierData().browserCheckFile("sign-in");
/**
 * A verdict file the project's CI wrote (verdict.fixtures/): read as a file, as
 * `pnpm prd ci` reads one.
 * @param {string} name
 */
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./verdict.fixtures/${name}.json`, import.meta.url), "utf8"));
const test2 = { job: "unit", file: UNIT2, name: "two" };

/** A verdict with the fields the tools read. */
const verdict = (/** @type {any} */ o = {}) => {
  const tests = o.tests ?? [];
  const files = o.files ?? [...new Set(tests.map((/** @type {any} */ t) => t.file))];
  return {
    version: 1,
    commit: o.commit ?? SHA,
    target: o.target ?? o.commit ?? SHA,
    runId: "1",
    tier: o.tier ?? "unit",
    narrowed: !!o.narrowed,
    narrowedFiles: o.narrowedFiles ?? [],
    kind: o.kind ?? "file",
    failed: {
      jobs: o.jobs ?? [...new Set(tests.map((/** @type {any} */ t) => t.job))],
      files,
      tests,
      truncated: !!o.truncated,
      unnamedJobs: o.unnamedJobs ?? [],
      ...(o.hung ? { hung: o.hung } : {}),
    },
    afterRerun: o.afterRerun ?? null,
    flaky: o.flaky ?? [],
    brake: { jobs: o.brakeJobs ?? [], tests: o.brakeTests ?? [], files: o.brakeFiles ?? [] },
    infra: { jobs: o.infra ?? [] },
    quarantined: o.quarantined ?? [],
    quarantineList: o.quarantineList ?? [],
  };
};
/** A narrowed result on dev's tip for these files. */
const onDev = (/** @type {any} */ o = {}, files = [UNIT, UNIT2]) =>
  verdict({ commit: NARROWED, target: DEV, narrowed: true, narrowedFiles: files, kind: "green", ...o });

function world(
  /** @type {any} */ {
    branchVerdict = verdict({ tests: [test1] }),
    dev = onDev(),
    absent = [],
    merges = [],
    diff = "",
    diffOk = true,
    filed = null,
    notices = [],
  } = {},
) {
  /** @type {string[]} */ const calls = [];
  /** @type {string[]} */ const lines = [];
  /** @type {any[]} */ const filings = [];
  const board = [...notices];
  let nextNotice = 100;
  let pushedSha = "";
  let clock = 0;
  const branchRun = {
    databaseId: 1,
    headSha: SHA,
    headBranch: "ci/unit/slice-t-5",
    workflowName: "CI",
    status: "completed",
    conclusion: "failure",
    createdAt: "2026-11-22T10:00:00Z",
    url: "https://example.test/run/1",
  };
  const io = {
    git(/** @type {string[]} */ args) {
      calls.push(`git ${args.join(" ")}`);
      const [cmd] = args;
      if (cmd === "fetch") return { ok: true, out: "" };
      if (cmd === "rev-parse")
        return { ok: true, out: String(args.at(-1)).includes("origin/dev") ? DEV : SHA };
      if (cmd === "branch") return { ok: true, out: "slice/t/5" };
      if (cmd === "cat-file")
        return { ok: !absent.some((/** @type {string} */ f) => args[2]?.endsWith(`:${f}`)), out: "" };
      if (cmd === "hash-object" || cmd === "mktree") return { ok: true, out: "f".repeat(40) };
      if (cmd === "ls-tree") return { ok: true, out: `100644 blob ${"1".repeat(40)}\tREADME.md` };
      if (cmd === "commit-tree") return { ok: true, out: NARROWED };
      if (cmd === "ls-remote") return { ok: true, out: "" };
      if (cmd === "push") {
        const to = String(args.at(-1));
        if (!to.startsWith(":")) pushedSha = to.split(":")[0] ?? "";
        return { ok: true, out: "" };
      }
      if (cmd === "log")
        return {
          ok: true,
          out: merges
            .map((/** @type {any} */ m, /** @type {number} */ i) => `m${i}\t${m.subject}`)
            .join("\n"),
        };
      if (cmd === "diff") {
        const m = /^m(\d+)\^1$/.exec(args[2] ?? "");
        if (m) return { ok: true, out: merges[Number(m[1])].files.join("\n") };
        return { ok: diffOk, out: diff };
      }
      return { ok: false, out: "" };
    },
    gh(/** @type {string[]} */ args) {
      calls.push(`gh ${args.join(" ")}`);
      if (args[0] === "api") return { ok: true, out: "" };
      if (args[1] === "list") {
        if (args.includes("--commit")) return { ok: true, out: JSON.stringify([branchRun]) };
        const runs = pushedSha
          ? [
              {
                ...branchRun,
                databaseId: 2,
                headSha: pushedSha,
                headBranch: args[args.indexOf("--branch") + 1],
                status: "in_progress",
              },
            ]
          : [];
        return { ok: true, out: JSON.stringify(runs) };
      }
      if (args[1] === "view")
        return { ok: true, out: JSON.stringify({ status: "completed", conclusion: "success", attempt: 1 }) };
      if (args[1] === "download") {
        const v = args[2] === "1" ? branchVerdict : dev;
        if (!v) return { ok: false, out: "" };
        writeFileSync(join(args[args.indexOf("--dir") + 1] ?? "", "verdict.json"), JSON.stringify(v));
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
    fileFindings(/** @type {any[]} */ findings, /** @type {boolean} */ push) {
      filings.push({ findings, push });
      if (filed === false) return null;
      return {
        filed: findings.map((f, i) => ({ key: f.key, id: `B-${900 + i}`, created: true })),
        removed: [],
        pushed: push ? (filed?.pushed ?? true) : null,
      };
    },
    board: () => ({
      list: () => board,
      post: (/** @type {string} */ text) => void board.push({ id: `n${nextNotice++}`, text }),
      withdraw: (/** @type {string} */ id) =>
        void board.splice(
          board.findIndex((n) => n.id === id),
          1,
        ),
    }),
  };
  return { io, calls, lines, filings, board };
}
const run = (/** @type {any} */ w, json = false) => blame({ branch: "slice/t/5", sha: SHA, json }, w.io);

describe("the split", () => {
  it("is all the branch's when dev passes", async () => {
    const w = world({ branchVerdict: verdict({ tests: [test1, test2] }) });
    expect(await run(w)).toBe(2);
    expect(w.lines.filter((l) => l.includes("the branch's"))).toHaveLength(2);
    expect(w.filings).toEqual([]);
  });

  it("is all dev's when dev fails the same tests", async () => {
    const w = world({
      branchVerdict: verdict({ tests: [test1, test2] }),
      dev: onDev({ kind: "file", tests: [test1, test2] }),
    });
    expect(await run(w)).toBe(0);
    expect(w.filings[0].findings.map((/** @type {any} */ f) => f.prd)).toEqual(["fixes-bug", "fixes-bug"]);
    expect(w.filings[0].push).toBe(false);
    expect(w.filings[0].findings[0].note).toContain("https://example.test/run/1");
    expect(w.filings[0].findings[0].note).toContain("slice/t/5");
  });

  it("splits a mixed run, and a test that fails beside a failing one is still the branch's", async () => {
    const w = world({
      branchVerdict: verdict({ tests: [test1, test2] }),
      dev: onDev({ kind: "file", tests: [test1] }),
    });
    expect(await run(w)).toBe(2);
    expect(w.filings[0].findings).toHaveLength(1);
    expect(w.lines.some((l) => l.includes("dev's") && l.includes(UNIT))).toBe(true);
    expect(w.lines.some((l) => l.includes("the branch's") && l.includes(UNIT2))).toBe(true);
  });

  it("splits a brake the same way, reading what the rerun left", async () => {
    const w = world({
      branchVerdict: verdict({
        kind: "brake",
        tests: [test1, test2],
        afterRerun: { files: [UNIT], tests: [test1] },
        flaky: [{ job: "unit", file: UNIT2, name: "two", brake: false }],
        brakeTests: [test1],
      }),
      dev: onDev({ kind: "brake", tests: [test1], brakeTests: [test1] }),
    });
    expect(await run(w)).toBe(0);
    expect(w.filings[0].findings).toHaveLength(1);
  });

  it("gives a test file dev doesn't have to the branch, without running it", async () => {
    const w = world({ branchVerdict: verdict({ tests: [test1] }), absent: [UNIT] });
    expect(await run(w)).toBe(2);
    expect(w.calls.some((c) => c.startsWith("git push"))).toBe(false);
    expect(w.lines.some((l) => l.includes("not on dev"))).toBe(true);
  });

  it("runs a failed static or build job's whole tier on dev", () => {
    const plan = (/** @type {string} */ job, /** @type {any[]} */ tests = []) =>
      devRunPlan(
        verdictFailures(verdict({ kind: "brake", tests, jobs: [job], brakeJobs: [job] })),
        () => true,
      ).run;
    expect(plan("static")).toMatchObject({ tier: "static", whole: true });
    expect(plan("build")).toMatchObject({ tier: "full", whole: true });
    expect(plan("static", [{ job: "integration", file: INT, name: "n" }])).toMatchObject({
      tier: "integration",
      whole: true,
    });
  });

  it("a failing check job is dev's only when dev's run fails it", async () => {
    const branchVerdict = verdict({ kind: "brake", jobs: ["static"], brakeJobs: ["static"] });
    const whole = (/** @type {any} */ o) => verdict({ commit: DEV, tier: "static", ...o });
    const failing = world({
      branchVerdict,
      dev: whole({ kind: "brake", jobs: ["static"], brakeJobs: ["static"] }),
    });
    expect(await run(failing)).toBe(0);
    expect(await run(world({ branchVerdict, dev: whole({ kind: "green" }) }))).toBe(2);
  });

  it("names the slices whose merges changed the test's directory", async () => {
    expect(
      slicesNear(
        [
          { subject: "feat(t): a (slice 2, B-1)", files: ["scripts/loops/x.mjs"] },
          { subject: "feat(t): b (slice 3)", files: ["apps/web/y.ts"] },
          { subject: "chore: merge dev", files: ["scripts/loops/z.mjs"] },
        ],
        UNIT,
      ),
    ).toEqual([2]);
    const w = world({ merges: [{ subject: "feat(t): a (slice 2, B-1)", files: ["scripts/loops/x.mjs"] }] });
    await run(w);
    expect(w.lines.some((l) => l.includes("(slices 2)"))).toBe(true);
  });

  it("prints one JSON object with --json", async () => {
    const w = world();
    expect(await run(w, true)).toBe(2);
    expect(w.lines).toHaveLength(1);
    expect(JSON.parse(w.lines[0] ?? "").branchFailures[0]).toMatchObject({ file: UNIT, slices: [] });
  });
});

describe("a browser check's failure", () => {
  const spec = SPEC;
  const failed = {
    afterRerun: { files: [spec], tests: [] },
    failed: { jobs: ["browser"], files: [spec], tests: [], unnamedJobs: [] },
  };

  it("is named, so the verdict's list is whole", () => {
    expect(verdictFailures(failed)).toMatchObject({ files: [spec], partial: false });
  });

  it("needs a whole candidate run on dev: a narrowed run has no browser job", () => {
    expect(devRunPlan(verdictFailures(failed), () => true).run).toEqual({
      tier: "candidate",
      files: [spec],
      whole: true,
    });
  });

  it("files a flake with no quarantine entry", () => {
    const { findings } = sortFlakes([{ job: "browser", file: spec, name: null, brake: false }], [], {
      branch: "rc/1",
    });
    expect(findings[0]?.quarantine).toBeNull();
    expect(findings[0]?.note).toContain("a browser check is filed, never quarantined");
  });
});

describe("unknown is never green", () => {
  it.each([
    ["an infra dev run", onDev({ kind: "infra", infra: ["unit"] })],
    ["an unknown kind", onDev({ kind: "something-new" })],
    ["a cut-short dev run", onDev({ kind: "file", tests: [test1], truncated: true })],
    ["a dev run for another commit", onDev({ target: "c".repeat(40) })],
    ["a dev run that didn't cover the file", onDev({}, [UNIT2])],
    ["no dev verdict", null],
    [
      "a flake on dev",
      onDev({ kind: "flake", flaky: [{ job: "unit", file: UNIT, name: "one", brake: false }] }),
    ],
  ])("%s leaves the failure unknown and files nothing", async (_label, dev) => {
    const w = world({ dev });
    expect(await run(w)).toBe(EXIT.unknown);
    expect(w.lines.some((l) => l.includes("unknown:"))).toBe(true);
    expect(w.filings).toEqual([]);
  });

  it("a cut-short branch verdict can't read as all dev's", async () => {
    const w = world({
      branchVerdict: verdict({ tests: [test1], truncated: true }),
      dev: onDev({ kind: "file", tests: [test1] }),
    });
    expect(await run(w)).toBe(EXIT.unknown);
  });

  it("a failed job with no named test can't read as all dev's", () => {
    const failures = verdictFailures(verdict({ tests: [test1], jobs: ["unit", "integration"] }));
    expect(failures.partial).toBe(true);
  });

  it("blame refuses a verdict that isn't file or brake", async () => {
    expect(await run(world({ branchVerdict: verdict({ kind: "green" }) }))).toBe(EXIT.unknown);
  });

  it("files a hung file against that file, its message saying it hung", () => {
    const failures = verdictFailures(verdict({ files: [UNIT], jobs: ["unit"], hung: [UNIT] }));
    expect(failures).toMatchObject({ files: [UNIT], hung: [UNIT], partial: false });
    const s = splitFailures(failures, onDev({ files: [UNIT], jobs: ["unit"], kind: "file" }), []);
    expect(s.dev).toMatchObject([{ file: UNIT, name: null, message: HUNG_MESSAGE }]);
    const passed = splitFailures(failures, onDev(), []);
    expect(passed.branch).toMatchObject([{ file: UNIT, message: HUNG_MESSAGE }]);
  });

  it("a verdict from before hung files names none", () => {
    expect(verdictFailures(verdict({ files: [UNIT], jobs: ["unit"] })).hung).toEqual([]);
  });

  it("with no dev result nothing is placed on dev or the branch", () => {
    const s = splitFailures(verdictFailures(verdict({ tests: [test1] })), null, []);
    expect(s).toMatchObject({ dev: [], branch: [] });
    expect(s.unknown).toHaveLength(1);
  });
});

describe("blame never clears a failure it didn't compare", () => {
  // The verdicts below are the project CI's own (verdict.fixtures/): a narrowed
  // dev run is on commit NARROWED for target DEV, the branch's on SHA.

  it("B-587: a test dev skipped as quarantined stays unknown", async () => {
    const w = world({ dev: fixture("dev-quarantined-skipped") });
    expect(await run(w)).toBe(EXIT.unknown);
    expect(w.lines.some((l) => l.includes("unknown:") && l.includes(UNIT))).toBe(true);
    expect(w.filings).toEqual([]);
  });

  it("B-587: a quarantined test that failed in dev's quarantine step stays unknown", async () => {
    const w = world({ dev: fixture("dev-quarantined-failed") });
    expect(await run(w)).toBe(EXIT.unknown);
  });

  it("B-587: a quarantined test that passed in dev's quarantine step is the branch's", async () => {
    const w = world({ dev: fixture("dev-quarantined-passed") });
    expect(await run(w)).toBe(2);
  });

  it("B-587: a dev verdict with no quarantine list can't clear a named test", async () => {
    const { quarantineList: _gone, ...older } = onDev();
    expect(await run(world({ dev: older }))).toBe(EXIT.unknown);
  });

  it("B-588: a flake doesn't explain a failed job", async () => {
    const branchVerdict = fixture("branch-flake-failed-job");
    expect(branchVerdict.kind).toBe("file");
    const w = world({ branchVerdict });
    expect(await run(w)).toBe(EXIT.unknown);
    expect(w.filings).toEqual([]);
  });

  // The unit job's flake, beside an integration failure dev has too: the unit
  // job failed (branch-flake-beside-failure) or passed on its rerun (…-passed-rerun).
  const intOnDev = () =>
    onDev({ kind: "file", tests: [{ job: "integration", file: INT, name: "n" }] }, [INT]);

  it("B-588: an unexplained job beside a failure dev has too isn't all dev's", async () => {
    expect(await run(world({ branchVerdict: fixture("branch-flake-beside-failure"), dev: intOnDev() }))).toBe(
      EXIT.unknown,
    );
  });

  it("B-588: a job that passed on its rerun still leaves the rest all dev's", async () => {
    expect(
      await run(world({ branchVerdict: fixture("branch-flake-beside-passed-rerun"), dev: intOnDev() })),
    ).toBe(0);
  });

  /** A real narrowed dev verdict whose unit job failed to load the file. */
  const loadFailureOnDev = () => fixture("dev-load-failure");

  it("B-589: a named failure against a dev load failure stays unknown", async () => {
    const w = world({ dev: loadFailureOnDev() });
    expect(await run(w)).toBe(EXIT.unknown);
    expect(w.filings).toEqual([]);
  });

  it("B-590: a branch load failure against dev's named failure stays unknown", async () => {
    const branchVerdict = fixture("branch-load-failure");
    const dev = fixture("dev-named-failure");
    const w = world({ branchVerdict, dev });
    expect(await run(w)).toBe(EXIT.unknown);
    expect(w.lines.some((l) => l.includes("unknown:") && l.includes(UNIT))).toBe(true);
    expect(w.filings).toEqual([]);
  });

  it("B-589: a file failure against a dev load failure is still dev's", async () => {
    const branchVerdict = verdict({ files: [UNIT], jobs: ["unit"] });
    expect(await run(world({ branchVerdict, dev: loadFailureOnDev() }))).toBe(0);
  });
});

describe("filing a dev failure", () => {
  const item = () => ({ id: "B-1", title: "t", status: "triaged", notes: "" });
  const finding = { key: "k1", title: "t", prd: "fixes-bug", note: "found" };
  const writer = (/** @type {any} */ b) => ({
    add(/** @type {any} */ f) {
      const it = { ...item(), id: `B-${b.items.length + 1}`, notes: f.note };
      b.items.push(it);
      return it;
    },
    note(/** @type {any} */ it, /** @type {string} */ text) {
      it.notes += `\n${text}`;
    },
  });

  it("files once, and a second find adds a note", () => {
    const b = { items: /** @type {any[]} */ ([]) };
    expect(applyFindings(b, null, [finding], writer(b)).filed[0]).toMatchObject({ created: true });
    expect(applyFindings(b, null, [finding], writer(b)).filed[0]).toMatchObject({
      created: false,
      id: "B-1",
    });
    expect(b.items).toHaveLength(1);
    expect(b.items[0].notes.split("\n")).toEqual([`${keyMark("k1")} found`, "found"]);
  });

  it("a finished item's key starts a new one", () => {
    const b = { items: [{ ...item(), status: "landed", notes: keyMark("k1") }] };
    expect(applyFindings(b, null, [finding], writer(b)).filed[0]).toMatchObject({ created: true, id: "B-2" });
  });

  it("a done item's quarantine entry leaves; an unknown item's stays", () => {
    const text = `# head\n${UNIT}\tone\tB-1\n${UNIT}\ttwo\tB-2\n${UNIT}\tthree\tB-3\n${UNIT}\tfour\tB-9\n`;
    const out = pruneQuarantine(
      text,
      [
        { ...item(), status: "landed" },
        { ...item(), id: "B-2" },
      ],
      ["B-3"],
    );
    expect(out.removed).toHaveLength(2);
    expect(out.text).toBe(`# head\n${UNIT}\ttwo\tB-2\n${UNIT}\tfour\tB-9\n`);
  });

  it("a dev brake posts one notice, and a later pass withdraws it", async () => {
    const braking = { branchVerdict: verdict({ kind: "brake", tests: [test1], brakeTests: [test1] }) };
    const dev = onDev({ kind: "brake", tests: [test1], brakeTests: [test1] });
    const first = world({ ...braking, dev });
    await run(first);
    expect(first.board).toHaveLength(1);
    expect(first.board[0].text).toBe(`dev brake B-900 ${keyMark(findingKey(test1))}: ${UNIT}: one`);

    const again = world({ ...braking, dev, notices: first.board });
    await run(again);
    expect(again.board).toHaveLength(1);

    const other = { id: "n1", text: "someone else's notice" };
    const passed = world({ ...braking, dev: onDev(), notices: [...first.board, other] });
    expect(await run(passed)).toBe(2);
    expect(passed.board).toEqual([other]);
  });

  it("a test absent on dev proves nothing about a brake on it", async () => {
    const notice = { id: "n5", text: `dev brake B-1 ${keyMark(findingKey(test1))}: x` };
    const w = world({ absent: [UNIT], notices: [notice] });
    await run(w);
    expect(w.board).toEqual([notice]);
  });
});

describe("a failure's message", () => {
  const message = "AssertionError: expected 812 to be below 500\n  at search.test.ts:40";
  const said = { ...test1, message };

  it("prints beside the test in blame, on one line", async () => {
    const w = world({ branchVerdict: verdict({ tests: [said] }) });
    expect(await run(w)).toBe(2);
    const at = w.lines.findIndex((l) => l.startsWith("  the branch's: "));
    expect(w.lines[at + 1]).toBe("      AssertionError: expected 812 to be below 500 at search.test.ts:40");
  });

  it("is kept in blame's JSON and quoted in dev's filed note", async () => {
    const w = world({
      branchVerdict: verdict({ tests: [said] }),
      dev: onDev({ kind: "file", tests: [test1] }),
    });
    await run(w, true);
    expect(JSON.parse(w.lines.at(-1) ?? "").devFailures[0].message).toBe(message);
    expect(w.filings[0].findings[0].note).toMatch(
      / First failure: AssertionError: expected 812 to be below 500 at search\.test\.ts:40$/,
    );
  });

  it("is quoted in a filed flake's note, and a test with none adds nothing", () => {
    const flake = { job: "unit", file: UNIT, name: "one", brake: false };
    const [filed] = sortFlakes([{ ...flake, message }], [], { branch: "b" }).findings;
    expect(filed.note).toContain("; found by b. First failure: AssertionError: expected 812");
    const [bare] = sortFlakes([flake], [], { branch: "b" }).findings;
    expect(bare.note).not.toContain("First failure");
  });

  it("prints under a branch's own flake in ci file", () => {
    const w = world({
      branchVerdict: verdict({ kind: "flake", jobs: ["unit"], flaky: [{ ...test1, brake: false, message }] }),
      diff: UNIT,
    });
    fileFlakes({ branch: "slice/t/5", sha: SHA, base: null }, w.io);
    const at = w.lines.findIndex((l) => l.includes("the branch's flake"));
    expect(w.lines[at + 1]).toContain("expected 812 to be below 500");
  });
});

describe("ci file", () => {
  const flaky = (/** @type {any} */ o = {}) => ({ job: "unit", file: UNIT, name: "one", brake: false, ...o });
  const file = (/** @type {any} */ w, base = /** @type {string | null} */ (null)) =>
    fileFlakes({ branch: "slice/t/5", sha: SHA, base }, w.io);
  const flakes = (/** @type {any[]} */ list) => verdict({ kind: "flake", flaky: list, jobs: ["unit"] });

  it("files and quarantines a flake in an untouched file, with a push", () => {
    const w = world({ branchVerdict: flakes([flaky()]) });
    expect(file(w)).toBe(0);
    expect(w.filings).toHaveLength(1);
    expect(w.filings[0].push).toBe(true);
    expect(w.filings[0].findings[0]).toMatchObject({
      prd: "fixes-tooling",
      quarantine: { file: UNIT, name: "one" },
    });
  });

  it("files a brake-list flake with no entry and no push", () => {
    const w = world({ branchVerdict: flakes([flaky({ brake: true })]) });
    expect(file(w)).toBe(0);
    expect(w.filings[0]).toMatchObject({ push: false });
    expect(w.filings[0].findings[0].quarantine).toBeNull();
  });

  it("files a whole-file flake with no entry", () => {
    const w = world({ branchVerdict: flakes([flaky({ name: null })]) });
    expect(file(w)).toBe(0);
    expect(w.filings[0].findings[0].quarantine).toBeNull();
  });

  it("lists a flake in a file the branch edited as the branch's and writes nothing", () => {
    const w = world({ branchVerdict: flakes([flaky()]), diff: UNIT });
    expect(file(w)).toBe(2);
    expect(w.filings).toEqual([]);
    expect(w.lines.some((l) => l.includes("the branch's flake"))).toBe(true);
  });

  it("compares with --base when given, and doesn't fetch", () => {
    const w = world({ branchVerdict: flakes([flaky()]) });
    file(w, "c".repeat(40));
    expect(w.calls).toContain(`git diff --name-only ${"c".repeat(40)}...${SHA}`);
    expect(w.calls.some((c) => c.startsWith("git fetch"))).toBe(false);
  });

  it("writes nothing when it can't read what the branch changed", () => {
    const w = world({ branchVerdict: flakes([flaky()]), diffOk: false });
    expect(file(w)).toBe(EXIT.unknown);
    expect(w.filings).toEqual([]);
  });

  it("a failed push or write isn't green", () => {
    expect(file(world({ branchVerdict: flakes([flaky()]), filed: { pushed: false } }))).toBe(EXIT.unknown);
    expect(file(world({ branchVerdict: flakes([flaky()]), filed: false }))).toBe(EXIT.unknown);
  });

  it("files one finding for a flake two jobs saw", () => {
    const out = sortFlakes([flaky(), flaky({ job: "other" })], [], { branch: "b" });
    expect(out.findings).toHaveLength(1);
  });
});

/** A fake run for requestRun: each view returns the next state, each download the next verdict. */
function rerunWorld(/** @type {any[]} */ views, /** @type {any[]} */ verdicts, rerunOk = true) {
  /** @type {string[]} */ const calls = [];
  /** @type {string[]} */ const lines = [];
  let pushed = false;
  let clock = 0;
  let view = 0;
  let got = 0;
  const running = {
    databaseId: 7,
    headSha: SHA,
    headBranch: "ci/unit/slice-t-5",
    workflowName: "CI",
    status: "in_progress",
    createdAt: "2026-11-22T10:00:00Z",
    url: "https://example.test/7",
  };
  const io = {
    git(/** @type {string[]} */ args) {
      calls.push(`git ${args.join(" ")}`);
      if (args[0] === "ls-remote") return { ok: true, out: "" };
      if (args[0] === "push") {
        pushed = true;
        return { ok: true, out: "" };
      }
      return { ok: false, out: "" };
    },
    gh(/** @type {string[]} */ args) {
      calls.push(`gh ${args.join(" ")}`);
      if (args[0] === "api") return { ok: true, out: "" };
      if (args[1] === "list") return { ok: true, out: JSON.stringify(pushed ? [running] : []) };
      if (args[1] === "view")
        return { ok: true, out: JSON.stringify(views[Math.min(view++, views.length - 1)]) };
      if (args[1] === "rerun") return { ok: rerunOk, out: "" };
      if (args[1] === "download") {
        writeFileSync(
          join(args[args.indexOf("--dir") + 1] ?? "", "verdict.json"),
          JSON.stringify(verdicts[got++]),
        );
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
  return { io, calls, lines, reruns: () => calls.filter((c) => c.includes("run rerun")).length };
}
const completed = (/** @type {number} */ attempt) => ({
  status: "completed",
  conclusion: "failure",
  attempt,
});
const request = (/** @type {any} */ w, waitMin = 5) =>
  requestRun({ tier: "unit", branch: "slice/t/5", sha: SHA, waitMin }, w.io);

describe("an infra verdict", () => {
  const infra = verdict({ kind: "infra", infra: ["unit"] });

  it("is rerun once and reads the new attempt's verdict", async () => {
    const w = rerunWorld(
      [completed(1), completed(1), { status: "in_progress", attempt: 2 }, completed(2)],
      [infra, verdict({ kind: "green" })],
    );
    expect(await request(w)).toBe(EXIT.green);
    expect(w.reruns()).toBe(1);
    expect(w.calls).toContain("gh run rerun 7 --failed");
    expect(w.calls.filter((c) => c.startsWith("gh run download"))).toHaveLength(2);
  });

  it("is never rerun twice, and is reported when it stays infra", async () => {
    const w = rerunWorld([completed(1), completed(2), completed(3)], [infra, infra, infra]);
    expect(await request(w)).toBe(EXIT.infra);
    expect(w.reruns()).toBe(1);
    expect(w.lines).toContain("still infra after its one rerun");
  });

  it("keeps its ref until the final verdict", async () => {
    const w = rerunWorld([completed(1), completed(2)], [infra, verdict({ kind: "green" })]);
    await request(w);
    const rerunAt = w.calls.findIndex((c) => c.includes("run rerun"));
    const deleteAt = w.calls.findIndex(
      (c) => c.startsWith("git push") && c.endsWith(" :refs/heads/ci/unit/slice-t-5"),
    );
    expect(deleteAt).toBeGreaterThan(rerunAt);
  });

  it("reads as infra when the rerun can't start", async () => {
    const w = rerunWorld([completed(1)], [infra], false);
    expect(await request(w)).toBe(EXIT.infra);
    expect(w.reruns()).toBe(1);
  });

  it("times out, never green, when the new attempt doesn't appear", async () => {
    const w = rerunWorld([completed(1)], [infra]);
    expect(await request(w, 1)).toBe(EXIT.timeout);
  });

  it("a file verdict isn't rerun", async () => {
    const w = rerunWorld([completed(1)], [verdict({ tests: [test1] })]);
    expect(await request(w)).toBe(EXIT.file);
    expect(w.reruns()).toBe(0);
  });
});

describe("the commit status", () => {
  const statusCall = (/** @type {any} */ w) =>
    w.calls.find((/** @type {string} */ c) => c.startsWith("gh api"));

  it.each([
    ["green", "success"],
    ["flake", "success"],
    ["file", "failure"],
    ["brake", "failure"],
  ])("a whole-tier %s writes %s, naming the tier", async (kind, state) => {
    const w = rerunWorld([completed(1)], [verdict({ kind })]);
    await request(w);
    expect(statusCall(w)).toContain(`statuses/${SHA}`);
    expect(statusCall(w)).toContain(`state=${state}`);
    expect(statusCall(w)).toContain(`context=${sharedNames().ciContext}/unit`);
    expect(statusCall(w)).toContain(`description=${kind} (unit)`);
  });

  it("a narrowed run gets none", async () => {
    const w = rerunWorld([completed(1)], [verdict({ kind: "green", narrowed: true, narrowedFiles: [UNIT] })]);
    await request(w);
    expect(statusCall(w)).toBeUndefined();
  });

  it("a failed write only warns", async () => {
    const w = rerunWorld([completed(1)], [verdict({ kind: "green" })]);
    const gh = w.io.gh;
    w.io.gh = (args) => (args[0] === "api" ? { ok: false, out: "" } : gh(args));
    expect(await request(w)).toBe(EXIT.green);
    expect(w.lines.some((l) => l.startsWith("warning: could not write the commit status"))).toBe(true);
  });
});

describe("ci status", () => {
  const listed = (/** @type {any} */ o = {}) => ({
    databaseId: 1,
    attempt: 1,
    headSha: SHA,
    headBranch: "ci/unit/slice-t-5",
    workflowName: "CI",
    status: "completed",
    conclusion: "failure",
    createdAt: "2026-11-22T10:00:00Z",
    ...o,
  });
  function statusWorld(/** @type {any[]} */ runs, /** @type {any} */ v = verdict(), ok = true) {
    /** @type {string[]} */ const calls = [];
    /** @type {string[]} */ const lines = [];
    /** @type {Map<string, string>} */ const store = new Map();
    const state = { clock: 1000 };
    const io = {
      git: () => ({ ok: true, out: SHA }),
      gh(/** @type {string[]} */ args, /** @type {number=} */ timeoutMs) {
        calls.push(`${args[1]} ${timeoutMs}`);
        if (!ok) return { ok: false, out: "" };
        if (args[1] === "list") return { ok: true, out: JSON.stringify(runs) };
        writeFileSync(join(args[args.indexOf("--dir") + 1] ?? "", "verdict.json"), JSON.stringify(v));
        return { ok: true, out: "" };
      },
      sleep: async () => {},
      now: () => state.clock,
      log: (/** @type {string} */ l) => lines.push(l),
      pollMs: 1,
      cache: () => ({
        read: (/** @type {string} */ n) => store.get(n) ?? null,
        write: (/** @type {string} */ n, /** @type {string} */ t) => void store.set(n, t),
      }),
    };
    return { io, calls, lines, state };
  }

  it("prints each branch's latest whole-tier verdict and tier", () => {
    const w = statusWorld([
      listed({
        databaseId: 2,
        headBranch: "ci/unit/slice-t-5-narrowed-abcd1234",
        createdAt: "2026-11-22T11:00:00Z",
      }),
      listed(),
    ]);
    expect(ciStatus(["slice/t/5", "prd/other"], w.io)).toBe(0);
    expect(w.lines).toEqual([
      "CI (latest whole-tier verdicts)",
      `  slice/t/5: file · unit · ${SHA.slice(0, 8)}`,
    ]);
  });

  it("asks GitHub once, with a time limit, and reuses the list and the verdict", () => {
    const w = statusWorld([listed()]);
    ciStatus(["slice/t/5"], w.io);
    w.state.clock += 5000;
    ciStatus(["slice/t/5"], w.io);
    expect(w.calls).toEqual(["list 10000", "download 10000"]);
  });

  it("reads the list again after 30 s, and a new attempt's verdict", () => {
    const runs = [listed()];
    const w = statusWorld(runs);
    ciStatus(["slice/t/5"], w.io);
    runs[0] = listed({ attempt: 2 });
    w.state.clock += 31_000;
    ciStatus(["slice/t/5"], w.io);
    expect(w.calls.filter((c) => c.startsWith("list"))).toHaveLength(2);
    expect(w.calls.filter((c) => c.startsWith("download"))).toHaveLength(2);
  });

  it("prints nothing when GitHub is away", () => {
    const w = statusWorld([], verdict(), false);
    expect(ciStatus(["slice/t/5"], w.io)).toBe(0);
    expect(w.lines).toEqual([]);
  });

  it("a completed run with no readable verdict is unknown, never green", () => {
    const w = statusWorld([listed()], { nope: true });
    ciStatus(["slice/t/5"], w.io);
    expect(w.lines[1]).toContain("unknown");
  });

  it("main routes the command", async () => {
    const w = statusWorld([listed()]);
    expect(await main(["status", "slice/t/5"], w.io)).toBe(0);
    expect(w.lines).toHaveLength(2);
  });
});
