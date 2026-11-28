// The inbox store: a temp bare repo stands in for the private one, and each clone's
// folder is the test's own (RISA_INBOX_STORE), never ~/.risa.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRANCH, StoreError, TRIES, cloneName, storeFor, storeRoot } from "./inbox-store.mjs";

const IDENTITY = {
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const FILE = "sample.md";
const HEAD = "# Inbox\n";

/** @type {string} */ let root;
/** @type {string} */ let remote;
const saved = { ...process.env };
const quiet = () => {};

/** A store with its clone in its own folder (a machine of its own). */
const store = (name = "a") => storeFor(remote, { env: { RISA_INBOX_STORE: join(root, `clones-${name}`) } });
/** A line added at the end of the file (a new file: the heading first). */
const add = (line) => (text) => `${text ?? HEAD}- ${line}\n`;
const onRemote = (...args) => execFileSync("git", ["-C", remote, ...args], { encoding: "utf8" }).trim();
const commits = () => Number(onRemote("rev-list", "--count", BRANCH));

beforeEach(() => {
  Object.assign(process.env, IDENTITY);
  root = realpathSync(mkdtempSync(join(tmpdir(), "inbox-store-")));
  remote = join(root, "store.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
});
afterEach(() => {
  for (const k of Object.keys(IDENTITY)) if (!(k in saved)) delete process.env[k];
  rmSync(root, { recursive: true, force: true });
});

describe("the store's clone", () => {
  it("is under ~/.risa/inbox-store, or the folder RISA_INBOX_STORE names, made on first use", () => {
    expect(storeRoot({ HOME: "/home/x" })).toBe("/home/x/.risa/inbox-store");
    expect(storeRoot({ HOME: "/home/x", RISA_INBOX_STORE: "/s" })).toBe("/s");
    expect(cloneName("git@github.com:me/ideas.git")).toBe("github.com-me-ideas");
    expect(cloneName("https://github.com/me/ideas.git")).toBe("github.com-me-ideas");
    const s = store();
    expect(s.dir.startsWith(join(root, "clones-a"))).toBe(true);
    expect(existsSync(s.dir)).toBe(false);
    expect(s.read(FILE)).toBeNull();
    expect(existsSync(join(s.dir, "HEAD"))).toBe(true);
  });

  it("refuses a file that is a path", () => {
    expect(() => store().read("../x.md")).toThrow(StoreError);
    expect(() => store().write("a/b.md", add("x"), "m")).toThrow(StoreError);
  });
});

describe("read and write", () => {
  it("round-trips a write through a read, on another machine too, committing only that file", () => {
    const a = store("a");
    const sha = a.write(FILE, add("first idea"), "inbox: add one");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(onRemote("rev-parse", BRANCH)).toBe(sha);
    expect(a.read(FILE)).toBe(`${HEAD}- first idea\n`);
    expect(store("b").read(FILE)).toBe(`${HEAD}- first idea\n`);
    const next = a.write("other.md", add("elsewhere"), "inbox: other");
    expect(onRemote("diff-tree", "--no-commit-id", "--name-only", "-r", next)).toBe("other.md");
    expect(onRemote("log", "-1", "--format=%s", next)).toBe("inbox: other");
    expect(a.read(FILE)).toBe(`${HEAD}- first idea\n`);
  });

  it("keeps both lines when two clones write at once: the loser rebuilds on the new tip", () => {
    const a = store("a");
    const b = store("b");
    a.write(FILE, add("base"), "base");
    b.read(FILE);
    const logged = [];
    let raced = false;
    // b's edit runs on the tip it fetched; a pushes in between, so b's first push is refused.
    const sha = b.write(
      FILE,
      (text) => {
        if (!raced) {
          raced = true;
          a.write(FILE, add("from a"), "a's line");
        }
        return add("from b")(text);
      },
      "b's line",
      { log: (l) => logged.push(l) },
    );
    expect(sha).toBe(onRemote("rev-parse", BRANCH));
    expect(a.read(FILE)).toBe(`${HEAD}- base\n- from a\n- from b\n`);
    expect(commits()).toBe(3);
    expect(logged).toEqual(["the inbox store moved; building the edit on its new tip"]);
  });

  it("gives up after five refused pushes, with nothing written", () => {
    const a = store();
    a.write(FILE, add("base"), "base");
    const hook = join(remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    onRemote("config", "core.hooksPath", join(remote, "hooks"));
    let edits = 0;
    const tried = () =>
      a.write(
        FILE,
        (t) => {
          edits++;
          return add("refused")(t);
        },
        "m",
        { log: quiet },
      );
    expect(tried).toThrow(StoreError);
    expect(tried).toThrow(/refused 5 pushes.*nothing was written/);
    expect(edits).toBe(2 * TRIES);
    expect(commits()).toBe(1);
    expect(a.read(FILE)).toBe(`${HEAD}- base\n`);
  });

  it("reads the last copy with the remote gone, and refuses a write then", () => {
    const a = store();
    a.write(FILE, add("kept"), "m");
    renameSync(remote, `${remote}-gone`);
    expect(a.read(FILE)).toBe(`${HEAD}- kept\n`);
    expect(() => a.write(FILE, add("lost"), "m")).toThrow(/couldn't fetch.*nothing was written/);
  });

  it("commits nothing for an edit that changes nothing", () => {
    const a = store();
    a.write(FILE, add("one"), "m");
    expect(a.write(FILE, (t) => t, "m")).toBeNull();
    expect(store("b").write("none.md", () => null, "m")).toBeNull();
    expect(commits()).toBe(1);
  });

  it("makes no fetch for a read with fetch: false: the clone's last fetched copy", () => {
    const a = store("a");
    a.write(FILE, add("one"), "m");
    store("b").write(FILE, add("two"), "m");
    expect(a.read(FILE, { fetch: false })).toBe(`${HEAD}- one\n`);
    expect(a.read(FILE)).toBe(`${HEAD}- one\n- two\n`);
    expect(store("c").read(FILE, { fetch: false })).toBeNull();
    expect(existsSync(store("c").dir)).toBe(false);
  });
});
