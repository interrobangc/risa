// `pnpm prd ci promote` through `main`, on temp repositories: origin is a local bare
// repository and gh is a fixture that merges into it, so no test can reach GitHub.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REFUSED } from "./candidate.mjs";
import { EXIT, main } from "./ci.mjs";
import { applyFindings } from "./filing.mjs";
import { releasePasses } from "./gate.mjs";
import { tierData } from "./tier-data.mjs";

const { browserCheckFile } = tierData();

const BRANCH = "rc/20261123-1030";
const CI_REF = "ci/candidate/rc-20261123-1030";
const HELD = {
  number: 115,
  url: "https://example.test/pull/115",
  headRefName: "dev",
  headRefOid: "d".repeat(40),
  isCrossRepository: false,
};

const gitEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.test",
});

/** @type {string} */ let root;
/** @type {string} */ let repo;
/** @type {string} */ let tip;
/** @type {any[]} */ let prs;
/** @type {any[]} */ let runs;
/** @type {Map<number, any>} */ let verdicts;
/** @type {string[][]} */ let ghCalls;
/** @type {string[]} */ let lines;
/** @type {any} */ let world;
/** @type {{ items: any[] }} */ let backlog;

const run = (/** @type {string} */ cwd, /** @type {string[]} */ args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
};
const git = (/** @type {string[]} */ ...commands) => {
  let out = "";
  for (const args of commands) {
    const r = run(repo, args);
    if (!r.ok) throw new Error(`git ${args.join(" ")} failed`);
    out = r.out;
  }
  return out;
};
const commit = (/** @type {string} */ subject, /** @type {string} */ file) => {
  writeFileSync(join(repo, file), `${subject}\n`);
  git(["add", file], ["commit", "-q", "-m", subject]);
  return git(["rev-parse", "HEAD"]);
};
const onOrigin = (/** @type {string} */ ref) => {
  const r = run(repo, ["ls-remote", "origin", `refs/heads/${ref}`]);
  return r.out.split(/\s+/)[0] ?? "";
};

/** What GitHub does: refuses a moved head, else makes a merge commit on staging. */
function ghMerge(/** @type {string[]} */ args) {
  world.beforeMerge?.();
  const pr = prs.find((p) => String(p.number) === args[2]);
  if (!pr || world.mergeFails) return { ok: false, out: "" };
  const head = onOrigin(pr.headRefName);
  if (args[args.indexOf("--match-head-commit") + 1] !== head) return { ok: false, out: "" };
  git(["fetch", "-q", "origin", "staging"]);
  const merge = git([
    "commit-tree",
    `${head}^{tree}`,
    "-p",
    "FETCH_HEAD",
    "-p",
    head,
    "-m",
    args[args.indexOf("--subject") + 1],
  ]);
  git(["push", "-q", "origin", `${merge}:refs/heads/staging`]);
  pr.merged = { oid: merge, head };
  return world.mergeAnswerLost ? { ok: false, out: "" } : { ok: true, out: "" };
}

function gh(/** @type {string[]} */ args) {
  ghCalls.push(args);
  const [area, action] = args;
  if (area === "pr" && action === "list") {
    if (world.prListFails) return { ok: false, out: "" };
    return { ok: true, out: JSON.stringify(prs.filter((p) => !p.merged)) };
  }
  if (area === "pr" && action === "merge") return ghMerge(args);
  if (area === "pr" && action === "view") {
    if (world.viewFails) return { ok: false, out: "" };
    const pr = prs.find((p) => String(p.number) === args[2]);
    return {
      ok: true,
      out: JSON.stringify({
        state: pr.merged ? "MERGED" : "OPEN",
        headRefOid: pr.merged?.head ?? pr.headRefOid,
        mergeCommit: pr.merged ? { oid: pr.merged.oid } : null,
      }),
    };
  }
  if (area === "run" && action === "list") {
    if (world.runsFail) return { ok: false, out: "" };
    return { ok: true, out: JSON.stringify(runs) };
  }
  if (area === "run" && action === "download") {
    const v = verdicts.get(Number(args[2]));
    if (!v) return { ok: false, out: "" };
    writeFileSync(join(args[args.indexOf("--dir") + 1], "verdict.json"), JSON.stringify(v));
    return { ok: true, out: "" };
  }
  return { ok: false, out: "" };
}

