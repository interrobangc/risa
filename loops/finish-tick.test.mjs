// The dispatcher's finish of a landed topic: finish.mjs's pure finishPick, and
// finishStep through dispatch.mjs on a throwaway main checkout with these scripts
// and the backlog tool copied in, a stub claude run under session.sh, fake
// osascript and iTerm2, and the sessions, heartbeat, landing journals and asks in
// the throwaway folder: nothing here touches a real session, the asks queue or GitHub.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureTierData, stubHookConfig } from "./config-fixture.mjs";
import { failedKey, finishPick } from "./finish.mjs";
import { scaledWait } from "./test-limits.mjs";

const act = (topic) => ({ kind: "act", topic, why: "idle", end: [`prd-${topic}`], rm: true });
const report = (topic, key = `${topic}\tcode\ttip`) => ({
  kind: "report",
  topic,
  why: "a code tail",
  reasons: [{ reason: "code", why: "a code tail" }],
  key,
});
const wait = (topic) => ({ kind: "wait", topic, why: "busy", waits: ["busy"] });
const cand = (topic, decision, extra = {}) => ({ topic, tip: "tip", decision, ...extra });

describe("finishPick", () => {
  it("picks the first in row order of two landed topics with leftovers", () => {
    expect(finishPick([cand("a", act("a")), cand("b", act("b"))])?.topic).toBe("a");
  });

  it("skips a clean one", () => {
    const clean = { kind: "clean", topic: "a", why: "landed, and nothing is left" };
    expect(finishPick([cand("a", clean), cand("b", act("b"))])?.topic).toBe("b");
  });

  it("picks a code-tail topic once, then passes over it once its report is filed", () => {
    const d = report("a");
    expect(finishPick([cand("a", d)])?.topic).toBe("a");
    expect(finishPick([cand("a", d)], { reported: [d.key] })).toBeNull();
    // finishDecision's own null for a filed key: passed over too.
    expect(finishPick([cand("a", null), cand("b", act("b"))])?.topic).toBe("b");
  });

  it("passes over a first that waits for a second that acts", () => {
    expect(finishPick([cand("a", wait("a")), cand("b", act("b"))])?.topic).toBe("b");
  });

  it("never takes a standing topic", () => {
    expect(finishPick([cand("a", act("a"), { standing: true })])).toBeNull();
  });

  it("passes over an act that failed at this tip", () => {
    expect(finishPick([cand("a", act("a"))], { reported: [failedKey("a", "tip")] })).toBeNull();
    expect(
      finishPick([cand("a", act("a"), { tip: "new" })], { reported: [failedKey("a", "tip")] })?.topic,
    ).toBe("a");
  });

  it("picks none while paused or draining", () => {
    expect(finishPick([cand("a", act("a"))], { paused: true })).toBeNull();
    expect(finishPick([cand("a", act("a"))], { draining: true })).toBeNull();
  });
});

// The stub claude: says it's ready, records a TERM (its end) and exits on it.
const STUB = `#!/usr/bin/env bash
trap 'touch "$STUB_STATE/term-$STUB_NAME"; exit 143' TERM
touch "$STUB_STATE/ready-$STUB_NAME"
for i in $(seq 1200); do sleep 0.1; done
`;
const PLAN = `# Plan: T

## Status

| Slice | Wave | State | Merge |
| ----- | ---- | ----- | ----- |
| 1 | 1 | merged | abc |
`;
const TOPICS = ["doc", "code"];
const REGISTRY = `# Backlog tracker

Intro.

## PRDs

The registry.

| PRD | Flags | After | Hot files | Doc and notes |
| --- | ----- | ----- | --------- | ------------- |
${TOPICS.map((t) => `| \`${t}\` | — | — | — | landed |`).join("\n")}

