// Where `pnpm prd check` starts (lib.sh: check_base). A throwaway repo with lib.sh
// copied in; the record is written by hand, as `pnpm prd check` would write it, so
// no check runs here.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./config-fixture.mjs";
import { sharedNames } from "./config.mjs";

const HERE = new URL(".", import.meta.url).pathname;
let repo;
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
const commit = (files, msg) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git("add", "-A");
  git("commit", "-qm", msg);
  return git("rev-parse", "HEAD");
};
const record = (line) =>
  writeFileSync(join(git("rev-parse", "--absolute-git-dir"), sharedNames().checked), `${line}\n`);

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "check-gate-")));
  git("init", "-q", "-b", "dev");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "core.hooksPath", "/dev/null");
  mkdirSync(join(repo, "loops"), { recursive: true });
  for (const f of ["lib.sh", "config.mjs"]) copyFileSync(join(HERE, f), join(repo, "loops", f));
  commit({ "web/a.ts": "1", "README.md": "r" }, "base");
  git("checkout", "-qb", "feature");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("check_base", () => {
  const base = (asked) =>
    spawnSync("bash", ["-c", `source loops/lib.sh && check_base "$PWD" ${asked}`], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, TRUNK: "dev" },
    }).stdout.trim();

  it("a quick check with no pass recorded starts where the branch left dev", () => {
    const left = git("rev-parse", "dev");
    commit({ "web/b.ts": "1" }, "work");
    expect(base("quick")).toBe(left);
  });

  it("a quick check starts from a recorded full pass", () => {
    const passed = commit({ "web/b.ts": "1" }, "work");
    record(`${passed} full`);
    commit({ "web/c.ts": "1" }, "more");
    expect(base("quick")).toBe(passed);
  });

  it("a slice starts where it left its PRD branch, whatever is recorded", () => {
    git("checkout", "-qb", "prd/topic");
    const left = commit({ "web/p.ts": "1" }, "prd work");
    git("checkout", "-qb", "slice/topic/1");
    const mine = commit({ "web/s.ts": "1" }, "slice work");
    record(`${mine} full`);
    commit({ "web/t.ts": "1" }, "more");
    expect(base("slice")).toBe(left);
  });
});
