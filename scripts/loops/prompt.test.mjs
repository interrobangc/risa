// The session prompts (prompt.sh) against a throwaway repo with the scripts
// copied in: the plain prompts, the resume and continue variants, and the
// every-step _Status_ rule. Nothing here starts a session.
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_CONFIG } from "./config-fixture.mjs";

const HERE = new URL(".", import.meta.url).pathname;
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
`;

// A topic with a PRD: slices cite its parts, and one decision row names an item.
const V_PLAN = `# Plan: V

## Status

| Slice | Wave | State |
| ----- | ---- | ----- |
| 1     | 1    | not started |

## Architectural decisions

- **Tooling only:** every slice follows this.

## Slice 1: The store

Stack: no · Reads: docs/agents/machinery.md · Tests: unit

**User stories:** US 1 to 2.

**Build:** the PRD's _The store_ and the _Quiet rule_ row (B-9).

## Slice 2: The brief

Stack: no · Reads: none · Tests: unit

**Build:** the PRD's _The brief_, nothing else.
`;

const V_PRD = `# PRD: V

## Decisions

| Decision                         | Why    | Source     | Cost |
| -------------------------------- | ------ | ---------- | ---- |
| **Quiet rule:** stores are quiet | asked  | assumed    | low  |
| Briefs are short                 | budget | item B-9   | low  |
| Briefs name no model             | rules  | item B-10  | low  |

## User stories

1. As a loop, I want a store, so that I keep things.
2. As a loop, I want it quiet, so that I hear nothing.
3. As a loop, I want a brief, so that I know things.

## Implementation decisions

- **The store** keeps one file per record.
- **The brief:** prints a short text.
`;

// A fixes topic, its slices under wave headings and no PRD.
const FIXES_PLAN = `# Plan: fixes-w

## Status

| Slice | Wave | State |
| ----- | ---- | ----- |
| 4     | 2    | not started |

## Wave 1

The first wave's intro.

### Slice 3: An old fix

Stack: no · Reads: plans/fixes-rules.md · Tests: unit

Old fix text.

## Wave 2

The second wave's intro: slice 4 goes first.

### Slice 4: A new fix (B-40)

Stack: no · Reads: plans/fixes-rules.md · Tests: unit

New fix text.

### Slice 5: Another fix

Stack: no · Reads: plans/fixes-rules.md · Tests: unit

