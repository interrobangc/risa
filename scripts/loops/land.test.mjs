// docs_only (lib.sh) and the PR path of land.sh: a Markdown-only prd/ diff
// lands with no Codex verdict, a code diff still needs one. A throwaway repo
// with these scripts copied in, a bare origin, and a stubbed `gh`; the
// CARETOOK_PR_THROWAWAY seam stops land before the merge, so nothing is pushed.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { brakeNotice } from "../ci/blame.mjs";
import { createNotice, withdrawNotice } from "./notices.mjs";

const HERE = new URL(".", import.meta.url).pathname;
let root, repo;
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
const commit = (files, msg) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git("add", "-A");
  git("commit", "-qm", msg);
  return git("rev-parse", "HEAD");
};
const docsOnly = () =>
  spawnSync("bash", ["-c", "source scripts/loops/lib.sh && docs_only dev feature"], {
    cwd: repo,
    encoding: "utf8",
  }).status === 0;

// A `gh` that answers the three calls land.sh makes; the PR's head is $PR_HEAD
// and Codex has said nothing ("waiting"), unless $PR_COMMENTS holds its
// summary comment (a JSON array of comment nodes).
const GH = `#!/usr/bin/env bash
case "$1 $2" in
  "repo view") echo o/r ;;
  "pr list") echo 7 ;;
  "pr merge") [[ -z "$GH_MERGE_FAIL" ]] || { echo "merge refused" >&2; exit 1; }; git push -q origin prd/throwaway-x:dev; [[ -z "$GH_BREAK_SYNC" ]] || touch "$(git rev-parse --absolute-git-dir)/REVERT_HEAD" ;;
  "pr edit") while (($#)); do [[ $1 != --body ]] || printf '%s' "$2" > "$GH_PR_BODY"; shift; done ;;
  "pr view") echo https://example.test/pr/7 ;;
  "run list" | "run view" | "run download" | "api -X") exec node "$GH_CI" "$@" ;;
  "api graphql") printf '{"data":{"repository":{"pullRequest":{"number":7,"url":"https://example.test/pr/7","state":"OPEN","headRefName":"prd/throwaway-x","headRefOid":"%s","reviews":{"nodes":[]},"reviewThreads":{"nodes":[]},"comments":{"nodes":%s},"reactions":{"nodes":[]}}}}}' "$PR_HEAD" "\${PR_COMMENTS:-[]}" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`;

// The stub backlog: `list` prints the items; `ci-file` logs what it was given and
// whether the branch was already in dev, and files everything as B-77.
const BACKLOG = (items) => `import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
if (process.argv[2] === "ci-file") {
  if (process.env.CI_FILE_FAIL) process.exit(1);
  const { findings } = JSON.parse(readFileSync(0, "utf8"));
  const merged = spawnSync("git", ["merge-base", "--is-ancestor", "prd/throwaway-x", "dev"]).status === 0;
  if (process.env.CI_FILE_LOG)
    appendFileSync(process.env.CI_FILE_LOG, JSON.stringify({ merged, push: process.argv.includes("--push"), keys: findings.map((f) => f.key) }) + "\\n");
  console.log(JSON.stringify({ filed: findings.map((f) => ({ key: f.key, id: "B-77", created: true })), removed: [], pushed: !(process.env.CI_FILE_UNPUSHED && process.argv.includes("--push")) }));
} else process.stdout.write(${JSON.stringify(JSON.stringify(items))});
`;

