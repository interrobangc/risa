// The dispatcher (`pnpm prd dispatch`: dispatch.mjs) against a throwaway repo
// with the dispatcher and its modules copied in, and stubs for the rest: the
// worktree command (new.sh), the opener (open-session.sh), tidy (tidy-cli.mjs)
// and the backlog command (backlog.mjs, its registry rows a JSON file), a stub
// claude (RISA_CLAUDE_BIN), osascript, a load file and a clock file.
// Nothing here starts a real claude, opens a tab or reads the real load.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAsk, getAsk } from "./asks.mjs";
import { ROTATING_GRACE_MS } from "./dispatch-pick.mjs";
import {
  HELPER_SESSION,
  PICKUP_EVERY_S,
  REOPEN_RESET_MS,
  TAKEOVER_STALE_MS,
  TIDY_EVERY_MS,
  answerAction,
  codeHash,
  helperLine,
  lockHolder,
  pickupDue,
  pickupEvery,
  runLoop,
  sessionLine,
  staleCode,
  takeLock,
  tidyDue,
} from "./dispatch.mjs";
import {
  STUCK_OPTIONS,
  STUCK_SESSION,
  busyUnder,
  onlyWaits,
  stuckAnswer,
  stuckClock,
  stuckDecision,
  stuckSettings,
} from "./dispatch-stuck.mjs";
import { createRequest } from "./session-requests.mjs";
import "./config-fixture.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();

