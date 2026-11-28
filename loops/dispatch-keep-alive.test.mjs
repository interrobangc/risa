// The dispatcher's keep-alive tick and the inbox session's keep-alive:
// dispatch.mjs on dispatch-fixture.mjs's throwaway repo.
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELPER_SESSION } from "./dispatch.mjs";
import {
  root,
  main,
  loops,
  sessions,
  asks,
  env,
  inboxDir,
  claudeConfig,
  scripts,
  calls,
  openCalls,
  ok,
  dstate,
  setRows,
  setClock,
  T0,
  deadRecord,
  answer,
  askFile,
  until,
  useDispatchRepo,
} from "./dispatch-fixture.mjs";

useDispatchRepo();

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

  const inboxReports = () =>
    existsSync(asks)
      ? readdirSync(asks)
          .map((f) => askFile(f.replace(/\.json$/, "")))
          .filter((a) => a.session === "dispatch-keep" && a.kind === "report")
      : [];

  it("files one report naming the folder and `inbox` while it can't open (RISA-978)", () => {
    writeFileSync(join(root, "processes"), backlogLive);
    mkdirSync(inboxDir, { recursive: true });
    expect(ok(["--once"], on)).toContain("keep-alive inbox: reported it can't open");
    ok(["--once"], on);
    const reports = inboxReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ topic: "dispatch" });
    expect(reports[0].text).toContain("`pnpm prd inbox`");
    expect(reports[0].text).toContain(realpathSync(inboxDir));
    expect(dstate().inboxReported).toBe(true);
  });

  it("trusted clears the record, so untrusted again files a second report", () => {
    writeFileSync(join(root, "processes"), backlogLive);
    mkdirSync(inboxDir, { recursive: true });
    ok(["--once"], on);
    trust();
    ok(["--once"], on);
    expect(dstate().inboxReported).toBeUndefined();
    rmSync(claudeConfig, { force: true });
    ok(["--once"], on);
    expect(inboxReports()).toHaveLength(2);
  });

  it("a dry run files none and says it would; switched off, none", () => {
    writeFileSync(join(root, "processes"), backlogLive);
    mkdirSync(inboxDir, { recursive: true });
    expect(ok(["--dry-run"], on)).toContain("keep-alive inbox: would report it can't open");
    expect(inboxReports()).toEqual([]);
    ok(["--once"], { RISA_KEEP_SESSIONS: "off" });
    expect(inboxReports()).toEqual([]);
    expect(dstate().inboxReported).toBeUndefined();
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
