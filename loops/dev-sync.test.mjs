// dev-sync and the push of dev (lib.sh), against a throwaway main checkout and a
// bare origin. Nothing here reaches the real repository.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./config-fixture.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const INBOX = "plans/inbox.md";
const inbox = (bugs) => `# Inbox\n\n## Bugs\n\n${bugs.map((b) => `- ${b}\n`).join("")}\n## Chores\n`;
const TRAILER = "\n\nBacklog-Tool: ingest";

let root, repo, other;
const gitIn = (dir, ...a) =>
  execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
const git = (...a) => gitIn(repo, ...a);
const write = (dir, files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
};
const commitIn = (dir, files, msg) => {
  write(dir, files);
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-qm", msg);
  return gitIn(dir, "rev-parse", "HEAD");
};
/** A commit on origin/dev, made from a second clone. */
const remote = (files, msg = "chore: remote") => {
  gitIn(other, "pull", "-q", "origin", "dev");
  const sha = commitIn(other, files, msg);
  gitIn(other, "push", "-q", "origin", "dev");
  return sha;
};
const local = (files, msg = `chore(backlog): local${TRAILER}`) => commitIn(repo, files, msg);
const run = (fn) =>
  spawnSync("bash", ["-c", `source loops/lib.sh && ${fn}`], { cwd: repo, encoding: "utf8" });
const sync = () => run("dev_sync test");
const read = (path = INBOX) => readFileSync(join(repo, path), "utf8");
const committed = (path = INBOX) => git("show", `dev:${path}`);
const state = () => [git("rev-parse", "dev"), git("status", "--porcelain"), read()];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "dev-sync-")));
  repo = join(root, "repo");
  other = join(root, "other");
  execFileSync("git", ["init", "-q", "--bare", "-b", "dev", join(root, "origin.git")]);
  execFileSync("git", ["init", "-q", "-b", "dev", repo]);
  for (const [k, v] of [
    ["user.email", "t@example.com"],
    ["user.name", "T"],
    ["core.hooksPath", "/dev/null"],
  ])
    git("config", k, v);
  git("remote", "add", "origin", join(root, "origin.git"));
  for (const dir of ["loops", "backlog"])
    cpSync(join(HERE, "..", dir), join(repo, dir), {
      recursive: true,
      filter: (src) => !src.endsWith(".test.mjs"),
    });
  write(repo, { ".gitignore": "scripts/\n" });
  commitIn(repo, { [INBOX]: inbox(["First"]), "plans/backlog.md": "b\n", "a.txt": "a\n" }, "base");
  git("push", "-q", "origin", "dev");
  execFileSync("git", ["clone", "-q", "-b", "dev", join(root, "origin.git"), other]);
  gitIn(other, "config", "user.email", "t@example.com");
  gitIn(other, "config", "user.name", "T");
  gitIn(other, "config", "core.hooksPath", "/dev/null");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("dev-sync and the inbox", () => {
  it("keeps an uncommitted inbox line through a fast-forward that changes the inbox", () => {
    remote({ [INBOX]: inbox(["First", "Pushed"]) });
    write(repo, { [INBOX]: inbox(["First", "Typed here"]) });
    const r = sync();
    expect(r.status, r.stderr).toBe(0);
    expect(git("rev-parse", "dev")).toBe(git("rev-parse", "origin/dev"));
    expect(read()).toContain("- Pushed");
    expect(read()).toContain("- Typed here");
    expect(committed()).not.toContain("Typed here");
    expect(git("status", "--porcelain")).toBe(`M ${INBOX}`);
    expect(git("diff", "--cached", "--name-only")).toBe("");
  });

  it("keeps lines the user had staged, uncommitted", () => {
    remote({ [INBOX]: inbox(["First", "Pushed"]) });
    write(repo, { [INBOX]: inbox(["First", "Staged here"]) });
    git("add", INBOX);
    expect(sync().status).toBe(0);
    expect(read()).toContain("- Staged here");
    expect(read()).toContain("- Pushed");
    expect(committed()).not.toContain("Staged here");
  });

  it("leaves an uncommitted inbox alone when the update doesn't change it", () => {
    remote({ "b.txt": "b\n" });
    write(repo, { [INBOX]: inbox(["First", "Typed here"]) });
    expect(sync().status).toBe(0);
    expect(read()).toBe(inbox(["First", "Typed here"]));
  });

  it("resolves a local ingest commit against a remote line git can't merge", () => {
    remote({ [INBOX]: inbox(["First", "Pushed"]) });
    local({ [INBOX]: inbox(["First (B-1)"]) });
    const r = sync();
    expect(r.status, r.stderr).toBe(0);
    expect(committed()).toBe(inbox(["First (B-1)", "Pushed"]).trimEnd());
    expect(read().match(/\(B-1\)/g)).toHaveLength(1);
    expect(git("status", "--porcelain")).toBe("");
    expect(git("rev-list", "--parents", "-n", "1", "dev").split(" ")).toHaveLength(2);
  });

  it("resolves an inbox-only conflict in the merge of a commit of the user's", () => {
    remote({ [INBOX]: inbox(["First", "Pushed"]) });
    local({ [INBOX]: inbox(["First", "Mine"]), "a.txt": "mine\n" }, "feat: my own");
    const r = sync();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("merged origin/dev");
    expect(committed()).toContain("- Mine");
    expect(committed()).toContain("- Pushed");
    expect(committed("a.txt")).toBe("mine");
  });

  it("stops on a conflict in another file with nothing changed", () => {
    remote({ "a.txt": "theirs\n", [INBOX]: inbox(["First", "Pushed"]) });
    local({ "a.txt": "mine\n", [INBOX]: inbox(["First", "Mine"]) }, "feat: my own");
    write(repo, { [INBOX]: inbox(["First", "Mine", "Typed"]) });
    const before = state();
    const r = sync();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("conflict");
    expect(state()).toEqual(before);
  });

  it("refuses uncommitted edits to another file the update touches, inbox untouched", () => {
    remote({ "a.txt": "theirs\n", [INBOX]: inbox(["First", "Pushed"]) });
    write(repo, { "a.txt": "edited\n", [INBOX]: inbox(["First", "Typed"]) });
    const before = state();
    const r = sync();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("uncommitted changes");
    expect(state()).toEqual(before);
  });
});