const io = () => ({
  git: (/** @type {string[]} */ args) => run(repo, args),
  gh,
  sleep: async () => {},
  now: () => 0,
  log: (/** @type {string} */ line) => lines.push(line),
  pollMs: 1,
  // The backlog's locked write, on an in-memory backlog.
  fileFindings: (/** @type {any[]} */ findings) => ({
    ...applyFindings(backlog, null, findings, {
      add: (/** @type {any} */ f) => {
        const item = {
          id: `X-${backlog.items.length + 1}`,
          title: f.title,
          status: "triaged",
          notes: f.note,
        };
        backlog.items.push(item);
        return item;
      },
      note: (/** @type {any} */ item, /** @type {string} */ text) => {
        item.notes += `\n${text}`;
      },
    }),
    pushed: null,
  }),
});
const promote = (/** @type {string[]} */ ...argv) => main(["promote", ...argv], /** @type {any} */ (io()));

/** A green candidate verdict the project's CI wrote (verdict.fixtures/), for the tip. */
const baseVerdict = (over = {}) => ({
  ...JSON.parse(readFileSync(new URL("./verdict.fixtures/candidate-green.json", import.meta.url), "utf8")),
  commit: tip,
  target: tip,
  ...over,
});
const addRun = (/** @type {number} */ id, /** @type {any} */ verdict, over = {}) => {
  runs.push({
    databaseId: id,
    headSha: tip,
    headBranch: CI_REF,
    workflowName: "CI",
    status: "completed",
    conclusion: "success",
    createdAt: `2026-11-23T10:${String(id).padStart(2, "0")}:00Z`,
    url: `https://example.test/runs/${id}`,
    ...over,
  });
  if (verdict) verdicts.set(id, verdict);
};
const flakeOf = (/** @type {boolean} */ brake) => ({
  kind: "flake",
  flaky: [{ job: "browser", file: browserCheckFile("roundtrip"), name: null, brake }],
});

