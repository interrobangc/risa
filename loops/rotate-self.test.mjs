// `pnpm prd rotate --self` and the inbox session, against rotate-fixture.mjs's
// throwaway repo and stub claude.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASE, scaledWait } from "./test-limits.mjs";
import {
  ADMIRALS,
  shown,
  git,
  root,
  main,
  loops,
  state,
  stub,
  env,
  wt,
  sessions,
  tabEnv,
  scripts,
  record,
  stubPid,
  stateFile,
  run,
  start,
  until,
  printedLine,
  useRotateRepo,
} from "./rotate-fixture.mjs";

// The limits follow the load as this file starts, not only as the run did (RISA-994).
vi.setConfig({ testTimeout: scaledWait(BASE.testTimeout), hookTimeout: scaledWait(BASE.hookTimeout) });
useRotateRepo();
// A test that failed or timed out leaves its stub sessions running, and they write the shared
// state folder (ready, rotate.out) under the next test's feet: a cascade of false failures. End
// whatever of this file's repo still runs once each test is done.
afterEach(() => {
  spawnSync("pkill", ["-KILL", "-f", `${root}/`]);
});

describe("pnpm prd rotate --self", () => {
  const briefs = () => join(loops, ".briefs");
  const briefFile = (name = "backlog") => join(briefs(), `${name}.md`);
  /** A recorded session that runs `rotate --self` from inside itself, then stays up. */
  const selfSession = async (
    name,
    { args = "", cwd = main, claude = ["--model", "sonnet"], remote = name, extra = {}, wait = 10_000 } = {},
  ) => {
    const s = start(
      "bash",
      [scripts("session.sh"), name, "--", ...claude, "--remote-control", remote, "x"],
      { STUB_MODE: "self", STUB_STAY: "1", STUB_NAME: name, STUB_ARGS: args, ...extra },
      cwd,
    );
    await until(() => existsSync(join(state, "ready")), wait);
    return { s, pid: stubPid(), out: stateFile("rotate.out"), code: stateFile("rotate.code").trim() };
  };
  const finish = async ({ s, pid }) => {
    process.kill(pid, "SIGTERM");
    await s.done;
  };
  const runInto = (line, name = "backlog") =>
    spawnSync("bash", ["-c", line], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, STUB_MODE: "exit", STUB_NAME: name },
    });
  /** The new session's args: flags first, the prompt as the rest. */
  const newArgs = () => stateFile("args").split("\n");
  // The prompt follows the names session.sh passes: --remote-control, then --name.
  const promptOf = (args) => args.slice(args.indexOf("--name") + 2).join("\n");

  beforeEach(() => rmSync(briefs(), { recursive: true, force: true }));

  // The file's first rotation runs every script cold (about three times the others' start in a
  // full run): twice the scaled limits, for the test and for its wait on the session.
  it(
    "ends the main backlog session and opens one of the same name and model, as a new captain, with no brief",
    async () => {
      const old = await selfSession("backlog", { remote: "Archer", wait: 20_000 });
      expect(old.code).toBe("0");
      const captain = /^Rotating backlog: pid \d+ \(the calling session\), as ([A-Za-z]+)\.$/m.exec(
        old.out,
      )?.[1];
      expect(ADMIRALS).toContain(captain);
      expect(captain).not.toBe("Archer");
      // The tab is titled with the captain.
      expect(old.out).toContain(`to open ${captain} (its command):`);
      const line = printedLine(old.out);
      expect(line).toBe(`cd ${main} && ${scripts("rotate-into.sh")} backlog ${old.pid} --captain ${captain}`);
      expect(runInto(line).status).toBe(0);
      expect((await old.s.done).code).toBe(143);
      expect(JSON.parse(stateFile("record-at-term"))).toMatchObject({ pid: old.pid, rotating: true });
      const atStart = JSON.parse(stateFile("record-at-start"));
      // The record (backlog.json, read at start) stays backlog; only the display name is the captain's.
      expect(atStart).toMatchObject({ kind: "backlog", model: "sonnet", remote: captain });
      expect(atStart.pid).not.toBe(old.pid);
      expect(atStart).not.toHaveProperty("rotating");
      const args = newArgs();
      expect(args.slice(0, 6)).toEqual([
        "--settings",
        scripts("context-settings.json"),
        "--model",
        "sonnet",
        "--remote-control",
        shown("backlog", "backlog", captain),
      ]);
      const prompt = promptOf(args);
      expect(prompt.startsWith("You are the new backlog/inbox planning agent.")).toBe(true);
      expect(prompt).not.toContain("Brief from the session before");
    },
    scaledWait(BASE.testTimeout * 2),
  );

  it("keeps a Remote Control name that differs from the record's", async () => {
    const s = start(
      "bash",
      [scripts("session.sh"), "backlog-tax", "--", "--remote-control", "backlog - tax", "x"],
      { STUB_MODE: "self", STUB_STAY: "1", STUB_NAME: "backlog-tax" },
    );
    await until(() => existsSync(join(state, "ready")));
    const pid = stubPid();
    expect(runInto(printedLine(stateFile("rotate.out")), "backlog-tax").status).toBe(0);
    await s.done;
    expect(stubPid()).not.toBe(pid);
    const args = newArgs();
    expect(args.slice(2, 4)).toEqual(["--remote-control", shown("backlog-tax", "backlog", "backlog - tax")]);
  });

  it("leads the new prompt with the brief and deletes the file", async () => {
    const text = "Fictional hand-over: `$HOME` stays as typed.\nNext: sort the inbox.";
    const file = join(root, "my brief.md");
    writeFileSync(file, `${text}\n`);
    const s = start(
      "bash",
      [scripts("session.sh"), "backlog", "--", "--model", "sonnet", "--remote-control", "backlog", "x"],
      { STUB_MODE: "wait", STUB_NAME: "backlog" },
    );
    await until(() => existsSync(join(state, "ready")));
    const pid = stubPid();
    const line = `cd ${main} && ${scripts("rotate-into.sh")} backlog ${pid} --brief '${file}'`;
    expect(runInto(line).status).toBe(0);
    await s.done;
    // A rotation given no --captain (an old opener's line) draws one itself.
    const args = newArgs();
    expect(ADMIRALS.map((a) => shown("backlog", "backlog", a))).toContain(
      args[args.indexOf("--remote-control") + 1],
    );
    const prompt = promptOf(args);
    expect(prompt.startsWith("## Brief from the session before")).toBe(true);
    expect(prompt).toContain(text);
    expect(prompt.indexOf(text)).toBeLessThan(
      prompt.indexOf("You are the new backlog/inbox planning agent."),
    );
    expect(existsSync(file)).toBe(false);
  });

  it("passes --brief on as an absolute path and prints where to write one", async () => {
    const pathRun = await selfSession("backlog", { args: "--brief-path" });
    expect(pathRun.code).toBe("0");
    expect(pathRun.out.trim()).toBe(briefFile());
    expect(existsSync(briefs())).toBe(true);
    await finish(pathRun);

    rmSync(state, { recursive: true, force: true });
    writeFileSync(join(main, "rel-brief.md"), "Fictional notes.\n");
    try {
      const old = await selfSession("backlog", { args: "--brief rel-brief.md" });
      expect(old.code).toBe("0");
      expect(printedLine(old.out)).toContain(`--brief ${join(main, "rel-brief.md")}`);
      await finish(old);
    } finally {
      rmSync(join(main, "rel-brief.md"), { force: true });
    }
  });

  it("says at the top of the new prompt that no brief came with --no-brief", async () => {
    const old = await selfSession("backlog");
    const line = `cd ${main} && ${scripts("rotate-into.sh")} backlog ${old.pid} --reason context --no-brief`;
    expect(runInto(line).status).toBe(0);
    await old.s.done;
    const prompt = promptOf(newArgs());
    expect(prompt.startsWith("## No brief from the session before")).toBe(true);
    expect(prompt).toContain("nothing was handed over");
    expect(prompt).not.toContain("Brief from the session before\n\nThe last session wrote");
  });

  it("refuses --brief with --no-brief before anything ends", async () => {
    const old = await selfSession("backlog");
    const line = `cd ${main} && ${scripts("rotate-into.sh")} backlog ${old.pid} --brief /x --no-brief`;
    const r = runInto(line);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("--brief or --no-brief, not both");
    expect(() => process.kill(old.pid, 0)).not.toThrow();
    await finish(old);
  });

  it("deletes a stale brief when a session of that name starts, and doesn't use it", async () => {
    mkdirSync(briefs(), { recursive: true });
    writeFileSync(briefFile(), "Fictional stale brief.\n");
    const r = run("session.sh", ["backlog", "--", "--remote-control", "backlog", "x"], {
      STUB_MODE: "exit",
      STUB_NAME: "backlog",
    });
    expect(r.status).toBe(0);
    expect(existsSync(briefFile())).toBe(false);
    expect(stateFile("args")).not.toContain("Fictional stale brief.");
  });

  it.each([
    ["missing", null, /can't read the brief/],
    ["empty", " \n", /is empty/],
    ["too long", "x".repeat(64 * 1024 + 1), /is over 64 KB/],
  ])("refuses a %s brief before anything ends", async (_what, content, why) => {
    const file = join(root, "bad-brief.md");
    rmSync(file, { force: true });
    if (content !== null) writeFileSync(file, content);
    const old = await selfSession("backlog", { args: `--brief ${file}` });
    expect(old.code).toBe("1");
    expect(old.out).toMatch(why);
    expect(old.out).toContain("nothing was ended");
    expect(old.out).not.toContain("iTerm2 isn't here");
    expect(spawnSync("kill", ["-0", String(old.pid)]).status).toBe(0);
    expect(record("backlog")).not.toHaveProperty("rotating");

    // The tab refuses it too, if the file went bad after rotate's own check.
    const r = runInto(`cd ${main} && ${scripts("rotate-into.sh")} backlog ${old.pid} --brief ${file}`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("nothing was ended");
    expect(spawnSync("kill", ["-0", String(old.pid)]).status).toBe(0);
    expect(record("backlog")).not.toHaveProperty("rotating");
    await finish(old);
    rmSync(file, { force: true });
  });

  it("behaves as plain rotate for an orchestrator, and takes no brief", async () => {
    const old = await selfSession("prd-w", { cwd: wt, claude: [] });
    expect(old.code).toBe("0");
    expect(old.out).toContain(`Rotating prd-w: pid ${old.pid} (from its record).`);
    expect(printedLine(old.out)).toBe(`cd ${wt} && ${scripts("rotate-into.sh")} prd-w ${old.pid}`);
    await finish(old);

    rmSync(state, { recursive: true, force: true });
    const briefed = await selfSession("prd-w", { cwd: wt, claude: [], args: "--brief /nope" });
    expect(briefed.code).toBe("1");
    expect(briefed.out).toContain("an orchestrator hands over through _Status_");
    await finish(briefed);
  });

  describe("says whether the hand-off took once its tab is open (RISA-1082)", () => {
    const alive = (pid) => spawnSync("kill", ["-0", String(pid)]).status === 0;

    it.each([
      ["backlog", main],
      ["prd-w", null],
    ])(
      "%s: rotate-into never runs in the tab: not started, exit 1, the session carries on",
      async (name, cwd) => {
        const old = await selfSession(name, {
          cwd: cwd ?? wt,
          claude: name === "backlog" ? ["--model", "sonnet"] : [],
          extra: { ...tabEnv, FAKE_TAB: "none", RISA_ROTATE_START_WAIT: "1" },
        });
        expect(old.code).toBe("1");
        expect(old.out).toMatch(/^Opened .* in a new background iTerm2 tab/m);
        expect(old.out).toContain(`the hand-off did not start: no sign of rotate-into on ${name} within 1s`);
        expect(old.out).toContain(`This session carries on (pid ${old.pid})`);
        expect(old.out).not.toContain("The hand-off started");
        expect(alive(old.pid)).toBe(true);
        expect(record(name)).not.toHaveProperty("rotating");
        await finish(old);
      },
    );

    it("rotate-into refuses in the tab: not started, with its reason, and the reason's file is gone", async () => {
      const file = join(root, "gone-brief.md");
      writeFileSync(file, "Fictional notes.\n");
      const old = await selfSession("backlog", {
        args: `--brief ${file}`,
        extra: { ...tabEnv, FAKE_TAB: "run", FAKE_RM: file },
      });
      expect(old.code).toBe("1");
      expect(old.out).toContain(
        `rotate --self: the hand-off did not start: rotate-into: can't read the brief ${file}; nothing was ended. This session carries on (pid ${old.pid})`,
      );
      expect(old.out).not.toContain("The hand-off started");
      expect(existsSync(join(sessions, "backlog.refused"))).toBe(false);
      expect(alive(old.pid)).toBe(true);
      expect(record("backlog")).not.toHaveProperty("rotating");
      await finish(old);
    });

    it("the record is marked rotating within the wait: the hand-off is under way, exit 0", async () => {
      const old = await selfSession("backlog", { extra: { ...tabEnv, FAKE_TAB: "rotating" } });
      expect(old.code).toBe("0");
      expect(old.out).toContain(
        `The hand-off started (marked rotating): this session (pid ${old.pid}) is about to be ended; a fresh backlog opens in that tab.`,
      );
      expect(old.out).not.toContain("did not start");
      expect(record("backlog")).toMatchObject({ pid: old.pid, rotating: true });
      await finish(old);
    });
  });

  describe("the inbox session", () => {
    const inboxDir = () => join(root, "home/.risa/inbox");
    const inboxEnv = () => ({ RISA_INBOX_DIR: join(root, "elsewhere") });
    const startInbox = async (extraArgs = "") => {
      mkdirSync(inboxDir(), { recursive: true });
      const s = start(
        "bash",
        [
          scripts("session.sh"),
          "inbox",
          "--kind",
          "inbox",
          "--managed",
          "--",
          // Recorded on the old default: the new session must come up on prd.sh's Opus.
          "--model",
          "sonnet",
          "--remote-control",
          "inbox",
          "x",
        ],
        { STUB_MODE: "self", STUB_STAY: "1", STUB_NAME: "inbox", STUB_ARGS: extraArgs },
        inboxDir(),
      );
      await until(() => existsSync(join(state, "ready")));
      return { s, pid: stubPid(), out: stateFile("rotate.out"), code: stateFile("rotate.code").trim() };
    };
    /** The new session: in the recorded directory, on Opus with the low-effort settings, managed. */
    const expectFresh = (oldPid) => {
      const atStart = JSON.parse(stateFile("record-at-start"));
      expect(atStart).toMatchObject({
        kind: "inbox",
        model: "opus",
        remote: "inbox",
        managed: true,
        dir: inboxDir(),
      });
      expect(atStart.pid).not.toBe(oldPid);
      expect(atStart).not.toHaveProperty("rotating");
      const args = newArgs();
      expect(args.slice(0, 6)).toEqual([
        "--settings",
        scripts("inbox-settings.json"),
        "--model",
        "opus",
        "--remote-control",
        shown("inbox", "inbox", "inbox"),
      ]);
      expect(promptOf(args).startsWith("You are the inbox agent.")).toBe(true);
    };
    beforeEach(() => rmSync(join(root, "home"), { recursive: true, force: true }));

    it("rotates itself into a fresh one in its own directory, on Opus at low effort though recorded on Sonnet", async () => {
      const old = await startInbox();
      expect(old.code).toBe("0");
      expect(JSON.parse(stateFile("record-at-start")).model).toBe("sonnet");
      expect(old.out).toContain(`Rotating inbox: pid ${old.pid} (the calling session).`);
      const line = printedLine(old.out);
      expect(line).toBe(`cd ${main} && ${scripts("rotate-into.sh")} inbox ${old.pid}`);
      const r = spawnSync("bash", ["-c", line], {
        cwd: root,
        encoding: "utf8",
        env: { ...env, ...inboxEnv(), STUB_MODE: "exit", STUB_NAME: "inbox" },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("a fresh session with the inbox prompt");
      expect((await old.s.done).code).toBe(143);
      expect(JSON.parse(stateFile("record-at-term"))).toMatchObject({ pid: old.pid, rotating: true });
      expectFresh(old.pid);
    });

    it("refuses a brief or --mid-wave before anything ends", async () => {
      const old = await startInbox("--brief-path");
      expect(old.code).toBe("1");
      expect(old.out).toContain("the inbox session hands off with no brief");
      expect(spawnSync("kill", ["-0", String(old.pid)]).status).toBe(0);
      await finish(old);
      const r = runInto(`cd ${main} && ${scripts("rotate-into.sh")} inbox ${old.pid} --no-brief`, "inbox");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("the inbox session hands off with no brief");
    });

    it("the keep-alive's opener reopens a dead Sonnet one the same way: its directory, Opus low, managed", async () => {
      const old = await startInbox();
      await finish(old);
      expect(record("inbox").model).toBe("sonnet");
      rmSync(join(state, "record-at-start"), { force: true });
      const r = run("open-session.sh", ["inbox", "--print"], inboxEnv());
      expect(r.status).toBe(0);
      const line = r.stdout.split("\n")[1].trim();
      expect(line).toBe(`cd ${main} && ${scripts("prd.sh")} inbox --dir ${inboxDir()} --managed`);
      const opened = spawnSync("bash", ["-c", line], {
        cwd: root,
        encoding: "utf8",
        env: { ...env, ...inboxEnv(), STUB_MODE: "exit", STUB_NAME: "inbox" },
      });
      expect(opened.status).toBe(0);
      expectFresh(old.pid);
    });
  });

  it.each([
    ["hotfix-x", /hotfix-x is a hotfix session: only backlog and inbox sessions and orchestrators/],
    ["recover", /recover is a recovery session: only backlog and inbox sessions and orchestrators/],
  ])("refuses %s, saying why", async (name, why) => {
    const old = await selfSession(name);
    expect(old.code).toBe("1");
    expect(old.out).toMatch(why);
    expect(spawnSync("kill", ["-0", String(old.pid)]).status).toBe(0);
    await finish(old);
  });

  it("refuses an unrecorded caller, and a shell under no claude", () => {
    expect(
      spawnSync(stub, [], { cwd: main, encoding: "utf8", env: { ...env, STUB_MODE: "self" } }).status,
    ).toBe(0);
    expect(stateFile("rotate.code").trim()).toBe("1");
    expect(stateFile("rotate.out")).toMatch(/its claude \(pid \d+\) has no live session record/);
    const r = run("prd.sh", ["rotate", "--self"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/this shell isn't under a claude process/);
  });

  it("refuses on a slice branch, whose shell carries its orchestrator's session", async () => {
    const dir = join(loops, "w-9");
    git(main, "worktree", "add", "-q", "-b", "slice/w/9", dir, "prd/w");
    try {
      const old = await selfSession("prd-w", { cwd: dir, claude: [] });
      expect(old.code).toBe("1");
      expect(old.out).toContain("refused on a slice branch");
      await finish(old);
    } finally {
      git(main, "worktree", "remove", "--force", dir);
      git(main, "branch", "-D", "slice/w/9");
    }
  });

  it("refuses the brief flags without --self, and a pid that isn't the live backlog session", async () => {
    expect(run("prd.sh", ["rotate", "w", "--brief", "x"]).stderr).toContain("go with --self");
    const r = runInto(`cd ${main} && ${scripts("rotate-into.sh")} backlog 999999`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("has no backlog record; nothing was ended");
  });
});
