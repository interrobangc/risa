// The origin writer and the inbox commands (`pnpm backlog inbox add|move`,
// `inbox`, `ingest`'s pickup), against a throwaway main checkout, a bare origin
// and a second clone standing in for another device. The scripts are copied
// into the checkout, so the pickup's lib.sh belongs to it; nothing here reaches
// the real repository, its origin or its asks.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HERE = new URL(".", import.meta.url).pathname;
const INBOX = "plans/inbox.md";
const BASE_INBOX = [
  "# Inbox",
  "",
  "Add anything here.",
  "",
  "## Bugs/Nits",
  "",
  "- Timeline jumps on scroll",
  "",
  "## Feature requests",
  "",
  "- Dark mode for the calendar",
  "  and the timeline",
  "- Dark mode for the settings",
  "",
  "## Questions",
  "",
].join("\n");

let root, repo, other, origin;
const gitIn = (dir, ...a) =>
  execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
const git = (...a) => gitIn(repo, ...a);
const put = (dir, files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
};
const commitIn = (dir, files, msg) => {
  put(dir, files);
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-qm", msg);
  return gitIn(dir, "rev-parse", "HEAD");
};
/** A commit on origin/dev from the other clone. */
const remote = (edit, msg = "chore: from elsewhere") => {
  gitIn(other, "pull", "-q", "origin", "dev");
  const sha = commitIn(other, edit(readFileSync(join(other, INBOX), "utf8")), msg);
  gitIn(other, "push", "-q", "origin", "dev");
  return sha;
};
const cli = (args, env = {}) => {
  const r = spawnSync("node", [join(repo, "scripts/backlog/backlog.mjs"), ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, BACKLOG_BY: "", GIT_AUTHOR_NAME: "T", GIT_COMMITTER_NAME: "T", ...env },
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const off = { BACKLOG_PICKUP: "off" };
const onOrigin = (rel = INBOX) => gitIn(origin, "show", `dev:${rel}`);
const read = () => readFileSync(join(repo, INBOX), "utf8");
/** Everything of the main checkout's that the writer must leave alone. */
const snapshot = () => ({
  head: git("rev-parse", "HEAD"),
  status: git("status", "--porcelain"),
  staged: git("diff", "--cached"),
  unstaged: git("diff"),
  inbox: read(),
  merging: existsSync(join(repo, ".git/MERGE_HEAD")),
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "inbox-origin-")));
  repo = join(root, "repo");
  other = join(root, "other");
  origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "dev", origin]);
  execFileSync("git", ["init", "-q", "-b", "dev", repo]);
  for (const [k, v] of [
    ["user.email", "t@example.com"],
    ["user.name", "T"],
    ["core.hooksPath", "/dev/null"],
    ["commit.gpgsign", "false"],
  ])
    git("config", k, v);
  git("remote", "add", "origin", origin);
  for (const dir of ["loops", "backlog"])
    cpSync(join(HERE, "..", dir), join(repo, "scripts", dir), {
      recursive: true,
      filter: (src) => !src.endsWith(".test.mjs"),
    });
  put(repo, { ".gitignore": "scripts/\n" });
  commitIn(
    repo,
    { [INBOX]: BASE_INBOX, "plans/backlog.md": "# Backlog\n\n## Items\n", "a.txt": "a\n" },
    "base",
  );
  git("push", "-q", "-u", "origin", "dev");
  execFileSync("git", ["clone", "-q", "-b", "dev", origin, other]);
  for (const [k, v] of [
    ["user.email", "t@example.com"],
    ["user.name", "T"],
    ["core.hooksPath", "/dev/null"],
  ])
    gitIn(other, "config", k, v);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("inbox add", () => {
  it("pushes one inbox-only commit with the trailer to origin/dev, leaving the main checkout alone", () => {
    put(repo, {
      [INBOX]: BASE_INBOX.replace("## Questions\n", "## Questions\n\n- Typed here\n"),
      "a.txt": "x\n",
    });
    git("add", "a.txt");
    const before = snapshot();
    const tip = gitIn(origin, "rev-parse", "dev");
    const r = cli(["inbox", "add", "bug", "Doses", "list", "empty", "--details", "seen by a viewer"], off);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toMatch(/^added under Bugs\/Nits on origin\/dev as [0-9a-f]{7}: Doses list empty$/);
    expect(onOrigin()).toContain(
      "- Timeline jumps on scroll\n- Doses list empty\n  seen by a viewer\n\n## Feature requests",
    );
    expect(gitIn(origin, "rev-parse", "dev^")).toBe(tip);
    expect(gitIn(origin, "diff-tree", "--no-commit-id", "--name-only", "-r", "dev")).toBe(INBOX);
    const msg = gitIn(origin, "log", "-1", "--format=%B", "dev");
    expect(msg).toMatch(/^chore\(backlog\): inbox: add \(bug\) Doses list empty\n/);
    expect(msg).toMatch(/\nBacklog-Tool: inbox add$/);
    expect(snapshot()).toEqual(before);
    expect(git("rev-parse", "refs/remotes/origin/dev")).toBe(gitIn(origin, "rev-parse", "dev"));
  });

  it("with the pickup on, the line arrives in dev and an uncommitted local line stays uncommitted", () => {
    put(repo, { [INBOX]: BASE_INBOX.replace("## Questions\n", "## Questions\n\n- Typed here\n") });
    const r = cli(["inbox", "add", "question", "Who", "sees", "the", "notes?"]);
    expect(r.status, r.err).toBe(0);
    expect(r.err).toContain("dev-sync: fast-forwarded dev");
    expect(git("rev-parse", "dev")).toBe(gitIn(origin, "rev-parse", "dev"));
    expect(read()).toContain("- Who sees the notes?");
    expect(read()).toContain("- Typed here");
    expect(git("show", `dev:${INBOX}`)).not.toContain("Typed here");
    expect(git("status", "--porcelain")).toBe(`M ${INBOX}`);
  });

  it("works with the main checkout mid-merge or on another branch; the pickup says why it skipped", () => {
    git("switch", "-q", "-c", "side");
    commitIn(repo, { "a.txt": "side\n" }, "side");
    git("switch", "-q", "dev");
    commitIn(repo, { "a.txt": "dev\n" }, "feat: mine");
    expect(spawnSync("git", ["-C", repo, "merge", "-q", "side"]).status).not.toBe(0);
    const before = snapshot();
    expect(before.merging).toBe(true);
    let r = cli(["inbox", "add", "bug", "Calendar", "export", "fails"]);
    expect(r.status, r.err).toBe(0);
    expect(r.err).toMatch(/pickup skipped: .*middle of a merge/);
    expect(onOrigin()).toContain("- Calendar export fails");
    expect(snapshot()).toEqual(before);

    git("merge", "--abort");
    git("switch", "-q", "side");
    r = cli(["inbox", "add", "bug", "Shared", "notes", "vanish"]);
    expect(r.status, r.err).toBe(0);
    expect(r.err).toMatch(/pickup skipped: .*isn't on dev/);
    expect(onOrigin()).toContain("- Shared notes vanish");
    expect(git("branch", "--show-current")).toBe("side");
  });

  it("pushes unpushed backlog commits first, so the pickup is a fast-forward", () => {
    expect(cli(["add", "chore", "Rename", "the", "scripts"]).status).toBe(0);
    const local = git("rev-parse", "dev");
    const r = cli(["inbox", "add", "feature", "Print", "the", "medication", "list"]);
    expect(r.status, r.err).toBe(0);
    expect(r.err).toContain("pushed 1 backlog commit(s) of dev first");
    expect(gitIn(origin, "rev-parse", "dev^")).toBe(local);
    expect(r.err).toContain("dev-sync: fast-forwarded");
    expect(git("rev-parse", "dev")).toBe(gitIn(origin, "rev-parse", "dev"));
  });

  it("never pushes a commit of the user's own: the inbox commit goes on origin's tip, the pickup merges", () => {
    const tip = gitIn(origin, "rev-parse", "dev");
    const mine = commitIn(repo, { "a.txt": "mine\n" }, "feat: my own");
    const r = cli(["inbox", "add", "feature", "Print", "the", "medication", "list"]);
    expect(r.status, r.err).toBe(0);
    expect(r.err).toContain("a commit of your own that isn't pushed");
    expect(gitIn(origin, "rev-parse", "dev^")).toBe(tip);
    expect(spawnSync("git", ["-C", origin, "merge-base", "--is-ancestor", mine, "dev"]).status).not.toBe(0);
    expect(r.err).toContain("dev-sync: merged origin/dev");
    expect(git("rev-list", "--parents", "-n", "1", "dev").split(" ")).toHaveLength(3);
    expect(git("show", `dev:${INBOX}`)).toContain("- Print the medication list");
  });

  it("stops on a look-alike, an item or an unfiled line, and pushes nothing; --anyway pushes", () => {
    expect(cli(["add", "bug", "Doses", "list", "shows", "nothing"]).status).toBe(0);
    git("push", "-q", "origin", "dev");
    const tip = gitIn(origin, "rev-parse", "dev");
    const before = snapshot();
    let r = cli(["inbox", "add", "bug", "Doses", "list", "shows", "nothing", "today"], off);
    expect(r.status).toBe(3);
    expect(r.err).toMatch(/B-1 +inbox +no topic +Doses list shows nothing/);
    r = cli(["inbox", "add", "feature", "Dark", "mode", "for", "calendar"], off);
    expect(r.status).toBe(3);
    expect(r.err).toContain("unfiled inbox line  Dark mode for the calendar");
    expect(gitIn(origin, "rev-parse", "dev")).toBe(tip);
    expect(snapshot()).toEqual(before);
    r = cli(["inbox", "add", "feature", "Dark", "mode", "for", "calendar", "--anyway"], off);
    expect(r.status, r.err).toBe(0);
    expect(onOrigin()).toContain("- Dark mode for calendar");
  });

  it("rebuilds a rejected push on the new tip, keeping both changes", () => {
    raceHook(1);
    const before = snapshot();
    const r = cli(["inbox", "add", "bug", "Lost", "connection", "banner"], off);
    expect(r.status, r.err).toBe(0);
    expect(r.err).toContain("moved; building the edit on its new tip");
    expect(onOrigin()).toContain("- Raced 1");
    expect(onOrigin()).toContain("- Lost connection banner");
    expect(snapshot()).toEqual(before);
  });

  it("after five rejections it fails, says nothing was written, and leaves the checkout alone", () => {
    raceHook(99);
    const before = snapshot();
    const r = cli(["inbox", "add", "bug", "Lost", "connection", "banner"], off);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/refused 5 pushes.*nothing was written/);
    expect(onOrigin()).toContain("- Raced 5");
    expect(onOrigin()).not.toContain("Lost connection banner");
    expect(snapshot()).toEqual(before);
    expect(existsSync(join(repo, ".git", `caretook-inbox-index-${process.pid}`))).toBe(false);
  });
});

