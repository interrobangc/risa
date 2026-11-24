// `pnpm backlog prd` and the registry's doctor findings end to end, against a
// throwaway repo: a "main checkout" on dev plus a prd/ worktree.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI = new URL("./backlog.mjs", import.meta.url).pathname;
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();
const env = { ...process.env, BACKLOG_BY: "", GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test" };
const cli = (cwd, ...a) =>
  execFileSync("node", [CLI, ...a], { cwd, encoding: "utf8", env, stdio: "pipe" }).trim();
/** stdout and stderr of a command that fails, with its exit code. */
const cliFails = (cwd, ...a) => {
  try {
    execFileSync("node", [CLI, ...a], { cwd, encoding: "utf8", env, stdio: "pipe" });
  } catch (e) {
    return { out: `${e.stdout}${e.stderr}`, code: e.status };
  }
  throw new Error("expected the command to fail");
};

// The table before the registry (refused), and the registry's (written by hand in a test).
const OLD_TABLE = `| PRD | Doc | Depends on | Hot files |
| --- | --- | ---------- | --------- |
| \`alpha\` | [PRD](alpha-prd.md): **done** (\`abc1234\`) | — | none now |
| \`beta\` | [plan](beta-plan.md): 3 slices | \`alpha\` | \`scripts/loops/\` |
| \`gamma\` | to write (B-2) | (none) | none now |
| \`fixes-x\` | standing fixes | — | — |
`;
const NEW_TABLE = `| PRD | Flags | After | Hot files | Doc and notes |
| --- | ----- | ----- | --------- | ------------- |
| \`alpha\` | done | — | — | [PRD](alpha-prd.md): **done** (\`abc1234\`) |
| \`beta\` | — | — | — | [plan](beta-plan.md): 3 slices |
| \`gamma\` | — | — | — | to write (B-2) |
| \`fixes-x\` | — | — | — | standing fixes |
`;
const BACKLOG = `# Backlog tracker

Intro.

## PRDs

Which PRDs exist.

${OLD_TABLE}
## Items

### B-1 · bug · Something in beta

- status: triaged
- prd: beta

### B-2 · feature · A gamma thing

- status: triaged
- prd: gamma

### B-3 · bug · A fix

- status: triaged
- prd: fixes-x
`;

let root, main, prd;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "registry-test-")));
  main = join(root, "repo");
  prd = join(root, "prd-beta");
  execFileSync("git", ["init", "-q", "-b", "dev", main]);
  git(main, "config", "user.email", "test@example.com");
  git(main, "config", "user.name", "Test");
  git(main, "config", "commit.gpgsign", "false");
  mkdirSync(join(main, "plans"));
  writeFileSync(join(main, "plans/backlog.md"), BACKLOG);
  writeFileSync(join(main, "plans/beta-plan.md"), "# Plan: beta\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  git(main, "worktree", "add", "-q", "-b", "prd/beta", prd);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const file = () => readFileSync(join(main, "plans/backlog.md"), "utf8");
const lastMessage = () => git(main, "log", "-1", "--format=%s%n%b");
const order = () => JSON.parse(cli(prd, "prd", "list", "--json")).map((r) => r.topic);

describe("backlog prd", () => {
  it("refuses the old prose table, and the rest works as before; there is no migrate", () => {
    const r = cliFails(prd, "prd", "list");
    expect(r.code).toBe(1);
    expect(r.out).toContain("the PRD table is in the old prose form");
    expect(cliFails(prd, "prd", "set", "beta", "flags=hold").out).toContain("old prose form");
    expect(cliFails(prd, "prd", "migrate").out).toContain(
      'unknown prd command "migrate" (list, add, set, move)',
    );
    expect(cli(prd, "list")).toContain("B-1");
  });

  it("reads the registry's table once it is written by hand", () => {
    writeFileSync(join(main, "plans/backlog.md"), file().replace(OLD_TABLE, NEW_TABLE));
    git(main, "commit", "-q", "-am", "chore(backlog): the registry's columns");
    expect(order()).toEqual(["alpha", "beta", "gamma", "fixes-x"]);
    expect(git(prd, "status", "--porcelain")).toBe("");
  });

  it("lists each topic with its worked-out state", () => {
    const rows = JSON.parse(cli(prd, "prd", "list", "--json"));
    expect(rows.map((r) => [r.topic, r.state])).toEqual([
      ["alpha", "done"],
      ["beta", "running"],
      ["gamma", "to-write"],
      ["fixes-x", "to-write"],
    ]);
    const text = cli(prd, "prd", "list").split("\n");
    expect(text[0]).toMatch(/^PRD\s+STATE\s+FLAGS\s+AFTER\s+WAITING\s+HOT FILES$/);
    expect(text[2]).toMatch(/^beta\s+running\s+—\s+—\s+1\s+—$/);
  });

  it("sets a row in one commit, and standing gives planned with items", () => {
    expect(cli(prd, "prd", "set", "fixes-x", "flags=standing", "hot=scripts/loops/,apps/web/x.ts")).toBe(
      "updated fixes-x",
    );
    expect(lastMessage()).toMatch(/^chore\(backlog\): prd set fixes-x: flags=standing, hot=scripts\/loops\//);
    expect(lastMessage()).toMatch(/By: prd\/beta\n\nBacklog-Tool: prd set$/);
    expect(git(main, "show", "--name-only", "--format=", "HEAD")).toBe("plans/backlog.md");
    const fixes = JSON.parse(cli(prd, "prd", "list", "--json")).find((r) => r.topic === "fixes-x");
    expect(fixes).toMatchObject({
      state: "planned",
      flags: ["standing"],
      hot: ["scripts/loops/", "apps/web/x.ts"],
    });
    expect(cliFails(prd, "prd", "set", "fixes-x", "flags=paused").out).toContain("unknown flag paused");
  });

  it("holds and releases with flags+= and flags-=, keeping standing", () => {
    const flags = () =>
      JSON.parse(cli(prd, "prd", "list", "--json")).find((r) => r.topic === "fixes-x").flags;
    cli(prd, "prd", "set", "fixes-x", "flags+=hold");
    expect(flags()).toEqual(["standing", "hold"]);
    expect(lastMessage()).toContain("prd set fixes-x: flags+=hold");
    // Holding a held row changes nothing: no commit.
    const head = git(main, "rev-parse", "HEAD");
    cli(prd, "prd", "set", "fixes-x", "flags+=hold");
    expect(git(main, "rev-parse", "HEAD")).toBe(head);
    cli(prd, "prd", "set", "fixes-x", "flags-=hold");
    expect(flags()).toEqual(["standing"]);
  });

  it("adds rows where it's told", () => {
    cli(prd, "prd", "add", "delta");
    cli(
      prd,
      "prd",
      "add",
      "epsilon",
      "--before",
      "gamma",
      "after=beta",
      "flags=hold",
      "notes=waits on the user",
    );
    expect(order()).toEqual(["alpha", "beta", "epsilon", "gamma", "fixes-x", "delta"]);
    expect(file()).toContain("| `epsilon` | hold | `beta` | — | waits on the user |");
    expect(cliFails(prd, "prd", "add", "delta").out).toContain("already a PRD row");
  });

  it("moves in all four forms", () => {
    cli(prd, "prd", "move", "delta", "--first");
    expect(order()).toEqual(["delta", "alpha", "beta", "epsilon", "gamma", "fixes-x"]);
    cli(prd, "prd", "move", "delta", "--last");
    expect(order()).toEqual(["alpha", "beta", "epsilon", "gamma", "fixes-x", "delta"]);
    cli(prd, "prd", "move", "delta", "--before", "alpha");
    expect(order()).toEqual(["delta", "alpha", "beta", "epsilon", "gamma", "fixes-x"]);
    expect(cli(prd, "prd", "move", "delta", "--after", "gamma")).toBe("moved delta after gamma");
    expect(order()).toEqual(["alpha", "beta", "epsilon", "gamma", "delta", "fixes-x"]);
    expect(cliFails(prd, "prd", "move", "delta").out).toContain("where to?");
    expect(cliFails(prd, "prd", "move", "delta", "--first", "--last").out).toContain("give one of");
  });

  it("leaves the items, the summary and backlog list alone", () => {
    expect(file()).toContain("| B-3 | bug | triaged | fixes-x |  | A fix |");
    expect(cli(prd, "list").split("\n")).toHaveLength(4);
    expect(cli(main, "doctor")).toBe("backlog ok");
  });

  // The After cells are written by hand in one commit: `prd set` is tested above,
  // and each CLI write is a node start and about 25 git commands, which put
  // this test past its 20 s timeout under load.
  it("doctor reports the registry's findings and --fix touches none", () => {
    const after = { alpha: "`ghost`", gamma: "`delta`", delta: "`gamma`" };
    const rows = file().replace(/^\| `([a-z-]+)` \|([^|]*)\|[^|]*\|/gm, (row, topic, flags) =>
      topic in after ? `| \`${topic}\` |${flags}| ${after[topic]} |` : row,
    );
    writeFileSync(join(main, "plans/backlog.md"), rows);
    git(main, "commit", "-q", "-am", "chore(backlog): after cells by hand");
    cli(prd, "add", "bug", "Orphan", "--prd", "nowhere");
    cli(prd, "add", "bug", "Late", "--prd", "alpha");
    const expected = [
      'alpha  comes after "ghost", which has no row in the PRD table',
      "gamma  is in a cycle of After: gamma → delta → gamma",
      "nowhere  has 1 waiting item (B-4) but no row in the PRD table",
      "B-5  is triaged, but its topic alpha is done",
      "4 findings",
    ];
    const r = cliFails(main, "doctor");
    expect(r.code).toBe(1);
    expect(r.out.trim().split("\n")).toEqual(expected);
    expect(cliFails(main, "doctor", "--fix").out.trim().split("\n")).toEqual(expected);
  });
});
