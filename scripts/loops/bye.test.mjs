// `pnpm prd bye` (bye.mjs): the pure verdict, then the command against a
// throwaway repo (with a bare origin) with the scripts copied in, a stub
// claude (CARETOOK_CLAUDE_BIN, named claude-stub so no walk up finds a real
// claude) and temporary sessions, asks, notices and lease folders. Nothing here
// touches the real main checkout, origin or asks queue, and the only processes
// it signals are ones it started.
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAsk, dismissAsk, getAsk } from "./asks.mjs";
import { byeLines, byeVerdict } from "./bye.mjs";
import { createNotice } from "./notices.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();

/** Facts for a clean prd session, with overrides. */
const facts = (over = {}) => ({
  role: "prd",
  name: "prd-w",
  topic: "w",
  sessionPid: 100,
  recorded: true,
  worktree: null,
  left: { worktrees: [], branches: [] },
  leases: [],
  jobs: [],
  asks: [],
  notices: [],
  ...over,
});
const tree = (over = {}) => ({
  path: "/r/.loops/w",
  branch: "prd/w",
  dirty: [],
  unpushed: 0,
  stack: false,
  server: false,
  ...over,
});

describe("the verdict", () => {
  it("is clean with nothing open, and releases the session's own and dead leases", () => {
    const own = {
      kind: "check",
      n: "1",
      path: "/l/check/1",
      worktree: "w",
      check: "x",
      pid: 100,
      alive: true,
    };
    const dead = { ...own, n: "2", path: "/l/check/2", pid: 7, alive: false };
    const v = byeVerdict(facts({ worktree: tree(), leases: [own, dead] }));
    expect(v.clean).toBe(true);
    expect(v.open).toEqual([]);
    expect(v.release.map((l) => l.path)).toEqual(["/l/check/1", "/l/check/2"]);
    expect(byeLines(facts(), v)).toEqual([
      "bye: prd-w (prd) is clean: nothing open; released 2 leases.",
      "Hand-off: the session ends now; say nothing after this.",
    ]);
    expect(byeLines(facts(), v, { dryRun: true })).toEqual([
      "bye: prd-w (prd) is clean: nothing open (dry run: nothing released or ended).",
    ]);
  });

  it("lists every open thing, each with how to clear it", () => {
    const f = facts({
      worktree: tree({ dirty: ["a.ts", "b.ts"], unpushed: 2, stack: true, server: true }),
      left: { worktrees: ["/r/.loops/w-1"], branches: ["slice/w/2"] },
      leases: [
        { kind: "browser", n: "1", path: "/l/b/1", worktree: "w", check: "roundtrip", pid: 9, alive: true },
      ],
      jobs: [{ pid: 12, args: "bash -c sleep 30" }],
      asks: [{ id: "a4", text: "Which one?" }],
    });
    const v = byeVerdict(f);
    expect(v.clean).toBe(false);
    expect(v.release).toEqual([]);
    expect(v.open.map((o) => o.what)).toEqual([
      "uncommitted work",
      "unpushed commits",
      "a stack still up",
      "a dev server running",
      "a worktree still out",
      "a branch not merged into the trunk",
      "a browser lease held",
      "a background job running",
      "an open question it filed",
    ]);
    const lines = byeLines(f, v);
    expect(lines[0]).toBe("bye: prd-w (prd) has 9 open things; nothing was closed:");
    expect(lines).toContain(
      "  1. uncommitted work: 2 files in /r/.loops/w (a.ts, b.ts) (commit it, or drop it on the user's word)",
    );
    expect(lines).toContain(
      "  2. unpushed commits: 2 commits on prd/w on no remote and not in the trunk (push or land them (pnpm prd pr / land), or hand them off)",
    );
    expect(lines).toContain(
      "  9. an open question it filed: a4: Which one? (wait for the answer, or dismiss it (pnpm prd asks --done a4))",
    );
    expect(lines.at(-1)).toContain(
      "Ask the user about each, one at a time: finish it, hand it off or drop it",
    );
  });

  it("lists notices to read without blocking, and a slice ends nothing", () => {
    const f = facts({ role: "slice", name: "w-1", notices: [{ id: "n3", session: "prd-x", text: "sync" }] });
    const v = byeVerdict(f);
    expect(v.clean).toBe(true);
    expect(byeLines(f, v)).toEqual([
      "Notices for w to read first (none blocks):",
      "  n3 (prd-x): sync",
      "bye: w-1 (slice) is clean: nothing open.",
      "A slice has no session of its own to end: send your hand-off message now, and nothing after it.",
    ]);
  });
});

