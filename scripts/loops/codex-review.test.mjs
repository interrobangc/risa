// Codex's verdict, from PR states captured from real Codex reviews on GitHub
// (codex-review.fixtures/, cut down to what the verdict reads; the human's
// login replaced): waiting is PR #4 (no Codex activity); the rest are the
// throwaway PR #7, in order: running (Codex reviewing the first push), findings
// (two P2 threads, plus a human comment), declined (one replied to and
// resolved), outdated (the fix pushed and reviewed clean, but Codex left its
// fixed thread open), clean (every thread resolved, asked again) and stale (one
// more push, before Codex started on it).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isCodex, verdict, verdictLine, verdictText } from "./codex-review.mjs";

const CLI = new URL("./codex-review.mjs", import.meta.url).pathname;
const path = (name) => new URL(`./codex-review.fixtures/${name}.json`, import.meta.url).pathname;
const fixture = (name) => JSON.parse(readFileSync(path(name), "utf8"));

const FIRST = "b131ab720eb31e4ef73c65ccd8e0862246f7cd5d";
const FIXED = "27837955ea07d283b98e0cc3828f12e8fc4b27f5";
const LAST = "70d3d0ffadca00c124b6c4c40b8411ff3535d2ab";
const LAST_ITEMS = {
  path: "scripts/codex-fixture-scratch.mjs",
  line: 5,
  priority: "P2",
  body: "Slice from the end when selecting the last items",
  url: "https://github.com/caretook/caretook.com/pull/7#discussion_r4650487588",
  threadId: "PRRT_kwDOVx-WLM66Riu3",
  outdated: false,
};
const AVERAGE = {
  path: "scripts/codex-fixture-scratch.mjs",
  line: 12,
  priority: "P2",
  body: "Stop summing before reaching the array length",
  url: "https://github.com/caretook/caretook.com/pull/7#discussion_r4650487594",
  threadId: "PRRT_kwDOVx-WLM66Riu7",
  outdated: false,
};

describe("codex-review verdict", () => {
  it("is waiting when Codex hasn't touched the PR", () => {
    const v = verdict(fixture("waiting"));
    expect(v).toMatchObject({ state: "waiting", findings: [], reviewedSha: null, reviewingSha: null });
    expect(verdictLine(v)).toBe("codex: waiting for a review of 8aa1e3c");
  });

  it("is waiting while a review runs, and names the commit it's on", () => {
    const v = verdict(fixture("running"));
    expect(v).toMatchObject({ state: "waiting", headSha: FIRST, reviewingSha: FIRST, reviewedSha: null });
    expect(verdictLine(v)).toBe("codex: reviewing b131ab7");
  });

  it("lists findings with path, line, priority, title, link and thread id", () => {
    const v = verdict(fixture("findings"));
    expect(v).toMatchObject({ state: "findings", headSha: FIRST, reviewedSha: FIRST, number: 7 });
    expect(v.findings).toEqual([LAST_ITEMS, AVERAGE]);
    expect(verdictText(v)).toContain(
      "  P2 scripts/codex-fixture-scratch.mjs:12  Stop summing before reaching the array length",
    );
  });

  it("ignores a human's comment", () => {
    const pr = fixture("findings");
    expect(pr.comments.nodes.some((c) => c.author.login === "a-human")).toBe(true);
    expect(verdict(pr).findings.map((f) => f.threadId)).toEqual([LAST_ITEMS.threadId, AVERAGE.threadId]);
  });

  it("drops a declined finding once it's replied to and resolved", () => {
    const pr = fixture("declined");
    const thread = pr.reviewThreads.nodes.find((t) => t.id === LAST_ITEMS.threadId);
    expect(thread).toMatchObject({ isResolved: true });
    expect(thread.comments.nodes.map((c) => c.author.login)).toEqual(["chatgpt-codex-connector", "a-human"]);
    expect(verdict(pr)).toMatchObject({ state: "findings", findings: [AVERAGE] });
  });

  it("still blocks on a fixed finding Codex left open (outdated) until it's resolved", () => {
    const v = verdict(fixture("outdated"));
    expect(v).toMatchObject({ state: "findings", headSha: FIXED, reviewedSha: FIXED });
    expect(v.findings).toEqual([{ ...AVERAGE, line: 12, outdated: true }]);
    expect(verdictText(v)).toContain("(outdated)");
  });

  it("is clean when Codex reviewed the head and every thread of its own is resolved", () => {
    const v = verdict(fixture("clean"));
    expect(v).toMatchObject({ state: "clean", findings: [], headSha: FIXED, reviewedSha: FIXED });
    expect(verdictLine(v)).toBe("codex: clean on 2783795");
  });

  it("is stale when the last review is of an older head, whatever 👍 is on the PR", () => {
    const pr = fixture("stale");
    expect(pr.reactions.nodes.map((r) => r.content)).toContain("THUMBS_UP");
    const v = verdict(pr);
    expect(v).toMatchObject({ state: "stale", findings: [], headSha: LAST, reviewedSha: FIXED });
    expect(verdictLine(v)).toBe("codex: stale (last reviewed 2783795, head 70d3d0f): ask again with --again");
  });

  it("accepts the full GraphQL response as well as the pullRequest node", () => {
    expect(verdict({ data: { repository: { pullRequest: fixture("clean") } } }).state).toBe("clean");
  });

  it("knows Codex's login with and without [bot]", () => {
    expect(isCodex("chatgpt-codex-connector")).toBe(true);
    expect(isCodex("chatgpt-codex-connector[bot]")).toBe(true);
    expect(isCodex("a-human")).toBe(false);
  });

  it("prints JSON, a line or text from the command line", () => {
    const run = (...args) => execFileSync("node", [CLI, path("findings"), ...args], { encoding: "utf8" });
    expect(JSON.parse(run()).state).toBe("findings");
    expect(run("--line")).toBe("codex: 2 open findings on b131ab7\n");
    expect(run("--text")).toContain("thread PRRT_kwDOVx-WLM66Riu7");
  });
});
