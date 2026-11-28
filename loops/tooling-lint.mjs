// tooling-lint.mjs: the lint step `pnpm test:tooling` runs before its tests.
// eslint and prettier on the tooling files changed since the trunk (committed
// since the merge base, staged, unstaged and untracked), so a tooling-only
// change that needs no `pnpm check` is still linted. Only the changed files,
// so it stays fast. Exit 1 on an error; a tier data or check plan rules file
// that doesn't load prints one line and exits 2, never a Node stack. First it
// checks package.json's version against the newest v* tag reachable from HEAD:
// a tag above the version prints one line and exits 1 (no tags, as in a shallow
// checkout, skips saying so; no package.json skips quietly).
//   RISA_TOOLING_LINT=off skips it (the check's own static steps lint and
//   format everything, so its tooling step runs only the tests). TRUNK names the
//   trunk (default the config's branches.trunk).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TierDataError } from "../ci/tier-data.mjs";
import { CheckPlanRulesError, planToolingLint } from "./check-plan.mjs";
import { branchKinds, loadConfigOrExit } from "./config.mjs";

const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const lines = (r) => (r.status === 0 ? r.stdout.split("\n").filter(Boolean) : []);

const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
if (process.env.RISA_TOOLING_LINT === "off") process.exit(0);

/** @param {string} v */
const semver = (v) =>
  v
    .match(/^v?(\d+)\.(\d+)\.(\d+)/)
    ?.slice(1)
    .map(Number);
const pkgPath = join(root, "package.json");
if (existsSync(pkgPath)) {
  const version = String(JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "");
  const tag = lines(git("tag", "--merged", "HEAD", "--list", "v*", "--sort=-v:refname")).find((t) =>
    semver(t),
  );
  if (!tag) console.log("tooling lint: no v* tag reachable from HEAD; version check skipped");
  else {
    const [have, want] = [semver(version) ?? [0, 0, 0], semver(tag) ?? []];
    const i = want.findIndex((n, j) => n !== have[j]);
    if (i >= 0 && want[i] > have[i]) {
      console.error(
        `tooling lint: package.json's version ${version || "(none)"} is below the newest tag ${tag}; bump it (a release bumps the version, then tags)`,
      );
      process.exit(1);
    }
  }
}

const trunkName = process.env.TRUNK || branchKinds(loadConfigOrExit("tooling lint").config).trunk;
const trunk = [trunkName, `origin/${trunkName}`].find(
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

/** @type {ReturnType<typeof planToolingLint>} */
let plan;
try {
  plan = planToolingLint(changed);
} catch (e) {
  if (!(e instanceof TierDataError || e instanceof CheckPlanRulesError)) throw e;
  console.error(`tooling lint: ${e.problems.join("; ")}`);
  process.exit(2);
}
const { eslint, prettier } = plan;
if (!prettier.length) process.exit(0);
console.log(`tooling lint: eslint and prettier on ${prettier.length} changed tooling file(s)`);
const bin = (name) => join(root, "node_modules/.bin", name);
const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, stdio: "inherit" }).status === 0;
const linted = !eslint.length || run(bin("eslint"), ["--no-warn-ignored", ...eslint]);
const formatted = run(bin("prettier"), ["--check", "--ignore-unknown", ...prettier]);
process.exit(linted && formatted ? 0 : 1);
