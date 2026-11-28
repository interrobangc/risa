// Each generic role doc ends with a pinned heading: a project's additions continue
// the generic doc's last section (loops/doc.mjs), so a fold-in must not move it.
import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

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
