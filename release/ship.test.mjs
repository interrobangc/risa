// Risa's ship hooks (release/ship.mjs), against a throwaway repo with a bare origin,
// tags v0.1.0 and v0.2.0, and a fake `gh` whose runs are a file the test writes.
// Nothing here pushes to the real origin, tags this repo or writes the real ~/.risa.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bumpChangelog, bumpPackage, ciVerdict, compareVersions, highestTag, parseTags } from "./ship.mjs";

const SCRIPT = fileURLToPath(new URL("./ship.mjs", import.meta.url));
const PKG = (/** @type {string} */ v) =>
  `{\n  "name": "sample-tool",\n  "version": "${v}",\n  "private": true\n}\n`;
const CHANGELOG = "# Changelog\n\n## Unreleased\n\n- A sample change.\n\n## v0.2.0\n\n- An older one.\n";

// gh run list --commit <sha>: the runs $GH_RUNS (a JSON file: sha → runs) holds for it.
// $GH_ON_LIST, when set, runs once (a marker beside the file) before it answers.
const GH = `#!/usr/bin/env node
const { execSync } = require("node:child_process");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "run" || args[1] !== "list") { console.error("unexpected gh " + args.join(" ")); process.exit(1); }
if (process.env.GH_ON_LIST && !existsSync(process.env.GH_RUNS + ".moved")) {
  writeFileSync(process.env.GH_RUNS + ".moved", "");
  execSync(process.env.GH_ON_LIST, { stdio: "ignore" });
}
const sha = args[args.indexOf("--commit") + 1];
const runs = JSON.parse(readFileSync(process.env.GH_RUNS, "utf8"))[sha] ?? [];
console.log(JSON.stringify(runs.map((r, i) => ({ databaseId: i + 1, headSha: sha, headBranch: "main",
  status: r.status ?? "completed", conclusion: r.conclusion ?? "success", createdAt: "2026-01-0" + (i + 1) + "T00:00:00Z",
  url: "https://example.test/run/" + (i + 1), workflowName: r.workflow ?? "CI", attempt: 1 }))));
`;

let root = "",
  repo = "",
  origin = "";
/** @type {Record<string, object[]>} */
let runs = {};
const git = (/** @type {string[]} */ ...a) =>
  execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
