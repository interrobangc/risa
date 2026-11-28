// The inbox commands on an inbox store: `backlog inbox …` for a project with an `inbox`
// group, and the store CLI (inbox-store.mjs run directly) from a folder outside any repo.
// A temp bare repo stands in for the private store; the clones, the machine config and
// the projects are the test's own, never ~/.risa or this checkout's config.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_CONFIG } from "../loops/config-fixture.mjs";
import { keyNote, lineKey, newInboxEntries } from "./format.mjs";

const BACKLOG = new URL("./backlog.mjs", import.meta.url).pathname;
const STORE_CLI = new URL("./inbox-store.mjs", import.meta.url).pathname;
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();

/** @type {string} */ let root;
/** @type {string} */ let remote;
/** @type {string} */ let sample;
/** @type {string} */ let elsewhere;
/** @type {string} */ let machine;
/** @type {Record<string, string | undefined>} */ let env;

/** A project's main checkout at root/NAME: its risa.json (the fixture's, renamed, with INBOX) and a backlog. */
function project(name, inbox) {
  const dir = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "dev", dir]);
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  const fixture = JSON.parse(readFileSync(FIXTURE_CONFIG, "utf8"));
  writeFileSync(join(dir, "risa.json"), JSON.stringify({ ...fixture, name, inbox }, null, 2));
  mkdirSync(join(dir, "plans"));
  writeFileSync(
    join(dir, "plans/backlog.md"),
    "# Backlog\n\n## Items\n\n### B-1 · bug · Sign-in can be submitted twice\n\n- status: triaged\n- prd:\n- owner:\n- commit:\n",
  );
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const writeMachine = (...paths) =>
  writeFileSync(machine, JSON.stringify({ repos: paths.map((path) => ({ path, work: true })) }));

