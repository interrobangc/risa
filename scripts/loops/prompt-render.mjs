// Every prompt kind and flag (prompt.sh and its parts in prompts/), rendered on a
// project config into one text: what the prompt goldens hold. A throwaway repo on
// the config (sample-project/repo.mjs's makeRepo), with the plans the cases read,
// runs each case and the outputs are joined, each under its `===== <args> (exit n)`
// line. The temp root and the test's pid are written as `<root>` and `<pid>`.
//
//   renderPrompts(config)   the config's path → the rendered text
//
// Its users: prompt-golden.test.mjs (the sample project, against its golden) and
// project-check.mjs (the configured project, against the golden its config names:
// paths.promptGolden).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.mjs";
import { makeRepo } from "./sample-project/repo.mjs";

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
/** @type {(string | { dispatcher: boolean })[][]} */
export const CASES = [
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

/**
 * Every case's output on the config at `config`, joined.
 * @param {string} config the config's path
 * @returns {string}
 */
export function renderPrompts(config) {
  // Only what git and the shells need: no tool knob or RISA_CONFIG from the caller.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prompt-render-")));
  try {
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

    const run = (/** @type {(string | { dispatcher: boolean })[]} */ cased) => {
      const args = cased.map((a) => (typeof a === "string" ? a.replace("<id>", `${backlog.idPrefix}-`) : a));
      const last = args.at(-1);
      const opts = typeof last === "object" ? last : { dispatcher: false };
      const argv = args.flatMap((a) => (typeof a === "string" ? [a.replace("<root>", root)] : []));
      const lock = join(main, ".loops/.dispatch.lock");
      if (opts.dispatcher) writeFileSync(lock, `${process.pid}\n`);
      try {
        const r = spawnSync("bash", [join(main, "scripts/loops/prompt.sh"), ...argv], {
          cwd: main,
          encoding: "utf8",
          env,
        });
        const norm = (/** @type {string} */ s) =>
          s.replaceAll(root, "<root>").replaceAll(`pid ${process.pid})`, "pid <pid>)");
        const label = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
        return `===== ${label} (exit ${r.status})\n${norm(r.stdout)}----- stderr\n${norm(r.stderr)}`;
      } finally {
        rmSync(lock, { force: true });
      }
    };
    return CASES.map(run).join("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