/** A pre-push hook that, on each of its first `n` runs, pushes a line from the other clone first. */
function raceHook(n) {
  const hooks = join(root, "hooks");
  mkdirSync(hooks);
  const hook = join(hooks, "pre-push");
  writeFileSync(
    hook,
    `#!/usr/bin/env bash
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
c=$(cat "${root}/count" 2>/dev/null || echo 0)
(( c < ${n} )) || exit 0
c=$((c + 1)); echo $c > "${root}/count"
git -C "${other}" pull -q origin dev
printf -- '- Raced %s\\n' "$c" >> "${other}/${INBOX}"
git -C "${other}" commit -qam "raced $c"
git -C "${other}" push -q origin dev
`,
  );
  chmodSync(hook, 0o755);
  git("config", "core.hooksPath", hooks);
}

describe("inbox move", () => {
  it("moves an unfiled bullet with its details to another heading", () => {
    const before = snapshot();
    const r = cli(["inbox", "move", "dark", "mode", "for", "the", "calendar", "bug"], off);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toMatch(/^moved to Bugs\/Nits on origin\/dev as [0-9a-f]{7}: Dark mode for the calendar$/);
    expect(onOrigin()).toContain(
      "- Timeline jumps on scroll\n- Dark mode for the calendar\n  and the timeline\n\n## Feature requests\n\n- Dark mode for the settings\n",
    );
    expect(gitIn(origin, "log", "-1", "--format=%B", "dev")).toMatch(/Backlog-Tool: inbox move$/);
    expect(snapshot()).toEqual(before);
  });

  it("refuses no match and several matches, pushing nothing", () => {
    const tip = gitIn(origin, "rev-parse", "dev");
    let r = cli(["inbox", "move", "nothing", "like", "it", "bug"], off);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/no inbox line on origin\/dev has "nothing like it"; nothing was written/);
    r = cli(["inbox", "move", "dark", "mode", "bug"], off);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/in 2 inbox lines .*give more of its words/);
    expect(gitIn(origin, "rev-parse", "dev")).toBe(tip);
  });

  it("refuses a bullet filed on origin/dev with the set line", () => {
    remote((t) => ({ [INBOX]: t.replace("- Timeline jumps on scroll", "- Timeline jumps on scroll (B-7)") }));
    const r = cli(["inbox", "move", "timeline", "jumps", "feature"], off);
    expect(r.status).toBe(1);
    expect(r.err).toContain("filed as B-7: change the item instead: pnpm backlog set B-7 type=feature");
  });

  it("refuses a bullet filed only on local dev (ingest's tag, not pushed)", () => {
    expect(cli(["ingest"], off).status).toBe(0); // tags all three locally
    commitIn(repo, { "a.txt": "mine\n" }, "feat: my own"); // so nothing local is pushed
    expect(onOrigin()).not.toContain("(B-");
    const r = cli(["inbox", "move", "timeline", "jumps", "feature"], off);
    expect(r.status).toBe(1);
    expect(r.err).toContain("filed as B-1: change the item instead: pnpm backlog set B-1 type=feature");
    expect(onOrigin()).not.toContain("(B-");
  });
});