Another fix text.
`;

let root, main, loops;
const prompt = (...args) => {
  const r = spawnSync("bash", [join(main, "scripts/loops/prompt.sh"), ...args], {
    cwd: main,
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const ok = (...args) => {
  const r = prompt(...args);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return r.out;
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "prompt-test-")));
  main = join(root, "main");
  loops = join(main, ".loops");
  mkdirSync(join(main, "scripts/loops"), { recursive: true });
  mkdirSync(join(main, "plans"), { recursive: true });
  for (const f of ["prompt.sh", "lib.sh", "config.mjs", "slice-fields.mjs", "slice-brief.mjs"]) {
    copyFileSync(join(HERE, f), join(main, "scripts/loops", f));
  }
  cpSync(join(HERE, "prompts"), join(main, "scripts/loops/prompts"), { recursive: true });
  writeFileSync(join(main, "plans/T-plan.md"), PLAN);
  writeFileSync(join(main, "plans/T-prd.md"), "# PRD: T\n");
  writeFileSync(join(main, "plans/V-plan.md"), V_PLAN);
  writeFileSync(join(main, "plans/V-prd.md"), V_PRD);
  writeFileSync(join(main, "plans/fixes-w-plan.md"), FIXES_PLAN);
  git(root, "init", "-q", "-b", "dev", main);
  git(main, "add", ".");
  git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "chore: init");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const EVERY_STEP = "Keep the plan's _Status_ section current **at every step**, not only at wave boundaries";
const RESUME = "**You're taking over after an interruption**";
const CONTINUE = "**You're continuing slice";
const RUN_THROUGH = "**Landing mode: run everything through.**";
const ASK_FIRST = "**Landing mode: ask first.**";

describe("orchestrator", () => {
  it("plain: asks for a landing mode, updates _Status_ at every step, and says nothing about resuming", () => {
    const out = ok("orchestrator", "T");
    expect(out).toContain('You are the PRD orchestrator for "T".');
    expect(out).toContain("plans/T-prd.md and plans/T-plan.md");
    expect(out).toContain(EVERY_STEP);
    expect(out).toMatch(/a slice started .*handed off, merged .*a wave landed/);
    expect(out).not.toContain("at every wave boundary (merged SHAs");
    expect(out).toContain(ASK_FIRST);
    expect(out).not.toContain(RUN_THROUGH);
    expect(out).not.toContain(RESUME);
    expect(out).not.toContain("**Respawn each in-flight slice**");
    expect(out.trimEnd()).toMatch(/Record the answers in the plan's _Status_ and follow them\..*$/);
  });

  it("runs the status trim after each landing, in every variant (B-598)", () => {
    for (const flags of [[], ["--auto"], ["--resume"], ["--resume", "--auto"]]) {
      const out = ok("orchestrator", "T", ...flags);
      expect(out).toContain("Then run `pnpm prd status-trim T`");
      expect(out).toContain("plans/T-history.md; commit both files");
      expect(out).toContain("Keep _Status_ under about 6 KB");
    }
    expect(ok("orchestrator", "fixes-x")).toContain("numbered on from `pnpm prd status-trim fixes-x --next`");
  });

  it("carries the PR flow in every variant", () => {
    for (const flags of [[], ["--auto"], ["--resume"], ["--resume", "--auto"]]) {
      const out = ok("orchestrator", "T", ...flags);
      expect(out).toContain("**Code lands through a GitHub PR into dev, reviewed by Codex.**");
      expect(out).toContain("`pnpm prd pr T`");
      expect(out).toContain("`pnpm prd review T --wait` in the background");
      expect(out).toContain("push a real one off to the backlog");
      expect(out).toContain(
        "when `add` stops on a look-alike (exit 3), `note` the item it names if that covers the finding, or rerun with `--anyway` if it doesn't",
      );
      expect(out).toContain("Reply on every thread before resolving it");
      expect(out).toContain("resolve each answered thread");
      expect(out).toContain("`review --again` until clean");
      expect(out).toContain("After about three rounds, ask the user");
      expect(out).toContain(
        "`--force` and `--no-review` each need a Fable land skeptic's `go` for this tip and action",
      );
      expect(out).toContain("on a brake or an unsynced tip `--force` needs `--by-user`");
      expect(out).toContain("Before declining a finding");
      expect(out).toContain('`--action "decline <thread>"`');
      expect(out).toContain("a `no` makes it a backlog item");
      expect(out).toContain(
        'needs neither when Codex is out of credits: `review` exits 4 with "codex: out of credits"',
      );
      expect(out).toContain(
        "When the wave's diff is docs only (Markdown files, nothing else), don't run or wait for `pnpm prd review`: open the PR with `pnpm prd pr T` and land.",
      );
    }
  });

  it("drains, then rotates after a landing, and ends with rm then end, with and without --auto", () => {
    for (const flags of [[], ["--auto"], ["--resume"], ["--resume", "--auto"]]) {
      const out = ok("orchestrator", "T", ...flags);
      expect(out).toContain("**One session per wave: drain, then rotate.**");
      expect(out).toContain(
        "After a landing and its docs (not the last one), start no new slice; once the slices in flight are merged, commit _Status_ and run `pnpm prd rotate`; with none in flight, rotate at once.",
      );
      expect(out).toContain("`pnpm prd rotate --mid-wave`");
      expect(out).toContain("**past the context limit** (160k tokens; a hook reminds you)");
      expect(out).toContain('`pnpm prd rotate --mid-wave --reason "context"`');
      expect(out).toContain('`pnpm prd context --keep "<why>"` and write the reason in _Status_');
      expect(out).toContain("only on the user's word");
      expect(out).toMatch(
        /When the last wave has landed, run `pnpm prd rm T`, then `cd \S+ && pnpm prd end`/,
      );
    }
  });

  it("--auto: the run-through mode, starting the first ready wave", () => {
    const out = ok("orchestrator", "T", "--auto");
    expect(out).toContain(EVERY_STEP);
    expect(out).toContain(RUN_THROUGH);
    expect(out).toContain(
      "You were started run-through (by the dispatcher, in the registry's order, or by hand)",
    );
    expect(out).not.toContain("pnpm prd queue");
    expect(out).not.toContain(ASK_FIRST);
    expect(out).not.toContain(RESUME);
    expect(out).toContain("record the landing mode in the plan's _Status_, then start the first ready wave.");
  });

  it("--auto: a landing declares its tier", () => {
    for (const flags of [["--auto"], ["--resume", "--auto"]]) {
      const out = ok("orchestrator", "T", ...flags);
      expect(out).toContain('`pnpm prd land T --tier <t> -m "<subject>"`');
      expect(out).toContain("land typechecks the merge and lands the unsynced tip");
      expect(out).toContain("the next wave syncs as usual");
    }
  });

  it("--auto: questions and reports go through pnpm prd ask, only a question is pushed, never AskUserQuestion", () => {
    for (const flags of [["--auto"], ["--resume", "--auto"]]) {
      const out = ok("orchestrator", "T", ...flags);
      expect(out).toContain("`pnpm prd ask --topic T --question");
      expect(out).toContain("PushNotification tool yourself");
      expect(out).toContain("`pnpm prd ask --wait <id>` in the background");
      expect(out).toContain("`pnpm prd answer <id>");
      expect(out).toContain("`pnpm prd ask --topic T --report");
      expect(out).toContain("never pushed: no PushNotification for a report");
      expect(out).toContain(
        "**The only PushNotification you ever send is the line `pnpm prd ask` prints for a question**",
      );
      // What silence means: --defaults with a recommendation, --waits for the never list, the tool decides.
      expect(out).toContain("--recommend <a> --defaults` (or `--waits`, below)");
      expect(out).toContain("Pass `--defaults` on it: if no one answers within 30 minutes, the tool takes");
      expect(out).toContain(
        "Pass `--waits` instead for the questions that never default: money (a paid service too), data loss or a change to existing data, a live deploy (staging or production), a destructive step (deleting unmerged work, a forced push), a new dependency (AGENTS.md: the user's approval), and compliance",
      );
      expect(out).toContain("The tool, never you, puts the recommendation in place of an answer");
      expect(out).toContain("`to-test/<date>-<time>-<topic>.md`");
      expect(out).toContain("names the topic, what landed and that to-test file, and stands alone");
      expect(out).not.toContain("AskUserQuestion");
    }
    for (const flags of [[], ["--resume"]]) {
      const out = ok("orchestrator", "T", ...flags);
      expect(out).not.toContain("pnpm prd ask");
      // The watch's stall record names its class (--defaults or --waits); nothing else defaults.
      expect(out.replace(/^- \*\*Watch the slice agents:\*\*.*$/m, "")).not.toContain("--defaults");
      expect(out).toContain("AskUserQuestion");
    }
    // An attended planner asks in front of the user: nothing defaults there.
    expect(ok("plan", "T", "B-1")).not.toContain("--defaults");
  });

  it("carries the watch steps in every variant: mark first, confirm a stop, a stall skeptic", () => {
    for (const flags of [[], ["--auto"], ["--resume"], ["--resume", "--auto"]]) {
      const out = ok("orchestrator", "T", ...flags);
      expect(out).toContain("keep one `pnpm prd watch T --wait` running in the background");
      expect(out).toContain("**marking first** (`pnpm prd watch T --mark <n> <mark>`)");
      expect(out).toMatch(/\*\*nudge:\*\* mark `nudged`, then SendMessage .*mark `replied`/);
      expect(out).toMatch(
        /\*\*restart:\*\* mark `restarted`, stop the agent \(TaskStop\), then run `pnpm prd watch T` until that slice reads `stopped`.*only then spawn one background agent with `pnpm prd prompt slice T <n> --continue` in the same worktree/,
      );
      expect(out).toContain("No stop shown means no spawn");
      expect(out).toContain("A slice restarts once");
      expect(out).toContain("`pnpm prd prompt skeptic stall --evidence <file>`");
      expect(out).toContain("`pnpm prd skeptic record --kind stall --slice <n> --verdict restart|leave|ask");
      expect(out).toContain("(`--waits` for a step on the never list: then only ask)");
      expect(out).toContain(
        flags.includes("--auto")
          ? 'on ask, file it naming "slice <n>" (`pnpm prd ask … --skeptic <id>`), then mark `asked --ask <id>`'
          : 'on ask, ask the user about "slice <n>" with AskUserQuestion, then mark `asked`',
      );
      expect(out).toContain("restarts nothing");
    }
  });

  it("--resume restarts the watch after respawning", () => {
    const out = ok("orchestrator", "T", "--resume");
    const respawn = out.indexOf("**Respawn each in-flight slice**");
    expect(
      out.indexOf("Then start the watch again: `pnpm prd watch T --wait` in the background"),
    ).toBeGreaterThan(respawn);
    expect(ok("orchestrator", "T")).not.toContain("start the watch again");
  });

  it("--resume: reconcile _Status_ with git first, respawn with --continue, review handed-off slices", () => {
    const out = ok("orchestrator", "T", "--resume");
    expect(out).toContain(EVERY_STEP);
    expect(out).toContain(RESUME);
    expect(out).toContain("**Git wins over a stale line**, so correct _Status_ first");
    expect(out).toContain(`git -C ${loops}/T-<n> status --short`);
    expect(out).toContain("pnpm log --oneline prd/T..slice/T/<n>");
    expect(out).toContain("pnpm log --merges --oneline dev..prd/T");
    expect(out).toContain("ListAgents");
    expect(out).toContain("`pnpm prd prompt slice T <n> --continue`");
    expect(out).toContain("**A slice handed off but not merged**");
    expect(out).toContain("git diff --stat prd/T...slice/T/<n>");
    expect(out).toContain("**Follow the landing mode _Status_ records**");
    // It carries on rather than starting from the first wave, and asks for a
    // landing mode only when none is recorded.
    expect(out).not.toContain(ASK_FIRST);
    expect(out).not.toContain(RUN_THROUGH);
    expect(out).not.toContain("then start the first ready wave");
    expect(out).toContain("Start by reconciling _Status_ with git");
    expect(out).toContain("If _Status_ records no landing mode, ask the user with AskUserQuestion");
    // The resume block comes after the standing rules.
    expect(out.indexOf(RESUME)).toBeGreaterThan(out.indexOf(EVERY_STEP));
  });

  it("--resume --auto (either order): the resume block plus the run-through text", () => {
    const a = ok("orchestrator", "T", "--resume", "--auto");
    const b = ok("orchestrator", "T", "--auto", "--resume");
    expect(a).toBe(b);
    expect(a).toContain(RESUME);
    expect(a).toContain(RUN_THROUGH);
    expect(a).toContain("land each green wave yourself");
    expect(a).not.toContain(ASK_FIRST);
    expect(a).not.toContain("If _Status_ records no landing mode");
    expect(a.indexOf(RESUME)).toBeLessThan(a.indexOf(RUN_THROUGH));
    expect(a.trimEnd()).toMatch(/Start by reconciling _Status_ with git .*start the next ready wave\.$/);
  });

  it("refuses an unknown flag", () => {
    const r = prompt("orchestrator", "T", "--bogus");
    expect(r.code).toBe(1);
    expect(r.err).toContain("--bogus");
  });
});

