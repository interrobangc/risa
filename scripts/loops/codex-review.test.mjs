// Codex's verdict, from PR states captured from real Codex reviews on GitHub
// (codex-review.fixtures/, cut down to what the verdict reads; the human's
// login replaced): waiting is PR #4 (no Codex activity); the rest are the
// throwaway PR #7, in order: running (Codex reviewing the first push), findings
// (two P2 threads, plus a human comment), declined (one replied to and
// resolved), outdated (the fix pushed and reviewed clean, but Codex left its
// fixed thread open), clean (every thread resolved, asked again) and stale (one
// more push, before Codex started on it). out-of-credits is PR #48 (dev into
// staging): Codex reviewed one head, then answered later pushes with its usage
// limit comment and marked its summary "failed". The carry rule runs against a
// throwaway repository, with PR states built by hand in the same shape.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { carried, isCodex, outOfCreditsAt, verdict, verdictLine, verdictText } from "./codex-review.mjs";

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

  it("is out of credits when Codex's usage-limit comment is its latest word, keeping old findings", () => {
    const v = verdict(fixture("out-of-credits"));
    expect(v).toMatchObject({
      state: "out-of-credits",
      headSha: "7a205be1d73d85e099e8a70b3e80b03f1372cde5",
      reviewedSha: "69e9c6e268a0a3214d48d32ef6f5c9ada803e2ae",
      reviewingSha: null,
      outOfCreditsAt: "2026-11-22T05:04:50Z",
    });
    expect(v.findings.map((f) => f.priority)).toEqual(["P2", "P2"]);
    expect(verdictLine(v)).toBe(
      "codex: out of credits, no review of 7a205be is coming (last reviewed 69e9c6e); land with --no-review, or add credits and ask again with --again",
    );
  });

  it("isn't out of credits once Codex is back at work after its limit comment", () => {
    const pr = fixture("out-of-credits");
    pr.reactions.nodes.push({
      content: "EYES",
      createdAt: "2026-11-22T06:00:00Z",
      user: { login: "chatgpt-codex-connector[bot]" },
    });
    expect(outOfCreditsAt(pr)).toBeNull();
    expect(verdict(pr).state).toBe("waiting");
  });

  it("isn't out of credits when Codex reviewed the head", () => {
    const pr = fixture("clean");
    pr.comments.nodes.unshift({
      author: { login: "chatgpt-codex-connector" },
      body: "You have reached your Codex usage limits for code reviews.",
      createdAt: "2026-11-21T03:00:00Z",
    });
    expect(verdict(pr).state).toBe("clean");
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

describe("a clean verdict carried over dev merges", () => {
  let repo, reviewed;
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
  const commit = (files, msg) => {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(repo, name), text);
    git("add", "-A");
    git("commit", "-qm", msg);
    return git("rev-parse", "HEAD");
  };
  const lines = (...changed) =>
    Array.from({ length: 9 }, (_, i) => (changed.includes(i) ? `line ${i} changed` : `line ${i}`)).join(
      "\n",
    ) + "\n";
  // dev moves (files), then the branch merges it; returns the new head.
  const mergeDev = (files) => {
    git("checkout", "-q", "dev");
    commit(files, "dev work");
    git("checkout", "-q", "prd/x");
    git("merge", "-q", "--no-ff", "-m", "merge dev", "dev");
    return git("rev-parse", "HEAD");
  };
  const state = (sha, status) =>
    `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: sha, status } })} -->`;
  // The PR as GitHub returns it: Codex's summary says `now`; its edit history holds `before`.
  const pr = (head, now, before = [], threads = []) => ({
    number: 9,
    url: "https://example.test/pr/9",
    headRefOid: head,
    reviews: { nodes: [] },
    reviewThreads: { nodes: threads },
    comments: {
      nodes: [
        {
          author: { login: "chatgpt-codex-connector" },
          body: state(...now),
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:09:00Z",
          userContentEdits: {
            nodes: before.map(([sha, status], i) => ({
              editedAt: `2026-01-01T00:0${i}:00Z`,
              diff: state(sha, status),
            })),
          },
        },
      ],
    },
    reactions: { nodes: [] },
  });
  const check = (json) => carried(json, { repo, trunk: "dev" });

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "codex-carry-")));
    execFileSync("git", ["init", "-q", "-b", "dev", repo]);
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    git("config", "core.hooksPath", "/dev/null");
    commit({ "mine.txt": lines(), "other.txt": "o\n" }, "base");
    git("checkout", "-qb", "prd/x");
    reviewed = commit({ "mine.txt": lines(1) }, "work");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("carries over a plain merge of dev that touches other files", () => {
    const head = mergeDev({ "other.txt": "dev\n", "new.txt": "n\n" });
    const json = pr(head, [reviewed, "completed"]);
    expect(verdict(json).state).toBe("stale");
    expect(carried(json).state).toBe("stale");
    const v = check(json);
    expect(v).toMatchObject({
      state: "clean",
      findings: [],
      headSha: head,
      reviewedSha: reviewed,
      carriedFrom: reviewed,
    });
    expect(verdictLine(v)).toBe(
      `codex: clean on ${head.slice(0, 7)} (carried from ${reviewed.slice(0, 7)}: only plain dev merges since, the PR's diff unchanged)`,
    );
  });

  it("carries over several dev merges, and while Codex reviews the merged head by itself", () => {
    mergeDev({ "other.txt": "dev\n" });
    const head = mergeDev({ "new.txt": "n\n" });
    const json = pr(
      head,
      [head, "running"],
      [
        [reviewed, "running"],
        [reviewed, "completed"],
      ],
    );
    expect(verdict(json)).toMatchObject({ state: "waiting", reviewedSha: reviewed, reviewingSha: head });
    expect(check(json)).toMatchObject({ state: "clean", carriedFrom: reviewed });
  });

  it("is the head's own verdict once Codex finishes on it", () => {
    const head = mergeDev({ "other.txt": "dev\n" });
    const v = check(
      pr(
        head,
        [head, "completed"],
        [
          [reviewed, "completed"],
          [head, "running"],
        ],
      ),
    );
    expect(v).toMatchObject({ state: "clean", reviewedSha: head });
    expect(v.carriedFrom).toBeUndefined();
  });

  it("still waits when the running review is of the head Codex already reviewed (--again)", () => {
    const json = pr(reviewed, [reviewed, "running"], [[reviewed, "completed"]]);
    expect(check(json)).toMatchObject({ state: "waiting", reviewingSha: reviewed });
  });

  it("doesn't carry over new work by the branch", () => {
    mergeDev({ "other.txt": "dev\n" });
    const head = commit({ "mine.txt": lines(1, 5) }, "more work");
    const v = check(pr(head, [reviewed, "completed"]));
    expect(v.state).toBe("stale");
    expect(v.notCarried).toBe(`${head.slice(0, 7)} isn't a merge of dev`);
    expect(verdictLine(v)).toContain("; not carried: ");
    expect(check(pr(head, [head, "running"], [[reviewed, "completed"]])).state).toBe("waiting");
  });

  it("doesn't carry when dev changed a file the PR touches, even if it merged cleanly", () => {
    const head = mergeDev({ "mine.txt": lines(7) });
    const v = check(pr(head, [reviewed, "completed"]));
    expect(v).toMatchObject({ state: "stale", notCarried: "dev changed mine.txt, which the PR touches" });
  });

  it("doesn't carry over a merge with a conflict resolved", () => {
    git("checkout", "-q", "dev");
    commit({ "mine.txt": lines().replace("line 1", "line 1 by dev") }, "dev work");
    git("checkout", "-q", "prd/x");
    expect(() => git("merge", "-q", "--no-ff", "-m", "merge dev", "dev")).toThrow();
    const head = commit({ "mine.txt": lines(1) }, "merge dev");
    expect(git("rev-list", "--parents", "-1", head).split(" ")).toHaveLength(3);
    expect(check(pr(head, [reviewed, "completed"])).notCarried).toMatch(/isn't a plain merge of dev/);
  });

  it("doesn't carry over a merge of dev with changes added to it", () => {
    mergeDev({ "other.txt": "dev\n" });
    writeFileSync(join(repo, "extra.txt"), "slipped in\n");
    git("add", "-A");
    git("commit", "-q", "--amend", "--no-edit");
    const v = check(pr(git("rev-parse", "HEAD"), [reviewed, "completed"]));
    expect(v.notCarried).toMatch(/isn't a plain merge of dev/);
  });

  it("doesn't carry over a merge of another branch", () => {
    git("checkout", "-qb", "side", "dev");
    commit({ "side.txt": "s\n" }, "side work");
    git("checkout", "-q", "prd/x");
    git("merge", "-q", "--no-ff", "-m", "merge side", "side");
    const v = check(pr(git("rev-parse", "HEAD"), [reviewed, "completed"]));
    expect(v.notCarried).toMatch(/isn't a merge of dev/);
  });

  it("doesn't carry a review with a finding still open", () => {
    const head = mergeDev({ "other.txt": "dev\n" });
    const open = {
      id: "T1",
      isResolved: false,
      path: "mine.txt",
      line: 2,
      comments: {
        nodes: [{ author: { login: "chatgpt-codex-connector" }, body: "![P2 Badge](x) A finding", url: "u" }],
      },
    };
    const v = check(pr(head, [reviewed, "completed"], [], [open]));
    expect(v.state).toBe("stale");
    expect(v.findings).toHaveLength(1);
    expect(check(pr(head, [reviewed, "completed"], [], [{ ...open, isResolved: true }])).state).toBe("clean");
  });

  it("doesn't carry when the reviewed commit isn't in the checkout", () => {
    const head = mergeDev({ "other.txt": "dev\n" });
    const v = check(pr(head, ["1".repeat(40), "completed"]));
    expect(v).toMatchObject({ state: "stale", notCarried: "1111111 isn't in this checkout" });
  });

  it("carries from the command line with --repo and --trunk only", () => {
    const head = mergeDev({ "other.txt": "dev\n" });
    const file = join(repo, "..", `codex-carry-${head}.json`);
    writeFileSync(file, JSON.stringify(pr(head, [reviewed, "completed"])));
    try {
      const run = (...args) => execFileSync("node", [CLI, file, "--line", ...args], { encoding: "utf8" });
      expect(run()).toMatch(/^codex: stale /);
      expect(run(`--repo=${repo}`, "--trunk=dev")).toMatch(/^codex: clean on .* \(carried from /);
    } finally {
      rmSync(file, { force: true });
    }
  });
});