## Items
`;

const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
const HERE = new URL(".", import.meta.url).pathname;
let root, main, loops, sessions, asks, state, env;
/** @type {{ child: import("node:child_process").ChildProcess, pid: number }[]} */
const started = [];
const dispatch = (args, extra = {}) =>
  spawnSync(process.execPath, [join(main, "loops/dispatch.mjs"), ...args], {
    cwd: main,
    encoding: "utf8",
    env: { ...env, ...extra },
  });
const filedFor = (topic) =>
  existsSync(asks)
    ? readdirSync(asks)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(asks, f), "utf8")))
        .filter((a) => a.topic === topic)
    : [];
const dstate = () => JSON.parse(readFileSync(join(loops, ".dispatch.json"), "utf8"));
const until = async (what, ms = 10_000) => {
  const end = Date.now() + scaledWait(ms);
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};

/** prd/<t> landed in dev, then TAIL committed on it, checked out at .loops/<t> with a slot. */
function landedTopic(topic, tail) {
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
  const slot = join(loops, ".slots", String(TOPICS.indexOf(topic) + 1));
  mkdirSync(slot, { recursive: true });
  writeFileSync(join(slot, "name"), `${topic}\n`);
  return dir;
}

/** A recorded session prd-<t> (the stub under session.sh) in its worktree, idle 20 minutes by its heartbeat. */
async function idleSession(topic) {
  const child = spawn("bash", [join(main, "loops/session.sh"), `prd-${topic}`, "--", "x"], {
    cwd: join(loops, topic),
    env: { ...env, STUB_NAME: `prd-${topic}` },
    stdio: "ignore",
  });
  await until(() => existsSync(join(state, `ready-prd-${topic}`)));
  const pid = JSON.parse(readFileSync(join(sessions, `prd-${topic}.json`), "utf8")).pid;
  started.push({ child, pid });
  const at = new Date(Date.now() - 20 * 60_000).toISOString();
  const hb = join(loops, ".heartbeat", `prd-${topic}`);
  mkdirSync(hb, { recursive: true });
  writeFileSync(
    join(hb, "session.json"),
    JSON.stringify({
      session: `prd-${topic}`,
      pid,
      agent: null,
      firstAt: at,
      lastStart: at,
      lastEnd: at,
      stoppedAt: at,
      running: {},
    }),
  );
  return pid;
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "finish-tick-test-")));
  main = join(root, "repo");
  loops = join(main, ".loops");
  sessions = join(loops, ".sessions");
  asks = join(root, "asks");
  state = join(root, "state");
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(state);
  mkdirSync(join(root, "iTerm.app"));
  writeFileSync(join(bin, "claude-stub"), STUB);
  writeFileSync(join(bin, "osascript"), "#!/usr/bin/env bash\n");
  for (const f of ["claude-stub", "osascript"]) chmodSync(join(bin, f), 0o755);

  execFileSync("git", ["init", "-q", "-b", "dev", main]);
  for (const [k, v] of [
    ["user.email", "test@example.com"],
    ["user.name", "Test"],
    ["commit.gpgsign", "false"],
  ])
    git(main, "config", k, v);
  mkdirSync(join(main, "loops"), { recursive: true });
  mkdirSync(join(main, "backlog"), { recursive: true });
  for (const f of readdirSync(HERE).filter((f) => /\.(mjs|sh)$/.test(f) && !f.includes(".test.")))
    copyFileSync(join(HERE, f), join(main, "loops", f));
  cpSync(join(HERE, "prompts"), join(main, "loops", "prompts"), { recursive: true });
  const backlogDir = join(HERE, "../backlog");
  for (const f of readdirSync(backlogDir).filter((f) => f.endsWith(".mjs") && !f.includes(".test.")))
    copyFileSync(join(backlogDir, f), join(main, "backlog", f));
  mkdirSync(join(main, "ci"), { recursive: true });
  for (const f of ["outstanding.mjs", "tier-data.mjs"])
    copyFileSync(join(HERE, "../ci", f), join(main, "ci", f));
  fixtureTierData(main);
  writeFileSync(join(main, ".gitignore"), ".loops/\n");
  mkdirSync(join(main, "plans"));
  writeFileSync(join(main, "plans/backlog.md"), REGISTRY);
  for (const t of TOPICS) writeFileSync(join(main, `plans/${t}-plan.md`), PLAN);
  writeFileSync(join(root, "load"), "1 1 1");
  writeFileSync(join(root, "processes"), "");
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TRUNK: "dev",
    RISA_MAIN: main,
    RISA_CONFIG: stubHookConfig(main),
    RISA_CLAUDE_BIN: join(bin, "claude-stub"),
    RISA_ITERM_APP: join(root, "iTerm.app"),
    RISA_SESSIONS_DIR: sessions,
    RISA_LANDING_DIR: join(root, "landing"),
    RISA_ASKS_DIR: asks,
    RISA_ASK_NOTIFY: "",
    RISA_REQUESTS_DIR: join(root, "requests"),
    RISA_NOTICES_DIR: join(root, "notices"),
    RISA_WATCH_DIR: join(root, "watch"),
    RISA_END_WAIT: "3",
    RISA_SESSION: "",
    RISA_LOAD_FILE: join(root, "load"),
    RISA_LOAD_BUSY: "8",
    RISA_LOAD_GATE: "",
    RISA_MAX_PRDS: "",
    RISA_CLOCK_FILE: "",
    RISA_FINISH_IDLE_MIN: "",
    RISA_KEEP_SESSIONS: "off",
    RISA_PROCESS_FILE: join(root, "processes"),
    RISA_USAGE_WATCH: "off",
    RISA_USAGE_DIR: join(root, "usage"),
    RISA_PICKUP_EVERY: "off",
    RISA_STUCK_WATCH: "off",
    RISA_INBOX_DIR: join(root, "home/.risa/inbox"),
    RISA_CLAUDE_PROJECTS: join(root, "projects"),
    RISA_CLAUDE_CONFIG: join(root, "claude.json"),
    RISA_MACHINE_CONFIG: join(root, "machine.json"),
    BACKLOG_BY: "",
    STUB_STATE: state,
    SAMPLE_STACK_STATE: join(root, "stack-state"),
  };
  mkdirSync(env.SAMPLE_STACK_STATE);
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "chore: init");

  landedTopic("doc", { "docs/notes.md": "# Notes\n" });
  await idleSession("doc");
}, scaledWait(60_000));

afterAll(() => {
  for (const { child, pid } of started) {
    try {
      process.kill(pid, "KILL");
    } catch {
      /* gone */
    }
    child.kill("SIGKILL");
  }
  rmSync(root, { recursive: true, force: true });
});

describe("finishStep (dispatch.mjs)", () => {
  it("--dry-run prints one `finish: would end …, rm …` line and changes nothing", () => {
    const r = dispatch(["--dry-run"]);
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l.startsWith("finish: would"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^finish: would end prd-doc, rm doc \(/);
    expect(existsSync(join(loops, "doc"))).toBe(true);
    expect(existsSync(join(state, "term-prd-doc"))).toBe(false);
    expect(filedFor("doc")).toEqual([]);
  });

  it("files one report for a topic landed with a code commit past it on the first tick, none on the second, and keeps its worktree", () => {
    landedTopic("code", { "tail.mjs": "export {};\n" });
    // prd-doc stays busy for this test, so the tick's one topic is code.
    const busy = { RISA_FINISH_IDLE_MIN: "1000" };
    const first = dispatch(["--once"], busy);
    expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
    expect(first.stdout).toMatch(/finish: .*finish code: kept it, nothing ended/);
    expect(filedFor("code")).toHaveLength(1);
    expect(JSON.stringify(filedFor("code")[0])).toMatch(/aren't Markdown only/);
    const keys = dstate().finish.reported;
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^code\tcode\t[0-9a-f]{40}$/);

    const second = dispatch(["--once"], busy);
    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    expect(second.stdout).not.toMatch(/finish: /);
    expect(filedFor("code")).toHaveLength(1);
    expect(dstate().finish.reported).toEqual(keys);
    expect(existsSync(join(loops, "code"))).toBe(true);
    expect(git(main, "branch", "--list", "prd/code")).not.toBe("");
    // prd-doc was never ended.
    expect(existsSync(join(state, "term-prd-doc"))).toBe(false);
  });
});
