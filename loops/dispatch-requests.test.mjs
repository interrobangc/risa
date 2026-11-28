// The dispatcher's session-request tick: dispatch.mjs on dispatch-fixture.mjs's
// throwaway repo.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRequest } from "./session-requests.mjs";
import { loadConfig } from "./config.mjs";
import {
  HERE,
  root,
  main,
  loops,
  sessions,
  env,
  scripts,
  openCalls,
  ok,
  T0,
  deadRecord,
  useDispatchRepo,
} from "./dispatch-fixture.mjs";

useDispatchRepo();

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
      `cd ${main} && ${scripts("session.sh")} backlog-reminders --kind backlog --managed -- --model sonnet --remote-control 'backlog - reminders' "$(${scripts("prompt.sh")} backlog --brief ${r.brief} || ${scripts("prompt.sh")} backlog)"`,
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
    expect(args).toContain(`--remote-control\nbacklog - labels (${loadConfig().config.name})\n`);
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
