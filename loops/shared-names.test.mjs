// The names other worktrees, the watchdog and GitHub share are built from the
// config's name (config.mjs's sharedNames, lib.sh's $project_name), the same in Node
// and bash: here on the fixture project's config. That the project's own name keeps
// them at today's values (an unsynced worktree, the loaded launchd job and the commit
// statuses already posted must still match) is the project-data check's
// (project-check.mjs) and the project's own test.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LABEL } from "./autostart.mjs";
import { FIXTURE_CONFIG } from "./config-fixture.mjs";
import { loadConfig, sharedNames } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** What the fixture's name (`fixture`) makes them. */
const TODAY = {
  backlogLock: "fixture-backlog.lock",
  checked: "fixture-checked",
  inboxMerged: "fixture-inbox-merged",
  unsyncedMerge: "fixture-unsynced-merge",
  launchdLabel: "com.fixture.prd-watchdog",
  ciContext: "fixture-ci",
};

const bash = (/** @type {string} */ script) =>
  spawnSync("bash", ["-c", script], {
    cwd: HERE,
    encoding: "utf8",
    env: { ...process.env, RISA_CONFIG: FIXTURE_CONFIG },
  });

describe("the shared names on the fixture project's config", () => {
  it("come from its name in Node", () => {
    expect(sharedNames(loadConfig({ path: FIXTURE_CONFIG }).config)).toEqual(TODAY);
    expect(LABEL).toBe(TODAY.launchdLabel);
  });

  it("come from its name in bash, the same as Node", () => {
    const r = bash(
      `source "${join(HERE, "lib.sh")}" && source "${join(HERE, "unsynced.sh")}" && ` +
        `basename "$(checked_file .)" && basename "$(unsynced_marker .)" && echo "$project_name-backlog.lock"`,
    );
    expect(r.stderr).toBe("");
    expect(r.stdout.trim().split("\n")).toEqual([TODAY.checked, TODAY.unsyncedMerge, TODAY.backlogLock]);
  });
});
