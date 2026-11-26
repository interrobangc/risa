// land.sh's CI gate (land.test.mjs has the rest): the throwaway repo is land-fixture.mjs's.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { root, repo, git, commit, branch, GH_CI, useLandRepo } from "./land-fixture.mjs";

useLandRepo();

describe("land.sh's CI gate", () => {
  const TEST = "apps/web/x.test.ts";
  const failing = { job: "unit", file: TEST, name: "fails" };
  const failed = { tests: [failing], files: [TEST], jobs: ["unit"], unnamedJobs: [] };
  const fileLog = () => join(root, "ci-file.log");
  const filed = () =>
    existsSync(fileLog())
      ? readFileSync(fileLog(), "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  const merged = () =>
    spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", "prd/throwaway-x", "dev"]).status === 0;
  let tip;
  const verdict = (kind, over = {}) => ({
    version: 1,
    commit: tip,
    runId: "11",
    tier: "components",
    ranTier: "components",
    kind,
    flaky: [],
    brake: { jobs: [], tests: [], files: [] },
    failed: { tests: [], files: [], jobs: [] },
    ...over,
  });
  const land = (fixture, args = [], extra = {}) => {
    writeFileSync(join(root, "fixture.json"), JSON.stringify({ byCommit: {}, ...fixture }));
    return spawnSync(
      "bash",
      [
        "scripts/loops/land.sh",
        "throwaway-x",
        "-m",
        "feat(throwaway-x): t",
        ...(args.includes("--local") ? [] : ["--no-review", "--by-user"]),
        ...args,
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          PR_HEAD: tip,
          GH_CI: join(root, "gh-ci.mjs"),
          GH_CI_FIXTURE: join(root, "fixture.json"),
          CI_FILE_LOG: fileLog(),
          CARETOOK_CI_POLL: "0",
          CARETOOK_NOTICES_DIR: join(root, "notices"),
          ...extra,
        },
      },
    );
  };
  const on = (v, sha = tip) => ({ byCommit: { [sha]: [{ id: 11, tier: v.tier, verdict: v }] } });
  const out = (r) => r.stdout + r.stderr;

  beforeEach(() => {
    writeFileSync(join(root, "gh-ci.mjs"), GH_CI);
    writeFileSync(join(repo, ".git", "info", "exclude"), ".loops/\nto-test/\n");
    commit({ [TEST]: "t" }, "a test");
    git("push", "-q", "origin", "dev");
    branch({ "apps/web/b.ts": "2" });
    tip = git("rev-parse", "prd/throwaway-x");
  });

  it("green lands, and the report names the tier and the proposal", () => {
    const r = land(on(verdict("green")));
    expect(r.status, out(r)).toBe(0);
    expect(merged()).toBe(true);
    expect(r.stdout).toContain("tier components (proposed components: app code");
    expect(filed()).toEqual([]);
  });

  it("a flake in a file the branch didn't touch lands, and is filed only after the merge", () => {
    const flaky = [{ job: "unit", file: TEST, name: "wobbles", brake: false }];
    const r = land(on(verdict("flake", { flaky })));
    expect(r.status, out(r)).toBe(0);
    expect(filed()).toEqual([expect.objectContaining({ merged: true })]);
  });

  it("a filing that fails after the merge exits 5 with the retry, and the landing stands", () => {
    const flaky = [{ job: "unit", file: TEST, name: "wobbles", brake: false }];
    const r = land(on(verdict("flake", { flaky })), [], { CI_FILE_FAIL: "1" });
    expect(r.status).toBe(5);
    expect(merged()).toBe(true);
    expect(r.stderr).toContain("pnpm prd ci file prd/throwaway-x --base");
  });

  it("a local landing files its flakes without pushing, and its retry says so", () => {
    const flaky = [{ job: "unit", file: TEST, name: "wobbles", brake: false }];
    const r = land(on(verdict("flake", { flaky })), ["--local"]);
    expect(r.status, out(r)).toBe(0);
    expect(filed()).toEqual([expect.objectContaining({ merged: true, push: false })]);
    expect(git("ls-remote", "origin", "refs/heads/dev").split("\t")[0]).not.toBe(git("rev-parse", "dev"));

    git("reset", "-q", "--hard", "HEAD^1");
    const again = land(on(verdict("flake", { flaky })), ["--local"], { CI_FILE_FAIL: "1" });
    expect(again.status).toBe(5);
    expect(again.stderr).toMatch(/pnpm prd ci file prd\/throwaway-x --base \w+ --run 11 --no-push/);
  });

  it("a quarantine push refused after the merge finishes the landing, prints the retry and exits 5", () => {
    const flaky = [{ job: "unit", file: TEST, name: "wobbles", brake: false }];
    const r = land(on(verdict("flake", { flaky })), [], { CI_FILE_UNPUSHED: "1" });
    expect(r.status, out(r)).toBe(5);
    expect(merged()).toBe(true);
    expect(filed()).toEqual([expect.objectContaining({ merged: true, push: true })]);
    expect(r.stdout).toContain("through PR #7");
    expect(out(r)).toContain("wasn't pushed");
    expect(r.stderr).toMatch(/Retry: pnpm prd ci file prd\/throwaway-x --base \w+ --run 11$/m);
  });

  it("a dev-sync failure's message carries the flake filing's retry", () => {
    const flaky = [{ job: "unit", file: TEST, name: "wobbles", brake: false }];
    const r = land(on(verdict("flake", { flaky })), [], { GH_BREAK_SYNC: "1" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("dev-sync stopped");
    expect(r.stderr).toContain("pnpm prd land --resume prd/throwaway-x");
    expect(r.stderr).toMatch(
      /then files the flakes: `pnpm prd ci file prd\/throwaway-x --base \w+ --run 11`/,
    );
    expect(filed()).toEqual([]);
  });

  describe("pr.sh's tier", () => {
    const body = () => join(root, "pr-body.md");
    const pr = (...args) =>
      spawnSync("bash", ["scripts/loops/pr.sh", "throwaway-x", "-m", "feat(throwaway-x): t", ...args], {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          CARETOOK_PR_THROWAWAY: "1",
          GH_PR_BODY: body(),
        },
      });

    it("puts the tier and the proposal in the PR body", () => {
      const r = pr();
      expect(r.status, out(r)).toBe(0);
      expect(readFileSync(body(), "utf8")).toContain("**Tier:** components (proposed components: app code");
    });

    it("refuses a tier below the proposal without --why, before anything is written", () => {
      const r = pr("--tier", "unit");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("below the proposal, components");
      expect(existsSync(body())).toBe(false);
    });

    it("names the reason in the body for a tier below the proposal", () => {
      const r = pr("--tier", "unit", "--why", "only a copy change");
      expect(r.status, out(r)).toBe(0);
      expect(readFileSync(body(), "utf8")).toMatch(
        /\*\*Tier:\*\* unit \(proposed components: .*\); below the proposal because: only a copy change/,
      );
    });
  });

  describe("ready.sh's proposal", () => {
    const ready = (fixture) => {
      writeFileSync(join(root, "fixture.json"), JSON.stringify({ byCommit: {}, ...fixture }));
      return spawnSync("bash", ["scripts/loops/ready.sh", "throwaway-x"], {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          GH_CI: join(root, "gh-ci.mjs"),
          GH_CI_FIXTURE: join(root, "fixture.json"),
          PR_HEAD: tip,
        },
      });
    };
    beforeEach(() => git("worktree", "add", "-q", join(repo, ".loops", "throwaway-x"), "prd/throwaway-x"));

    it("shows the proposal and the verdict it peeked at", () => {
      const r = ready(on(verdict("green")));
      expect(r.status, out(r)).toBe(0);
      expect(r.stdout).toContain("Proposed tier: **components** (app code");
      expect(r.stdout).toContain(`CI: verdict: green · components · ${tip.slice(0, 8)}`);
    });

    it("says the landing will request a run, and requests none", () => {
      const r = ready({});
      expect(r.status, out(r)).toBe(0);
      expect(r.stdout).toContain(
        `CI: no components verdict for ${tip.slice(0, 8)}: the landing will request one`,
      );
      expect(git("ls-remote", "origin", "refs/heads/ci/*")).toBe("");
    });
  });

  it("a flake in a file the branch touched refuses, names it and files nothing", () => {
    const flaky = [{ job: "unit", file: "apps/web/b.ts", name: "wobbles", brake: false }];
    const r = land(on(verdict("flake", { flaky })));
    expect(r.status).toBe(2);
    expect(out(r)).toContain("apps/web/b.ts: wobbles");
    expect(merged()).toBe(false);
    expect(filed()).toEqual([]);
  });

  it("file lands when blame gives every failure to dev", () => {
    const r = land({ ...on(verdict("file", { failed })), devFails: [failing] });
    expect(r.status, out(r)).toBe(0);
    expect(merged()).toBe(true);
  });

  it("file refuses naming the branch's failing tests", () => {
    const r = land(on(verdict("file", { failed })));
    expect(r.status).toBe(2);
    expect(out(r)).toContain(`${TEST}: fails`);
    expect(merged()).toBe(false);
  });

  it.each([
    ["infra", 4],
    ["something new", 5],
  ])("a %s verdict refuses with how to retry", (kind, code) => {
    const r = land(on(verdict(kind)));
    expect(r.status, out(r)).toBe(code);
    expect(out(r)).toContain("Retry: pnpm prd ci run components --ref prd/throwaway-x --wait");
    expect(merged()).toBe(false);
    expect(filed()).toEqual([]);
  });

  it("a dev brake refuses naming its item, and --fixes with that item lands", () => {
    const brake = { jobs: [], tests: [failing], files: [] };
    const fixture = { ...on(verdict("brake", { failed, brake })), devFails: [failing] };
    let r = land(fixture);
    expect(r.status).toBe(1);
    expect(out(r)).toContain(`${TEST}: fails (B-77)`);
    expect(merged()).toBe(false);
    r = land(fixture, ["--fixes", "B-8"]);
    expect(r.status).toBe(1);
    r = land(fixture, ["--fixes", "B-77"]);
    expect(r.status, out(r)).toBe(0);
    expect(merged()).toBe(true);
  });

  it.each([
    ["infra", 4],
    ["something-new", 5],
  ])("%s refuses with how to retry", (kind, code) => {
    const r = land(on(verdict(kind)));
    expect(r.status).toBe(code);
    expect(out(r)).toContain("pnpm prd ci run components --ref prd/throwaway-x --wait");
    expect(merged()).toBe(false);
  });

  it("a narrowed verdict on the tip doesn't count: the gate requests the tier", () => {
    const narrowed = verdict("green", { narrowed: true, narrowedFiles: [TEST] });
    const r = land({ ...on(narrowed), requested: verdict("infra") });
    expect(out(r)).toContain("no components verdict");
    expect(r.status).toBe(4);
    expect(merged()).toBe(false);
  });

  it("requests the run when there's no verdict, and lands on its green", () => {
    const r = land({ requested: verdict("green") });
    expect(r.status, out(r)).toBe(0);
    expect(merged()).toBe(true);
  });

  it("a tier below the proposal needs --why, and with it lands and prints the reason", () => {
    const low = on(verdict("green", { tier: "integration", ranTier: "integration" }));
    let r = land(low, ["--tier", "integration"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("below the proposal, components");
    expect(merged()).toBe(false);
    r = land(low, ["--tier", "integration", "--why", "only a server line moved"]);
    expect(r.status, out(r)).toBe(0);
    expect(r.stdout).toContain("below the proposal because: only a server line moved");
  });

  it("--tier none over a real proposal is refused, even with a reason", () => {
    const r = land({}, ["--tier", "none", "--why", "trust me"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--force");
    expect(merged()).toBe(false);
  });

  it("a verdict for a lower tier than declared refuses", () => {
    const low = verdict("green", { tier: "full", ranTier: "integration" });
    const r = land({ ...on(low), requested: verdict("infra", { tier: "full", ranTier: "full" }) }, [
      "--tier",
      "full",
    ]);
    expect(out(r)).toContain("no full verdict");
    expect(r.status).toBe(4);
    expect(merged()).toBe(false);
  });

  it("a verdict for a higher tier than declared lands", () => {
    const r = land(on(verdict("green", { tier: "full", ranTier: "full" })));
    expect(r.status, out(r)).toBe(0);
    expect(merged()).toBe(true);
  });

  it("a tip with docs-only commits since its verdict lands", () => {
    const checked = tip;
    git("checkout", "-q", "prd/throwaway-x");
    commit({ "docs/note.md": "n" }, "docs");
    git("checkout", "-q", "dev");
    tip = git("rev-parse", "prd/throwaway-x");
    const r = land(on(verdict("green", { commit: checked }), checked));
    expect(r.status, out(r)).toBe(0);
    expect(merged()).toBe(true);
  });

  it("a code commit since the verdict doesn't keep it", () => {
    const checked = tip;
    git("checkout", "-q", "prd/throwaway-x");
    commit({ "apps/web/b.ts": "3" }, "more");
    git("checkout", "-q", "dev");
    tip = git("rev-parse", "prd/throwaway-x");
    const r = land({ ...on(verdict("green", { commit: checked }), checked), requested: verdict("infra") });
    expect(r.status).toBe(4);
    expect(merged()).toBe(false);
  });

  it("--recheck is gone, and says what replaced it", () => {
    const r = land({}, ["--recheck", "stale"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--tier");
  });
});
