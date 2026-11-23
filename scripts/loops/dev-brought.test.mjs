// What dev brought since the last sync (dev-brought.mjs), over throwaway repositories.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { devBrought, riskyKind } from "./dev-brought.mjs";

const HERE = new URL(".", import.meta.url).pathname;

let root;
let repo;
let n = 0;
const git = (...args) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
const write = (file, text = `${++n}\n`) => {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), text);
};
const commit = (...files) => {
  for (const f of files) write(f);
  git("add", "-A");
  git("commit", "-qm", `change ${files.join(" ")}`);
  return git("rev-parse", "HEAD");
};
const on = (branch) => git("checkout", "-q", branch);

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "dev-brought-")));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

// dev and branch, both at one first commit holding the files the tests edit.
beforeEach(() => {
  repo = mkdtempSync(join(root, "repo-"));
  execFileSync("git", ["init", "-q", "-b", "dev", repo]);
  git("config", "user.email", "loop@example.test");
  git("config", "user.name", "Loop");
  git("config", "commit.gpgsign", "false");
  commit("shared.ts", "other.ts", "plans/backlog.md", "plans/inbox.md");
  git("branch", "branch");
});

describe("devBrought", () => {
  it("finds no shared or risky file when dev changed other files", () => {
    on("branch");
    commit("mine.ts");
    on("dev");
    const sha = commit("theirs.ts");
    const v = devBrought(repo, "dev", "branch");
    expect(v).toMatchObject({
      answered: true,
      branchFiles: ["mine.ts"],
      devFiles: ["theirs.ts"],
      commits: [sha],
      drift: true,
      shared: [],
      risky: [],
      refusal: null,
    });
  });

  it("names a shared file", () => {
    on("branch");
    commit("shared.ts");
    on("dev");
    commit("shared.ts");
    const v = devBrought(repo, "dev", "branch");
    expect(v.shared).toEqual(["shared.ts"]);
    expect(v.refusal).toBe("dev changed shared.ts, which the branch touches");
  });

  it.each(["plans/backlog.md", "plans/inbox.md", "plans/backlog-archive.md"])(
    "doesn't count %s as shared",
    (file) => {
      on("branch");
      commit(file);
      on("dev");
      commit(file);
      expect(devBrought(repo, "dev", "branch")).toMatchObject({ drift: false, shared: [], refusal: null });
    },
  );

  it.each([
    ["packages/data/src/db/migrations/0100_x.sql", "a migration"],
    ["packages/data/src/seeds/people.ts", "seeds"],
    ["powersync/sync-config.yaml", "the sync config"],
    ["pnpm-lock.yaml", "the lockfile"],
    ["apps/web/package.json", "a package.json"],
    ["vitest.config.ts", "the Vitest config"],
    ["packages/data/test/setup.ts", "test setup"],
    ["apps/web/test/setup.ts", "test setup"],
    ["apps/web/vite.config.ts", "a Vite config"],
    ["tsconfig.base.json", "a TypeScript config"],
    ["packages/api/tsconfig.json", "a TypeScript config"],
    ["pnpm-workspace.yaml", "the pnpm workspace"],
    ["eslint.config.js", "the ESLint config"],
    ["scripts/eslint/plugin.mjs", "the ESLint rules"],
    [".prettierrc.json", "the Prettier config"],
    [".prettierignore", "the Prettier config"],
  ])("names %s on dev's side as %s", (file, kind) => {
    on("branch");
    commit("mine.ts");
    on("dev");
    commit(file);
    const v = devBrought(repo, "dev", "branch");
    expect(v.risky).toEqual([{ file, kind }]);
    expect(v.refusal).toBe(`dev brought ${kind} (${file})`);
  });

  it("leaves Markdown and CI's two lists off the risky list", () => {
    expect(riskyKind("packages/data/src/seeds/notes.md")).toBeNull();
    expect(riskyKind("scripts/ci/quarantine.txt")).toBeNull();
    expect(riskyKind("scripts/ci/brake-list.txt")).toBeNull();
    expect(riskyKind("scripts/ci/gate.mjs")).toBe("scripts/ci");
    expect(riskyKind("apps/web/app/routes/home.tsx")).toBeNull();
  });

  it("doesn't call a dev that moved only CI's lists drift", () => {
    on("branch");
    commit("mine.ts");
    on("dev");
    commit("scripts/ci/quarantine.txt");
    expect(devBrought(repo, "dev", "branch")).toMatchObject({ drift: false, risky: [], refusal: null });
  });

  it("treats dev renaming a file the branch edits as shared", () => {
    write("big.ts", Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"));
    git("add", "-A");
    git("commit", "-qm", "a file to rename");
    git("branch", "-f", "branch", "HEAD");
    on("branch");
    commit("big.ts");
    on("dev");
    git("mv", "big.ts", "moved.ts");
    git("commit", "-qm", "rename");
    const v = devBrought(repo, "dev", "branch");
    expect(v.devFiles).toEqual(["big.ts", "moved.ts"]);
    expect(v.shared).toEqual(["big.ts"]);
  });

  it("reports no drift on a synced branch", () => {
    on("dev");
    commit("theirs.ts");
    on("branch");
    git("merge", "-q", "--no-ff", "-m", "merge dev", "dev");
    commit("mine.ts");
    expect(devBrought(repo, "dev", "branch")).toMatchObject({
      answered: true,
      devFiles: [],
      commits: [],
      drift: false,
      refusal: null,
    });
  });

  it("counts only dev's commits since the last of several syncs", () => {
    for (const file of ["first.ts", "second.ts"]) {
      on("dev");
      commit(file);
      on("branch");
      git("merge", "-q", "--no-ff", "-m", "merge dev", "dev");
    }
    commit("mine.ts");
    on("dev");
    const sha = commit("third.ts");
    expect(devBrought(repo, "dev", "branch")).toMatchObject({
      branchFiles: ["mine.ts"],
      devFiles: ["third.ts"],
      commits: [sha],
    });
  });

  it("counts dev's merges once, along its first parent", () => {
    on("dev");
    git("checkout", "-qb", "side");
    commit("side-1.ts");
    commit("side-2.ts");
    on("dev");
    git("merge", "-q", "--no-ff", "-m", "land side", "side");
    const merge = git("rev-parse", "HEAD");
    const v = devBrought(repo, "dev", "branch");
    expect(v.commits).toEqual([merge]);
    expect(v.devFiles).toEqual(["side-1.ts", "side-2.ts"]);
  });

  it("refuses a missing ref, naming it", () => {
    expect(devBrought(repo, "origin/nope", "branch")).toEqual({
      answered: false,
      refusal: "origin/nope isn't in this checkout",
    });
    expect(devBrought(repo, "dev", "nope")).toEqual({
      answered: false,
      refusal: "nope isn't in this checkout",
    });
  });

  it("refuses a directory that isn't a repository", () => {
    const v = devBrought(mkdtempSync(join(root, "plain-")), "dev", "branch");
    expect(v.answered).toBe(false);
  });

  it("refuses unrelated histories", () => {
    git("checkout", "-q", "--orphan", "alone");
    commit("alone.ts");
    expect(devBrought(repo, "dev", "alone")).toEqual({
      answered: false,
      refusal: "alone shares no history with dev",
    });
  });

  it("refuses criss-crossed merges, which have no one last sync", () => {
    on("dev");
    const d = commit("d.ts");
    on("branch");
    const b = commit("b.ts");
    git("merge", "-q", "--no-ff", "-m", "merge dev", d);
    on("dev");
    git("merge", "-q", "--no-ff", "-m", "merge branch", b);
    const v = devBrought(repo, "dev", "branch");
    expect(v.answered).toBe(false);
    expect(v.refusal).toContain("2 merge bases");
  });
});

describe("the command line", () => {
  const cli = (...args) =>
    spawnSync(process.execPath, [join(HERE, "dev-brought.mjs"), ...args], { encoding: "utf8" });

  it("prints the verdict as JSON and exits 0, a refusal included", () => {
    on("branch");
    commit("shared.ts");
    on("dev");
    commit("shared.ts");
    const r = cli("--repo", repo, "--dev", "dev", "--tip", "branch");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ answered: true, shared: ["shared.ts"] });
  });

  it("exits 2 on a missing argument", () => {
    expect(cli("--repo", repo).status).toBe(2);
  });
});
