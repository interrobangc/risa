// pnpm prd doc <role> [section] (doc.mjs): on the sample project (generic alone,
// generic then additions, a replacement, a section, each error), and on this repo's
// config: a replacement role prints today's file byte for byte, a split one (loop,
// hotfix, recovery, orchestrator, planner, backlog, inbox) the core's generic doc and
// then the project's additions.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.mjs";
import { DocError, roleDoc, sectionOf } from "./doc.mjs";
import { makeRepo } from "./sample-project/repo.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "doc-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const GENERIC_PLANNER =
  "# Planner\n\nGeneric intro.\n\n## Shape\n\nGeneric shape.\n\n### Detail\n\nDeep.\n\n## Fields\n\nGeneric fields.\n";
const ADDITIONS = "## Sample's rules\n\nThe sample's own.\n\n```sh\n# not a heading\n```\n";
const MACHINERY = "# Machinery\n\nThe generic machinery.\n";
const SLICE = "# Slice\n\nThe sample's slice doc, whole.\n";

const repo = join(tmp, "sample");
makeRepo(repo, {
  files: {
    "scripts/loops/docs/planner.md": GENERIC_PLANNER,
    "scripts/loops/docs/machinery.md": MACHINERY,
    "handbook/roles/planner.md": ADDITIONS,
    "handbook/roles/slice.md": SLICE,
  },
});

const doc = (/** @type {string[]} */ ...args) => {
  const env = { ...process.env };
  delete env.RISA_CONFIG;
  return spawnSync(process.execPath, [join(repo, "scripts/loops/doc.mjs"), ...args], {
    encoding: "utf8",
    env,
  });
};
const ok = (/** @type {string[]} */ ...args) => {
  const r = doc(...args);
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  return r.stdout;
};
const fails = (/** @type {string[]} */ ...args) => {
  const r = doc(...args);
  expect(r.status).toBe(2);
  expect(r.stdout).toBe("");
  return r.stderr;
};

