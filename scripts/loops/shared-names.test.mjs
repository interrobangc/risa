// The names other worktrees, the watchdog and GitHub share keep today's values on
// Caretook's own config: they are built from its name now (config.mjs's sharedNames,
// lib.sh's $project_name), and an unsynced worktree, the loaded launchd job and the
// commit statuses already posted must still match. This file is the sample of
// Caretook's config the boundary lint lets through; it leaves with that config at the move.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LABEL } from "./autostart.mjs";
import { FIXTURE_CONFIG } from "./config-fixture.mjs";
import { loadConfig, sharedNames } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** What they were before the names came from the config. */
const TODAY = {
  backlogLock: "caretook-backlog.lock",
  checked: "caretook-checked",
  inboxMerged: "caretook-inbox-merged",
  unsyncedMerge: "caretook-unsynced-merge",
  launchdLabel: "com.caretook.prd-watchdog",
  ciContext: "caretook-ci",
};

const bash = (/** @type {string} */ script) =>
  spawnSync("bash", ["-c", script], {
    cwd: HERE,
    encoding: "utf8",
    env: { ...process.env, RISA_CONFIG: FIXTURE_CONFIG },
  });

describe("the shared names on Caretook's config", () => {
  it("keep their values in Node", () => {
    expect(sharedNames(loadConfig({ path: FIXTURE_CONFIG }).config)).toEqual(TODAY);
    expect(LABEL).toBe(TODAY.launchdLabel);
  });

  it("keep their values in bash", () => {
    const r = bash(
      `source "${join(HERE, "lib.sh")}" && source "${join(HERE, "unsynced.sh")}" && ` +
        `basename "$(checked_file .)" && basename "$(unsynced_marker .)" && echo "$project_name-backlog.lock"`,
    );
    expect(r.stderr).toBe("");
    expect(r.stdout.trim().split("\n")).toEqual([TODAY.checked, TODAY.unsyncedMerge, TODAY.backlogLock]);
  });
});