const expectNothingMerged = (/** @type {string} */ stagingBefore) => {
  expect(onOrigin("staging")).toBe(stagingBefore);
  expect(onOrigin(BRANCH)).toBe(prs.find((p) => p.headRefName === BRANCH).headRefOid);
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "risa-promote-test-")));
  const origin = join(root, "origin.git");
  repo = join(root, "repo");
  prs = [];
  runs = [];
  verdicts = new Map();
  ghCalls = [];
  lines = [];
  world = {};
  backlog = { items: [] };
  run(root, ["init", "-q", "--bare", "-b", "dev", origin]);
  run(root, ["clone", "-q", origin, repo]);
  git(["checkout", "-q", "-B", "dev"]);
  commit("chore: start", "a.txt");
  git(["branch", "staging"]);
  commit("feat: new work", "b.txt");
  const merged = git([
    "commit-tree",
    "HEAD^{tree}",
    "-p",
    "HEAD",
    "-p",
    "staging",
    "-m",
    `chore(release): merge staging into ${BRANCH}`,
  ]);
  git([
    "push",
    "-q",
    "origin",
    "dev",
    "staging",
    `${merged}:refs/heads/${BRANCH}`,
    `${merged}:refs/heads/${CI_REF}`,
  ]);
  tip = merged;
  prs = [
    {
      number: 200,
      url: "https://example.test/pull/200",
      headRefName: BRANCH,
      headRefOid: tip,
      isCrossRepository: false,
    },
  ];
  // The guard on every test: the only remote is the bare repository in the temp directory.
  expect(git(["remote", "get-url", "origin"]).startsWith(root)).toBe(true);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("promote merges", () => {
  it("a green candidate, pinned to its tip with a merge commit, and deletes its refs", async () => {
    addRun(1, baseVerdict());
    expect(await promote()).toBe(0);
    const merge = ghCalls.find((c) => c[1] === "merge") ?? [];
    expect(merge.slice(0, 4)).toEqual(["pr", "merge", "200", "--merge"]);
    expect(merge[merge.indexOf("--match-head-commit") + 1]).toBe(tip);
    expect(merge).not.toContain("--squash");
    expect(merge).not.toContain("--rebase");
    expect(merge).not.toContain("--admin");
    expect(merge).not.toContain("--auto");
    const staging = onOrigin("staging");
    git(["fetch", "-q", "origin", "staging"]);
    expect(git(["rev-parse", `${staging}^{tree}`])).toBe(git(["rev-parse", `${tip}^{tree}`]));
    expect(git(["rev-list", "--parents", "-n", "1", staging]).split(" ")).toHaveLength(3);
    expect(onOrigin(BRANCH)).toBe("");
    expect(onOrigin(CI_REF)).toBe("");
  });

  it("a flake with nothing on the brake list", async () => {
    addRun(1, baseVerdict(flakeOf(false)));
    expect(await promote()).toBe(0);
    expect(onOrigin(BRANCH)).toBe("");
  });

  it("files a passing flake's test, and a second promotion of it notes that item", async () => {
    addRun(1, baseVerdict(flakeOf(false)));
    expect(await promote()).toBe(0);
    expect(backlog.items).toHaveLength(1);
    expect(backlog.items[0].notes).toContain("https://example.test/runs/1");
    expect(lines).toContain("  filed X-1");

    // The next candidate: staging (now with the first merge) merged into a new rc/ tip.
    git(["fetch", "-q", "origin", "staging"]);
    tip = git(["commit-tree", `${tip}^{tree}`, "-p", tip, "-p", "FETCH_HEAD", "-m", "chore(release): next"]);
    git(["push", "-q", "origin", `${tip}:refs/heads/${BRANCH}`, `${tip}:refs/heads/${CI_REF}`]);
    prs = [{ ...prs[0], number: 201, headRefOid: tip, merged: undefined }];
    runs = [];
    lines = [];
    addRun(2, baseVerdict(flakeOf(false)));
    expect(await promote()).toBe(0);
    expect(backlog.items).toHaveLength(1);
    expect(backlog.items[0].notes).toContain("https://example.test/runs/2");
    expect(lines).toContain("  noted on X-1");
  });

  it("finishes the cleanup when the merge's answer is lost", async () => {
    addRun(1, baseVerdict());
    world.mergeAnswerLost = true;
    expect(await promote()).toBe(0);
    expect(onOrigin(BRANCH)).toBe("");
  });

  it("a candidate with no ci ref left", async () => {
    git(["push", "-q", "origin", `:refs/heads/${CI_REF}`]);
    addRun(1, baseVerdict());
    expect(await promote()).toBe(0);
  });
});

