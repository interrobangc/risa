// docs_only (lib.sh), CI's lists on dev, and land.sh's PR path, doc budget,
// to-test file, landing notice and run log: a Markdown-only prd/ diff lands with
// no Codex verdict, a code diff still needs one. The throwaway repo is
// land-fixture.mjs's. The rest of land.sh's tests: land-gate (the CI gate),
// land-unsynced (an unsynced tip), land-force-resume (--force, --no-review and
// --resume), split so Vitest's workers spread them.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { FIXTURE_CONFIG } from "./config-fixture.mjs";
import { root, repo, git, commit, landWith, land, branch, useLandRepo } from "./land-fixture.mjs";

useLandRepo();

const docsOnly = () =>
  spawnSync("bash", ["-c", "source scripts/loops/lib.sh && docs_only dev feature"], {
    cwd: repo,
    encoding: "utf8",
  }).status === 0;

describe("docs_only", () => {
  const onFeature = (files) => {
    git("checkout", "-q", "feature");
    commit(files, "t");
  };
  it("is true when only Markdown changes, anywhere", () => {
    onFeature({ "docs/x.md": "d", "plans/p.md": "p", "AGENTS.md": "a" });
    expect(docsOnly()).toBe(true);
  });
  it("is false with one .mjs or .sh file among the Markdown", () => {
    onFeature({ "docs/x.md": "d", "scripts/loops/t.mjs": "x" });
    expect(docsOnly()).toBe(false);
    git("reset", "-q", "--hard", "dev");
    onFeature({ "docs/x.md": "d", "scripts/loops/t.sh": "x" });
    expect(docsOnly()).toBe(false);
  });
  it("is false when a code file is renamed to .md, true for a Markdown rename", () => {
    git("checkout", "-q", "feature");
    git("mv", "apps/web/a.ts", "apps/web/a.md");
    git("commit", "-qm", "rename code");
    expect(docsOnly()).toBe(false);
    git("reset", "-q", "--hard", "dev");
    git("mv", "README.md", "NOTES.md");
    git("commit", "-qm", "rename docs");
    expect(docsOnly()).toBe(true);
  });
  it("is false for an empty diff", () => {
    git("checkout", "-q", "feature");
    expect(docsOnly()).toBe(false);
  });
});

describe("CI's two lists on dev", () => {
  const LISTS = ["scripts/ci/quarantine.txt", "scripts/ci/brake-list.txt"];
  const lib = (/** @type {string} */ body) =>
    spawnSync("bash", ["-c", `source scripts/loops/lib.sh && ${body}`], { cwd: repo, encoding: "utf8" });

  it.each(LISTS)("a dev commit changing only %s is not drift", (list) => {
    branch({ "apps/web/b.ts": "2" });
    commit({ [list]: "a line\n" }, "chore(backlog): filed from CI");
    expect(lib("trunk_drift prd/throwaway-x").stdout).toBe("");
    commit({ "apps/web/a.ts": "changed" }, "real work");
    expect(lib("trunk_drift prd/throwaway-x").stdout.trim()).toBe("apps/web/a.ts");
  });

  it("names the lists dev changed and the branch didn't, for sync to take", () => {
    branch({ "apps/web/b.ts": "2" });
    expect(lib("trunk_lists prd/throwaway-x").stdout).toBe("");
    commit({ "scripts/ci/quarantine.txt": "a line\n", "apps/web/a.ts": "changed" }, "dev work");
    expect(lib("trunk_lists prd/throwaway-x").stdout.trim()).toBe("scripts/ci/quarantine.txt");
    git("checkout", "-q", "prd/throwaway-x");
    commit({ "scripts/ci/quarantine.txt": "its own\n" }, "the branch's own list");
    git("checkout", "-q", "dev");
    expect(lib("trunk_lists prd/throwaway-x").stdout).toBe("");
  });

  it.each(LISTS)("a commit changing only %s keeps a recorded pass", (list) => {
    git("checkout", "-qb", "prd/throwaway-x");
    commit({ "apps/web/b.ts": "2" }, "work");
    const checked = git("rev-parse", "HEAD");
    writeFileSync(join(git("rev-parse", "--absolute-git-dir"), "caretook-checked"), `${checked} full\n`);
    commit({ [list]: "a line\n" }, "chore(ci): the list");
    expect(lib("checked_ok . prd/throwaway-x").status).toBe(0);
    expect(lib("checked_how . prd/throwaway-x").stdout).toContain(`full on ${checked.slice(0, 7)}`);
    commit({ "apps/web/b.ts": "3" }, "more work");
    expect(lib("checked_ok . prd/throwaway-x").status).not.toBe(0);
  });

  it("a branch changing only a list still needs a check", () => {
    branch({ "scripts/ci/quarantine.txt": "a line\n" });
    expect(lib("checked_ok . prd/throwaway-x").status).not.toBe(0);
  });
});

