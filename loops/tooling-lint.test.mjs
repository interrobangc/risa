// tooling-lint.mjs on a throwaway git repo with a changed tooling file, the sample
// project's config pointing at tier data that doesn't load. That failure only
// shows once the lint finds a trunk to diff against, so it also tells which
// trunk the lint read.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_NAME } from "./config.mjs";
import { SAMPLE_CONFIG } from "./sample-project/repo.mjs";

const LINT = join(import.meta.dirname, "tooling-lint.mjs");
const SAMPLE_ROOT = dirname(SAMPLE_CONFIG);
const SKIPPED = "tooling lint: no trunk to diff against; skipped\n";

/** @type {string[]} */
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A repo whose config names `trunk`, its first commit on `branch`, then broken tier
 * data and a new tooling file on a work branch.
 * @param {{ branch: string, trunk: string }} opts
 */
function fixture({ branch, trunk }) {
  const root = mkdtempSync(join(tmpdir(), "tooling-lint-"));
  roots.push(root);
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd: root,
    });
  git("init", "-q", "-b", branch);
  const config = JSON.parse(readFileSync(SAMPLE_CONFIG, "utf8"));
  config.branches.trunk = trunk;
  for (const rel of [config.paths.checkPlanRules, config.paths.tierData]) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    copyFileSync(join(SAMPLE_ROOT, rel), join(root, rel));
  }
  writeFileSync(join(root, CONFIG_NAME), JSON.stringify(config));
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  git("checkout", "-q", "-b", "work");
  writeFileSync(join(root, config.paths.tierData), '{"tiers": "broken"}');
  mkdirSync(join(root, "loops"), { recursive: true });
  writeFileSync(join(root, "loops/x.mjs"), "export const x = 1;\n");
  return root;
}

/** @param {string} root @param {Record<string, string>} [extra] */
function lint(root, extra = {}) {
  const { RISA_TOOLING_LINT: _off, TRUNK: _trunk, ...env } = process.env;
  return spawnSync("node", [LINT], {
    cwd: root,
    encoding: "utf8",
    env: { ...env, RISA_CONFIG: join(root, CONFIG_NAME), ...extra },
  });
}

describe("tooling-lint", () => {
  it("prints one line and exits non-zero on tier data that doesn't load, never a stack", () => {
    const r = lint(fixture({ branch: "dev", trunk: "dev" }), { TRUNK: "dev" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
    const lines = r.stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^tooling lint: .*tiers\.json: /);
    expect(r.stderr).not.toMatch(/TierDataError|\n\s+at /);
  });

  it("diffs against the config's trunk when TRUNK isn't set", () => {
    const r = lint(fixture({ branch: "main", trunk: "main" }));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^tooling lint: .*tiers\.json: /);

    // a repo with only dev, whose config names main: dev is no longer the default
    expect(lint(fixture({ branch: "dev", trunk: "main" })).stdout).toBe(SKIPPED);
  });

  it("lets TRUNK override the config's trunk", () => {
    const r = lint(fixture({ branch: "main", trunk: "main" }), { TRUNK: "elsewhere" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(SKIPPED);
    expect(lint(fixture({ branch: "dev", trunk: "main" }), { TRUNK: "dev" }).status).toBe(2);
  });
});