describe("promote refuses", () => {
  /** @type {string} */ let before;
  beforeEach(() => {
    before = onOrigin("staging");
  });
  const refused = async (/** @type {string} */ text) => {
    expect(await promote()).toBe(REFUSED);
    expect(lines.at(-1)).toContain(text);
    expect(ghCalls.some((c) => c[1] === "merge")).toBe(false);
    expectNothingMerged(before);
  };

  it.each(["brake", "file", "infra", "something-new"])("a %s verdict", async (kind) => {
    addRun(1, baseVerdict({ kind }));
    await refused(`the verdict is ${kind}`);
  });

  it("a flake on the brake list", async () => {
    addRun(1, baseVerdict(flakeOf(true)));
    await refused("flaky on the brake list");
  });

  it("a stale verdict, for another commit", async () => {
    addRun(1, baseVerdict({ commit: "e".repeat(40) }));
    await refused("another commit");
  });

  it("a tip with no run", async () => {
    await refused("no readable candidate verdict");
  });

  it("a run of the old tip only, after a commit reached the candidate", async () => {
    addRun(1, baseVerdict());
    git(["checkout", "-q", "--detach", tip]);
    const newer = commit("fix: after the verdict", "c.txt");
    git(["push", "-q", "origin", `${newer}:refs/heads/${BRANCH}`]);
    prs[0].headRefOid = newer;
    expect(await promote()).toBe(REFUSED);
    // The fake lists the old run under any commit; the filter on headSha drops it.
    expect(lines.at(-1)).toContain("no readable candidate verdict");
    expect(ghCalls.some((c) => c[1] === "merge")).toBe(false);
  });

  it("a narrowed verdict", async () => {
    addRun(1, baseVerdict({ narrowed: true }));
    await refused("narrowed");
  });

  it("a proof run's verdict", async () => {
    addRun(1, baseVerdict({ forcedFlake: "roundtrip" }));
    await refused("proof run");
  });

  it("a verdict below the candidate tier", async () => {
    addRun(1, baseVerdict({ tier: "full", ranTier: "full" }));
    await refused("below candidate");
  });

  it("an expired artifact", async () => {
    addRun(1, null);
    await refused("7-day artifact expired");
  });

  it("an expired newest verdict, even with an older green", async () => {
    addRun(1, baseVerdict());
    addRun(2, null);
    await refused("no readable candidate verdict");
  });

  it("a newer failing verdict over an older green", async () => {
    addRun(1, baseVerdict());
    addRun(2, baseVerdict({ kind: "file" }));
    await refused("the verdict is file");
  });

  it("a run still going, even with an older green", async () => {
    addRun(1, baseVerdict());
    addRun(2, null, { status: "in_progress", conclusion: "" });
    await refused("still going");
  });

  it("an unreachable GitHub for the runs", async () => {
    addRun(1, baseVerdict());
    world.runsFail = true;
    await refused("can't be reached");
  });

  it("an unreachable GitHub for the PRs", async () => {
    addRun(1, baseVerdict());
    world.prListFails = true;
    expect(await promote()).toBe(REFUSED);
    expect(lines.at(-1)).toContain("could not read the open PRs");
    expect(ghCalls.some((c) => c[1] === "merge")).toBe(false);
  });

  it("a staging that moved since the cut", async () => {
    addRun(1, baseVerdict());
    git(["checkout", "-q", "staging"]);
    const moved = commit("fix: straight onto staging", "s.txt");
    git(["push", "-q", "origin", "staging"]);
    before = moved;
    await refused("staging moved");
  });

  it("a PR head that disagrees with the branch", async () => {
    addRun(1, baseVerdict());
    prs[0].headRefOid = "f".repeat(40);
    expect(await promote()).toBe(REFUSED);
    expect(lines.at(-1)).toContain("on the PR");
    expect(ghCalls.some((c) => c[1] === "merge")).toBe(false);
  });

  it("more than one candidate", async () => {
    addRun(1, baseVerdict());
    git(["push", "-q", "origin", `${tip}:refs/heads/rc/20261123-1100`]);
    prs.push({ ...prs[0], number: 201, headRefName: "rc/20261123-1100" });
    expect(await promote()).toBe(REFUSED);
    expect(lines.at(-1)).toContain("more than one");
  });

  it("extra arguments, as usage", async () => {
    expect(await promote("now")).toBe(EXIT.usage);
    expect(ghCalls).toEqual([]);
  });
});

