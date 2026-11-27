// A prd/ branch's last landing and what it carries past it (landed.mjs), in a
// throwaway repo: the landing found through a later dev sync, each tail kind,
// the dispatcher's landed topics (B-431), and the items left.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { itemsLeft, landedTopics, lastLanding, tailOf } from "./landed.mjs";

let root, repo;
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
const commit = (files, msg) => {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), text);
  }
  git("add", "-A");
  git("commit", "-qm", msg);
  return git("rev-parse", "HEAD");
};
const plan = (rows) =>
  `# Plan: T\n\n## Status\n\n| Slice | Wave | State | Merge |\n| ----- | ---- | ----- | ----- |\n${rows}\n`;
const DONE = "| 1 | 1 | merged | abc |";

/** prd/<topic> from dev with FILES, landed in dev with a --no-ff merge; returns the merge. */
const landed = (topic, files) => {
  git("checkout", "-qb", `prd/${topic}`, "dev");
  commit(files, `feat(${topic}): work`);
  git("checkout", "-q", "dev");
  git("merge", "-q", "--no-ff", "-m", `feat(${topic}): land`, `prd/${topic}`);
  return git("rev-parse", "HEAD");
};
/** A commit on BRANCH, back on dev after. */
const onBranch = (branch, files, msg = "docs: landed") => {
  git("checkout", "-q", branch);
  commit(files, msg);
  git("checkout", "-q", "dev");
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "landed-test-")));
  repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "dev", repo]);
  for (const [k, v] of [
    ["user.email", "t@example.com"],
    ["user.name", "T"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", "/dev/null"],
  ])
    git("config", k, v);
  commit({ "README.md": "r\n" }, "chore: init");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("lastLanding and tailOf", () => {
  it("finds no landing for a branch that never landed", () => {
    git("checkout", "-qb", "prd/fresh", "dev");
    git("checkout", "-q", "dev");
    expect(lastLanding(repo, "prd/fresh", "dev")).toBeNull();
    expect(tailOf(repo, "prd/fresh", "dev", "fresh")).toMatchObject({ kind: "merged", landing: null });
    onBranch("prd/fresh", { "a.ts": "1" }, "feat: a");
    expect(tailOf(repo, "prd/fresh", "dev", "fresh")).toMatchObject({ kind: "unlanded", commits: 1 });
  });

  it("names the landing merge, and each kind of tail past it", () => {
    const merge = landed("one", { "one.ts": "1", "plans/one-plan.md": plan(DONE) });
    expect(lastLanding(repo, "prd/one", "dev")?.sha).toBe(merge);
    expect(tailOf(repo, "prd/one", "dev", "one")).toMatchObject({
      kind: "merged",
      landing: merge,
      commits: 0,
    });
    onBranch("prd/one", { "plans/one-plan.md": `${plan(DONE)}\nLanded.\n` });
    expect(tailOf(repo, "prd/one", "dev", "one")).toMatchObject({ kind: "plan", landing: merge, commits: 1 });
    onBranch("prd/one", { "docs/one.md": "# One\n" });
    expect(tailOf(repo, "prd/one", "dev", "one")).toMatchObject({ kind: "docs", commits: 2 });
    onBranch("prd/one", { "one.ts": "2" }, "fix: more");
    expect(tailOf(repo, "prd/one", "dev", "one")).toMatchObject({ kind: "code", commits: 3 });
  });

  it("still finds its own landing after a dev sync brings another topic's, and reads only its own tail", () => {
    const merge = landed("two", { "two.ts": "1" });
    const other = landed("other", { "other.ts": "1" });
    git("checkout", "-q", "prd/two");
    git("merge", "-q", "--no-ff", "-m", "chore(two): merge dev into prd/two", "dev");
    git("checkout", "-q", "dev");
    expect(lastLanding(repo, "prd/two", "dev")?.sha).toBe(merge);
    expect(lastLanding(repo, "prd/other", "dev")?.sha).toBe(other);
    expect(tailOf(repo, "prd/two", "dev", "two")).toMatchObject({ kind: "empty", landing: merge });
    onBranch("prd/two", { "plans/two-plan.md": plan(DONE) });
    expect(tailOf(repo, "prd/two", "dev", "two")).toMatchObject({
      kind: "plan",
      files: ["plans/two-plan.md"],
    });
  });
});

describe("landedTopics, the dispatcher's guard", () => {
  it("names a topic landed with only docs past it and no slice left, and no other", () => {
    const merge = landed("fin", { "fin.ts": "1", "plans/fin-plan.md": plan(DONE) });
    onBranch("prd/fin", { "plans/fin-plan.md": `${plan(DONE)}\nLanded in dev.\n` });
    landed("open", { "open.ts": "1", "plans/open-plan.md": plan(`${DONE}\n| 2 | 2 | not started | |`) });
    landed("coded", { "coded.ts": "1", "plans/coded-plan.md": plan(DONE) });
    onBranch("prd/coded", { "coded.ts": "2" }, "fix: after");
    landed("notable", { "notable.ts": "1", "plans/notable-plan.md": "# Plan\n\n## Status\n\nAll in.\n" });
    git("checkout", "-qb", "prd/unlanded", "dev");
    commit({ "plans/unlanded-plan.md": plan(DONE) }, "docs: plan");
    git("checkout", "-q", "dev");
    expect(landedTopics(repo, ["fin", "open", "coded", "notable", "unlanded", "nobranch"], "dev")).toEqual({
      fin: { sha: merge },
    });
  });

  it("gives nothing for no topics or a repo it can't read", () => {
    expect(landedTopics(repo, [], "dev")).toEqual({});
    expect(landedTopics(join(root, "nowhere"), ["fin"], "dev")).toEqual({});
  });
});

describe("itemsLeft", () => {
  it("names the items that aren't landed, staging, live or dropped", () => {
    const items = ["landed", "staging", "live", "dropped", "ready", "in-progress", "triaged"].map(
      (status, i) => ({
        id: `B-${i + 1}`,
        status,
      }),
    );
    expect(itemsLeft(items)).toEqual(["B-5", "B-6", "B-7"]);
    expect(itemsLeft([])).toEqual([]);
  });
});
