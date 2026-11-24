// The skeptic: the store, the pure checker and the brief against throwaway
// directories, and `pnpm prd skeptic` / `prompt skeptic` through prd.sh with
// CARETOOK_SKEPTIC_DIR set. Nothing reads or writes the real .loops/.skeptic.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SLICE_SIZE_RULE,
  SkepticError,
  VERDICTS,
  checkRecord,
  getRecord,
  listRecords,
  maxAgeMin,
  questionHash,
  readRules,
  recordVerdict,
  skepticBrief,
  useRecord,
} from "./skeptics.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const REPO = join(HERE, "../..");
const PRD_SH = join(HERE, "prd.sh");
const TIP = "a".repeat(40);
const OTHER_TIP = "b".repeat(40);
const NOW = Date.parse("2026-11-23T12:00:00Z");
const Q = "Keep the old label?";
const OPTIONS = ["keep", "drop"];
const HASH = questionHash(Q, OPTIONS);

let root, dir;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "skeptic-test-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  dir = mkdtempSync(join(root, "store-"));
});

const land = (over = {}) =>
  recordVerdict(dir, {
    kind: "land",
    verdict: "go",
    why: "unrelated flake",
    topic: "t",
    tip: TIP,
    action: "force",
    now: NOW,
    ...over,
  });
const ask = (over = {}) =>
  recordVerdict(dir, {
    kind: "ask",
    verdict: "ask",
    why: "the user's call",
    topic: "t",
    question: Q,
    offers: OPTIONS,
    askerClass: "defaults",
    now: NOW,
    ...over,
  });
const decide = (over = {}) => ask({ verdict: "decide", option: "keep", ...over });
const plan = (over = {}) =>
  recordVerdict(dir, { kind: "plan", verdict: "send-back", why: "a gap", topic: "t", now: NOW, ...over });

const wantLand = (over = {}) => ({ use: "land", topic: "t", action: "force", tip: TIP, ...over });
const wantAsk = (over = {}) => ({
  use: "ask",
  topic: "t",
  questionHash: HASH,
  askerClass: "defaults",
  ...over,
});
const wantDecided = (over = {}) => ({
  use: "decided",
  topic: "t",
  questionHash: HASH,
  chose: "keep",
  ...over,
});
const check = (r, wanted, opts = {}) => checkRecord(r, wanted, { now: NOW, ...opts });

