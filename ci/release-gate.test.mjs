// The main gate through `main`, on temp repositories: origin is a local bare repository
// and gh is a fixture that records status writes, so no test can reach GitHub.
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REFUSED } from "./candidate.mjs";
import { EXIT, main } from "./ci.mjs";
import { GATE_CONTEXT, TEST_STATUS, gateStatus, parseOverrideArgs } from "./release-gate.mjs";
import { tierData } from "./tier-data.mjs";

const { browserCheckFile } = tierData();

const CI_REF = "ci/release/staging";
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
/** @type {string} */ let mainTip;
/** @type {string} */ let loose;
/** @type {any[]} */ let prs;
/** @type {any[]} */ let runs;
/** @type {Map<number, any>} */ let verdicts;
/** @type {string[][]} */ let ghCalls;
/** @type {string[]} */ let lines;
/** @type {string[]} */ let notices;
/** @type {any[][]} */ let filings;
/** @type {{ commentFails?: boolean, statusFails?: boolean }} */ let world;
let clock = 0;

const git = (/** @type {string[]} */ args) => {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: gitEnv() });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
};
const must = (/** @type {string[]} */ args) => {
  const r = git(args);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed`);
  return r.out;
};
const commit = (/** @type {string} */ subject) => {
  writeFileSync(join(repo, "f.txt"), `${subject}\n`);
  must(["add", "f.txt"]);
  must(["commit", "-q", "-m", subject]);
  return must(["rev-parse", "HEAD"]);
};

function gh(/** @type {string[]} */ args) {
  ghCalls.push(args);
  const [area, action] = args;
  if (area === "pr" && action === "list") return { ok: true, out: JSON.stringify(prs) };
  if (area === "pr" && action === "comment") return { ok: !world.commentFails, out: "" };
  if (area === "api") return { ok: !world.statusFails, out: "{}" };
  if (area === "run" && action === "list") return { ok: true, out: JSON.stringify(runs) };
  if (area === "run" && action === "download") {
    const v = verdicts.get(Number(args[2]));
    if (!v) return { ok: false, out: "" };
    writeFileSync(join(args[args.indexOf("--dir") + 1], "verdict.json"), JSON.stringify(v));
    return { ok: true, out: "" };
  }
  return { ok: false, out: "" };
}

const io = (over = {}) => ({
  git,
  gh,
  sleep: async (/** @type {number} */ ms) => {
    clock += ms;
  },
  now: () => clock,
  log: (/** @type {string} */ line) => lines.push(line),
  pollMs: 1,
  fileFindings: (/** @type {any[]} */ findings) => {
    filings.push(findings);
    return {
      filed: findings.map((f) => ({ key: f.key, id: "B-1", created: false })),
      removed: [],
      pushed: null,
    };
  },
  board: () => ({
    list: () => [],
    post: (/** @type {string} */ text) => notices.push(text),
    withdraw: () => {},
  }),
  session: () => "",
  terminal: () => true,
  ask: async () => tip.slice(0, 8),
  ...over,
});
const statuses = () =>
  ghCalls
    .filter((c) => c[0] === "api")
    .map((c) => ({
      path: c[3],
      ...Object.fromEntries(
        c.filter((a) => /^(state|context|description)=/.test(a)).map((a) => a.split(/=(.*)/s).slice(0, 2)),
      ),
    }));
const verdict = (over = {}) => ({
  version: 1,
  commit: tip,
  runId: "7",
  tier: "release",
  ranTier: "release",
  kind: "green",
  failed: { jobs: [] },
  flaky: [],
  ...over,
});
const addRun = (/** @type {any} */ v, id = 7) => {
  runs.push({
    databaseId: id,
    headSha: tip,
    headBranch: CI_REF,
    workflowName: "CI",
    status: "completed",
    conclusion: "failure",
    createdAt: "2026-11-23T10:00:00Z",
    url: `https://example.test/runs/${id}`,
  });
  verdicts.set(id, v);
};
const release = (/** @type {string[]} */ ...argv) => main(["release", ...argv], /** @type {any} */ (io()));
const override = (over = {}, sha = tip) =>
  main(["override", sha.slice(0, 8), "--reason", "fictional emergency"], /** @type {any} */ (io(over)));
