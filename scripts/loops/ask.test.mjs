// pnpm prd ask | asks | answer (ask.mjs through prd.sh) against a throwaway
// CARETOOK_ASKS_DIR. osascript is a stub that records its arguments (never a
// real notification), and CARETOOK_ASK_NOTIFY names stub hooks.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DISPATCHER_SESSIONS } from "./asks.mjs";
import { CONTEXT_SESSION } from "./dispatch-context.mjs";
import { DISPATCH_SESSION, KEEP_SESSION } from "./dispatch-pick.mjs";
import { recordVerdict } from "./skeptics.mjs";

const PRD_SH = new URL("./prd.sh", import.meta.url).pathname;

let root, dir, skepticDir, stubs, env;
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
  skepticDir = mkdtempSync(join(root, "skeptic-"));
  rmSync(join(root, "osascript.args"), { force: true });
  env = {
    ...process.env,
    PATH: `${stubs}:${process.env.PATH}`,
    CARETOOK_ASKS_DIR: dir,
    CARETOOK_SKEPTIC_DIR: skepticDir,
    CARETOOK_ASK_POLL: "0.2",
  };
  for (const k of [
    "CARETOOK_ASK_NOTIFY",
    "CARETOOK_ASK_NOTIFY_TIMEOUT",
    "CARETOOK_SESSION",
    "CARETOOK_ASK_DEFAULT_MIN",
  ])
    delete env[k];
});
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const raw = (args, extra = {}) =>
  spawnSync("bash", [PRD_SH, ...args], { cwd: root, encoding: "utf8", env: { ...env, ...extra } });
// The queue's own behavior, filed as the dispatcher (no skeptic); the skeptic's tests use raw.
const prd = (args, extra) =>
  raw(args[0] === "ask" && args.includes("--question") ? [...args, "--session", "dispatch"] : args, extra);
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
      "--waits",
    ],
    extra,
  );
/** A question that takes "yes" after CARETOOK_ASK_DEFAULT_MIN minutes. */
const askDefaulting = (minutes, extra = {}) =>
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
      "--defaults",
    ],
    { CARETOOK_ASK_DEFAULT_MIN: String(minutes), ...extra },
  );