describe("slice", () => {
  it("plain: the fields line and no continue text", () => {
    const out = ok("slice", "T", "1");
    expect(out).toContain('You are the agent for slice 1 of the "T" PRD.');
    expect(out).toContain("  - Stack: no\n  - Reads: docs/loops.md\n  - Tests: unit\n");
    expect(out).toContain('Check with `pnpm prd check --quick "slice hand-off"`');
    expect(out).toContain("never a bare `pnpm check`");
    expect(out).not.toContain("`pnpm check` still runs everything");
    expect(out).not.toContain(CONTINUE);
    expect(out).toMatch(/Your orchestrator merges it again\.\n\nSlice 1, from plans\/T-plan\.md/);
    expect(out.trimEnd()).toMatch(/----- end$/);
  });

  it("--continue: the slice prompt with its fields, then the continue text, then the slice's text", () => {
    const plain = ok("slice", "T", "2");
    const out = ok("slice", "T", "2", "--continue");
    const rules = plain.slice(0, plain.indexOf("\nSlice 2, from"));
    expect(out.startsWith(rules)).toBe(true);
    expect(out.indexOf(CONTINUE)).toBeLessThan(out.indexOf("\nSlice 2, from"));
    expect(out.endsWith(plain.slice(rules.length))).toBe(true);
    expect(out).toContain("  - Stack: yes\n  - Reads: none\n  - Tests: e2e:invites\n");
    expect(out).toContain("**You're continuing slice 2, not starting it.**");
    expect(out).toContain("`pnpm log --oneline prd/T..HEAD`, `git status`, `git diff prd/T...HEAD`");
    expect(out).toContain("`git diff` (what isn't)");
    expect(out).toContain("Don't start over, and don't redo committed work.");
    expect(out).toContain(
      "If everything is committed and `pnpm prd check` (or `--quick`) passes, don't rebuild",
    );
    expect(out).toContain("write the hand-off");
  });

  it("embeds its own section and the wave's intro, not another slice's text (a fixes plan)", () => {
    for (const out of [ok("slice", "fixes-w", "4"), ok("slice", "fixes-w", "4", "--continue")]) {
      expect(out).toContain("Your slice's section and what it needs from plans/fixes-w-plan.md");
      expect(out).toContain("there's no plans/fixes-w-prd.md: the plan is the whole spec");
      expect(out).toContain("open the whole plan only for a question they leave");
      expect(out).not.toContain("Then read slice 4 in");
      expect(out).toContain(
        "----- plans/fixes-w-plan.md: Wave 2, its intro\nThe second wave's intro: slice 4 goes first.",
      );
      expect(out).toContain("### Slice 4: A new fix (B-40)");
      expect(out).toContain("New fix text.");
      expect(out).toContain("`pnpm prd doc loop`");
      for (const other of ["first wave's intro", "Old fix text", "Slice 5", "Another fix text", "| Slice |"])
        expect(out).not.toContain(other);
    }
  });

  it("embeds the PRD parts and decision rows it cites, not the uncited ones", () => {
    for (const out of [ok("slice", "V", "1"), ok("slice", "V", "1", "--continue")]) {
      expect(out).toContain("from plans/V-plan.md and plans/V-prd.md are at the end");
      expect(out).toContain("open the whole plan or PRD only for a question they leave");
      expect(out).toContain("----- plans/V-plan.md: _Architectural decisions_\n- **Tooling only:**");
      expect(out).toContain("**Build:** the PRD's _The store_");
      // Cited by its bold lead, and by the slice's backlog item in its Source.
      expect(out).toContain("| **Quiet rule:** stores are quiet | asked | assumed | low |");
      expect(out).toContain("| Briefs are short | budget | item B-9 | low |");
      expect(out).not.toContain("Briefs name no model");
      expect(out).toContain("- **The store** keeps one file per record.");
      expect(out).not.toContain("prints a short text");
      expect(out).toContain("1. As a loop, I want a store");
      expect(out).toContain("2. As a loop, I want it quiet");
      expect(out).not.toContain("I want a brief");
      expect(out).not.toContain("Slice 2: The brief");
    }
    const two = ok("slice", "V", "2");
    expect(two).toContain("- **The brief:** prints a short text.");
    expect(two).not.toContain("keeps one file per record");
    expect(two).not.toContain("Quiet rule");
  });

  it("a slice the plan lacks falls back to reading the files", () => {
    const out = ok("slice", "T", "9");
    expect(out).toContain("Then read plans/T-prd.md and slice 9 in plans/T-plan.md, then the docs");
    expect(out).not.toContain("----- end");
  });

  it("refuses an unknown flag", () => {
    const r = prompt("slice", "T", "1", "--resume");
    expect(r.code).toBe(1);
    expect(r.err).toContain("--resume");
  });
});

