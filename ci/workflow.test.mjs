// The GitHub Actions workflow (.github/workflows/ci.yml) against what `risa ci`
// expects of it: the name runs are filtered by, the ref `ci run` pushes (it dispatches
// with no inputs), the trunk's push and PR triggers, every action pinned to a SHA, and
// the verdict it uploads pass or fail (write-verdict.mjs), read back as `ci run --wait`
// reads it (ci-runs.mjs's readVerdict).
// A line-based read of the file: the workflow keeps to flow-style lists for this.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { VERDICT_ARTIFACT, VERDICT_FILE, WORKFLOW_NAME } from "./ci-io.mjs";
import { readVerdict, verdictLines } from "./ci-runs.mjs";
import { MAX_TESTS, buildVerdict } from "./write-verdict.mjs";

const root = new URL("../", import.meta.url);
const workflow = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");
const tiers = JSON.parse(readFileSync(new URL("risa-tiers.json", root), "utf8"));

/** The lines of a top-level key's block (its own line excluded). */
const block = (/** @type {string} */ text, /** @type {string} */ key, indent = "") => {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `${indent}${key}:` || l.startsWith(`${indent}${key}: `));
  if (start < 0) return null;
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() && !l.startsWith(`${indent} `) && !l.trim().startsWith("#")) break;
    out.push(l);
  }
  return out.join("\n");
};