describe("dev-sync's replay of backlog commits", () => {
  it("replays a backlog commit no other ref holds", () => {
    const mine = local({ "plans/backlog.md": "b\nmine\n" });
    remote({ "b.txt": "b\n" });
    const r = sync();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("rebased 1 backlog commit");
    expect(git("rev-parse", "dev^")).toBe(git("rev-parse", "origin/dev"));
    expect(git("rev-parse", "dev")).not.toBe(mine);
  });

  it("merges instead when a prd/ branch holds the commit, so it keeps its id", () => {
    const mine = local({ "plans/backlog.md": "b\nmine\n" });
    git("branch", "prd/throwaway", mine);
    remote({ "b.txt": "b\n" });
    const r = sync();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("merged origin/dev");
    expect(git("rev-parse", "dev^1")).toBe(mine);
    expect(git("merge-base", "--is-ancestor", mine, "dev")).toBe("");
  });

  it("merges instead when a detached worktree holds the commit", () => {
    const mine = local({ "plans/backlog.md": "b\nmine\n" });
    git("worktree", "add", "-q", "--detach", join(root, "detached"), mine);
    remote({ "b.txt": "b\n" });
    const r = sync();
    expect(r.status, r.stderr).toBe(0);
    expect(git("rev-parse", "dev^1")).toBe(mine);
  });
});

describe("the push of dev", () => {
  const originDev = () => gitIn(join(root, "origin.git"), "rev-parse", "dev");

  it("picks up origin/dev's commits, then pushes", () => {
    const theirs = remote({ [INBOX]: inbox(["First", "Pushed"]) });
    local({ "plans/backlog.md": "b\nmine\n" });
    const r = run("push_trunk");
    expect(r.status, r.stderr).toBe(0);
    expect(originDev()).toBe(git("rev-parse", "dev"));
    expect(git("merge-base", "--is-ancestor", theirs, "dev")).toBe("");
    expect(read()).toContain("- Pushed");
  });

  it("stops on a real conflict and pushes nothing", () => {
    const theirs = remote({ "a.txt": "theirs\n" });
    const mine = local({ "a.txt": "mine\n" }, "feat: my own");
    const r = run("push_trunk");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("nothing was pushed");
    expect(originDev()).toBe(theirs);
    expect(git("rev-parse", "dev")).toBe(mine);
  });

  it("a landing goes on when the pickup brought only the backlog files", () => {
    remote({ [INBOX]: inbox(["First", "Pushed"]) });
    const r = run("land_push_trunk");
    expect(r.status, r.stderr).toBe(0);
  });

  it("a landing refuses when the pickup brought anything its checks didn't see", () => {
    remote({ "b.txt": "code\n" });
    const r = run("land_push_trunk");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("nothing landed");
    expect(r.stderr).toContain("b.txt");
  });
});