// The stub claude: records itself (when STUB_NAME is set) and its pid, takes a
// lease as itself (STUB_LEASE) and starts a background job (STUB_JOB), then runs
// bye in STUB_CWD in the background and waits for it, so a TERM lands at once.
const STUB = `#!/usr/bin/env bash
mkdir -p "$STUB_STATE"
echo "$$" > "$STUB_STATE/pid"
[[ -z \${STUB_NAME:-} ]] || node "$SESSIONS_MJS" set "$STUB_NAME" pid=$$ kind="$STUB_KIND" topic="\${STUB_TOPIC:-}" started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [[ -n \${STUB_LEASE:-} ]]; then
  mkdir -p "$CARETOOK_LEASE_ROOT/check/1"
  printf 'kind=check\\nworktree=%s\\ncheck=stub\\npid=%s\\ncmd=claude-stub\\nstarted=1\\n' "$STUB_LEASE" "$$" > "$CARETOOK_LEASE_ROOT/check/1/name"
fi
[[ -z \${STUB_JOB:-} ]] || { bash -c 'sleep 30; true' & }
trap 'touch "$STUB_STATE/ended"; exit 143' TERM
cd "$STUB_CWD"
bash "$PRD_SH" bye \${STUB_ARGS:-} > "$STUB_STATE/out" 2>&1 &
wait $!
echo "$?" > "$STUB_STATE/code"
`;

let root, main, origin, loops, state, stub, env, leaseRoot, asksDir, noticesDir;
const scripts = (f) => join(main, "scripts/loops", f);

/** Runs the stub to its end: the bye output, its exit code (null when the session was ended) and whether it was ended. */
function bye(extra = {}) {
  const child = spawn(stub, [], { env: { ...env, ...extra }, stdio: "ignore" });
  return new Promise((resolve) =>
    child.on("close", () => {
      const read = (f) => (existsSync(join(state, f)) ? readFileSync(join(state, f), "utf8") : null);
      resolve({ out: read("out") ?? "", code: read("code")?.trim() ?? null, ended: read("ended") !== null });
    }),
  );
}
const until = async (what, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bye-test-")));
  main = join(root, "repo");
  origin = join(root, "origin.git");
  loops = join(main, ".loops");
  state = join(root, "state");
  leaseRoot = join(root, "lease");
  asksDir = join(root, "asks");
  noticesDir = join(root, "notices");
  const bin = join(root, "bin");
  mkdirSync(bin);
  stub = join(bin, "claude-stub");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  execFileSync("git", ["init", "-q", "-b", "dev", main]);
  execFileSync("git", ["init", "-q", "--bare", origin]);
  for (const [k, v] of [
    ["user.email", "test@example.com"],
    ["user.name", "Test"],
    ["commit.gpgsign", "false"],
  ])
    git(main, "config", k, v);
  mkdirSync(join(main, "scripts/loops"), { recursive: true });
  for (const f of [
    "prd.sh",
    "lib.sh",
    "bye.mjs",
    "sessions.mjs",
    "asks.mjs",
    "notices.mjs",
    "end-session.sh",
  ])
    copyFileSync(join(HERE, f), scripts(f));
  mkdirSync(join(main, "plans"));
  writeFileSync(join(main, "plans/backlog.md"), "# Backlog\n");
  writeFileSync(join(main, "notes.md"), "mine\n");
  writeFileSync(join(main, ".gitignore"), ".loops/\n.env.loop\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "--no-verify", "-m", "chore: init");
  git(main, "remote", "add", "origin", origin);
  git(main, "push", "-q", "origin", "dev");
  env = {
    ...process.env,
    TRUNK: "dev",
    CARETOOK_CLAUDE_BIN: stub,
    CARETOOK_SESSIONS_DIR: join(loops, ".sessions"),
    CARETOOK_ASKS_DIR: asksDir,
    CARETOOK_NOTICES_DIR: noticesDir,
    CARETOOK_LEASE_ROOT: leaseRoot,
    CARETOOK_END_WAIT: "5",
    CARETOOK_SESSION: "",
    STUB_STATE: state,
    STUB_CWD: main,
    PRD_SH: scripts("prd.sh"),
    SESSIONS_MJS: scripts("sessions.mjs"),
  };
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  for (const d of [state, leaseRoot, asksDir, noticesDir, join(loops, ".sessions")])
    rmSync(d, { recursive: true, force: true });
});