// The stub of GitHub's runs. $GH_CI_FIXTURE holds the verdicts already there
// (byCommit: sha → [{ id, tier, verdict }]), what a requested run returns
// (requested), and the tests dev fails in blame's narrowed run (devFails).
const GH_CI = `import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const fixture = JSON.parse(readFileSync(process.env.GH_CI_FIXTURE, "utf8"));
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const [cmd, sub, ...rest] = process.argv.slice(2);
const flag = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : null);
const row = (id, headSha, headBranch) => ({ databaseId: id, headSha, headBranch, status: "completed", conclusion: "success",
  createdAt: "2026-01-01T00:00:00Z", url: "https://example.test/run/" + id, workflowName: "CI", attempt: 1 });
if (cmd === "api") console.log("{}");
else if (sub === "view") console.log(JSON.stringify({ status: "completed", conclusion: "success", url: "https://example.test/run", attempt: 1 }));
else if (sub === "list") {
  const commit = flag("--commit"), ref = flag("--branch");
  if (commit) console.log(JSON.stringify((fixture.byCommit[commit] ?? []).map((r) => row(r.id, commit, "ci/" + r.tier + "/x"))));
  else {
    const sha = git("ls-remote", "origin", "refs/heads/" + ref).split(/\\s+/)[0];
    const id = ref.includes("dev-narrowed") ? 900 : 902;
    if (sha) writeFileSync(process.env.GH_CI_FIXTURE + "." + id, sha);
    console.log(JSON.stringify(sha ? [row(id, sha, ref)] : []));
  }
} else if (sub === "download") {
  const id = Number(rest[0]);
  let verdict = Object.values(fixture.byCommit).flat().find((r) => r.id === id)?.verdict;
  if (id === 902 && fixture.requested) verdict = { ...fixture.requested, commit: readFileSync(process.env.GH_CI_FIXTURE + ".902", "utf8") };
  if (id === 900) {
    const sha = readFileSync(process.env.GH_CI_FIXTURE + ".900", "utf8");
    const { target, files } = JSON.parse(git("show", sha + ":.ci-narrowed.json"));
    const tests = fixture.devFails ?? [];
    verdict = { version: 1, commit: sha, target, narrowed: true, narrowedFiles: files, runId: "900", tier: "unit", ranTier: "unit",
      kind: tests.length ? "file" : "green", quarantineList: [], flaky: [], brake: { jobs: [], tests: [], files: [] },
      failed: { tests, files: [...new Set(tests.map((t) => t.file))], jobs: tests.length ? ["unit"] : [], unnamedJobs: [] } };
  }
  if (!verdict) process.exit(1);
  writeFileSync(join(flag("--dir"), "verdict.json"), JSON.stringify(verdict));
}
`;

const landWith = (extra, ...args) =>
  spawnSync("bash", ["scripts/loops/land.sh", "throwaway-x", "-m", "docs(throwaway-x): t", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      CARETOOK_PR_THROWAWAY: "1",
      PR_HEAD: git("rev-parse", "prd/throwaway-x"),
      ...extra,
    },
  });
const land = (...args) => landWith({}, ...args);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "land-")));
  repo = join(root, "repo");
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "gh"), GH);
  chmodSync(join(root, "bin", "gh"), 0o755);
  execFileSync("git", ["init", "-q", "--bare", "-b", "dev", join(root, "origin.git")]);
  execFileSync("git", ["init", "-q", "-b", "dev", repo]);
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "core.hooksPath", "/dev/null");
  git("remote", "add", "origin", join(root, "origin.git"));
  mkdirSync(join(repo, "scripts"), { recursive: true });
  for (const dir of ["loops", "ci"])
    cpSync(join(HERE, "..", dir), join(repo, "scripts", dir), {
      recursive: true,
      filter: (src) => !src.endsWith(".test.mjs"),
    });
  // A stubbed backlog: what `backlog list --prd throwaway-x --json` would print.
  const items = [
    { id: "B-1", type: "feature", status: "ready", title: "A throwaway feature" },
    { id: "B-2", type: "bug", status: "triaged", title: "A follow-up bug" },
    { id: "B-3", type: "feature", status: "landed", title: "An earlier wave" },
  ];
  commit(
    {
      "apps/web/a.ts": "1",
      "README.md": "r",
      "scripts/backlog/backlog.mjs": BACKLOG(items),
    },
    "base",
  );
  git("push", "-q", "origin", "dev");
  git("checkout", "-qb", "feature");
  git("checkout", "-q", "dev");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const branch = (files) => {
  git("checkout", "-qb", "prd/throwaway-x");
  commit(files, "work");
  git("checkout", "-q", "dev");
};

describe("docs_only", () => {
  const onFeature = (files) => {
    git("checkout", "-q", "feature");
    commit(files, "t");
  };
  it("is true when only Markdown changes, anywhere", () => {
    onFeature({ "docs/x.md": "d", "plans/p.md": "p", "AGENTS.md": "a" });
    expect(docsOnly()).toBe(true);
  });
  it("is false with one .mjs or .sh file among the Markdown", () => {
    onFeature({ "docs/x.md": "d", "scripts/loops/t.mjs": "x" });
    expect(docsOnly()).toBe(false);
    git("reset", "-q", "--hard", "dev");
    onFeature({ "docs/x.md": "d", "scripts/loops/t.sh": "x" });
    expect(docsOnly()).toBe(false);
  });
  it("is false when a code file is renamed to .md, true for a Markdown rename", () => {
    git("checkout", "-q", "feature");
    git("mv", "apps/web/a.ts", "apps/web/a.md");
    git("commit", "-qm", "rename code");
    expect(docsOnly()).toBe(false);
    git("reset", "-q", "--hard", "dev");
    git("mv", "README.md", "NOTES.md");
    git("commit", "-qm", "rename docs");
    expect(docsOnly()).toBe(true);
  });
  it("is false for an empty diff", () => {
    git("checkout", "-q", "feature");
    expect(docsOnly()).toBe(false);
  });
});

