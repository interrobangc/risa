// Every prompt kind and flag (prompt.sh and its parts in prompts/) against a
// golden file, so a change to the prompt scripts can't change a byte of what they
// print unseen. Rendered (prompt-render.mjs) on the sample project (sample-project/,
// its golden beside its config), whose names differ from this repo's wherever the
// prompts read them from the config. A project's own golden (paths.promptGolden) is
// the project-data check's line (project-check.mjs), not a case here. After a
// deliberate prompt change, regenerate the sample's with
// `pnpm exec vitest run --project tooling:unit loops/prompt-golden.test.mjs -u`, the
// project's with `node loops/project-check.mjs --write-golden`, and review
// their diffs.
import { describe, expect, it } from "vitest";
import { renderPrompts } from "./prompt-render.mjs";
import { SAMPLE_CONFIG } from "./sample-project/repo.mjs";

const SAMPLE_GOLDEN = new URL("./sample-project/prompt-golden.txt", import.meta.url).pathname;

describe("the prompts, byte for byte, for every kind and flag", () => {
  it("on the sample project, in its own names", async () => {
    const out = renderPrompts(SAMPLE_CONFIG);
    await expect(out).toMatchFileSnapshot(SAMPLE_GOLDEN);
    // Its commands, paths, role docs (by the doc command), trunk and ids, and none of this repo's.
    for (const name of [
      "`risa start",
      "`risa backlog list`",
      "`make check`",
      "`make test-tools`",
      "`make log",
      "GUIDE.md is already",
      "work/plans/T-plan.md",
      "work/inbox.md on origin/main",
      "`risa doc orchestrator`",
      "`risa doc planner`",
      '`risa doc orchestrator "Models"`',
      "into its file, handbook/roles/hotfix.md.",
      "handbook/taste.md",
      "handbook/ and GUIDE.md",
      "`web/.env`",
      "SAM-<n>",
      "dangling sample Docker",
      "(`main-<n>`)",
    ])
      expect(out, name).toContain(name);
    for (const name of ["pnpm", "docs/agents/", "AGENTS.md is", "B-<n>", "plans/inbox.md", "on dev"])
      expect(out, name).not.toContain(name);
  });
});
