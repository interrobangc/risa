// The backlog CLI end to end, against a throwaway repo: a "main checkout" on
// dev plus a prd/ worktree, like the real layout.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI = new URL("./backlog.mjs", import.meta.url).pathname;
const run = promisify(execFile);
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();
const env = { ...process.env, BACKLOG_BY: "", GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test" };
const cli = (cwd, ...a) => execFileSync("node", [CLI, ...a], { cwd, encoding: "utf8", env }).trim();
const cliFails = (cwd, ...a) => {
  try {
    execFileSync("node", [CLI, ...a], { cwd, encoding: "utf8", env, stdio: "pipe" });
  } catch (e) {
    return String(e.stderr);
  }
  throw new Error("expected the command to fail");
};

let root, main, prd;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "backlog-test-")));
  main = join(root, "repo");
  prd = join(root, "prd-x");
  execFileSync("git", ["init", "-q", "-b", "dev", main]);
  git(main, "config", "user.email", "test@example.com");
  git(main, "config", "user.name", "Test");
  git(main, "config", "commit.gpgsign", "false");
  execFileSync("mkdir", ["-p", join(main, "plans")]);
  writeFileSync(join(main, "plans/backlog.md"), "# Backlog\n\n## Items\n");
  writeFileSync(join(main, "other.txt"), "x\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  git(main, "worktree", "add", "-q", "-b", "prd/x", prd);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const file = () => readFileSync(join(main, "plans/backlog.md"), "utf8");
const lastFiles = () => git(main, "show", "--name-only", "--format=", "HEAD");

describe("backlog CLI", () => {
  it("adds from a prd worktree straight onto dev in the main checkout, committing only backlog.md", () => {
    writeFileSync(join(main, "other.txt"), "staged work\n");
    git(main, "add", "other.txt");
    expect(cli(prd, "add", "bug", "Sign-in", "twice", "--prd", "quick-fixes")).toBe("added B-1");
    expect(file()).toContain("### B-1 · bug · Sign-in twice");
    expect(lastFiles()).toBe("plans/backlog.md");
    expect(git(main, "log", "-1", "--format=%s%n%b")).toBe("backlog: add B-1 (bug) Sign-in twice\nBy: prd/x");
    expect(git(main, "diff", "--cached", "--name-only")).toBe("other.txt"); // the dev keeper's staging is untouched
    git(main, "reset", "-q", "other.txt");
    git(main, "checkout", "-q", "other.txt");
    expect(git(prd, "status", "--porcelain")).toBe(""); // nothing lands on the prd branch
  });

  it("gives concurrent writers distinct ids", async () => {
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) => run("node", [CLI, "add", "feature", `Parallel ${n}`], { cwd: prd, env })),
    );
    const ids = [...file().matchAll(/^### (B-\d+)/gm)].map((m) => m[1]);
    expect(ids).toEqual(["B-1", "B-2", "B-3", "B-4", "B-5", "B-6"]);
    expect(git(main, "status", "--porcelain")).toBe("");
  });

  it("claims for the caller's branch, and the first claim wins", () => {
    expect(cli(prd, "claim", "B-2")).toBe("B-2 claimed by prd/x");
    expect(cliFails(main, "claim", "B-2", "--as", "prd/y")).toMatch(/already claimed by prd\/x/);
    expect(cliFails(main, "claim", "B-3")).toMatch(/claim from your prd/);
    expect(cli(prd, "show", "B-2")).toContain("status: in-progress");
  });

  it("notes and sets fields", () => {
    cli(prd, "note", "B-2", "found", "a", "thing");
    cli(main, "set", "B-3", "status=dropped", "title=Renamed");
    expect(file()).toMatch(/- \d{4}-\d\d-\d\d \(prd\/x\): found a thing/);
    expect(file()).toContain("### B-3 · feature · Renamed");
    expect(cliFails(main, "set", "B-3", "status=bogus")).toMatch(/status must be/);
  });

  it("derives ready → landed → staging → live from where the commit is", () => {
    writeFileSync(join(prd, "work.txt"), "w\n");
    git(prd, "add", "work.txt");
    git(prd, "commit", "-q", "-m", "work");
    cli(prd, "done", "B-2");
    expect(cli(main, "show", "B-2")).toMatch(/status: ready/);

    git(main, "merge", "-q", "--no-ff", "-m", "land prd/x", "prd/x");
    expect(cli(main, "show", "B-2")).toMatch(/status: landed \(file says ready\)/);
    git(main, "branch", "staging", "dev");
    expect(cli(main, "list")).toMatch(/B-2 +feature +staging/);
    git(main, "branch", "main", "dev");
    expect(cli(main, "list")).not.toMatch(/B-2/); // live items are hidden…
    expect(cli(main, "list", "--all")).toMatch(/B-2 +feature +live/); // …unless --all
    expect(cli(main, "refresh", "--no-fetch")).toBe("B-2 ready → live");
    expect(file()).toMatch(/### B-2[^\n]*\n\n- status: live/);
  });

  it("commits hand edits, normalised, and says so", () => {
    writeFileSync(
      join(main, "plans/backlog.md"),
      file().replace("bug · Sign-in twice", "bug · Sign-in twice (edited)"),
    );
    cli(main, "note", "B-5", "x");
    expect(git(main, "log", "-1", "--format=%b")).toContain("Includes uncommitted hand edits");
    expect(file()).toContain("### B-1 · bug · Sign-in twice (edited)");
    expect(git(main, "status", "--porcelain")).toBe("");
  });

  it("refuses when the main checkout isn't on dev", () => {
    git(main, "switch", "-q", "-c", "elsewhere");
    try {
      expect(cliFails(prd, "add", "bug", "x")).toMatch(/not dev/);
    } finally {
      git(main, "switch", "-q", "dev");
    }
  });
});
