// `pnpm prd ci candidate` on temp repositories: origin is a local bare repository
// and gh is a fixture, so no test can reach GitHub or the real remote.
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REFUSED, candidateName, candidatePrs, runCandidate } from "./candidate.mjs";

const HELD = {
  number: 115,
  url: "https://example.test/pull/115",
  headRefName: "dev",
  isCrossRepository: false,
};
const NOW = Date.UTC(2026, 10, 23, 10, 30);

const gitEnv = () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.test",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.test",
  };
};

/** @type {string} */ let root;
/** @type {string} */ let repo;
/** @type {any[]} */ let prs;
/** @type {string[][]} */ let ghCalls;
/** @type {any[]} */ let runs;
/** @type {string[]} */ let lines;
/** @type {any} */ let verdict;

const run = (/** @type {string} */ cwd, /** @type {string[]} */ args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
};
const git = (/** @type {string[]} */ ...commands) => {
  let out = "";
  for (const args of commands) {
    const r = run(repo, args);
    if (!r.ok) throw new Error(`git ${args.join(" ")} failed`);
    out = r.out;
  }
  return out;
};
const commit = (/** @type {string} */ subject, /** @type {string} */ file, /** @type {string} */ text) => {
  writeFileSync(join(repo, file), text);
  git(["add", file], ["commit", "-q", "-m", subject]);
  return git(["rev-parse", "HEAD"]);
};
const pushAll = () => git(["push", "-q", "origin", "dev", "staging"]);
const onDev = () => git(["checkout", "-q", "dev"]);