/** A trigger's branch list (`branches: [a, "b"]`). */
const branches = (/** @type {string} */ trigger) => {
  const on = block(workflow, "on") ?? "";
  const m = new RegExp(`^  ${trigger}:\\n    branches: \\[([^\\]]*)\\]`, "m").exec(on);
  return m ? (m[1] ?? "").split(",").map((b) => b.trim().replace(/^["']|["']$/g, "")) : [];
};

describe("the CI workflow", () => {
  it("has the name risa ci filters runs by", () => {
    expect(/^name: (.+)$/m.exec(workflow)?.[1]).toBe(WORKFLOW_NAME);
  });

  it("runs on push to main and on PRs to main", () => {
    expect(branches("push")).toContain("main");
    expect(branches("pull_request")).toContain("main");
  });

  it("runs on the ref ci run pushes", () => {
    expect(branches("push")).toContain(`${tiers.refPrefix}**`);
  });

  it("asks no dispatch inputs: ci run sends none", () => {
    const on = block(workflow, "on") ?? "";
    expect(on).toMatch(/^ {2}workflow_dispatch:\s*$/m);
    expect(block(on, "workflow_dispatch", "  ") ?? "").not.toMatch(/inputs:/);
  });

  it("runs pnpm check", () => {
    expect(workflow).toMatch(/^\s+- run: pnpm check$/m);
  });

  it("pins every action to a full commit SHA, its version in a comment", () => {
    const uses = [...workflow.matchAll(/uses: (\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, ref, rest] of uses) {
      expect(ref).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      expect(rest).toMatch(/^ # v\d+\.\d+\.\d+$/);
    }
  });
});

/** The workflow's steps, each its lines (`- ` first). */
const steps = () => {
  const lines = workflow.split("\n");
  /** @type {string[][]} */ const out = [];
  for (const l of lines.slice(lines.indexOf("    steps:") + 1)) {
    if (/^ {6}- /.test(l)) out.push([l]);
    else if (/^ {8}/.test(l) || !l.trim()) out.at(-1)?.push(l);
    else if (!l.trim().startsWith("#")) break;
  }
  return out.map((s) => s.join("\n"));
};
const stepOf = (/** @type {RegExp} */ re) => steps().find((s) => re.test(s)) ?? "";
/** A step's `key: value` line (in its own line or its with/env block). */
const field = (/** @type {string} */ step, /** @type {string} */ key) =>
  new RegExp(`^\\s+(?:- )?${key}: (.+)$`, "m").exec(step)?.[1]?.trim();

describe("the CI workflow's checkout", () => {
  it("fetches the full history and its tags, so docs:headings finds the last v* tag", () => {
    const checkout = stepOf(/uses: actions\/checkout@/);
    expect(checkout).not.toBe("");
    // A shallow checkout has no v* tag reachable from HEAD: the headings check passes vacuously.
    expect(field(checkout, "fetch-depth")).toBe("0");
    expect(field(checkout, "fetch-tags")).not.toBe("false");
  });
});

describe("the CI workflow's verdict", () => {
  const writer = stepOf(/run: node ci\/write-verdict\.mjs/);
  const upload = stepOf(/uses: actions\/upload-artifact@/);

  it("is written and uploaded on success and failure alike", () => {
    expect(writer).not.toBe("");
    expect(upload).not.toBe("");
    expect(field(writer, "if")).toBe("always()");
    expect(field(upload, "if")).toBe("always()");
    const all = steps();
    const check = all.findIndex((s) => /^\s+- run: pnpm check$/m.test(s));
    expect(check).toBeGreaterThanOrEqual(0);
    expect(all.indexOf(writer)).toBeGreaterThan(check);
    expect(all.indexOf(upload)).toBeGreaterThan(all.indexOf(writer));
  });

  it("is uploaded under the name ci run --wait downloads, as the file it reads", () => {
    expect(field(upload, "name")).toBe(VERDICT_ARTIFACT);
    expect(field(upload, "path")).toBe(field(writer, "VERDICT_OUT"));
    expect(basename(field(upload, "path") ?? "")).toBe(VERDICT_FILE);
  });

  it("hands the writer the check step's outcome and vitest's report", () => {
    const check = stepOf(/^\s+- run: pnpm check$/m);
    expect(field(writer, "CHECK_OUTCOME")).toBe(`\${{ steps.${field(check, "id")}.outcome }}`);
    expect(field(writer, "VERDICT_REPORT")).toBe(field(check, "RISA_CI_REPORT"));
  });
});

describe("a verdict the workflow writes", () => {
  const SHA = "c".repeat(40);
  /** @type {string[]} */ const dirs = [];
  const temp = () => {
    const d = mkdtempSync(join(tmpdir(), "risa-verdict-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** readVerdict against a fake gh whose run left `file` as its artifact. */
  const readBack = (/** @type {string} */ file) => {
    /** @type {string[][]} */ const asked = [];
    const io = /** @type {any} */ ({
      gh: (/** @type {string[]} */ args) => {
        asked.push(args);
        if (args[args.indexOf("--name") + 1] !== VERDICT_ARTIFACT) return { ok: false, out: "" };
        cpSync(file, join(args[args.indexOf("--dir") + 1] ?? "", basename(file)));
        return { ok: true, out: "" };
      },
    });
    return { verdict: readVerdict(io, 7), asked };
  };

  /** The writer run as the workflow runs it, in a throwaway dir. */
  const write = (/** @type {Record<string, string>} */ env) => {
    const dir = temp();
    const out = join(dir, "verdict", VERDICT_FILE);
    const r = spawnSync(process.execPath, [fileURLToPath(new URL("./write-verdict.mjs", import.meta.url))], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        VERDICT_OUT: out,
        VERDICT_COMMIT: SHA,
        VERDICT_RUN_ID: "7",
        VERDICT_REF: "main",
        ...env,
      },
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    return out;
  };

  it("reads back green when the check passed", () => {
    const { verdict } = readBack(write({ CHECK_OUTCOME: "success" }));
    expect(verdict).toMatchObject({ kind: "green", commit: SHA, runId: "7" });
    expect(verdictLines(verdict)[0]).toMatch(/^verdict: green · \S+ · cccccccc · run 7$/);
  });

  it("reads back a failure naming the failing tests, from vitest's report", () => {
    const dir = temp();
    const report = join(dir, "vitest.json");
    const json = {
      testResults: [
        {
          name: join(dir, "ci", "a.test.mjs"),
          status: "failed",
          assertionResults: [
            { fullName: "a thing works", status: "failed" },
            { fullName: "a thing passes", status: "passed" },
          ],
        },
        { name: join(dir, "ci", "b.test.mjs"), status: "failed", assertionResults: [] },
        { name: join(dir, "ci", "c.test.mjs"), status: "passed", assertionResults: [] },
      ],
    };
    writeFileSync(report, JSON.stringify(json));
    const out = write({ CHECK_OUTCOME: "failure", VERDICT_REPORT: report });
    const { verdict } = readBack(out);
    expect(verdict?.kind).toBe("file");
    expect(verdict?.failed.tests).toHaveLength(1);
    expect(verdict?.failed.tests[0]).toMatchObject({ name: "a thing works" });
    expect(verdict?.failed.files).toHaveLength(2);
    const lines = verdictLines(verdict).join("\n");
    expect(lines).toMatch(/failed jobs: /);
    expect(lines).toMatch(/a\.test\.mjs: a thing works/);
    expect(lines).toMatch(/failed file: .*b\.test\.mjs/);
  });

  it("reads back a failure with no report (a lint or format failure) as file, never green", () => {
    const { verdict } = readBack(write({ CHECK_OUTCOME: "failure", VERDICT_REPORT: "/nonexistent" }));
    expect(verdict?.kind).toBe("file");
    expect(verdict?.failed.tests).toEqual([]);
    expect(verdict?.failed.jobs.length).toBeGreaterThan(0);
  });

  it("reads back infra when the check never ran", () => {
    const { verdict } = readBack(write({ CHECK_OUTCOME: "skipped" }));
    expect(verdict?.kind).toBe("infra");
  });

  it("names the tier of the ci/ ref it ran on", () => {
    const tier = tiers.tiers.at(-1);
    const { verdict } = readBack(
      write({ CHECK_OUTCOME: "success", VERDICT_REF: `${tiers.refPrefix}${tier}/x` }),
    );
    expect(verdict?.tier).toBe(tier);
  });

  it("names at most MAX_TESTS failures, then says there are more", () => {
    const report = {
      testResults: [
        {
          name: "ci/a.test.mjs",
          status: "failed",
          assertionResults: Array.from({ length: MAX_TESTS + 1 }, (_, i) => ({
            fullName: `t${i}`,
            status: "failed",
          })),
        },
      ],
    };
    const v = buildVerdict({
      commit: SHA,
      runId: "1",
      tier: "unit",
      jobs: ["check"],
      outcome: "failure",
      report,
    });
    expect(v.failed.tests).toHaveLength(MAX_TESTS);
    expect(v.failed.truncated).toBe(true);
  });
});
