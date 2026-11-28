// docs-headings.mjs: a generic role doc's heading change since the newest v* tag
// needs a CHANGELOG.md line under "## Unreleased" naming the doc and the heading.
// On throwaway git repos in the OS temp dir.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { headingDiff, unloggedHeadingChanges, unreleasedLines } from "./docs-headings.mjs";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "docs-headings-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const LOOP = "# Loop\n\nIntro.\n\n## Hand-off\n\nh\n\n## Loop rules\n\nr\n";

/** @param {string} dir @param {string[]} args */
const git = (dir, ...args) => {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
};

/** A repo with loops/docs/loop.md committed, tagged when asked. */
let n = 0;
const repo = (/** @type {{ tag?: boolean }} */ { tag = true } = {}) => {
  const dir = join(tmp, `r${n++}`);
  mkdirSync(join(dir, "loops/docs"), { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  writeFileSync(join(dir, "loops/docs/loop.md"), LOOP);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  if (tag) git(dir, "tag", "v0.1.0");
  return dir;
};
const write = (/** @type {string} */ dir, /** @type {string} */ path, /** @type {string} */ text) =>
  writeFileSync(join(dir, path), text);

describe("unloggedHeadingChanges", () => {
  it("fails a heading rename with no CHANGELOG line, naming the doc and heading", () => {
    const dir = repo();
    write(dir, "loops/docs/loop.md", LOOP.replace("## Hand-off", "## Handing off"));
    write(
      dir,
      "CHANGELOG.md",
      "# Changelog\n\n## Unreleased\n\n- Something else.\n\n## v0.1.0\n\n- loop.md: Handing off\n",
    );
    const out = unloggedHeadingChanges(dir);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(
      /^loops\/docs\/loop\.md: "Hand-off" is gone since v0\.1\.0; .*names loop\.md and "Hand-off"/,
    );
    expect(out[1]).toMatch(/^loops\/docs\/loop\.md: "Handing off" is new since v0\.1\.0/);
  });

  it("passes the rename with a line naming the doc and its headings", () => {
    const dir = repo();
    write(dir, "loops/docs/loop.md", LOOP.replace("## Hand-off", "## Handing off"));
    write(dir, "CHANGELOG.md", "# Changelog\n\n## Unreleased\n\n- loop.md: Hand-off is now Handing off.\n");
    expect(unloggedHeadingChanges(dir)).toEqual([]);
  });

  it("passes any change when there is no tag", () => {
    const dir = repo({ tag: false });
    write(dir, "loops/docs/loop.md", "# Loop\n\n## Other\n\nx\n");
    expect(unloggedHeadingChanges(dir)).toEqual([]);
  });

  it("passes an untouched doc, and fails a new doc's headings", () => {
    const dir = repo();
    expect(unloggedHeadingChanges(dir)).toEqual([]);
    write(dir, "loops/docs/new.md", "# New\n\n## Only\n\nx\n");
    expect(unloggedHeadingChanges(dir)).toEqual([
      expect.stringMatching(/^loops\/docs\/new\.md: "Only" is new since v0\.1\.0/),
    ]);
  });
});

describe("headingDiff", () => {
  it("names a moved section and a new last section; a body edit is no change", () => {
    const moved = "# Loop\n\nIntro.\n\n## Loop rules\n\nr\n\n## Hand-off\n\nh\n";
    expect(headingDiff(LOOP, moved)).toEqual([
      { headings: ["Loop rules"], what: '"Loop rules" moved' },
      { headings: ["Hand-off", "Loop rules"], what: 'the last section is "Hand-off" (was "Loop rules")' },
    ]);
    expect(headingDiff(LOOP, `${LOOP}\nMore rules.\n`)).toEqual([]);
    expect(headingDiff(LOOP, `${LOOP}\n### Detail\n\nd\n`)).toEqual([
      { headings: ["Detail", "Loop rules"], what: 'the last section is "Detail" (was "Loop rules")' },
    ]);
  });

  it("unreleasedLines reads only the lines under ## Unreleased", () => {
    const dir = repo({ tag: false });
    write(dir, "CHANGELOG.md", "# C\n\n## Unreleased\n\n- a\n- b\n\n## v0.1.0\n\n- c\n");
    expect(unreleasedLines(dir)).toEqual(["- a", "- b"]);
  });
});