describe("CI's two lists on dev", () => {
  const LISTS = ["scripts/ci/quarantine.txt", "scripts/ci/brake-list.txt"];
  const lib = (/** @type {string} */ body) =>
    spawnSync("bash", ["-c", `source scripts/loops/lib.sh && ${body}`], { cwd: repo, encoding: "utf8" });

  it.each(LISTS)("a dev commit changing only %s is not drift", (list) => {
    branch({ "apps/web/b.ts": "2" });
    commit({ [list]: "a line\n" }, "chore(backlog): filed from CI");
    expect(lib("trunk_drift prd/throwaway-x").stdout).toBe("");
    commit({ "apps/web/a.ts": "changed" }, "real work");
    expect(lib("trunk_drift prd/throwaway-x").stdout.trim()).toBe("apps/web/a.ts");
  });

  it.each(LISTS)("a commit changing only %s keeps a recorded pass", (list) => {
    git("checkout", "-qb", "prd/throwaway-x");
    commit({ "apps/web/b.ts": "2" }, "work");
    const checked = git("rev-parse", "HEAD");
    writeFileSync(join(git("rev-parse", "--absolute-git-dir"), "caretook-checked"), `${checked} full\n`);
    commit({ [list]: "a line\n" }, "chore(ci): the list");
    expect(lib("checked_ok . prd/throwaway-x").status).toBe(0);
    expect(lib("checked_how . prd/throwaway-x").stdout).toContain(`full on ${checked.slice(0, 7)}`);
    commit({ "apps/web/b.ts": "3" }, "more work");
    expect(lib("checked_ok . prd/throwaway-x").status).not.toBe(0);
  });

  it("a branch changing only a list still needs a check", () => {
    branch({ "scripts/ci/quarantine.txt": "a line\n" });
    expect(lib("checked_ok . prd/throwaway-x").status).not.toBe(0);
  });
});

