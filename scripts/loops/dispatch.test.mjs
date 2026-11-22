// The dispatcher (`pnpm prd dispatch`: dispatch.mjs) against a throwaway repo
// with the dispatcher and its modules copied in, and stubs for the rest: the
// worktree command (new.sh), the opener (open-session.sh), tidy (tidy-cli.mjs)
// and the backlog command (backlog.mjs, its registry rows a JSON file), a stub
// claude (CARETOOK_CLAUDE_BIN), osascript, a load file and a clock file.
// Nothing here starts a real claude, opens a tab or reads the real load.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAsk, getAsk } from "./asks.mjs";
import { ROTATING_GRACE_MS } from "./dispatch-pick.mjs";
import {
  HELPER_SESSION,
  REOPEN_RESET_MS,
  TIDY_EVERY_MS,
  answerAction,
  helperLine,
  sessionLine,
  tidyDue,
} from "./dispatch.mjs";

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

// The stubs. Each records its arguments, one call per line, in $STUB_STATE.
const NEW_SH = `#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/new.calls"
[[ -z \${STUB_NEW_FAIL:-} ]] || { echo "no room" >&2; exit 1; }
echo "made $2"
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
  const rows = JSON.parse(readFileSync(file, "utf8"));
  const row = rows.find((r) => r.topic === topic);
  for (const w of kv) if (w.startsWith("flags=")) row.flags = w.slice(6).split(",").filter(Boolean);
  writeFileSync(file, JSON.stringify(rows));
} else process.exit(2);
`;

let root, main, loops, sessions, asks, state, env, clock, rowsFile;
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
    env: { ...env, CARETOOK_ASKS_DIR: asks },
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
    "context.mjs",
    "keep-alive.mjs",
    "asks.mjs",
    "ask.mjs",
    "sessions.mjs",
    "load-gate.mjs",
  ])
    copyFileSync(join(HERE, f), scripts(f));
  writeFileSync(scripts("new.sh"), NEW_SH);
  writeFileSync(scripts("open-session.sh"), OPEN_SH);
  writeFileSync(scripts("tidy-cli.mjs"), TIDY);
  writeFileSync(join(main, "scripts/backlog/backlog.mjs"), BACKLOG);
  writeFileSync(join(main, ".gitignore"), ".loops/\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "chore: init");
  writeFileSync(join(root, "load"), "1 1 1");
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CARETOOK_CLAUDE_BIN: join(bin, "claude-stub"),
    CARETOOK_ITERM_APP: join(root, "iTerm.app"),
    CARETOOK_SESSIONS_DIR: "",
    CARETOOK_ASKS_DIR: "",
    CARETOOK_ASK_NOTIFY: "",
    CARETOOK_LOAD_FILE: join(root, "load"),
    CARETOOK_LOAD_BUSY: "8",
    CARETOOK_LOAD_GATE: "",
    CARETOOK_MAX_PRDS: "",
    CARETOOK_MAX_PLANNERS: "",
    CARETOOK_FIXES_MIN: "",
    CARETOOK_CLOCK_FILE: clock,
    // Off unless a test turns it on, and never the machine's real processes.
    CARETOOK_KEEP_SESSIONS: "off",
    CARETOOK_PROCESS_FILE: join(root, "processes"),
    STUB_STATE: state,
    STUB_ROWS: rowsFile,
  };
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  for (const d of [state, sessions, asks]) rmSync(d, { recursive: true, force: true });
  for (const f of [".dispatch.json", ".dispatch.log", ".dispatch.lock"])
    rmSync(join(loops, f), { force: true });
  for (const w of existsSync(loops) ? readdirSync(loops) : [])
    if (!w.startsWith(".")) git(main, "worktree", "remove", "--force", join(loops, w));
  for (const b of git(main, "branch", "--format=%(refname:short)").split("\n"))
    if (b && b !== "dev") git(main, "branch", "-q", "-D", b);
  mkdirSync(state, { recursive: true });
  setClock(T0);
  setRows([]);
  writeFileSync(join(root, "processes"), "");
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

  it("a failed worktree opens nothing", () => {
    setRows([{ topic: "a", state: "planned" }]);
    const out = ok(["--once"], { STUB_NEW_FAIL: "1" });
    expect(out).toContain("new.sh prd a: failed (exit 1): no room");
    expect(openCalls()).toEqual([]);
    expect(existsSync(join(sessions, "prd-a.json"))).toBe(false);
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

  it("--dry-run prints the pick and writes and opens nothing", () => {
    setRows([
      { topic: "a", state: "planned" },
      { topic: "b", state: "planned" },
    ]);
    const out = ok(["--dry-run"], { CARETOOK_ITERM_APP: join(root, "nowhere") });
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
    const r = dispatch(["--once"], { CARETOOK_ITERM_APP: join(root, "nowhere") });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("dispatch needs iTerm2");
    expect(calls("new")).toEqual([]);
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
    expect(helper[1]).toContain(`${env.CARETOOK_CLAUDE_BIN} --model haiku --remote-control dispatch-push`);
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
    expect(calls("backlog")).toEqual(["prd set a flags=hold"]);
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
      env: { ...env, CARETOOK_ASKS_DIR: asks },
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

describe("the keep-alive tick", () => {
  const on = { CARETOOK_KEEP_SESSIONS: "on" };
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
    const out = ok(["--once"], { ...on, CARETOOK_MAX_PRDS: "1" });
    expect(out).toContain("start a:");
    expect(keptOpens()).toHaveLength(1);
    expect(calls("new")).toEqual(["prd a"]);
  });

  it("counts an unrecorded --remote-control backlog process as live", () => {
    writeFileSync(join(root, "processes"), "claude-stub --model opus --remote-control backlog You are\n");
    ok(["--once"], on);
    expect(keptOpens()).toEqual([]);
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
      env: { ...env, CARETOOK_ASKS_DIR: asks },
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