const bare = (/** @type {string[]} */ ...a) =>
  execFileSync("git", ["-C", origin, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
const commit = (/** @type {Record<string, string>} */ files, /** @type {string} */ msg) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git("add", "-A");
  git("commit", "-qm", msg);
  return git("rev-parse", "HEAD");
};
const green = (/** @type {string} */ sha) => {
  runs[sha] = [{}];
};
const hook = (/** @type {string} */ verb, /** @type {string} */ version, extra = {}) => {
  writeFileSync(join(root, "runs.json"), JSON.stringify(runs));
  const r = spawnSync(process.execPath, [SCRIPT, verb, version], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      HOME: join(root, "home"),
      RISA_MACHINE_CONFIG: join(root, "machine.json"),
      RISA_SHIPS_DIR: join(root, "ships"),
      RISA_ASKS_DIR: join(root, "asks"),
      GH_RUNS: join(root, "runs.json"),
      ...extra,
    },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "release-ship-")));
  repo = join(root, "repo");
  origin = join(root, "origin.git");
  runs = {};
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "home"));
  writeFileSync(join(root, "bin", "gh"), GH);
  chmodSync(join(root, "bin", "gh"), 0o755);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "core.hooksPath", "/dev/null");
  git("remote", "add", "origin", origin);
  commit(
    { "package.json": PKG("0.1.0"), "CHANGELOG.md": "# Changelog\n\n## Unreleased\n", "src/a.mjs": "1\n" },
    "a",
  );
  git("tag", "-a", "v0.1.0", "-m", "v0.1.0");
  commit({ "package.json": PKG("0.2.0"), "CHANGELOG.md": CHANGELOG }, "chore(release): v0.2.0");
  git("tag", "-a", "v0.2.0", "-m", "v0.2.0");
  commit({ "src/a.mjs": "2\n", "plans/backlog.md": "# Backlog\n" }, "feat: a change");
  git("push", "-q", "origin", "main", "--tags");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the helpers", () => {
  it("compares versions and finds the highest tag", () => {
    expect(compareVersions("0.2.1", "v0.2.0")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "v0.2.0")).toBe(0);
    expect(compareVersions("0.3.0-rc.1", "0.3.0")).toBeLessThan(0);
    expect(highestTag(["v0.9.0", "v0.10.0", "v0.2.0"])).toBe("v0.10.0");
    expect(highestTag([])).toBeNull();
    const tags = parseTags(
      "a1\trefs/tags/v0.1.0\nb2\trefs/tags/v0.2.0\nc3\trefs/tags/v0.2.0^{}\nd4\trefs/tags/vnext\n",
    );
    expect([...tags]).toEqual([
      ["v0.1.0", "a1"],
      ["v0.2.0", "c3"],
    ]);
  });

  it("reads CI's verdict from the runs", () => {
    const sha = "a".repeat(40);
    expect(
      ciVerdict(
        [{ databaseId: 1, headSha: sha, status: "completed", conclusion: "success", createdAt: "1" }],
        sha,
      ),
    ).toEqual({ ok: true });
    expect(ciVerdict(null, sha)).toMatchObject({ ok: false, why: expect.stringMatching(/can't be read/) });
    expect(ciVerdict([], sha)).toMatchObject({ why: expect.stringMatching(/no CI run/) });
    // The newest completed run decides: a rerun's success after a failure passes.
    const r = (/** @type {string} */ conclusion, /** @type {string} */ createdAt) => ({
      databaseId: 1,
      headSha: sha,
      status: "completed",
      conclusion,
      createdAt,
    });
    expect(ciVerdict([r("failure", "1"), r("success", "2")], sha)).toEqual({ ok: true });
    expect(ciVerdict([r("success", "1"), r("failure", "2")], sha)).toMatchObject({
      why: expect.stringMatching(/didn't pass/),
    });
  });

  it("bumps the one version value and the changelog's heading", () => {
    expect(bumpPackage(PKG("0.2.0"), "0.2.1")).toBe(PKG("0.2.1"));
    expect(bumpChangelog(CHANGELOG, "0.2.1")).toBe(
      "# Changelog\n\n## Unreleased\n\n## v0.2.1\n\n- A sample change.\n\n## v0.2.0\n\n- An older one.\n",
    );
  });
});

describe("check", () => {
  it("passes a green tip above the highest tag and prints it", () => {
    const tip = git("rev-parse", "HEAD");
    green(tip);
    const r = hook("check", "0.2.1");
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    expect(r.out).toBe(`tip=${tip}\n`);
  });

  it("refuses a tagged version and one not above the highest tag", () => {
    green(git("rev-parse", "HEAD"));
    const tagged = hook("check", "0.2.0");
    expect(tagged.status).toBe(1);
    expect(tagged.err).toMatch(/v0\.2\.0 is already tagged on origin/);
    const below = hook("check", "0.1.9");
    expect(below.status).toBe(1);
    expect(below.err).toMatch(/0\.1\.9 isn't above v0\.2\.0, the highest tag on origin/);
  });

  it("refuses a failed, running or missing CI run, each saying why", () => {
    const tip = git("rev-parse", "HEAD");
    runs[tip] = [{ conclusion: "failure" }];
    expect(hook("check", "0.2.1")).toMatchObject({
      status: 1,
      err: expect.stringMatching(/CI didn't pass on .*failure/),
    });
    runs[tip] = [{ status: "in_progress", conclusion: "" }];
    expect(hook("check", "0.2.1")).toMatchObject({
      status: 1,
      err: expect.stringMatching(/still running.*try again/),
    });
    // Another workflow's run is not CI's.
    runs[tip] = [{ workflow: "Pages" }];
    expect(hook("check", "0.2.1")).toMatchObject({ status: 1, err: expect.stringMatching(/no CI run on/) });
  });

  it("passes a green commit followed only by a backlog commit", () => {
    const base = git("rev-parse", "HEAD");
    green(base);
    commit({ "plans/backlog.md": "# Backlog\n\n- RISA-1: a new item\n" }, "docs(backlog): an item");
    git("push", "-q", "origin", "main");
    const r = hook("check", "0.2.1");
    expect(r.status).toBe(0);
    expect(r.out).toBe(`tip=${base}\n`);
  });
});

describe("ship", () => {
  it("bumps, commits, tags and pushes, leaving the main checkout alone", () => {
    const before = git("rev-parse", "HEAD");
    green(before);
    writeFileSync(join(repo, "src/a.mjs"), "an edit in progress\n");
    const status = git("status", "--porcelain");
    const r = hook("ship", "0.2.1");
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    const head = bare("rev-parse", "main");
    expect(r.out).toBe(`tag=v0.2.1\ncommit=${head}\n`);
    expect(bare("log", "-1", "--format=%s%n%P", "main")).toBe(`chore(release): v0.2.1\n${before}`);
    expect(bare("diff", "--name-only", before, head).split("\n")).toEqual(["CHANGELOG.md", "package.json"]);
    expect(bare("show", `${head}:package.json`)).toBe(PKG("0.2.1").trim());
    expect(bare("show", `${head}:CHANGELOG.md`)).toBe(bumpChangelog(CHANGELOG, "0.2.1").trim());
    expect(bare("cat-file", "-t", "v0.2.1")).toBe("tag");
    expect(bare("rev-parse", "v0.2.1^{commit}")).toBe(head);
    // The main checkout: its branch, HEAD, index and files as they were; no worktree left.
    expect(git("symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git("rev-parse", "HEAD")).toBe(before);
    expect(git("status", "--porcelain")).toBe(status);
    expect(readFileSync(join(repo, "src/a.mjs"), "utf8")).toBe("an edit in progress\n");
    expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);

    // Again: done already, no new commit.
    const again = hook("ship", "0.2.1");
    expect(again.status).toBe(0);
    expect(again.out).toMatch(`tag=v0.2.1\ncommit=${head}\n`);
    expect(bare("rev-parse", "main")).toBe(head);
    // And the check now refuses it as tagged.
    expect(hook("check", "0.2.1").err).toMatch(/already tagged/);
  });

  it("pushes no tag when origin's main moves before the push", () => {
    green(git("rev-parse", "HEAD"));
    // A second clone pushes to main while the hook reads CI (after the worktree started).
    const other = join(root, "other");
    const move = `git clone -q ${origin} ${other} && cd ${other} && git -c user.name=o -c user.email=o@example.com commit -q --allow-empty -m "feat: elsewhere" && git push -q origin main`;
    const r = hook("ship", "0.2.1", { GH_ON_LIST: move });
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/pushing the release to main/);
    expect(bare("log", "-1", "--format=%s", "main")).toBe("feat: elsewhere");
    expect(bare("tag", "--list", "v0.2.1")).toBe("");
    expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  });

  it("refuses a tip whose CI didn't pass, pushing nothing", () => {
    const before = bare("rev-parse", "main");
    runs[before] = [{ conclusion: "failure" }];
    const r = hook("ship", "0.2.1");
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/CI didn't pass/);
    expect(bare("rev-parse", "main")).toBe(before);
    expect(bare("tag", "--list", "v0.2.1")).toBe("");
  });

  it("refuses a tag on origin whose package.json has another version", () => {
    git("tag", "-a", "v0.3.0", "-m", "v0.3.0");
    git("push", "-q", "origin", "v0.3.0");
    const r = hook("ship", "0.3.0");
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/v0\.3\.0 is on origin at \w+, whose package\.json says 0\.2\.0/);
  });

  it("refuses usage it can't read", () => {
    expect(hook("deploy", "0.2.1").status).toBe(2);
    expect(hook("check", "next").status).toBe(2);
  });
});