describe("land.sh on the PR path", () => {
  it("lands a Markdown-only PR with no verdict, and says so", () => {
    branch({ "docs/x.md": "d" });
    const r = land();
    expect(r.stdout).toContain("no Codex verdict needed");
    expect(r.stdout).toContain("It would push");
    expect(r.status).toBe(0);
  });

  it("still refuses a code PR without a clean verdict", () => {
    branch({ "docs/x.md": "d", "scripts/loops/t.mjs": "x" });
    const r = land("--force");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Codex's verdict on PR #7 isn't clean/);
  });

  it("still needs the PR's head to be the local tip", () => {
    branch({ "docs/x.md": "d" });
    const r = spawnSync("bash", ["scripts/loops/land.sh", "throwaway-x"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        CARETOOK_PR_THROWAWAY: "1",
        PR_HEAD: "0".repeat(40),
      },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("local tip");
  });

  // Codex finished clean on `sha`: its summary comment, as PR_COMMENTS.
  const reviewedClean = (sha) => ({
    PR_COMMENTS: JSON.stringify([
      {
        author: { login: "chatgpt-codex-connector" },
        body: `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: sha, status: "completed" } })} -->`,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]),
  });
  // A code branch Codex reviewed clean, then dev moved (another file) and the branch merged it.
  const reviewedThenSynced = () => {
    branch({ "apps/web/b.ts": "2" });
    const reviewed = git("rev-parse", "prd/throwaway-x");
    commit({ "apps/web/dev.ts": "dev moved" }, "dev work");
    git("push", "-q", "origin", "dev");
    git("checkout", "-q", "prd/throwaway-x");
    git("merge", "-q", "--no-ff", "-m", "chore(throwaway-x): merge dev", "dev");
    git("checkout", "-q", "dev");
    return reviewed;
  };

  it("lands on a clean verdict carried over a dev merge, pinned to the merged tip", () => {
    const reviewed = reviewedThenSynced();
    const tip = git("rev-parse", "prd/throwaway-x");
    const r = landWith(reviewedClean(reviewed), "--force");
    expect(r.stdout).toContain(`codex: clean on ${tip.slice(0, 7)} (carried from ${reviewed.slice(0, 7)}`);
    expect(r.stdout).toContain(`--match-head-commit ${tip}`);
    expect(r.status).toBe(0);
  });

  it("refuses a stale verdict when the branch added work after the dev merge", () => {
    const reviewed = reviewedThenSynced();
    git("checkout", "-q", "prd/throwaway-x");
    commit({ "apps/web/b.ts": "3" }, "more work");
    git("checkout", "-q", "dev");
    const r = landWith(reviewedClean(reviewed), "--force");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(
      /Codex's verdict on PR #7 isn't clean \(codex: stale .*not carried: .* isn't a merge of/,
    );
  });
});

// The real merge: the stubbed `gh pr merge` pushes the branch to origin/dev (or
// fails), so land.sh runs its whole PR path in the temporary main checkout.
// The gate, through the real ci.mjs against the stubbed runs: a real merge, so
// "filed after the merge" and "nothing landed" are what git says.
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
        ...(args.includes("--local") ? [] : ["--no-review"]),
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
    expect(r.stderr).toMatch(/then file the flakes: `pnpm prd ci file prd\/throwaway-x --base \w+ --run 11`/);
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

describe("land.sh writes a to-test file", () => {
  const landFor = (mergeFails = false) =>
    spawnSync(
      "bash",
      ["scripts/loops/land.sh", "throwaway-x", "-m", "feat(throwaway-x): t (B-1)", "--force", "--no-review"],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          PR_HEAD: git("rev-parse", "prd/throwaway-x"),
          GH_MERGE_FAIL: mergeFails ? "1" : "",
        },
      },
    );
  const files = () => (existsSync(join(repo, "to-test")) ? readdirSync(join(repo, "to-test")) : []);

  it("writes one file with its parts after a code landing", () => {
    branch({ "apps/web/b.ts": "2", "plans/throwaway-x-prd.md": "# PRD: Throwaway (a test topic)\n" });
    const r = landFor();
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(files()).toHaveLength(1);
    expect(files()[0]).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-throwaway-x\.md$/);
    const text = readFileSync(join(repo, "to-test", files()[0]), "utf8");
    for (const part of [
      "# Landed: Throwaway (a test topic)",
      "feat(throwaway-x): t (B-1)",
      "- B-1 A throwaway feature",
      "- work (`",
      "https://example.test/pr/7",
      "## What landed",
      "## What to try, and where",
      "http://localhost:5173",
      "apps/web/b.ts",
      "the check was skipped (--force)",
      "merged without a clean Codex verdict (--no-review)",
      "## Follow-ups and still open",
      "- B-2 A follow-up bug",
    ])
      expect(text).toContain(part);
    expect(text).not.toContain("An earlier wave");
    expect(text).toContain(git("rev-parse", "--short", "dev"));
  });

  it("writes none after a docs-only landing", () => {
    branch({ "docs/x.md": "d" });
    const r = landFor();
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(files()).toEqual([]);
  });

  it("writes one after a local hotfix landing too, naming the local merge", () => {
    git("checkout", "-qb", "hotfix/throwaway-y");
    commit({ "apps/web/c.ts": "3" }, "fix it");
    git("checkout", "-q", "dev");
    const r = spawnSync(
      "bash",
      ["scripts/loops/land.sh", "hotfix/throwaway-y", "--local", "--force", "-m", "fix(web): c"],
      { cwd: repo, encoding: "utf8" },
    );
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(files()).toHaveLength(1);
    expect(files()[0]).toMatch(/-throwaway-y\.md$/);
    const text = readFileSync(join(repo, "to-test", files()[0]), "utf8");
    expect(text).toContain("# Landed: throwaway-y");
    expect(text).toContain("landed locally: no PR and no Codex review");
    expect(text).toContain(`as \`${git("rev-parse", "--short", "dev")}\``);
    expect(text).toContain("- fix it (`");
  });

  it("writes none when the merge fails", () => {
    branch({ "apps/web/b.ts": "2" });
    const r = landFor(true);
    expect(r.status).not.toBe(0);
    expect(files()).toEqual([]);
  });
});

