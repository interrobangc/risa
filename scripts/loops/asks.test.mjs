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
  createAsk,
  dismissAsk,
  formatAsks,
  getAsk,
  listAsks,
  shorten,
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
      askedAt: "2026-11-21T10:00:00.000Z",
      answer: null,
      answeredAt: null,
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
