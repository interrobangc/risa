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
    expect(git(main, "log", "-1", "--format=%s%n%b")).toBe(
      "chore(backlog): add B-1 (bug) Sign-in twice\nBy: prd/x\n\nBacklog-Tool: add\nBacklog-Ids: B-1",
    );
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

  it("files new inbox bullets, tags them, and commits both files", () => {
    writeFileSync(
      join(main, "plans/inbox.md"),
      "# Inbox\n\n## Bugs\n\n- Already filed (B-1)\n- Scrolling jumps\n  on my phone\n\n## Questions\n\n- Why so slow?\n",
    );
    git(main, "add", "plans/inbox.md");
    git(main, "commit", "-q", "-m", "inbox");
    expect(cli(main, "inbox")).toContain("2 not filed yet");
    const out = cli(prd, "ingest");
    expect(out).toMatch(/B-7 +bug +Scrolling jumps/);
    expect(out).toMatch(/B-8 +question +Why so slow\?/);
    const inbox = readFileSync(join(main, "plans/inbox.md"), "utf8");
    expect(inbox).toContain("- Scrolling jumps (B-7)\n  on my phone");
    expect(inbox).toContain("- Why so slow? (B-8)");
    expect(inbox).toContain("- Already filed (B-1)\n");
    expect(cli(main, "show", "B-7")).toMatch(/status: inbox[\s\S]*From the inbox: on my phone/);
    expect(git(main, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual([
      "plans/backlog.md",
      "plans/inbox.md",
    ]);
    expect(cli(prd, "ingest")).toBe("nothing new in the inbox");
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

// Write safety, doctor, archive and fresh statuses, in a repo of their own.
describe("backlog CLI: safety, doctor and archive", () => {
  let r2, m2, p2;
  const f2 = (rel) => readFileSync(join(m2, rel), "utf8");
  const put = (rel, text) => writeFileSync(join(m2, rel), text);
  const committed = (rel) => git(m2, "show", `HEAD:${rel}`);
  const doctor = (...a) => {
    try {
      return {
        code: 0,
        out: execFileSync("node", [CLI, "doctor", ...a], { cwd: m2, encoding: "utf8", env }),
      };
    } catch (e) {
      return { code: e.status, out: String(e.stdout) };
    }
  };
  const INBOX =
    "# Inbox\n\n## Bugs\n\n- Dates overflow on phones\n\n## Changes\n\n- Bigger day headers\n  on every screen\n";

  beforeAll(() => {
    r2 = realpathSync(mkdtempSync(join(tmpdir(), "backlog-test-")));
    m2 = join(r2, "repo");
    p2 = join(r2, "prd-y");
    execFileSync("git", ["init", "-q", "-b", "dev", m2]);
    git(m2, "config", "user.email", "test@example.com");
    git(m2, "config", "user.name", "Test");
    git(m2, "config", "commit.gpgsign", "false");
    execFileSync("mkdir", ["-p", join(m2, "plans")]);
    put("plans/backlog.md", "# Backlog\n\n## Items\n");
    put("plans/inbox.md", INBOX);
    git(m2, "add", ".");
    git(m2, "commit", "-q", "-m", "init");
    git(m2, "worktree", "add", "-q", "-b", "prd/y", p2);
    expect(cli(m2, "ingest")).toContain("filed 2"); // B-1 dates, B-2 headers
  });
  afterAll(() => rmSync(r2, { recursive: true, force: true }));

  it("add, set and note commit only backlog.md, leaving a dirty inbox line alone", () => {
    const dirty = `${f2("plans/inbox.md")}- Half-typed thing (B-3)\n- Another half\n`;
    put("plans/inbox.md", dirty);
    const head = git(m2, "rev-parse", "HEAD");
    expect(cli(p2, "add", "bug", "Turning", "invites", "off", "blocks", "staff")).toBe("added B-4"); // B-3 is a tag in the inbox
    cli(p2, "note", "B-1", "looked");
    cli(p2, "set", "B-2", "prd=polish");
    expect(git(m2, "diff", "--name-only", head, "HEAD")).toBe("plans/backlog.md");
    expect(f2("plans/inbox.md")).toBe(dirty); // untouched on disk…
    expect(committed("plans/inbox.md")).not.toContain("Half-typed"); // …and not committed
    expect(git(m2, "status", "--porcelain")).toBe("M plans/inbox.md"); // shows as the user's own edit
    expect(git(m2, "diff", "--cached", "--name-only")).toBe("");
  });

  it("doctor reports a mis-tagged bullet, a tag with no item and owners that are gone", () => {
    // The B-106 case: a bullet about browser tests tagged with another item's id.
    put(
      "plans/inbox.md",
      `${INBOX.replace("- Dates overflow on phones", "- Dates overflow on phones (B-1)").replace("  on every screen", "  on every screen\n- Browser checks hang without a timeout (B-4)\n- Ghost (B-99)")}`,
    );
    put(
      "plans/inbox.md",
      f2("plans/inbox.md").replace("- Bigger day headers\n", "- Bigger day headers (B-2)\n"),
    );
    cli(m2, "set", "B-1", "owner=prd/gone", "status=in-progress");
    const { code, out } = doctor();
    expect(code).toBe(1);
    expect(out).toMatch(
      /B-4 +inbox line \d+ \("Browser checks hang without a timeout"\) is tagged with it, but its title \("Turning invites off blocks staff"\) didn't come from that line/,
    );
    expect(out).toMatch(/B-99 +.*there's no such item/);
    expect(out).toMatch(/B-1 +is in-progress, owned by prd\/gone, which isn't a branch any more/);
    expect(out).not.toMatch(/B-2 /); // a correct tag, with details
    cli(m2, "set", "B-1", "owner=prd/y");
    put(
      "plans/inbox.md",
      INBOX.replace("- Dates overflow on phones", "- Dates overflow on phones (B-1)").replace(
        "- Bigger day headers\n",
        "- Bigger day headers (B-2)\n",
      ),
    );
    cli(m2, "commit", "inbox tidy");
    expect(doctor()).toEqual({ code: 0, out: "backlog ok\n" });
  });

  it("doctor reports duplicate ids, a stale summary and stale statuses, and --fix repairs the safe ones", () => {
    writeFileSync(join(p2, "work.txt"), "w\n");
    git(p2, "add", "work.txt");
    git(p2, "commit", "-q", "-m", "work");
    cli(p2, "done", "B-1");
    git(m2, "merge", "-q", "--no-ff", "-m", "land", "prd/y"); // B-1 is now landed, but the file says ready
    const text = f2("plans/backlog.md");
    put(
      "plans/backlog.md",
      text.replace(/^\| B-2 \|.*\n/m, "").replace("| B-4 |", "| B-9 | bug | inbox |  |  | Gone |\n| B-4 |"),
    );
    let { code, out } = doctor();
    expect(code).toBe(1);
    expect(out).toMatch(/B-1 +status says ready, but git says landed \(--fix\)/);
    expect(out).toMatch(/B-2 +has no row in the summary/);
    expect(out).toMatch(/B-9 +is in the summary but has no item/);
    ({ code, out } = doctor("--fix"));
    expect(out).toMatch(/fixed 3/);
    expect(out).toMatch(/backlog ok/);
    expect(code).toBe(0);
    expect(committed("plans/backlog.md")).toMatch(/\| B-1 \| bug \| landed \|/);
    expect(committed("plans/backlog.md")).toMatch(/### B-1[^\n]*\n\n- status: landed/);

    const dup = f2("plans/backlog.md").replace("### B-4 · bug ·", "### B-1 · bug ·");
    put("plans/backlog.md", dup);
    ({ code, out } = doctor());
    expect(code).toBe(1);
    expect(out).toMatch(/B-1 +appears more than once in plans\/backlog\.md/);
    expect(cliFails(m2, "note", "B-2", "x")).toMatch(/B-1 appears twice/); // writes refuse it
    put("plans/backlog.md", dup.replace("### B-1 · bug · Turning", "### B-4 · bug · Turning"));
    cli(m2, "commit");
  });

  it("every write recomputes derived statuses from local refs", () => {
    cli(p2, "add", "chore", "More work");
    writeFileSync(join(p2, "work2.txt"), "w\n");
    git(p2, "add", "work2.txt");
    git(p2, "commit", "-q", "-m", "work 2");
    cli(p2, "done", "B-5");
    expect(committed("plans/backlog.md")).toMatch(/\| B-5 \| chore \| ready \|/);
    git(m2, "merge", "-q", "--no-ff", "-m", "land 2", "prd/y");
    cli(p2, "note", "B-2", "unrelated");
    expect(committed("plans/backlog.md")).toMatch(/\| B-5 \| chore \| landed \|/);
    expect(git(m2, "log", "-1", "--format=%b")).toContain("Statuses from git: B-5 ready → landed.");
  });

  it("archive moves finished items and their bullets; reads still find them; ids aren't reused", () => {
    cli(m2, "set", "B-4", "status=dropped");
    const dirtyLine = "- Still typing this one\n";
    put("plans/inbox.md", `${f2("plans/inbox.md")}${dirtyLine}`);
    expect(cli(p2, "archive")).toBe("archived 3 to plans/backlog-archive.md: B-1, B-4, B-5");
    const backlog = committed("plans/backlog.md");
    expect(backlog).not.toMatch(/### B-1 |### B-4 |### B-5 /);
    expect(backlog).toMatch(/### B-2 /);
    const archive = committed("plans/backlog-archive.md");
    expect(archive).toMatch(/^# Backlog archive/);
    expect(archive).toMatch(/### B-1 · bug · Dates overflow on phones\n\n- status: landed/);
    expect(archive).toMatch(/\| B-4 \| bug \| dropped \|/);
    // The bullet is gone from the inbox, committed and on disk; the dirty line stays, uncommitted.
    expect(committed("plans/inbox.md")).not.toContain("Dates overflow");
    expect(committed("plans/inbox.md")).toContain("- Bigger day headers (B-2)\n  on every screen");
    expect(f2("plans/inbox.md")).not.toContain("Dates overflow");
    expect(f2("plans/inbox.md")).toContain(dirtyLine);
    expect(committed("plans/inbox.md")).not.toContain("Still typing");
    expect(git(m2, "status", "--porcelain")).toBe("M plans/inbox.md");

    expect(cli(m2, "show", "B-1")).toMatch(/B-1 · bug · Dates overflow on phones \(archived/);
    expect(cli(m2, "list")).not.toMatch(/B-1 /);
    expect(cli(m2, "list", "--all")).toMatch(/B-1 +bug +landed/);
    expect(cliFails(m2, "note", "B-1", "x")).toMatch(/B-1 is archived/);
    expect(cli(m2, "add", "bug", "After the archive")).toBe("added B-6");
    expect(cli(m2, "archive")).toBe("nothing to archive");
    expect(doctor().out).toBe("backlog ok\n");
  });
});

// Multi-id writes and amending, in a repo of their own.
describe("backlog CLI: multi-id writes and amending", () => {
  let r3, m3, p3;
  const f3 = () => readFileSync(join(m3, "plans/backlog.md"), "utf8");
  const count = () => Number(git(m3, "rev-list", "--count", "HEAD"));
  const head = () => git(m3, "rev-parse", "HEAD");
  const msg = (rev = "HEAD") => git(m3, "log", "-1", "--format=%B", rev);
  const item = (id) =>
    f3()
      .split(/^### /m)
      .find((s) => s.startsWith(`${id} `)) ?? "";
  let n = 0;
  /** A commit of someone's own work on dev: never amended. */
  const handCommit = () => {
    writeFileSync(join(m3, "hand.txt"), `${++n}\n`);
    git(m3, "add", "hand.txt");
    git(m3, "commit", "-q", "-m", `hand ${n}`);
    return head();
  };

  beforeAll(() => {
    r3 = realpathSync(mkdtempSync(join(tmpdir(), "backlog-test-")));
    m3 = join(r3, "repo");
    p3 = join(r3, "prd-z");
    execFileSync("git", ["init", "-q", "-b", "dev", m3]);
    git(m3, "config", "user.email", "test@example.com");
    git(m3, "config", "user.name", "Test");
    git(m3, "config", "commit.gpgsign", "false");
    execFileSync("mkdir", ["-p", join(m3, "plans")]);
    writeFileSync(join(m3, "plans/backlog.md"), "# Backlog\n\n## Items\n");
    git(m3, "add", ".");
    git(m3, "commit", "-q", "-m", "init");
    git(m3, "worktree", "add", "-q", "-b", "prd/z", p3);
    for (const t of ["One", "Two", "Three", "Four"]) cli(m3, "add", "feature", t);
  }, 60_000);
  afterAll(() => rmSync(r3, { recursive: true, force: true }));

  it("set with several ids is one commit that changes them all", () => {
    handCommit();
    const before = count();
    expect(cli(p3, "set", "B-1", "b-2", "prd=x", "status=triaged")).toBe("updated B-1, B-2");
    expect(count()).toBe(before + 1);
    for (const id of ["B-1", "B-2"]) expect(item(id)).toMatch(/- status: triaged\n- prd: x/);
    expect(item("B-3")).not.toMatch(/prd: x/);
    expect(git(m3, "log", "-1", "--format=%s")).toBe("chore(backlog): B-1, B-2: set prd=x, status=triaged");
  });

  it("note with several ids is one commit; ids after the first need the B- prefix", () => {
    handCommit();
    const before = count();
    expect(cli(p3, "note", "B-1", "B-3", "2", "tests", "fail")).toBe("noted B-1, B-3");
    expect(count()).toBe(before + 1);
    for (const id of ["B-1", "B-3"]) expect(item(id)).toMatch(/\(prd\/z\): 2 tests fail/);
    expect(item("B-2")).not.toMatch(/tests fail/);
    expect(git(m3, "log", "-1", "--format=%s")).toBe("chore(backlog): B-1, B-3: note");
  });

  it("claim with several ids is all or nothing, and names the conflict", () => {
    expect(cli(m3, "claim", "B-1", "--as", "prd/a")).toBe("B-1 claimed by prd/a");
    const at = head();
    const text = f3();
    expect(cliFails(p3, "claim", "B-2", "B-1", "B-3")).toMatch(
      /B-1 is already claimed by prd\/a; nothing claimed/,
    );
    expect(head()).toBe(at);
    expect(f3()).toBe(text);
    expect(cli(p3, "claim", "B-2", "B-3")).toBe("B-2 claimed by prd/z\nB-3 claimed by prd/z");
    for (const id of ["B-2", "B-3"]) expect(item(id)).toMatch(/- owner: prd\/z/);
  });

  it("a quick second write amends the first: one commit, every id in the subject, both writes' lines", () => {
    const hand = handCommit();
    cli(p3, "note", "B-1", "first");
    const first = head();
    cli(m3, "set", "B-4", "prd=y");
    expect(git(m3, "rev-parse", "HEAD^")).toBe(hand);
    expect(head()).not.toBe(first);
    expect(git(m3, "log", "-1", "--format=%s")).toBe("chore(backlog): B-1, B-4: note, set");
    expect(msg()).toBe(
      [
        "chore(backlog): B-1, B-4: note, set",
        "",
        "B-1: note",
        "By: prd/z",
        "",
        "B-4: set prd=y",
        "By: Test",
        "",
        "Backlog-Tool: note",
        "Backlog-Tool: set",
        "Backlog-Ids: B-1, B-4",
      ].join("\n"),
    );
    expect(item("B-1")).toMatch(/first/);
    expect(item("B-4")).toMatch(/- prd: y/);
    cli(p3, "note", "B-2", "B-3", "B-4", "B-1", "third");
    expect(git(m3, "rev-parse", "HEAD^")).toBe(hand);
    expect(git(m3, "log", "-1", "--format=%s")).toBe("chore(backlog): B-1, B-4, B-2 +1: note, set");
    expect(git(m3, "status", "--porcelain")).toBe("");
  });

  it("a write after the prd/ branch merged dev makes a new commit", () => {
    handCommit();
    cli(m3, "note", "B-1", "before the sync");
    const synced = head();
    git(p3, "merge", "-q", "--no-ff", "-m", "sync dev", "dev");
    cli(m3, "note", "B-2", "after the sync");
    expect(git(m3, "rev-parse", "HEAD^")).toBe(synced);
    expect(git(m3, "log", "-1", "--format=%s")).toBe("chore(backlog): B-2: note");
  });

  it("a write after a hand commit makes a new commit", () => {
    cli(m3, "note", "B-1", "x");
    const hand = handCommit();
    cli(m3, "note", "B-2", "y");
    expect(git(m3, "rev-parse", "HEAD^")).toBe(hand);
    expect(msg(hand)).toBe("hand " + n);
  });

  it("a write when HEAD is over 10 minutes old makes a new commit", () => {
    handCommit();
    const old = `@${Math.floor(Date.now() / 1000) - 11 * 60} +0000`;
    execFileSync("node", [CLI, "note", "B-1", "old"], {
      cwd: m3,
      encoding: "utf8",
      env: { ...env, GIT_COMMITTER_DATE: old, GIT_AUTHOR_DATE: old },
    });
    const stale = head();
    cli(m3, "note", "B-2", "new");
    expect(git(m3, "rev-parse", "HEAD^")).toBe(stale);
  });
});
