// Each generic role doc ends with a pinned heading: a project's additions continue
// the generic doc's last section (loops/doc.mjs), so a fold-in must not move it.
import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { sectionOf } from "./doc.mjs";

const docs = new URL("./docs/", import.meta.url);

const LAST = {
  "backlog.md": "## Deciding what's next",
  "hotfix.md": "# Hotfix handbook",
  "inbox.md": "## Starting it",
  "loop.md": "## Loop rules",
  "machinery.md": "## Worktrees and leases",
  "orchestration.md": "# How work gets done",
  "orchestrator.md": "## Starting and steering",
  "planner.md": "## The plan's shape",
  "project-config.md": "# The project config and the core's line",
  "recovery.md": "# Recovery",
  "ship.md": "# Ship",
};

const lastHeading = (text) => {
  let last = "";
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    else if (!fence && /^#{1,6} /.test(line)) last = line.trimEnd();
  }
  return last;
};

it("pins every generic doc", () => {
  const files = readdirSync(docs)
    .filter((f) => f.endsWith(".md"))
    .sort();
  expect(files).toEqual(Object.keys(LAST).sort());
});

for (const [file, heading] of Object.entries(LAST)) {
  it(`${file} ends with ${heading}`, () => {
    const got = lastHeading(readFileSync(new URL(file, docs), "utf8"));
    expect(
      got,
      `loops/docs/${file} must end with "${heading}" (now "${got}"): a project's additions continue the generic doc's last section, so keep it last`,
    ).toBe(heading);
  });
}

// Docs and prompts send readers to a section (`{{prd}} doc machinery "The dispatcher"`;
// a prompt's `role_doc orchestrator "Models"`): each must name a generic doc's heading,
// or `prd doc` prints "no section" (RISA-1051).
const REFS = [
  /(?:\{\{prd\}\}|\$prd_cmd|\brisa) doc ([a-z-]+) \\?"([^"\\]+)\\?"/g,
  /\brole_doc ([a-z-]+) (?:"([^"]+)"|(\w+)\))/g,
];

const refsIn = (/** @type {URL} */ dir) =>
  readdirSync(dir)
    .filter((f) => /\.(md|sh)$/.test(f))
    .flatMap((f) => {
      const text = readFileSync(new URL(f, dir), "utf8");
      return REFS.flatMap((re) =>
        [...text.matchAll(re)].map((m) => ({ from: f, role: m[1], section: m[2] ?? m[3] })),
      );
    });

const refs = [
  ...refsIn(docs).map((r) => ({ ...r, from: `loops/docs/${r.from}` })),
  ...refsIn(new URL("../docs/", import.meta.url)).map((r) => ({ ...r, from: `docs/${r.from}` })),
  ...refsIn(new URL("./prompts/", import.meta.url)).map((r) => ({ ...r, from: `loops/prompts/${r.from}` })),
];

it("finds the section references", () => {
  expect(refs.map((r) => `${r.role} ${r.section}`)).toContain("machinery The dispatcher");
  expect(refs.map((r) => `${r.role} ${r.section}`)).toContain("orchestrator Models");
});

it.each(refs)("$from: $role doc's $section section exists", ({ role, section }) => {
  const text = readFileSync(new URL(`${role}.md`, docs), "utf8");
  expect(sectionOf(text, section), `loops/docs/${role}.md has no "${section}" section`).toBeDefined();
});
