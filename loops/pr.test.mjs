// pr.sh: it pushes the branch and opens its PR into dev, or updates the open
// one, titled with the landing subject and listing the backlog items; it
// refuses a plan/ branch and a branch dev has moved past. The throwaway repo is
// land-fixture.mjs's (RISA_PR_THROWAWAY: dev is never pushed), with a `gh` that
// logs what pr.sh asks of it; no GitHub.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { root, repo, git, commit, branch, useLandRepo } from "./land-fixture.mjs";

useLandRepo();
// The open PR is $PR_NUMBER (none when empty); create and edit log their call to
// $GH_LOG and their --title and --body to $GH_LOG.title and $GH_LOG.body.
const GH = `#!/usr/bin/env bash
keep() { echo "$1 $2" >> "$GH_LOG"; while (($#)); do case $1 in --title) printf '%s' "$2" > "$GH_LOG.title" ;; --body) printf '%s' "$2" > "$GH_LOG.body" ;; esac; shift; done; }
case "$1 $2" in
  "repo view") echo o/r ;;
  "pr list") echo "$PR_NUMBER" ;;
  "pr create") keep "$@"; echo https://example.test/pr/8 ;;
  "pr edit") keep "$@" ;;
  "pr view") echo https://example.test/pr/7 ;;
  "run list") echo "[]" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`;
beforeEach(() => {
  writeFileSync(join(root, "bin", "gh"), GH);
  chmodSync(join(root, "bin", "gh"), 0o755);
});

const ghLog = () => join(root, "gh.log");
const read = (suffix = "") => (existsSync(ghLog() + suffix) ? readFileSync(ghLog() + suffix, "utf8") : "");
const pr = (env, ...args) =>
  spawnSync("bash", ["loops/pr.sh", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      RISA_PR_THROWAWAY: "1",
      GH_LOG: ghLog(),
      PR_NUMBER: "",
      ...env,
    },
  });
const onOrigin = (ref) => git("ls-remote", "origin", `refs/heads/${ref}`).split(/\s+/)[0];

describe("pr.sh", () => {
  it("pushes the branch and opens its PR into dev, titled with the landing subject", () => {
    branch({ "web/b.ts": "2" });
    const r = pr({}, "throwaway-x");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(onOrigin("prd/throwaway-x")).toBe(git("rev-parse", "prd/throwaway-x"));
    expect(r.stdout).toContain("opened https://example.test/pr/8");
    expect(read()).toBe("pr create\n");
    // The stub backlog ignores --status, so every item is named.
    expect(read(".title")).toMatch(/^feat\(throwaway-x\): land prd\/throwaway-x \(B-1\b/);
    const body = read(".body");
    expect(body).toContain("- B-1 (feature): A throwaway feature");
    expect(body).toMatch(/\*\*Tier:\*\* \w+ \(proposed /);
  });

  it("updates the open PR instead, with -m as its title", () => {
    branch({ "web/b.ts": "2" });
    const r = pr({ PR_NUMBER: "7" }, "throwaway-x", "-m", "fix(throwaway-x): a subject");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("updated PR #7: https://example.test/pr/7");
    expect(read()).toBe("pr edit\n");
    expect(read(".title")).toBe("fix(throwaway-x): a subject");
  });

  it("refuses a plan/ branch: it lands locally", () => {
    const r = pr({}, "plan/throwaway-x");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("lands locally");
    expect(read()).toBe("");
  });

  it("refuses a branch dev has moved past, and pushes nothing", () => {
    branch({ "web/a.ts": "2" });
    commit({ "web/a.ts": "changed" }, "dev work");
    git("push", "-q", "origin", "dev");
    const r = pr({}, "throwaway-x");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/has moved since prd\/throwaway-x last synced/);
    expect(onOrigin("prd/throwaway-x")).toBe("");
    expect(read()).toBe("");
  });
});