describe("prd doc on the sample project", () => {
  it("prints a generic doc alone when the config names nothing for the role", () => {
    expect(ok("machinery")).toBe(MACHINERY);
  });

  it("prints the generic doc, then the additions", () => {
    expect(ok("planner")).toBe(`${GENERIC_PLANNER}\n${ADDITIONS}`);
  });

  it("prints a replacement alone, byte for byte", () => {
    expect(ok("loop")).toBe(SLICE);
  });

  it("prints one section of the merged doc, its subsections with it", () => {
    expect(ok("planner", "Shape")).toBe("## Shape\n\nGeneric shape.\n\n### Detail\n\nDeep.\n");
    expect(ok("planner", "Detail")).toBe("### Detail\n\nDeep.\n");
    expect(ok("planner", "Sample's rules")).toBe(ADDITIONS);
    expect(ok("planner", "Fields")).toBe("## Fields\n\nGeneric fields.\n");
  });

  it("refuses an unknown role, naming the roles", () => {
    expect(fails("nope")).toMatch(/no role "nope" \(the roles: backlog, hotfix, inbox, loop, machinery,/);
  });

  it("refuses an unknown section, and a fenced line is no heading", () => {
    expect(fails("planner", "Nope")).toMatch(/the planner doc has no section "Nope"/);
    expect(fails("planner", "not a heading")).toMatch(/no section/);
  });

  it("refuses a named file that is missing", () => {
    expect(fails("backlog")).toMatch(
      /the backlog role's replacement, handbook\/roles\/backlog.md, is missing/,
    );
  });

  it("with no role, prints the usage and the roles", () => {
    expect(fails()).toMatch(/usage: prd doc <role> \[section\][\s\S]*machinery/);
  });
});

describe("roleDoc's other errors", () => {
  const empty = mkdtempSync(join(tmp, "generic-"));
  it("refuses additions without a generic doc", () => {
    const config = { roles: { planner: { additions: "handbook/roles/planner.md" } } };
    expect(() => roleDoc("planner", { config, root: repo, genericDir: empty })).toThrow(
      /the planner role's generic doc is missing/,
    );
  });

  it("refuses a role naming both", () => {
    const config = { roles: { loop: { additions: "a.md", replacement: "b.md" } } };
    expect(() => roleDoc("loop", { config, root: repo, genericDir: empty })).toThrow(DocError);
  });

  it("sectionOf finds nothing for a missing heading", () => {
    expect(sectionOf("# A\n\nx\n", "B")).toBeUndefined();
  });
});

describe("this repo's roles", () => {
  const { config, root } = loadConfig();

  const replaced = Object.entries(config.roles).filter(([, e]) => e.replacement);
  const split = Object.entries(config.roles).filter(([, e]) => e.additions);

  it.each(replaced)("%s, a replacement, prints today's file byte for byte", (role, entry) => {
    expect(roleDoc(role, { config, root })).toBe(readFileSync(join(root, entry.replacement), "utf8"));
  });

  it("the split roles are loop, hotfix, recovery, orchestrator, planner, backlog and inbox", () => {
    expect(split.map(([role]) => role).sort()).toEqual([
      "backlog",
      "hotfix",
      "inbox",
      "loop",
      "orchestrator",
      "planner",
      "recovery",
    ]);
  });

  it.each(split)("%s prints the core's generic doc, then the project's additions", (role, entry) => {
    const generic = readFileSync(join(HERE, "docs", `${role}.md`), "utf8");
    const additions = readFileSync(join(root, entry.additions), "utf8");
    expect(roleDoc(role, { config, root })).toBe(`${generic}\n${additions}`);
  });

  it.each([
    ["loop", "Loop rules", /- \*\*A fix request is only:\*\*[\s\S]*- Work only inside your worktree\./],
    ["loop", "Hand-off", /^## Hand-off\n\nYour final message:/],
    ["loop", "Tests", /^## Tests\n/],
    ["loop", "Your worktree and stack", /Slots and ports/],
    ["orchestrator", "Models", /^## Models\n\n\*\*Coding goes to opus/],
    ["orchestrator", "Recovery", /\*\*Resuming as orchestrator:\*\*/],
    ["orchestrator", "The check gate", /^### The check gate\n[\s\S]*\*\*How each kind lands:\*\*/],
    [
      "orchestrator",
      "Rules across PRDs",
      /Migrations take the next number[\s\S]*Hot files get regions first/,
    ],
    ["planner", "Slice fields", /^## Slice fields\n[\s\S]*slice-fields\.mjs/],
    ["planner", "What to ask", /^## What to ask\n[\s\S]*\*\*Unattended\*\*/],
    ["planner", "The skeptic pass", /^## The skeptic pass\n[\s\S]*\*\*A second send-back\*\*/],
    ["backlog", "Deciding what's next", /Standing priorities:\n\n1\. Write the PRDs/],
  ])("%s's %s section, which prompts and docs name, is in the merged text", (role, heading, want) => {
    expect(roleDoc(role, { config, root, section: heading })).toMatch(want);
  });

  it("every doc in docs/agents but the preferences is a role", () => {
    const docs = readdirSync(join(root, "docs/agents")).filter((f) => f !== "preferences.md");
    const named = Object.values(config.roles).map((e) => e.replacement ?? e.additions);
    for (const f of docs) expect(named).toContain(`docs/agents/${f}`);
  });

  it("no core file outside the tests names a docs/agents/ path", () => {
    /** @param {string} dir @returns {string[]} */
    const walk = (dir) =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    const naming = walk(HERE)
      .filter((p) => !p.endsWith(".test.mjs") && !p.endsWith("golden.txt"))
      .filter((p) => readFileSync(p, "utf8").includes("docs/agents/"))
      .map((p) => relative(HERE, p));
    expect(naming).toEqual([]);
  });
});