describe("the store", () => {
  it("writes a record and lists it, oldest first", () => {
    const a = land();
    const b = ask();
    expect(getRecord(dir, a.id)).toMatchObject({ kind: "land", verdict: "go", tip: TIP, usedAt: null });
    expect(listRecords(dir).map((r) => r.id)).toEqual([a.id, b.id]);
    expect(listRecords(dir, { topic: "other" })).toEqual([]);
  });

  it("never repeats an id", () => {
    const ids = Array.from({ length: 12 }, () => plan().id);
    expect(new Set(ids).size).toBe(12);
    expect(ids.at(-1)).toBe("s12");
  });

  it("gives no record for a path or an unknown id", () => {
    expect(getRecord(dir, "../secret")).toBeNull();
    expect(getRecord(dir, "s99")).toBeNull();
  });

  it.each([
    ["ask", "go"],
    ["ask", "no"],
    ["land", "decide"],
    ["land", "ask"],
    ["plan", "decide"],
    ["plan", "no"],
  ])("refuses a %s verdict of %s", (kind, verdict) => {
    expect(VERDICTS[kind]).not.toContain(verdict);
    expect(() => recordVerdict(dir, { kind, verdict, why: "x", topic: "t" })).toThrow(/answers/);
    expect(listRecords(dir)).toEqual([]);
  });

  it("needs a one-line why, a topic and a known kind", () => {
    expect(() => land({ why: " " })).toThrow(/why/);
    expect(() => land({ why: "one\ntwo" })).toThrow(/one line/);
    expect(() => land({ topic: "" })).toThrow(/topic/);
    expect(() => recordVerdict(dir, { kind: "other", verdict: "go", why: "x", topic: "t" })).toThrow(/kind/);
  });

  it("binds a land verdict to a known action and a full tip", () => {
    expect(() => land({ action: "merge" })).toThrow(/action/);
    expect(() => land({ action: "decline" })).toThrow(/action/);
    expect(() => land({ tip: "abc1234" })).toThrow(/full tip/);
    expect(land({ action: "decline PRRT_1" }).action).toBe("decline PRRT_1");
    expect(() => plan({ tip: TIP })).toThrow(/only a land/);
  });

  it("needs an ask verdict's question and class", () => {
    expect(() => ask({ question: "" })).toThrow(/question/);
    expect(() => ask({ askerClass: null })).toThrow(/class/);
    expect(() => plan({ question: Q })).toThrow(/only an ask/);
  });

  it("refuses a decide on a --waits question when it is recorded", () => {
    expect(() => decide({ askerClass: "waits" })).toThrow(SkepticError);
    expect(() => decide({ askerClass: "waits" })).toThrow(/user's/);
    expect(listRecords(dir)).toEqual([]);
    expect(ask({ askerClass: "waits" }).verdict).toBe("ask");
  });

  it("makes a decide name one of the options, and only a decide", () => {
    expect(() => decide({ option: "neither" })).toThrow(/options/);
    expect(() => ask({ option: "keep" })).toThrow(/only a decide/);
  });

  it("spends a record once", () => {
    const r = ask();
    expect(useRecord(dir, r.id, wantAsk(), { now: NOW }).usedAt).toBeTruthy();
    expect(getRecord(dir, r.id).usedAt).toBeTruthy();
    expect(() => useRecord(dir, r.id, wantAsk(), { now: NOW })).toThrow(/already used/);
  });

  it("reads the age limit from its setting", () => {
    expect(maxAgeMin(undefined)).toBe(60);
    expect(maxAgeMin("")).toBe(60);
    expect(maxAgeMin("nope")).toBe(60);
    expect(maxAgeMin("-1")).toBe(60);
    expect(maxAgeMin("5")).toBe(5);
  });

  it("applies CARETOOK_SKEPTIC_MAX_MIN when the caller names no limit", () => {
    const r = land();
    vi.stubEnv("CARETOOK_SKEPTIC_MAX_MIN", "5");
    try {
      expect(checkRecord(r, wantLand(), { now: NOW + 6 * 60_000 }).reason).toMatch(/over 5 minutes/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the checker", () => {
  it("passes the right kind, verdict, action, topic and tip", () => {
    expect(check(land(), wantLand())).toEqual({ ok: true });
    const decline = land({ action: "decline PRRT_1" });
    expect(check(decline, wantLand({ action: "decline PRRT_1" }))).toEqual({ ok: true });
    expect(check(land({ action: "no-review" }), wantLand({ action: "no-review" }))).toEqual({ ok: true });
  });

  it.each([
    ["another topic", () => land(), wantLand({ topic: "other" }), /is for t/],
    ["another tip", () => land(), wantLand({ tip: OTHER_TIP }), /judged a{7}/],
    ["another action", () => land(), wantLand({ action: "no-review" }), /judged "force"/],
    [
      "a decline go for --force",
      () => land({ action: "decline PRRT_1" }),
      wantLand(),
      /judged "decline PRRT_1"/,
    ],
    ["a no", () => land({ verdict: "no", why: "a real bug" }), wantLand(), /said no: a real bug/],
    ["an ask record", () => ask(), wantLand(), /not a landing/],
  ])("refuses a landing on %s", (_name, make, wanted, reason) => {
    const r = check(make(), wanted);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(reason);
  });

  it("refuses no record, an old one and a future one, and honours the limit", () => {
    expect(check(null, wantLand()).reason).toMatch(/no such/);
    const r = land();
    expect(check(r, wantLand(), { now: NOW + 60 * 60_000 }).ok).toBe(true);
    expect(check(r, wantLand(), { now: NOW + 60 * 60_000 + 1 }).reason).toMatch(/over 60 minutes/);
    expect(check(r, wantLand(), { now: NOW + 6 * 60_000, maxMin: 5 }).reason).toMatch(/over 5 minutes/);
    expect(check(r, wantLand(), { now: NOW - 1 }).reason).toMatch(/usable time/);
    expect(check({ ...r, at: "soon" }, wantLand()).reason).toMatch(/usable time/);
  });

  it("refuses a used record", () => {
    const r = ask();
    useRecord(dir, r.id, wantAsk(), { now: NOW });
    expect(check(getRecord(dir, r.id), wantAsk()).reason).toMatch(/already used/);
  });

  it("lets an ask take an ask verdict, a land no and a plan send-back", () => {
    expect(check(ask(), wantAsk())).toEqual({ ok: true });
    expect(check(land({ verdict: "no" }), wantAsk())).toEqual({ ok: true });
    expect(check(plan(), wantAsk())).toEqual({ ok: true });
  });

  it.each([
    ["a decide, pointing at --decided", () => decide(), wantAsk(), /--decided --skeptic/],
    ["a land go", () => land(), wantAsk(), /land go/],
    ["a plan go", () => plan({ verdict: "go" }), wantAsk(), /plan go/],
    ["another question", () => ask(), wantAsk({ questionHash: questionHash("Else?", OPTIONS) }), /another/],
    ["other options", () => ask(), wantAsk({ questionHash: questionHash(Q, ["keep"]) }), /another/],
    ["another class", () => ask(), wantAsk({ askerClass: "waits" }), /--defaults question/],
    ["another topic", () => ask(), wantAsk({ topic: "other" }), /is for t/],
  ])("refuses an ask on %s", (_name, make, wanted, reason) => {
    const r = check(make(), wanted);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(reason);
  });

  it("files a decision only from a matching decide on a defaulting question", () => {
    expect(check(decide(), wantDecided())).toEqual({ ok: true });
    expect(check(ask(), wantDecided()).reason).toMatch(/isn't a decide/);
    expect(check(decide(), wantDecided({ chose: "drop" })).reason).toMatch(/chose "keep"/);
    expect(check(decide(), wantDecided({ questionHash: "x" })).reason).toMatch(/another/);
    expect(check(decide(), wantDecided({ askerClass: "waits" })).reason).toMatch(/user's/);
    expect(check({ ...decide(), askerClass: "waits" }, wantDecided()).reason).toMatch(/user's/);
  });
});

describe("a stall verdict", () => {
  const stall = (over = {}) =>
    recordVerdict(dir, {
      kind: "stall",
      verdict: "restart",
      why: "quiet an hour, its stop recorded",
      topic: "t",
      slice: "4",
      askerClass: "defaults",
      now: NOW,
      ...over,
    });
  const wantStall = (over = {}) => wantAsk({ question: "Slice 4 has stalled twice: restart it?", ...over });

  it("records restart, leave or ask, bound to its slice and class", () => {
    expect(VERDICTS.stall).toEqual(["restart", "leave", "ask"]);
    for (const verdict of VERDICTS.stall)
      expect(stall({ verdict })).toMatchObject({ kind: "stall", slice: "4" });
    expect(() => stall({ verdict: "go" })).toThrow(/answers restart, leave or ask/);
    expect(() => stall({ slice: null })).toThrow(/names its slice/);
    expect(() => stall({ askerClass: null })).toThrow(/--defaults, or --waits/);
    expect(() => stall({ question: Q })).toThrow(/no question/);
    expect(() => ask({ slice: "4" })).toThrow(/only a stall verdict names a slice/);
  });

  it("refuses restart or leave on a never-list step: only ask", () => {
    expect(() => stall({ askerClass: "waits" })).toThrow(
      /never list is the user's: a stall skeptic can only ask/,
    );
    expect(() => stall({ askerClass: "waits", verdict: "leave" })).toThrow(/can only ask/);
    expect(stall({ askerClass: "waits", verdict: "ask" })).toMatchObject({
      verdict: "ask",
      askerClass: "waits",
    });
  });

  it("lets an ask take its ask verdict on a question naming the slice", () => {
    expect(check(stall({ verdict: "ask" }), wantStall())).toEqual({ ok: true });
    expect(check(stall({ verdict: "ask" }), wantStall({ question: "Restart t-4?" }))).toEqual({ ok: true });
    expect(check(stall({ verdict: "ask" }), wantStall({ question: "Restart slice 5?" })).reason).toMatch(
      /name "slice 4"/,
    );
    expect(check(stall(), wantStall()).reason).toMatch(/stall restart: act on it/);
    expect(check(stall({ verdict: "leave" }), wantStall()).reason).toMatch(/stall leave/);
    const never = stall({ verdict: "ask", askerClass: "waits" });
    expect(check(never, wantStall()).reason).toMatch(/takes --waits/);
    expect(check(never, wantStall({ askerClass: "waits" }))).toEqual({ ok: true });
  });
});

describe("the brief", () => {
  const rules = () => readRules(REPO);
  const preferencesNever = () =>
    /Never \(`--waits`\): (.+?) \(agent-autonomy, /.exec(
      readFileSync(join(REPO, "docs/agents/preferences.md"), "utf8"),
    )[1];

  it("reads the never list as the preferences doc has it", () => {
    expect(rules().neverList).toBe(preferencesNever());
    expect(rules().whatToAsk).toContain("Existing data");
    expect(rules().whatToAsk).not.toContain("**Unattended**");
    expect(rules().fixesRules).toContain("One slice and one backlog item per fix");
  });

  it.each([
    ["ask", ["decide <option>", "**ask**", "always ask"]],
    ["land", ["**go**", "**no**"]],
    ["plan", ["**go**", "**send-back**", "once more", "a slice too big"]],
    ["stall", ["**restart**", "**leave**", "**ask**", "restarted once", "never resets, cleans or removes"]],
  ])("the %s brief has the evidence, the never list and its verdict words", (kind, words) => {
    const brief = skepticBrief(kind, { evidence: "EVIDENCE-LINE", rules: rules() });
    expect(brief).toContain("EVIDENCE-LINE");
    expect(brief).toContain(preferencesNever());
    expect(brief).toContain("What is worth asking");
    expect(brief).toContain("The fix topics");
    for (const word of words) expect(brief).toContain(word);
  });

  it("the plan brief carries the slice-size cap; the others don't", () => {
    const brief = (kind) => skepticBrief(kind, { evidence: "x", rules: rules() });
    expect(brief("plan")).toContain(SLICE_SIZE_RULE);
    expect(SLICE_SIZE_RULE).toContain("more than about 8 files, or more than one running topic's hot file");
    expect(SLICE_SIZE_RULE).toContain("split it into slices that each land on their own");
    for (const kind of ["ask", "land"]) expect(brief(kind)).not.toContain(SLICE_SIZE_RULE);
  });

  it("refuses an empty evidence or another kind", () => {
    expect(() => skepticBrief("ask", { evidence: " \n", rules: rules() })).toThrow(/empty/);
    expect(() => skepticBrief("other", { evidence: "x", rules: rules() })).toThrow(
      /ask, land, plan or stall/,
    );
  });

  it("refuses docs that lost the never list", () => {
    const docs = mkdtempSync(join(root, "docs-"));
    mkdirSync(join(docs, "docs/agents"), { recursive: true });
    mkdirSync(join(docs, "plans"));
    writeFileSync(join(docs, "docs/agents/preferences.md"), "# Preferences\n");
    writeFileSync(join(docs, "docs/agents/planner.md"), "## What to ask\n\nx\n\n## The skeptic pass\n\ny\n");
    writeFileSync(join(docs, "plans/fixes-rules.md"), "# Rules\n\nz\n");
    expect(() => readRules(docs)).toThrow(/no never list/);
    rmSync(join(docs, "plans/fixes-rules.md"));
    expect(() => readRules(docs)).toThrow(/fixes-rules/);
  });
});

describe("the commands", () => {
  const prd = (...args) => {
    const env = { ...process.env, CARETOOK_SKEPTIC_DIR: dir };
    delete env.CARETOOK_SESSION;
    const r = spawnSync("bash", [PRD_SH, ...args], { encoding: "utf8", env });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it("records and lists a verdict", () => {
    const made = prd(
      "skeptic",
      "record",
      "--kind",
      "land",
      "--verdict",
      "go",
      "--why",
      "plain flake",
      "--tip",
      TIP,
      "--action",
      "force",
      "--topic",
      "t",
      "--session",
      "prd-t",
    );
    expect(made.err).toBe("");
    expect(made.out.trim()).toBe("s1");
    expect(prd("skeptic").out).toContain("land force @aaaaaaa: go: plain flake");
    expect(prd("skeptic", "list", "--topic", "other").out).toContain("No skeptic verdicts");
    expect(JSON.parse(prd("skeptic", "--topic", "t", "--json").out)[0]).toMatchObject({
      id: "s1",
      session: "prd-t",
      tip: TIP,
    });
  });

  it("records what an ask verdict judged", () => {
    const made = prd(
      "skeptic",
      "record",
      "--kind",
      "ask",
      "--verdict",
      "decide",
      "--why",
      "reversible",
      "--option",
      "keep",
      "--question",
      Q,
      "--offer",
      "keep",
      "--offer",
      "drop",
      "--defaults",
      "--topic",
      "t",
    );
    expect(made.code).toBe(0);
    expect(getRecord(dir, "s1")).toMatchObject({
      questionHash: HASH,
      askerClass: "defaults",
      option: "keep",
    });
  });

  it("refuses a bad verdict and files nothing", () => {
    const r = prd("skeptic", "record", "--kind", "ask", "--verdict", "go", "--why", "x", "--topic", "t");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/answers decide or ask/);
    expect(listRecords(dir)).toEqual([]);
  });

  it("prints a brief from an evidence file and refuses a missing one", () => {
    const file = join(dir, "evidence.md");
    writeFileSync(file, "the failing test is unrelated\n");
    const ok = prd("prompt", "skeptic", "land", "--evidence", file);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("the failing test is unrelated");
    const missing = prd("prompt", "skeptic", "land", "--evidence", join(dir, "none.md"));
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/can't read the evidence/);
    expect(prd("prompt", "skeptic", "land").code).toBe(1);
  });
});
