// The backlog CLI end to end, against a throwaway repo: a "main checkout" on
// dev plus a prd/ worktree, like the real layout.
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../loops/config.mjs";

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

/**
 * Items as the CLI writes them, for fixtures written straight to disk: each
 * `cli` write is a node start and 25–35 git spawns, so a fixture built through
 * it outran the 10 s hook timeout at load 40 (B-754).
 */
const items = (...rows) =>
  rows
    .map(
      ([id, type, title, status = "inbox", prd = ""]) =>
        `\n### ${id} · ${type} · ${title}\n\n- status: ${status}\n- prd:${prd && ` ${prd}`}\n- owner:\n- commit:\n`,
    )
    .join("");

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

  it("set and note --archived change an archived item in place; without the flag they refuse, naming it", () => {
    expect(cliFails(m2, "set", "B-4", "title=Fixed")).toMatch(/B-4 is archived.*pass --archived/);
    expect(cliFails(m2, "note", "B-4", "x")).toMatch(/B-4 is archived.*pass --archived/);
    const backlogBefore = committed("plans/backlog.md");

    expect(cli(m2, "set", "B-4", "title=Hygiene fix", "prd=fixes-nit", "--archived")).toBe("updated B-4");
    expect(cli(m2, "note", "B-4", "archived", "tidy", "--archived")).toBe("noted B-4");
    const archive = committed("plans/backlog-archive.md");
    expect(archive).toMatch(/### B-4 · bug · Hygiene fix\n\n- status: dropped\n- prd: fixes-nit/);
    expect(archive).toMatch(/- \d{4}-\d\d-\d\d \([^)]*\): archived tidy/);
    expect(archive).toMatch(/\| B-4 \| bug \| dropped \| fixes-nit \|/);
    expect(committed("plans/backlog.md")).toBe(backlogBefore); // still archived: not back in backlog.md
    expect(cli(m2, "show", "B-4")).toMatch(/B-4 · bug · Hygiene fix \(archived/);
    expect(cliFails(m2, "set", "B-4", "status=nope", "--archived")).toMatch(/status must be one of/);
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
    const four = ["One", "Two", "Three", "Four"].map((t, i) => [`B-${i + 1}`, "feature", t]);
    writeFileSync(join(m3, "plans/backlog.md"), `# Backlog\n\n## Items\n${items(...four)}`);
    git(m3, "add", ".");
    git(m3, "commit", "-q", "-m", "init");
    git(m3, "worktree", "add", "-q", "-b", "prd/z", p3);
  });
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
        "Backlog-Tool: note, set",
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

describe("backlog ci-file", () => {
  const FILE = "loops/a.test.mjs";
  const LIST = loadConfig().config.paths.quarantine;
  const flake = {
    key: "k1",
    title: "CI flake: a",
    prd: "fixes-tooling",
    note: "flaked",
    quarantine: { file: FILE, name: "one" },
  };
  let dir, repo, origin;
  const file = (...a) =>
    JSON.parse(
      execFileSync("node", [CLI, "ci-file", ...a.slice(1)], {
        cwd: repo,
        encoding: "utf8",
        env,
        input: JSON.stringify({ findings: a[0] }),
      }),
    );
  const count = (ref = "dev") => Number(git(repo, "rev-list", "--count", ref));
  const list = () => git(repo, "show", `HEAD:${LIST}`);
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "backlog-ci-file-")));
    repo = join(dir, "repo");
    origin = join(dir, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "dev", origin]);
    execFileSync("git", ["init", "-q", "-b", "dev", repo]);
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "commit.gpgsign", "false");
    git(repo, "remote", "add", "origin", origin);
    execFileSync("mkdir", ["-p", join(repo, "plans"), join(repo, "scripts/ci")]);
    writeFileSync(join(repo, "plans/backlog.md"), "# Backlog\n\n## Items\n");
    writeFileSync(join(repo, LIST), "# the quarantine\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "push", "-q", "origin", "dev");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("files and quarantines in one commit, followed by a push", () => {
    const before = count();
    const out = file([flake], "--push");
    expect(out).toMatchObject({ filed: [{ key: "k1", id: "B-1", created: true }], pushed: true });
    expect(count()).toBe(before + 1);
    expect(git(repo, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual([
      "plans/backlog.md",
      LIST,
    ]);
    expect(list()).toContain(`${FILE}\tone\tB-1`);
    expect(git(origin, "rev-parse", "dev")).toBe(git(repo, "rev-parse", "dev"));
    expect(readFileSync(join(repo, LIST), "utf8")).toContain("B-1");
  });

  it("a second find only adds a note, and never amends", () => {
    const head = git(repo, "rev-parse", "HEAD");
    expect(file([flake])).toMatchObject({ filed: [{ id: "B-1", created: false }], pushed: null });
    expect(git(repo, "rev-parse", "HEAD~1")).toBe(head);
    expect(list().match(/B-1/g)).toHaveLength(1);
    const text = readFileSync(join(repo, "plans/backlog.md"), "utf8");
    expect(text.match(/### B-/g)).toHaveLength(1);
    expect(text).toContain("[ci-key k1]");
  });

  it("a brake-list flake is filed with no entry", () => {
    const out = file([{ ...flake, key: "k2", title: "CI flake: b", quarantine: null }]);
    expect(out.filed[0]).toMatchObject({ id: "B-2", created: true });
    expect(list()).not.toContain("B-2");
  });

  it("a done item's entry leaves on the next write", () => {
    cli(repo, "set", "B-1", "status=dropped");
    expect(file([]).removed).toEqual([`${FILE}\tone\tB-1`]);
    expect(list()).not.toContain("B-1");
    expect(readFileSync(join(repo, LIST), "utf8")).not.toContain("B-1");
  });

  it("refuses to force a push onto a diverged origin", () => {
    const other = join(dir, "other");
    execFileSync("git", ["clone", "-q", "-b", "dev", origin, other]);
    git(other, "config", "user.email", "test@example.com");
    git(other, "config", "user.name", "Test");
    git(other, "commit", "-q", "--allow-empty", "-m", "elsewhere");
    git(other, "push", "-q", "origin", "dev");
    const theirs = git(other, "rev-parse", "HEAD");
    const out = file(
      [{ ...flake, key: "k3", title: "CI flake: c", quarantine: { file: FILE, name: "three" } }],
      "--push",
    );
    expect(out.pushed).toBe(false);
    expect(git(origin, "rev-parse", "dev")).toBe(theirs);
  });
});

// Look-alikes and archiving by id, in a repo of their own.
describe("backlog CLI: look-alikes and archive by id", () => {
  let r4, m4;
  const f4 = (rel) => readFileSync(join(m4, rel), "utf8");
  const raw = (...a) => {
    try {
      const out = execFileSync("node", [CLI, ...a], { cwd: m4, encoding: "utf8", env, stdio: "pipe" });
      return { code: 0, out, err: "" };
    } catch (e) {
      return { code: e.status, out: String(e.stdout), err: String(e.stderr) };
    }
  };

  beforeAll(() => {
    r4 = realpathSync(mkdtempSync(join(tmpdir(), "backlog-test-")));
    m4 = join(r4, "repo");
    execFileSync("git", ["init", "-q", "-b", "dev", m4]);
    git(m4, "config", "user.email", "test@example.com");
    git(m4, "config", "user.name", "Test");
    git(m4, "config", "commit.gpgsign", "false");
    execFileSync("mkdir", ["-p", join(m4, "plans")]);
    // What adding three items, dropping B-2 and archiving it leaves.
    writeFileSync(
      join(m4, "plans/backlog.md"),
      `# Backlog\n\n## Items\n${items(
        ["B-1", "bug", "Login link can be clicked twice", "triaged", "auth"],
        ["B-3", "feature", "Weekly summary for the family"],
      )}`,
    );
    writeFileSync(
      join(m4, "plans/backlog-archive.md"),
      `# Backlog archive\n\n## Items\n${items(["B-2", "bug", "Calendar export drops the time zone", "dropped"])}`,
    );
    writeFileSync(join(m4, "plans/inbox.md"), "# Inbox\n\n## Bugs\n\n## Features\n");
    git(m4, "add", ".");
    git(m4, "commit", "-q", "-m", "init");
  });
  afterAll(() => rmSync(r4, { recursive: true, force: true }));

  it("similar lists open and archived matches, and exits 0 with none", () => {
    expect(raw("similar", "The", "login", "link", "gets", "clicked", "twice")).toMatchObject({
      code: 0,
      out: "B-1  triaged  auth  Login link can be clicked twice\n",
    });
    expect(raw("similar", "Calendar export drops time zones").out).toBe(
      "B-2  dropped (archived)  no topic  Calendar export drops the time zone\n",
    );
    expect(raw("similar", "Something else entirely")).toMatchObject({ code: 0, out: "no look-alikes\n" });
  });

  it("add on a look-alike exits 3, names it and files nothing; --anyway files", () => {
    const head = git(m4, "rev-parse", "HEAD");
    const before = f4("plans/backlog.md");
    const stopped = raw("add", "bug", "Login link gets clicked twice");
    expect(stopped.code).toBe(3);
    expect(stopped.err).toContain("B-1  triaged  auth  Login link can be clicked twice");
    expect(stopped.err).toContain("--anyway");
    expect(git(m4, "rev-parse", "HEAD")).toBe(head);
    expect(f4("plans/backlog.md")).toBe(before);
    expect(raw("add", "bug", "Calendar export drops time zones").code).toBe(3); // an archived match stops it too
    expect(raw("add", "bug", "Login link gets clicked twice", "--anyway")).toMatchObject({
      code: 0,
      out: "added B-4\n",
    });
  });

  it("ingest files a look-alike line, and its item's note names the match", () => {
    writeFileSync(
      join(m4, "plans/inbox.md"),
      "# Inbox\n\n## Bugs\n\n- Weekly family summary\n- Nothing like the others\n\n## Features\n",
    );
    const { code, out } = raw("ingest");
    expect(code).toBe(0);
    expect(out).toMatch(/^B-5 +bug +Weekly family summary\n {2}looks like B-3 /m);
    expect(out).toContain("filed 2");
    expect(cli(m4, "show", "B-5")).toContain("Looks like: B-3 (inbox) Weekly summary for the family");
    expect(cli(m4, "show", "B-6")).not.toContain("Looks like");
  });

  it("archive B-n moves only that item, and refuses one that isn't finished", () => {
    cli(m4, "set", "B-4", "B-6", "status=dropped");
    expect(raw("archive", "B-4")).toMatchObject({
      code: 0,
      out: "archived 1 to plans/backlog-archive.md: B-4\n",
    });
    expect(f4("plans/backlog-archive.md")).toMatch(/### B-4 /);
    expect(f4("plans/backlog.md")).toMatch(/### B-6 /); // finished, but not named
    const head = git(m4, "rev-parse", "HEAD");
    const refused = raw("archive", "B-6", "B-3");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("B-3 is inbox, not finished; nothing archived");
    expect(git(m4, "rev-parse", "HEAD")).toBe(head);
    expect(f4("plans/backlog.md")).toMatch(/### B-6 /);
  });

  it("list --all --json marks archived items", () => {
    const rows = JSON.parse(cli(m4, "list", "--all", "--json"));
    expect(rows.find((r) => r.id === "B-2").archived).toBe(true);
    expect(rows.find((r) => r.id === "B-1").archived).toBeUndefined();
  });
});

// Another project's config (RISA_CONFIG): its own paths, trunk, PRD heading and
// id prefix. Every id, heading, tag and lookup follows it.
describe("backlog CLI: another project's config", () => {
  let r4, m4, p4, cfg;
  const at = (rel) => readFileSync(join(m4, rel), "utf8");
  const run4 = (cwd, ...a) =>
    execFileSync("node", [CLI, ...a], { cwd, encoding: "utf8", env: { ...env, RISA_CONFIG: cfg } }).trim();
  beforeAll(() => {
    r4 = realpathSync(mkdtempSync(join(tmpdir(), "backlog-sample-")));
    m4 = join(r4, "repo");
    p4 = join(r4, "topic-x");
    const sample = loadConfig().config;
    cfg = join(r4, "sample.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        ...sample,
        name: "sample",
        paths: { ...sample.paths, backlog: "todo/list.md", inbox: "todo/in.md", archive: "todo/old.md" },
        branches: {
          ...sample.branches,
          trunk: "trunk",
          prefixes: { ...sample.branches.prefixes, prd: "topic/" },
        },
        backlog: { ...sample.backlog, prdsHeading: "## Topics", idPrefix: "RISA" },
      }),
    );
    execFileSync("git", ["init", "-q", "-b", "trunk", m4]);
    git(m4, "config", "user.email", "test@example.com");
    git(m4, "config", "user.name", "Test");
    git(m4, "config", "commit.gpgsign", "false");
    execFileSync("mkdir", ["-p", join(m4, "todo")]);
    writeFileSync(
      join(m4, "todo/list.md"),
      "# Tracker\n\n## Topics\n\n| PRD | Flags | After | Hot files | Doc and notes |\n| --- | ----- | ----- | --------- | ------------- |\n| `x` | — | — | — | notes |\n\n## Items\n",
    );
    writeFileSync(join(m4, "todo/in.md"), "# Inbox\n\n## Bugs\n\n- Scrolling jumps\n");
    git(m4, "add", ".");
    git(m4, "commit", "-q", "-m", "init");
    git(m4, "worktree", "add", "-q", "-b", "topic/x", p4);
  });
  afterAll(() => rmSync(r4, { recursive: true, force: true }));

  it("gives new ids, headings, summary rows and inbox tags the project's prefix", () => {
    expect(run4(p4, "add", "bug", "Sign-in", "twice")).toBe("added RISA-1");
    expect(at("todo/list.md")).toContain("### RISA-1 · bug · Sign-in twice");
    expect(at("todo/list.md")).toMatch(/^\| RISA-1 \| bug \|/m);
    expect(git(m4, "log", "-1", "--format=%s%n%b")).toBe(
      "chore(backlog): add RISA-1 (bug) Sign-in twice\nBy: topic/x\n\nBacklog-Tool: add\nBacklog-Ids: RISA-1",
    );
    expect(run4(p4, "ingest")).toMatch(/RISA-2 +bug +Scrolling jumps/);
    expect(at("todo/in.md")).toContain("- Scrolling jumps (RISA-2)");
    expect(git(m4, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual([
      "todo/in.md",
      "todo/list.md",
    ]);
    expect(run4(p4, "ingest")).toBe("nothing new in the inbox");
  });

  it("finds items by the prefix, a bare number or lower case, and notes several", () => {
    expect(run4(m4, "show", "risa-1")).toMatch(/^RISA-1 · bug · Sign-in twice/);
    expect(run4(m4, "show", "2")).toMatch(/^RISA-2 · bug · Scrolling jumps/);
    expect(run4(m4, "note", "RISA-1", "RISA-2", "seen", "twice")).toBe("noted RISA-1, RISA-2");
    expect(run4(m4, "note", "RISA-1", "B-2", "a", "B-n", "is", "words")).toBe("noted RISA-1");
    expect(at("todo/list.md")).toMatch(/: B-2 a B-n is words/);
  });

  it("reads the registry under the project's heading, and finds its prd worktrees by their prefix", () => {
    expect(JSON.parse(run4(m4, "prd", "list", "--json"))).toMatchObject([{ topic: "x", state: "running" }]);
  });

  it("archives to the project's archive", () => {
    run4(m4, "set", "RISA-1", "status=dropped");
    expect(run4(m4, "archive")).toBe("archived 1 to todo/old.md: RISA-1");
    expect(at("todo/old.md")).toContain("### RISA-1 · bug · Sign-in twice");
    expect(at("todo/old.md")).toContain("`pnpm backlog show RISA-n`");
    expect(run4(m4, "show", "RISA-1")).toContain("(archived in todo/old.md)");
    expect(run4(m4, "add", "bug", "Another")).toBe("added RISA-3");
  });

  it("orders look-alikes by their number under the project's prefix", () => {
    expect(run4(m4, "add", "bug", "Sign-in", "twice", "--anyway")).toBe("added RISA-4");
    // RISA-4 is open and RISA-1 archived, so the pool lists RISA-4 first: only the number sorts them.
    expect(
      run4(m4, "similar", "Sign-in", "twice")
        .split("\n")
        .map((l) => l.split(" ")[0]),
    ).toEqual(["RISA-1", "RISA-4"]);
  });
});

// A project whose items came from another project's backlog: with a
// former prefix, a lookup reads B-772 as RISA-772; what it makes keeps RISA.
describe("backlog CLI: a former id prefix", () => {
  let r5, m5, cfg;
  const run5 = (...a) =>
    execFileSync("node", [CLI, ...a], {
      cwd: m5,
      encoding: "utf8",
      env: { ...env, RISA_CONFIG: cfg },
    }).trim();
  beforeAll(() => {
    r5 = realpathSync(mkdtempSync(join(tmpdir(), "backlog-former-")));
    m5 = join(r5, "repo");
    const sample = loadConfig().config;
    cfg = join(r5, "risa.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        ...sample,
        name: "risa",
        backlog: { ...sample.backlog, idPrefix: "RISA", formerIdPrefix: "B", zoneOverflowItem: "RISA-750" },
      }),
    );
    execFileSync("git", ["init", "-q", "-b", sample.branches.trunk, m5]);
    git(m5, "config", "user.email", "test@example.com");
    git(m5, "config", "user.name", "Test");
    git(m5, "config", "commit.gpgsign", "false");
    execFileSync("mkdir", ["-p", join(m5, "plans")]);
    // An item moved here from the other backlog keeps its number.
    writeFileSync(
      join(m5, "plans/backlog.md"),
      "# Backlog\n\n## Items\n\n### RISA-772 · chore · Moved over\n- status: triaged\n- prd: x\n- owner: \n- commit: \n",
    );
    git(m5, "add", ".");
    git(m5, "commit", "-q", "-m", "init");
  });
  afterAll(() => rmSync(r5, { recursive: true, force: true }));

  it("finds RISA-772 by B-772 in every lookup, and gives new items the current prefix", () => {
    expect(run5("show", "B-772")).toMatch(/^RISA-772 · chore · Moved over/);
    expect(run5("show", "b-772")).toMatch(/^RISA-772 · /);
    expect(run5("note", "B-772", "seen")).toBe("noted RISA-772");
    expect(run5("set", "B-772", "type=bug")).toMatch(/RISA-772/);
    expect(run5("add", "bug", "Fresh", "one")).toBe("added RISA-773");
    expect(run5("note", "RISA-773", "B-772", "both")).toBe("noted RISA-773, RISA-772");
    const text = readFileSync(join(m5, "plans/backlog.md"), "utf8");
    expect(text).toContain("### RISA-772 · bug · Moved over");
    expect(text).toContain("### RISA-773 · bug · Fresh one");
    expect(text).not.toMatch(/^### B-/m);
  });

  it("ingests an inbox whose line is tagged with a former id as filed", () => {
    writeFileSync(join(m5, "plans/inbox.md"), "# Inbox\n\n## Chores\n\n- Moved over (B-772)\n- Brand new\n");
    git(m5, "add", ".");
    git(m5, "commit", "-q", "-m", "inbox");
    const out = run5("ingest");
    expect(out).toMatch(/RISA-774 +feature|RISA-774 +chore/);
    expect(out).not.toMatch(/Moved over/);
    const inbox = readFileSync(join(m5, "plans/inbox.md"), "utf8");
    expect(inbox).toContain("- Moved over (B-772)");
    expect(inbox).toContain("- Brand new (RISA-774)");
    expect(run5("doctor")).not.toMatch(/772/);
  });
});

describe("backlog CLI: a broken project config", () => {
  let dir;
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "backlog-broken-")));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const fails = (text) => {
    const cfg = join(dir, "risa.json");
    writeFileSync(cfg, text);
    const r = spawnSync("node", [CLI, "list"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...env, RISA_CONFIG: cfg },
    });
    return { status: r.status, stderr: r.stderr };
  };

  it("prints one backlog: line and exits non-zero, never a stack", () => {
    for (const text of ["{ not json", JSON.stringify({ name: "x" })]) {
      const { status, stderr } = fails(text);
      expect(status).toBe(2);
      expect(stderr).toMatch(/^backlog: \S.*\n$/);
      expect(stderr).not.toMatch(/\n\s+at /);
    }
    expect(
      fails(JSON.stringify({ ...loadConfig().config, backlog: { prdsHeading: "## PRDs", idPrefix: "b" } }))
        .stderr,
    ).toMatch(/^backlog: .*backlog\.idPrefix: must be an id prefix/);
  });

  it("names the command that imported the backlog's modules, not backlog", () => {
    const cfg = join(dir, "risa.json");
    writeFileSync(cfg, "{ not json");
    for (const [script, who] of [
      ["../loops/planner-model.mjs", "planner-model"],
      ["../loops/open-session.mjs", "open-session"],
    ]) {
      const r = spawnSync("node", [new URL(script, import.meta.url).pathname, "x", dir], {
        cwd: dir,
        encoding: "utf8",
        env: { ...env, RISA_CONFIG: cfg },
      });
      expect(r.status, script).toBe(2);
      expect(r.stderr).toMatch(new RegExp(`^${who}: \\S.*not JSON.*\\n$`));
      expect(r.stderr).not.toMatch(/\n\s+at /);
    }
  });
});
