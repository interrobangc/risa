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

let root, main, env;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ls-test-")));
  main = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "dev", main]);
  for (const [k, v] of [
    ["user.email", "test@example.com"],
    ["user.name", "Test"],
    ["commit.gpgsign", "false"],
  ])
    git(main, "config", k, v);
  // The scripts, the config reader and the backlog CLI: status-extra.mjs and the
  // other Node parts ls.sh calls stay out (each prints nothing when it fails), so
  // the machine's own sessions and workers never reach the output.
  mkdirSync(join(main, "loops"));
  for (const f of readdirSync(HERE).filter((f) => f.endsWith(".sh") || f === "config.mjs"))
    copyFileSync(join(HERE, f), join(main, "loops", f));
  cpSync(join(HERE, "../backlog"), join(main, "backlog"), {
    recursive: true,
    filter: (src) => !/\.test\.mjs$/.test(src),
  });
  const raw = JSON.parse(readFileSync(FIXTURE_CONFIG, "utf8"));
  for (const h of Object.keys(raw.hooks)) if (/^stack|^testDb$|^serve$/.test(h)) delete raw.hooks[h];
  const config = join(root, "risa.json");
  writeFileSync(config, `${JSON.stringify(raw, null, 2)}\n`);
  mkdirSync(join(main, "plans"));
  writeFileSync(join(main, "plans/backlog.md"), BACKLOG);
  writeFileSync(join(main, ".gitignore"), ".loops/\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "chore: init");
  env = {
    ...process.env,
    RISA_CONFIG: config,
    RISA_LEASE_ROOT: join(root, "leases"),
    RISA_BROWSER_LEASES: join(root, "leases/browser"),
    RISA_SESSIONS_DIR: join(root, "sessions"),
    RISA_ASKS_DIR: join(root, "asks"),
    RISA_USAGE_DIR: join(root, "usage"),
    RISA_NOTICES_DIR: join(root, "notices"),
  };
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("prd status: holds", () => {
  it("shows a hold's date and reason beside it, and a hold with none alone (RISA-986)", () => {
    const r = spawnSync("bash", [join(main, "loops", "ls.sh")], {
      cwd: main,
      encoding: "utf8",
      env,
      input: "",
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(
      /^Holds\n {2}alpha: on hold since 2026-11-21: waits on the user\n {2}beta: on hold\n/m,
    );
    expect(r.stdout).not.toMatch(/gamma: on hold/);
  });
});