describe("the pickup and the listing", () => {
  it("ingest picks up a line that was only on origin/dev first, and never waits on its own lock", () => {
    remote((t) => ({ [INBOX]: t.replace("## Questions\n", "## Questions\n\n- Pushed from the phone\n") }));
    const started = Date.now();
    const r = cli(["ingest"]);
    expect(r.status, r.err).toBe(0);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r.err).not.toMatch(/locked/);
    expect(r.out).toMatch(/B-\d+ +question +Pushed from the phone/);
    expect(read()).toMatch(/- Pushed from the phone \(B-\d+\)/);
  });

  it("ingest files what is local when the pickup can't run, and says so", () => {
    remote((t) => ({
      [INBOX]: t.replace("## Questions\n", "## Questions\n\n- Pushed from the phone\n"),
      "a.txt": "theirs\n",
    }));
    put(repo, { "a.txt": "my unsaved edit\n" });
    const r = cli(["ingest"]);
    expect(r.status, r.err).toBe(0);
    expect(r.err).toMatch(/pickup skipped: .*uncommitted changes/);
    expect(r.out).toMatch(/Timeline jumps on scroll/);
    expect(r.out).not.toMatch(/Pushed from the phone/);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("my unsaved edit\n");
  });

  it("ingest with the checkout mid-merge says the pickup skipped, and refuses as before", () => {
    git("switch", "-q", "-c", "side");
    commitIn(repo, { "a.txt": "side\n" }, "side");
    git("switch", "-q", "dev");
    commitIn(repo, { "a.txt": "dev\n" }, "feat: mine");
    spawnSync("git", ["-C", repo, "merge", "-q", "side"]);
    const r = cli(["ingest"]);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/pickup skipped: .*middle of a merge/);
    expect(r.err).toMatch(/backlog: the main checkout is in the middle of a merge/);
  });

  it("inbox lists unfiled lines from origin/dev merged with the working copy", () => {
    remote((t) => ({ [INBOX]: t.replace("## Questions\n", "## Questions\n\n- Pushed from the phone\n") }));
    put(repo, {
      [INBOX]: BASE_INBOX.replace("- Timeline jumps on scroll", "- Timeline jumps on scroll\n- Typed here"),
    });
    const r = cli(["inbox"]);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toMatch(/question +Pushed from the phone/);
    expect(r.out).toMatch(/bug +Typed here/);
    expect(r.out).toContain("5 not filed yet");
    expect(read()).not.toContain("Pushed from the phone"); // a listing writes nothing
  });

  it("an inbox commit picked up into dev leaves a synced branch synced (pr's drift rule)", () => {
    git("branch", "prd/x", "dev");
    expect(cli(["inbox", "add", "bug", "Drift", "check"]).status).toBe(0);
    expect(git("rev-parse", "dev")).not.toBe(git("rev-parse", "prd/x"));
    const r = spawnSync("bash", ["-c", "source scripts/loops/lib.sh && trunk_drift prd/x"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});