const flaky = (/** @type {boolean} */ brake) => [
  { job: "browser", file: browserCheckFile("roundtrip"), name: null, brake },
];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "risa-release-gate-")));
  const origin = join(root, "origin.git");
  repo = join(root, "repo");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: gitEnv() });
  spawnSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv() });
  must(["remote", "add", "origin", origin]);
  mainTip = commit("chore: on main");
  must(["push", "-q", "origin", "main"]);
  must(["checkout", "-q", "-b", "staging"]);
  tip = commit("chore: on staging");
  must(["push", "-q", "origin", "staging"]);
  must(["checkout", "-q", "-b", "throwaway"]);
  loose = commit("test: a throwaway commit");
  prs = [
    {
      number: 200,
      url: "https://example.test/pull/200",
      headRefName: "staging",
      headRefOid: tip,
      isCrossRepository: false,
    },
  ];
  runs = [];
  verdicts = new Map();
  ghCalls = [];
  lines = [];
  notices = [];
  filings = [];
  world = {};
  clock = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the status of a verdict", () => {
  it.each([
    ["green", {}, "success"],
    ["a flake off the brake list", { kind: "flake", flaky: flaky(false) }, "success"],
    ["a flake on the brake list", { kind: "flake", flaky: flaky(true) }, "failure"],
    ["file", { kind: "file" }, "failure"],
    ["brake", { kind: "brake" }, "failure"],
    ["infra", { kind: "infra" }, "error"],
    ["unknown", { kind: "unknown" }, "error"],
    ["a run below the tier", { ranTier: "candidate" }, "error"],
  ])("%s", (_name, over, state) => {
    expect(gateStatus(verdict(over), tip).state).toBe(state);
  });

  it("keeps a description within GitHub's limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      file: `scripts/browser-checks/c${i}.spec.mjs`,
      brake: true,
    }));
    expect(gateStatus(verdict({ kind: "flake", flaky: many }), tip).description.length).toBeLessThanOrEqual(
      140,
    );
  });
});

describe("pnpm prd ci release", () => {
  it("refuses with no open PR, says how to open one, and writes nothing", async () => {
    prs = [];
    expect(await release()).toBe(REFUSED);
    expect(lines.join("\n")).toContain("gh pr create --base main --head staging");
    expect(statuses()).toEqual([]);
  });

  it("ignores a fork's staging branch", async () => {
    prs[0].isCrossRepository = true;
    expect(await release()).toBe(REFUSED);
    expect(statuses()).toEqual([]);
  });

  it("refuses a PR head that isn't staging's tip", async () => {
    prs[0].headRefOid = mainTip;
    expect(await release()).toBe(REFUSED);
    expect(statuses()).toEqual([]);
  });

  it("writes success on the exact head from a passing verdict", async () => {
    addRun(verdict());
    expect(await release()).toBe(0);
    expect(statuses()).toEqual([
      {
        path: `repos/{owner}/{repo}/statuses/${tip}`,
        state: "success",
        context: GATE_CONTEXT,
        description: "green (release run 7)",
      },
    ]);
    expect(ghCalls.some((c) => c[0] === "pr" && ["create", "merge", "edit"].includes(c[1] ?? ""))).toBe(
      false,
    );
  });

  it("writes failure and exits by kind on a failing verdict", async () => {
    addRun(verdict({ kind: "file" }));
    expect(await release()).toBe(EXIT.file);
    expect(statuses()[0]).toMatchObject({ state: "failure" });
  });

  it("never exits 0 on a green verdict below the tier", async () => {
    addRun(verdict({ ranTier: "candidate" }));
    expect(await release()).toBe(EXIT.unknown);
    expect(statuses()[0]).toMatchObject({ state: "error" });
  });

  it("writes nothing from a verdict for another commit", async () => {
    addRun(verdict({ commit: mainTip }));
    const code = await main(["release", "--wait", "1"], /** @type {any} */ (io()));
    expect(code).not.toBe(0);
    expect(statuses().filter((s) => s.context === GATE_CONTEXT)).toEqual([]);
  });

  it("files second-zone failures without changing a passing status", async () => {
    addRun(
      verdict({
        secondZone: { zone: "America/New_York", mode: "report", files: ["a.browser.test.tsx"], infra: [] },
      }),
    );
    expect(await release()).toBe(0);
    expect(filings).toHaveLength(1);
    expect(statuses()[0]).toMatchObject({ state: "success" });
  });

  it("reports a head that moved during the run", async () => {
    addRun(verdict());
    let reads = 0;
    const moving = io({
      gh: (/** @type {string[]} */ args) => {
        const r = gh(args);
        if (args[0] === "pr" && args[1] === "list" && ++reads > 1)
          return { ok: true, out: JSON.stringify([{ ...prs[0], headRefOid: mainTip }]) };
        return r;
      },
    });
    expect(await main(["release"], /** @type {any} */ (moving))).toBe(REFUSED);
    expect(lines.join("\n")).toContain("a newer commit needs a new run");
  });
});

