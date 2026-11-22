// docs_only (lib.sh) and the PR path of land.sh: a Markdown-only prd/ diff
// lands with no Codex verdict, a code diff still needs one. A throwaway repo
// with these scripts copied in, a bare origin, and a stubbed `gh`; the
// CARETOOK_PR_THROWAWAY seam stops land before the merge, so nothing is pushed.
import { execFileSync, spawnSync } from "node:child_process";
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
  "pr merge") [[ -z "$GH_MERGE_FAIL" ]] || { echo "merge refused" >&2; exit 1; }; git push -q origin prd/throwaway-x:dev ;;
  "api graphql") printf '{"data":{"repository":{"pullRequest":{"number":7,"url":"https://example.test/pr/7","state":"OPEN","headRefName":"prd/throwaway-x","headRefOid":"%s","reviews":{"nodes":[]},"reviewThreads":{"nodes":[]},"comments":{"nodes":%s},"reactions":{"nodes":[]}}}}}' "$PR_HEAD" "\${PR_COMMENTS:-[]}" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
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
  cpSync(join(HERE), join(repo, "scripts/loops"), {
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
      "scripts/backlog/backlog.mjs": `process.stdout.write(${JSON.stringify(JSON.stringify(items))});\n`,
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
  it("is false for an empty diff", () => {
    git("checkout", "-q", "feature");
    expect(docsOnly()).toBe(false);
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
// --recheck: the branch's worktree in .loops, a check record written by hand
// (as `pnpm prd check` writes it), and a stub `pnpm` (CARETOOK_PNPM_BIN) that
// logs its arguments and records a pass, or fails: no real check runs.
describe("land.sh --recheck", () => {
  const PNPM = `#!/usr/bin/env bash
echo "$PWD $*" >> "$PNPM_LOG"
[[ -z "$RECHECK_FAIL" ]] || { echo "check failed" >&2; exit 1; }
if [[ " $* " == *" --quick "* ]]; then mode="quick $(git merge-base dev HEAD) x"; else mode=full; fi
echo "$(git rev-parse HEAD) $mode" > "$(git rev-parse --absolute-git-dir)/caretook-checked"
`;
  const log = () => (existsSync(join(root, "pnpm.log")) ? readFileSync(join(root, "pnpm.log"), "utf8") : "");
  const wt = () => join(repo, ".loops", "throwaway-x");
  const record = (dir, line) =>
    writeFileSync(
      join(
        execFileSync("git", ["-C", dir, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim(),
        "caretook-checked",
      ),
      `${line}\n`,
    );
  // A prd/ branch whose last check passed on an earlier commit, then a code
  // commit on top: a stale tip.
  const stale = (files = { "apps/web/b.ts": "3" }) => {
    git("checkout", "-qb", "prd/throwaway-x");
    commit({ "apps/web/b.ts": "2" }, "work");
    const checked = git("rev-parse", "HEAD");
    commit(files, "more work");
    git("checkout", "-q", "dev");
    git("worktree", "add", "-q", wt(), "prd/throwaway-x");
    record(wt(), `${checked} full`);
  };
  const env = (extra = {}) => ({
    ...process.env,
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    CARETOOK_PNPM_BIN: join(root, "bin", "stub-pnpm"),
    PNPM_LOG: join(root, "pnpm.log"),
    ...extra,
  });
  // The PR path stops at the throwaway seam; "It would push" means every
  // refusal passed and it reached the merge.
  const landPr = (args, extra = {}) =>
    spawnSync("bash", ["scripts/loops/land.sh", "throwaway-x", "-m", "feat(throwaway-x): t", ...args], {
      cwd: repo,
      encoding: "utf8",
      env: env({ CARETOOK_PR_THROWAWAY: "1", PR_HEAD: git("rev-parse", "prd/throwaway-x"), ...extra }),
    });
  beforeEach(() => {
    writeFileSync(join(root, "bin", "stub-pnpm"), PNPM);
    chmodSync(join(root, "bin", "stub-pnpm"), 0o755);
    writeFileSync(join(repo, ".git", "info", "exclude"), ".loops/\nto-test/\n");
  });

  it("refuses a stale tip without it, naming --recheck and not --force", () => {
    stale();
    const r = landPr([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('--recheck "<why>"');
    expect(r.stderr).not.toContain("--force");
    expect(log()).toBe("");
  });

  it("rechecks a stale tip in the worktree (quick) and reaches the merge, but stops at Codex first", () => {
    stale();
    let r = landPr(["--recheck", "tip moved after the sync"]);
    // Codex hasn't spoken: that refusal stands, before any check runs.
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Codex's verdict on PR #7 isn't clean/);
    expect(log()).toBe("");
    r = landPr(["--recheck", "tip moved after the sync", "--no-review"]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain("tip moved after the sync");
    expect(r.stdout).toContain("It would push");
    expect(log().trim()).toBe(`${wt()} prd check --quick recheck at landing: tip moved after the sync`);
    expect(r.stdout).toMatch(/check: quick on \w+ \(x\), rechecked at landing: tip moved after the sync/);
  });

  it("runs the full check when the plan says full (a migration)", () => {
    stale({ "packages/data/src/db/migrations/0001_x.sql": "select 1;" });
    const r = landPr(["--recheck", "stale", "--no-review"]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain("a migration changed");
    expect(log().trim()).toBe(`${wt()} prd check`);
    expect(r.stdout).toContain("check: full on");
  });

  it("refuses and merges nothing when the recheck fails", () => {
    stale();
    const r = landPr(["--recheck", "stale", "--no-review"], { RECHECK_FAIL: "1" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("the recheck failed");
    expect(r.stdout).not.toContain("It would push");
    expect(log()).not.toBe("");
  });

  it("runs no check when the gate already accepts the tip", () => {
    stale();
    record(wt(), `${git("rev-parse", "prd/throwaway-x")} full`);
    const r = landPr(["--recheck", "stale", "--no-review"]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain("the gate already accepts the tip");
    expect(log()).toBe("");
  });

  it("needs a reason", () => {
    stale();
    for (const args of [["--recheck"], ["--recheck", "--no-review"]]) {
      const r = landPr(args);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("--recheck needs a reason");
    }
    expect(log()).toBe("");
  });

  it("still refuses a branch that isn't synced with dev", () => {
    stale();
    commit({ "apps/web/a.ts": "dev moved" }, "dev work");
    git("push", "-q", "origin", "dev");
    const r = landPr(["--recheck", "stale", "--no-review"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("pnpm prd sync");
    expect(log()).toBe("");
  });

  it("refuses a hotfix with no worktree", () => {
    git("checkout", "-qb", "hotfix/throwaway-y");
    commit({ "apps/web/c.ts": "3" }, "fix it");
    git("checkout", "-q", "dev");
    const r = spawnSync(
      "bash",
      ["scripts/loops/land.sh", "hotfix/throwaway-y", "--local", "--recheck", "stale", "-m", "fix(web): c"],
      { cwd: repo, encoding: "utf8", env: env() },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("it has none");
    expect(log()).toBe("");
    expect(git("log", "-1", "--format=%s", "dev")).toBe("base");
  });

  it("says in the landing report that the tip was rechecked, and why", () => {
    stale();
    const r = spawnSync(
      "bash",
      [
        "scripts/loops/land.sh",
        "throwaway-x",
        "-m",
        "feat(throwaway-x): t",
        "--recheck",
        "the tip moved",
        "--no-review",
      ],
      { cwd: repo, encoding: "utf8", env: env({ PR_HEAD: git("rev-parse", "prd/throwaway-x") }) },
    );
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const files = readdirSync(join(repo, "to-test"));
    expect(files).toHaveLength(1);
    const text = readFileSync(join(repo, "to-test", files[0]), "utf8");
    expect(text).toContain("the last check was stale; the tip was rechecked at landing (the tip moved)");
    expect(text).toContain("rechecked at landing: the tip moved");
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
