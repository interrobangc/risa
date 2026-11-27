// The GitHub Actions workflow (.github/workflows/ci.yml) against what `risa ci`
// expects of it: the name runs are filtered by, the ref `ci run` pushes (it dispatches
// with no inputs), the trunk's push and PR triggers, and every action pinned to a SHA.
// A line-based read of the file: the workflow keeps to flow-style lists for this.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { WORKFLOW_NAME } from "./ci-io.mjs";

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
