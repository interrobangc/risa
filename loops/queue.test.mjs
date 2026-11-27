// `pnpm prd queue <topic>` (queue.mjs) against a throwaway repo with the loops
// and backlog scripts copied in: it moves the registry row first and returns
// with one line. A dispatcher is only its lock (this test's own pid); nothing
// here starts a session, a worktree or a dispatcher.
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queueLine } from "./queue.mjs";
import "./config-fixture.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();

const BACKLOG = `# Backlog tracker

## PRDs

| PRD | Flags | After | Hot files | Doc and notes |
| --- | ----- | ----- | --------- | ------------- |
| \`alpha\` | — | — | — | first |
| \`beta\` | — | — | — | second |
| \`gamma\` | — | \`alpha\` | — | third |

## Items
`;

let root, main, loops, env;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "queue-test-")));
  main = join(root, "repo");
  loops = join(main, ".loops");
  execFileSync("git", ["init", "-q", "-b", "dev", main]);
  for (const [k, v] of [
    ["user.email", "test@example.com"],
    ["user.name", "Test"],
    ["commit.gpgsign", "false"],
  ])
    git(main, "config", k, v);
  for (const d of ["loops", "backlog"]) {
    mkdirSync(join(main, d), { recursive: true });
    const from = join(HERE, "..", d);
    for (const f of readdirSync(from).filter((f) => /\.(mjs|sh)$/.test(f) && !f.includes(".test.")))
      copyFileSync(join(from, f), join(main, d, f));
  }
  mkdirSync(join(main, "plans"));
  writeFileSync(join(main, "plans/backlog.md"), BACKLOG);
  writeFileSync(join(main, ".gitignore"), ".loops/\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "chore: init");
  mkdirSync(loops);
  env = { ...process.env, TRUNK: "dev", BACKLOG_BY: "", GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test" };
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const queue = (...args) => {
  const r = spawnSync("bash", [join(main, "loops/prd.sh"), "queue", ...args], {
    cwd: main,
    encoding: "utf8",
    env,
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const order = () =>
  JSON.parse(
    execFileSync("node", [join(main, "backlog/backlog.mjs"), "prd", "list", "--json"], {
      cwd: main,
      encoding: "utf8",
      env,
    }),
  ).map((r) => r.topic);
const commits = () => Number(git(main, "rev-list", "--count", "HEAD"));
const lock = () => join(loops, ".dispatch.lock");

describe("queueLine", () => {
  it("says the dispatcher takes it, or that none runs, and whether it is paused", () => {
    expect(queueLine("t", { pid: null, moved: true })).toBe(
      "t is first in the PRD registry now, but no dispatcher is running: start one in a tab of its own (pnpm prd dispatch), or start t by hand (pnpm prd start t).",
    );
    expect(queueLine("t", { pid: 42, moved: true })).toBe(
      "t is first in the PRD registry now: the dispatcher (pid 42) takes it as soon as it may run (pnpm prd dispatch --dry-run says why not).",
    );
    expect(queueLine("t", { pid: 42, moved: false, paused: { why: "usage limit" } })).toBe(
      "t is already first in the PRD registry: the dispatcher (pid 42) takes it as soon as it may run (pnpm prd dispatch --dry-run says why not). It is paused (usage limit): pnpm prd dispatch --resume.",
    );
  });
});

describe("pnpm prd queue", () => {
  it("with no dispatcher: moves the row first in one backlog commit, prints one line, starts nothing", () => {
    const before = commits();
    const r = queue("gamma");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([
      "gamma is first in the PRD registry now, but no dispatcher is running: start one in a tab of its own (pnpm prd dispatch), or start gamma by hand (pnpm prd start gamma).",
    ]);
    expect(order()).toEqual(["gamma", "alpha", "beta"]);
    expect(commits()).toBe(before + 1);
    expect(git(main, "log", "-1", "--format=%s")).toBe("chore(backlog): prd move gamma first");
    // No worktree, ticket, lock or session: nothing waits and nothing starts.
    expect(readdirSync(loops)).toEqual([]);
    expect(git(main, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("with a dispatcher running: says it takes the topic, and returns", () => {
    writeFileSync(lock(), `${process.pid}\n`);
    try {
      const r = queue("beta");
      expect(r.code).toBe(0);
      expect(r.out).toBe(
        `beta is first in the PRD registry now: the dispatcher (pid ${process.pid}) takes it as soon as it may run (pnpm prd dispatch --dry-run says why not).`,
      );
      expect(order()).toEqual(["beta", "gamma", "alpha"]);
      // A lock whose pid is gone is no dispatcher.
      writeFileSync(lock(), "999999\n");
      expect(queue("alpha").out).toMatch(
        /^alpha is first in the PRD registry now, but no dispatcher is running/,
      );
    } finally {
      rmSync(lock(), { force: true });
    }
  });

  it("leaves a topic that is already first where it is, with no commit, and names a pause", () => {
    writeFileSync(lock(), `${process.pid}\n`);
    writeFileSync(join(loops, ".dispatch.json"), JSON.stringify({ paused: { at: "x", why: "usage limit" } }));
    try {
      const before = commits();
      const r = queue("alpha");
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/^alpha is already first in the PRD registry: the dispatcher/);
      expect(r.out).toMatch(/It is paused \(usage limit\): pnpm prd dispatch --resume\.$/);
      expect(commits()).toBe(before);
    } finally {
      rmSync(lock(), { force: true });
      rmSync(join(loops, ".dispatch.json"), { force: true });
    }
  });

  it("refuses an unknown topic, a bad name and the old options", () => {
    const before = commits();
    expect(queue("nope")).toMatchObject({ code: 1, err: expect.stringContaining('no PRD row "nope"') });
    expect(queue("Bad_Name").err).toContain("isn't a topic");
    expect(queue("alpha", "--manual")).toMatchObject({ code: 2, err: expect.stringContaining("no options") });
    expect(queue().code).toBe(2);
    expect(commits()).toBe(before);
    expect(existsSync(join(loops, ".queue"))).toBe(false);
  });

  it("is in pnpm prd help as a move to the front", () => {
    const help = spawnSync("bash", [join(main, "loops/prd.sh"), "help"], {
      encoding: "utf8",
      env,
    }).stdout;
    expect(help).toMatch(/^ {4}queue <topic> {2,}put the topic first in the PRD registry and return/m);
    expect(help).not.toContain("--manual");
    expect(help).toMatch(/^ {4}dispatch --pause \[<why>\]\|--resume\|--stop/m);
    expect(help).toMatch(/the dispatcher \(running, paused and why, stopped; its last line\)/);
    expect(help).toMatch(/record what's up \(the dispatcher too\), stop the\n\s+dispatcher/);
    expect(help).toMatch(/the dispatcher in a background\n\s+tab when it was running/);
  });
});
