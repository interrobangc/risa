// `prd status` (ls.sh) on a fixture registry: a held row shows its hold's date
// and reason when it has one, the hold alone when it doesn't (RISA-986). A
// throwaway repo with the scripts and the backlog CLI copied in and
// the fixture config without its stack and test database hooks: nothing here
// touches real containers, slots or worktrees.
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_CONFIG } from "./config-fixture.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();

const BACKLOG = `# Backlog tracker

Intro.

## PRDs

Which PRDs exist.

| PRD | Flags | After | Hot files | Doc and notes |
| --- | ----- | ----- | --------- | ------------- |
| \`alpha\` | standing, hold (2026-11-21: waits on the user) | — | — | standing fixes |
| \`beta\` | hold | — | — | [plan](beta-plan.md) |
| \`gamma\` | — | — | — | to write |

## Items

### B-1 · bug · Something in gamma

- status: triaged
- prd: gamma
`;

let root, main, release, home, env;
/** A throwaway repo at DIR with the scripts, the config reader, pin.mjs and the backlog CLI. */
const repoAt = (/** @type {string} */ dir) => {
  execFileSync("git", ["init", "-q", "-b", "dev", dir]);
  for (const [k, v] of [
    ["user.email", "test@example.com"],
    ["user.name", "Test"],
    ["commit.gpgsign", "false"],
  ])
    git(dir, "config", k, v);
  // The scripts, the config reader, pin.mjs and the backlog CLI: status-extra.mjs and
  // the other Node parts ls.sh calls stay out (each prints nothing when it fails), so
  // the machine's own sessions and workers never reach the output.
  mkdirSync(join(dir, "loops"));
  for (const f of readdirSync(HERE).filter((f) => f.endsWith(".sh") || f === "config.mjs" || f === "pin.mjs"))
    copyFileSync(join(HERE, f), join(dir, "loops", f));
  cpSync(join(HERE, "../backlog"), join(dir, "backlog"), {
    recursive: true,
    filter: (src) => !/\.test\.mjs$/.test(src),
  });
  mkdirSync(join(dir, "plans"));
  writeFileSync(join(dir, "plans/backlog.md"), BACKLOG);
  writeFileSync(join(dir, ".gitignore"), ".loops/\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "chore: init");
  return dir;
};
/** The fixture config without its stack and test database hooks, at NAME, its risaVersion PIN (none: unset). */
const configAt = (/** @type {string} */ name, /** @type {string | undefined} */ pin) => {
  const raw = JSON.parse(readFileSync(FIXTURE_CONFIG, "utf8"));
  for (const h of Object.keys(raw.hooks)) if (/^stack|^testDb$|^serve$/.test(h)) delete raw.hooks[h];
  if (pin === undefined) delete raw.risaVersion;
  else raw.risaVersion = pin;
  const config = join(root, name);
  writeFileSync(config, `${JSON.stringify(raw, null, 2)}\n`);
  return config;
};
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ls-test-")));
  // HOME is the test's own: no machine config, and a release folder of its own.
  home = join(root, "home");
  main = repoAt(join(root, "repo"));
  // A repo standing as a release install, v0.2.0: ls.sh runs from it.
  release = repoAt(join(home, ".risa", "releases", "v0.2.0"));
  env = {
    ...process.env,
    HOME: home,
    RISA_CONFIG: configAt("risa.json"),
    RISA_LEASE_ROOT: join(root, "leases"),
    RISA_BROWSER_LEASES: join(root, "leases/browser"),
    RISA_SESSIONS_DIR: join(root, "sessions"),
    RISA_ASKS_DIR: join(root, "asks"),
    RISA_USAGE_DIR: join(root, "usage"),
    RISA_NOTICES_DIR: join(root, "notices"),
  };
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** `prd status` from the tool at TOOL, on the config with risaVersion PIN. */
const status = (/** @type {string} */ tool, /** @type {string | null} */ pin = null) =>
  spawnSync("bash", [join(tool, "loops", "ls.sh")], {
    cwd: tool,
    encoding: "utf8",
    env:
      pin === null ? env : { ...env, RISA_CONFIG: configAt(`risa-${pin || "none"}.json`, pin || undefined) },
    input: "",
  });

describe("prd status: holds", () => {
  it("shows a hold's date and reason beside it, and a hold with none alone (RISA-986)", () => {
    const r = status(main);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(
      /^Holds\n {2}alpha: on hold since 2026-11-21: waits on the user\n {2}beta: on hold\n/m,
    );
    expect(r.stdout).not.toMatch(/gamma: on hold/);
  });
});

describe("prd status: the pinned risa against the release running (RISA-1050)", () => {
  const WARNING = "risa version: this project pins v0.1.8 (risaVersion) but release v0.2.0 is running";

  it("a pin of 0.1.8 under release v0.2.0 prints one line naming both, first", () => {
    const r = status(release, "0.1.8");
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout.startsWith(`${WARNING}\n\nNAME `)).toBe(true);
    expect(r.stdout.split("risa version:").length - 1).toBe(1);
  });

  it("prints nothing for an equal pin, no pin, or a run from a checkout", () => {
    for (const [tool, pin] of [
      [release, "0.2.0"],
      [release, ""],
      [main, "0.1.8"],
    ]) {
      const r = status(tool, pin);
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout).not.toContain("risa version:");
    }
  });
});