const io = () => ({
  git: (/** @type {string[]} */ args) => run(repo, args),
  gh(/** @type {string[]} */ args) {
    ghCalls.push(args);
    if (args[0] === "pr" && args[1] === "list") return { ok: true, out: JSON.stringify(prs) };
    if (args[0] === "pr" && args[1] === "create") {
      const headRefName = args[args.indexOf("--head") + 1];
      const url = `https://example.test/pull/${200 + prs.length}`;
      prs.push({ number: 200 + prs.length, url, headRefName, isCrossRepository: false });
      return { ok: true, out: url };
    }
    return { ok: false, out: "" };
  },
  sleep: async () => {},
  now: () => NOW,
  log: (/** @type {string} */ line) => lines.push(line),
  pollMs: 1,
});
const deps = {
  requestRun: async (/** @type {any} */ request) => {
    runs.push(request);
    return 0;
  },
  findVerdict: () => ({ verdict, run: null }),
  deleteRef: () => true,
  verdictLines: (/** @type {any} */ v) => [`verdict: ${v.kind}`],
  exitFor: (/** @type {string} */ kind) => (kind === "green" ? 0 : 5),
};
const candidate = (/** @type {string[]} */ ...argv) => runCandidate(argv, /** @type {any} */ (io()), deps);
const remoteTip = (/** @type {string} */ branch) => git(["rev-parse", `refs/remotes/origin/${branch}`]);
const BRANCH = "rc/20261123-1030";

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "risa-candidate-test-")));
  const origin = join(root, "origin.git");
  repo = join(root, "repo");
  prs = [];
  ghCalls = [];
  runs = [];
  lines = [];
  verdict = null;
  run(root, ["init", "-q", "--bare", "-b", "dev", origin]);
  run(root, ["clone", "-q", origin, repo]);
  git(["checkout", "-q", "-B", "dev"]);
  commit("chore: start", "a.txt", "one\n");
  git(["checkout", "-q", "-b", "staging"]);
  onDev();
  commit("feat: first", "b.txt", "b\n");
  git(["checkout", "-q", "staging"], ["merge", "-q", "--no-ff", "-m", "chore: release", "dev"]);
  onDev();
  commit("feat: second", "c.txt", "c\n");
  pushAll();
  // The guard on every test: the only remote is the bare repository in the temp directory.
  expect(git(["remote", "get-url", "origin"]).startsWith(root)).toBe(true);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("candidate cut", () => {
  it("cuts dev's tip with staging merged, the tree exactly dev's, and opens the PR and run", async () => {
    const dev = git(["rev-parse", "dev"]);
    expect(await candidate("cut")).toBe(0);
    const tip = remoteTip(BRANCH);
    expect(git(["rev-parse", `${tip}^{tree}`])).toBe(git(["rev-parse", "dev^{tree}"]));
    expect(git(["rev-list", "--parents", "-n", "1", tip]).split(" ").slice(1)).toEqual([
      dev,
      git(["rev-parse", "origin/staging"]),
    ]);
    expect(git(["log", "-1", "--format=%s", tip])).toBe(`chore(release): merge staging into ${BRANCH}`);
    const create = ghCalls.find((c) => c[1] === "create");
    expect(create?.[create.indexOf("--base") + 1]).toBe("staging");
    expect(create?.[create.indexOf("--head") + 1]).toBe(BRANCH);
    expect(runs).toEqual([{ tier: "candidate", branch: BRANCH, sha: tip, waitMin: null }]);
  });

  it("merges cleanly over a staging cherry-pick that dev later changed", async () => {
    const fixed = commit("fix: the line", "a.txt", "fixed\n");
    git(["checkout", "-q", "staging"], ["cherry-pick", "-x", fixed]);
    onDev();
    commit("feat: changes the line again", "a.txt", "changed later\n");
    pushAll();
    expect(await candidate("cut")).toBe(0);
    git(
      ["checkout", "-q", "staging"],
      ["merge", "-q", "--no-ff", "-m", "chore: promote", `origin/${BRANCH}`],
    );
    expect(git(["rev-parse", "HEAD^{tree}"])).toBe(git(["rev-parse", "dev^{tree}"]));
  });

  it("refuses a commit only staging holds, and names it", async () => {
    git(["checkout", "-q", "staging"]);
    const only = commit("fix: straight onto staging", "s.txt", "s\n");
    onDev();
    pushAll();
    expect(await candidate("cut")).toBe(REFUSED);
    expect(lines.join("\n")).toContain(only.slice(0, 8));
    expect(ghCalls.some((c) => c[1] === "create")).toBe(false);
    expect(run(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${BRANCH}`]).ok).toBe(false);
  });

  it("refuses an older commit that lacks a fix staging took from dev", async () => {
    const older = git(["rev-parse", "dev"]);
    const fixed = commit("fix: newer", "a.txt", "newer\n");
    git(["checkout", "-q", "staging"], ["cherry-pick", "-x", fixed]);
    onDev();
    pushAll();
    expect(await candidate("cut", older)).toBe(REFUSED);
    expect(lines.join("\n")).toContain("would drop");
  });

  it("refuses a commit that isn't in dev", async () => {
    git(["checkout", "-q", "-b", "side"]);
    const side = commit("feat: side", "d.txt", "d\n");
    onDev();
    expect(await candidate("cut", side)).toBe(REFUSED);
    expect(lines.join("\n")).toContain("not in dev");
  });

  it("refuses a second candidate", async () => {
    expect(await candidate("cut")).toBe(0);
    expect(await candidate("cut")).toBe(REFUSED);
    expect(lines.at(-1)).toContain(`a candidate is open: ${BRANCH}`);
  });
});

describe("a PR into staging that isn't a candidate", () => {
  it("counts only this repository's rc/ heads", () => {
    const fork = { ...HELD, number: 116, headRefName: "rc/from-a-fork", isCrossRepository: true };
    const own = { ...HELD, number: 117, headRefName: "rc/20261123-1030" };
    expect(candidatePrs([HELD, fork, own])).toEqual([own]);
  });

  it("the held dev PR doesn't block a cut, and is never closed or edited", async () => {
    prs = [{ ...HELD }];
    expect(await candidate("cut")).toBe(0);
    expect(prs[0]).toEqual(HELD);
    expect(
      ghCalls.every((c) => c[0] === "pr" && ["list", "create"].includes(/** @type {string} */ (c[1]))),
    ).toBe(true);
    expect(ghCalls.filter((c) => c[1] === "create")).toHaveLength(1);
    expect(ghCalls.flat()).not.toContain("115");
  });

  it("alone reads as no open candidate", async () => {
    prs = [{ ...HELD }];
    expect(await candidate("status")).toBe(0);
    expect(lines).toContain("no open candidate");
    expect(await candidate("fix", "dev")).toBe(REFUSED);
    expect(ghCalls.every((c) => c[1] === "list")).toBe(true);
  });
});

describe("candidate fix", () => {
  it("cherry-picks a fix from dev with its trailer and requests a new run", async () => {
    await candidate("cut");
    const before = remoteTip(BRANCH);
    const fixed = commit("fix(area): a bug", "e.txt", "e\n");
    git(["push", "-q", "origin", "dev"]);
    expect(await candidate("fix", fixed)).toBe(0);
    const tip = remoteTip(BRANCH);
    expect(git(["rev-parse", `${tip}^`])).toBe(before);
    expect(git(["log", "-1", "--format=%B", tip])).toContain(`(cherry picked from commit ${fixed})`);
    expect(runs.at(-1)).toMatchObject({ tier: "candidate", branch: BRANCH, sha: tip });
    expect(git(["worktree", "list"]).split("\n")).toHaveLength(1);
  });

  it("takes a landing's merge commit with -m 1", async () => {
    await candidate("cut");
    git(["checkout", "-q", "-b", "topic"]);
    commit("test: part one", "f.txt", "f\n");
    commit("test: part two", "g.txt", "g\n");
    onDev();
    git(["merge", "-q", "--no-ff", "-m", "fix(area): landing", "topic"], ["push", "-q", "origin", "dev"]);
    const landing = git(["rev-parse", "dev"]);
    expect(await candidate("fix", landing)).toBe(0);
    const tip = remoteTip(BRANCH);
    expect(git(["show", "--format=", "--name-only", tip]).split("\n").sort()).toEqual(["f.txt", "g.txt"]);
    expect(git(["log", "-1", "--format=%B", tip])).toContain(`(cherry picked from commit ${landing})`);
  });

  it("refuses a commit that isn't a fix", async () => {
    await candidate("cut");
    const feature = commit("feat: new work", "h.txt", "h\n");
    git(["push", "-q", "origin", "dev"]);
    const before = remoteTip(BRANCH);
    expect(await candidate("fix", feature)).toBe(REFUSED);
    expect(lines.at(-1)).toContain("only fix commits");
    expect(remoteTip(BRANCH)).toBe(before);
  });

  it("refuses a fix that isn't in dev", async () => {
    await candidate("cut");
    git(["checkout", "-q", "-b", "side"]);
    const side = commit("fix: not landed", "i.txt", "i\n");
    onDev();
    expect(await candidate("fix", side)).toBe(REFUSED);
    expect(lines.at(-1)).toContain("not in dev");
  });

  it("refuses the same fix twice", async () => {
    await candidate("cut");
    const fixed = commit("fix: once", "j.txt", "j\n");
    git(["push", "-q", "origin", "dev"]);
    expect(await candidate("fix", fixed)).toBe(0);
    expect(await candidate("fix", fixed)).toBe(REFUSED);
    expect(lines.at(-1)).toContain("already on");
  });

  it("aborts a conflict, leaving the candidate and the worktrees as they were", async () => {
    await candidate("cut");
    const before = remoteTip(BRANCH);
    commit("feat: changes the line", "a.txt", "two\n");
    const fixed = commit("fix: on top of it", "a.txt", "three\n");
    git(["push", "-q", "origin", "dev"]);
    const runCount = runs.length;
    expect(await candidate("fix", fixed)).toBe(REFUSED);
    expect(lines.at(-1)).toContain("doesn't apply cleanly");
    expect(remoteTip(BRANCH)).toBe(before);
    expect(runs).toHaveLength(runCount);
    expect(git(["worktree", "list"]).split("\n")).toHaveLength(1);
  });
});

describe("candidate status", () => {
  it("shows the commit, base and verdict", async () => {
    const dev = git(["rev-parse", "dev"]);
    await candidate("cut");
    verdict = { kind: "green" };
    lines = [];
    expect(await candidate("status")).toBe(0);
    expect(lines).toContain(`commit: ${remoteTip(BRANCH).slice(0, 8)}`);
    expect(lines).toContain(`base: dev ${dev.slice(0, 8)}`);
    expect(lines).toContain("verdict: green");
  });

  it("reads no verdict as unknown", async () => {
    await candidate("cut");
    expect(await candidate("status")).toBe(5);
    expect(lines.at(-1)).toContain("verdict: unknown");
  });
});

it("names a candidate by the UTC minute", () => {
  expect(candidateName(NOW)).toBe(BRANCH);
});