describe("sending failures back", () => {
  it("the orchestrator's prompt names the merge check, tier, blame, send-back, late rm and rotation rule", () => {
    const out = ok("orchestrator", "T");
    expect(out).toContain("no local quick check after a merge or dev sync when a CI run follows");
    expect(out).not.toContain('`pnpm prd check --quick "slice <n> merged"`');
    expect(out).toContain("`pnpm prd ci run <tier> --wait` in the background");
    expect(out).toContain(
      "the tier `pnpm prd tier` proposes (it prints the tier and why) unless you have a reason",
    );
    expect(out).toContain("run `pnpm prd ci blame`");
    expect(out).toContain(
      "to the agent whose slice it names (SendMessage), with the failing tests and the run link",
    );
    expect(out).toContain("an agent idle past an hour, gets a fresh fix agent in that slice's worktree");
    expect(out).toContain("run `pnpm prd rm T-<n>` then, not at the merge");
    expect(out).toContain("**No rotation while a wave's run is out or a fix is in flight**");
  });

  it("the slice's prompt names its own tests, the stack release, the wait and the fix steps", () => {
    const out = ok("slice", "T", "1");
    expect(out).toContain("only the integration and component test files you added or edited");
    expect(out).toContain("run `pnpm prd stack down` before your final message");
    expect(out).toContain("then wait");
    expect(out).toContain("**A fix request is these steps and nothing else:**");
    expect(out).toContain('git merge --no-ff -m "chore(T): merge prd/T for a fix" prd/T');
    expect(out).toContain('`pnpm prd check --quick "slice fix"`');
  });
});

describe("waiting on a check", () => {
  it("orchestrator and slice prompts wait with pnpm prd wait check, never pgrep -f", () => {
    for (const out of [ok("orchestrator", "T"), ok("slice", "T", "1")]) {
      expect(out).toContain("`pnpm prd wait check`");
      expect(out).toContain("never `pgrep -f`");
    }
  });
});

