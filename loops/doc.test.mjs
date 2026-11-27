// pnpm prd doc <role> [section] (doc.mjs): on the sample project (generic alone,
// generic then additions, a replacement, a section, each error), and on the fixture
// project's config (fixture-project/): its role is split, printing the core's generic
// doc and then its additions, and the sections the prompts and docs name in the
// generic docs (loops/docs/) are in the merged text. This repo's own role
// docs are the project-data check's (project-check.mjs) and its own tests'.
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.mjs";
import { DocError, GENERIC_DIR, fillNames, roleDoc, sectionOf } from "./doc.mjs";
import { SAMPLE_CONFIG, makeRepo } from "./sample-project/repo.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const FIXTURE_PROJECT = fileURLToPath(new URL("./fixture-project/risa.json", import.meta.url));
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
    "loops/docs/planner.md": GENERIC_PLANNER,
    "loops/docs/machinery.md": MACHINERY,
    "handbook/roles/planner.md": ADDITIONS,
    "handbook/roles/slice.md": SLICE,
  },
});

const doc = (/** @type {string[]} */ ...args) => {
  const env = { ...process.env };
  delete env.RISA_CONFIG;
  return spawnSync(process.execPath, [join(repo, "loops/doc.mjs"), ...args], {
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
  it("fills the generic docs' command placeholders with the config's names: risa, never pnpm", () => {
    const sample = { ...JSON.parse(readFileSync(SAMPLE_CONFIG, "utf8")), roles: {} };
    const roles = readdirSync(GENERIC_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3));
    expect(roles.length).toBeGreaterThan(5);
    let named = 0;
    for (const role of roles) {
      const raw = readFileSync(join(GENERIC_DIR, `${role}.md`), "utf8");
      const text = roleDoc(role, { config: sample, root: repo });
      expect(raw, role).not.toMatch(/\bpnpm (prd|backlog)\b/);
      expect(text, role).not.toMatch(/\bpnpm\b|\{\{/);
      named += (text.match(/`risa /g) ?? []).length;
    }
    expect(named).toBeGreaterThan(20);
  });

  it("no generic doc names a literal backticked prd command: each is {{prd}}", () => {
    for (const f of readdirSync(GENERIC_DIR).filter((f) => f.endsWith(".md"))) {
      const raw = readFileSync(join(GENERIC_DIR, f), "utf8");
      expect(raw.match(/`prd [^`]*`/g) ?? [], f).toEqual([]);
    }
  });

  it("leaves a placeholder a config has no name for", () => {
    expect(fillNames("`{{prd}} land` and `{{backlog}} add`", { tool: { prd: "x", backlog: "x b" } })).toBe(
      "`x land` and `x b add`",
    );
    expect(fillNames("`{{prd}} land`", {})).toBe("`{{prd}} land`");
  });

  it("prints a generic doc alone when the config names nothing for the role", () => {
    expect(ok("machinery")).toBe(MACHINERY);
  });

  it("prints the generic doc, then the additions", () => {
    expect(ok("planner")).toBe(`${GENERIC_PLANNER}\n${ADDITIONS}`);
  });

  it("leaves out an additions file's opening comment, a pointer for its direct reader", () => {
    const config = { roles: { planner: { additions: "pointed.md" } } };
    writeFileSync(join(repo, "pointed.md"), `<!-- Read it whole: risa doc planner. -->\n\n${ADDITIONS}`);
    expect(roleDoc("planner", { config, root: repo, genericDir: join(repo, "loops/docs") })).toBe(
      `${GENERIC_PLANNER}\n${ADDITIONS}`,
    );
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

  it("sectionOf closes a fence only on its own marker", () => {
    // A ``` inside a ~~~ fence, and a shorter ``` inside a ```` one, don't close it.
    const doc = "## A\n\n~~~\n```\n## B\n~~~\n\n````\n```\n## C\n````\n\nx\n\n## D\n\ny\n";
    expect(sectionOf(doc, "B")).toBeUndefined();
    expect(sectionOf(doc, "C")).toBeUndefined();
    expect(sectionOf(doc, "A")).toBe(doc.slice(0, doc.indexOf("## D")).replace(/\n*$/, "\n"));
    expect(sectionOf(doc, "D")).toBe("## D\n\ny\n");
  });

  it("sectionOf strips a heading's closing #s and ends at its own level or above", () => {
    const doc = "# Top\n\n## A ##\n\na\n\n### Sub\n\ns\n\n## B\n\nb\n";
    expect(sectionOf(doc, "A")).toBe("## A ##\n\na\n\n### Sub\n\ns\n");
    expect(sectionOf(doc, "Sub")).toBe("### Sub\n\ns\n");
    expect(sectionOf("## C#\n\nc\n", "C#")).toBe("## C#\n\nc\n");
  });
});

describe("the fixture project's roles", () => {
  const { config, root } = loadConfig({ path: FIXTURE_PROJECT });

  const split = Object.entries(config.roles).filter(([, e]) => e.additions);

  it("its one role is split: generic plus additions, none a replacement", () => {
    expect(Object.values(config.roles).filter((e) => e.replacement)).toEqual([]);
    expect(split.map(([role]) => role)).toEqual(["planner"]);
  });

  it.each(split)("%s prints the core's generic doc, then the project's additions", (role, entry) => {
    const generic = readFileSync(join(HERE, "docs", `${role}.md`), "utf8");
    const additions = readFileSync(join(root, entry.additions), "utf8");
    expect(roleDoc(role, { config, root })).toBe(
      fillNames(`${generic}\n${additions.replace(/^<!--.*-->\n\n/, "")}`, config),
    );
  });

  it("the loop doc's rules-across-PRDs reference names the config's tool.prd", () => {
    expect(config.tool.prd).toBe("pnpm prd");
    expect(roleDoc("loop", { config, root })).toContain(
      `(migrations, seeds, registries, hot files; \`pnpm prd doc orchestrator "Rules across PRDs"\`)`,
    );
  });

  it("each merged doc opens with its title and intro, the generic one first", () => {
    const roles = readdirSync(GENERIC_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3));
    for (const role of roles) expect(roleDoc(role, { config, root }), role).toMatch(/^# .+\n\n[^#\n-].+\n/);
  });

  it.each([
    ["loop", "Loop rules", /- \*\*A fix request is only:\*\*/],
    ["loop", "Hand-off", /^## Hand-off\n\nYour final message:/],
    ["orchestrator", "Models", /^## Models\n\n\*\*Coding goes to opus/],
    ["orchestrator", "Recovery", /\*\*Resuming as orchestrator:\*\*/],
    ["planner", "What to ask", /^## What to ask\n[\s\S]*\*\*Unattended\*\*/],
    ["planner", "The skeptic pass", /^## The skeptic pass\n[\s\S]*\*\*A second send-back\*\*/],
    ["backlog", "Deciding what's next", /Standing priorities:/],
    ["machinery", "Worktrees and leases", /\*\*`pnpm prd tidy`\*\*/],
  ])("%s's %s section, which prompts and docs name, is in the merged text", (role, heading, want) => {
    expect(roleDoc(role, { config, root, section: heading })).toMatch(want);
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
