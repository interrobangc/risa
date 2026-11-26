// land.sh's --force, --no-review and --resume (land.test.mjs has the rest): the throwaway repo is
// land-fixture.mjs's.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { declinesSince, markLanded } from "./land-skeptic.mjs";
import { recordVerdict } from "./skeptics.mjs";
import { root, repo, git, commit, landWith, branch, GH_CI, useLandRepo } from "./land-fixture.mjs";

useLandRepo();

describe("land.sh's --force and --no-review", () => {
  const store = () => join(root, "skeptic");
  let tip;
  const record = (over = {}) =>
    recordVerdict(store(), {
      kind: "land",
      verdict: "go",
      why: "the failure is unrelated",
      topic: "throwaway-x",
      tip,
      action: "force",
      ...over,
    }).id;
  const ciEnv = (byCommit = {}) => {
    writeFileSync(join(root, "gh-ci.mjs"), GH_CI);
    writeFileSync(join(root, "fixture.json"), JSON.stringify({ byCommit }));
    return {
      GH_CI: join(root, "gh-ci.mjs"),
      GH_CI_FIXTURE: join(root, "fixture.json"),
      RISA_CI_POLL: "0",
      RISA_LOAD_GATE: "off",
      RISA_NOTICES_DIR: join(root, "notices"),
      RISA_SKEPTIC_DIR: store(),
    };
  };
  // Off the seam: land measures against the local dev, not origin/dev.
  const unseamed = { RISA_PR_THROWAWAY: "" };
  const seam = (args, byCommit, extra = {}) => landWith({ ...ciEnv(byCommit), ...extra }, ...args);
  const brakeOn = (sha) => ({
    [sha]: [
      {
        id: 11,
        tier: "components",
        verdict: {
          version: 1,
          commit: sha,
          runId: "11",
          tier: "components",
          ranTier: "components",
          kind: "brake",
          flaky: [],
          brake: { jobs: ["unit"], tests: [], files: [] },
          failed: { tests: [], files: [], jobs: ["unit"] },
        },
      },
    ],
  });
  const outOfCredits = {
    PR_COMMENTS: JSON.stringify([
      {
        author: { login: "chatgpt-codex-connector" },
        body: "You have reached your Codex usage limits for code reviews.",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]),
  };
  const report = () => {
    const [file] = readdirSync(join(repo, "to-test"));
    return readFileSync(join(repo, "to-test", file), "utf8");
  };

  beforeEach(() => {
    writeFileSync(join(repo, ".git", "info", "exclude"), ".loops/\nto-test/\n");
    branch({ "docs/x.md": "d" });
    tip = git("rev-parse", "prd/throwaway-x");
  });

  it("--force with neither is refused, naming both", () => {
    const r = seam(["--force"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--skeptic <id>");
    expect(r.stderr).toContain("--by-user");
  });

  it("--force lands on a go for the tip, and says whose word it was", () => {
    const r = seam(["--force", "--skeptic", record()]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("--force: skeptic s1 go: the failure is unrelated");
    const byUser = seam(["--force", "--by-user"]);
    expect(byUser.status, byUser.stderr).toBe(0);
    expect(byUser.stdout).toContain("on the user's word");
  });

  it.each([
    ["an older tip", () => ({ tip: "0".repeat(40) }), "judged 0000000"],
    ["another topic", () => ({ topic: "other" }), "is for other"],
    ["another action", () => ({ action: "no-review" }), 'judged "no-review"'],
    ["an old record", () => ({ now: Date.now() - 2 * 3600_000 }), "minutes old"],
    ["a no", () => ({ verdict: "no", why: "a real bug" }), "the skeptic said no: a real bug"],
  ])("--force is refused on %s", (_name, over, reason) => {
    const r = seam(["--force", "--skeptic", record(over())]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(reason);
  });

  it("a no beside a go still refuses", () => {
    const go = record();
    const no = record({ verdict: "no", why: "a real bug" });
    const r = seam(["--force", "--skeptic", go, "--skeptic", no]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("a real bug");
  });

  it("--skeptic and --by-user need a flag to cover, and not both", () => {
    expect(seam(["--by-user"]).stderr).toContain("go with --force or --no-review");
    expect(seam(["--force", "--by-user", "--skeptic", "s1"]).stderr).toContain("not both");
  });

  describe("--no-review on a code diff", () => {
    beforeEach(() => {
      git("checkout", "-q", "prd/throwaway-x");
      commit({ "scripts/loops/own.sh": "own" }, "code");
      git("checkout", "-q", "dev");
      tip = git("rev-parse", "prd/throwaway-x");
    });

    it("is refused with neither, and on another action's go", () => {
      for (const args of [["--no-review"], ["--no-review", "--skeptic", record()]]) {
        const r = seam(args);
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain("--no-review");
      }
    });

    it("lands on a go or the user's word", () => {
      const go = seam(["--no-review", "--skeptic", record({ action: "no-review" })]);
      expect(go.status, go.stdout + go.stderr).toBe(0);
      expect(go.stdout).toContain("--no-review: skeptic");
      const byUser = seam(["--no-review", "--by-user"]);
      expect(byUser.status, byUser.stderr).toBe(0);
    });

    it("needs neither when Codex is out of credits", () => {
      const r = seam(["--no-review"], {}, outOfCredits);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain("Codex is out of credits");
    });
  });

  describe("where a go doesn't reach", () => {
    it("a brake on the branch's tip needs --by-user", () => {
      const refused = seam(["--force", "--skeptic", record()], brakeOn(tip));
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("doesn't cover a brake");
      const r = seam(["--force", "--by-user"], brakeOn(tip));
      expect(r.status, r.stderr).toBe(0);
    });

    it("a brake on dev's tip needs --by-user", () => {
      const dev = git("rev-parse", "dev");
      const refused = seam(["--force", "--skeptic", record()], brakeOn(dev));
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("doesn't cover a brake");
    });

    it("a brake only on origin/dev's newer tip needs --by-user", () => {
      // origin/dev is a commit ahead of the local dev land measures against, and
      // the remote-tracking ref is stale: only a fetch sees the newer tip.
      const local = git("rev-parse", "dev");
      commit({ "notes/dev.txt": "d" }, "dev work");
      git("push", "-q", "origin", "dev");
      const newer = git("rev-parse", "dev");
      git("reset", "-q", "--hard", local);
      git("update-ref", "refs/remotes/origin/dev", local);
      const refused = seam(["--force", "--skeptic", record()], brakeOn(newer), unseamed);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain(
        `doesn't cover a brake (CI reads a brake on origin/dev's tip ${newer.slice(0, 8)}`,
      );
    });

    it("a brake state that can't be read refuses a go, naming --by-user", () => {
      const refused = seam(["--force", "--skeptic", record()], {}, { GH_CI: join(root, "no-such-stub.mjs") });
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("couldn't be read (GitHub couldn't be read for");
      expect(refused.stderr).toContain("--force --by-user");
      // The board's path is a file: it can't be listed.
      writeFileSync(join(root, "notices"), "x");
      const noBoard = seam(["--force", "--skeptic", record()]);
      expect(noBoard.status).not.toBe(0);
      expect(noBoard.stderr).toContain("couldn't read the dev-brake notices");
      const r = seam(["--force", "--by-user"], {}, { GH_CI: join(root, "no-such-stub.mjs") });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    });

    it("an unsynced tip needs --by-user", () => {
      commit({ "web/dev.ts": "d" }, "dev work");
      git("push", "-q", "origin", "dev");
      const refused = seam(["--force", "--skeptic", record()]);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("doesn't cover an unsynced tip");
      const r = seam(["--force", "--by-user"]);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain("landed on an unsynced tip");
    });
  });

  it("the report has the verdict and the declines since the last landing, once", () => {
    git("checkout", "-q", "prd/throwaway-x");
    commit({ "web/b.ts": "2" }, "code");
    git("checkout", "-q", "dev");
    tip = git("rev-parse", "prd/throwaway-x");
    markLanded(store(), "throwaway-x", Date.now() - 60_000);
    record({ action: "decline T_old", why: "before the last landing", now: Date.now() - 120_000 });
    record({ action: "decline T_1", why: "the guard is above it" });
    record({ action: "decline T_2", verdict: "no", why: "a real bug" });
    const ids = [record(), record({ action: "no-review", why: "Codex is stuck" })];
    const r = seam(["--force", "--no-review", "--skeptic", ids[0], "--skeptic", ids[1]], {}, unseamed);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const text = report();
    expect(text).toContain("## What the skeptic said");
    expect(text).toContain("the failure is unrelated");
    expect(text).toContain("Codex is stuck");
    expect(text).toContain("declining Codex thread T_1: s");
    expect(text).toContain("declining Codex thread T_2: s");
    expect(text).not.toContain("before the last landing");
    expect(r.stdout).toContain("for the landing and run-through reports");
    expect(declinesSince(store(), "throwaway-x")).toEqual([]);
  });
});

describe("land.sh --resume", () => {
  const board = () => join(root, "notices");
  const mergeLog = () => join(root, "merges.log");
  const journal = (b = "prd-throwaway-x") => join(root, "landing", `${b}.json`);
  const notices = () =>
    existsSync(board()) ? readdirSync(board()).filter((f) => /^n\d+\.json$/.test(f)) : [];
  const toTest = () => (existsSync(join(repo, "to-test")) ? readdirSync(join(repo, "to-test")) : []);
  const merges = () => (existsSync(mergeLog()) ? readFileSync(mergeLog(), "utf8").trim().split("\n") : []);
  const run = (args, extra = {}) =>
    spawnSync("bash", ["scripts/loops/land.sh", ...args], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        PR_HEAD: spawnSync("git", ["-C", repo, "rev-parse", "prd/throwaway-x"], {
          encoding: "utf8",
        }).stdout.trim(),
        RISA_NOTICES_DIR: board(),
        GH_MERGE_LOG: mergeLog(),
        ...extra,
      },
    });
  const PRD = ["throwaway-x", "-m", "feat(throwaway-x): t (B-1)", "--force", "--no-review", "--by-user"];
  const HOTFIX = ["hotfix/throwaway-y", "--local", "--force", "--by-user", "-m", "fix(web): c"];
  const killedAt = (args, step) => {
    const r = run(args, { RISA_LAND_KILL_AT: step });
    expect(r.signal, r.stderr + r.stdout).toBe("SIGKILL");
    return r;
  };
  const resume = (b, extra) => run(["--resume", b], extra);
  const has = (ref, tip) =>
    spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", tip, ref]).status === 0;
  const hotfix = () => {
    git("checkout", "-qb", "hotfix/throwaway-y");
    commit({ "web/c.ts": "3" }, "fix it");
    git("checkout", "-q", "dev");
    return git("rev-parse", "hotfix/throwaway-y");
  };

  describe("on the PR path", () => {
    let tip;
    beforeEach(() => {
      branch({ "web/b.ts": "2" });
      tip = git("rev-parse", "prd/throwaway-x");
    });

    for (const step of ["mark", "to-test", "notice", "dev-sync", "flakes"])
      it(`a landing killed before ${step} resumes to one merge and a synced dev`, () => {
        killedAt(PRD, step);
        expect(existsSync(journal())).toBe(true);
        expect(run(PRD).stderr).toContain("pnpm prd land --resume prd/throwaway-x");
        const r = resume("prd/throwaway-x");
        expect(r.status, r.stderr + r.stdout).toBe(0);
        expect(r.stdout).toContain("finish:");
        expect(merges()).toEqual(["merged"]);
        git("fetch", "-q", "origin");
        expect(git("rev-parse", "dev")).toBe(git("rev-parse", "origin/dev"));
        expect(has("dev", tip)).toBe(true);
        expect(toTest()).toHaveLength(1);
        expect(readFileSync(join(repo, "to-test", toTest()[0]), "utf8")).toContain(
          `as \`${git("rev-parse", "--short", "dev")}\``,
        );
        expect(notices()).toHaveLength(1);
        expect(existsSync(journal())).toBe(false);
        expect(readdirSync(join(root, "landing"))).toEqual([]);
        expect(resume("prd/throwaway-x").stdout).toContain("no cut-off landing");
      });

    it("a PR merged with no dev sync resumes with the sync", () => {
      killedAt(PRD, "dev-sync");
      expect(has("dev", tip)).toBe(false);
      const r = resume("prd/throwaway-x");
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toContain("dev-sync: fast-forwarded");
      expect(has("dev", tip)).toBe(true);
    });

    it("killed before the GitHub merge, it's undone, and goes through land again", () => {
      killedAt(PRD, "merge");
      expect(merges()).toEqual([]);
      const r = resume("prd/throwaway-x");
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toContain("undone");
      expect(existsSync(journal())).toBe(false);
      expect(merges()).toEqual([]);
      expect(toTest()).toEqual([]);
      const again = run(PRD);
      expect(again.status, again.stderr + again.stdout).toBe(0);
      expect(merges()).toEqual(["merged"]);
      expect(existsSync(journal())).toBe(false);
    });

    it("killed before its first step leaves no journal, and a resume says so", () => {
      killedAt(PRD, "push");
      expect(existsSync(journal())).toBe(false);
      const r = resume("prd/throwaway-x");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("no cut-off landing");
    });

    it("asks, and keeps the journal, when GitHub's state is unknown and origin/dev lacks the tip", () => {
      killedAt(PRD, "merge");
      const r = resume("prd/throwaway-x", { GH_PR_STATE: "WEIRD" });
      expect(r.status).toBe(3);
      expect(r.stdout + r.stderr).toContain("ask");
      expect(existsSync(journal())).toBe(true);
      expect(merges()).toEqual([]);
    });

    it("a refusal at the push drops the journal: nothing landed", () => {
      git("checkout", "-q", "dev");
      commit({ "web/other.ts": "o" }, "elsewhere");
      git("push", "-q", "origin", "dev");
      git("reset", "-q", "--hard", "HEAD^");
      const r = run(PRD);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("nothing landed");
      expect(existsSync(journal())).toBe(false);
    });
  });

  describe("on the local path", () => {
    let tip;
    beforeEach(() => {
      tip = hotfix();
    });

    for (const step of ["mark", "to-test", "notice", "flakes"])
      it(`a landing killed before ${step} resumes to one merge`, () => {
        killedAt(HOTFIX, step);
        const r = resume("hotfix/throwaway-y");
        expect(r.status, r.stderr + r.stdout).toBe(0);
        expect(git("rev-list", "--merges", "--count", "dev")).toBe("1");
        expect(has("dev", tip)).toBe(true);
        expect(toTest()).toHaveLength(1);
        expect(notices()).toHaveLength(1);
        expect(existsSync(journal("hotfix-throwaway-y"))).toBe(false);
      });

    // A landing cut off inside `git merge`: the journal at merge, MERGE_HEAD the tip.
    const midMerge = () => {
      killedAt(HOTFIX, "mark");
      git("reset", "-q", "--hard", "HEAD^");
      git("merge", "-q", "--no-ff", "--no-commit", "hotfix/throwaway-y");
    };
    const mergeHead = () => join(git("rev-parse", "--absolute-git-dir"), "MERGE_HEAD");

    it("killed mid-merge, it aborts the merge of the recorded tip and goes through land again", () => {
      midMerge();
      const before = git("rev-parse", "dev");
      const r = resume("hotfix/throwaway-y");
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toContain("aborted the cut-off merge");
      expect(existsSync(mergeHead())).toBe(false);
      expect(git("rev-parse", "dev")).toBe(before);
      expect(existsSync(journal("hotfix-throwaway-y"))).toBe(false);
      const again = run(HOTFIX);
      expect(again.status, again.stderr + again.stdout).toBe(0);
      expect(git("rev-list", "--merges", "--count", "dev")).toBe("1");
    });

    it("never aborts a MERGE_HEAD other than the recorded tip", () => {
      midMerge();
      git("merge", "--abort");
      git("checkout", "-qb", "other");
      const other = commit({ "web/d.ts": "4" }, "other work");
      git("checkout", "-q", "dev");
      git("merge", "-q", "--no-ff", "--no-commit", "other");
      const r = resume("hotfix/throwaway-y");
      expect(r.status).toBe(3);
      expect(r.stdout).toContain("never aborted");
      expect(readFileSync(mergeHead(), "utf8").trim()).toBe(other);
      expect(existsSync(journal("hotfix-throwaway-y"))).toBe(true);
    });
  });
});