describe("pnpm prd ci override", () => {
  const nothingWritten = () => {
    expect(statuses()).toEqual([]);
    expect(ghCalls.some((c) => c[1] === "comment")).toBe(false);
    expect(notices).toEqual([]);
  };

  it("refuses in a recorded agent session", async () => {
    expect(await override({ session: () => "loop-6" })).toBe(REFUSED);
    nothingWritten();
  });

  it("refuses without a terminal", async () => {
    expect(await override({ terminal: () => false })).toBe(REFUSED);
    nothingWritten();
  });

  it("refuses a wrongly typed commit", async () => {
    expect(await override({ ask: async () => "deadbeef" })).toBe(REFUSED);
    nothingWritten();
  });

  it("refuses a commit that isn't the PR's head", async () => {
    expect(await override({}, mainTip)).toBe(REFUSED);
    nothingWritten();
  });

  it("refuses with no open PR", async () => {
    prs = [];
    expect(await override()).toBe(REFUSED);
    nothingWritten();
  });

  it("needs a reason", () => {
    expect(() => parseOverrideArgs(["abc12345"])).toThrow(/usage/);
    expect(() => parseOverrideArgs(["abc12345", "--reason", "   "])).toThrow(/usage/);
  });

  it("writes no status when the record can't be left", async () => {
    world.commentFails = true;
    expect(await override()).toBe(REFUSED);
    expect(statuses()).toEqual([]);
  });

  it("warns that the reason is public, then comments, writes OVERRIDE and posts a notice", async () => {
    expect(await override()).toBe(0);
    expect(lines.join("\n")).toContain("leave out health details and names");
    const comment = ghCalls.findIndex((c) => c[1] === "comment");
    const status = ghCalls.findIndex((c) => c[0] === "api");
    expect(comment).toBeGreaterThanOrEqual(0);
    expect(comment).toBeLessThan(status);
    expect(statuses()[0]).toMatchObject({
      state: "success",
      context: GATE_CONTEXT,
      description: "OVERRIDE: fictional emergency",
    });
    expect(notices[0]).toContain("OVERRIDE");
  });
});

describe("pnpm prd ci release-test", () => {
  const test = (/** @type {string} */ sha) => main(["release-test", sha], /** @type {any} */ (io()));

  it("writes a non-passing status on a throwaway commit", async () => {
    expect(await test(loose)).toBe(0);
    expect(statuses()).toEqual([
      {
        path: `repos/{owner}/{repo}/statuses/${loose}`,
        state: TEST_STATUS.state,
        context: GATE_CONTEXT,
        description: TEST_STATUS.description,
      },
    ]);
    expect(TEST_STATUS.state).not.toBe("success");
  });

  it("refuses staging's tip", async () => {
    expect(await test(tip)).toBe(REFUSED);
    expect(lines.join("\n")).toContain("reachable from staging");
    expect(statuses()).toEqual([]);
  });

  it("refuses a commit reachable from main", async () => {
    expect(await test(mainTip)).toBe(REFUSED);
    expect(statuses()).toEqual([]);
  });

  it("refuses a commit that only main holds", async () => {
    must(["checkout", "-q", "main"]);
    const onlyMain = commit("chore: only on main");
    must(["push", "-q", "origin", "main"]);
    expect(await test(onlyMain)).toBe(REFUSED);
    expect(lines.join("\n")).toContain("reachable from main");
    expect(statuses()).toEqual([]);
  });

  it("refuses when it can't see main, rather than clearing the commit", async () => {
    must(["--git-dir", join(root, "origin.git"), "symbolic-ref", "HEAD", "refs/heads/staging"]);
    must(["push", "-q", "origin", ":refs/heads/main"]);
    must(["update-ref", "-d", "refs/remotes/origin/main"]);
    expect(await test(loose)).toBe(REFUSED);
    expect(statuses()).toEqual([]);
  });

  it("refuses an unknown commit", async () => {
    expect(await test("f".repeat(40))).toBe(REFUSED);
    expect(statuses()).toEqual([]);
  });
});
