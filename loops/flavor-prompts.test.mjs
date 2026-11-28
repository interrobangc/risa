// The flavor line at the end of the prompts the user talks to (prompt.sh's exit
// path, flavor.mjs's `line`; RISA-914): backlog (its drawn admiral), orchestrator,
// plan, hotfix, inbox and recover, each for its session's name; none for slice and
// tidy, under the `none` flavor, or on a failed render. On a throwaway sample
// repo, with the machine config at a temp file or none.
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { flavorLine, personaFor } from "./flavor.mjs";
import { makeRepo } from "./sample-project/repo.mjs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "flavor-prompts-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const main = join(root, "main");
const PLAN = "# Plan: T\n\n## Slice 1: One\n\nStack: no · Reads: none · Tests: unit\n";
makeRepo(main, { files: { "work/plans/T-plan.md": PLAN, "work/plans/T-prd.md": "# PRD: T\n" } });
const NONE = join(root, "machine-none.json");
writeFileSync(NONE, JSON.stringify({ flavor: "none", repos: [] }));

/** Run prompt.sh with ARGS; MACHINE is RISA_MACHINE_CONFIG (empty: none). */
const prompt = (/** @type {string[]} */ args, { machine = "", captain = "" } = {}) =>
  spawnSync("bash", [join(main, "loops/prompt.sh"), ...args], {
    cwd: main,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RISA_MACHINE_CONFIG: machine,
      RISA_CAPTAIN: captain,
    },
  });

/** ROLE's line for the session named NAME (the default flavor). */
const lineFor = (/** @type {string} */ role, /** @type {string} */ name) =>
  flavorLine(role, personaFor(role, name));

// Each prompt the user talks to: its arguments, and the line it ends with.
const SIX = [
  { args: ["orchestrator", "T"], line: lineFor("prd", "prd-T") },
  { args: ["plan", "T"], line: lineFor("plan", "plan-T") },
  { args: ["hotfix", "h", "the menu closes twice"], line: lineFor("hotfix", "hotfix-h") },
  { args: ["inbox"], line: lineFor("inbox", "inbox") },
  { args: ["recover"], line: lineFor("recovery", "recover") },
  {
    args: ["backlog"],
    captain: "Janeway",
    line: flavorLine("backlog", { rank: "Admiral", name: "Janeway" }),
  },
];

describe("the flavor line in the prompts", () => {
  it("ends each prompt the user talks to with its role's line", () => {
    for (const { args, line, captain } of SIX) {
      const r = prompt(args, { captain });
      expect(r.status, args.join(" ")).toBe(0);
      expect(line).toMatch(/^- You are \w[\w ]* \w+: /);
      expect(r.stdout.endsWith(`\n${line}\n`), args.join(" ")).toBe(true);
      expect(r.stdout.split(line).length, args.join(" ")).toBe(2);
    }
    expect(prompt(["backlog"], { captain: "Janeway" }).stdout).toContain("- You are Admiral Janeway: ");
    expect(prompt(["orchestrator", "T"]).stdout).toContain(
      `- You are Captain ${personaFor("prd", "prd-T")?.name}: `,
    );
  });

  it("gives slice, tidy and the backlog's guide none", () => {
    for (const args of [["slice", "T", "1"], ["tidy"], ["backlog", "--guide"]]) {
      const r = prompt(args, { captain: "Janeway" });
      expect(r.status, args.join(" ")).toBe(0);
      expect(r.stdout, args.join(" ")).not.toContain("- You are ");
    }
  });

  it("gives the backlog none without an admiral, or with something that isn't a name", () => {
    for (const captain of ["", "Pi card", "$(x)", "backlog"])
      expect(prompt(["backlog"], { captain }).stdout, captain).not.toContain("- You are ");
  });

  it("gives none under the none flavor", () => {
    for (const { args, captain } of SIX) {
      const r = prompt(args, { captain, machine: NONE });
      expect(r.status, args.join(" ")).toBe(0);
      expect(r.stdout, args.join(" ")).not.toContain("- You are ");
    }
  });

  it("prints no line on a failed render, and keeps its exit", () => {
    for (const args of [
      ["orchestrator", "T", "--bogus"],
      ["plan", "T", "nope"],
      ["backlog", "--bogus"],
      ["inbox", "x"],
    ]) {
      const r = prompt(args, { captain: "Janeway" });
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stdout, args.join(" ")).not.toContain("- You are ");
    }
  });
});
