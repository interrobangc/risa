// land.sh on an unsynced tip (land.test.mjs has the rest): the throwaway repo is land-fixture.mjs's.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { brakeNotice } from "../ci/blame.mjs";
import { createNotice, withdrawNotice } from "./notices.mjs";
import { FIXTURE_CONFIG } from "./config-fixture.mjs";
import { root, repo, git, commit, landWith, branch, GH_CI, useLandRepo } from "./land-fixture.mjs";

useLandRepo();

describe("land.sh on an unsynced tip", () => {
  const OWN = "scripts/loops/own.sh";
  const wt = () => join(repo, ".loops", "throwaway-x");
  const inWt = (...a) => execFileSync("git", ["-C", wt(), ...a], { encoding: "utf8", stdio: "pipe" }).trim();
  const steps = () =>
    existsSync(join(root, "pnpm.log")) ? readFileSync(join(root, "pnpm.log"), "utf8").trim().split("\n") : [];
  const env = () => ({
    GH_CI: join(root, "gh-ci.mjs"),
    GH_CI_FIXTURE: join(root, "fixture.json"),
    RISA_CI_POLL: "0",
    RISA_LEASE_ROOT: join(root, "leases"),
    RISA_LEASE_POLL: "1",
    RISA_NOTICES_DIR: join(root, "notices"),
    RISA_LOAD_GATE: "off",
    PNPM_LOG: join(root, "pnpm.log"),
  });
  const go = (extra = {}, ...args) => landWith({ ...env(), ...extra }, "--no-review", "--by-user", ...args);
  const toDev = (files) => {
    commit(files, "dev work");
    git("push", "-q", "origin", "dev");
  };
  const started = (files = { [OWN]: "own" }) => {
    branch(files);
    git("worktree", "add", "-q", wt(), "prd/throwaway-x");
  };
  const atTip = () => {
    expect(inWt("rev-parse", "HEAD")).toBe(git("rev-parse", "prd/throwaway-x"));
    expect(inWt("status", "--porcelain")).toBe("");
    expect(
      existsSync(join(git("rev-parse", "--absolute-git-dir"), "worktrees", "throwaway-x", "MERGE_HEAD")),
    ).toBe(false);
  };
  // A merge a killed landing left: its marker names a pid that isn't running.
  const leftover = () => {
    const tip = inWt("rev-parse", "HEAD");
    const dev = git("rev-parse", "dev");
    inWt("merge", "--no-commit", "--no-ff", "-q", dev);
    writeFileSync(
      join(inWt("rev-parse", "--absolute-git-dir"), "caretook-unsynced-merge"),
      `${tip} ${dev} 999999\nnever\n`,
    );
  };

  beforeEach(() => {
    writeFileSync(join(root, "gh-ci.mjs"), GH_CI);
    writeFileSync(join(root, "fixture.json"), JSON.stringify({ byCommit: {} }));
    writeFileSync(join(repo, ".git", "info", "exclude"), ".loops/\nto-test/\n");
    writeFileSync(
      join(root, "bin", "pnpm"),
      `#!/usr/bin/env bash
echo "$1" >> "$PNPM_LOG"
if [[ $1 == typecheck ]]; then
  [[ -z "\${PNPM_ON_TYPECHECK:-}" ]] || eval "$PNPM_ON_TYPECHECK"
  [[ -z "\${PNPM_HANG:-}" ]] || { touch "$PNPM_HANG"; sleep 30; }
  [[ -z "\${PNPM_FAIL:-}" ]] || { echo "a type error" >&2; exit 2; }
fi
exit 0
`,
    );
    chmodSync(join(root, "bin", "pnpm"), 0o755);
  });

  it("records the landing's end after the unsynced typecheck", () => {
    started();
    toDev({ "apps/web/dev.ts": "d" });
    const r = go();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(steps()).toEqual(["typegen", "typecheck"]);
    const kinds = readFileSync(process.env.RISA_RUN_LOG, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .map((e) => [e.kind, e.exit]);
    expect(kinds).toEqual([
      ["land-start", undefined],
      ["land-end", 0],
    ]);
  });

  it("lands over drift on other files: typegen then typecheck, the line printed and in --body", () => {
    started();
    toDev({ "apps/web/dev.ts": "d" });
    const r = go();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(steps()).toEqual(["typegen", "typecheck"]);
    expect(r.stdout).toContain(
      "landed on an unsynced tip: `dev` had 1 commit since the last sync, sharing no file with it; only the merged result's typecheck ran",
    );
    expect(r.stdout).toMatch(/--body Landed\\? on\\? an\\? unsynced\\? tip:/);
    atTip();
  });

  // A sample config with other commands and another id prefix: the landing runs
  // and takes what it says.
  const sample = (change) => {
    const raw = JSON.parse(readFileSync(FIXTURE_CONFIG, "utf8"));
    change(raw);
    writeFileSync(join(root, "sample.json"), JSON.stringify(raw));
    // Its paths start from its own folder: the tier data and rules the check plan reads go there too.
    for (const rel of [raw.paths.tierData, raw.paths.checkPlanRules]) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      cpSync(join(dirname(FIXTURE_CONFIG), rel), join(root, rel));
    }
    return { RISA_CONFIG: join(root, "sample.json") };
  };

  it("runs the config's typegen and typecheck", () => {
    started();
    toDev({ "lib/dev.ts": "d" });
    const conf = sample((c) =>
      Object.assign(c.commands, { typegen: "pnpm gen:types", typecheck: "pnpm tsc -b" }),
    );
    const r = go(conf);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(steps()).toEqual(["gen:types", "tsc"]);
    atTip();
  });

  it("takes --fixes in the config's id form", () => {
    started();
    const conf = sample((c) => (c.backlog.idPrefix = "RISA"));
    const r = go(conf, "--fixes", "B-9");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--fixes takes backlog ids: --fixes RISA-1,RISA-2");
    expect(go(conf, "--fixes", "RISA-9,RISA-10").stderr).not.toContain("--fixes takes");
    // With a former prefix, its ids are read too.
    const former = sample((c) => Object.assign(c.backlog, { idPrefix: "RISA", formerIdPrefix: "B" }));
    expect(go(former, "--fixes", "B-9,RISA-10").stderr).not.toContain("--fixes takes");
    expect(go(former, "--fixes", "C-9").stderr).toContain("--fixes takes backlog ids: --fixes RISA-1,RISA-2");
  });

  it("counts only the commits that are drift", () => {
    started();
    toDev({ "plans/backlog.md": "b" });
    toDev({ "apps/web/dev.ts": "d" });
    expect(go().stdout).toContain("`dev` had 1 commit since");
  });

  it("refuses a shared file", () => {
    started({ "apps/web/a.ts": "mine", [OWN]: "own" });
    toDev({ "apps/web/a.ts": "theirs" });
    const r = go();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("has moved since prd/throwaway-x last synced");
    expect(r.stderr).toContain("changed apps/web/a.ts");
    expect(steps()).toEqual([]);
  });

  it.each([
    ["a migration", "packages/data/src/db/migrations/0001_x.sql"],
    ["a package.json", "apps/web/package.json"],
    ["test setup", "packages/data/test/setup.ts"],
  ])("refuses dev bringing %s, naming it", (_kind, file) => {
    started();
    toDev({ [file]: "x" });
    const r = go();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(file);
    expect(steps()).toEqual([]);
  });

  it("keeps the drift refusal with --fixes and with RISA_UNSYNCED=off", () => {
    started();
    toDev({ "apps/web/dev.ts": "d" });
    const refused = [go({}, "--fixes", "B-9"), go({ RISA_UNSYNCED: "off" })];
    for (const r of refused) {
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("has moved since");
    }
    expect(steps()).toEqual([]);
  });

  describe("on the branch's CI verdict", () => {
    const TEST = "apps/web/x.test.ts";
    const failing = { job: "unit", file: TEST, name: "fails" };
    const verdict = (tip, kind) => ({
      version: 1,
      commit: tip,
      runId: "11",
      tier: "components",
      ranTier: "components",
      kind,
      flaky: [],
      brake: { jobs: [], tests: [], files: [] },
      failed: { tests: [failing], files: [TEST], jobs: ["unit"], unnamedJobs: [] },
    });
    const withVerdict = (kind) => {
      toDev({ [TEST]: "t" });
      started({ "apps/web/b.ts": "2" });
      toDev({ "apps/web/dev.ts": "d" });
      const tip = git("rev-parse", "prd/throwaway-x");
      writeFileSync(
        join(root, "fixture.json"),
        JSON.stringify({
          byCommit: { [tip]: [{ id: 11, tier: "components", verdict: verdict(tip, kind) }] },
          devFails: [failing],
        }),
      );
    };

    it("a brake that is all dev's still refuses the unsynced landing", () => {
      withVerdict("brake");
      const r = go();
      expect(r.status, r.stdout + r.stderr).not.toBe(0);
      expect(r.stderr).toContain("CI reads a brake");
      expect(steps()).toEqual([]);
    });

    it("an unknown verdict refuses, and no typecheck runs", () => {
      withVerdict("something-new");
      const r = go();
      expect(r.status).not.toBe(0);
      expect(steps()).toEqual([]);
    });

    it("a failure that is all dev's lands unsynced", () => {
      withVerdict("file");
      const r = go();
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain("landed on an unsynced tip");
    });
  });

  describe("on a known dev brake", () => {
    const board = () => join(root, "notices");
    const failure = { key: "k1", job: "unit", file: "apps/web/x.test.ts", name: "fails" };
    const ciVerdict = (sha, kind) => ({
      version: 1,
      commit: sha,
      runId: "21",
      tier: "components",
      ranTier: "components",
      kind,
      flaky: [],
      brake: { jobs: [], tests: [], files: [] },
      failed: { tests: [], files: [], jobs: [], unnamedJobs: [] },
    });
    const runs = (verdicts) =>
      writeFileSync(
        join(root, "fixture.json"),
        JSON.stringify({
          byCommit: Object.fromEntries(
            verdicts.map(([sha, kind], i) => [
              sha,
              [{ id: 21 + i, tier: "components", verdict: ciVerdict(sha, kind) }],
            ]),
          ),
        }),
      );
    const drifted = (files) => {
      started(files);
      toDev({ "apps/web/dev.ts": "d" });
      return git("rev-parse", "origin/dev");
    };
    const refused = (r, why) => {
      expect(r.status, r.stdout + r.stderr).not.toBe(0);
      expect(r.stderr).toContain("has moved since");
      expect(r.stderr).toContain(why);
      expect(r.stdout).not.toContain("landed on an unsynced tip");
    };
    const landed = (r) => {
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain("landed on an unsynced tip");
    };

    it("refuses a tier none branch when dev's tip reads brake", () => {
      runs([[drifted(), "brake"]]);
      refused(go(), "CI reads a brake on dev's tip");
      expect(steps()).toEqual([]);
    });

    it("refuses a Markdown-only branch when dev's tip reads brake", () => {
      runs([[drifted({ "docs/own.md": "own" }), "brake"]]);
      refused(go(), "CI reads a brake on dev's tip");
    });

    it("refuses a tier none branch on a live dev-brake notice with no verdict on the tip", () => {
      drifted();
      createNotice(board(), { text: brakeNotice("B-9", failure), session: "ci", minutes: 60 });
      refused(go(), "a dev-brake notice is live: dev brake B-9");
      expect(steps()).toEqual([]);
    });

    it("refuses a gated branch with a clean verdict of its own when dev reads brake", () => {
      const dev = drifted({ "apps/web/b.ts": "2" });
      runs([
        [git("rev-parse", "prd/throwaway-x"), "green"],
        [dev, "brake"],
      ]);
      refused(go(), "CI reads a brake on dev's tip");
      expect(steps()).toEqual([]);
    });

    it("reads the tip land measures against, not a local dev ahead of it", () => {
      const measured = drifted();
      commit({ "apps/web/local.ts": "l" }, "unpushed dev work");
      runs([[measured, "brake"]]);
      refused(go(), `CI reads a brake on dev's tip ${measured.slice(0, 8)}`);
    });

    it("refuses when a brake appears during the typecheck", () => {
      drifted();
      const later = join(root, "later.json");
      const { id } = createNotice(board(), { text: brakeNotice("B-9", failure), session: "ci" });
      cpSync(join(board(), `${id}.json`), later);
      withdrawNotice(board(), id);
      const r = go({ PNPM_ON_TYPECHECK: `cp "${later}" "${join(board(), `${id}.json`)}"` });
      refused(r, "a dev-brake notice is live");
      expect(steps()).toEqual(["typegen", "typecheck"]);
      atTip();
    });

    it("lands with no verdict on dev", () => {
      drifted();
      landed(go());
    });

    it.each(["green", "file", "something-new"])("lands when dev's tip reads %s", (kind) => {
      runs([[drifted(), kind]]);
      landed(go());
    });

    it("lands when GitHub can't be reached, and says so", () => {
      drifted();
      const r = go({ GH_CI: join(root, "no-such-stub.mjs") });
      landed(r);
      expect(r.stderr).toContain("dev's brake state couldn't all be read (GitHub couldn't be read for");
    });

    it("lands on an unreadable board, and says so", () => {
      drifted();
      writeFileSync(join(root, "a-file"), "x");
      const r = go({ RISA_NOTICES_DIR: join(root, "a-file", "notices") });
      landed(r);
      expect(r.stderr).toContain("couldn't read the dev-brake notices");
    });

    it("an expired brake notice doesn't refuse", () => {
      drifted();
      createNotice(board(), {
        text: brakeNotice("B-9", failure),
        session: "ci",
        minutes: 60,
        now: Date.now() - 2 * 3600_000,
      });
      landed(go());
    });

    it("a withdrawn brake notice doesn't refuse", () => {
      drifted();
      const { id } = createNotice(board(), { text: brakeNotice("B-9", failure), session: "ci" });
      withdrawNotice(board(), id);
      landed(go());
    });

    it("a notice that isn't a brake notice doesn't refuse", () => {
      drifted();
      createNotice(board(), { text: "landed prd/x in dev as abc1234: dev brake talk", session: "s" });
      createNotice(board(), { text: "dev brake B-9 without its key", session: "s" });
      landed(go());
    });
  });

  it("refuses a merge that conflicts and restores the worktree", () => {
    // No path is on both sides, so only the merge can see it: a directory on
    // one side and a file on the other.
    started({ "scripts/loops/thing/one.sh": "1" });
    toDev({ "scripts/loops/thing": "a file" });
    const r = go();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("conflicts");
    expect(steps()).toEqual([]);
    atTip();
  });

  it("lands nothing on a failing typecheck, and restores the worktree", () => {
    started();
    toDev({ "apps/web/dev.ts": "d" });
    const r = go({ PNPM_FAIL: "1" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("doesn't typecheck");
    expect(r.stderr).toContain("pnpm prd sync");
    expect(r.stdout).not.toContain("It would push");
    atTip();
  });

  it("restores the worktree after an interrupt", async () => {
    started();
    toDev({ "apps/web/dev.ts": "d" });
    const hung = join(root, "hung");
    const child = spawn(
      "bash",
      ["scripts/loops/land.sh", "throwaway-x", "-m", "docs(throwaway-x): t", "--no-review", "--by-user"],
      {
        cwd: repo,
        stdio: "ignore",
        env: {
          ...process.env,
          ...env(),
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          RISA_PR_THROWAWAY: "1",
          PR_HEAD: git("rev-parse", "prd/throwaway-x"),
          PNPM_HANG: hung,
        },
      },
    );
    const gone = new Promise((done) => child.on("exit", done));
    await expect.poll(() => existsSync(hung), { timeout: 15_000 }).toBe(true);
    child.kill("SIGTERM");
    await gone;
    await expect
      .poll(() => existsSync(join(inWt("rev-parse", "--absolute-git-dir"), "caretook-unsynced-merge")), {
        timeout: 5_000,
      })
      .toBe(false);
    atTip();
  });

  it("aborts a leftover marked merge at the next land", () => {
    started();
    toDev({ "apps/web/dev.ts": "d" });
    leftover();
    const r = go();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("aborted a temporary merge");
    atTip();
  });

  it("aborts a leftover marked merge at the next sync", () => {
    started();
    toDev({ "apps/web/dev.ts": "d" });
    leftover();
    const r = syncIt("--force");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("aborted a temporary merge");
    expect(r.stdout).toContain("Merged dev into prd/throwaway-x");
  });

  const syncIt = (/** @type {string[]} */ ...args) =>
    spawnSync("bash", [join(wt(), "scripts/loops/prd.sh"), "sync", ...args], {
      cwd: wt(),
      encoding: "utf8",
      env: { ...process.env, ...env() },
    });

  it("sync skips a merge dev's changes don't need, and --force merges them", () => {
    started();
    toDev({ "apps/web/dev.ts": "d" });
    const before = inWt("rev-parse", "HEAD");
    const skip = syncIt();
    expect(skip.status, skip.stdout + skip.stderr).toBe(0);
    expect(skip.stdout).toContain("needs no merge");
    expect(inWt("rev-parse", "HEAD")).toBe(before);
    const forced = syncIt("--force");
    expect(forced.status, forced.stdout + forced.stderr).toBe(0);
    expect(forced.stdout).toContain("Merged dev into prd/throwaway-x");
  });

  it("sync merges when dev brings something risky", () => {
    started();
    toDev({ "eslint.config.js": "export default [];" });
    const r = syncIt();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("Merged dev into prd/throwaway-x");
  });

  it("sync treats a backlog archive commit as no drift", () => {
    started();
    toDev({ "plans/backlog-archive.md": "archived" });
    const r = syncIt();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("up to date");
  });

  it("leaves a merge that isn't the marked one alone", () => {
    started();
    toDev({ "apps/web/dev.ts": "d" });
    leftover();
    const marker = join(inWt("rev-parse", "--absolute-git-dir"), "caretook-unsynced-merge");
    writeFileSync(marker, `${"0".repeat(40)} ${"1".repeat(40)} 999999\nnever\n`);
    const r = go();
    expect(r.stderr).toContain("isn't the landing's temporary one");
    expect(r.status).not.toBe(0);
    expect(existsSync(join(inWt("rev-parse", "--absolute-git-dir"), "MERGE_HEAD"))).toBe(true);
  });

  it("refuses a worktree holding a browser lease", () => {
    started();
    toDev({ "apps/web/dev.ts": "d" });
    const lease = join(root, "leases", "browser", "1");
    mkdirSync(lease, { recursive: true });
    writeFileSync(
      join(lease, "name"),
      `kind=browser\nworktree=throwaway-x\ncheck=x\npid=${process.pid}\ncmd=\nstarted=${Math.floor(Date.now() / 1000)}\n`,
    );
    const r = go();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("holds a check or browser lease");
    expect(steps()).toEqual([]);
    atTip();
  });

  it("refuses a dirty worktree and one that's missing", () => {
    started();
    toDev({ "apps/web/dev.ts": "d" });
    writeFileSync(join(wt(), "stray.txt"), "x");
    expect(go().stderr).toContain("uncommitted changes");
    rmSync(join(wt(), "stray.txt"));
    git("worktree", "remove", "--force", wt());
    const r = go();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no worktree");
  });

  it("refuses when dev moves onto a shared file during the typecheck", () => {
    started();
    toDev({ "apps/web/dev.ts": "d" });
    const other = join(root, "other");
    execFileSync("git", ["clone", "-q", "-b", "dev", join(root, "origin.git"), other]);
    mkdirSync(join(other, "scripts", "loops"), { recursive: true });
    writeFileSync(join(other, OWN), "theirs");
    execFileSync("git", ["-C", other, "add", "-A"]);
    execFileSync("git", [
      "-C",
      other,
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=T",
      "commit",
      "-qm",
      "moved",
    ]);
    const r = go({ PNPM_ON_TYPECHECK: `git -C ${other} push -q origin dev` });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("judging it once more");
    expect(r.stderr).toContain(`changed ${OWN}`);
    atTip();
  });

  it("typechecks once more when dev moves onto other files, then lands", () => {
    started();
    toDev({ "apps/web/dev.ts": "d" });
    const other = join(root, "other");
    execFileSync("git", ["clone", "-q", "-b", "dev", join(root, "origin.git"), other]);
    writeFileSync(join(other, "apps/web/later.ts"), "later");
    execFileSync("git", ["-C", other, "add", "-A"]);
    execFileSync("git", [
      "-C",
      other,
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=T",
      "commit",
      "-qm",
      "moved",
    ]);
    const once = join(root, "once");
    const r = go({
      PNPM_ON_TYPECHECK: `[[ -e ${once} ]] || { touch ${once}; git -C ${other} push -q origin dev; }`,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(steps()).toEqual(["typegen", "typecheck", "typegen", "typecheck"]);
    expect(r.stdout).toContain("`dev` had 2 commits since");
  });

  it("lands a Markdown-only branch with no worktree and no typecheck", () => {
    branch({ "docs/x.md": "d" });
    toDev({ "apps/web/dev.ts": "d" });
    const r = go();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(steps()).toEqual([]);
    expect(r.stdout).toContain("Markdown only, so no typecheck ran");
  });

  it("the local path's merge commit and the to-test file carry the line", () => {
    git("checkout", "-qb", "hotfix/throwaway-y");
    commit({ [OWN]: "own" }, "fix it");
    git("checkout", "-q", "dev");
    git("worktree", "add", "-q", join(repo, ".loops", "hotfix-throwaway-y"), "hotfix/throwaway-y");
    commit({ "apps/web/dev.ts": "d" }, "dev work");
    const r = spawnSync(
      "bash",
      ["scripts/loops/land.sh", "hotfix/throwaway-y", "--local", "-m", "fix(web): c"],
      {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, ...env(), PATH: `${join(root, "bin")}:${process.env.PATH}` },
      },
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(git("log", "-1", "--format=%s")).toBe("fix(web): c");
    expect(git("log", "-1", "--format=%b")).toContain(
      "Landed on an unsynced tip: dev had 1 commit since the last sync, sharing no file with it",
    );
    const [file] = readdirSync(join(repo, "to-test"));
    expect(readFileSync(join(repo, "to-test", file), "utf8")).toContain("landed on an unsynced tip");
  });
});

// A skeptic's go in place of the user's word, on real records in a temporary store.
