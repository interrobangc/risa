// The asks store (asks.mjs) against a throwaway directory.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AskError,
  age,
  answerAsk,
  awaitsAnswer,
  clock,
  createAsk,
  dismissAsk,
  formatAsks,
  getAsk,
  isListed,
  listAsks,
  settleAsk,
  settleDue,
  shorten,
  withAskLock,
} from "./asks.mjs";

const ASKS = new URL("./asks.mjs", import.meta.url).href;
let dir;
beforeEach(() => (dir = join(mkdtempSync(join(tmpdir(), "asks-test-")), "asks")));
afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

const question = (extra = {}) =>
  createAsk(dir, {
    kind: "question",
    topic: "demo",
    text: "Land now?",
    session: "prd-demo",
    options: ["yes", "wait for the check"],
    recommended: "yes",
    ...extra,
  });
const report = () => createAsk(dir, { kind: "report", topic: "demo", text: "Wave 1 landed." });

describe("createAsk", () => {
  it("numbers ids a1, a2, … and stores the fields", () => {
    const a = question({ now: Date.parse("2026-11-21T10:00:00Z") });
    expect(a).toEqual({
      id: "a1",
      kind: "question",
      session: "prd-demo",
      topic: "demo",
      text: "Land now?",
      options: ["yes", "wait for the check"],
      recommended: "yes",
      defaults: false,
      defaultAt: null,
      askedAt: "2026-11-21T10:00:00.000Z",
      answer: null,
      answeredAt: null,
      defaulted: false,
      doneAt: null,
    });
    expect(report().id).toBe("a2");
    expect(getAsk(dir, "a1")).toEqual(a);
    expect(readdirSync(dir).sort()).toEqual(["a1.json", "a2.json"]);
  });

  it("takes the next id after the highest, and skips one another create took", () => {
    question();
    writeFileSync(join(dir, "a7.json"), JSON.stringify({ id: "a7", kind: "report", options: [] }));
    expect(report().id).toBe("a8");
  });

  it("gives creates at once different ids", async () => {
    const script = `import { createAsk } from ${JSON.stringify(ASKS)};
      console.log(createAsk(process.argv[1], { kind: "report", topic: "t", text: "r" }).id);`;
    const runs = Array.from(
      { length: 8 },
      () =>
        new Promise((resolve, reject) => {
          const c = spawn(process.execPath, ["--input-type=module", "-e", script, dir]);
          let out = "";
          c.stdout.on("data", (d) => (out += d));
          c.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`))));
        }),
    );
    const ids = await Promise.all(runs);
    expect(new Set(ids).size).toBe(8);
    expect(listAsks(dir)).toHaveLength(8);
    expect(readdirSync(dir).filter((n) => n.startsWith(".tmp"))).toEqual([]);
  });

  it("takes a recommendation by number, and refuses a bad one", () => {
    expect(question({ recommended: "2" }).recommended).toBe("wait for the check");
    expect(() => question({ recommended: "no" })).toThrow(AskError);
    expect(() => question({ recommended: "3" })).toThrow(/isn't one of the options/);
  });

  it("refuses a report with options, no text, no topic, an unknown kind", () => {
    expect(() => createAsk(dir, { kind: "report", topic: "t", text: "r", options: ["a"] })).toThrow(
      /no options/,
    );
    expect(() => createAsk(dir, { kind: "question", topic: "t", text: " " })).toThrow(/needs its text/);
    expect(() => createAsk(dir, { kind: "question", topic: "", text: "q" })).toThrow(/topic/);
    expect(() => createAsk(dir, { kind: "note", topic: "t", text: "q" })).toThrow(/unknown kind/);
  });
});

describe("answerAsk and dismissAsk", () => {
  it("answers by an option's number", () => {
    question();
    const a = answerAsk(dir, "a1", "2", { now: Date.parse("2026-11-21T11:00:00Z") });
    expect(a.answer).toBe("wait for the check");
    expect(a.answeredAt).toBe("2026-11-21T11:00:00.000Z");
    expect(getAsk(dir, "a1").answer).toBe("wait for the check");
  });

  it("answers in words, and a number past the options is words too", () => {
    question();
    expect(answerAsk(dir, "a1", "  yes, but after lunch ").answer).toBe("yes, but after lunch");
    question();
    expect(answerAsk(dir, "a2", "5").answer).toBe("5");
  });

  it("refuses an unknown id, a second answer, a report, a dismissed question, an empty answer", () => {
    expect(() => answerAsk(dir, "a9", "1")).toThrow(/no ask a9/);
    expect(() => answerAsk(dir, "../x", "1")).toThrow(/no ask/);
    question();
    expect(() => answerAsk(dir, "a1", " ")).toThrow(/needs a number or some text/);
    answerAsk(dir, "a1", "1");
    expect(() => answerAsk(dir, "a1", "2")).toThrow(/already answered: yes/);
    expect(getAsk(dir, "a1").answer).toBe("yes");
    report();
    expect(() => answerAsk(dir, "a2", "ok")).toThrow(/is a report/);
    question();
    dismissAsk(dir, "a3");
    expect(() => answerAsk(dir, "a3", "1")).toThrow(/dismissed/);
  });

  it("lists only open asks: an answered question and a dismissed report leave", () => {
    question();
    report();
    question();
    expect(listAsks(dir).map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
    answerAsk(dir, "a1", "1");
    dismissAsk(dir, "a2");
    expect(listAsks(dir).map((a) => a.id)).toEqual(["a3"]);
    expect(listAsks(dir, { all: true }).map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
    expect(() => dismissAsk(dir, "a2")).toThrow(/already dismissed/);
    expect(() => dismissAsk(dir, "a4")).toThrow(/no ask a4/);
  });

  it("lists nothing when the directory doesn't exist yet", () => {
    expect(listAsks(dir)).toEqual([]);
  });
});

describe("formatting", () => {
  it("prints each ask with its topic, age, numbered options and the recommendation", () => {
    const now = Date.parse("2026-11-21T10:00:00Z");
    question({ now: now - 12 * 60_000 });
    createAsk(dir, {
      kind: "report",
      topic: "other",
      text: "Landed.\nTry the list.",
      now: now - 3 * 3600_000,
    });
    expect(formatAsks(listAsks(dir), now)).toBe(
      [
        "a1  question  demo  12m ago, prd-demo",
        "    Land now?",
        "    1. yes  (recommended)",
        "    2. wait for the check",
        "",
        "a2  report  other  3h ago",
        "    Landed.",
        "    Try the list.",
      ].join("\n"),
    );
    expect(formatAsks([])).toBe("No open asks.");
  });

  it("ages and shortens", () => {
    const t = "2026-11-21T10:00:00Z";
    expect(age(t, Date.parse(t) + 45_000)).toBe("45s");
    expect(age(t, Date.parse(t) + 2 * 86400_000)).toBe("2d");
    expect(shorten("a\n  b")).toBe("a b");
    expect(shorten("x".repeat(20), 10)).toBe("xxxxxxxxx…");
  });
});

describe("defaults", () => {
  const T = Date.parse("2026-11-21T10:00:00Z");
  const MIN = 60_000;
  const defaulting = (extra = {}) => question({ defaults: true, now: T, ...extra });

  it("records whether it may default and when: askedAt plus the wait", () => {
    expect(defaulting()).toMatchObject({ defaults: true, defaultAt: "2026-11-21T10:30:00.000Z" });
    expect(defaulting({ waitMin: 5 }).defaultAt).toBe("2026-11-21T10:05:00.000Z");
    expect(question()).toMatchObject({ defaults: false, defaultAt: null });
  });

  it("needs a recommendation, and a report never defaults", () => {
    expect(() => question({ defaults: true, recommended: null })).toThrow(/needs a recommendation/);
    expect(() => createAsk(dir, { kind: "report", topic: "t", text: "r", defaults: true })).toThrow(/report/);
    expect(listAsks(dir)).toEqual([]);
  });

  it("settles to its recommendation once due, and not before", () => {
    defaulting();
    const early = settleAsk(dir, "a1", { now: T + 29 * MIN });
    expect(early).toMatchObject({ settled: false });
    expect(early.why).toMatch(/^not due until /);
    expect(getAsk(dir, "a1").answeredAt).toBe(null);
    const due = settleAsk(dir, "a1", { now: T + 30 * MIN });
    expect(due.settled).toBe(true);
    expect(getAsk(dir, "a1")).toMatchObject({
      answer: "yes",
      answeredAt: "2026-11-21T10:30:00.000Z",
      defaulted: true,
    });
    // A second settle changes nothing.
    expect(settleAsk(dir, "a1", { now: T + 60 * MIN })).toMatchObject({
      settled: false,
      why: "already defaulted",
    });
    expect(getAsk(dir, "a1").answeredAt).toBe("2026-11-21T10:30:00.000Z");
  });

  it("settling an answered or dismissed ask changes nothing", () => {
    defaulting();
    answerAsk(dir, "a1", "2", { now: T + MIN });
    expect(settleAsk(dir, "a1", { now: T + 31 * MIN })).toMatchObject({ settled: false, why: "answered" });
    expect(getAsk(dir, "a1")).toMatchObject({ answer: "wait for the check", defaulted: false });
    defaulting();
    dismissAsk(dir, "a2", { now: T + MIN });
    expect(settleAsk(dir, "a2", { now: T + 31 * MIN })).toMatchObject({ settled: false, why: "dismissed" });
    expect(getAsk(dir, "a2")).toMatchObject({ answer: null, defaulted: false });
  });

  it("a waiting ask never settles", () => {
    question({ now: T });
    expect(settleAsk(dir, "a1", { now: T + 1000 * MIN })).toMatchObject({
      settled: false,
      why: "waits for an answer",
    });
    expect(settleDue(dir, { now: T + 1000 * MIN })).toEqual([]);
    expect(awaitsAnswer(getAsk(dir, "a1"))).toBe(true);
  });

  it("settleDue settles only the due ones", () => {
    defaulting();
    defaulting({ waitMin: 60 });
    question({ now: T });
    expect(settleDue(dir, { now: T + 45 * MIN }).map((a) => a.id)).toEqual(["a1"]);
    expect(
      listAsks(dir)
        .filter(awaitsAnswer)
        .map((a) => a.id),
    ).toEqual(["a2", "a3"]);
  });

  it("a defaulted ask stays listed until dismissed, and doesn't await an answer", () => {
    defaulting();
    settleAsk(dir, "a1", { now: T + 30 * MIN });
    const a = getAsk(dir, "a1");
    expect(awaitsAnswer(a)).toBe(false);
    expect(isListed(a)).toBe(true);
    expect(listAsks(dir).map((x) => x.id)).toEqual(["a1"]);
    dismissAsk(dir, "a1");
    expect(listAsks(dir)).toEqual([]);
  });

  it("a defaulted ask can't be answered, and says why", () => {
    defaulting();
    settleAsk(dir, "a1", { now: T + 30 * MIN });
    expect(() => answerAsk(dir, "a1", "2")).toThrow(
      /was decided for you: it took "yes" at .* can't be answered/,
    );
    expect(getAsk(dir, "a1").answer).toBe("yes");
  });

  it("the lock: a held one makes the others wait, then give up; a dead holder's is taken over", () => {
    defaulting();
    withAskLock(dir, "a1", () => {
      expect(() => answerAsk(dir, "a1", "2", { lockWaitMs: 100 })).toThrow(/a1 is busy/);
      expect(() => settleAsk(dir, "a1", { now: T + 31 * MIN, lockWaitMs: 100 })).toThrow(/a1 is busy/);
    });
    expect(getAsk(dir, "a1").answeredAt).toBe(null);
    // A holder that died leaves its lock behind: the next one takes it over.
    writeFileSync(join(dir, ".a1.lock"), "999999 gone");
    expect(answerAsk(dir, "a1", "1", { lockWaitMs: 100 }).answer).toBe("yes");
    expect(readdirSync(dir).filter((n) => n.endsWith(".lock"))).toEqual([]);
  });

  it("an answer and a settle racing for one ask leave exactly one, and the loser reports it", async () => {
    defaulting();
    // Hold the exclusive step while both start, then let go: they race for it.
    const lock = join(dir, ".a1.lock");
    writeFileSync(lock, `${process.pid} the-test`);
    const due = T + 31 * MIN;
    const node = (script) =>
      new Promise((resolve) => {
        const c = spawn(process.execPath, ["--input-type=module", "-e", script, dir]);
        let out = "";
        let err = "";
        c.stdout.on("data", (d) => (out += d));
        c.stderr.on("data", (d) => (err += d));
        c.on("exit", (code) => resolve({ code, out: out.trim(), err }));
      });
    const answering = node(`import { answerAsk } from ${JSON.stringify(ASKS)};
      try { answerAsk(process.argv[1], "a1", "2"); console.log("answered"); }
      catch (e) { console.log("lost: " + e.message); }`);
    const settling = node(`import { settleAsk } from ${JSON.stringify(ASKS)};
      const r = settleAsk(process.argv[1], "a1", { now: ${due} });
      console.log(r.settled ? "settled" : "lost: " + r.why);`);
    await new Promise((r) => setTimeout(r, 400));
    // Neither wrote while the step was held.
    expect(getAsk(dir, "a1").answeredAt).toBe(null);
    rmSync(lock);
    const [a, b] = await Promise.all([answering, settling]);
    expect(a.code, a.err).toBe(0);
    expect(b.code, b.err).toBe(0);
    const final = getAsk(dir, "a1");
    if (a.out === "answered") {
      expect(b.out).toBe("lost: answered");
      expect(final).toMatchObject({ answer: "wait for the check", defaulted: false });
    } else {
      expect(a.out).toMatch(/^lost: a1 was decided for you/);
      expect(b.out).toBe("settled");
      expect(final).toMatchObject({ answer: "yes", defaulted: true });
    }
    expect(readdirSync(dir).filter((n) => n.endsWith(".lock"))).toEqual([]);
  });

  it("the listing shows the countdown, due once past, and the decided part", () => {
    defaulting();
    defaulting();
    settleAsk(dir, "a2", { now: T + 30 * MIN });
    const at = clock("2026-11-21T10:30:00Z");
    expect(formatAsks(listAsks(dir), T + 12 * MIN)).toContain(
      `a1  question  demo  12m ago, prd-demo, takes "yes" in 18m (at ${at}) unless answered`,
    );
    const later = formatAsks(listAsks(dir), T + 40 * MIN);
    expect(later).toContain(`a1  question  demo  40m ago, prd-demo, takes "yes": due (still answerable)`);
    const [open, decided] = later.split("\n\nDECIDED FOR YOU");
    expect(open).not.toContain("a2 ");
    expect(decided).toContain("a2  question  demo  40m ago, prd-demo");
    expect(decided).toContain(`    → took "yes" at ${at}, 10m ago, unanswered`);
  });
});
