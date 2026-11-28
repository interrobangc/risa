// review.sh's run log: Codex's answer on a head is recorded once per PR and
// head, however often it's polled, and out of credits apart; --json's stdout is
// only the verdict; --again --wait times out when Codex never takes it up; a
// clean verdict carries over docs-only commits after it. A throwaway repo
// with these scripts copied in and a stubbed `gh` serving a fixture PR state
// (codex-review.fixtures/); the run log is a temp file.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./config-fixture.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const fixture = (name) => join(HERE, "codex-review.fixtures", `${name}.json`);
const GH = `#!/usr/bin/env bash
case "$1 $2" in
  "repo view") echo o/r ;;
  "pr list") echo 7 ;;
  "pr comment") ;;
  "api graphql") cat "$PR_FIXTURE" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`;
let root, repo;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "review-")));
  repo = join(root, "repo");
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "gh"), GH);
  chmodSync(join(root, "bin", "gh"), 0o755);
  execFileSync("git", ["init", "-q", "-b", "dev", repo]);
  cpSync(HERE, join(repo, "loops"), {
    recursive: true,
    filter: (src) => !src.endsWith(".test.mjs"),
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const log = () => join(root, "run-log.jsonl");
const events = () =>
  existsSync(log())
    ? readFileSync(log(), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const review = (name, ...args) => reviewWith({}, name, ...args);
const reviewWith = (env, name, ...args) =>
  spawnSync("bash", ["loops/review.sh", "throwaway-x", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      PR_FIXTURE: fixture(name),
      RISA_RUN_LOG: log(),
      ...env,
    },
  });
const headOf = (name) => JSON.parse(readFileSync(fixture(name), "utf8")).headRefOid;

describe("review.sh's run log", () => {
  it("polling one head several times records one verdict", () => {
    for (let i = 0; i < 3; i++) expect(review("clean").status).toBe(0);
    expect(review("clean", "--wait", "1").status).toBe(0);
    expect(events()).toEqual([
      expect.objectContaining({
        kind: "codex",
        topic: "throwaway-x",
        pr: 7,
        head: headOf("clean"),
        answer: "review",
        state: "clean",
        findings: 0,
      }),
    ]);
  });

  it("findings count, out of credits apart, and a waiting head records nothing", () => {
    expect(review("findings").status).toBe(1);
    expect(review("findings").status).toBe(1);
    expect(review("out-of-credits").status).toBe(4);
    expect(review("waiting").status).toBe(2);
    const [found, credits, ...more] = events();
    expect(more).toEqual([]);
    expect(found).toMatchObject({ head: headOf("findings"), state: "findings", answer: "review" });
    expect(found.findings).toBeGreaterThan(0);
    expect(credits).toMatchObject({ head: headOf("out-of-credits"), answer: "out-of-credits" });
  });
});

describe("review.sh's output and waits", () => {
  it("--json prints only the verdict on stdout, progress on stderr", () => {
    const waited = review("clean", "--json", "--wait", "1");
    expect(waited.status).toBe(0);
    expect(JSON.parse(waited.stdout)).toMatchObject({ state: "clean", headSha: headOf("clean") });

    const asked = review("clean", "--json", "--again");
    expect(asked.status).toBe(0);
    expect(JSON.parse(asked.stdout)).toMatchObject({ state: "clean" });
    expect(asked.stderr).toContain("asked Codex to review PR #7 again");
  });

  it("--again --wait exits 75 when Codex's summary never changes, not with the old verdict", () => {
    const r = reviewWith({ REVIEW_TAKE_UP: "0" }, "clean", "--again", "--wait", "1");
    expect(r.status).toBe(75);
    expect(r.stderr).toContain("didn't take up the re-review of PR #7");
    expect(r.stdout).not.toContain("clean");
    expect(events()).toEqual([]);
  });
});

describe("review.sh over commits after Codex's approval", () => {
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
  const commit = (files, msg) => {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(repo, name), text);
    git("add", "-A");
    git("commit", "-qm", msg);
    return git("rev-parse", "HEAD");
  };
  const state = (sha) =>
    `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: sha, status: "completed" } })} -->`;
  // The PR at head, with Codex's last finished review (clean) on reviewed.
  const prAt = (head, reviewed) => {
    const file = join(root, `pr-${head}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        number: 7,
        url: "https://example.test/pr/7",
        headRefOid: head,
        reviews: { nodes: [] },
        reviewThreads: { nodes: [] },
        comments: {
          nodes: [
            {
              author: { login: "chatgpt-codex-connector" },
              body: state(reviewed),
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:09:00Z",
            },
          ],
        },
        reactions: { nodes: [] },
      }),
    );
    return file;
  };
  const reviewAt = (file, ...args) =>
    spawnSync("bash", ["loops/review.sh", "throwaway-x", ...args], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        PR_FIXTURE: file,
        RISA_RUN_LOG: log(),
      },
    });
  let reviewed;

  beforeEach(() => {
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    git("config", "core.hooksPath", "/dev/null");
    writeFileSync(join(repo, ".gitignore"), "loops/\n");
    commit({ "mine.txt": "base\n" }, "base");
    git("checkout", "-qb", "prd/throwaway-x");
    reviewed = commit({ "mine.txt": "work\n" }, "work");
  });

  it("reads clean when only a .md commit came after the approved one", () => {
    const head = commit({ "notes.md": "## Status\n\nwave 1 landed\n" }, "status");
    const r = reviewAt(prAt(head, reviewed), "--json");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      state: "clean",
      headSha: head,
      carriedFrom: reviewed,
      carriedOver: "docs",
    });
  });

  it("still reads stale when a code commit came after it", () => {
    commit({ "notes.md": "n\n" }, "status");
    const head = commit({ "mine.txt": "more work\n" }, "more work");
    const r = reviewAt(prAt(head, reviewed), "--json");
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ state: "stale", headSha: head });
    expect(JSON.parse(r.stdout).notCarried).toContain("mine.txt changed since, not only docs");
  });
});
