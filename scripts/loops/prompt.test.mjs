// The session prompts (prompt.sh) against a throwaway repo with the scripts
// copied in: the plain prompts, the resume and continue variants, and the
// every-step _Status_ rule. Nothing here starts a session.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
  for (const f of ["prompt.sh", "lib.sh", "slice-fields.mjs"]) {
    copyFileSync(join(HERE, f), join(main, "scripts/loops", f));
  }
  writeFileSync(join(main, "plans/T-plan.md"), PLAN);
  writeFileSync(join(main, "plans/T-prd.md"), "# PRD: T\n");
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
    expect(out).not.toContain("--continue");
    expect(out.trimEnd()).toMatch(/Record the answers in the plan's _Status_ and follow them\..*$/);
  });

  it("carries the PR flow in every variant", () => {
    for (const flags of [[], ["--auto"], ["--resume"], ["--resume", "--auto"]]) {
      const out = ok("orchestrator", "T", ...flags);
      expect(out).toContain("**Code lands through a GitHub PR into dev, reviewed by Codex.**");
      expect(out).toContain("`pnpm prd pr T`");
      expect(out).toContain("`pnpm prd review T --wait` in the background");
      expect(out).toContain("a reply on its thread with the reason");
      expect(out).toContain("resolve fixed and declined threads");
      expect(out).toContain("`review --again` until clean");
      expect(out).toContain("After about three rounds, ask the user");
      expect(out).toContain("`--no-review` only when they say so");
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
    expect(out).toContain("`pnpm prd queue T`");
    expect(out).not.toContain(ASK_FIRST);
    expect(out).not.toContain(RESUME);
    expect(out).toContain("record the landing mode in the plan's _Status_, then start the first ready wave.");
  });

  it("--auto: questions and reports go through pnpm prd ask with a push, never AskUserQuestion", () => {
    for (const flags of [["--auto"], ["--resume", "--auto"]]) {
      const out = ok("orchestrator", "T", ...flags);
      expect(out).toContain("`pnpm prd ask --topic T --question");
      expect(out).toContain("PushNotification tool yourself");
      expect(out).toContain("`pnpm prd ask --wait <id>` in the background");
      expect(out).toContain("`pnpm prd answer <id>");
      expect(out).toContain("`pnpm prd ask --topic T --report");
      expect(out).toContain("Push other reports only when something failed");
      expect(out).not.toContain("AskUserQuestion");
    }
    for (const flags of [[], ["--resume"]]) {
      const out = ok("orchestrator", "T", ...flags);
      expect(out).not.toContain("pnpm prd ask");
      expect(out).toContain("AskUserQuestion");
    }
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
    expect(out.trimEnd()).toMatch(/your orchestrator does that\.$/);
  });

  it("--continue: the slice prompt with its fields, then the continue text", () => {
    const plain = ok("slice", "T", "2");
    const out = ok("slice", "T", "2", "--continue");
    expect(out.startsWith(plain)).toBe(true);
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

  it("refuses an unknown flag", () => {
    const r = prompt("slice", "T", "1", "--resume");
    expect(r.code).toBe(1);
    expect(r.err).toContain("--resume");
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

  it("backlog reads the queue on startup", () => {
    const text = ok("backlog");
    expect(text).toMatch(/and the queue: `ls \S+\/\.queue`/);
    expect(text).toContain("never propose starting or queueing a topic that is already queued");
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

  it("backlog reads the open asks and the PRD registry, and leads with what waits on the user", () => {
    const text = ok("backlog");
    expect(text).toContain("`pnpm prd asks`");
    expect(text).toContain("`pnpm backlog prd list`");
    expect(text).toContain("what waits on the user");
  });

  it("backlog asks one multi-select question first: a PRD, what to run, or a new issue", () => {
    const text = ok("backlog");
    expect(text).toMatch(/ask \*\*one\*\* AskUserQuestion, multi-select, and nothing else/);
    expect(text).toContain("**Write a PRD**");
    expect(text).toContain("**Decide what to run next**");
    expect(text).toContain("**Triage a new issue or idea**");
    expect(text).toContain("Never ask about a task they didn't pick");
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
    expect(text).toContain("**Never close or end a session**");
    expect(text).toContain("**Never delete unmerged work**");
    expect(text).toContain("send that PushNotification");
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
    expect(text).toContain("docs/agents/hotfix.md");
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
    for (const text of [ok("backlog"), ok("orchestrator", "T")]) {
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
    expect(ok("orchestrator", "T")).not.toContain("append one slice per waiting item");
  });
});
