// The landing gate (lib.sh: exempt_only, checked_ok, checked_how): what counts
// as checked. A throwaway repo with lib.sh copied in; the record is written by
// hand, as `pnpm prd check` would write it, so no check runs here.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  writeFileSync(join(git("rev-parse", "--absolute-git-dir"), "caretook-checked"), `${line}\n`);
const lib = (fn) =>
  spawnSync("bash", ["-c", `source scripts/loops/lib.sh && ${fn} "$PWD" feature`], {
    cwd: repo,
    encoding: "utf8",
  });
const ok = () => lib("checked_ok").status === 0;
const how = () => lib("checked_how").stdout.trim();

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "check-gate-")));
  git("init", "-q", "-b", "dev");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "core.hooksPath", "/dev/null");
  mkdirSync(join(repo, "scripts/loops"), { recursive: true });
  copyFileSync(join(HERE, "lib.sh"), join(repo, "scripts/loops/lib.sh"));
  commit({ "apps/web/a.ts": "1", "README.md": "r" }, "base");
  git("checkout", "-qb", "feature");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("the check gate", () => {
  it("needs no check when the branch changes only docs and internal tooling", () => {
    commit(
      { "docs/x.md": "d", "scripts/loops/new.sh": "s", "scripts/backlog/b.mjs": "b", ".githooks/h": "h" },
      "t",
    );
    expect(ok()).toBe(true);
    expect(how()).toBe("none needed (docs and tooling only)");
  });

  it("needs a check when the branch changes app code, or other scripts", () => {
    commit({ "apps/web/a.ts": "2" }, "app");
    expect(ok()).toBe(false);
    expect(how()).toBe("not checked");
    git("reset", "-q", "--hard", "dev");
    commit({ "scripts/browser-checks/c.mjs": "c" }, "check");
    expect(ok()).toBe(false);
  });

  it("takes a full or a quick pass on the tip, and says which", () => {
    const tip = commit({ "apps/web/a.ts": "2" }, "app");
    record(`${tip} full`);
    expect(ok()).toBe(true);
    expect(how()).toBe(`full on ${tip.slice(0, 7)}`);
    record(`${tip} quick abc123 clean sync, no shared files`);
    expect(ok()).toBe(true);
    expect(how()).toBe(`quick on ${tip.slice(0, 7)} (clean sync, no shared files)`);
  });

  it("reads an older bare-sha record as a full pass", () => {
    const tip = commit({ "apps/web/a.ts": "2" }, "app");
    record(tip);
    expect(how()).toBe(`full on ${tip.slice(0, 7)}`);
  });

  it("keeps a pass across later docs and tooling commits, not app ones", () => {
    const checked = commit({ "apps/web/a.ts": "2" }, "app");
    record(`${checked} full`);
    commit({ "docs/x.md": "d", "scripts/loops/new.sh": "s" }, "docs");
    expect(ok()).toBe(true);
    expect(how()).toBe(`full on ${checked.slice(0, 7)}`);
    commit({ "apps/web/a.ts": "3" }, "more app");
    expect(ok()).toBe(false);
  });

  it("wants a new check after a sync brings in dev's code", () => {
    const checked = commit({ "apps/web/a.ts": "2" }, "app");
    record(`${checked} full`);
    git("checkout", "-q", "dev");
    commit({ "packages/data/b.ts": "b" }, "landed elsewhere");
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-ff", "-m", "chore: sync", "dev");
    expect(ok()).toBe(false);
  });
});