/** `backlog …` in the sample project. */
const backlog = (...args) => {
  const r = spawnSync("node", [BACKLOG, ...args], {
    cwd: sample,
    encoding: "utf8",
    env: { ...env, RISA_CONFIG: join(sample, "risa.json") },
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
/** The store CLI by its absolute path, from a folder outside any repo, with no project config. */
const storeCli = (...args) => {
  const { RISA_CONFIG: _, ...rest } = env;
  const r = spawnSync("node", [STORE_CLI, ...args], { cwd: elsewhere, encoding: "utf8", env: rest });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const onStore = (file) => git(remote, "show", `main:${file}`);
const storeCommits = () => Number(git(remote, "rev-list", "--count", "main"));

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "inbox-store-cli-")));
  remote = join(root, "store.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  machine = join(root, "machine.json");
  sample = project("sample", { repo: remote });
  const other = project("other", { repo: remote, file: "ideas.md" });
  writeMachine(sample, other);
  env = {
    ...process.env,
    BACKLOG_BY: "",
    BACKLOG_PICKUP: "off",
    GIT_AUTHOR_NAME: "T",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "T",
    GIT_COMMITTER_EMAIL: "t@example.com",
    RISA_INBOX_STORE: join(root, "clones"),
    RISA_MACHINE_CONFIG: machine,
  };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("backlog inbox with an inbox store", () => {
  it("adds to the store file, leaving the trunk's history and checkout as they were", () => {
    const head = git(sample, "rev-parse", "HEAD");
    const r = backlog(
      "inbox",
      "add",
      "bug",
      "The export button does nothing",
      "--details",
      "seen on the reports page",
    );
    expect(r.status).toBe(0);
    const sha = git(remote, "rev-parse", "main");
    expect(r.out).toBe(
      `added under Bugs on ${remote} sample.md as ${sha.slice(0, 7)}: The export button does nothing`,
    );
    expect(onStore("sample.md")).toBe(
      "# Inbox\n\n## Bugs\n\n- The export button does nothing\n  seen on the reports page",
    );
    expect(git(remote, "log", "-1", "--format=%s", "main")).toBe(
      "inbox: add (bug) The export button does nothing",
    );
    expect(git(sample, "rev-parse", "HEAD")).toBe(head);
    expect(git(sample, "status", "--porcelain")).toBe("");
    expect(backlog("inbox").out).toBe(
      "bug       The export button does nothing\n1 not filed yet (pnpm backlog ingest)",
    );
  });

  it("edits, moves and removes the store's lines", () => {
    let r = backlog("inbox", "edit", "export button", "--to", "The export button fails silently");
    expect(r.out).toMatch(
      new RegExp(
        `^edited on ${remote} sample\\.md as [0-9a-f]{7}: "The export button does nothing" is now "The export button fails silently"$`,
      ),
    );
    r = backlog("inbox", "move", "export button", "feature");
    expect(r.out).toMatch(
      /^moved to Features on .* sample\.md as [0-9a-f]{7}: The export button fails silently$/,
    );
    expect(onStore("sample.md")).toContain(
      "## Features\n\n- The export button fails silently\n  seen on the reports page",
    );
    expect(onStore("sample.md")).not.toMatch(/## Bugs\n\n- /);
    r = backlog("inbox", "remove", "export button");
    expect(r.out).toMatch(/^removed on .* sample\.md as [0-9a-f]{7}: The export button fails silently$/);
    expect(onStore("sample.md")).not.toContain("export button");
    expect(backlog("inbox", "remove", "nowhere to be seen")).toMatchObject({ status: 1 });
  });

  it("stops on a look-alike (exit 3), an item or a store line, writing nothing", () => {
    backlog("inbox", "add", "feature", "Dark mode for the dashboard");
    const before = storeCommits();
    let r = backlog("inbox", "add", "bug", "Sign-in can be submitted twice");
    expect(r.status).toBe(3);
    expect(r.err).toContain("B-1  triaged");
    r = backlog("inbox", "add", "feature", "Dark mode for the dashboard");
    expect(r.status).toBe(3);
    expect(r.err).toContain("unfiled inbox line  Dark mode for the dashboard");
    expect(storeCommits()).toBe(before);
    expect(backlog("inbox", "add", "feature", "Dark mode for the dashboard", "--anyway").status).toBe(0);
  });

  it("refuses edit, move and remove of a line whose key an item holds (filed, its removal pending)", () => {
    backlog("inbox", "add", "change", "Reports load the whole year at once");
    const line = newInboxEntries(onStore("sample.md")).find((e) => e.text.startsWith("Reports load"));
    expect(
      backlog("note", "B-1", `From the inbox ${keyNote(lineKey(/** @type {any} */ (line)))}`).status,
    ).toBe(0);
    const before = storeCommits();
    for (const [args, then] of [
      [
        ["edit", "whole year", "--to", "Reports load a month"],
        "change the item instead, in the backlog session",
      ],
      [["move", "whole year", "bug"], "change the item instead: pnpm backlog set B-1 type=bug"],
      [["remove", "whole year"], "drop the item instead, in the backlog session"],
    ]) {
      const r = backlog("inbox", ...args);
      expect(r.status).toBe(1);
      expect(r.err).toBe(`backlog: "Reports load the whole year at once" is filed as B-1: ${then}`);
    }
    const cli = storeCli("remove", "--project", "sample", "whole year");
    expect(cli.status).toBe(1);
    expect(cli.err).toBe(
      'inbox-store: "Reports load the whole year at once" is filed as B-1: drop the item instead, in the backlog session',
    );
    expect(storeCommits()).toBe(before);
  });
});

describe("the store CLI", () => {
  it("adds with --project from a folder outside any repo, comparing with that project's backlog", () => {
    const r = storeCli("add", "--project", "sample", "chore", "Rotate the staging keys");
    expect(r.err).toBe("");
    expect(r.out).toMatch(
      new RegExp(`^added under Chores on ${remote} sample\\.md as [0-9a-f]{7}: Rotate the staging keys$`),
    );
    expect(onStore("sample.md")).toContain("## Chores\n\n- Rotate the staging keys");
    const like = storeCli("add", "--project", "sample", "bug", "Sign-in can be submitted twice");
    expect(like.status).toBe(3);
    expect(like.err).toContain("B-1  triaged");
    expect(storeCli("list", "--project", "sample").out).toContain("chore     Rotate the staging keys");
    expect(storeCli("remove", "--project", "sample", "staging keys").status).toBe(0);
  });

  it("reaches a project with a custom inbox.file by that file's stem", () => {
    const r = storeCli("add", "--project", "ideas", "question", "Should reports export to CSV?");
    expect(r.out).toMatch(
      /^added under Questions on .* ideas\.md as [0-9a-f]{7}: Should reports export to CSV\?$/,
    );
    expect(onStore("ideas.md")).toContain("- Should reports export to CSV?");
  });

  it("refuses when the machine config's repos name different inbox stores", () => {
    const third = project("third", { repo: join(root, "another.git") });
    writeMachine(sample, third);
    try {
      const r = storeCli("add", "--project", "sample", "bug", "Never written");
      expect(r.status).toBe(1);
      expect(r.err).toBe(
        `inbox-store: the machine config's repos name different inbox stores: ${remote} (${sample}) and ${join(root, "another.git")} (${third}); give them one inbox.repo`,
      );
      expect(onStore("sample.md")).not.toContain("Never written");
    } finally {
      writeMachine(sample, join(root, "other"));
    }
  });
});