describe("plan and backlog", () => {
  it("are unchanged by the resume work", () => {
    const plan = ok("plan", "T", "B-1", "B-2");
    expect(plan).toContain('You are the planning agent for "T".');
    expect(plan).toContain("(B-1 B-2)");
    expect(plan).toContain("**Decide, then report: no interview.**");
    expect(plan).not.toContain("begin the interview");
    expect(plan).not.toContain(RESUME);
    expect(ok("backlog")).toContain("You are the new backlog/inbox planning agent.");
  });

  it("plan reads a former id prefix's ids as the current prefix's", () => {
    const config = JSON.parse(readFileSync(FIXTURE_CONFIG, "utf8"));
    Object.assign(config.backlog, { idPrefix: "RISA", formerIdPrefix: "B", zoneOverflowItem: "RISA-750" });
    const file = join(root, "former-prefix.json");
    writeFileSync(file, JSON.stringify(config));
    const run = (/** @type {string[]} */ ...ids) =>
      spawnSync("bash", [join(main, "scripts/loops/prompt.sh"), "plan", "T", ...ids], {
        cwd: main,
        encoding: "utf8",
        env: { ...process.env, RISA_CONFIG: file },
      });
    const r = run("B-1", "RISA-2");
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("(RISA-1 RISA-2)");
    expect(run("C-1").stderr).toContain("plan takes --auto and RISA-<n> ids, not C-1");
  });

  it("backlog without a dispatcher: as before, it prints start commands for the user", () => {
    const text = ok("backlog", "--guide");
    expect(text).not.toContain(".queue");
    expect(text).toContain("the dispatcher: none is running, so nothing starts a topic unless the user does");
    expect(text).toContain("What to run: start, queue or wait for each ready PRD.");
    expect(text).toContain("- No dispatcher is running. To run a planned one, never run `pnpm prd start`");
    expect(text).toContain("print the commands as options for the user to run themselves");
    expect(text).toContain("(the user runs `! pnpm prd plan <topic> --open [B-n …]` themselves)");
    expect(text).not.toContain("moving and holding rows");
  });

  it("backlog with the dispatcher running: deciding is moving and holding rows, and no start commands", () => {
    const lock = join(loops, ".dispatch.lock");
    mkdirSync(loops, { recursive: true });
    writeFileSync(lock, `${process.pid}\n`);
    try {
      const text = ok("backlog", "--guide");
      expect(text).toContain(`the dispatcher: it is running (pid ${process.pid})`);
      expect(text).toContain(
        "**The dispatcher is running, so deciding what runs next is moving and holding rows**",
      );
      expect(text).toContain("`pnpm backlog prd move <topic> --first|--before <t>|--after <t>`");
      expect(text).toContain(
        "`pnpm backlog prd set <topic> flags+=hold` to keep it back (`flags-=hold` releases it",
      );
      expect(text).not.toContain("flags=hold");
      expect(text).toContain("**Print no start commands**");
      expect(text).toContain("What to run: move up, hold or leave each topic.");
      expect(text).toContain("leave it to the dispatcher (move it first;");
      expect(text).not.toContain("(the user runs `! pnpm prd plan <topic> --open");
      expect(text).not.toContain("No dispatcher is running");
    } finally {
      rmSync(lock);
    }
    // A lock whose pid is gone is no running dispatcher.
    writeFileSync(lock, "999999\n");
    try {
      expect(ok("backlog", "--guide")).toContain("No dispatcher is running");
    } finally {
      rmSync(lock);
    }
  });

  it("plan adds its registry row through pnpm backlog prd and ends with pnpm prd end", () => {
    const plan = ok("plan", "T");
    expect(plan).toContain("`pnpm backlog prd add T`");
    expect(plan).toContain("`pnpm backlog prd set T after=<topic> hot=<path prefixes>`");
    expect(plan.indexOf("`pnpm prd rm plan-T`")).toBeLessThan(plan.indexOf("&& pnpm prd end`"));
    // rm deleted the worktree: end runs from the main checkout
    expect(plan).toMatch(/`cd \S+ && pnpm prd end`/);
    expect(plan.trimEnd()).toMatch(/Start by summarising[^]*$/);
  });

  it("plain plan: one AskUserQuestion round, a plain landing, and the row set when it exists", () => {
    const plan = ok("plan", "T", "B-1");
    expect(plan).toContain("in one AskUserQuestion round of at most four questions");
    expect(plan).not.toContain("pnpm prd ask");
    expect(plan).not.toContain("--force");
    expect(plan).toContain('`pnpm prd land plan/T -m "docs(T): PRD and plan for … (B-<n>, …)"`');
    expect(plan).toMatch(
      /when `pnpm backlog prd list` already has a row for T, set it with `pnpm backlog prd set T/,
    );
    expect(plan).toMatch(/when it has none, add it first with `pnpm backlog prd add T`/);
    expect(plan).toContain("report the decisions you assumed");
  });

  it("both asking paragraphs send a question past a fresh Opus skeptic, then ask or file the decision", () => {
    for (const out of [ok("orchestrator", "T", "--auto"), ok("plan", "T", "--auto", "B-1")]) {
      expect(out).toContain("**A fresh skeptic reads every question first.**");
      expect(out).toContain("`pnpm prd prompt skeptic ask --evidence <file>`");
      expect(out).toContain('`model: "opus"`');
      expect(out).toContain("`pnpm prd skeptic record --kind ask --verdict <decide|ask>");
      expect(out).toContain('--option "<b>" --skeptic <id> --recommend <a> --defaults`');
      expect(out).toContain("`pnpm prd ask --decided --skeptic <id> --topic T");
      expect(out).toContain("with no PushNotification and no wait");
      expect(out).toContain("A `--waits` question is never decided");
      expect(out).toContain("a land `no` or a plan `send-back` already counts");
    }
    // A terminal the user is watching gets no skeptic.
    for (const out of [ok("orchestrator", "T"), ok("plan", "T", "B-1")])
      expect(out).not.toContain("A fresh skeptic reads every question");
  });

  it("both planner prompts cap a slice at about 8 files and one running topic's hot file", () => {
    for (const plan of [ok("plan", "T"), ok("plan", "T", "--auto")])
      expect(plan).toContain(
        "**a slice that would touch more than about 8 files, or more than one running topic's hot file** (`pnpm backlog prd list`), **is split into slices that each land on their own**",
      );
  });

  it("both planner prompts run the skeptic from the plan brief, with send-back and one retry", () => {
    for (const plan of [ok("plan", "T"), ok("plan", "T", "--auto")]) {
      expect(plan).toContain("`pnpm prd prompt skeptic plan --evidence <file>`");
      expect(plan).toContain('`model: "opus"`');
      expect(plan).toContain("`pnpm prd skeptic record --kind plan --verdict go|send-back");
      expect(plan).toContain("run a fresh skeptic **once more** (one retry)");
      expect(plan).toContain("A second **send-back**");
    }
    expect(ok("plan", "T")).toMatch(
      /second \*\*send-back\*\* is the user's: put it to them with AskUserQuestion/,
    );
    const auto = ok("plan", "T", "--auto");
    expect(auto).toContain("`pnpm backlog prd set T flags+=hold`");
    expect(auto).not.toContain("flags=");
    expect(auto).toContain("`--waits` question with `--skeptic <that record's id>`");
    expect(auto.indexOf("flags+=hold")).toBeLessThan(auto.indexOf("`--waits` question with"));
  });

  it("plan --auto: questions and the report through pnpm prd ask with a push, never AskUserQuestion", () => {
    for (const plan of [ok("plan", "T", "--auto", "B-1"), ok("plan", "T", "B-1", "--auto")]) {
      expect(plan).toContain('You are the planning agent for "T".');
      expect(plan).toContain("(B-1)");
      expect(plan).not.toContain("AskUserQuestion");
      expect(plan).not.toContain("--force");
      expect(plan).toContain('`pnpm prd ask --topic T --question "<text>"');
      expect(plan).toContain("PushNotification");
      expect(plan).toContain("`pnpm prd ask --wait <id>` in the background, with no `--timeout`");
      expect(plan).toContain("**Never put your own recommendation in place of an answer:**");
      // A planner's questions default like any other: --defaults with a recommendation, --waits for the never list.
      expect(plan).toContain("--recommend <a> --defaults` (or `--waits`, below)");
      expect(plan).toContain("Pass `--defaults` on it");
      expect(plan).toContain(
        "Pass `--waits` instead for the questions that never default: money (a paid service too), data loss or a change to existing data, a live deploy (staging or production), a destructive step (deleting unmerged work, a forced push), a new dependency (AGENTS.md: the user's approval), and compliance",
      );
      expect(plan).toContain("The tool, never you, puts the recommendation in place of an answer");
      expect(plan).not.toContain("wait for it however long it takes");
      // After the landing: the report, then rm, then end.
      const land = plan.indexOf("`pnpm prd land plan/T -m");
      const report = plan.indexOf('`pnpm prd ask --topic T --report "<text>"`');
      const rm = plan.indexOf("`pnpm prd rm plan-T`");
      expect(land).toBeGreaterThan(0);
      expect(report).toBeGreaterThan(land);
      expect(rm).toBeGreaterThan(report);
      expect(plan.indexOf("&& pnpm prd end`")).toBeGreaterThan(rm);
      expect(plan).toContain("`pnpm backlog prd set T flags+=hold`");
      expect(plan).not.toContain("flags=");
    }
    const r = prompt("plan", "T", "--resume");
    expect(r.code).toBe(1);
    expect(r.err).toContain("--auto");
  });

  it("a fixes orchestrator sets its row's hot files and leaves colliding fixes for later", () => {
    const text = ok("orchestrator", "fixes-ui");
    expect(text).toContain("`pnpm backlog prd set fixes-ui hot=<path prefixes>`");
    expect(text).toContain("Leave for a later wave any fix that would touch a running topic's hot files");
    expect(ok("orchestrator", "T")).not.toContain("hot=<path prefixes>");
  });

  it("backlog has the hand-off paragraph with both modes", () => {
    const text = ok("backlog", "--guide");
    expect(text).toContain('**When the user says "hand off"**');
    expect(text).toContain("**A short brief** (recommended");
    expect(text).toContain("at most about 40 lines");
    expect(text).toContain("**Nothing** (the new session starts blank)");
    expect(text).toContain("`pnpm prd rotate --self --brief-path`");
    expect(text).toContain("`pnpm prd rotate --self --brief <that file>`");
    expect(text).toContain("for nothing, `pnpm prd rotate --self`");
  });

  it("backlog has the request paragraph: a brief, the request, the name, and no tab of its own", () => {
    const text = ok("backlog", "--guide");
    expect(text).toContain("**When the user asks for another backlog session for a task**");
    expect(text).toContain("`pnpm prd session request backlog <name> --brief <file>`");
    expect(text).toContain("`backlog - <name>`");
    expect(text).toContain("Never open a tab yourself");
    expect(text).toContain("`pnpm prd notices`");
  });

  it("backlog reads the open asks and the PRD registry, and leads with what waits on the user", () => {
    const text = ok("backlog", "--guide");
    expect(text).toContain("`pnpm prd asks`");
    expect(text).toContain("`pnpm backlog prd list`");
    expect(text).toContain("what waits on the user");
  });

  it("backlog asks one multi-select question first and loads the guide only after the picks", () => {
    const text = ok("backlog");
    expect(text).toContain("**First, and nothing else:** run `pnpm prd asks --short`");
    expect(text).toMatch(/ask \*\*one\*\* AskUserQuestion, multi-select/);
    expect(text).toContain("**Then collect for the picks only:** run `pnpm prd prompt backlog --guide`");
    expect(text).not.toContain("`pnpm backlog ingest`");
    expect(text).toContain("**Catch up**");
    expect(text).toContain("**Write a PRD**");
    expect(text).toContain("**Decide what to run next**");
    expect(text).toContain("**Triage a new issue or idea**");
    expect(ok("backlog", "--guide")).toContain("Never ask about a task they didn't pick");
  });
});