const stored = (id) => JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
const hhmm = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

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

  it("files a report with no push line", () => {
    const text = `Wave 1 landed. ${"Try the list. ".repeat(20)}`;
    const r = prd(["ask", "--topic", "demo", "--report", text, "--session", "prd-demo"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual([
      "a1",
      "Filed. No PushNotification for a report: only questions are pushed.",
    ]);
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
    const r = prd(["ask", "--topic", "d", "--question", "q", "--option", "a", "--recommend", "b", "--waits"]);
    expect(r.stderr).toMatch(/isn't one of the options/);
    expect(existsSync(join(dir, "a1.json"))).toBe(false);
  });
});

describe("defaults on silence", () => {
  it("refuses a recommended question with neither flag: files nothing, names both flags and the never list", () => {
    const r = prd(["ask", "--topic", "d", "--question", "q", "--option", "a", "--recommend", "a"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--defaults");
    expect(r.stderr).toContain("--waits");
    expect(r.stderr).toMatch(
      /money .*data loss .*a live deploy .*a destructive step .*a new dependency .*compliance/,
    );
    expect(r.stderr).toContain("Nothing was filed");
    expect(existsSync(join(dir, "a1.json"))).toBe(false);
  });

  it("refuses both flags, --defaults with no recommendation, and either on a report", () => {
    const both = ["ask", "--topic", "d", "--question", "q", "--option", "a", "--recommend", "a"];
    expect(prd([...both, "--defaults", "--waits"]).stderr).toMatch(/not both/);
    expect(prd(["ask", "--topic", "d", "--question", "q", "--option", "a", "--defaults"]).stderr).toMatch(
      /needs a recommendation/,
    );
    expect(prd(["ask", "--topic", "d", "--report", "r", "--waits"]).stderr).toMatch(/report neither/);
    expect(existsSync(join(dir, "a1.json"))).toBe(false);
    // A question with no recommendation waits, flag or not.
    expect(prd(["ask", "--topic", "d", "--question", "q", "--option", "a"]).status).toBe(0);
    expect(stored("a1")).toMatchObject({ defaults: false, defaultAt: null });
  });

  it("a defaulting question's push line says what it takes and when; a waiting one's is unchanged", () => {
    const r = askDefaulting(30);
    expect(r.status, r.stderr).toBe(0);
    const a = stored("a1");
    expect(a).toMatchObject({ defaults: true, recommended: "yes", defaulted: false });
    expect(Date.parse(a.defaultAt) - Date.parse(a.askedAt)).toBe(30 * 60_000);
    expect(r.stdout.split("\n")[1]).toBe(
      `Now send a PushNotification: demo: Land wave 1 now? (takes "yes" at ${hhmm(a.defaultAt)} unless answered)`,
    );
    expect(askQuestion().stdout.split("\n")[1]).toBe("Now send a PushNotification: demo: Land wave 1 now?");
    expect(stored("a2")).toMatchObject({ defaults: false });
  });

  it("--wait on a due ask prints the option, says it was defaulted, and exits 0", async () => {
    askDefaulting(0.005); // 0.3 s
    const w = start(["ask", "--wait", "a1", "--timeout", "15"]);
    expect(await w.exit).toBe(0);
    const [answer, note] = w.out.trim().split("\n");
    expect(answer).toBe("yes");
    expect(note).toMatch(/^\(defaulted: no answer in 0s, so it took the recommendation at \d\d:\d\d;/);
    expect(stored("a1")).toMatchObject({ answer: "yes", defaulted: true });
  });

  it("--wait returns a user's answer given before the default", async () => {
    askDefaulting(1);
    const w = start(["ask", "--wait", "a1", "--timeout", "15"]);
    await new Promise((r) => setTimeout(r, 400));
    expect(prd(["answer", "a1", "2"]).status).toBe(0);
    expect(await w.exit).toBe(0);
    expect(w.out).toBe("after the check\n");
    expect(stored("a1")).toMatchObject({ answer: "after the check", defaulted: false });
  });

  it("asks shows the countdown from a fixed now, and a due ask as due without settling it: it can still be answered", () => {
    // CARETOOK_CLOCK_FILE: ask files at, and asks lists from, these epoch seconds.
    const clockFile = join(root, "clock");
    const T = 1_794_999_960; // a whole minute (2026-11-18)
    const at = (s) => {
      writeFileSync(clockFile, String(T + s));
      return { CARETOOK_CLOCK_FILE: clockFile };
    };
    expect(askDefaulting(30, at(0)).status).toBe(0);
    const when = hhmm(stored("a1").defaultAt);
    const first = (s) => prd(["asks"], at(s)).stdout.split("\n")[0];
    const line = (ago, left) =>
      `a1  question  demo  ${ago} ago, dispatch, takes "yes" in ${left} (at ${when}) unless answered`;
    expect(first(0)).toBe(line("0s", "30m"));
    // Whole minutes left, rounded down: 1 s and 59 s past a minute boundary both read 29m.
    expect(first(1)).toBe(line("1s", "29m"));
    expect(first(59)).toBe(line("59s", "29m"));
    expect(first(60)).toBe(line("1m", "29m"));
    expect(first(61)).toBe(line("1m", "28m"));
    askDefaulting(0.001, at(59)); // due 60 ms later
    const listed = prd(["asks"], at(60)).stdout;
    expect(listed).toMatch(
      /^a2 {2}question {2}demo {2}1s ago, dispatch, takes "yes": due \(still answerable\)$/m,
    );
    expect(stored("a2")).toMatchObject({ answeredAt: null, defaulted: false });
    expect(prd(["asks", "--json"]).status).toBe(0);
    expect(stored("a2").answeredAt).toBe(null);
    expect(prd(["answer", "a2", "2"]).stdout).toBe("a2 answered: after the check\n");
  });

  it("asks lists a defaulted ask under its own heading, --json carries the fields, answer is refused", async () => {
    askDefaulting(0.001);
    await new Promise((r) => setTimeout(r, 200));
    expect(await start(["ask", "--wait", "a1"]).exit).toBe(0);
    askQuestion();
    const listed = prd(["asks"]).stdout;
    const [open, decided] = listed.split("DECIDED FOR YOU");
    expect(open).toMatch(/^a2 {2}question/);
    expect(decided).toMatch(/\na1 {2}question {2}demo/);
    expect(decided).toMatch(/→ took "yes" at \d\d:\d\d, \d+s ago, unanswered/);
    const json = JSON.parse(prd(["asks", "--json"]).stdout);
    expect(json.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(json[0]).toMatchObject({ defaults: true, defaulted: true, answer: "yes" });
    expect(typeof json[0].defaultAt).toBe("string");
    expect(json[1]).toMatchObject({ defaults: false, defaultAt: null, defaulted: false });
    const r = prd(["answer", "a1", "2"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/a1 was decided for you: it took "yes"/);
    expect(prd(["asks", "--done", "a1"]).status).toBe(0);
    expect(prd(["asks"]).stdout).not.toContain("DECIDED FOR YOU");
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
      /^a1 {2}question {2}demo {2}\d+s ago, dispatch\n {4}Land wave 1 now\?\n {4}1\. yes {2}\(recommended\)\n {4}2\. after the check\n\na2 {2}report {2}other {2}\d+s ago, prd-other\n {4}Landed\.\n$/,
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

describe("a skeptic before every ask", () => {
  const Q = "Keep the old column?";
  const OFFERS = ["keep", "drop"];
  const question = (...more) => [
    "ask",
    "--topic",
    "demo",
    "--question",
    Q,
    ...OFFERS.flatMap((o) => ["--option", o]),
    ...more,
  ];
  const verdict = (fields = {}) =>
    recordVerdict(skepticDir, {
      kind: "ask",
      verdict: "ask",
      why: "the user's call",
      topic: "demo",
      question: Q,
      offers: OFFERS,
      askerClass: "defaults",
      ...fields,
    }).id;
  const decide = (fields = {}) =>
    verdict({ verdict: "decide", option: "keep", why: "reversible", ...fields });
  const filed = () => (existsSync(join(dir, "a1.json")) ? stored("a1") : null);

  it("without --skeptic it files nothing and names the steps", () => {
    const r = raw(question("--recommend", "keep", "--defaults"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("goes to a skeptic first");
    expect(r.stderr).toContain("pnpm prd prompt skeptic ask --evidence");
    expect(r.stderr).toContain("pnpm prd skeptic record --kind ask");
    expect(filed()).toBeNull();
  });

  it("only the dispatcher's sessions are exempt, and only by an explicit --session", () => {
    expect(DISPATCHER_SESSIONS).toEqual([DISPATCH_SESSION, CONTEXT_SESSION, KEEP_SESSION]);
    for (const s of DISPATCHER_SESSIONS) expect(raw(question("--session", s, "--waits")).status).toBe(0);
    expect(raw(question("--session", "prd-demo", "--waits")).status).toBe(1);
    expect(raw(question("--waits"), { CARETOOK_SESSION: "dispatch" }).status).toBe(1);
  });

  it("a report needs none, and refuses one", () => {
    expect(raw(["ask", "--topic", "demo", "--report", "Landed."]).status).toBe(0);
    const r = raw(["ask", "--topic", "demo", "--report", "Landed.", "--skeptic", "s1"]);
    expect(r.stderr).toMatch(/report needs no skeptic/);
  });

  it("an ask verdict files it as today, --defaults and --waits unchanged, carrying the verdict", () => {
    const d = raw(question("--recommend", "keep", "--defaults", "--skeptic", verdict()));
    expect(d.status).toBe(0);
    expect(d.stdout).toContain("Now send a PushNotification");
    expect(stored("a1")).toMatchObject({
      defaults: true,
      skeptic: { id: "s1", verdict: "ask", why: "the user's call" },
    });
    const w = raw(question("--recommend", "keep", "--waits", "--skeptic", verdict({ askerClass: "waits" })));
    expect(w.status).toBe(0);
    expect(stored("a2")).toMatchObject({ defaults: false, defaultAt: null });
  });

  it("a question with no recommendation counts as --waits", () => {
    expect(raw(question("--skeptic", verdict())).status).toBe(1);
    expect(raw(question("--skeptic", verdict({ askerClass: "waits" }))).status).toBe(0);
  });

  it("a decide verdict is refused, pointing at --decided", () => {
    const r = raw(question("--recommend", "keep", "--defaults", "--skeptic", decide()));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("pnpm prd ask --decided --skeptic s1");
    expect(filed()).toBeNull();
  });

  it("another question, a reused record and an unknown one are refused", () => {
    const other = raw([
      ...question("--recommend", "keep", "--defaults", "--skeptic", verdict({ question: "Something else?" })),
    ]);
    expect(other.stderr).toMatch(/another question/);
    const id = verdict();
    expect(raw(question("--recommend", "keep", "--defaults", "--skeptic", id)).status).toBe(0);
    const again = raw(question("--recommend", "keep", "--defaults", "--skeptic", id));
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/already used/);
    expect(raw(question("--waits", "--skeptic", "s99")).stderr).toMatch(/no such skeptic record/);
  });

  it("a question that can't be filed doesn't burn the verdict", () => {
    const id = verdict();
    const bad = raw(question("--recommend", "neither", "--defaults", "--skeptic", id));
    expect(bad.stderr).toMatch(/isn't one of the options/);
    expect(existsSync(join(skepticDir, `${id}.used`))).toBe(false);
    expect(raw(question("--recommend", "keep", "--defaults", "--skeptic", id)).status).toBe(0);
  });

  it("a land no and a plan send-back file a question", () => {
    const tip = "a".repeat(40);
    const land = recordVerdict(skepticDir, {
      kind: "land",
      verdict: "no",
      why: "thin evidence",
      topic: "demo",
      tip,
      action: "force",
    }).id;
    const plan = recordVerdict(skepticDir, {
      kind: "plan",
      verdict: "send-back",
      why: "twice rejected",
      topic: "demo",
    }).id;
    expect(raw(question("--waits", "--skeptic", land)).status).toBe(0);
    expect(raw(question("--waits", "--skeptic", plan)).status).toBe(0);
    expect(stored("a1").skeptic).toMatchObject({ verdict: "no" });
    expect(stored("a2").skeptic).toMatchObject({ verdict: "send-back" });
  });

  describe("--decided", () => {
    const decided = (id, ...more) => question("--decided", "--skeptic", id, "--chose", "keep", ...more);

    it("files a settled record, with no push line and no notification", () => {
      const hookFile = join(root, "decided-hook");
      const r = raw(decided(decide()), { CARETOOK_ASK_NOTIFY: `touch ${hookFile}; true` });
      expect(r.status).toBe(0);
      expect(r.stdout.split("\n")[0]).toBe("a1");
      expect(r.stdout).not.toContain("Now send a PushNotification");
      expect(existsSync(join(root, "osascript.args"))).toBe(false);
      expect(existsSync(hookFile)).toBe(false);
      expect(stored("a1")).toMatchObject({
        answer: "keep",
        defaulted: true,
        defaults: false,
        skeptic: { id: "s1", verdict: "decide", why: "reversible" },
      });
    });

    it("takes the option by number", () => {
      const r = raw(question("--decided", "--skeptic", decide(), "--chose", "1"));
      expect(r.status).toBe(0);
      expect(stored("a1").answer).toBe("keep");
    });

    it("is listed under decided for you with its why, --json carries it, --done dismisses it", () => {
      raw(decided(decide()));
      const listed = raw(["asks"]).stdout;
      expect(listed).toContain("DECIDED FOR YOU (by a skeptic");
      expect(listed).toMatch(/→ a skeptic chose "keep" at \d\d:\d\d, \d+s ago: reversible/);
      const [json] = JSON.parse(raw(["asks", "--json"]).stdout);
      expect(json.skeptic).toEqual({ id: "s1", verdict: "decide", why: "reversible" });
      expect(raw(["ask", "--wait", "a1"]).stdout).toContain("decided by skeptic s1: reversible");
      expect(raw(["answer", "a1", "2"]).stderr).toMatch(/decided by a skeptic/);
      expect(raw(["asks", "--done", "a1"]).status).toBe(0);
      expect(raw(["asks"]).stdout).toBe("No open asks.\n");
    });

    it("refuses a --waits class, another choice, an ask verdict and a reuse", () => {
      expect(raw(decided(decide(), "--waits")).stderr).toMatch(/--waits question is the user's/);
      expect(raw(question("--decided", "--skeptic", decide(), "--chose", "drop")).stderr).toMatch(
        /chose "keep"/,
      );
      expect(raw(decided(verdict())).stderr).toMatch(/isn't a decide verdict/);
      expect(filed()).toBeNull();
      const id = decide();
      expect(raw(decided(id)).status).toBe(0);
      expect(raw(decided(id)).stderr).toMatch(/already used/);
    });

    it("needs --skeptic and --chose, and --chose needs --decided", () => {
      expect(raw(question("--decided", "--chose", "keep")).stderr).toMatch(/needs --skeptic/);
      expect(raw(question("--decided", "--skeptic", "s1")).stderr).toMatch(/--chose/);
      expect(raw(question("--chose", "keep", "--skeptic", "s1")).stderr).toMatch(/goes with --decided/);
      expect(raw(question("--decided", "--skeptic", decide(), "--chose", "other")).stderr).toMatch(
        /isn't one of the options/,
      );
    });
  });
});
