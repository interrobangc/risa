// review.sh's run log: Codex's answer on a head is recorded once per PR and
// head, however often it's polled, and out of credits apart; --json's stdout is
// only the verdict; --again --wait times out when Codex never takes it up. A throwaway repo
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
  cpSync(HERE, join(repo, "scripts", "loops"), {
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
  spawnSync("bash", ["scripts/loops/review.sh", "throwaway-x", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      PR_FIXTURE: fixture(name),
      CARETOOK_RUN_LOG: log(),
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