describe("land.sh on the PR path", () => {
  it("lands a Markdown-only PR with no verdict, and says so", () => {
    branch({ "docs/x.md": "d" });
    const r = land();
    expect(r.stdout).toContain("no Codex verdict needed");
    expect(r.stdout).toContain("It would push");
    expect(r.status).toBe(0);
  });

  it("still refuses a code PR without a clean verdict", () => {
    branch({ "docs/x.md": "d", "scripts/loops/t.mjs": "x" });
    const r = land("--force", "--by-user");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Codex's verdict on PR #7 isn't clean/);
  });

  it("still needs the PR's head to be the local tip", () => {
    branch({ "docs/x.md": "d" });
    const r = spawnSync("bash", ["scripts/loops/land.sh", "throwaway-x"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        CARETOOK_PR_THROWAWAY: "1",
        PR_HEAD: "0".repeat(40),
      },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("local tip");
  });

  // Codex finished clean on `sha`: its summary comment, as PR_COMMENTS.
  const reviewedClean = (sha) => ({
    PR_COMMENTS: JSON.stringify([
      {
        author: { login: "chatgpt-codex-connector" },
        body: `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: sha, status: "completed" } })} -->`,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]),
  });
  // A code branch Codex reviewed clean, then dev moved (another file) and the branch merged it.
  const reviewedThenSynced = () => {
    branch({ "apps/web/b.ts": "2" });
    const reviewed = git("rev-parse", "prd/throwaway-x");
    commit({ "apps/web/dev.ts": "dev moved" }, "dev work");
    git("push", "-q", "origin", "dev");
    git("checkout", "-q", "prd/throwaway-x");
    git("merge", "-q", "--no-ff", "-m", "chore(throwaway-x): merge dev", "dev");
    git("checkout", "-q", "dev");
    return reviewed;
  };

  it("lands on a clean verdict carried over a dev merge, pinned to the merged tip", () => {
    const reviewed = reviewedThenSynced();
    const tip = git("rev-parse", "prd/throwaway-x");
    const r = landWith(reviewedClean(reviewed), "--force", "--by-user");
    expect(r.stdout).toContain(`codex: clean on ${tip.slice(0, 7)} (carried from ${reviewed.slice(0, 7)}`);
    expect(r.stdout).toContain(`--match-head-commit ${tip}`);
    expect(r.status).toBe(0);
  });

  it("refuses a stale verdict when the branch added work after the dev merge", () => {
    const reviewed = reviewedThenSynced();
    git("checkout", "-q", "prd/throwaway-x");
    commit({ "apps/web/b.ts": "3" }, "more work");
    git("checkout", "-q", "dev");
    const r = landWith(reviewedClean(reviewed), "--force", "--by-user");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(
      /Codex's verdict on PR #7 isn't clean \(codex: stale .*not carried: .* isn't a merge of/,
    );
  });
});

// The real merge: the stubbed `gh pr merge` pushes the branch to origin/dev (or
// fails), so land.sh runs its whole PR path in the temporary main checkout.
// The gate, through the real ci.mjs against the stubbed runs: a real merge, so
// "filed after the merge" and "nothing landed" are what git says.

describe("land.sh's doc budget", () => {
  // A copy of the config with a change, its data files beside it.
  const withConfig = (change) => {
    const raw = JSON.parse(readFileSync(FIXTURE_CONFIG, "utf8"));
    change(raw);
    writeFileSync(join(root, "budget.json"), JSON.stringify(raw));
    for (const rel of [raw.paths.tierData, raw.paths.checkPlanRules]) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      cpSync(join(dirname(FIXTURE_CONFIG), rel), join(root, rel));
    }
    return { RISA_CONFIG: join(root, "budget.json") };
  };

  it("tells a budget hook that failed to run from a breach", () => {
    branch({ "docs/x.md": "d" });
    const breach = landWith(withConfig((c) => (c.hooks.docBudget = "sh -c 'exit 1'")));
    expect(breach.status).not.toBe(0);
    expect(breach.stderr).toContain("grows a doc that is over its budget");
    const broken = landWith(withConfig((c) => (c.hooks.docBudget = "sh -c 'exit 3'")));
    expect(broken.status).not.toBe(0);
    expect(broken.stderr).toContain("the doc budget (the config's docBudget hook) failed to run (exit 3)");
    expect(broken.stderr).not.toContain("grows a doc");
  });

  it("refuses on a mistyped hooks key instead of skipping the budget", () => {
    branch({ "docs/x.md": "d" });
    const r = landWith(
      withConfig((c) => {
        c.hooks.docBuget = c.hooks.docBudget;
        delete c.hooks.docBudget;
      }),
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/hooks\.docBuget: unknown key/);
    expect(r.stdout).not.toContain("It would push");
  });
});

describe("land.sh writes a to-test file", () => {
  const landFor = (mergeFails = false) =>
    spawnSync(
      "bash",
      [
        "scripts/loops/land.sh",
        "throwaway-x",
        "-m",
        "feat(throwaway-x): t (B-1)",
        "--force",
        "--no-review",
        "--by-user",
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          PR_HEAD: git("rev-parse", "prd/throwaway-x"),
          GH_MERGE_FAIL: mergeFails ? "1" : "",
        },
      },
    );
  const files = () => (existsSync(join(repo, "to-test")) ? readdirSync(join(repo, "to-test")) : []);

  it("writes one file with its parts after a code landing", () => {
    branch({ "apps/web/b.ts": "2", "plans/throwaway-x-prd.md": "# PRD: Throwaway (a test topic)\n" });
    const r = landFor();
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(files()).toHaveLength(1);
    expect(files()[0]).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-throwaway-x\.md$/);
    const text = readFileSync(join(repo, "to-test", files()[0]), "utf8");
    for (const part of [
      "# Landed: Throwaway (a test topic)",
      "feat(throwaway-x): t (B-1)",
      "- B-1 A throwaway feature",
      "- work (`",
      "https://example.test/pr/7",
      "## What landed",
      "## What to try, and where",
      "http://localhost:5173",
      "apps/web/b.ts",
      "the check was skipped (--force)",
      "merged without a clean Codex verdict (--no-review)",
      "## Follow-ups and still open",
      "- B-2 A follow-up bug",
    ])
      expect(text).toContain(part);
    expect(text).not.toContain("An earlier wave");
    expect(text).toContain(git("rev-parse", "--short", "dev"));
  });

  it("writes none after a docs-only landing", () => {
    branch({ "docs/x.md": "d" });
    const r = landFor();
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(files()).toEqual([]);
  });

  it("writes one after a local hotfix landing too, naming the local merge", () => {
    git("checkout", "-qb", "hotfix/throwaway-y");
    commit({ "apps/web/c.ts": "3" }, "fix it");
    git("checkout", "-q", "dev");
    const r = spawnSync(
      "bash",
      ["scripts/loops/land.sh", "hotfix/throwaway-y", "--local", "--force", "--by-user", "-m", "fix(web): c"],
      { cwd: repo, encoding: "utf8" },
    );
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(files()).toHaveLength(1);
    expect(files()[0]).toMatch(/-throwaway-y\.md$/);
    const text = readFileSync(join(repo, "to-test", files()[0]), "utf8");
    expect(text).toContain("# Landed: throwaway-y");
    expect(text).toContain("landed locally: no PR and no Codex review");
    expect(text).toContain(`as \`${git("rev-parse", "--short", "dev")}\``);
    expect(text).toContain("- fix it (`");
  });

  it("lists the landed items after a local landing: read before the merge makes them landed", () => {
    branch({ "apps/web/b.ts": "2" });
    const r = spawnSync(
      "bash",
      [
        "scripts/loops/land.sh",
        "throwaway-x",
        "--local",
        "--force",
        "--by-user",
        "-m",
        "feat(throwaway-x): t (B-1)",
      ],
      { cwd: repo, encoding: "utf8" },
    );
    expect(r.status, r.stderr + r.stdout).toBe(0);
    // The stub backlog now reads B-1 as landed: dev holds its commit.
    expect(git("merge-base", "--is-ancestor", "prd/throwaway-x", "dev")).toBe("");
    const text = readFileSync(join(repo, "to-test", files()[0]), "utf8");
    expect(text).toMatch(/## What landed\n\n- B-1 A throwaway feature\n/);
    expect(text).not.toContain("(none marked done)");
  });

  it("gives a tooling-only landing the commands to try, not the app's URL and sign-ins", () => {
    branch({ "scripts/loops/x.sh": "echo x", "scripts/backlog/y.mjs": "1", "docs/x.md": "d" });
    const r = landFor();
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const text = readFileSync(join(repo, "to-test", files()[0]), "utf8");
    const tryPart = text.slice(text.indexOf("## What to try"), text.indexOf("## What wasn't checked"));
    expect(tryPart).toContain("Only docs and tooling changed");
    expect(tryPart).toContain("`pnpm prd help`");
    expect(tryPart).toContain("`pnpm backlog`");
    expect(tryPart).toContain("scripts/loops/x.sh");
    expect(tryPart).not.toContain("localhost");
    expect(tryPart).not.toContain("example.com");
  });

  it("an app file among the tooling still gets the app's URL", () => {
    branch({ "scripts/loops/x.sh": "echo x", "apps/web/b.ts": "2" });
    expect(landFor().status).toBe(0);
    const text = readFileSync(join(repo, "to-test", files()[0]), "utf8");
    expect(text).toContain("http://localhost:5173");
    expect(text).not.toContain("Only docs and tooling changed");
  });

  it("says each line of 'What wasn't checked' once", () => {
    branch({ "scripts/loops/x.sh": "echo x" });
    const r = spawnSync(
      "bash",
      ["scripts/loops/land.sh", "throwaway-x", "--local", "--tier", "none", "-m", "fix(throwaway-x): t"],
      { cwd: repo, encoding: "utf8" },
    );
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const text = readFileSync(join(repo, "to-test", files()[0]), "utf8");
    const part = text.slice(text.indexOf("## What wasn't checked"), text.indexOf("## Follow-ups"));
    const lines = part.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBeGreaterThan(1);
    expect(new Set(lines).size).toBe(lines.length);
    expect(part.match(/none needed/g)).toHaveLength(1);
  });

  it("writes none when the merge fails", () => {
    branch({ "apps/web/b.ts": "2" });
    const r = landFor(true);
    expect(r.status).not.toBe(0);
    expect(files()).toEqual([]);
  });
});