describe("inbox", () => {
  const b = () => `pnpm -s -C ${main} backlog`;

  it("names the commands it may run, by the main checkout's path", () => {
    const text = ok("inbox");
    expect(text).toMatch(/^You are the inbox agent\./);
    expect(text).toContain("Run only these:");
    expect(text).toContain(`\`${b()} inbox add <type> <text…> [--details "<text>"]\``);
    expect(text).toContain("rerun with `--anyway` only on the user's word");
    expect(text).toContain(`\`${b()} inbox edit <words…> --to "<text>" [--details "<text>"]\``);
    expect(text).toContain(`\`${b()} inbox move <words…> <type>\``);
    expect(text).toContain(`\`${b()} inbox remove <words…>\``);
    expect(text).toContain(`\`${b()} inbox\` lists the lines not filed yet, only when a request needs them`);
    // Its backlog commands are the inbox ones, nothing else.
    expect(
      text
        .split(`${b()} `)
        .slice(1)
        .map((s) => /^[a-z]+/.exec(s)?.[0]),
    ).toEqual(Array(5).fill("inbox"));
  });

  it("only writes unfiled lines on the user's word: no backlog read, no similar step, no extra work", () => {
    const text = ok("inbox");
    expect(text).toContain("On the user's word you add, reword, move or remove lines in their inbox");
    expect(text).toContain("never read the backlog");
    expect(text).toContain("do no extra work");
    expect(text).not.toMatch(/similar|backlog\.md|backlog list|backlog show/);
    expect(text).toContain(
      "Dedupe, ingest, triage, priority, holds, PRDs and asks belong to the backlog session",
    );
  });

  it("says what it must not do: no file, no commit, no ingest, triage, holds or asks", () => {
    const text = ok("inbox");
    expect(text).toContain("Edit no file and commit nothing");
    expect(text).toContain(
      "A filed line (one with an id) is the backlog session's: edit, move and remove refuse it (move prints a `set` line: don't run it)",
    );
    expect(text).not.toContain("pnpm backlog ingest");
    expect(text).not.toContain("pnpm prd");
    // Its prd commands are its own hand-off and its bye.
    expect(text.match(/ prd [a-z-]+/g)).toEqual([" prd rotate", " prd bye"]);
  });

  it("hands off to a fresh inbox session by the main checkout's path, with no brief", () => {
    const text = ok("inbox");
    expect(text).toContain(
      `**Hand off** when the user says so (from the phone too) or a context-watch reminder does: say in one line that a fresh inbox session takes over, run \`pnpm -s -C ${main} prd rotate --self\`, and do nothing after it.`,
    );
    expect(text).not.toContain("--brief");
  });

  it("sends a priority request to the backlog session and writes nothing", () => {
    expect(ok("inbox")).toContain(
      "**Priority:** told what comes first or matters most, change nothing and tell the user to say it in the backlog session.",
    );
  });

  it("reads no doc, opens no poll, lists nothing at the start, and waits", () => {
    const text = ok("inbox");
    expect(text).toContain(
      "read no doc, never read the backlog, ask no opening question, list nothing at the start",
    );
    expect(text).toContain("Wait for what the user says.");
    expect(text).not.toMatch(/AGENTS\.md|docs\/|AskUserQuestion|--guide/);
  });

  it("names items by their plain titles", () => {
    expect(ok("inbox")).toContain("Name an item by its short plain title with the id");
  });

  it("runs with no topic, refuses one, and stays short", () => {
    // Under a fixed size, the main checkout's path (a test's temporary one) counted as one word.
    expect(ok("inbox").replaceAll(main, "<main>").length).toBeLessThan(2000);
    const r = prompt("inbox", "T");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("prompt: inbox takes no topic or options");
  });
});

