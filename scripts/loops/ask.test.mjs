// pnpm prd ask | asks | answer (ask.mjs through prd.sh) against a throwaway
// CARETOOK_ASKS_DIR. osascript is a stub that records its arguments (never a
// real notification), and CARETOOK_ASK_NOTIFY names stub hooks.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const PRD_SH = new URL("./prd.sh", import.meta.url).pathname;

let root, dir, stubs, env;
const children = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ask-test-"));
  stubs = join(root, "bin");
  mkdirSync(stubs);
  const osascript = join(stubs, "osascript");
  writeFileSync(osascript, `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/osascript.args"\n`);
  chmodSync(osascript, 0o755);
});
beforeEach(() => {
  dir = mkdtempSync(join(root, "asks-"));
  rmSync(join(root, "osascript.args"), { force: true });
  env = {
    ...process.env,
    PATH: `${stubs}:${process.env.PATH}`,
    CARETOOK_ASKS_DIR: dir,
    CARETOOK_ASK_POLL: "0.2",
  };
  for (const k of ["CARETOOK_ASK_NOTIFY", "CARETOOK_ASK_NOTIFY_TIMEOUT", "CARETOOK_SESSION"]) delete env[k];
});
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const prd = (args, extra = {}) =>
  spawnSync("bash", [PRD_SH, ...args], { cwd: root, encoding: "utf8", env: { ...env, ...extra } });
const start = (args) => {
  const child = spawn("bash", [PRD_SH, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const p = { child, out: "", err: "" };
  child.stdout.on("data", (d) => (p.out += d));
  child.stderr.on("data", (d) => (p.err += d));
  p.exit = new Promise((r) => child.once("exit", (code) => r(code)));
  return p;
};
const hook = (name, body) => {
  const f = join(root, name);
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
};
const askQuestion = (extra) =>
  prd(
    [
      "ask",
      "--topic",
      "demo",
      "--question",
      "Land wave 1 now?",
      "--option",
      "yes",
      "--option",
      "after the check",
      "--recommend",
      "yes",
    ],
    extra,
  );

describe("pnpm prd ask", () => {
  it("files a question: prints the id, the PushNotification line, and notifies", () => {
    const r = askQuestion();
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toBe("a1");
    expect(lines[1]).toBe("Now send a PushNotification: demo: Land wave 1 now?");
    expect(lines[2]).toBe("Then wait in the background: pnpm prd ask --wait a1");
    const stored = JSON.parse(readFileSync(join(dir, "a1.json"), "utf8"));
    expect(stored).toMatchObject({ kind: "question", topic: "demo", options: ["yes", "after the check"] });
    expect(readFileSync(join(root, "osascript.args"), "utf8")).toContain(
      "Caretook question: demo\nLand wave 1 now?\n",
    );
  });

  it("files a report, shortening the push line", () => {
    const text = `Wave 1 landed. ${"Try the list. ".repeat(20)}`;
    const r = prd(["ask", "--topic", "demo", "--report", text, "--session", "prd-demo"]);
    expect(r.status, r.stderr).toBe(0);
    const [id, push, ...rest] = r.stdout.trim().split("\n");
    expect(id).toBe("a1");
    expect(push).toMatch(/^Now send a PushNotification: demo: Wave 1 landed\. Try the list\..*…$/);
    expect(push.length).toBeLessThan(170);
    expect(rest).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "a1.json"), "utf8")).session).toBe("prd-demo");
  });

  it("runs CARETOOK_ASK_NOTIFY with the id, kind, topic and text", () => {
    const out = join(root, "hook.args");
    const r = askQuestion({ CARETOOK_ASK_NOTIFY: hook("notify-ok", `printf '%s\\n' "$@" > "${out}"`) });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("a1\nquestion\ndemo\nLand wave 1 now?\n");
  });

  it("ignores a failing hook", () => {
    const r = askQuestion({ CARETOOK_ASK_NOTIFY: hook("notify-fail", "exit 3") });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^a1\n/);
    expect(r.stderr).toMatch(/CARETOOK_ASK_NOTIFY exit 3 \(ignored\)/);
  });

  it("bounds a hanging hook's time", () => {
    const t = Date.now();
    const r = askQuestion({
      CARETOOK_ASK_NOTIFY: hook("notify-hang", "sleep 30"),
      CARETOOK_ASK_NOTIFY_TIMEOUT: "1",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/CARETOOK_ASK_NOTIFY timed out \(ignored\)/);
    expect(Date.now() - t).toBeLessThan(10_000);
  });

  it("refuses a missing text, both kinds, no topic outside a worktree, a bad recommendation", () => {
    expect(prd(["ask", "--topic", "demo"]).stderr).toMatch(/needs one of --question/);
    expect(prd(["ask", "--topic", "d", "--question", "q", "--report", "r"]).status).toBe(1);
    expect(prd(["ask", "--question", "q"]).stderr).toMatch(/needs --topic/);
    const r = prd(["ask", "--topic", "d", "--question", "q", "--option", "a", "--recommend", "b"]);
    expect(r.stderr).toMatch(/isn't one of the options/);
    expect(existsSync(join(dir, "a1.json"))).toBe(false);
  });
});

