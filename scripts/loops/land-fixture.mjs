// The throwaway repo land.sh's tests share (land*.test.mjs): these scripts
// copied in, a bare origin, a stubbed `gh` and backlog; the CARETOOK_PR_THROWAWAY
// seam stops land before the merge, so nothing is pushed. A test file calls
// useLandRepo() once; root and repo are each test's own.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach } from "vitest";

// For its RISA_CONFIG: the scripts land runs read this repo's config through it.
import "./config-fixture.mjs";

const HERE = new URL(".", import.meta.url).pathname;
export let root, repo;
export const git = (...a) =>
  execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
export const commit = (files, msg) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git("add", "-A");
  git("commit", "-qm", msg);
  return git("rev-parse", "HEAD");
};

// A `gh` that answers the three calls land.sh makes; the PR's head is $PR_HEAD
// and Codex has said nothing ("waiting"), unless $PR_COMMENTS holds its
// summary comment (a JSON array of comment nodes). A merge is logged to
// $GH_MERGE_LOG, and the PR's state (a resume's question) is $GH_PR_STATE, else
// MERGED once that log has a line, else OPEN.
const GH = `#!/usr/bin/env bash
case "$1 $2" in
  "repo view") echo o/r ;;
  "pr list") echo 7 ;;
  "pr merge") [[ -z "$GH_MERGE_FAIL" ]] || { echo "merge refused" >&2; exit 1; }; git push -q origin prd/throwaway-x:dev; [[ -z "$GH_MERGE_LOG" ]] || echo merged >> "$GH_MERGE_LOG"; [[ -z "$GH_BREAK_SYNC" ]] || touch "$(git rev-parse --absolute-git-dir)/REVERT_HEAD" ;;
  "pr edit") while (($#)); do [[ $1 != --body ]] || printf '%s' "$2" > "$GH_PR_BODY"; shift; done ;;
  "pr view") if [[ " $* " != *" state "* ]]; then echo https://example.test/pr/7
    elif [[ -n "$GH_PR_STATE" ]]; then echo "$GH_PR_STATE"
    elif [[ -n "$GH_MERGE_LOG" && -s "$GH_MERGE_LOG" ]]; then echo MERGED; else echo OPEN; fi ;;
  "run list" | "run view" | "run download" | "api -X") exec node "$GH_CI" "$@" ;;
  "api graphql") printf '{"data":{"repository":{"pullRequest":{"number":7,"url":"https://example.test/pr/7","state":"OPEN","headRefName":"prd/throwaway-x","headRefOid":"%s","reviews":{"nodes":[]},"reviewThreads":{"nodes":[]},"comments":{"nodes":%s},"reactions":{"nodes":[]}}}}}' "$PR_HEAD" "\${PR_COMMENTS:-[]}" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`;

// The stub backlog: `list` prints the items, deriving an item's status as the real
// one does (ready, then landed once dev holds its commit; here its commitRef);
// `ci-file` logs what it was given and whether the branch was already in dev, and
// files everything as B-77.
const BACKLOG = (items) => `import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
if (process.argv[2] === "ci-file") {
  if (process.env.CI_FILE_FAIL) process.exit(1);
  const { findings } = JSON.parse(readFileSync(0, "utf8"));
  const merged = spawnSync("git", ["merge-base", "--is-ancestor", "prd/throwaway-x", "dev"]).status === 0;
  if (process.env.CI_FILE_LOG)
    appendFileSync(process.env.CI_FILE_LOG, JSON.stringify({ merged, push: process.argv.includes("--push"), keys: findings.map((f) => f.key) }) + "\\n");
  console.log(JSON.stringify({ filed: findings.map((f) => ({ key: f.key, id: "B-77", created: true })), removed: [], pushed: !(process.env.CI_FILE_UNPUSHED && process.argv.includes("--push")) }));
} else {
  const items = ${JSON.stringify(items)};
  const inDev = (ref) => spawnSync("git", ["merge-base", "--is-ancestor", ref, "dev"]).status === 0;
  for (const it of items) if (it.commitRef && inDev(it.commitRef)) it.status = "landed";
  process.stdout.write(JSON.stringify(items));
}
`;

// The stub of GitHub's runs. $GH_CI_FIXTURE holds the verdicts already there
// (byCommit: sha → [{ id, tier, verdict }]), what a requested run returns
// (requested), and the tests dev fails in blame's narrowed run (devFails).
export const GH_CI = `import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const fixture = JSON.parse(readFileSync(process.env.GH_CI_FIXTURE, "utf8"));
export const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
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

export const landWith = (extra, ...args) =>
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
export const land = (...args) => landWith({}, ...args);

/** Each test's throwaway repo: call once at the top of a test file. */
export function useLandRepo() {
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "land-")));
    repo = join(root, "repo");
    // The run log outside the throwaway repo, whose .loops/ isn't ignored: a log
    // there would be committed by a test's `git add -A`.
    process.env.CARETOOK_RUN_LOG = join(root, "run-log.jsonl");
    // The landing journal outside it too, for the same reason.
    process.env.CARETOOK_LANDING_DIR = join(root, "landing");
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
    for (const dir of ["loops", "ci", "project"])
      cpSync(join(HERE, "..", dir), join(repo, "scripts", dir), {
        recursive: true,
        filter: (src) => !src.endsWith(".test.mjs"),
      });
    // A stubbed backlog: what `backlog list --prd throwaway-x --json` would print.
    const items = [
      {
        id: "B-1",
        type: "feature",
        status: "ready",
        title: "A throwaway feature",
        commitRef: "prd/throwaway-x",
      },
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
}

export const branch = (files) => {
  git("checkout", "-qb", "prd/throwaway-x");
  commit(files, "work");
  git("checkout", "-q", "dev");
};