describe("land.sh posts a landing notice", () => {
  const board = () => join(root, "notices");
  const notices = () =>
    existsSync(board())
      ? readdirSync(board())
          .filter((f) => /^n\d+\.json$/.test(f))
          .map((f) => JSON.parse(readFileSync(join(board(), f), "utf8")))
      : [];
  const landFor = (args, extra = {}) =>
    spawnSync("bash", ["scripts/loops/land.sh", ...args], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        PR_HEAD: spawnSync("git", ["-C", repo, "rev-parse", "prd/throwaway-x"], {
          encoding: "utf8",
        }).stdout.trim(),
        CARETOOK_NOTICES_DIR: board(),
        ...extra,
      },
    });
  const prdLand = (extra) =>
    landFor(
      ["throwaway-x", "-m", "feat(throwaway-x): t (B-1)", "--force", "--no-review", "--by-user"],
      extra,
    );

  it("posts one for a code landing, with the topic and the commit, for six hours", () => {
    branch({ "apps/web/b.ts": "2" });
    const r = prdLand();
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const [n, ...more] = notices();
    expect(more).toEqual([]);
    expect(n).toMatchObject({ session: "prd-throwaway-x", topic: "throwaway-x" });
    expect(n.text).toContain(`landed prd/throwaway-x in dev as ${git("rev-parse", "--short", "origin/dev")}`);
    expect(n.text).toContain("sync at your next wave boundary");
    expect(Date.parse(n.expiresAt) - Date.parse(n.postedAt)).toBe(6 * 3600_000);
    expect(r.stdout).toContain("notice posted");
  });

  it("posts one for a local hotfix landing too", () => {
    git("checkout", "-qb", "hotfix/throwaway-y");
    commit({ "apps/web/c.ts": "3" }, "fix it");
    git("checkout", "-q", "dev");
    const r = landFor(["hotfix/throwaway-y", "--local", "--force", "--by-user", "-m", "fix(web): c"]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(notices()).toMatchObject([{ session: "hotfix-throwaway-y", topic: "throwaway-y" }]);
    expect(notices()[0].text).toContain(`as ${git("rev-parse", "--short", "dev")}`);
  });

  it("posts none for a Markdown-only landing or a plan/ landing", () => {
    branch({ "docs/x.md": "d" });
    expect(prdLand().status).toBe(0);
    git("checkout", "-qb", "plan/throwaway-z");
    commit({ "plans/throwaway-z-plan.md": "p", "scripts/loops/z.sh": "z" }, "plan it");
    git("checkout", "-q", "dev");
    const r = landFor(["plan/throwaway-z", "-m", "docs(throwaway-z): plan"]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(notices()).toEqual([]);
  });

  it("still lands when the notice can't be posted", () => {
    branch({ "apps/web/b.ts": "2" });
    writeFileSync(join(root, "not-a-dir"), "x");
    const r = prdLand({ CARETOOK_NOTICES_DIR: join(root, "not-a-dir", "notices") });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain("Landed prd/throwaway-x");
    expect(r.stderr).toContain("couldn't post the landing notice");
  });
});

