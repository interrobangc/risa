// ready.sh: the "ready to land" report for a PRD branch. A synced branch with a
// clean worktree is ready (exit 0): its commits, the items it addresses and the
// PR line; a branch dev has moved past isn't (exit 1), and says to sync. The
// throwaway repo is land-fixture.mjs's, with a `gh` that knows no PR; no GitHub.
import { appendFileSync, chmodSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { root, repo, git, commit, branch, useLandRepo } from "./land-fixture.mjs";

useLandRepo();
const GH = `#!/usr/bin/env bash
case "$1 $2" in
  "repo view") echo o/r ;;
  "pr list") ;;
  "run list") echo "[]" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`;
beforeEach(() => {
  writeFileSync(join(root, "bin", "gh"), GH);
  chmodSync(join(root, "bin", "gh"), 0o755);
});

const ready = () =>
  spawnSync("bash", ["loops/ready.sh", "throwaway-x"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
  });
// The PRD's branch, checked out in its worktree (kept out of the repo's own commits).
const prd = (files) => {
  branch(files);
  appendFileSync(join(repo, ".git", "info", "exclude"), ".loops/\n");
  git("worktree", "add", "-q", join(repo, ".loops", "throwaway-x"), "prd/throwaway-x");
};

describe("ready.sh", () => {
  it("reports a synced branch with a clean worktree ready to land", () => {
    prd({ "web/b.ts": "2" });
    const r = ready();
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const tip = git("rev-parse", "--short", "prd/throwaway-x");
    expect(r.stdout).toContain("# prd/throwaway-x is ready to land");
    expect(r.stdout).toContain(
      `\`prd/throwaway-x\` at \`${tip}\`: 1 commit(s) ahead of \`dev\`, up to date with it.`,
    );
    expect(r.stdout).toContain("- no PR yet");
    expect(r.stdout).toMatch(/\*\*Features\*\*\n\n- B-1 A throwaway feature/);
    expect(r.stdout).toContain("- B-2 A follow-up bug (triaged)");
    expect(r.stdout).toContain(`- work (\`${tip}\`)`);
    expect(r.stdout).toContain('Say **"land throwaway-x"**');
  });

  it("refuses a branch dev has moved past: sync first", () => {
    prd({ "web/a.ts": "2" });
    commit({ "web/a.ts": "changed" }, "dev work");
    const r = ready();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("# prd/throwaway-x isn't ready to land yet");
    expect(r.stdout).toMatch(/- ✗ dev has newer work \(1 file\(s\) changed\): run `.*sync`/);
    expect(r.stdout).not.toContain("## To land it");
  });

  it("refuses with no worktree to confirm the checks", () => {
    branch({ "web/b.ts": "2" });
    const r = ready();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("- ✗ no worktree at");
  });
});

// The Codex line on an open PR (#7): Codex finished clean on $PR_REVIEWED (its
// summary comment) and the PR's head is $PR_HEAD. A docs-only commit after the
// approval keeps it clean (lib.sh's docs_re, as land.sh passes it); code doesn't.
describe("ready.sh's Codex line", () => {
  const GH_PR = `#!/usr/bin/env bash
case "$1 $2" in
  "repo view") echo o/r ;;
  "pr list") echo 7 ;;
  "run list") echo "[]" ;;
  "api graphql") state='{"code_review":{"commit_sha":"'"$PR_REVIEWED"'","status":"completed"}}'
    comment='{"author":{"login":"chatgpt-codex-connector"},"body":"<!-- codex-review-state:v1 '"\${state//\\"/\\\\\\"}"' -->","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}'
    printf '{"data":{"repository":{"pullRequest":{"number":7,"url":"https://example.test/pr/7","state":"OPEN","headRefName":"prd/throwaway-x","headRefOid":"%s","reviews":{"nodes":[]},"reviewThreads":{"nodes":[]},"comments":{"nodes":[%s]},"reactions":{"nodes":[]}}}}}' "$PR_HEAD" "$comment" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`;
  // prd/throwaway-x reviewed clean on its first commit, then `after` committed on it.
  const readyAfter = (after) => {
    git("checkout", "-qb", "prd/throwaway-x");
    const reviewed = commit({ "web/b.ts": "2" }, "work");
    const head = commit(after, "after the review");
    git("checkout", "-q", "dev");
    appendFileSync(join(repo, ".git", "info", "exclude"), ".loops/\n");
    git("worktree", "add", "-q", join(repo, ".loops", "throwaway-x"), "prd/throwaway-x");
    writeFileSync(join(root, "bin", "gh"), GH_PR);
    const r = spawnSync("bash", ["loops/ready.sh", "throwaway-x"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        PR_REVIEWED: reviewed,
        PR_HEAD: head,
      },
    });
    return { r, reviewed: reviewed.slice(0, 7), head: head.slice(0, 7) };
  };

  it("reads clean when only a .md file changed since Codex's approval", () => {
    const { r, reviewed, head } = readyAfter({ "plans/x-plan.md": "## Status\n\nwave 1 landed\n" });
    expect(r.stdout).toContain("- https://github.com/o/r/pull/7");
    expect(r.stdout).toContain(
      `- codex: clean on ${head} (approved on ${reviewed}: only docs changed since)`,
    );
  });

  it("isn't clean when a code file changed since", () => {
    const { r, reviewed, head } = readyAfter({ "web/c.ts": "3" });
    expect(r.stdout).toContain(`- codex: stale (last reviewed ${reviewed}, head ${head}; not carried: `);
    expect(r.stdout).not.toContain("codex: clean");
  });
});
