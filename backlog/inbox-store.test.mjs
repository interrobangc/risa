// The inbox store: a temp bare repo stands in for the private one, and each clone's
// folder is the test's own (RISA_INBOX_STORE), never ~/.risa.
import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRANCH, StoreError, TRIES, cloneName, findStoreRepo, storeFor, storeRoot } from "./inbox-store.mjs";

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
    expect(cloneName("git@github.com:me/ideas.git")).toMatch(/^github\.com-me-ideas-[0-9a-f]{8}$/);
    expect(cloneName("https://github.com/me/ideas.git")).toMatch(/^github\.com-me-ideas-[0-9a-f]{8}$/);
    const s = store();
    expect(s.dir.startsWith(join(root, "clones-a"))).toBe(true);
    expect(existsSync(s.dir)).toBe(false);
    expect(s.read(FILE)).toBeNull();
    expect(existsSync(join(s.dir, "HEAD"))).toBe(true);
  });

  it("gives URLs that fold to one safe name clones of their own (a hash of the URL)", () => {
    const [a, b] = ["git@github.com:a/b-c.git", "git@github.com:a-b/c.git"];
    expect(cloneName(a).replace(/-[0-9a-f]{8}$/, "")).toBe(cloneName(b).replace(/-[0-9a-f]{8}$/, ""));
    expect(cloneName(a)).not.toBe(cloneName(b));
    expect(cloneName(a)).toBe(cloneName(a));
  });

  it("works from a relative RISA_INBOX_STORE: the clone and its temp index are at absolute paths", () => {
    const rel = relative(process.cwd(), join(root, "clones-rel"));
    expect(isAbsolute(rel)).toBe(false);
    const s = storeFor(remote, { env: { RISA_INBOX_STORE: rel } });
    expect(s.dir).toBe(join(root, "clones-rel", cloneName(remote)));
    expect(s.write(FILE, add("relative"), "m")).toMatch(/^[0-9a-f]{40}$/);
    expect(s.read(FILE)).toBe(`${HEAD}- relative\n`);
  });

  it("ends on one clone when processes make it at once: each loser uses the winner's", async () => {
    const clones = join(root, "clones-race");
    const url = new URL("./inbox-store.mjs", import.meta.url).href;
    const script = `const m = await import(${JSON.stringify(url)}); console.log(String(m.storeFor(process.argv[1]).read(${JSON.stringify(FILE)})));`;
    store("seed").write(FILE, add("seen"), "m");
    const outs = await Promise.all(
      Array.from({ length: 6 }, () =>
        promisify(execFile)("node", ["--input-type=module", "-e", script, remote], {
          env: { ...process.env, RISA_INBOX_STORE: clones },
        }),
      ),
    );
    for (const { stdout } of outs) expect(stdout).toBe(`${HEAD}- seen\n\n`);
    expect(readdirSync(clones)).toEqual([cloneName(remote)]);
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

  it("forgets the old tip when the remote is found empty: no stale read, and a write starts the branch", () => {
    const a = store();
    a.write(FILE, add("old"), "m");
    rmSync(remote, { recursive: true, force: true });
    execFileSync("git", ["init", "-q", "--bare", remote]);
    expect(a.read(FILE)).toBeNull();
    const sha = a.write(FILE, add("new"), "m");
    expect(onRemote("rev-list", "--parents", "-1", BRANCH)).toBe(sha);
    expect(a.read(FILE)).toBe(`${HEAD}- new\n`);
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

describe("finding the store", () => {
  it("counts two clones of one URL as one store (RISA-1067)", () => {
    const clones = join(root, "clones-a");
    const env = { RISA_INBOX_STORE: clones, RISA_MACHINE_CONFIG: join(root, "no-machine.json") };
    store("a").read(FILE);
    cpSync(join(clones, cloneName(remote)), join(clones, "an-older-name"), { recursive: true });
    expect(readdirSync(clones)).toHaveLength(2);
    expect(findStoreRepo({ env })).toBe(remote);
    storeFor(join(root, "other.git"), { env }).read(FILE);
    expect(() => findStoreRepo({ env })).toThrow(/holds 2 clones/);
  });
});