describe("land.sh posts a landing notice", () => {
  const board = () => join(root, "notices");
  const notices = () =>
    existsSync(board())
      ? readdirSync(board())
          .filter((f) => /^n\d+\.json$/.test(f))
          .map((f) => JSON.parse(readFileSync(join(board(), f), "utf8")))
      : [];
  const landFor = (args, extra = {}) =>
    spawnSync("bash", ["scripts/loops/land.sh", ...args], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        PR_HEAD: spawnSync("git", ["-C", repo, "rev-parse", "prd/throwaway-x"], {
          encoding: "utf8",
        }).stdout.trim(),
        CARETOOK_NOTICES_DIR: board(),
        ...extra,
      },
    });
  const prdLand = (extra) =>
    landFor(["throwaway-x", "-m", "feat(throwaway-x): t (B-1)", "--force", "--no-review"], extra);

  it("posts one for a code landing, with the topic and the commit, for six hours", () => {
    branch({ "apps/web/b.ts": "2" });
    const r = prdLand();
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const [n, ...more] = notices();
    expect(more).toEqual([]);
    expect(n).toMatchObject({ session: "prd-throwaway-x", topic: "throwaway-x" });
    expect(n.text).toContain(`landed prd/throwaway-x in dev as ${git("rev-parse", "--short", "origin/dev")}`);
    expect(n.text).toContain("sync at your next wave boundary");
    expect(Date.parse(n.expiresAt) - Date.parse(n.postedAt)).toBe(6 * 3600_000);
    expect(r.stdout).toContain("notice posted");
  });

  it("posts one for a local hotfix landing too", () => {
    git("checkout", "-qb", "hotfix/throwaway-y");
    commit({ "apps/web/c.ts": "3" }, "fix it");
    git("checkout", "-q", "dev");
    const r = landFor(["hotfix/throwaway-y", "--local", "--force", "-m", "fix(web): c"]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(notices()).toMatchObject([{ session: "hotfix-throwaway-y", topic: "throwaway-y" }]);
    expect(notices()[0].text).toContain(`as ${git("rev-parse", "--short", "dev")}`);
  });

  it("posts none for a Markdown-only landing or a plan/ landing", () => {
    branch({ "docs/x.md": "d" });
    expect(prdLand().status).toBe(0);
    git("checkout", "-qb", "plan/throwaway-z");
    commit({ "plans/throwaway-z-plan.md": "p", "scripts/loops/z.sh": "z" }, "plan it");
    git("checkout", "-q", "dev");
    const r = landFor(["plan/throwaway-z", "-m", "docs(throwaway-z): plan"]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(notices()).toEqual([]);
  });

  it("still lands when the notice can't be posted", () => {
    branch({ "apps/web/b.ts": "2" });
    writeFileSync(join(root, "not-a-dir"), "x");
    const r = prdLand({ CARETOOK_NOTICES_DIR: join(root, "not-a-dir", "notices") });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain("Landed prd/throwaway-x");
    expect(r.stderr).toContain("couldn't post the landing notice");
  });
});

// The unsynced landing: dev moved on files the branch doesn't touch. A stub
// `pnpm` logs its steps, and the seam stops the PR path before the merge.
describe("land.sh on an unsynced tip", () => {
  const OWN = "scripts/loops/own.sh";
  const wt = () => join(repo, ".loops", "throwaway-x");
  const inWt = (...a) => execFileSync("git", ["-C", wt(), ...a], { encoding: "utf8", stdio: "pipe" }).trim();
  const steps = () =>
    existsSync(join(root, "pnpm.log")) ? readFileSync(join(root, "pnpm.log"), "utf8").trim().split("\n") : [];
  const env = () => ({
    GH_CI: join(root, "gh-ci.mjs"),
    GH_CI_FIXTURE: join(root, "fixture.json"),
    CARETOOK_CI_POLL: "0",
    CARETOOK_LEASE_ROOT: join(root, "leases"),
    CARETOOK_LEASE_POLL: "1",
    CARETOOK_NOTICES_DIR: join(root, "notices"),
    CARETOOK_LOAD_GATE: "off",
    PNPM_LOG: join(root, "pnpm.log"),
  });
  const go = (extra = {}, ...args) => landWith({ ...env(), ...extra }, "--no-review", ...args);
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

  it("keeps the drift refusal with --fixes, with --force, and with CARETOOK_UNSYNCED=off", () => {
    started();
    toDev({ "apps/web/dev.ts": "d" });
    const refused = [go({}, "--fixes", "B-9"), go({}, "--force"), go({ CARETOOK_UNSYNCED: "off" })];
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

    it("lands when GitHub can't be reached", () => {
      drifted();
      landed(go({ GH_CI: join(root, "no-such-stub.mjs") }));
    });

    it("lands on an unreadable board, and says so", () => {
      drifted();
      writeFileSync(join(root, "a-file"), "x");
      const r = go({ CARETOOK_NOTICES_DIR: join(root, "a-file", "notices") });
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
      ["scripts/loops/land.sh", "throwaway-x", "-m", "docs(throwaway-x): t", "--no-review"],
      {
        cwd: repo,
        stdio: "ignore",
        env: {
          ...process.env,
          ...env(),
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          CARETOOK_PR_THROWAWAY: "1",
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
    const r = spawnSync("bash", [join(wt(), "scripts/loops/prd.sh"), "sync"], {
      cwd: wt(),
      encoding: "utf8",
      env: { ...process.env, ...env() },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("aborted a temporary merge");
    expect(r.stdout).toContain("Merged dev into prd/throwaway-x");
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
