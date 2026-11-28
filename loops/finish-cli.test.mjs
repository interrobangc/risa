// pnpm prd finish (finish.mjs) against a throwaway repo and .loops with these
// scripts and the backlog tool copied in, the stack hooks on the sample
// project's stub, a stub claude run under session.sh, fake osascript, and the
// sessions, heartbeat, landing journals and asks in the throwaway .loops: nothing
// here touches a real session, the asks queue or GitHub.
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
import { scaledWait } from "./test-limits.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();

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

const TOPICS = ["doc", "code", "dirty"];
const REGISTRY = `# Backlog tracker

Intro.

## PRDs

The registry.

| PRD | Flags | After | Hot files | Doc and notes |
| --- | ----- | ----- | --------- | ------------- |
${TOPICS.map((t) => `| \`${t}\` | — | — | — | landed |`).join("\n")}

## Items
`;

let root, main, loops, sessions, asks, state, env, dispatchEnv;
/** @type {{ child: import("node:child_process").ChildProcess, pid: number }[]} */
const started = [];
const finish = (args) =>
  spawnSync(process.execPath, [join(main, "loops/finish.mjs"), ...args], {
    cwd: main,
    encoding: "utf8",
    env,
  });
const dispatch = (args) =>
  spawnSync(process.execPath, [join(main, "loops/dispatch.mjs"), ...args], {
    cwd: main,
    encoding: "utf8",
    env: dispatchEnv,
  });
const reportedKeys = () => {
  try {
    return JSON.parse(readFileSync(join(loops, ".dispatch.json"), "utf8")).finish?.reported ?? [];
  } catch {
    return [];
  }
};
const filed = () =>
  existsSync(asks)
    ? readdirSync(asks)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(asks, f), "utf8")))
    : [];
const filedFor = (topic) => filed().filter((a) => a.topic === topic);
const flagsOf = (topic) =>
  JSON.parse(
    execFileSync(process.execPath, [join(main, "backlog/backlog.mjs"), "prd", "list", "--json"], {
      cwd: main,
      encoding: "utf8",
      env,
    }),
  ).find((r) => r.topic === topic).flags;
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
  root = realpathSync(mkdtempSync(join(tmpdir(), "finish-test-")));
  main = join(root, "repo");
  loops = join(main, ".loops");
  sessions = join(loops, ".sessions");
  asks = join(root, "asks");
  state = join(root, "state");
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(state);
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
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TRUNK: "dev",
    RISA_MAIN: main,
    RISA_CONFIG: stubHookConfig(main),
    RISA_CLAUDE_BIN: join(bin, "claude-stub"),
    RISA_SESSIONS_DIR: sessions,
    RISA_LANDING_DIR: join(root, "landing"),
    RISA_ASKS_DIR: asks,
    RISA_ASK_NOTIFY: "",
    RISA_END_WAIT: "3",
    RISA_SESSION: "",
    BACKLOG_BY: "",
    STUB_STATE: state,
    SAMPLE_STACK_STATE: join(root, "stack-state"),
  };
  mkdirSync(env.SAMPLE_STACK_STATE);
  mkdirSync(join(root, "iTerm.app"));
  writeFileSync(join(root, "load"), "1 1 1");
  writeFileSync(join(root, "processes"), "");
  // The dispatcher's tick, hermetic: no load gate, keep-alive, usage or pickup.
  dispatchEnv = {
    ...env,
    RISA_ITERM_APP: join(root, "iTerm.app"),
    RISA_REQUESTS_DIR: join(root, "requests"),
    RISA_NOTICES_DIR: join(root, "notices"),
    RISA_WATCH_DIR: join(root, "watch"),
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
  };
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "chore: init");

  landedTopic("doc", { "docs/notes.md": "# Notes\n" });
  landedTopic("code", { "tail.mjs": "export {};\n" });
  landedTopic("dirty", { "docs/more.md": "# More\n" });
  writeFileSync(join(loops, "dirty", "wip.txt"), "not committed\n");
  for (const t of TOPICS) await idleSession(t);
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

describe("prd finish", () => {
  it("--dry-run prints the decision and changes nothing", () => {
    const r = finish(["doc", "--dry-run"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^finish doc: act: /);
    expect(r.stdout).toContain("end: prd-doc");
    expect(existsSync(join(loops, "doc"))).toBe(true);
    expect(existsSync(join(state, "term-prd-doc"))).toBe(false);
    expect(filed()).toEqual([]);
    const j = JSON.parse(finish(["doc", "--dry-run", "--json"]).stdout);
    expect(j.decision).toMatchObject({ kind: "act", end: ["prd-doc"], rm: true });
  });

  it("ends an idle session of a topic landed with a docs tail, removes its worktree and slot, marks it done, files one report", () => {
    const r = finish(["doc"]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(existsSync(join(state, "term-prd-doc"))).toBe(true);
    expect(existsSync(join(loops, "doc"))).toBe(false);
    expect(existsSync(join(loops, ".slots", "1"))).toBe(false);
    expect(flagsOf("doc")).toEqual(["done"]);
    expect(git(main, "branch", "--list", "prd/doc")).toBe("");
    const reports = filedFor("doc");
    expect(reports).toHaveLength(1);
    expect(JSON.stringify(reports[0])).toMatch(/ended prd-doc; removed doc/);
    expect(JSON.stringify(reports[0])).toContain("Marked doc done in the PRD registry");
  });

  it.each([
    ["code", "a code commit past the landing", /aren't Markdown only/],
    ["dirty", "an uncommitted file", /uncommitted changes/],
  ])("keeps %s (%s): ends nothing, keeps worktree and branch, files one report naming why", (t, _, why) => {
    const r = finish([t]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(why);
    expect(existsSync(join(state, `term-prd-${t}`))).toBe(false);
    expect(existsSync(join(loops, t))).toBe(true);
    expect(git(main, "branch", "--list", `prd/${t}`)).not.toBe("");
    expect(flagsOf(t)).toEqual([]);
    const reports = filedFor(t);
    expect(reports).toHaveLength(1);
    expect(JSON.stringify(reports[0])).toMatch(why);
  });

  it("reports an unchanged code tail once however often it runs, again at a new tip, and a dispatcher tick on the same tip files none", () => {
    const tip = () => git(main, "rev-parse", "prd/code");
    expect(reportedKeys()).toContain(`code\tcode\t${tip()}`);
    const again = finish(["code"]);
    expect(again.status, `${again.stdout}\n${again.stderr}`).toBe(0);
    expect(again.stdout).toMatch(/reported already/);
    expect(filedFor("code")).toHaveLength(1);

    const dir = join(loops, "code");
    writeFileSync(join(dir, "more.mjs"), "export {};\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "feat(code): more");
    const moved = finish(["code"]);
    expect(moved.status, `${moved.stdout}\n${moved.stderr}`).toBe(0);
    expect(moved.stdout).toMatch(/aren't Markdown only/);
    expect(filedFor("code")).toHaveLength(2);
    expect(reportedKeys()).toContain(`code\tcode\t${tip()}`);

    // The dispatcher reads the same keys: code's and dirty's reports aren't filed again.
    const tick = dispatch(["--once"]);
    expect(tick.status, `${tick.stdout}\n${tick.stderr}`).toBe(0);
    expect(tick.stdout).not.toMatch(/finish: /);
    expect(filedFor("code")).toHaveLength(2);
    expect(filedFor("dirty")).toHaveLength(1);
  });
});