describe("the pure parts", () => {
  it("reads a reopen ask's answer", () => {
    expect(answerAction("reopen again")).toBe("reset");
    expect(answerAction("1")).toBe("reset");
    expect(answerAction("Reopen it")).toBe("reset");
    expect(answerAction("hold the topic")).toBe("hold");
    expect(answerAction("hold")).toBe("hold");
    expect(answerAction("2")).toBe("hold");
    expect(answerAction("no idea")).toBeNull();
    expect(answerAction(null)).toBeNull();
  });

  it("tidies only on an idle, unpaused tick six hours after the last", () => {
    const idle = { action: "none", paused: false };
    expect(tidyDue({ lastTidy: 0 }, TIDY_EVERY_MS, idle)).toBe(true);
    expect(tidyDue({ lastTidy: 0 }, TIDY_EVERY_MS - 1, idle)).toBe(false);
    expect(tidyDue({ lastTidy: 0 }, TIDY_EVERY_MS, { action: "start", paused: false })).toBe(false);
    expect(tidyDue({ lastTidy: 0 }, TIDY_EVERY_MS, { action: "none", paused: true })).toBe(false);
    expect(tidyDue({}, TIDY_EVERY_MS, idle)).toBe(false);
  });

  it("picks up once a period, never paused or off; RISA_PICKUP_EVERY sets the period", () => {
    const every = pickupEvery(undefined);
    expect(every).toBe(PICKUP_EVERY_S * 1000);
    expect(pickupEvery("60")).toBe(60_000);
    expect(pickupEvery("nope")).toBe(every);
    expect(pickupEvery("off")).toBeNull();
    expect(pickupDue({}, 0, { paused: false, everyMs: every })).toBe(true);
    expect(pickupDue({ lastPickup: 0 }, every - 1, { paused: false, everyMs: every })).toBe(false);
    expect(pickupDue({ lastPickup: 0 }, every, { paused: false, everyMs: every })).toBe(true);
    expect(pickupDue({}, 0, { paused: true, everyMs: every })).toBe(false);
    expect(pickupDue({}, 0, { paused: false, everyMs: null })).toBe(false);
  });

  it("builds the run-through, managed session lines, with no item ids", () => {
    expect(sessionLine({ kind: "plan", topic: "t", dir: "/l/plan-t", wrapper: "/b/session.sh" })).toBe(
      `cd /l/plan-t && /b/session.sh plan-t --auto --managed -- --model opus --remote-control plan-t "$(scripts/loops/prompt.sh plan t --auto)"`,
    );
    expect(sessionLine({ kind: "prd", topic: "t", dir: "/l/t", wrapper: "/b/session.sh" })).toBe(
      `cd /l/t && /b/session.sh prd-t --auto --managed -- --remote-control prd-t "$(scripts/loops/prompt.sh orchestrator t --auto)"`,
    );
    const h = helperLine({ main: "/m", claude: "claude", line: "a: it's dead" });
    expect(h).toMatch(/^cd \/m && claude --model haiku --remote-control dispatch-push '/);
    expect(h).toContain("PushNotification");
    expect(h).toContain("pnpm prd end");
  });
});

describe("the code check between ticks (B-809)", () => {
  const STOP = new Error("stop");
  /** Runs the loop with a fake sleep that ends it after TICKS ticks; CODES are the main checkout's hashes. */
  const drive = async (/** @type {(string | null)[]} */ codes, ticks = 3) => {
    let steps = 0;
    let checks = 0;
    const end = runLoop({
      every: 60,
      started: "aaa",
      current: () => codes[Math.min(checks++, codes.length - 1)],
      step: () => void steps++,
      sleep: async () => {
        if (steps >= ticks) throw STOP;
      },
    }).catch((e) => (e === STOP ? "ran on" : Promise.reject(e)));
    return { end: await end, steps, checks };
  };

  it("a changed hash ends the loop between ticks, before the next tick", async () => {
    expect(await drive(["aaa", "bbb"])).toEqual({
      end: { stale: true, from: "aaa", to: "bbb" },
      steps: 2,
      checks: 2,
    });
  });

  it("an unchanged or unreadable hash keeps ticking", async () => {
    expect(await drive(["aaa"])).toEqual({ end: "ran on", steps: 3, checks: 2 });
    expect(await drive([null])).toEqual({ end: "ran on", steps: 3, checks: 2 });
    expect(staleCode(null, "bbb")).toBe(false);
    expect(staleCode("aaa", "aaa")).toBe(false);
    expect(staleCode("aaa", "bbb")).toBe(true);
  });

  it("--once ticks once and never checks", async () => {
    let checks = 0;
    let steps = 0;
    const end = await runLoop({
      every: 60,
      once: true,
      started: "aaa",
      current: () => (checks++, "bbb"),
      step: () => void steps++,
    });
    expect({ end, steps, checks }).toEqual({ end: { stale: false }, steps: 1, checks: 0 });
  });

  it("hashes the non-test .mjs files of scripts/loops and scripts/backlog", () => {
    const r = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-code-")));
    try {
      expect(codeHash(r)).toBeNull();
      for (const d of ["scripts/loops", "scripts/backlog"]) mkdirSync(join(r, d), { recursive: true });
      writeFileSync(join(r, "scripts/loops/a.mjs"), "1");
      writeFileSync(join(r, "scripts/backlog/b.mjs"), "2");
      const h = codeHash(r);
      expect(h).toMatch(/^[0-9a-f]{12}$/);
      for (const f of ["a.test.mjs", "land-fixture.mjs", "notes.md", "x.sh"])
        writeFileSync(join(r, "scripts/loops", f), "3");
      expect(codeHash(r)).toBe(h);
      writeFileSync(join(r, "scripts/backlog/b.mjs"), "22");
      expect(codeHash(r)).not.toBe(h);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});

// The stubs. Each records its arguments, one call per line, in $STUB_STATE.
const NEW_SH = `#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/new.calls"
[[ -z \${STUB_NEW_FAIL:-} ]] || { echo "no room" >&2; exit 1; }
if [[ -n \${STUB_NEW_MAKE:-} ]]; then
  if [[ $1 == plan ]]; then name=plan-$2; else name=$2; fi
  git worktree add -q -b "$1/$2" ".loops/$name" dev
fi
[[ -z \${STUB_NEW_FAIL_AFTER:-} ]] || { echo "migrate failed" >&2; exit 1; }
echo "made $2"
`;
// rm.sh: removes the worktree and its session record, as the real one does.
const RM_SH = `#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/rm.calls"
if [[ $1 == plan-* ]]; then session=$1; else session=prd-$1; fi
git worktree remove --force ".loops/$1"
rm -f ".loops/.sessions/$session.json"
echo "removed $1"
`;
const OPEN_SH = `#!/usr/bin/env bash
printf '%s\\x1f' "$@" >> "$STUB_STATE/open.calls"; echo >> "$STUB_STATE/open.calls"
if [[ -n \${STUB_OPEN_FAIL:-} && " $* " == *" $STUB_OPEN_FAIL "* ]]; then echo "no tab" >&2; exit 1; fi
echo "Opened in a new background iTerm2 tab."
`;
const TIDY = `import { appendFileSync } from "node:fs";
appendFileSync(process.env.STUB_STATE + "/tidy.calls", process.argv.slice(2).join(" ") + "\\n");
console.log("removed 0 safe ones");
`;
// The backlog: prd list --json prints the rows file; prd set writes flags into it.
const BACKLOG = `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const file = process.env.STUB_ROWS;
const [a, b, topic, ...kv] = process.argv.slice(2);
if (a === "prd" && b === "list") console.log(readFileSync(file, "utf8"));
else if (a === "prd" && b === "set") {
  appendFileSync(process.env.STUB_STATE + "/backlog.calls", ["prd set", topic, ...kv].join(" ") + "\\n");
  if (process.env.STUB_BACKLOG_FAIL) {
    console.error("registry locked");
    process.exit(1);
  }
  const rows = JSON.parse(readFileSync(file, "utf8"));
  const row = rows.find((r) => r.topic === topic);
  for (const w of kv) {
    if (w.startsWith("flags=")) row.flags = w.slice(6).split(",").filter(Boolean);
    if (w.startsWith("flags+=")) row.flags = [...new Set([...(row.flags ?? []), ...w.slice(7).split(",")])];
  }
  writeFileSync(file, JSON.stringify(rows));
} else process.exit(2);
`;

// The pickup: `prd.sh dev-sync <why>`, recorded; STUB_PICKUP says how it ends.
const PRD_SH = `#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/prd.calls"
case \${STUB_PICKUP:-same} in
  same) echo "dev-sync: dev already has origin/dev" ;;
  moved) echo "dev-sync: fast-forwarded dev to abc1234" ;;
  refused) echo "dev-sync: the main checkout is in the middle of a merge, rebase or cherry-pick (MERGE_HEAD)" >&2; exit 1 ;;
esac
`;

let root, main, loops, sessions, asks, state, env, clock, rowsFile, inboxDir, claudeConfig;
const scripts = (f) => join(main, "scripts/loops", f);
const calls = (f) => {
  const p = join(state, `${f}.calls`);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
};
const openCalls = () => calls("open").map((l) => l.split("\x1f").filter(Boolean));
const dispatch = (args = ["--once"], extra = {}) =>
  spawnSync("node", [scripts("dispatch.mjs"), ...args], {
    cwd: main,
    encoding: "utf8",
    env: { ...env, ...extra },
  });
const ok = (args, extra) => {
  const r = dispatch(args, extra);
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  return r.stdout;
};
const dstate = () => JSON.parse(readFileSync(join(loops, ".dispatch.json"), "utf8"));
const logText = () => readFileSync(join(loops, ".dispatch.log"), "utf8");
const setRows = (rows) =>
  writeFileSync(
    rowsFile,
    JSON.stringify(rows.map((r) => ({ flags: [], after: [], hot: [], waiting: 0, notes: "", ...r }))),
  );
const setClock = (secs) => writeFileSync(clock, String(secs));
const T0 = 1_800_000_000;
/** A managed record whose pid is long gone: a dead session. */
const deadRecord = (name, extra = {}) => {
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    join(sessions, `${name}.json`),
    JSON.stringify({
      pid: 999_999,
      started: "2026-01-01T00:00:00Z",
      ended: "2026-01-01T01:00:00Z",
      managed: true,
      ...extra,
    }),
  );
};
const worktree = (name, branch) => {
  if (!existsSync(join(loops, name)))
    git(main, "worktree", "add", "-q", "-b", branch, join(loops, name), "dev");
};
const answer = (id, text) =>
  execFileSync("node", [scripts("ask.mjs"), "answer", id, text], {
    env: { ...env, RISA_ASKS_DIR: asks },
    encoding: "utf8",
  });
const askFile = (id) => JSON.parse(readFileSync(join(asks, `${id}.json`), "utf8"));
const until = async (what, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-test-")));
  main = join(root, "repo");
  loops = join(main, ".loops");
  sessions = join(loops, ".sessions");
  asks = join(loops, ".asks");
  state = join(root, "state");
  clock = join(root, "clock");
  rowsFile = join(root, "rows.json");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude-stub"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(bin, "osascript"), "#!/bin/sh\nexit 0\n");
  for (const f of ["claude-stub", "osascript"]) chmodSync(join(bin, f), 0o755);
  mkdirSync(join(root, "iTerm.app"));
  execFileSync("git", ["init", "-q", "-b", "dev", main]);
  for (const [k, v] of [
    ["user.email", "test@example.com"],
    ["user.name", "Test"],
    ["commit.gpgsign", "false"],
  ])
    git(main, "config", k, v);
  mkdirSync(join(main, "scripts/loops"), { recursive: true });
  mkdirSync(join(main, "scripts/backlog"), { recursive: true });
  for (const f of [
    "dispatch.mjs",
    "dispatch-pick.mjs",
    "dispatch-context.mjs",
    "dispatch-stuck.mjs",
    "context.mjs",
    "heartbeat.mjs",
    "keep-alive.mjs",
    "session-requests.mjs",
    "notices.mjs",
    "asks.mjs",
    "ask.mjs",
    "skeptics.mjs",
    "doc.mjs",
    "sessions.mjs",
    "captain.mjs",
    "load-gate.mjs",
    "rotate.mjs",
    "open-session.mjs",
    "host.mjs",
    "planner-model.mjs",
    "config.mjs",
    "machine.mjs",
    "drain.mjs",
    "usage.mjs",
    "land-journal.mjs",
    "landed.mjs",
    "resume.mjs",
  ])
    copyFileSync(join(HERE, f), scripts(f));
  writeFileSync(scripts("new.sh"), NEW_SH);
  writeFileSync(scripts("open-session.sh"), OPEN_SH);
  writeFileSync(scripts("rm.sh"), RM_SH);
  writeFileSync(scripts("tidy-cli.mjs"), TIDY);
  writeFileSync(scripts("prd.sh"), PRD_SH);
  writeFileSync(join(main, "scripts/backlog/backlog.mjs"), BACKLOG);
  for (const f of ["registry.mjs", "format.mjs"])
    copyFileSync(join(HERE, "../backlog", f), join(main, "scripts/backlog", f));
  writeFileSync(join(main, ".gitignore"), ".loops/\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "chore: init");
  writeFileSync(join(root, "load"), "1 1 1");
  inboxDir = join(root, "home/.caretook/inbox");
  claudeConfig = join(root, "claude.json");
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    RISA_CLAUDE_BIN: join(bin, "claude-stub"),
    RISA_ITERM_APP: join(root, "iTerm.app"),
    RISA_SESSIONS_DIR: "",
    RISA_ASKS_DIR: "",
    RISA_ASK_NOTIFY: "",
    RISA_REQUESTS_DIR: "",
    RISA_NOTICES_DIR: "",
    RISA_MAX_BACKLOG_SESSIONS: "",
    RISA_LOAD_FILE: join(root, "load"),
    RISA_LOAD_BUSY: "8",
    RISA_LOAD_GATE: "",
    RISA_MAX_PRDS: "",
    RISA_MAX_PLANNERS: "",
    RISA_FIXES_MIN: "",
    RISA_CLOCK_FILE: clock,
    // Off unless a test turns it on, and never the machine's real processes.
    RISA_KEEP_SESSIONS: "off",
    RISA_PROCESS_FILE: join(root, "processes"),
    // The drain: off unless a test turns it on; never the machine's own readings or landings.
    RISA_USAGE_WATCH: "off",
    RISA_USAGE_DIR: "",
    RISA_USAGE_DRAIN: "",
    RISA_USAGE_STOP: "",
    RISA_USAGE_STALE_MIN: "",
    RISA_LANDING_DIR: "",
    // Off unless a test turns it on; never the machine's own inbox folder or Claude Code files.
    RISA_PICKUP_EVERY: "off",
    RISA_INBOX_DIR: inboxDir,
    RISA_CLAUDE_PROJECTS: join(root, "projects"),
    RISA_CLAUDE_CONFIG: claudeConfig,
    STUB_STATE: state,
    STUB_ROWS: rowsFile,
  };
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  for (const d of [state, sessions, asks, join(loops, ".requests"), join(loops, ".notices")])
    rmSync(d, { recursive: true, force: true });
  for (const f of [".dispatch.json", ".dispatch.log", ".dispatch.lock", ".prd-cap"])
    rmSync(join(loops, f), { force: true });
  for (const w of existsSync(loops) ? readdirSync(loops) : [])
    if (!w.startsWith(".")) git(main, "worktree", "remove", "--force", join(loops, w));
  for (const b of git(main, "branch", "--format=%(refname:short)").split("\n"))
    if (b && b !== "dev") git(main, "branch", "-q", "-D", b);
  mkdirSync(state, { recursive: true });
  setClock(T0);
  setRows([]);
  writeFileSync(join(root, "processes"), "");
  rmSync(join(root, "home"), { recursive: true, force: true });
  rmSync(claudeConfig, { force: true });
});

describe("one tick per action", () => {
  it("start: makes the PRD worktree, writes a managed record, opens a run-through orchestrator in the background", () => {
    setRows([{ topic: "a", state: "planned" }]);
    const out = ok();
    expect(out).toContain("start a: planned, and nothing stops it");
    expect(calls("new")).toEqual(["prd a"]);
    const [open] = openCalls();
    expect(open).toEqual([
      "--command",
      `cd ${join(loops, "a")} && ${scripts("session.sh")} prd-a --auto --managed -- --remote-control prd-a "$(scripts/loops/prompt.sh orchestrator a --auto)"`,
      "--title",
      "prd-a",
      "--background",
    ]);
    expect(JSON.parse(readFileSync(join(sessions, "prd-a.json"), "utf8"))).toMatchObject({
      kind: "prd",
      topic: "a",
      managed: true,
      auto: true,
    });
    expect(logText()).toMatch(/^\S+Z start a: planned, and nothing stops it\n {2}new\.sh prd a: made a\n/);
  });

  it("plan: makes the plan worktree and opens a managed, run-through planner with no item ids", () => {
    setRows([{ topic: "p", state: "to-write", waiting: 4 }]);
    expect(ok()).toContain("plan p: 4 waiting, no plan yet");
    expect(calls("new")).toEqual(["plan p"]);
    const [open] = openCalls();
    expect(open[1]).toBe(
      `cd ${join(loops, "plan-p")} && ${scripts("session.sh")} plan-p --auto --managed -- --model opus --remote-control plan-p "$(scripts/loops/prompt.sh plan p --auto)"`,
    );
    expect(open[1]).not.toMatch(/B-\d/);
  });

  it("plan: a design row's planner opens on Fable", () => {
    setRows([{ topic: "pd", state: "to-write", waiting: 1, flags: ["design"] }]);
    ok();
    expect(openCalls()[0][1]).toContain('--model fable --remote-control plan-pd "$(');
  });

  it("the PRD cap defaults to four, and RISA_MAX_PRDS overrides it", () => {
    const names = ["w", "x", "y"];
    for (const n of names) worktree(n, `prd/${n}`);
    const running = names.map((topic) => ({ topic, state: "running" }));
    setRows([...running, { topic: "a", state: "planned" }]);
    expect(ok(["--dry-run"])).toContain("start a:");
    expect(ok(["--dry-run"], { RISA_MAX_PRDS: "3" })).toContain("no free slot (3 of 3 running)");
    worktree("z", "prd/z");
    setRows([...running, { topic: "z", state: "running" }, { topic: "a", state: "planned" }]);
    expect(ok(["--dry-run"])).toContain("no free slot (4 of 4 running)");
    expect(ok(["--dry-run"], { RISA_MAX_PRDS: "5" })).toContain("start a:");
  });

  it("--cap stores the PRD cap, read every tick over RISA_MAX_PRDS; default clears it", () => {
    const names = ["w", "x", "y"];
    for (const n of names) worktree(n, `prd/${n}`);
    setRows([...names.map((topic) => ({ topic, state: "running" })), { topic: "a", state: "planned" }]);
    const lowered = ok(["--cap", "2"]);
    expect(lowered).toContain("PRD cap 2 (pnpm prd dispatch --cap; was 4)");
    expect(lowered).toContain("3 PRD worktrees now: none start until fewer than 2 remain");
    expect(readFileSync(join(loops, ".prd-cap"), "utf8")).toBe("2\n");
    expect(logText()).toContain("PRD cap 2 (pnpm prd dispatch --cap; was 4)");
    expect(readdirSync(join(loops, ".notices")).length).toBeGreaterThan(0);
    // Lowering ends nothing: the running three stay, and no start.
    expect(ok(["--dry-run"], { RISA_MAX_PRDS: "6" })).toContain("no free slot (3 of 2 running)");
    expect(ok(["--cap", "6"])).toContain("3 more may start");
    expect(ok(["--dry-run"])).toContain("start a:");
    expect(ok(["--cap", "default"])).toContain("PRD cap 4 (default; was 6)");
    expect(existsSync(join(loops, ".prd-cap"))).toBe(false);
    expect(ok(["--dry-run"], { RISA_MAX_PRDS: "3" })).toContain("no free slot (3 of 3 running)");
    for (const bad of ["0", "20", "two", ""]) {
      const r = dispatch(["--cap", bad]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("--cap takes a number from 1 to 19, or default");
    }
  });

  it("a failed worktree opens nothing", () => {
    setRows([{ topic: "a", state: "planned" }]);
    const out = ok(["--once"], { STUB_NEW_FAIL: "1" });
    expect(out).toContain("new.sh prd a: failed (exit 1): no room");
    expect(openCalls()).toEqual([]);
    expect(existsSync(join(sessions, "prd-a.json"))).toBe(false);
  });

  it("a start whose tab never opens leaves no record, no worktree and no count, and starts on a later tick (B-468)", () => {
    setRows([{ topic: "a", state: "planned" }]);
    const out = ok(["--once"], { STUB_NEW_MAKE: "1", STUB_OPEN_FAIL: "prd-a" });
    expect(out).toContain(
      "  prd-a: its tab never opened, not counted as a death (failed (exit 1): no tab); a later tick retries; a removed",
    );
    expect(calls("rm")).toEqual(["a --no-registry"]);
    expect(existsSync(join(loops, "a"))).toBe(false);
    expect(existsSync(join(sessions, "prd-a.json"))).toBe(false);
    expect(dstate().reopens ?? {}).toEqual({});
    // One line for the failed open, after the new.sh line.
    expect(
      logText()
        .split("\n")
        .filter((l) => l.includes("prd-a")),
    ).toHaveLength(1);
    // The opener works again: the next tick starts it afresh, no reopen.
    git(main, "branch", "-q", "-D", "prd/a");
    expect(ok(["--once"], { STUB_NEW_MAKE: "1" })).toContain("start a: planned, and nothing stops it");
    expect(calls("new")).toEqual(["prd a", "prd a"]);
    expect(openCalls().at(-1)?.slice(2)).toEqual(["--title", "prd-a", "--background"]);
    expect(dstate().reopens ?? {}).toEqual({});
  });

  it("a planner whose tab never opens doesn't hold the planner slot", () => {
    setRows([
      { topic: "p", state: "to-write", waiting: 2 },
      { topic: "q", state: "to-write", waiting: 2 },
    ]);
    ok(["--once"], { STUB_NEW_MAKE: "1", STUB_OPEN_FAIL: "plan-p" });
    expect(calls("rm")).toEqual(["plan-p --no-registry"]);
    expect(existsSync(join(loops, "plan-p"))).toBe(false);
    // No planner runs: another may be planned (here p again, by row order), none is reopened.
    const next = ok(["--dry-run"]);
    expect(next).toContain("plan p: 2 waiting, no plan yet");
    expect(next).not.toContain("a planner is running");
    expect(next).not.toMatch(/reopen plan-p/);
  });

  it("a reopen whose tab never opens adds no count and files no ask: a later tick retries (B-468)", () => {
    worktree("a", "prd/a");
    deadRecord("prd-a");
    setRows([{ topic: "a", state: "running" }]);
    for (let i = 0; i < 4; i++) {
      const out = ok(["--once"], { STUB_OPEN_FAIL: "a" });
      expect(out).toContain("reopen prd-a: prd-a died (reopen 1 of 2)");
      expect(out).toContain("  prd-a: its tab never opened, not counted as a death");
    }
    expect(dstate().reopens ?? {}).toEqual({});
    expect(existsSync(asks)).toBe(false);
    expect(calls("rm")).toEqual([]);
    expect(existsSync(join(loops, "a"))).toBe(true);
    // Once a tab opens, it counts as the first reopen.
    expect(ok()).toContain("reopen prd-a: prd-a died (reopen 1 of 2)");
    expect(dstate().reopens).toEqual({ "prd-a": 1 });
  });

  it("reopen: the opener in the background, counted", () => {
    worktree("a", "prd/a");
    deadRecord("prd-a");
    setRows([{ topic: "a", state: "running" }]);
    expect(ok()).toContain("reopen prd-a: prd-a died (reopen 1 of 2)");
    expect(openCalls()).toEqual([["a", "--background"]]);
    expect(dstate().reopens).toEqual({ "prd-a": 1 });
  });

  it("reopens a record marked rotating over five minutes ago (its mtime), not a fresh one", () => {
    worktree("a", "prd/a");
    deadRecord("prd-a", { rotating: true });
    setRows([{ topic: "a", state: "running" }]);
    setClock(Math.floor(Date.now() / 1000));
    expect(ok()).toContain("a: its orchestrator is being rotated");
    expect(openCalls()).toEqual([]);
    const old = new Date(Date.now() - ROTATING_GRACE_MS - 60_000);
    utimesSync(join(sessions, "prd-a.json"), old, old);
    expect(ok()).toContain("reopen prd-a: prd-a died (reopen 1 of 2)");
    expect(openCalls()).toEqual([["a", "--background"]]);
  });

  it("leaves a worktree opened by hand alone, and logs why", () => {
    worktree("a", "prd/a");
    deadRecord("prd-a", { managed: false });
    setRows([{ topic: "a", state: "running" }]);
    expect(ok()).toContain("a: opened by hand, its orchestrator isn't live (left alone)");
    expect(openCalls()).toEqual([]);
  });

  it("the work switch off starts and plans nothing; RISA_WORK_SELF=1 lifts it for that process", () => {
    setRows([
      { topic: "a", state: "planned" },
      { topic: "p", state: "to-write", waiting: 2 },
    ]);
    const machine = join(root, "machine.json");
    writeFileSync(machine, JSON.stringify({ repos: [{ path: main, work: false }] }));
    const off = ok(["--dry-run"], { RISA_MACHINE_CONFIG: machine });
    expect(off).toMatch(
      /^nothing: the work switch is off \("work": false for .* in .*machine\.json; RISA_WORK_SELF=1/,
    );
    expect(off).toMatch(/\n {2}a: the work switch is off \(/);
    expect(off).toMatch(/\n {2}p: the work switch is off \(/);
    ok(["--once"], { RISA_MACHINE_CONFIG: machine });
    expect(calls("new")).toEqual([]);
    expect(openCalls()).toEqual([]);
    expect(ok(["--dry-run"], { RISA_MACHINE_CONFIG: machine, RISA_WORK_SELF: "1" })).toContain(
      "start a: planned, and nothing stops it",
    );
    // A bad machine config: the loader's line, nothing started.
    writeFileSync(machine, JSON.stringify({ repos: [{ path: "repo", work: "no" }] }));
    expect(ok(["--dry-run"], { RISA_MACHINE_CONFIG: machine })).toContain(
      "repos.0.path: must be an absolute path",
    );
  });

  it("--dry-run prints the pick and writes and opens nothing", () => {
    setRows([
      { topic: "a", state: "planned" },
      { topic: "b", state: "planned" },
    ]);
    const out = ok(["--dry-run"], { RISA_ITERM_APP: join(root, "nowhere") });
    expect(out).toContain("start a: planned, and nothing stops it");
    expect(out).toContain("  b: waits a tick: a starts first");
    expect(out).toContain("(dry run: nothing written, nothing opened)");
    expect(calls("new")).toEqual([]);
    expect(openCalls()).toEqual([]);
    for (const f of [".dispatch.json", ".dispatch.log", ".dispatch.lock"])
      expect(existsSync(join(loops, f))).toBe(false);
    expect(existsSync(sessions)).toBe(false);
  });

  it("refuses to run without iTerm2", () => {
    setRows([{ topic: "a", state: "planned" }]);
    const r = dispatch(["--once"], { RISA_ITERM_APP: join(root, "nowhere") });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("dispatch needs iTerm2");
    expect(calls("new")).toEqual([]);
  });

  it("a new.sh that fails after making the worktree removes it: no slot held at the next tick (B-452)", () => {
    setRows([{ topic: "a", state: "planned" }]);
    const out = ok(["--once"], { STUB_NEW_MAKE: "1", STUB_NEW_FAIL_AFTER: "1" });
    expect(out).toContain("  new.sh prd a: failed (exit 1): migrate failed; a removed");
    // Forced (a half setup holds no work) and with the registry row left alone.
    expect(calls("rm")).toEqual(["a --no-registry --force"]);
    expect(existsSync(join(loops, "a"))).toBe(false);
    expect(existsSync(join(sessions, "prd-a.json"))).toBe(false);
    expect(openCalls()).toEqual([]);
    expect(
      logText()
        .split("\n")
        .filter((l) => l.includes("new.sh")),
    ).toHaveLength(1);
    // The next tick sees no worktree opened by hand and no slot taken: it starts a again.
    const next = ok(["--dry-run"], { RISA_MAX_PRDS: "1" });
    expect(next).toContain("start a: planned, and nothing stops it");
    expect(next).not.toContain("opened by hand");
  });

  it("a planner whose new.sh fails after making its worktree doesn't hold the planner slot (B-452)", () => {
    setRows([{ topic: "p", state: "to-write", waiting: 2 }]);
    ok(["--once"], { STUB_NEW_MAKE: "1", STUB_NEW_FAIL_AFTER: "1" });
    expect(calls("rm")).toEqual(["plan-p --no-registry --force"]);
    expect(existsSync(join(loops, "plan-p"))).toBe(false);
    const next = ok(["--dry-run"]);
    expect(next).toContain("plan p: 2 waiting, no plan yet");
    expect(next).not.toContain("a planner is running");
  });

  it("a new.sh that fails before making the worktree removes nothing", () => {
    setRows([{ topic: "a", state: "planned" }]);
    expect(ok(["--once"], { STUB_NEW_FAIL: "1" })).toContain("  new.sh prd a: failed (exit 1): no room\n");
    expect(calls("rm")).toEqual([]);
  });
});

describe("the load gate and the rules through a tick", () => {
  it("busy: starts and plans nothing, and logs why", () => {
    writeFileSync(join(root, "load"), "30 30 30");
    try {
      setRows([
        { topic: "a", state: "planned" },
        { topic: "p", state: "to-write", waiting: 2 },
      ]);
      const out = ok();
      expect(out).toContain("nothing: the machine is busy");
      expect(out).toContain("(the 5-minute load 30 is over 8)");
      expect(out).toContain("  a: the machine is busy");
      expect(out).toContain("  p: the machine is busy");
      expect(calls("new")).toEqual([]);
      expect(logText()).toContain("nothing: the machine is busy");
    } finally {
      writeFileSync(join(root, "load"), "1 1 1");
    }
  });

  it("starts a fixes topic as the pick says: with three waiting, or fewer when nothing else may start", () => {
    setRows([
      { topic: "fixes-a", state: "planned", flags: ["standing"], waiting: 1 },
      { topic: "b", state: "planned" },
    ]);
    expect(ok()).toContain("start b: planned, and nothing stops it");
    rmSync(join(state, "new.calls"));
    setRows([{ topic: "fixes-a", state: "planned", flags: ["standing"], waiting: 1 }]);
    expect(ok()).toContain("start fixes-a: 1 waiting fixes");
    expect(calls("new")).toEqual(["prd fixes-a"]);
  });

  it("starts a freshly planned topic on the next tick: no hold", () => {
    setRows([{ topic: "p", state: "to-write", waiting: 2 }]);
    ok();
    expect(calls("new")).toEqual(["plan p"]);
    // The planner landed its plan and removed its worktree: the row is planned.
    setRows([{ topic: "p", state: "planned", waiting: 2 }]);
    expect(ok()).toContain("start p: planned, and nothing stops it");
    expect(calls("new")).toEqual(["plan p", "prd p"]);
  });
});

describe("the lock, pause, resume and stop", () => {
  it("a second instance refuses; a dead lock is taken over", async () => {
    const holder = spawn("sleep", ["30"]);
    try {
      writeFileSync(join(loops, ".dispatch.lock"), `${holder.pid}\n`);
      const r = dispatch();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`a dispatcher is already running (pid ${holder.pid})`);
    } finally {
      holder.kill();
    }
    await new Promise((r) => holder.on("exit", r));
    setRows([{ topic: "a", state: "planned" }]);
    expect(ok()).toContain("start a");
    expect(existsSync(join(loops, ".dispatch.lock"))).toBe(false);
  });

  it("--pause stops actions and --resume restores them", () => {
    setRows([{ topic: "a", state: "planned" }]);
    expect(ok(["--pause", "usage limit"])).toContain("Dispatcher paused: usage limit (none is running)");
    expect(dstate().paused).toMatchObject({ why: "usage limit" });
    expect(ok()).toContain("nothing: the dispatcher is paused");
    expect(calls("new")).toEqual([]);
    expect(ok(["--resume"])).toContain("Dispatcher resumed");
    expect(ok()).toContain("start a");
    expect(calls("new")).toEqual(["prd a"]);
  });

  it("--stop ends the running instance and frees the lock", async () => {
    setRows([]);
    const child = spawn("node", [scripts("dispatch.mjs"), "--every", "1"], { cwd: main, env });
    const exited = new Promise((r) => child.on("exit", (code) => r(code)));
    await until(() => existsSync(join(loops, ".dispatch.lock")) && existsSync(join(loops, ".dispatch.log")));
    expect(ok(["--stop"])).toContain(`Stopped the dispatcher (pid ${child.pid})`);
    expect(await exited).toBe(0);
    expect(existsSync(join(loops, ".dispatch.lock"))).toBe(false);
    expect(logText()).toContain("stopped (SIGTERM)");
    expect(ok(["--stop"])).toContain("No dispatcher is running.");
  });
});

describe("re-exec on new code (B-809)", () => {
  it("a landing on the main checkout re-execs the running dispatcher between ticks: same pid and lock, new code", async () => {
    setRows([]);
    const file = scripts("drain.mjs");
    const before = readFileSync(file, "utf8");
    const child = spawn("node", [scripts("dispatch.mjs"), "--every", "1"], {
      cwd: main,
      env,
      stdio: "ignore",
    });
    const exited = new Promise((r) => child.on("exit", (code) => r(code)));
    try {
      await until(() => existsSync(join(loops, ".dispatch.json")) && /started \(pid/.test(logText()));
      const old = dstate().code;
      expect(old).toMatchObject({ hash: codeHash(main), pid: child.pid });
      expect(logText()).not.toContain("re-exec");
      writeFileSync(file, `${before}\n// a landing\n`);
      await until(() => logText().includes("re-exec'd on new code"));
      const now = dstate().code;
      expect(now).toMatchObject({ hash: codeHash(main), pid: child.pid });
      expect(now.hash).not.toBe(old.hash);
      expect(logText()).toContain(`re-exec: the main checkout's code changed (${old.hash} -> ${now.hash})`);
      expect(logText()).toContain(`re-exec'd on new code ${now.hash} (was ${old.hash}; pid ${child.pid}`);
      expect(lockHolder(join(loops, ".dispatch.lock"))).toBe(child.pid);
      expect(ok(["--stop"])).toContain(`Stopped the dispatcher (pid ${child.pid})`);
      expect(await exited).toBe(0);
    } finally {
      writeFileSync(file, before);
      child.kill("SIGTERM");
    }
  });
});

describe("taking over a stale lock (B-454)", () => {
  // Two takers in this process, each with a live pid of its own; `between` runs
  // the other taker at the point the old unlink-and-write raced.
  const A = process.pid;
  const B = process.ppid;
  /** @type {string} */ let dir;
  /** @type {string} */ let lock;
  /** @type {number} */ let dead;

  beforeAll(() => {
    const r = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" });
    dead = Number(r.stdout.trim());
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dispatch-lock-"));
    lock = join(dir, ".dispatch.lock");
    writeFileSync(lock, `${dead}\n`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const held = () => Number(readFileSync(lock, "utf8").trim());

  it("two takers racing over a dead holder's lock end with one holder", () => {
    /** @type {any} */ let inner;
    const outer = takeLock(lock, { pid: A, between: () => (inner = takeLock(lock, { pid: B })) });
    expect(inner).toEqual({ ok: true });
    expect(outer).toEqual({ ok: false, pid: B });
    expect(held()).toBe(B);
    expect(existsSync(`${lock}.takeover`)).toBe(false);
  });

  it("the same race the other way round also ends with one holder", () => {
    /** @type {any} */ let inner;
    const outer = takeLock(lock, { pid: B, between: () => (inner = takeLock(lock, { pid: A })) });
    expect(inner).toEqual({ ok: true });
    expect(outer).toEqual({ ok: false, pid: A });
    expect(held()).toBe(A);
  });

  it("a lone taker takes a dead holder's lock", () => {
    expect(takeLock(lock, { pid: A })).toEqual({ ok: true });
    expect(lockHolder(lock)).toBe(A);
  });

  it("a live holder's lock is never taken", () => {
    writeFileSync(lock, `${B}\n`);
    expect(takeLock(lock, { pid: A })).toEqual({ ok: false, pid: B });
    expect(held()).toBe(B);
  });

  it("a crashed taker's stale guard is cleared; a fresh one is waited on", () => {
    mkdirSync(`${lock}.takeover`);
    const old = (Date.now() - TAKEOVER_STALE_MS - 1000) / 1000;
    utimesSync(`${lock}.takeover`, old, old);
    expect(takeLock(lock, { pid: A })).toEqual({ ok: true });
    expect(held()).toBe(A);

    writeFileSync(lock, `${dead}\n`);
    mkdirSync(`${lock}.takeover`);
    expect(takeLock(lock, { pid: A })).toEqual({ ok: false, pid: 0 });
    expect(held()).toBe(dead);
  });
});

describe("deaths and the reopen ask", () => {
  const dying = () => {
    worktree("a", "prd/a");
    deadRecord("prd-a");
    setRows([{ topic: "a", state: "running" }]);
  };

  it("the third death files one ask and pushes it, with no fourth reopen; each answer is acted on", () => {
    dying();
    ok();
    ok();
    expect(openCalls()).toEqual([
      ["a", "--background"],
      ["a", "--background"],
    ]);
    const out = ok();
    expect(out).toContain("ask prd-a: prd-a died again after 2 reopens");
    expect(out).toContain("filed ask a1");
    const ask = askFile("a1");
    expect(ask).toMatchObject({ kind: "question", topic: "a", session: "dispatch" });
    expect(ask.options).toEqual(["reopen again", "hold the topic"]);
    const helper = openCalls()[2];
    expect(helper.slice(2)).toEqual(["--title", HELPER_SESSION, "--background"]);
    expect(helper[1]).toContain(`${env.RISA_CLAUDE_BIN} --model haiku --remote-control dispatch-push`);
    expect(helper[1]).toContain("a: prd-a (a) died again after 2 reopens");
    expect(dstate().asked).toEqual({ "prd-a": { id: "a1", topic: "a" } });
    // While it's open: no fourth reopen and no second ask.
    expect(ok()).toContain("a: its orchestrator died after 2 reopens; waits on ask a1");
    expect(openCalls()).toHaveLength(3);
    expect(readdirSync(asks).filter((f) => f.endsWith(".json"))).toEqual(["a1.json"]);

    // "reopen again": the count resets, and it reopens on that tick.
    answer("a1", "1");
    const again = ok();
    expect(again).toContain('ask a1 answered "reopen again": prd-a may be reopened again');
    expect(again).toContain("reopen prd-a: prd-a died (reopen 1 of 2)");
    expect(dstate()).toMatchObject({ reopens: { "prd-a": 1 }, asked: {} });

    // Two more deaths, a new ask; "hold the topic" flags the row and nothing reopens.
    ok();
    expect(ok()).toContain("filed ask a2");
    answer("a2", "hold the topic");
    const held = ok();
    expect(held).toContain('ask a2 answered "hold the topic": a flagged hold');
    expect(calls("backlog")).toEqual(["prd set a flags+=hold"]);
    expect(held).toContain("a: on hold; its orchestrator isn't live (not reopened)");
    expect(openCalls()).toHaveLength(6);
    expect(ok()).not.toContain("filed ask");
  });

  it("a helper that can't start changes nothing", () => {
    dying();
    ok();
    ok();
    const out = ok(["--once"], { STUB_OPEN_FAIL: HELPER_SESSION });
    expect(out).toContain("filed ask a1");
    expect(out).toContain(`${HELPER_SESSION} didn't start (ignored)`);
    expect(dstate().asked).toEqual({ "prd-a": { id: "a1", topic: "a" } });
    expect(ok()).toContain("waits on ask a1");
  });

  it("forgets the count once the session has stayed live, or its worktree is gone", async () => {
    worktree("a", "prd/a");
    setRows([{ topic: "a", state: "running" }]);
    deadRecord("prd-a");
    ok();
    expect(dstate().reopens).toEqual({ "prd-a": 1 });
    // A live session (a sleep standing in) started over REOPEN_RESET_MS ago by the clock.
    const live = spawn("sleep", ["30"]);
    try {
      writeFileSync(
        join(sessions, "prd-a.json"),
        JSON.stringify({ pid: live.pid, started: new Date().toISOString(), managed: true }),
      );
      setClock(Math.ceil((Date.now() + REOPEN_RESET_MS) / 1000));
      ok();
      expect(dstate().reopens).toEqual({});
    } finally {
      live.kill();
    }
    // Its worktree gone, a count is stale.
    git(main, "worktree", "remove", "--force", join(loops, "a"));
    updateReopens({ "prd-a": 1, "prd-gone": 2 });
    ok();
    expect(dstate().reopens).toEqual({});
  });

  it("a failed hold write keeps the answer and the count, skips the topic, and is retried next tick", () => {
    dying();
    ok();
    ok();
    expect(ok()).toContain("filed ask a1");
    answer("a1", "hold the topic");
    const failed = ok(["--once"], { STUB_BACKLOG_FAIL: "1" });
    expect(failed).toContain(
      'ask a1 answered "hold the topic", but flagging a hold failed (retried next tick)',
    );
    expect(failed).toContain("registry locked");
    expect(failed).toContain("a: its orchestrator died after 2 reopens; waits on ask a1");
    expect(failed).not.toContain("filed ask");
    expect(dstate()).toMatchObject({ reopens: { "prd-a": 2 }, asked: { "prd-a": { id: "a1", topic: "a" } } });
    // Two reopens and the helper's tab: nothing opened on the failed tick.
    expect(openCalls()).toHaveLength(3);

    const held = ok();
    expect(held).toContain('ask a1 answered "hold the topic": a flagged hold');
    expect(calls("backlog")).toEqual(["prd set a flags+=hold", "prd set a flags+=hold"]);
    expect(held).toContain("a: on hold; its orchestrator isn't live (not reopened)");
    expect(dstate()).toMatchObject({ reopens: {}, asked: {} });
    expect(openCalls()).toHaveLength(3);
  });
});

describe("defaults on silence", () => {
  const defaulting = (topic, session) =>
    createAsk(asks, {
      kind: "question",
      topic,
      session,
      text: "Land now?",
      options: ["yes", "no"],
      recommended: "yes",
      defaults: true,
      now: T0 * 1000,
    });

  it("a tick settles a due ask of a dead session, and its reopened session finds the answer", () => {
    worktree("a", "prd/a");
    deadRecord("prd-a");
    setRows([{ topic: "a", state: "running" }]);
    defaulting("a", "prd-a");
    setClock(T0 + 60);
    expect(ok()).not.toContain("defaulted");
    expect(getAsk(asks, "a1").answeredAt).toBe(null);
    setClock(T0 + 31 * 60);
    expect(ok()).toContain('ask a1 (a) defaulted to "yes": no answer came');
    expect(getAsk(asks, "a1")).toMatchObject({ answer: "yes", defaulted: true });
    const waited = execFileSync("node", [scripts("ask.mjs"), "ask", "--wait", "a1"], {
      env: { ...env, RISA_ASKS_DIR: asks },
      encoding: "utf8",
    });
    expect(waited.split("\n")[0]).toBe("yes");
    expect(waited).toContain("(defaulted: no answer in 30m");
  });

  it("a topic whose only ask was defaulted is started on the same tick; a dry run settles nothing", () => {
    setRows([{ topic: "b", state: "planned" }]);
    defaulting("b", "plan-b");
    setClock(T0 + 31 * 60);
    const dry = ok(["--dry-run"]);
    expect(dry).toContain("has an open question (a1)");
    expect(getAsk(asks, "a1").answeredAt).toBe(null);
    const out = ok();
    expect(out).toContain('ask a1 (b) defaulted to "yes"');
    expect(out).toContain("start b");
  });

  it("files its own reopen question as waiting: it never settles", () => {
    worktree("a", "prd/a");
    deadRecord("prd-a");
    setRows([{ topic: "a", state: "running" }]);
    ok();
    ok();
    expect(ok()).toContain("filed ask a1");
    expect(askFile("a1")).toMatchObject({ defaults: false, defaultAt: null });
    setClock(T0 + 24 * 3600);
    expect(ok()).toContain("waits on ask a1");
    expect(askFile("a1").answeredAt).toBe(null);
  });
});

const updateReopens = (reopens) => {
  const s = dstate();
  writeFileSync(join(loops, ".dispatch.json"), JSON.stringify({ ...s, reopens }));
};

describe("tidy", () => {
  it("runs once the six hours have passed, not before, and never on a tick that acted", () => {
    ok();
    expect(dstate().lastTidy).toBe(T0 * 1000);
    setClock(T0 + TIDY_EVERY_MS / 1000 - 1);
    ok();
    expect(calls("tidy")).toEqual([]);
    // Due, but the tick starts a topic: no tidy.
    setClock(T0 + TIDY_EVERY_MS / 1000);
    setRows([{ topic: "a", state: "planned" }]);
    ok();
    expect(calls("tidy")).toEqual([]);
    // The next idle tick tidies, once.
    setRows([]);
    expect(ok()).toContain("tidy --yes: removed 0 safe ones");
    expect(calls("tidy")).toEqual(["--yes"]);
    ok();
    expect(calls("tidy")).toEqual(["--yes"]);
    expect(dstate().lastTidy).toBe((T0 + TIDY_EVERY_MS / 1000) * 1000);
  });
});

describe("the session-request tick", () => {
  const requests = () => join(loops, ".requests");
  const file = (name, opts = {}) => createRequest(requests(), { name, now: T0 * 1000, ...opts });
  const stored = (id) => JSON.parse(readFileSync(join(requests(), `${id}.json`), "utf8"));
  const notices = () =>
    existsSync(join(loops, ".notices"))
      ? readdirSync(join(loops, ".notices"))
          .filter((f) => f.endsWith(".json"))
          .map((f) => JSON.parse(readFileSync(join(loops, ".notices", f), "utf8")).text)
      : [];
  const opensOf = (name) => openCalls().filter((c) => c[3] === `backlog-${name}`);

  it("opens backlog-<name> through session.sh, with the brief on top, and posts the opened notice", () => {
    const brief = join(root, "a-brief.md");
    writeFileSync(brief, "Fictional task: sort the reminders.\n");
    const r = file("reminders", { brief, model: "sonnet", from: "backlog" });
    expect(ok()).toContain(`session request ${r.id}: opened backlog-reminders`);
    const [open] = opensOf("reminders");
    expect(open).toEqual([
      "--command",
      `cd ${main} && ${scripts("session.sh")} backlog-reminders --kind backlog --managed -- --model sonnet --remote-control 'backlog - reminders' "$(scripts/loops/prompt.sh backlog --brief ${r.brief} || scripts/loops/prompt.sh backlog)"`,
      "--title",
      "backlog-reminders",
      "--background",
    ]);
    expect(stored(r.id).state).toBe("opened");
    expect(notices()).toEqual([`request ${r.id} (for backlog): opened \`backlog - reminders\``]);
    ok();
    expect(opensOf("reminders")).toHaveLength(1);
  });

  it("the opened line really starts a recorded session with the brief at the top", () => {
    for (const f of ["session.sh", "prompt.sh", "lib.sh", "config.mjs"])
      copyFileSync(join(HERE, f), scripts(f));
    cpSync(join(HERE, "prompts"), scripts("prompts"), { recursive: true });
    const seen = join(root, "claude-args");
    const stub = join(root, "bin", "claude-args");
    writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${seen}\n`);
    chmodSync(stub, 0o755);
    const brief = join(root, "b-brief.md");
    writeFileSync(brief, "Fictional task: tidy the labels.\n");
    file("labels", { brief });
    ok();
    const [open] = opensOf("labels");
    const r = spawnSync("bash", ["-c", open[1]], {
      env: { ...env, RISA_CLAUDE_BIN: stub },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const args = readFileSync(seen, "utf8");
    expect(args).toContain("--remote-control\nbacklog - labels\n");
    expect(args).toMatch(/## Brief from the session before[\s\S]*Fictional task: tidy the labels/);
    expect(args.indexOf("Fictional task")).toBeLessThan(args.indexOf("You are the new backlog"));
    expect(JSON.parse(readFileSync(join(sessions, "backlog-labels.json"), "utf8"))).toMatchObject({
      kind: "backlog",
      managed: true,
      model: "opus",
      remote: "backlog - labels",
    });
  });

  it("refuses a live name with a notice, and never takes it again", () => {
    writeFileSync(join(root, "processes"), "claude-stub --remote-control backlog - busy You are\n");
    const r = file("busy");
    expect(ok()).toContain("refused (`backlog - busy` is already live)");
    expect(opensOf("busy")).toEqual([]);
    expect(stored(r.id)).toMatchObject({ state: "refused", why: "`backlog - busy` is already live" });
    expect(notices()[0]).toContain("not opened");
    ok();
    expect(notices()).toHaveLength(1);
  });

  it("a tab that can't open is a refusal with a notice", () => {
    const r = file("notab");
    expect(ok(["--once"], { STUB_OPEN_FAIL: "backlog-notab" })).toContain("refused (its tab didn't open");
    expect(stored(r.id).state).toBe("refused");
    expect(notices()).toHaveLength(1);
  });

  it("a paused dispatcher leaves it pending; --dry-run says what it would do and writes nothing", () => {
    const r = file("later");
    ok(["--pause", "t"]);
    ok();
    expect(stored(r.id).state).toBe("pending");
    ok(["--resume"]);
    expect(ok(["--dry-run"])).toContain(`session request ${r.id}: would open backlog-later`);
    expect(stored(r.id).state).toBe("pending");
    expect(opensOf("later")).toEqual([]);
    expect(notices()).toEqual([]);
  });

  it("takes one a tick, oldest first, and counts the first as up on the next", () => {
    const a = file("same");
    const b = file("same");
    ok();
    expect(stored(a.id).state).toBe("opened");
    expect(stored(b.id).state).toBe("pending");
    ok();
    expect(stored(b.id)).toMatchObject({ state: "refused", why: "`backlog - same` is already live" });
    expect(opensOf("same")).toHaveLength(1);
  });

  it("the keep-alive never reopens a named session", () => {
    deadRecord("backlog-gone", { kind: "backlog", remote: "backlog - gone" });
    writeFileSync(join(root, "processes"), "claude-stub --remote-control backlog You are\n");
    ok(["--once"], { RISA_KEEP_SESSIONS: "on" });
    expect(openCalls()).toEqual([]);
  });

  it("a kept session opened on this tick counts toward the limit", () => {
    file("one");
    expect(ok(["--once"], { RISA_KEEP_SESSIONS: "on", RISA_MAX_BACKLOG_SESSIONS: "1" })).toContain(
      "1 backlog sessions are live, the limit is 1",
    );
    expect(opensOf("one")).toEqual([]);
  });
});

describe("the keep-alive tick", () => {
  const on = { RISA_KEEP_SESSIONS: "on" };
  const keptOpens = () => openCalls().filter((c) => c[0] === "backlog");
  const dieAndTick = (at) => {
    setClock(at);
    return ok(["--once"], on);
  };

  it("opens a managed backlog session through the opener, with no record to start from", () => {
    expect(ok(["--once"], on)).toContain("keep-alive backlog: open (no live backlog session)");
    expect(keptOpens()).toEqual([["backlog", "--background"]]);
    expect(JSON.parse(readFileSync(join(sessions, "backlog.json"), "utf8"))).toEqual({
      kind: "backlog",
      managed: true,
    });
  });

  it("clears an ended record's end and keeps its model", () => {
    deadRecord("backlog", { kind: "backlog", managed: false, model: "opus", exit: 1 });
    ok(["--once"], on);
    const r = JSON.parse(readFileSync(join(sessions, "backlog.json"), "utf8"));
    expect(r).toEqual({ kind: "backlog", managed: true, model: "opus" });
  });

  it("takes no slot: a start the slots allow happens on the same tick", () => {
    setRows([{ topic: "a", state: "planned" }]);
    const out = ok(["--once"], { ...on, RISA_MAX_PRDS: "1" });
    expect(out).toContain("start a:");
    expect(keptOpens()).toHaveLength(1);
    expect(calls("new")).toEqual(["prd a"]);
  });

  it("a kept session whose tab never opens records no quick death, and opens on a later tick", () => {
    ok(["--once"], on);
    const before = dstate().keepAlive.backlog;
    setClock(T0 + 180);
    const out = ok(["--once"], { ...on, STUB_OPEN_FAIL: "backlog" });
    expect(out).toContain("  backlog: its tab never opened, not counted as a death");
    expect(dstate().keepAlive.backlog).toEqual(before);
    // A first open that fails leaves no entry at all.
    rmSync(join(loops, ".dispatch.json"));
    ok(["--once"], { ...on, STUB_OPEN_FAIL: "backlog" });
    expect(dstate().keepAlive?.backlog).toBeUndefined();
    setClock(T0 + 360);
    ok(["--once"], on);
    expect(dstate().keepAlive.backlog).toEqual({ deaths: 0, openedAt: (T0 + 360) * 1000 });
  });

  it("counts an unrecorded --remote-control backlog process as live", () => {
    writeFileSync(join(root, "processes"), "claude-stub --model opus --remote-control backlog You are\n");
    ok(["--once"], on);
    expect(keptOpens()).toEqual([]);
  });

  it("counts a captain-named backlog session as live: by its record, or by its process", () => {
    writeFileSync(join(root, "processes"), "claude-stub --model opus --remote-control Picard You are\n");
    ok(["--once"], on);
    expect(keptOpens()).toEqual([]);
  });

  it("reopens a dead captain-named backlog session, its record still backlog with its last captain", () => {
    deadRecord("backlog", { kind: "backlog", model: "opus", remote: "Picard" });
    expect(ok(["--once"], on)).toContain("keep-alive backlog: open (no live backlog session)");
    expect(keptOpens()).toEqual([["backlog", "--background"]]);
    // The opener draws the next captain against it (open-session.mjs).
    expect(JSON.parse(readFileSync(join(sessions, "backlog.json"), "utf8"))).toMatchObject({
      kind: "backlog",
      managed: true,
      remote: "Picard",
    });
  });

  it("doesn't reopen inside the start grace, and asks at the third quick death", () => {
    ok(["--once"], on);
    dieAndTick(T0 + 30);
    expect(keptOpens()).toHaveLength(1);
    dieAndTick(T0 + 180);
    dieAndTick(T0 + 360);
    expect(keptOpens()).toHaveLength(3);
    const out = dieAndTick(T0 + 540);
    expect(out).toContain("keep-alive backlog: ask");
    expect(keptOpens()).toHaveLength(3);
    const { id } = dstate().keepAlive.backlog.asked;
    expect(askFile(id)).toMatchObject({ session: "dispatch-keep", defaults: false });
    expect(openCalls().some((c) => c[3] === HELPER_SESSION)).toBe(true);
    dieAndTick(T0 + 720);
    expect(keptOpens()).toHaveLength(3);
  });

  const toQuestion = () => {
    ok(["--once"], on);
    dieAndTick(T0 + 180);
    dieAndTick(T0 + 360);
    dieAndTick(T0 + 540);
    return dstate().keepAlive.backlog.asked.id;
  };

  it('"open again" opens on the next tick with the count cleared', () => {
    answer(toQuestion(), "open again");
    expect(dieAndTick(T0 + 600)).toContain("may be opened again");
    expect(keptOpens()).toHaveLength(4);
    expect(dstate().keepAlive.backlog.deaths).toBe(0);
  });

  it('"stop keeping it alive" holds across ticks', () => {
    answer(toQuestion(), "stop keeping it alive");
    dieAndTick(T0 + 600);
    dieAndTick(T0 + 4000);
    expect(keptOpens()).toHaveLength(3);
    expect(dstate().keepAlive.backlog).toEqual({ stopped: true });
  });

  it("a dismissed question is asked again, never read as an open", () => {
    const id = toQuestion();
    execFileSync("node", [scripts("ask.mjs"), "asks", "--done", id], {
      env: { ...env, RISA_ASKS_DIR: asks },
      encoding: "utf8",
    });
    expect(dieAndTick(T0 + 600)).toContain("asking again");
    expect(keptOpens()).toHaveLength(3);
    expect(dstate().keepAlive.backlog.asked.id).not.toBe(id);
  });

  it("a dispatcher start clears a stop", async () => {
    answer(toQuestion(), "stop keeping it alive");
    dieAndTick(T0 + 600);
    expect(dstate().keepAlive.backlog).toEqual({ stopped: true });
    const child = spawn("node", [scripts("dispatch.mjs"), "--every", "60"], {
      cwd: main,
      env: { ...env, ...on },
      stdio: "ignore",
    });
    try {
      await until(() => keptOpens().length === 4);
      expect(dstate().keepAlive.backlog.stopped).toBeUndefined();
    } finally {
      child.kill("SIGTERM");
      await until(() => !existsSync(join(loops, ".dispatch.lock")));
    }
  });

  it("paused or switched off opens nothing; --dry-run says what it would do and writes nothing", () => {
    ok(["--once"]);
    expect(keptOpens()).toEqual([]);
    ok(["--pause", "t"]);
    ok(["--once"], on);
    expect(keptOpens()).toEqual([]);
    ok(["--resume"]);
    expect(ok(["--dry-run"], on)).toContain("keep-alive backlog: open");
    expect(keptOpens()).toEqual([]);
    expect(existsSync(join(sessions, "backlog.json"))).toBe(false);
  });
});

describe("the inbox session's keep-alive", () => {
  const on = { RISA_KEEP_SESSIONS: "on" };
  const inboxOpens = () => openCalls().filter((c) => c[0] === "inbox");
  /** The inbox folder made and trusted, as a first `pnpm prd inbox` by hand leaves it. */
  const trust = () => {
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(
      claudeConfig,
      JSON.stringify({ projects: { [inboxDir]: { hasTrustDialogAccepted: true } } }),
    );
  };
  const backlogLive = "claude-stub --remote-control backlog You are\n";

  it("opens nothing while its folder is missing or untrusted, and says why", () => {
    writeFileSync(join(root, "processes"), backlogLive);
    expect(ok(["--dry-run"], on)).toContain(`keep-alive inbox: its directory ${inboxDir} doesn't exist yet`);
    mkdirSync(inboxDir, { recursive: true });
    expect(ok(["--dry-run"], on)).toContain("isn't trusted yet: run `pnpm prd inbox` once by hand");
    ok(["--once"], on);
    expect(inboxOpens()).toEqual([]);
    expect(existsSync(join(sessions, "inbox.json"))).toBe(false);
  });

  it("opens a managed inbox session through the opener once trusted, outside the PRD slots", () => {
    trust();
    writeFileSync(join(root, "processes"), backlogLive);
    setRows([{ topic: "a", state: "planned" }]);
    const out = ok(["--once"], { ...on, RISA_MAX_PRDS: "1" });
    expect(out).toContain("keep-alive inbox: open (no live inbox session)");
    expect(out).toContain("start a:");
    expect(inboxOpens()).toEqual([["inbox", "--background"]]);
    expect(JSON.parse(readFileSync(join(sessions, "inbox.json"), "utf8"))).toEqual({
      kind: "inbox",
      managed: true,
    });
  });

  it("keeps a dead record's model and directory, and asks at the third quick death", () => {
    trust();
    writeFileSync(join(root, "processes"), backlogLive);
    deadRecord("inbox", { kind: "inbox", model: "sonnet", dir: inboxDir, managed: false });
    ok(["--once"], on);
    expect(JSON.parse(readFileSync(join(sessions, "inbox.json"), "utf8"))).toEqual({
      kind: "inbox",
      managed: true,
      model: "sonnet",
      dir: inboxDir,
    });
    for (const at of [180, 360]) {
      setClock(T0 + at);
      ok(["--once"], on);
    }
    expect(inboxOpens()).toHaveLength(3);
    setClock(T0 + 540);
    expect(ok(["--once"], on)).toContain("keep-alive inbox: ask");
    expect(inboxOpens()).toHaveLength(3);
    expect(askFile(dstate().keepAlive.inbox.asked.id).text).toContain("The inbox session died 3 times");
  });

  it("counts a --remote-control inbox process as live", () => {
    trust();
    writeFileSync(
      join(root, "processes"),
      `${backlogLive}claude-stub --model opus --remote-control inbox You are\n`,
    );
    ok(["--once"], on);
    expect(inboxOpens()).toEqual([]);
  });
});

describe("the pickup", () => {
  const every = { RISA_PICKUP_EVERY: "300" };
  const pickups = () => calls("prd");

  it("runs dev-sync once a period, not every tick, and says nothing when there was nothing", () => {
    expect(ok(["--once"], every)).not.toContain("pickup");
    expect(pickups()).toEqual(["dev-sync the dispatcher's pickup"]);
    setClock(T0 + 60);
    ok(["--once"], every);
    setClock(T0 + 299);
    ok(["--once"], every);
    expect(pickups()).toHaveLength(1);
    setClock(T0 + 300);
    expect(ok(["--once"], { ...every, STUB_PICKUP: "moved" })).toContain(
      "pickup: dev-sync: fast-forwarded dev to abc1234",
    );
    expect(pickups()).toHaveLength(2);
    expect(dstate().lastPickup).toBe((T0 + 300) * 1000);
  });

  it("a refused pickup logs one line and the tick still picks", () => {
    setRows([{ topic: "a", state: "planned" }]);
    const out = ok(["--once"], { ...every, STUB_PICKUP: "refused" });
    expect(out).toContain(
      "pickup: failed (exit 1): dev-sync: the main checkout is in the middle of a merge, rebase or cherry-pick (MERGE_HEAD)",
    );
    expect(out.match(/pickup/g)).toHaveLength(1);
    expect(out).toContain("start a:");
    expect(calls("new")).toEqual(["prd a"]);
    expect(logText()).toContain("pickup: failed (exit 1)");
    // Not retried on the next tick: once a period, failed or not.
    setClock(T0 + 60);
    ok(["--once"], { ...every, STUB_PICKUP: "refused" });
    expect(pickups()).toHaveLength(1);
  });

  it("runs by default, never paused, off or in a dry run", () => {
    ok(["--once"], { RISA_PICKUP_EVERY: "" });
    expect(pickups()).toHaveLength(1);
    rmSync(join(loops, ".dispatch.json"), { force: true });
    ok(["--pause", "t"]);
    ok(["--once"], every);
    ok(["--resume"]);
    ok(["--once"]);
    expect(pickups()).toHaveLength(1);
    expect(ok(["--dry-run"], every)).toContain("pickup: would run pnpm prd dev-sync");
    expect(pickups()).toHaveLength(1);
    expect(dstate().lastPickup).toBeUndefined();
  });
});

// ---- the stuck orchestrator (B-408) ------------------------------------------------

describe("the stuck decision", () => {
  const NOW = Date.parse("2027-01-15T12:00:00Z");
  const LIMIT = 30 * 60_000;
  const ago = (min) => new Date(NOW - min * 60_000).toISOString();
  const sess = (extra = {}) => ({
    name: "prd-x",
    pid: 100,
    kind: "prd",
    topic: "x",
    managed: true,
    auto: true,
    live: true,
    ...extra,
  });
  const own = (extra = {}) => ({
    session: "prd-x",
    pid: 100,
    agent: null,
    lastStart: ago(41),
    lastEnd: ago(40),
    stoppedAt: ago(40),
    running: {},
    ...extra,
  });
  const agent = (extra = {}) => ({ ...own(), agent: "a1", stoppedAt: null, ...extra });
  const decide = (facts = {}) =>
    stuckDecision({ sessions: [sess()], heartbeats: [own()], limitMs: LIMIT, now: NOW, ...facts });
  const asks = (facts) => decide(facts).filter((a) => a.type === "ask");

  it("asks once about an orchestrator quiet for the limit, then waits on its question", () => {
    const [a] = asks();
    expect(a).toMatchObject({ session: "prd-x", pid: 100, topic: "x", since: Date.parse(ago(40)) });
    expect(a.text).toMatch(/prd-x looks stuck: no tool call for 40m/);
    expect(asks({ heartbeats: [own({ lastEnd: ago(29), stoppedAt: ago(29) })] })).toEqual([]);
    const open = { id: "a1", topic: "x", kind: "question", session: STUCK_SESSION };
    expect(decide({ entries: { "prd-x": { pid: 100, since: 0, askId: "a1" } }, asks: [open] })).toEqual([]);
  });

  it("asks about one whose only command is watch --wait (or ask --wait)", () => {
    const waiting = (command) => own({ running: { t1: { tool: "Bash", at: ago(41), command } } });
    expect(asks({ heartbeats: [waiting("pnpm prd watch x --wait --timeout 3600")] })).toHaveLength(1);
    expect(asks({ heartbeats: [waiting("pnpm prd ask --wait a7")] })).toHaveLength(1);
    expect(asks({ heartbeats: [waiting("pnpm test")] })).toEqual([]);
    expect(onlyWaits("pnpm prd watch x --json")).toBe(false);
  });

  it("asks about one whose slice agent is hung: an old unfinished call is no recent heartbeat", () => {
    const hung = agent({
      lastStart: ago(90),
      lastEnd: ago(95),
      running: { t2: { tool: "Bash", at: ago(90) } },
    });
    expect(asks({ heartbeats: [own(), hung] })).toHaveLength(1);
    // An open Agent call of its own is that agent's to speak for.
    const call = own({ running: { t3: { tool: "Agent", at: ago(90) } } });
    expect(asks({ heartbeats: [call, hung] })).toHaveLength(1);
  });

  it("asks about a watch action unhandled for the limit, though the orchestrator is active", () => {
    const active = own({ lastEnd: ago(1), stoppedAt: ago(1) });
    const watch = (since, marks = []) => ({
      x: { state: { actions: { 2: { action: "restart", since } } }, marks },
    });
    const [a] = asks({ heartbeats: [active], watch: watch(ago(35)) });
    expect(a.text).toContain("slice 2's watch action (restart) has waited 35m unhandled");
    expect(asks({ heartbeats: [active], watch: watch(ago(20)) })).toEqual([]);
    // A mark for that slice since the action handled it.
    expect(asks({ heartbeats: [active], watch: watch(ago(35), [{ slice: "2", at: ago(30) }]) })).toEqual([]);
    expect(asks({ heartbeats: [active], watch: watch(ago(35), [{ slice: "3", at: ago(30) }]) })).toHaveLength(
      1,
    );
  });

  it("asks nothing with a recent agent heartbeat, a running command or an open question", () => {
    expect(asks({ heartbeats: [own(), agent({ lastStart: ago(5), lastEnd: ago(5) })] })).toEqual([]);
    expect(asks({ running: new Set(["prd-x"]) })).toEqual([]);
    expect(
      asks({
        heartbeats: [own({ running: { t1: { tool: "Bash", at: ago(41), command: "pnpm prd land x" } } })],
      }),
    ).toEqual([]);
    const question = { id: "a4", topic: "x", kind: "question", session: "prd-x" };
    expect(asks({ asks: [question] })).toEqual([]);
    expect(asks({ asks: [{ ...question, answeredAt: ago(2), answer: "yes" }] })).toHaveLength(1);
    expect(asks({ asks: [{ ...question, topic: "y" }] })).toHaveLength(1);
  });

  it("leaves alone a session with no heartbeat ever, or another pid's", () => {
    expect(decide({ heartbeats: [] })).toEqual([]);
    expect(decide({ heartbeats: [own({ pid: 99 })] })).toEqual([]);
    expect(decide({ heartbeats: [agent()] })).toEqual([]);
  });

  it("ignores a session opened by hand, a planner, a dead or rotating one", () => {
    for (const extra of [
      { managed: false },
      { auto: false },
      { kind: "plan" },
      { live: false },
      { rotating: true },
    ])
      expect(decide({ sessions: [sess(extra)] })).toEqual([]);
  });

  it("a tick gap resets the clocks", () => {
    const gap = stuckSettings({}).gapMs;
    expect(gap).toBe(600_000);
    expect(stuckSettings({}, 300).gapMs).toBe(900_000);
    expect(stuckSettings({ RISA_STUCK_MIN: "5" }).limitMs).toBe(300_000);
    expect(stuckClock(undefined, NOW, gap)).toBeNull();
    expect(stuckClock({ lastTickAt: NOW - 60_000 }, NOW, gap)).toBeNull();
    expect(stuckClock({ lastTickAt: NOW - gap - 1 }, NOW, gap)).toBe(NOW);
    expect(stuckClock({ lastTickAt: NOW - 60_000, clockFrom: NOW - 3_600_000 }, NOW, gap)).toBe(
      NOW - 3_600_000,
    );
    expect(asks({ clockFrom: NOW - 10 * 60_000 })).toEqual([]);
    const watch = { x: { state: { actions: { 2: { action: "nudge", since: ago(90) } } }, marks: [] } };
    expect(asks({ heartbeats: [own({ lastEnd: ago(1) })], watch, clockFrom: NOW - 10 * 60_000 })).toEqual([]);
    expect(asks({ clockFrom: NOW - 31 * 60_000 })).toHaveLength(1);
  });

  it("several going quiet together raise one report and no question", () => {
    const y = sess({ name: "prd-y", pid: 200, topic: "y" });
    const yBeat = own({ session: "prd-y", pid: 200, lastEnd: ago(50), stoppedAt: ago(50) });
    const facts = { sessions: [sess(), y], heartbeats: [own(), yBeat] };
    const out = decide(facts);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "report", sessions: ["prd-x", "prd-y"] });
    expect(out[0].text).toContain("went quiet together");
    expect(decide({ ...facts, reported: [out[0].key] })).toEqual([]);
    // Quiet far apart: each its own question.
    const far = own({
      session: "prd-y",
      pid: 200,
      lastEnd: ago(200),
      stoppedAt: ago(200),
      lastStart: ago(200),
    });
    expect(asks({ ...facts, heartbeats: [own(), far] }).map((a) => a.session)).toEqual(["prd-x", "prd-y"]);
  });

  it("each answer does what it says", () => {
    expect(stuckAnswer(STUCK_OPTIONS[0])).toBe("rotate");
    expect(stuckAnswer("1")).toBe("rotate");
    expect(stuckAnswer(STUCK_OPTIONS[1])).toBe("leave");
    expect(stuckAnswer("who knows")).toBe("leave");
    const entry = (extra = {}) => ({ "prd-x": { pid: 100, since: 0, askId: "a1", ...extra } });
    const q = (extra = {}) => [{ id: "a1", topic: "x", kind: "question", session: STUCK_SESSION, ...extra }];
    expect(decide({ entries: entry(), asks: q({ answeredAt: ago(1), answer: STUCK_OPTIONS[0] }) })).toEqual([
      { type: "answered", session: "prd-x", answer: "rotate", askId: "a1" },
      { type: "rotate", session: "prd-x", pid: 100, topic: "x" },
    ]);
    expect(decide({ entries: entry(), asks: q({ answeredAt: ago(1), answer: STUCK_OPTIONS[1] }) })).toEqual([
      { type: "answered", session: "prd-x", answer: "leave", askId: "a1" },
    ]);
    expect(decide({ entries: entry(), asks: q({ doneAt: ago(1) }) })).toEqual([
      { type: "answered", session: "prd-x", answer: "leave", askId: "a1" },
    ]);
    expect(decide({ entries: entry({ answer: "leave" }) })).toEqual([]);
    expect(decide({ entries: entry({ answer: "rotate", triedAt: NOW - 60_000 }) })).toEqual([]);
    expect(decide({ entries: entry({ answer: "rotate", triedAt: NOW - LIMIT }) })).toEqual([
      { type: "rotate", session: "prd-x", pid: 100, topic: "x" },
    ]);
    // The stall over: its entry clears and its open question is dismissed.
    const active = own({ lastEnd: ago(1) });
    expect(decide({ heartbeats: [active], entries: entry(), asks: q() })).toEqual([
      { type: "clear", session: "prd-x", askId: "a1" },
    ]);
    expect(
      decide({ sessions: [sess({ pid: 101 })], heartbeats: [], entries: entry({ answer: "leave" }) }),
    ).toEqual([{ type: "clear", session: "prd-x", askId: null }]);
  });

  it("a paused dispatcher does nothing", () => {
    expect(decide({ paused: true })).toEqual([]);
  });

  it("counts a pnpm prd command under the session as running, a wait not", () => {
    const table = (args) =>
      new Map([
        [100, { ppid: 1, args: "claude pnpm prd land x" }],
        [101, { ppid: 100, args: "bash -c x" }],
        [102, { ppid: 101, args }],
      ]);
    expect(busyUnder(100, table("pnpm prd land x"))).toBe(true);
    expect(busyUnder(100, table("bash scripts/loops/prd.sh check --quick"))).toBe(true);
    expect(busyUnder(100, table("pnpm prd watch x --wait"))).toBe(false);
    expect(busyUnder(100, table("pnpm prd ask --wait a3"))).toBe(false);
    expect(busyUnder(100, table("sleep 60"))).toBe(false);
  });
});

const ROTATE_SH = `#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/rotate.calls"
[[ ! -e $STUB_STATE/refuse ]] || { echo "rotate: plan has uncommitted changes" >&2; exit 1; }
echo "rotating"
`;

describe("the stuck tick", () => {
  let procs = [];
  const heartbeats = () => join(loops, ".heartbeat");
  const iso = (secs) => new Date(secs * 1000).toISOString();
  /** A live, managed, run-through orchestrator on a real process. */
  const liveOrchestrator = (script = "while :; do sleep 1; done", extra = {}) => {
    const child = spawn("bash", ["-c", script], { detached: true, stdio: "ignore" });
    procs.push(child);
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "prd-x.json"),
      JSON.stringify({
        pid: child.pid,
        kind: "prd",
        topic: "x",
        managed: true,
        auto: true,
        started: new Date().toISOString(),
        ...extra,
      }),
    );
    return child.pid;
  };
  const beat = (pid, lastSecs, file = "session.json", extra = {}) => {
    mkdirSync(join(heartbeats(), "prd-x"), { recursive: true });
    writeFileSync(
      join(heartbeats(), "prd-x", file),
      JSON.stringify({
        session: "prd-x",
        pid,
        agent: file === "session.json" ? null : file.replace(/\.json$/, ""),
        lastStart: iso(lastSecs),
        lastEnd: iso(lastSecs),
        stoppedAt: null,
        running: {},
        ...extra,
      }),
    );
  };
  const stuckAsks = () =>
    readdirSync(asks)
      .map((f) => askFile(f.replace(/\.json$/, "")))
      .filter((a) => a.session === STUCK_SESSION);
  const tryAsks = () => (existsSync(asks) ? stuckAsks() : []);

  beforeAll(() => writeFileSync(scripts("rotate.sh"), ROTATE_SH));
  beforeEach(() => {
    for (const d of [heartbeats(), join(loops, ".watch")]) rmSync(d, { recursive: true, force: true });
  });
  afterEach(() => {
    for (const c of procs)
      try {
        process.kill(-c.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    procs = [];
  });

  it("files one waiting question under its own session, pushes it, and asks once per stall", () => {
    const pid = liveOrchestrator();
    beat(pid, T0 - 40 * 60);
    expect(ok()).toContain("stuck: prd-x asked (");
    const [a] = stuckAsks();
    expect(a).toMatchObject({ kind: "question", topic: "x", options: STUCK_OPTIONS, defaults: false });
    expect(a.text).toContain("prd-x looks stuck");
    expect(openCalls().filter((c) => c.includes(HELPER_SESSION))).toHaveLength(1);
    expect(dstate().stuck.sessions["prd-x"]).toMatchObject({ pid, askId: a.id });
    setClock(T0 + 60);
    ok();
    // Never defaults, however long it waits.
    setClock(T0 + 24 * 3600);
    writeFileSync(
      join(loops, ".dispatch.json"),
      JSON.stringify({ ...dstate(), stuck: { ...dstate().stuck, lastTickAt: (T0 + 24 * 3600 - 60) * 1000 } }),
    );
    ok();
    expect(stuckAsks()).toHaveLength(1);
    expect(askFile(a.id).answeredAt).toBeFalsy();
  });

  it('rotates mid-wave on "rotate it now"; a refusal files one report', () => {
    const pid = liveOrchestrator();
    beat(pid, T0 - 40 * 60);
    ok();
    writeFileSync(join(state, "refuse"), "");
    answer(stuckAsks()[0].id, STUCK_OPTIONS[0]);
    setClock(T0 + 60);
    expect(ok()).toContain("stuck: rotating prd-x was refused");
    setClock(T0 + 120);
    ok();
    expect(calls("rotate")).toEqual(["x --mid-wave --reason stuck"]);
    const reports = stuckAsks().filter((a) => a.kind === "report");
    expect(reports).toHaveLength(1);
    expect(reports[0].text).toContain("its rotation was refused");
    rmSync(join(state, "refuse"));
    setClock(T0 + 60 + 30 * 60);
    writeFileSync(
      join(loops, ".dispatch.json"),
      JSON.stringify({ ...dstate(), stuck: { ...dstate().stuck, lastTickAt: (T0 + 30 * 60) * 1000 } }),
    );
    expect(ok()).toContain("stuck: prd-x rotating");
    expect(calls("rotate")).toHaveLength(2);
    expect(stuckAsks().filter((a) => a.kind === "report")).toHaveLength(1);
  });

  it('"leave it" leaves that stall alone; a stall that ends clears it', () => {
    const pid = liveOrchestrator();
    beat(pid, T0 - 40 * 60);
    ok();
    answer(stuckAsks()[0].id, STUCK_OPTIONS[1]);
    setClock(T0 + 60);
    expect(ok()).toContain("means leave it for prd-x");
    setClock(T0 + 120);
    ok();
    expect(calls("rotate")).toEqual([]);
    expect(stuckAsks()).toHaveLength(1);
    beat(pid, T0 + 100);
    setClock(T0 + 180);
    expect(ok()).toContain("stuck: prd-x cleared");
    expect(dstate().stuck.sessions["prd-x"]).toBeUndefined();
  });

  it("asks about one whose only command under it is watch --wait; a pnpm prd command holds it", async () => {
    const waiting = liveOrchestrator(`bash -c "while :; do sleep 1; done # pnpm prd watch x --wait"; true`);
    beat(waiting, T0 - 40 * 60);
    await until(() => {
      try {
        return execFileSync("pgrep", ["-P", String(waiting)], { encoding: "utf8" }).trim() !== "";
      } catch {
        return false;
      }
    });
    expect(ok()).toContain("stuck: prd-x asked");
    for (const c of procs) process.kill(-c.pid, "SIGKILL");
    procs = [];
    rmSync(join(loops, ".dispatch.json"), { force: true });
    rmSync(asks, { recursive: true, force: true });
    const landing = liveOrchestrator(`bash -c "while :; do sleep 1; done # pnpm prd land x"; true`);
    beat(landing, T0 - 40 * 60);
    await until(() => {
      try {
        return execFileSync("pgrep", ["-P", String(landing)], { encoding: "utf8" }).trim() !== "";
      } catch {
        return false;
      }
    });
    expect(ok()).not.toContain("stuck:");
    expect(tryAsks()).toEqual([]);
  });

  it("asks about a hung slice agent's session and a watch action left unhandled, from their files", () => {
    const pid = liveOrchestrator();
    beat(pid, T0 - 40 * 60);
    beat(pid, T0 - 90 * 60, "a1.json", { running: { t1: { tool: "Bash", at: iso(T0 - 90 * 60) } } });
    expect(ok()).toContain("stuck: prd-x asked");
    rmSync(join(loops, ".dispatch.json"), { force: true });
    rmSync(asks, { recursive: true, force: true });
    beat(pid, T0 - 60);
    mkdirSync(join(loops, ".watch", "x"), { recursive: true });
    writeFileSync(
      join(loops, ".watch", "x", "state.json"),
      JSON.stringify({ actions: { 2: { action: "restart", since: iso(T0 - 35 * 60) } } }),
    );
    expect(ok()).toContain("stuck: prd-x asked");
    expect(stuckAsks()[0].text).toContain("slice 2's watch action (restart)");
  });

  it("leaves alone a recent agent, no heartbeat ever, a session opened by hand, and a paused dispatcher", () => {
    let pid = liveOrchestrator();
    beat(pid, T0 - 40 * 60);
    beat(pid, T0 - 5 * 60, "a1.json");
    expect(ok()).not.toContain("stuck:");
    rmSync(heartbeats(), { recursive: true, force: true });
    expect(ok()).not.toContain("stuck:");
    pid = liveOrchestrator(undefined, { managed: false });
    beat(pid, T0 - 40 * 60);
    expect(ok()).not.toContain("stuck:");
    pid = liveOrchestrator();
    beat(pid, T0 - 40 * 60);
    ok(["--pause", "t"]);
    setClock(T0 + 60);
    expect(ok()).not.toContain("stuck:");
    expect(tryAsks()).toEqual([]);
    // A paused tick writes nothing, its clocks neither.
    expect(dstate().stuck).toEqual({ lastTickAt: T0 * 1000, clockFrom: null });
  });

  it("a tick gap resets the clocks: the stall counts again from the wake", () => {
    const pid = liveOrchestrator();
    beat(pid, T0 - 40 * 60);
    writeFileSync(
      join(loops, ".dispatch.json"),
      JSON.stringify({ stuck: { lastTickAt: (T0 - 3600) * 1000 } }),
    );
    expect(ok()).not.toContain("stuck:");
    expect(dstate().stuck.clockFrom).toBe(T0 * 1000);
    setClock(T0 + 29 * 60);
    for (let t = 60; t <= 29 * 60; t += 290) {
      setClock(T0 + t);
      expect(ok()).not.toContain("stuck:");
    }
    setClock(T0 + 30 * 60);
    expect(ok()).toContain("stuck: prd-x asked");
  });

  it("several going quiet together raise one report and no question", () => {
    const pid = liveOrchestrator();
    beat(pid, T0 - 40 * 60);
    const child = spawn("bash", ["-c", "while :; do sleep 1; done"], { detached: true, stdio: "ignore" });
    procs.push(child);
    writeFileSync(
      join(sessions, "prd-y.json"),
      JSON.stringify({
        pid: child.pid,
        kind: "prd",
        topic: "y",
        managed: true,
        auto: true,
        started: new Date().toISOString(),
      }),
    );
    mkdirSync(join(heartbeats(), "prd-y"), { recursive: true });
    writeFileSync(
      join(heartbeats(), "prd-y", "session.json"),
      JSON.stringify({
        session: "prd-y",
        pid: child.pid,
        agent: null,
        lastEnd: iso(T0 - 45 * 60),
        running: {},
      }),
    );
    expect(ok()).toContain("stuck: reported prd-x, prd-y quiet together");
    setClock(T0 + 60);
    ok();
    const all = stuckAsks();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: "report" });
    expect(all[0].text).toContain("prd-x, prd-y went quiet together");
  });
});

describe("the drain", () => {
  let procs = [];
  const usageDir = () => join(loops, ".usage");
  const on = { RISA_USAGE_WATCH: "" };
  /** A current reading (by the fake clock) of the 5-hour window, from a session of its own. */
  const reading = (percent, resetSecs = T0 + 3600) => {
    mkdirSync(usageDir(), { recursive: true });
    writeFileSync(
      join(usageDir(), "reader.json"),
      JSON.stringify({
        session: "reader",
        windows: {
          fiveHour: {
            percent,
            at: new Date(T0 * 1000).toISOString(),
            resetsAt: new Date(resetSecs * 1000).toISOString(),
          },
        },
      }),
    );
  };
  const readingOf = (name) => JSON.parse(readFileSync(join(usageDir(), `${name}.json`), "utf8"));
  /** A live session on a real process (a bash loop standing in for claude). */
  const liveSession = (name, { managed = true, script = "while :; do sleep 0.2; done", ...extra } = {}) => {
    const child = spawn("bash", ["-c", script], { detached: true, stdio: "ignore" });
    procs.push(child);
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, `${name}.json`),
      JSON.stringify({ pid: child.pid, managed, started: new Date().toISOString(), ...extra }),
    );
    return child;
  };
  const gone = (child) => child.exitCode !== null || child.signalCode !== null;
  const drainAsks = () =>
    existsSync(asks)
      ? readdirSync(asks)
          .map((f) => askFile(f.replace(/\.json$/, "")))
          .filter((a) => a.session === "dispatch-usage")
      : [];

  beforeEach(() => {
    rmSync(usageDir(), { recursive: true, force: true });
    rmSync(join(loops, ".landing"), { recursive: true, force: true });
  });
  afterEach(() => {
    for (const c of procs)
      try {
        process.kill(-c.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    procs = [];
  });

  it("draining: no start, plan or reopen, and --resume doesn't override it; RISA_USAGE_WATCH=off does", () => {
    reading(96);
    worktree("d", "prd/d");
    deadRecord("prd-d", { kind: "prd", topic: "d" });
    setRows([
      { topic: "a", state: "planned" },
      { topic: "p", state: "to-write", waiting: 2 },
      { topic: "d", state: "running" },
    ]);
    const out = ok(["--once"], on);
    expect(out).toMatch(/^\S+Z nothing: usage is draining: 5h 96%, at or over the drain line 95% \(until /);
    expect(out).toContain("  a: no start while usage is draining");
    expect(out).toContain("  p: no plan while usage is draining");
    expect(out).toContain("  d: its orchestrator died; not reopened while usage is draining");
    expect(out).toContain("usage: now draining: 5h 96%");
    ok(["--resume"]);
    expect(ok(["--once"], on)).toMatch(/^\S+Z nothing: usage is draining/);
    expect(calls("new")).toEqual([]);
    expect(openCalls()).toEqual([]);
    expect(dstate().drain).toMatchObject({ state: "draining" });
    // Off: the reopen goes ahead.
    expect(ok(["--once"])).toMatch(/^\S+Z reopen prd-d/);
  });

  it("draining ends nothing, and a session in a landing is never stopped", () => {
    reading(96);
    const s = liveSession("prd-x", { kind: "prd", topic: "x" });
    const l = liveSession("prd-y", {
      kind: "prd",
      topic: "y",
      script: "exec -a land.sh bash -c 'while :; do sleep 0.2; done'",
    });
    ok(["--once"], on);
    expect(gone(s) || gone(l)).toBe(false);
    expect(existsSync(join(usageDir(), "prd-x.json"))).toBe(false);
  });

  it("limited: ends each managed session (marked stalled), one in a landing only after it finishes; reports the hand-opened once", async () => {
    reading(99);
    const x = liveSession("prd-x", { kind: "prd", topic: "x" });
    const kept = liveSession("backlog", { kind: "backlog" });
    // The landing: a land.sh under the session (as `pnpm prd land` runs it), until a file says stop.
    const stop = join(root, "landing-done");
    rmSync(stop, { force: true });
    writeFileSync(join(root, "land.sh"), `while [[ ! -e ${stop} ]]; do sleep 0.2; done\n`);
    const y = liveSession("prd-y", {
      kind: "prd",
      topic: "y",
      script: `bash ${join(root, "land.sh")}; while :; do sleep 0.2; done`,
    });
    const hand = liveSession("hotfix-h", { managed: false, kind: "hotfix" });
    const landing = () =>
      execFileSync("ps", ["-A", "-o", "args="], { encoding: "utf8" })
        .split("\n")
        .some((l) => l.trim() === `bash ${join(root, "land.sh")}`);
    await until(landing);

    const first = ok(["--once"], on);
    expect(first).toMatch(/^\S+Z nothing: usage is limited: 5h 99%, at or over the stop line 98%/);
    expect(first).toMatch(new RegExp(`usage limited: ended prd-x \\(pid ${x.pid}, TERM; marked stalled\\)`));
    expect(first).toContain("usage limited: ended backlog");
    expect(first).toContain(
      "usage limited: prd-y left running (it runs a landing: ended once that finishes)",
    );
    expect(first).toContain("usage limited: reported hotfix-h (opened by hand, never ended)");
    await until(() => gone(x) && gone(kept));
    expect(readingOf("prd-x").stalled).toMatchObject({
      error: "limited",
      pid: x.pid,
      resetsAt: new Date((T0 + 3600) * 1000).toISOString(),
    });
    expect(gone(y) || gone(hand)).toBe(false);
    const [report] = drainAsks();
    expect(report).toMatchObject({ kind: "report" });
    expect(report.text).toContain("never ends one opened by hand: hotfix-h is still live");

    // The next tick: the landing still runs, and the report isn't filed again.
    setClock(T0 + 60);
    expect(ok(["--once"], on)).toContain("prd-y left running");
    expect(drainAsks()).toHaveLength(1);
    expect(gone(y)).toBe(false);

    // Its landing over, the session is ended; the hand-opened one never is.
    writeFileSync(stop, "");
    await until(() => !landing());
    setClock(T0 + 120);
    expect(ok(["--once"], on)).toMatch(new RegExp(`usage limited: ended prd-y \\(pid ${y.pid}`));
    await until(() => gone(y));
    expect(gone(hand)).toBe(false);
    expect(drainAsks()).toHaveLength(1);
  });

  it("limited on overage, and a session that ignores TERM is killed a tick later", async () => {
    reading(100);
    const x = liveSession("prd-x", {
      kind: "prd",
      topic: "x",
      script: "trap '' TERM; while :; do sleep 0.2; done",
    });
    expect(ok(["--once"], on)).toMatch(/usage limited: ended prd-x/);
    setClock(T0 + 1);
    expect(ok(["--once"], on)).toContain("prd-x left running (sent TERM; waiting for it to end)");
    expect(gone(x)).toBe(false);
    setClock(T0 + 60);
    expect(ok(["--once"], on)).toContain(`usage limited: prd-x ignored TERM: killed it (pid ${x.pid})`);
    await until(() => gone(x));
  });

  it("nothing opens a claude while limited: no reopen ask's helper, keep-alive, session request or probe", () => {
    reading(99);
    const claudeCalls = join(state, "claude.calls");
    const claude = join(root, "claude-recording");
    writeFileSync(claude, `#!/usr/bin/env bash\necho "$*" >> ${claudeCalls}\n`);
    chmodSync(claude, 0o755);
    worktree("d", "prd/d");
    deadRecord("prd-d", { kind: "prd", topic: "d" });
    setRows([{ topic: "d", state: "running" }]);
    createRequest(join(loops, ".requests"), { name: "notes", now: T0 * 1000 });
    const extra = { ...on, RISA_CLAUDE_BIN: claude, RISA_KEEP_SESSIONS: "" };
    // Past the reopen limit: a normal tick would file an ask and open its helper.
    writeFileSync(join(loops, ".dispatch.json"), JSON.stringify({ reopens: { "prd-d": 2 } }));
    for (let t = 0; t < 3; t++) {
      setClock(T0 + 60 * t);
      ok(["--once"], extra);
    }
    expect(openCalls()).toEqual([]);
    expect(existsSync(claudeCalls)).toBe(false);
  });

  it("an unknown reading doesn't drain, and files one report while sessions are live", () => {
    liveSession("prd-x", { kind: "prd", topic: "x" });
    setRows([{ topic: "a", state: "planned" }]);
    const out = ok(["--once"], on);
    expect(out).toMatch(/^\S+Z start a:/);
    expect(out).toContain("usage: reported an unknown reading");
    setClock(T0 + 60);
    expect(ok(["--once"], on)).not.toContain("reported an unknown reading");
    const reports = drainAsks();
    expect(reports).toHaveLength(1);
    expect(reports[0].text).toContain("The usage reading is unknown");
  });

  describe("the resume after a limit", () => {
    /** A stall whose reset passed a minute ago (by the fake clock). */
    const stalled = (name, extra = {}) => {
      mkdirSync(usageDir(), { recursive: true });
      writeFileSync(
        join(usageDir(), `${name}.json`),
        JSON.stringify({
          session: name,
          windows: {},
          stalled: {
            at: new Date((T0 - 7200) * 1000).toISOString(),
            error: "limited",
            resetsAt: new Date((T0 - 60) * 1000).toISOString(),
            pid: 999_999,
            ...extra,
          },
        }),
      );
    };
    const claimed = () => dstate().resume?.claimed ?? {};
    const hasChild = (child) => {
      try {
        return execFileSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" }).trim() !== "";
      } catch {
        return false;
      }
    };

    it("reopens a stalled managed session with --continue and the carry-on prompt, one per tick, never counted", () => {
      reading(10);
      worktree("a", "prd/a");
      worktree("b", "prd/b");
      deadRecord("prd-a", { kind: "prd", topic: "a" });
      deadRecord("prd-b", { kind: "prd", topic: "b" });
      stalled("prd-a");
      stalled("prd-b");
      setRows([
        { topic: "a", state: "running" },
        { topic: "b", state: "running" },
        { topic: "n", state: "planned" },
      ]);
      // At the reopen limit: an ordinary reopen would be an ask.
      writeFileSync(join(loops, ".dispatch.json"), JSON.stringify({ reopens: { "prd-a": 2 } }));
      const first = ok(["--once"], on);
      expect(first).toMatch(
        /^\S+Z resume prd-a: stopped on a usage limit that has reset: --continue with the carry-on prompt \(not counted toward the reopen limit\)/,
      );
      expect(first).toContain("  n: waits a tick: the resume of prd-a goes first");
      expect(first).toContain(
        "  b: its orchestrator stopped on a usage limit: the resume brings it back (not counted)",
      );
      expect(first).toContain("resume: claimed prd-a (stalled on a limit, limited; its reset has passed)");
      expect(first).toContain("resume: prd-b waits (one resume a tick: prd-a first)");
      expect(openCalls()).toEqual([["a", "--background", "--carry-on"]]);
      expect(calls("new")).toEqual([]);
      expect(dstate().reopens).toEqual({ "prd-a": 2 });
      expect(Object.keys(claimed())).toEqual(["prd-b"]);
      expect(readingOf("prd-a").stalled).toBeUndefined();
      expect(readingOf("prd-b").stalled).toBeUndefined();
      expect(drainAsks()).toEqual([]);

      // The next tick: prd-a is up; prd-b's turn, still uncounted.
      liveSession("prd-a", { kind: "prd", topic: "a" });
      setClock(T0 + 60);
      expect(ok(["--once"], on)).toMatch(/^\S+Z resume prd-b:/);
      expect(openCalls()).toEqual([
        ["a", "--background", "--carry-on"],
        ["b", "--background", "--carry-on"],
      ]);
      expect(claimed()).toEqual({});
      // prd-b's resume added no count (prd-a's went with its recovery: live for REOPEN_RESET_MS).
      expect(dstate().reopens?.["prd-b"]).toBeUndefined();

      // Nothing left: the pick goes on as usual.
      liveSession("prd-b", { kind: "prd", topic: "b" });
      setClock(T0 + 120);
      expect(ok(["--once"], on)).toMatch(/^\S+Z start n:/);
    });

    it("waits until the reset, and a tab that never opens keeps the claim", () => {
      reading(10);
      worktree("a", "prd/a");
      deadRecord("prd-a", { kind: "prd", topic: "a" });
      setRows([{ topic: "a", state: "running" }]);
      stalled("prd-a", { resetsAt: new Date((T0 + 600) * 1000).toISOString() });
      const before = ok(["--once"], on);
      expect(before).toMatch(/^\S+Z nothing: usage is limited: stopped on a limit: prd-a/);
      expect(openCalls()).toEqual([]);
      setClock(T0 + 660);
      const failed = ok(["--once"], { ...on, STUB_OPEN_FAIL: "--carry-on" });
      expect(failed).toMatch(/^\S+Z resume prd-a:/);
      expect(failed).toMatch(/prd-a: its tab never opened .*a later tick retries/);
      expect(Object.keys(claimed())).toEqual(["prd-a"]);
      setClock(T0 + 720);
      expect(ok(["--once"], on)).toMatch(/^\S+Z resume prd-a:/);
      expect(openCalls()).toHaveLength(2);
      expect(dstate().reopens ?? {}).toEqual({});
    });

    it("leaves alone a session in a pnpm prd command or with a landing marker; ends a live one, then resumes it", async () => {
      reading(10);
      for (const t of ["a", "b", "c"]) worktree(t, `prd/${t}`);
      setRows(["a", "b", "c"].map((topic) => ({ topic, state: "running" })));
      const busy = liveSession("prd-a", {
        kind: "prd",
        topic: "a",
        script: `bash -c "while :; do sleep 0.2; done # pnpm prd check x"; true`,
      });
      await until(() => hasChild(busy));
      deadRecord("prd-b", { kind: "prd", topic: "b" });
      mkdirSync(join(loops, ".landing"), { recursive: true });
      writeFileSync(
        join(loops, ".landing", "prd-b.json"),
        JSON.stringify({ branch: "prd/b", path: "pr", step: "dev-sync", tip: "abc", pid: 999_999 }),
      );
      const idle = liveSession("prd-c", { kind: "prd", topic: "c" });
      for (const n of ["prd-a", "prd-b", "prd-c"]) stalled(n, { pid: null });

      const first = ok(["--once"], on);
      expect(first).toContain("resume: prd-a waits (it runs a pnpm prd command)");
      expect(first).toContain("resume: prd-b waits (it has a landing marker: a landing first)");
      expect(first).toMatch(
        new RegExp(`resume: ended prd-c \\(pid ${idle.pid}, TERM\\): resumed once it has ended`),
      );
      expect(openCalls()).toEqual([]);
      await until(() => gone(idle));
      expect(gone(busy)).toBe(false);

      setClock(T0 + 60);
      const second = ok(["--once"], on);
      expect(second).toMatch(/^\S+Z resume prd-c:/);
      expect(second).toContain("resume: prd-a waits (it runs a pnpm prd command)");
      expect(second).toContain("resume: prd-b waits (it has a landing marker: a landing first)");
      expect(openCalls()).toEqual([["c", "--background", "--carry-on"]]);
      expect(gone(busy)).toBe(false);
      expect(Object.keys(claimed()).sort()).toEqual(["prd-a", "prd-b"]);
    });

    it("a hand-opened session is only reported, once", () => {
      reading(10);
      worktree("h", "prd/h");
      setRows([{ topic: "h", state: "running" }]);
      const hand = liveSession("prd-h", { managed: false, kind: "prd", topic: "h" });
      stalled("prd-h", { error: "rate_limit", pid: hand.pid });
      const out = ok(["--once"], on);
      expect(out).toContain("resume: reported prd-h (opened by hand, never resumed)");
      setClock(T0 + 60);
      expect(ok(["--once"], on)).not.toContain("resume:");
      expect(openCalls()).toEqual([]);
      expect(gone(hand)).toBe(false);
      const reports = drainAsks();
      expect(reports).toHaveLength(1);
      expect(reports[0].text).toMatch(
        /^prd-h stopped on a usage limit that has now reset\. .*never one opened by hand/,
      );
      expect(claimed()).toEqual({});
    });

    it("--dry-run claims, clears and opens nothing", () => {
      reading(10);
      worktree("a", "prd/a");
      deadRecord("prd-a", { kind: "prd", topic: "a" });
      setRows([{ topic: "a", state: "running" }]);
      stalled("prd-a");
      const out = ok(["--dry-run"], on);
      expect(out).toMatch(/^resume prd-a:/);
      expect(out).toContain("resume: would claim prd-a");
      expect(openCalls()).toEqual([]);
      expect(readingOf("prd-a").stalled).toBeTruthy();
      expect(existsSync(join(loops, ".dispatch.json"))).toBe(false);
    });
  });
});