describe("at the merge", () => {
  it("a commit pushed after the verdict can't slip through", async () => {
    addRun(1, baseVerdict());
    const before = onOrigin("staging");
    world.beforeMerge = () => {
      git(["checkout", "-q", "--detach", tip]);
      const late = commit("feat: pushed after the verdict", "late.txt");
      git(["push", "-q", "origin", `${late}:refs/heads/${BRANCH}`]);
      world.late = late;
    };
    expect(await promote()).toBe(REFUSED);
    expect(lines.at(-1)).toContain("nothing was merged");
    expect(onOrigin("staging")).toBe(before);
    expect(onOrigin(BRANCH)).toBe(world.late);
  });

  it("keeps the refs when the merge can't be confirmed", async () => {
    addRun(1, baseVerdict());
    world.viewFails = true;
    expect(await promote()).toBe(EXIT.unknown);
    expect(lines.at(-1)).toContain("could not confirm");
    expect(onOrigin(BRANCH)).toBe(tip);
    expect(onOrigin(CI_REF)).toBe(tip);
  });

  it("keeps a branch that moved after the merge", async () => {
    addRun(1, baseVerdict());
    const io2 = io();
    let late = "";
    const wrapped = {
      ...io2,
      gh(/** @type {string[]} */ args) {
        const out = gh(args);
        if (args[1] === "merge") {
          git(["checkout", "-q", "--detach", tip]);
          late = commit("feat: after the merge", "after.txt");
          git(["push", "-q", "origin", `${late}:refs/heads/${BRANCH}`]);
        }
        return out;
      },
    };
    expect(await main(["promote"], /** @type {any} */ (wrapped))).toBe(0);
    expect(onOrigin(BRANCH)).toBe(late);
    expect(lines.join("\n")).toContain("moved");
  });
});

describe("the held dev PR into staging", () => {
  it("is never counted, merged, closed or edited", async () => {
    const held = { ...HELD };
    prs.unshift(held);
    addRun(1, baseVerdict());
    expect(await promote()).toBe(0);
    expect(held).toEqual(HELD);
    expect(
      ghCalls.filter((c) => c[0] === "pr").every((c) => ["list", "merge", "view"].includes(`${c[1]}`)),
    ).toBe(true);
    expect(ghCalls.flat()).not.toContain("115");
  });

  it("alone is no candidate", async () => {
    prs = [{ ...HELD }];
    expect(await promote()).toBe(REFUSED);
    expect(lines.at(-1)).toContain("no open candidate");
    expect(ghCalls.every((c) => c[1] === "list")).toBe(true);
  });

  it("a fork's rc/ head is no candidate", async () => {
    prs = [{ ...prs[0], isCrossRepository: true }];
    expect(await promote()).toBe(REFUSED);
    expect(lines.at(-1)).toContain("no open candidate");
  });
});

describe("releasePasses", () => {
  const SHA = "a".repeat(40);
  const v = (over = {}) => ({ commit: SHA, ranTier: "candidate", kind: "green", flaky: [], ...over });

  it.each([
    ["green", v(), true],
    ["an unknown tier", v({ ranTier: "nonsense" }), false],
    ["a flake off the list", v({ kind: "flake", flaky: [{ file: "x", brake: false }] }), true],
    ["a flake on the list", v({ kind: "flake", flaky: [{ file: "x", brake: true }] }), false],
    [
      "one of two on the list",
      v({
        kind: "flake",
        flaky: [
          { file: "x", brake: false },
          { file: "y", brake: true },
        ],
      }),
      false,
    ],
    ["a flake with no brake flag", v({ kind: "flake", flaky: [{ file: "x" }] }), false],
    ["a flake naming nothing", v({ kind: "flake", flaky: [] }), false],
    ["a broken flaky list", v({ kind: "flake", flaky: "x" }), false],
    ["no verdict", null, false],
  ])("%s", (_name, verdict, pass) => {
    expect(releasePasses(verdict, "candidate", SHA).pass).toBe(pass);
  });

  // A release-tier verdict as the project's CI builds it (verdict.fixtures/, from its
  // buildVerdict), joined to the gate at the release tier.
  it("passes a built release verdict at the release tier, and a candidate one doesn't", () => {
    const read = (/** @type {string} */ name) =>
      JSON.parse(readFileSync(new URL(`./verdict.fixtures/${name}`, import.meta.url), "utf8"));
    const release = read("release-green.json");
    expect(releasePasses(release, "release", release.commit)).toEqual({ pass: true, why: "green" });
    expect(releasePasses(release, "candidate", release.commit).pass).toBe(true);
    const candidate = read("candidate-green.json");
    expect(releasePasses(candidate, "release", candidate.commit)).toEqual({
      pass: false,
      why: "the run reached candidate, below release",
    });
  });
});
