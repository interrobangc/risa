// The branch prefixes come from the config everywhere: the sample project names its
// kinds topic/, part/, draft/ and quick/ (not prd/, slice/, plan/, hotfix/), and
// the scripts that read a branch's kind honour them, in Node and in bash.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prdOf } from "./check-times.mjs";
import { worktreeKind } from "./dispatch-pick.mjs";
import { parentOf } from "./inventory-facts.mjs";
import { classify } from "./inventory.mjs";
import { branchKind } from "./metrics.mjs";
import { sessionOfBranch } from "./resume.mjs";
import { topicOfBranch } from "./run-log.mjs";
import { makeRepo, SAMPLE_CONFIG } from "./sample-project/repo.mjs";
import { protectedBranches } from "./tidy.mjs";

describe("the Node modules, on the sample project's prefixes", () => {
  const before = process.env.RISA_CONFIG;
  beforeAll(() => {
    process.env.RISA_CONFIG = SAMPLE_CONFIG;
  });
  afterAll(() => {
    if (before === undefined) delete process.env.RISA_CONFIG;
    else process.env.RISA_CONFIG = before;
  });

  it("reads a branch's kind and topic by the config's prefixes, not the built-in ones", () => {
    expect(["part/x/2", "topic/x", "draft/x", "quick/x", "slice/x/2", "prd/x"].map(topicOfBranch)).toEqual([
      "x",
      "x",
      "x",
      "x",
      "",
      "",
    ]);
    expect(["topic/x", "draft/x", "prd/x", "plan/x"].map(sessionOfBranch)).toEqual([
      "prd-x",
      "plan-x",
      null,
      null,
    ]);
    expect([worktreeKind("draft/x"), worktreeKind("plan/x")]).toEqual([{ kind: "plan", topic: "x" }, null]);
    expect(["quick/x", "part/x/1", "hotfix/x"].map(branchKind)).toEqual(["hotfix", "slice", "other"]);
    expect(prdOf({ branch: "part/x/1", worktree: "w" })).toBe("x");
    expect([parentOf("part/x/1"), parentOf("topic/x"), parentOf("slice/x/1")]).toEqual([
      "topic/x",
      "main",
      "main",
    ]);
    expect(classify({ branch: "topic/x" }).class).toBe("prd");
    expect(classify({ branch: "part/x/1", merged: true }).class).toBe("merged");
    expect(classify({ branch: "prd/x" }).why).toBe(
      "prd/x isn't a topic/, draft/ or part/ branch: nothing to bring back",
    );
    expect(protectedBranches()).toEqual(["main", "release"]);
  });
});

describe("the bash scripts, on the sample project's prefixes", () => {
  let root, main;
  const env = { ...process.env };
  delete env.RISA_CONFIG;
  const git = (cwd, ...a) =>
    execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
  const sh = (cwd, script, ...a) => {
    const r = spawnSync("bash", [join(main, "scripts/loops", script), ...a], { cwd, encoding: "utf8", env });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "prefixes-")));
    main = join(root, "main");
    makeRepo(main);
    git(main, "worktree", "add", "-q", "-b", "topic/x", join(main, ".loops/x"));
    git(main, "worktree", "add", "-q", "-b", "part/x/1", join(main, ".loops/x-1"), "topic/x");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("pr takes the PRD and hotfix kinds and refuses a draft by their prefixes", () => {
    expect(sh(main, "pr.sh", "draft/x")).toMatchObject({
      status: 1,
      out: expect.stringContaining("lands locally"),
    });
    expect(sh(main, "pr.sh", "prd/x").out).toContain("prd/x: pr takes a topic/ or quick/ branch");
  });

  it("rotate finds a PRD worktree, and refuses a slice's shell, by their prefixes", () => {
    expect(sh(main, "rotate.sh", "y").out).toContain("rotate: no PRD worktree for y");
    expect(sh(main, "rotate.sh", "y").out).toContain("on topic/y)");
    expect(sh(join(main, ".loops/x-1"), "rotate.sh", "--self").out).toContain("refused on a slice branch");
  });

  it("rm refuses a PRD worktree while its slice worktree is left", () => {
    expect(sh(main, "rm.sh", "x").out).toContain("slice worktree x-1 still exists");
  });

  it("slice_merged reads a slice by its prefix and finds it merged into its PRD branch", () => {
    const slice = join(main, ".loops/x-1");
    writeFileSync(join(slice, "a.txt"), "a\n");
    git(slice, "add", "a.txt");
    git(slice, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "feat: a");
    const merged = () =>
      spawnSync(
        "bash",
        ["-c", `source "${join(main, "scripts/loops/stack-lib.sh")}" && slice_merged "$1"`, "_", slice],
        {
          cwd: main,
          env,
        },
      ).status;
    expect(merged()).toBe(1);
    git(
      join(main, ".loops/x"),
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "merge",
      "-q",
      "--no-ff",
      "--no-verify",
      "-m",
      "m",
      "part/x/1",
    );
    expect(merged()).toBe(0);
  });
});
