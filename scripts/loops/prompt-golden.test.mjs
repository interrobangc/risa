// Every prompt kind and flag (prompt.sh and its parts in prompts/) against a
// golden file, so a change to the prompt scripts can't change a byte of what they
// print unseen. Rendered twice: on the sample project (sample-project/, its golden
// beside its config), whose names differ from this repo's wherever the prompts
// read them from the config, and on this repo's own config, held to the golden its
// config names (paths.promptGolden). After a deliberate prompt change, regenerate
// both with `pnpm exec vitest run --project tooling:unit loops/prompt-golden.test.mjs -u`
// and review their diffs.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { configPath, loadConfig } from "./config.mjs";
import { SAMPLE_CONFIG, makeRepo } from "./sample-project/repo.mjs";

const SAMPLE_GOLDEN = new URL("./sample-project/prompt-golden.txt", import.meta.url).pathname;

const PLAN = `# Plan: T

## Status

| Slice | Wave | State |
| ----- | ---- | ----- |
| 1     | 1    | not started |

## Slice 1: Stackless

Stack: no · Reads: docs/loops.md · Tests: unit

## Slice 2: Needs a stack

Stack: yes · Reads: none · Tests: e2e:invites

## Slice 3: No fields
`;

const FIXES_PLAN = `# Plan: fixes-x

## Slice 1: A fix

Stack: no · Reads: plans/fixes-rules.md · Tests: unit
`;

// Each case: the arguments (<id> is the config's backlog id prefix), and whether the dispatcher runs (a lock naming a live pid).
const CASES = [
  ["orchestrator", "T"],
  ["orchestrator", "T", "--auto"],
  ["orchestrator", "T", "--resume"],
  ["orchestrator", "T", "--resume", "--auto"],
  ["orchestrator", "fixes-x"],
  ["orchestrator", "fixes-x", "--auto"],
  ["orchestrator", "T", "--bogus"],
  ["plan", "T"],
  ["plan", "T", "<id>1", "<id>22"],
  ["plan", "T", "--auto"],
  ["plan", "T", "--auto", "<id>1"],
  ["plan", "fixes-x"],
  ["plan", "T", "nope"],
  ["slice", "T", "1"],
  ["slice", "T", "1", "--continue"],
  ["slice", "T", "2"],
  ["slice", "T", "3"],
  ["slice", "W", "2"],
  ["slice", "fixes-x", "1"],
  ["slice", "fixes-x", "1", "--continue"],
  ["slice", "T", "1", "--bogus"],
  ["hotfix", "h"],
  ["hotfix", "h", "the menu closes twice"],
  ["backlog"],
  ["backlog", "--guide"],
  ["backlog", "--brief", "<root>/brief.md"],
  ["backlog", "--brief", "<root>/empty.md"],
  ["backlog", "--no-brief"],
  ["backlog", "--bogus"],
  ["backlog", { dispatcher: true }],
  ["backlog", "--guide", { dispatcher: true }],
  ["inbox"],
  ["inbox", "extra"],
  ["recover"],
  ["tidy"],
  ["bogus", "T"],
];

// Only what git and the shells need: no tool knob or RISA_CONFIG from the caller.
const ENV = { PATH: process.env.PATH, HOME: process.env.HOME };

const roots = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

/** A throwaway repo on the config, with the plans the cases read; every case's output. */
function render(config) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prompt-golden-")));
  roots.push(root);
  const main = join(root, "main");
  const { paths, backlog } = loadConfig({ path: config }).config;
  makeRepo(main, {
    config,
    files: {
      [`${paths.plans}/T-plan.md`]: PLAN,
      [`${paths.plans}/T-prd.md`]: "# PRD: T\n",
      [`${paths.plans}/W-plan.md`]: PLAN,
      [`${paths.plans}/fixes-x-plan.md`]: FIXES_PLAN,
    },
  });
  // A worktree that exists without a stack wins over the plan's "Stack: yes".
  mkdirSync(join(main, ".loops/W-2"), { recursive: true });
  writeFileSync(join(main, ".loops/W-2/.env.loop"), "SLOT=\nBASE_BRANCH=prd/W\n");
  writeFileSync(join(root, "brief.md"), "What's in hand: one PRD.\n");
  writeFileSync(join(root, "empty.md"), "  \n");

  const run = (/** @type {any[]} */ cased) => {
    const args = cased.map((a) => (typeof a === "string" ? a.replace("<id>", `${backlog.idPrefix}-`) : a));
    const opts = typeof args.at(-1) === "object" ? args.at(-1) : {};
    const argv = args.filter((a) => typeof a === "string").map((a) => a.replace("<root>", root));
    const lock = join(main, ".loops/.dispatch.lock");
    if (opts.dispatcher) writeFileSync(lock, `${process.pid}\n`);
    try {
      const r = spawnSync("bash", [join(main, "scripts/loops/prompt.sh"), ...argv], {
        cwd: main,
        encoding: "utf8",
        env: ENV,
      });
      const norm = (s) => s.replaceAll(root, "<root>").replaceAll(`pid ${process.pid})`, "pid <pid>)");
      const label = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      return `===== ${label} (exit ${r.status})\n${norm(r.stdout)}----- stderr\n${norm(r.stderr)}`;
    } finally {
      rmSync(lock, { force: true });
    }
  };
  return CASES.map(run).join("");
}

describe("the prompts, byte for byte, for every kind and flag", () => {
  it("on the sample project, in its own names", async () => {
    const out = render(SAMPLE_CONFIG);
    await expect(out).toMatchFileSnapshot(SAMPLE_GOLDEN);
    // Its commands, paths, role docs (by the doc command), trunk and ids, and none of this repo's.
    for (const name of [
      "`risa start",
      "`risa backlog list`",
      "`make check`",
      "`make test-tools`",
      "`make log",
      "GUIDE.md is already",
      "work/plans/T-plan.md",
      "work/inbox.md on origin/main",
      "`risa doc orchestrator`",
      "`risa doc planner`",
      '`risa doc orchestrator "Models"`',
      "into its file, handbook/roles/hotfix.md.",
      "handbook/taste.md",
      "handbook/ and GUIDE.md",
      "`web/.env`",
      "SAM-<n>",
      "dangling sample Docker",
      "(`main-<n>`)",
    ])
      expect(out, name).toContain(name);
    for (const name of ["pnpm", "docs/agents/", "AGENTS.md is", "B-<n>", "plans/inbox.md", "on dev"])
      expect(out, name).not.toContain(name);
  });

  const own = loadConfig({ path: configPath({}) });
  const golden = own.config.paths.promptGolden;
  it.skipIf(!golden)("on this repo's own config, against the golden it names", async () => {
    await expect(render(own.path)).toMatchFileSnapshot(join(own.root, golden));
  });
});
