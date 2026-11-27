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
