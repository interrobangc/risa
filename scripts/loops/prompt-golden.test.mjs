// Every prompt kind and flag (prompt.sh and its parts in prompts/) against a
// golden file, so a refactor of the prompt scripts can't change a byte of what
// they print. The golden was made from the script before it was split
// (B-597). After a deliberate prompt change, regenerate it:
//   CARETOOK_UPDATE_GOLDEN=1 pnpm exec vitest run --project tooling:unit loops/prompt-golden.test.mjs
// and review the diff of prompt.fixtures/golden.txt.
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import "./config-fixture.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const GOLDEN = join(HERE, "prompt.fixtures/golden.txt");
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();

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

// Each case: the arguments, and whether the dispatcher runs (a lock naming a live pid).
const CASES = [
  ["orchestrator", "T"],
  ["orchestrator", "T", "--auto"],
  ["orchestrator", "T", "--resume"],
  ["orchestrator", "T", "--resume", "--auto"],
  ["orchestrator", "fixes-x"],
  ["orchestrator", "fixes-x", "--auto"],
  ["orchestrator", "T", "--bogus"],
  ["plan", "T"],
  ["plan", "T", "B-1", "B-22"],
  ["plan", "T", "--auto"],
  ["plan", "T", "--auto", "B-1"],
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

let root, main;
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("CARETOOK_") && k !== "TRUNK"),
);

const run = (args) => {
  const opts = typeof args.at(-1) === "object" ? args.at(-1) : {};
  const argv = args.filter((a) => typeof a === "string").map((a) => a.replace("<root>", root));
  const lock = join(main, ".loops/.dispatch.lock");
  if (opts.dispatcher) writeFileSync(lock, `${process.pid}\n`);
  try {
    const r = spawnSync("bash", [join(main, "scripts/loops/prompt.sh"), ...argv], {
      cwd: main,
      encoding: "utf8",
      env,
    });
    const norm = (s) => s.replaceAll(root, "<root>").replaceAll(`pid ${process.pid})`, "pid <pid>)");
    const label = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    return `===== ${label} (exit ${r.status})\n${norm(r.stdout)}----- stderr\n${norm(r.stderr)}`;
  } finally {
    rmSync(lock, { force: true });
  }
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "prompt-golden-")));
  main = join(root, "main");
  mkdirSync(join(main, "scripts/loops"), { recursive: true });
  mkdirSync(join(main, "plans"), { recursive: true });
  for (const f of ["prompt.sh", "lib.sh", "config.mjs", "slice-fields.mjs", "slice-brief.mjs"]) {
    copyFileSync(join(HERE, f), join(main, "scripts/loops", f));
  }
  if (existsSync(join(HERE, "prompts")))
    cpSync(join(HERE, "prompts"), join(main, "scripts/loops/prompts"), { recursive: true });
  writeFileSync(join(main, "plans/T-plan.md"), PLAN);
  writeFileSync(join(main, "plans/T-prd.md"), "# PRD: T\n");
  writeFileSync(join(main, "plans/W-plan.md"), PLAN);
  writeFileSync(join(main, "plans/fixes-x-plan.md"), FIXES_PLAN);
  writeFileSync(join(main, ".gitignore"), ".loops/\n");
  git(root, "init", "-q", "-b", "dev", main);
  git(main, "add", ".");
  git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "chore: init");
  // A worktree that exists without a stack wins over the plan's "Stack: yes".
  mkdirSync(join(main, ".loops/W-2"), { recursive: true });
  writeFileSync(join(main, ".loops/W-2/.env.loop"), "SLOT=\nBASE_BRANCH=prd/W\n");
  writeFileSync(join(root, "brief.md"), "What's in hand: one PRD.\n");
  writeFileSync(join(root, "empty.md"), "  \n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

it("prints byte-identical prompts for every kind and flag", () => {
  const out = CASES.map(run).join("");
  if (process.env.CARETOOK_UPDATE_GOLDEN === "1") {
    mkdirSync(join(HERE, "prompt.fixtures"), { recursive: true });
    writeFileSync(GOLDEN, out);
  }
  expect(out).toBe(readFileSync(GOLDEN, "utf8"));
});
