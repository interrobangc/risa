// tooling-lint.mjs: the lint step `pnpm test:tooling` runs before its tests.
// eslint and prettier on the tooling files changed since the trunk (committed
// since the merge base, staged, unstaged and untracked), so a tooling-only
// change that needs no `pnpm check` is still linted. Only the changed files,
// so it stays fast. Exit 1 on an error.
//   RISA_TOOLING_LINT=off skips it (the check's own static steps lint and
//   format everything, so its tooling step runs only the tests). TRUNK names the
//   trunk (default dev).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { planToolingLint } from "./check-plan.mjs";

const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const lines = (r) => (r.status === 0 ? r.stdout.split("\n").filter(Boolean) : []);

const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
if (process.env.RISA_TOOLING_LINT === "off") process.exit(0);

const trunk = [process.env.TRUNK || "dev", `origin/${process.env.TRUNK || "dev"}`].find(
  (ref) => git("rev-parse", "--verify", "-q", `${ref}^{commit}`).status === 0,
);
const base = trunk && git("merge-base", trunk, "HEAD").stdout.trim();
if (!base) {
  console.log("tooling lint: no trunk to diff against; skipped");
  process.exit(0);
}
const changed = [
  ...lines(git("diff", "--name-only", "--no-renames", base)),
  ...lines(git("ls-files", "--others", "--exclude-standard")),
].filter((f, i, all) => all.indexOf(f) === i && existsSync(join(root, f)));

const { eslint, prettier } = planToolingLint(changed);
if (!prettier.length) process.exit(0);
console.log(`tooling lint: eslint and prettier on ${prettier.length} changed tooling file(s)`);
const bin = (name) => join(root, "node_modules/.bin", name);
const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, stdio: "inherit" }).status === 0;
const linted = !eslint.length || run(bin("eslint"), ["--no-warn-ignored", ...eslint]);
const formatted = run(bin("prettier"), ["--check", "--ignore-unknown", ...prettier]);
process.exit(linted && formatted ? 0 : 1);
