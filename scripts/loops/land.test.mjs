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
// and Codex has said nothing ("waiting").
const GH = `#!/usr/bin/env bash
case "$1 $2" in
  "repo view") echo o/r ;;
  "pr list") echo 7 ;;
  "pr merge") [[ -z "$GH_MERGE_FAIL" ]] || { echo "merge refused" >&2; exit 1; }; git push -q origin prd/throwaway-x:dev ;;
  "api graphql") printf '{"data":{"repository":{"pullRequest":{"number":7,"url":"https://example.test/pr/7","state":"OPEN","headRefName":"prd/throwaway-x","headRefOid":"%s","reviews":{"nodes":[]},"reviewThreads":{"nodes":[]},"comments":{"nodes":[]},"reactions":{"nodes":[]}}}}}' "$PR_HEAD" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`;

const land = (...args) =>
  spawnSync("bash", ["scripts/loops/land.sh", "throwaway-x", "-m", "docs(throwaway-x): t", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      CARETOOK_PR_THROWAWAY: "1",
      PR_HEAD: git("rev-parse", "prd/throwaway-x"),
    },
  });

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
  commit({ "apps/web/a.ts": "1", "README.md": "r" }, "base");
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
});

// The real merge: the stubbed `gh pr merge` pushes the branch to origin/dev (or
// fails), so land.sh runs its whole PR path in the temporary main checkout.
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
    branch({ "apps/web/b.ts": "2" });
    const r = landFor();
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(files()).toHaveLength(1);
    expect(files()[0]).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-throwaway-x\.md$/);
    const text = readFileSync(join(repo, "to-test", files()[0]), "utf8");
    for (const part of [
      "# Landed: throwaway-x",
      "feat(throwaway-x): t (B-1)",
      "https://example.test/pr/7",
      "## What landed",
      "## What to try, and where",
      "http://localhost:5173",
      "apps/web/b.ts",
      "the check was skipped (--force)",
      "merged without a clean Codex verdict (--no-review)",
      "## Follow-ups and still open",
    ])
      expect(text).toContain(part);
    expect(text).toContain(git("rev-parse", "--short", "dev"));
  });

  it("writes none after a docs-only landing", () => {
    branch({ "docs/x.md": "d" });
    const r = landFor();
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(files()).toEqual([]);
  });

  it("writes none when the merge fails", () => {
    branch({ "apps/web/b.ts": "2" });
    const r = landFor(true);
    expect(r.status).not.toBe(0);
    expect(files()).toEqual([]);
  });
});