describe("pnpm prd ask --wait and answer", () => {
  it("returns the answer once another process answers", async () => {
    askQuestion();
    const w = start(["ask", "--wait", "a1", "--timeout", "15"]);
    await new Promise((r) => setTimeout(r, 600));
    expect(w.child.exitCode).toBe(null);
    const a = prd(["answer", "a1", "2"]);
    expect(a.stdout).toBe("a1 answered: after the check\n");
    expect(await w.exit).toBe(0);
    expect(w.out).toBe("after the check\n");
  });

  it("exits 75 at its timeout", async () => {
    askQuestion();
    const w = start(["ask", "--wait", "a1", "--timeout", "1"]);
    expect(await w.exit).toBe(75);
    expect(w.err).toMatch(/no answer to a1 after 1s/);
  });

  it("returns at once for an answered question; refuses a report or an unknown id", () => {
    askQuestion();
    prd(["answer", "a1", "ship", "it"]);
    expect(prd(["ask", "--wait", "a1"]).stdout).toBe("ship it\n");
    prd(["ask", "--topic", "demo", "--report", "done"]);
    expect(prd(["ask", "--wait", "a2"]).stderr).toMatch(/is a report/);
    expect(prd(["ask", "--wait", "a9"]).stderr).toMatch(/no ask a9/);
  });

  it("refuses a second answer", () => {
    askQuestion();
    prd(["answer", "a1", "1"]);
    const r = prd(["answer", "a1", "2"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already answered: yes/);
  });
});

describe("pnpm prd asks", () => {
  it("lists the open asks, as text or JSON, and dismisses one", () => {
    askQuestion();
    prd(["ask", "--topic", "other", "--report", "Landed.", "--session", "prd-other"]);
    const r = prd(["asks"]);
    expect(r.stdout).toMatch(
      /^a1 {2}question {2}demo {2}\d+s ago\n {4}Land wave 1 now\?\n {4}1\. yes {2}\(recommended\)\n {4}2\. after the check\n\na2 {2}report {2}other {2}\d+s ago, prd-other\n {4}Landed\.\n$/,
    );
    expect(JSON.parse(prd(["asks", "--json"]).stdout).map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(prd(["asks", "--done", "a2"]).stdout).toBe("a2 dismissed\n");
    prd(["answer", "a1", "yes"]);
    expect(prd(["asks"]).stdout).toBe("No open asks.\n");
    expect(JSON.parse(prd(["asks", "--json"]).stdout)).toEqual([]);
  });

  it("is in pnpm prd help under its own group", () => {
    const help = prd(["help"]).stdout;
    const group = help.slice(help.indexOf("\n  Asks"));
    expect(group).toMatch(/^\n {2}Asks /);
    for (const c of ["ask --topic", "ask --wait", "asks [--json]", "asks --done", "answer <id>"])
      expect(group.split("\n\n")[0]).toContain(c);
  });
});