describe("land.sh's run log", () => {
  const log = () => join(root, "run-log.jsonl");
  const events = () =>
    existsSync(log())
      ? readFileSync(log(), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  const landFor = (extra = {}) =>
    spawnSync(
      "bash",
      [
        "scripts/loops/land.sh",
        "throwaway-x",
        "-m",
        "feat(throwaway-x): t (B-1)",
        "--force",
        "--no-review",
        "--by-user",
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          PR_HEAD: git("rev-parse", "prd/throwaway-x"),
          CARETOOK_NOTICES_DIR: join(root, "notices"),
          CARETOOK_RUN_LOG: log(),
          ...extra,
        },
      },
    );

  it("records a landing's start and its end, landed", () => {
    branch({ "apps/web/b.ts": "2" });
    const r = landFor();
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const [start, end, ...more] = events();
    expect(more).toEqual([]);
    expect(start).toMatchObject({
      kind: "land-start",
      topic: "throwaway-x",
      branch: "prd/throwaway-x",
      path: "pr",
    });
    expect(end).toMatchObject({ kind: "land-end", topic: "throwaway-x", exit: 0, landed: true, path: "pr" });
    expect(end.seconds).toBeGreaterThanOrEqual(0);
  });

  it("records a failed landing's failure, with its exit", () => {
    branch({ "apps/web/b.ts": "2" });
    const r = landFor({ GH_MERGE_FAIL: "1" });
    expect(r.status).not.toBe(0);
    expect(events().map((e) => e.kind)).toEqual(["land-start", "land-end"]);
    expect(events()[1]).toMatchObject({ landed: false, exit: r.status });
  });

  it("a run log it can't write never stops a landing", () => {
    branch({ "apps/web/b.ts": "2" });
    writeFileSync(join(root, "not-a-dir"), "x");
    const r = landFor({ CARETOOK_RUN_LOG: join(root, "not-a-dir", "run-log.jsonl") });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain("Landed prd/throwaway-x");
  });
});

// The unsynced landing: dev moved on files the branch doesn't touch. A stub
// `pnpm` logs its steps, and the seam stops the PR path before the merge.
