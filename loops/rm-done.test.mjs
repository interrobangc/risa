// The done flag `pnpm prd rm` writes for a finished PRD, against
// rotate-fixture.mjs's throwaway repo.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { BASE, scaledWait } from "./test-limits.mjs";
import { git, plan, MERGED, root, main, loops, run, backlog, useRotateRepo } from "./rotate-fixture.mjs";

// The limits follow the load as this file starts, not only as the run did (RISA-994).
vi.setConfig({ testTimeout: scaledWait(BASE.testTimeout), hookTimeout: scaledWait(BASE.hookTimeout) });
useRotateRepo();

describe("pnpm prd rm marks a finished PRD done", () => {
  const REGISTRY = `# Backlog tracker

Intro.

## PRDs

The registry.

| PRD | Flags | After | Hot files | Doc and notes |
| --- | ----- | ----- | --------- | ------------- |
| \`fin\` | hold | — | — | finished |
| \`open\` | — | — | — | a slice left |
| \`std\` | standing | — | — | standing |
| \`unm\` | — | — | — | not merged |
| \`notable\` | — | — | — | no table |
| \`fixes-x\` | standing, alone | — | \`loops/\`, \`docs/\` | a fixes wave |
| \`busy\` | — | — | \`web/\` | a PRD with hot files |
| \`tailp\` | — | — | — | landed, then its plan's status |
| \`taild\` | — | — | — | landed, then docs |
| \`tailc\` | — | — | — | landed, then code |
| \`itm\` | — | — | — | an item not landed |

## Items

### B-1 · bug · Something

- status: triaged
- prd: std

### B-2 · bug · Still open

- status: triaged
- prd: itm
`;
  const OLD = `# Backlog tracker

Intro.

## PRDs

| PRD | Doc | Depends on | Hot files |
| --- | --- | ---------- | --------- |
| \`pre\` | [plan](pre-plan.md) | — | — |

## Items
`;
  const commitOnDev = (files) => {
    for (const [f, text] of Object.entries(files)) writeFileSync(join(main, f), text);
    git(main, "add", ...Object.keys(files));
    git(main, "commit", "-q", "-m", "chore: fixture");
  };
  /** A prd/<topic> worktree; unmerged gets a commit dev lacks. */
  const prdWorktree = (topic, { merged = true } = {}) => {
    const dir = join(loops, topic);
    git(main, "worktree", "add", "-q", "-b", `prd/${topic}`, dir, "dev");
    if (!merged) {
      writeFileSync(join(dir, "extra.txt"), "x\n");
      git(dir, "add", "extra.txt");
      git(dir, "commit", "-q", "-m", "feat: extra");
    }
  };
  const flagsOf = (topic) =>
    JSON.parse(backlog("prd", "list", "--json")).find((r) => r.topic === topic).flags;

  it("skips it with the old prose table", () => {
    commitOnDev({ "plans/backlog.md": OLD, "plans/pre-plan.md": plan(MERGED) });
    prdWorktree("pre");
    const r = run("rm.sh", ["pre"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Not marking pre done: .*old prose form/);
    expect(r.stdout).toMatch(/Removed pre and its branch prd\/pre/);
  });

  // One rm.sh is about a second of work alone (a hundred bash lines, six node
  // starts, a test-db drop), so each removal is a test of its own: five in one
  // test took 7 s at load 22 and passed 20 s under load.
  describe("sets done only for a merged branch with no slice left, keeping the other flags, never for standing", () => {
    beforeAll(() => {
      commitOnDev({
        "plans/backlog.md": REGISTRY,
        "plans/fin-plan.md": plan(MERGED),
        "plans/open-plan.md": plan(`${MERGED}\n| 3 | 2 | not started | |`),
        "plans/std-plan.md": plan(MERGED),
        "plans/unm-plan.md": plan(MERGED),
        "plans/notable-plan.md": "# Plan\n\n## Status\n\nAll in.\n",
      });
      for (const t of ["fin", "open", "std", "notable"]) prdWorktree(t);
      prdWorktree("unm", { merged: false });
    }, scaledWait(60_000));

    it("marks a merged branch with no slice left done", () => {
      const r = run("rm.sh", ["fin"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Marked fin done in the PRD registry (flags done)");
      expect(flagsOf("fin")).toEqual(["done"]);
      expect(git(main, "log", "-1", "--format=%s")).toMatch(/^chore\(backlog\): prd set fin: flags=done/);
    });

    it.each([
      ["open", "Not marking open done: slices 3 are still to run (plans/open-plan.md)"],
      ["std", "Not marking std done: std is standing: it never finishes"],
      ["notable", "Not marking notable done: plans/notable-plan.md has no _Status_ slice table"],
    ])("leaves %s undone and says why", (topic, why) => {
      expect(run("rm.sh", [topic]).stdout).toContain(why);
    });

    it("says nothing of done for an unmerged branch, and keeps it", () => {
      const r = run("rm.sh", ["unm"]);
      expect(r.stdout).not.toMatch(/done/);
      expect(r.stdout).toMatch(/kept prd\/unm: it isn't merged/);
    });

    it("left the others' flags as they were", () => {
      const flags = Object.fromEntries(
        JSON.parse(backlog("prd", "list", "--json")).map((r) => [r.topic, r.flags]),
      );
      for (const t of ["open", "std", "notable", "unm"]) expect(flags[t]).not.toContain("done");
      expect(flags.std).toEqual(["standing"]);
    });
  });

  // B-431: the orchestrator's 'landed' commit after the final land left the branch
  // unmerged, so rm kept it and never set done, and the dispatcher started it again.
  describe("a landed branch with a tail past its landing", () => {
    /** prd/<topic>: a commit landed in dev with a merge, then TAIL committed on the branch. */
    const landedWorktree = (topic, tail) => {
      const dir = join(loops, topic);
      git(main, "worktree", "add", "-q", "-b", `prd/${topic}`, dir, "dev");
      writeFileSync(join(dir, `${topic}.txt`), "work\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", `feat(${topic}): work`);
      git(main, "merge", "-q", "--no-ff", "-m", `feat(${topic}): land`, `prd/${topic}`);
      for (const [f, text] of Object.entries(tail)) {
        mkdirSync(join(dir, f, ".."), { recursive: true });
        writeFileSync(join(dir, f), text);
      }
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", `docs(${topic}): landed`);
    };
    beforeAll(() => {
      commitOnDev({
        "plans/backlog.md": REGISTRY,
        "plans/tailp-plan.md": plan(MERGED),
        "plans/taild-plan.md": plan(MERGED),
        "plans/tailc-plan.md": plan(MERGED),
        "plans/itm-plan.md": plan(MERGED),
      });
      landedWorktree("tailp", { "plans/tailp-plan.md": `${plan(MERGED)}\nLanded in dev.\n` });
      landedWorktree("taild", { "docs/tail-notes.md": "# Notes\n" });
      landedWorktree("tailc", { "plans/tailc-plan.md": `${plan(MERGED)}\nLanded.\n`, "code.mjs": "x\n" });
      prdWorktree("itm");
    }, scaledWait(60_000));

    it("marks it done when the tail changes only its plan, and drops the tail with the branch", () => {
      const r = run("rm.sh", ["tailp"]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("Marked tailp done in the PRD registry (flags done)");
      expect(r.stdout).toContain(
        "Removed tailp and its branch prd/tailp, dropping its 1 commit(s) past its last landing in dev (they change only plans/tailp-plan.md)",
      );
      expect(flagsOf("tailp")).toEqual(["done"]);
      expect(git(main, "branch", "--list", "prd/tailp")).toBe("");
    });

    it("marks it done when the tail is other docs, landing them in dev first", () => {
      const r = run("rm.sh", ["taild"]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(
        /Landed prd\/taild's 1 docs commit\(s\) past its last landing in dev as [0-9a-f]{7}/,
      );
      expect(r.stdout).toContain("Marked taild done");
      expect(r.stdout).toContain("Removed taild and its branch prd/taild (merged into dev)");
      expect(readFileSync(join(main, "docs/tail-notes.md"), "utf8")).toBe("# Notes\n");
      expect(git(main, "log", "-2", "--format=%s").split("\n")).toEqual([
        "chore(backlog): prd set taild: flags=done",
        "docs(taild): the docs after its last landing",
      ]);
    });

    it("leaves it undone, branch kept, when the tail has code", () => {
      const r = run("rm.sh", ["tailc"]);
      expect(r.stdout).toContain(
        "Not marking tailc done: prd/tailc has 1 commit(s) past its last landing in dev that aren't Markdown only",
      );
      expect(r.stdout).toMatch(/kept prd\/tailc: it isn't merged/);
      expect(flagsOf("tailc")).toEqual([]);
    });

    it("leaves a merged topic undone while one of its items isn't landed", () => {
      const r = run("rm.sh", ["itm"]);
      expect(r.stdout).toContain("Not marking itm done: B-2 aren't landed yet");
      expect(flagsOf("itm")).toEqual([]);
    });
  });

  it("clears a standing topic's hot files when its worktree goes, keeping its flags; others keep theirs", () => {
    commitOnDev({
      "plans/backlog.md": REGISTRY,
      "plans/fixes-x-plan.md": plan(`${MERGED}\n| 3 | 2 | not started | |`),
      "plans/busy-plan.md": plan(`${MERGED}\n| 3 | 2 | not started | |`),
    });
    prdWorktree("fixes-x", { merged: false });
    prdWorktree("busy");
    const rowOf = (topic) => JSON.parse(backlog("prd", "list", "--json")).find((r) => r.topic === topic);

    let r = run("rm.sh", ["fixes-x", "--force"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Cleared fixes-x's hot files in the PRD registry");
    expect(rowOf("fixes-x")).toMatchObject({ flags: ["standing", "alone"], hot: [] });
    expect(git(main, "log", "-1", "--format=%s")).toMatch(/^chore\(backlog\): prd set fixes-x: hot=—/);

    r = run("rm.sh", ["busy"]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("hot files");
    expect(rowOf("busy").hot).toEqual(["web/"]);
  });

  it("reads the registry once per rm (B-545)", () => {
    commitOnDev({ "plans/backlog.md": REGISTRY, "plans/fin-plan.md": plan(MERGED) });
    for (const b of ["prd/fin"]) if (git(main, "branch", "--list", b)) git(main, "branch", "-D", b);
    prdWorktree("fin");
    const file = join(main, "backlog/backlog.mjs");
    const original = readFileSync(file, "utf8");
    const log = join(root, "registry-reads");
    rmSync(log, { force: true });
    // A counting stub: the real tool, with a line appended per `prd list` call.
    const counter = `import { appendFileSync as __a } from "node:fs";\nif (process.argv.slice(2, 4).join(" ") === "prd list") __a(${JSON.stringify(log)}, "x\\n");\n`;
    writeFileSync(file, counter + original.replace(/^#!.*\n/, ""));
    try {
      const r = run("rm.sh", ["fin"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Marked fin done");
      expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      writeFileSync(file, original);
    }
  });

  it("--no-registry marks nothing done and clears no hot files (the dispatcher's undo, B-452)", () => {
    commitOnDev({ "plans/backlog.md": REGISTRY, "plans/fin-plan.md": plan(MERGED) });
    // The earlier tests' kept branches go: these two start fresh from dev, as new.sh's do.
    for (const b of ["prd/fin", "prd/fixes-x"])
      if (git(main, "branch", "--list", b)) git(main, "branch", "-D", b);
    prdWorktree("fin");
    prdWorktree("fixes-x");
    const head = git(main, "rev-parse", "HEAD");
    for (const t of ["fin", "fixes-x"]) {
      const r = run("rm.sh", [t, "--no-registry", "--force"]);
      expect(r.status).toBe(0);
      expect(r.stdout).not.toMatch(/done|hot files/);
      expect(r.stdout).toContain(`Removed ${t} and its branch prd/${t}`);
    }
    expect(git(main, "rev-parse", "HEAD")).toBe(head);
    const rows = JSON.parse(backlog("prd", "list", "--json"));
    expect(rows.find((r) => r.topic === "fin").flags).toEqual(["hold"]);
    expect(rows.find((r) => r.topic === "fixes-x").hot).toEqual(["loops/", "docs/"]);
  });
});
