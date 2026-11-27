// tooling-lint.mjs on a throwaway git repo with a changed tooling file, the sample
// project's config pointing at tier data that doesn't load.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_NAME } from "./config.mjs";
import { SAMPLE_CONFIG } from "./sample-project/repo.mjs";

const LINT = join(import.meta.dirname, "tooling-lint.mjs");
const SAMPLE_ROOT = dirname(SAMPLE_CONFIG);

describe("tooling-lint", () => {
  it("prints one line and exits non-zero on tier data that doesn't load, never a stack", () => {
    const root = mkdtempSync(join(tmpdir(), "tooling-lint-"));
    try {
      const git = (/** @type {string[]} */ ...args) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
          cwd: root,
        });
      git("init", "-q", "-b", "dev");
      const config = JSON.parse(readFileSync(SAMPLE_CONFIG, "utf8"));
      for (const rel of [config.paths.checkPlanRules, config.paths.tierData]) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        copyFileSync(join(SAMPLE_ROOT, rel), join(root, rel));
      }
      writeFileSync(join(root, CONFIG_NAME), JSON.stringify(config));
      git("add", "-A");
      git("commit", "-q", "-m", "init");
      writeFileSync(join(root, config.paths.tierData), '{"tiers": "broken"}');
      mkdirSync(join(root, "loops"), { recursive: true });
      writeFileSync(join(root, "loops/x.mjs"), "export const x = 1;\n");

      const { RISA_TOOLING_LINT: _off, ...env } = process.env;
      const r = spawnSync("node", [LINT], {
        cwd: root,
        encoding: "utf8",
        env: { ...env, RISA_CONFIG: join(root, CONFIG_NAME), TRUNK: "dev" },
      });
      expect(r.status).not.toBe(0);
      expect(r.stdout).toBe("");
      const lines = r.stderr.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^tooling lint: .*tiers\.json: /);
      expect(r.stderr).not.toMatch(/TierDataError|\n\s+at /);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