describe("bye", () => {
  const BYE = "- **A message of just 'bye'** (from the phone too): first the checks";
  const AFTER =
    "then run `pnpm prd bye`. Clean, it ends this session: say nothing after it. Otherwise ask the user about each open thing it lists, one at a time (finish it, hand it off or drop it), then run it again.";

  it.each([
    ["orchestrator", ["orchestrator", "T"], "orchestrator"],
    ["orchestrator --auto", ["orchestrator", "T", "--auto"], "orchestrator"],
    ["orchestrator --resume", ["orchestrator", "T", "--resume"], "orchestrator"],
    ["plan", ["plan", "T"], "planner"],
    ["plan --auto", ["plan", "T", "--auto"], "planner"],
    ["hotfix", ["hotfix", "x", "the fix"], "hotfix"],
    ["backlog", ["backlog"], "backlog"],
    ["recover", ["recover"], "recovery"],
  ])("%s: a message of just 'bye' runs pnpm prd bye after its doc's own checks", (_, args, doc) => {
    const text = ok(...args);
    expect(text).toContain(`${BYE} \`pnpm prd doc ${doc}\` names under _Bye_, ${AFTER}`);
    expect(text.match(/just 'bye'/g)).toHaveLength(1);
  });

  it.each([
    ["slice", ["slice", "T", "1"]],
    ["slice --continue", ["slice", "T", "1", "--continue"]],
  ])("%s: bye only reports, and the open things go to the orchestrator", (_, args) => {
    expect(ok(...args)).toContain(
      "- **A message of just 'bye'**: first the checks `pnpm prd doc loop` names under _Bye_, then run `pnpm prd bye` (a slice only reports; it ends no session). Clean: send your hand-off. Otherwise send your orchestrator the open things it lists and wait for its word on each.",
    );
  });

  it("inbox: its own checks in the prompt, by the main checkout's path", () => {
    const text = ok("inbox");
    expect(text).toContain(
      `- **Just 'bye':** with every idea added, run \`pnpm -s -C ${main} prd bye\` and say nothing after; if it lists open things, ask about each, then rerun it.`,
    );
    expect(text).not.toContain("_Bye_");
  });

  it.each([
    ["orchestrator", ["orchestrator", "T"], "orchestrator"],
    ["plan", ["plan", "T"], "planner"],
    ["hotfix", ["hotfix", "x", "the fix"], "hotfix"],
    ["backlog", ["backlog"], "backlog"],
    ["recover", ["recover"], "recovery"],
  ])("%s: a role the config names no doc for is still the doc command (its generic doc)", (_, args, role) => {
    const config = JSON.parse(readFileSync(FIXTURE_CONFIG, "utf8"));
    delete config.roles;
    const file = join(root, "no-roles.json");
    writeFileSync(file, JSON.stringify(config));
    const r = spawnSync("bash", [join(main, "scripts/loops/prompt.sh"), ...args], {
      cwd: main,
      encoding: "utf8",
      env: { ...process.env, RISA_CONFIG: file },
    });
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain(`${BYE} \`pnpm prd doc ${role}\` names under _Bye_, ${AFTER}`);
  });

  it("the briefs that aren't a role get none", () => {
    expect(ok("tidy")).not.toContain("bye");
  });
});