describe("pnpm prd bye", () => {
  it("a clean session prints its hand-off line, releases its leases and ends", async () => {
    createNotice(noticesDir, {
      text: "landed x: sync at your next wave boundary",
      session: "prd-x",
      topic: "w",
    });
    const r = await bye({ STUB_NAME: "prd-w", STUB_KIND: "prd", STUB_TOPIC: "w", STUB_LEASE: "w" });
    expect(r.ended).toBe(true);
    expect(r.code).toBeNull();
    expect(r.out).toContain("Notices for w to read first (none blocks):");
    expect(r.out).toContain("bye: prd-w (prd) is clean: nothing open; released 1 lease.");
    expect(r.out).toContain("Hand-off: the session ends now; say nothing after this.");
    expect(r.out).toMatch(/Ending prd-w \(pid \d+, from its record\)\./);
    expect(existsSync(join(leaseRoot, "check/1"))).toBe(false);
  });

  it("--dry-run on a clean session releases and ends nothing", async () => {
    const r = await bye({
      STUB_NAME: "prd-w",
      STUB_KIND: "prd",
      STUB_TOPIC: "w",
      STUB_LEASE: "w",
      STUB_ARGS: "--dry-run",
    });
    expect(r.ended).toBe(false);
    expect(r.code).toBe("0");
    expect(r.out).toContain("bye: prd-w (prd) is clean: nothing open (dry run: nothing released or ended).");
    expect(existsSync(join(leaseRoot, "check/1/name"))).toBe(true);
  });

  it("lists each open thing and closes nothing; once they're cleared a second run closes", async () => {
    const wt = join(loops, "w");
    git(main, "worktree", "add", "-q", "-b", "prd/w", wt, "dev");
    writeFileSync(join(wt, "done.md"), "work\n");
    git(wt, "add", "done.md");
    git(wt, "commit", "-q", "--no-verify", "-m", "feat(w): done");
    writeFileSync(join(wt, "draft.md"), "half done\n");
    // A check another process runs for the worktree.
    const holder = spawn("sleep", ["30"], { stdio: "ignore" });
    mkdirSync(join(leaseRoot, "check/2"), { recursive: true });
    writeFileSync(
      join(leaseRoot, "check/2/name"),
      `kind=check\nworktree=w\ncheck=pnpm check\npid=${holder.pid}\ncmd=sleep\nstarted=1\n`,
    );
    const ask = createAsk(asksDir, {
      kind: "question",
      topic: "w",
      text: "Which tier?",
      session: "prd-w",
      options: ["a", "b"],
    });
    createAsk(asksDir, {
      kind: "question",
      topic: "w",
      text: "Someone else's",
      session: "prd-x",
      options: ["a", "b"],
    });
    const head = git(wt, "rev-parse", "HEAD");

    const session = { STUB_NAME: "prd-w", STUB_KIND: "prd", STUB_TOPIC: "w", STUB_CWD: wt };
    const r = await bye({ ...session, STUB_JOB: "1" });
    expect(r.ended).toBe(false);
    expect(r.code).toBe("3");
    expect(r.out).toContain("bye: prd-w (prd) has 6 open things; nothing was closed:");
    expect(r.out).toContain(`uncommitted work: 1 file in ${wt} (draft.md)`);
    expect(r.out).toContain("unpushed commits: 1 commit on prd/w on no remote and not in the trunk");
    expect(r.out).toContain(`a worktree still out: ${wt}`);
    expect(r.out).toContain(`a check lease held: w: pnpm check (pid ${holder.pid})`);
    expect(r.out).toMatch(/a background job running: pid \d+: bash -c sleep 30; true/);
    expect(r.out).toContain(`an open question it filed: ${ask.id}: Which tier?`);
    expect(r.out).not.toContain("Someone else's");
    // Nothing was discarded or released.
    expect(readFileSync(join(wt, "draft.md"), "utf8")).toBe("half done\n");
    expect(git(wt, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(leaseRoot, "check/2/name"))).toBe(true);
    expect(getAsk(asksDir, ask.id).doneAt).toBeNull();

    // Clear them: finish the draft, land and push, remove the worktree, let the check end, dismiss the ask.
    git(wt, "add", "draft.md");
    git(wt, "commit", "-q", "--no-verify", "-m", "feat(w): draft");
    git(main, "merge", "-q", "--ff-only", "prd/w");
    git(main, "push", "-q", "origin", "dev");
    git(main, "worktree", "remove", wt);
    git(main, "branch", "-q", "-d", "prd/w");
    holder.kill("SIGTERM");
    await until(() => holder.exitCode !== null || holder.signalCode !== null);
    dismissAsk(asksDir, ask.id);
    rmSync(state, { recursive: true, force: true });
    const again = await bye({ ...session, STUB_CWD: main });
    expect(again.out).toContain("bye: prd-w (prd) is clean: nothing open; released 1 lease.");
    expect(again.ended).toBe(true);
    expect(existsSync(join(leaseRoot, "check/2"))).toBe(false);
  });

  it("a slice reports only: it never ends the claude it runs under, and its stack is open", async () => {
    const wt = join(loops, "w-1");
    git(main, "worktree", "add", "-q", "-b", "slice/w/1", wt, "dev");
    const session = { STUB_NAME: "prd-w", STUB_KIND: "prd", STUB_TOPIC: "w", STUB_CWD: wt };
    const r = await bye(session);
    expect(r.ended).toBe(false);
    expect(r.code).toBe("0");
    expect(r.out).toContain("bye: w-1 (slice) is clean: nothing open.");
    expect(r.out).toContain("send your hand-off message now");

    writeFileSync(join(wt, ".env.loop"), "SLOT=3\n"); // (ignored, as in the repo)
    rmSync(state, { recursive: true, force: true });
    const up = await bye(session);
    expect(up.code).toBe("3");
    expect(up.out).toContain(`a stack still up: ${wt} (pnpm prd stack down)`);
    expect(up.ended).toBe(false);
    git(main, "worktree", "remove", "--force", wt);
  });

  it("a backlog session counts only the backlog files in the main checkout", async () => {
    const session = { STUB_NAME: "backlog", STUB_KIND: "backlog" };
    writeFileSync(join(main, "notes.md"), "the user's own edit\n");
    const r = await bye({ ...session, STUB_ARGS: "--dry-run" });
    expect(r.code).toBe("0");
    expect(r.out).toContain("bye: backlog (backlog) is clean");
    writeFileSync(join(main, "plans/backlog.md"), "# Backlog\n\n- half written\n");
    rmSync(state, { recursive: true, force: true });
    const dirty = await bye({ ...session, STUB_ARGS: "--dry-run" });
    expect(dirty.code).toBe("3");
    expect(dirty.out).toContain(`uncommitted work: 1 file in ${main} (plans/backlog.md)`);
    git(main, "checkout", "--", "plans/backlog.md", "notes.md");
  });
});