describe("recover", () => {
  it("is the recovery agent: inventory, ListAgents, carry-on message, the opener, no code changes", () => {
    const text = ok("recover");
    expect(text).toMatch(/^You are the recovery agent\./);
    expect(text).toContain(`You're in the main checkout (${main}), on dev.`);
    expect(text).toContain("**Make no code changes and no commits**");
    expect(text).toContain("`pnpm prd recover --dry-run --json`");
    expect(text).toContain("`open-session` action");
    expect(text).toContain("ListAgents");
    expect(text).toContain("SendMessage");
    expect(text).toMatch(/> The machine recovered .*Reconcile your plan's _Status_ with git.*carry on/);
    expect(text).toContain("`pnpm prd open <target>`");
    expect(text).toContain("never open a session that ListAgents shows as live");
    expect(text).toMatch(/Then report.*Then end/s);
    expect(text).not.toContain(RESUME);
  });

  it("leaves managed sessions to a running dispatcher", () => {
    const text = ok("recover");
    expect(text).toContain("**Managed sessions belong to the dispatcher while it runs.**");
    expect(text).toContain(
      "When the inventory's `dispatcher.running` is true (recover reopened it, or it never stopped), leave every `open-session` marked `managed` to it: never open one",
    );
    expect(text).toContain("With no dispatcher running, treat managed sessions like the rest.");
    expect(text).toContain("or left it to the dispatcher");
  });

  it("takes no topic", () => {
    expect(ok("recover", "ignored")).toMatch(/^You are the recovery agent\./);
  });
});

describe("tidy", () => {
  it("is the cleanup brief: tidy --yes, SendMessage for finished sessions, /loop, never close or delete", () => {
    const text = ok("tidy");
    expect(text).toMatch(/^You are the cleanup agent: .*\(run it on haiku\)/);
    expect(text).toContain(`You're in the main checkout (${main}), on dev.`);
    expect(text).toContain("Run `pnpm prd tidy --yes`.");
    expect(text).toContain("SendMessage");
    expect(text).toContain("`/loop 3h`");
    expect(text).toContain("The dispatcher runs `pnpm prd tidy --yes` every six hours by itself");
    expect(text).toContain("dead lease and slot tickets");
    expect(text).toContain("finished backlog items: dropped ones, and landed ones whose topic has no `prd/`");
    expect(text).not.toContain("archive backlog items");
    expect(text).toContain("**Never close or end a session**");
    expect(text).toContain("**Never delete unmerged work**");
    expect(text).toContain("A report is never pushed: send no PushNotification for it.");
    expect(text).not.toContain(RESUME);
  });
});

describe("hotfix", () => {
  it("is the hotfix agent: its worktree, ask before long steps, background agents, document the pattern", () => {
    const text = ok("hotfix", "trim", "Trim the day summary");
    expect(text).toMatch(/^You are the hotfix agent for "trim"/);
    expect(text).toContain(`Your worktree is ${loops}/hotfix-trim, on branch hotfix/trim (from dev)`);
    expect(text).toContain("**Ask the user before every step that takes time or changes shared state**");
    expect(text).toContain("Background agents are allowed");
    expect(text).toContain("`pnpm prd doc hotfix`");
    expect(text).toContain("into its file, docs/agents/hotfix.md.");
    expect(text).toContain('**"PR or local?"**');
    expect(text).toContain("`pnpm prd land hotfix/trim --pr` or `--local`");
    expect(text).toContain("`pnpm prd pr hotfix/trim`");
    expect(text).toContain("The fix: Trim the day summary");
    expect(text).not.toContain(RESUME);
  });

  it("leaves the fix out when none is given, and needs a name", () => {
    expect(ok("hotfix", "trim")).not.toContain("The fix:");
    expect(prompt("hotfix").code).not.toBe(0);
  });
});

describe("fix categories", () => {
  const TOPICS = ["fixes-ui", "fixes-tooling", "fixes-perf", "fixes-bug", "fixes-nit"];

  it("the backlog and orchestrator prompts name the five topics, never prd=quick-fixes", () => {
    for (const text of [ok("backlog", "--guide"), ok("orchestrator", "T")]) {
      for (const t of TOPICS) expect(text).toContain(`\`${t}\``);
      expect(text).toContain("`prd=fixes-<cat>` (never `quick-fixes`)");
      expect(text).toContain("a tie-break for triage only");
      expect(text).not.toContain("prd=quick-fixes");
    }
  });

  it("a fixes orchestrator is told to append a slice per waiting item, and its plan is the whole spec", () => {
    const text = ok("orchestrator", "fixes-bug");
    expect(text).toContain("append one slice per waiting item");
    expect(text).toContain("plans/fixes-rules.md");
    expect(text).toContain("there's no plans/fixes-bug-prd.md: the plan is the whole spec");
    expect(text).toContain("slice table keeps its header and separator with no slice in flight"); // B-807
    expect(ok("orchestrator", "T")).not.toContain("append one slice per waiting item");
  });
});
