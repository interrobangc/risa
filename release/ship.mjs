#!/usr/bin/env node
// Risa's own ship steps (RISA-1053): the hooks risa.json's hooks.shipCheck and
// hooks.ship name. loops/ship.mjs owns the phases, the record and the report; this
// file knows only Risa's release: its v* tags on origin, its package.json and
// CHANGELOG.md, and its CI on main. Run from the main checkout (the hook runner's cwd).
//
//   check <version>   fetches origin; refuses a v<version> tag already on origin, a
//                     version not above origin's highest v* tag, and a release base
//                     whose CI didn't pass (no run, a failed one, or one still running:
//                     try again). Prints tip=<sha>, the release base.
//   ship <version>    in a temporary worktree detached at origin/main (removed on
//                     every exit): checks CI again, sets package.json's version (that
//                     one value), turns CHANGELOG.md's `## Unreleased` into
//                     `## v<version>` under a new empty one, commits
//                     `chore(release): v<version>`, pushes HEAD to main (no force),
//                     then makes the annotated tag and pushes it. A tag already on
//                     origin whose commit's package.json has the version is done.
//                     Prints tag=v<version> and commit=<sha>.
//
// The helpers: compareVersions, highestTag (origin's v* tags), releaseBase (the
// newest commit of origin/main that changes more than the backlog's files, plans/),
// ciOn (CI's conclusion on a commit, through ci-runs.mjs's listRuns, filtered to
// WORKFLOW_NAME there). Exit 0 done, 1 refused or failed, 2 usage.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realIo } from "../ci/ci-io.mjs";
import { listRuns } from "../ci/ci-runs.mjs";
import { isMain } from "../loops/is-main.mjs";

export const TRUNK = "main";
/** The backlog's files: commits touching only these don't need CI to pass. */
export const BACKLOG_PREFIX = "plans/";
/** How far back origin/main is searched for the release base. */
const BASE_DEPTH = 200;

/** A version's parts: [major, minor, patch, pre] (pre "" for a release), or null. */
const parts = (/** @type {string} */ v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ""] : null;
};

/** Below 0 when A is below B, 0 when equal, above 0 when above (a pre-release is below its release). */
export function compareVersions(/** @type {string} */ a, /** @type {string} */ b) {
  const [pa, pb] = [parts(a), parts(b)];
  if (!pa || !pb) throw new Error(`not a version: ${pa ? b : a}`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return Number(pa[i]) - Number(pb[i]);
  const [ra, rb] = [String(pa[3]), String(pb[3])];
  if (ra === rb) return 0;
  if (!ra) return 1;
  if (!rb) return -1;
  return ra < rb ? -1 : 1;
}

/**
 * Origin's v* tags from `git ls-remote --tags` output: tag → commit (an annotated
 * tag's peeled commit).
 * @returns {Map<string, string>}
 */
export function parseTags(/** @type {string} */ out) {
  /** @type {Map<string, string>} */
  const tags = new Map();
  for (const line of out.split("\n")) {
    const m = /^([0-9a-f]+)\s+refs\/tags\/(v[^\s^]+)(\^\{\})?$/.exec(line.trim());
    if (!m || !parts(m[2])) continue;
    if (m[3] || !tags.has(m[2])) tags.set(m[2], m[1]);
  }
  return tags;
}

/** The highest of TAGS' names, or null. */
export function highestTag(/** @type {Iterable<string>} */ tags) {
  let best = null;
  for (const t of tags) if (!best || compareVersions(t, best) > 0) best = t;
  return best;
}

/** Whether a commit's changed files are only the backlog's (an empty commit is too). */
export const backlogOnly = (/** @type {string[]} */ files) =>
  files.every((f) => f.startsWith(BACKLOG_PREFIX));

/**
 * CI's conclusion on a commit from its runs (WORKFLOW_NAME's already): ok, or why not.
 * @param {import("../ci/ci-io.mjs").Run[] | null} runs
 * @param {string} sha
 * @returns {{ ok: true } | { ok: false, why: string }}
 */
export function ciVerdict(runs, sha) {
  const short = sha.slice(0, 8);
  if (!runs) return { ok: false, why: `GitHub can't be read (gh run list failed) for ${short}` };
  if (!runs.length) return { ok: false, why: `no CI run on ${short}` };
  if (runs.some((r) => r.status !== "completed"))
    return { ok: false, why: `CI is still running on ${short}: try again when it finishes` };
  const newest = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (newest.conclusion === "success") return { ok: true };
  return {
    ok: false,
    why: `CI didn't pass on ${short} (${newest.conclusion || "no conclusion"}${newest.url ? `: ${newest.url}` : ""})`,
  };
}

const git = (/** @type {string[]} */ args, cwd = process.cwd()) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};
const say = (/** @type {string} */ s) => process.stdout.write(`${s}\n`);

class Refusal extends Error {}
const refuse = (/** @type {string} */ why) => {
  throw new Refusal(why);
};
const must = (/** @type {string[]} */ args, /** @type {string} */ what, cwd = process.cwd()) => {
  const r = git(args, cwd);
  if (!r.ok) refuse(`${what} failed: ${r.err || `git ${args.join(" ")}`}`);
  return r.out;
};

/** Fetches origin's trunk into origin/<trunk>. */
const fetchTrunk = () =>
  must(
    ["fetch", "-q", "origin", `+refs/heads/${TRUNK}:refs/remotes/origin/${TRUNK}`],
    `fetching origin's ${TRUNK}`,
  );

/** Origin's v* tags (tag → commit). */
const originTags = () =>
  parseTags(must(["ls-remote", "--tags", "origin", "refs/tags/v*"], "reading origin's tags"));

/** The newest commit of REF (first parents) that changes more than the backlog's files. */
export function releaseBase(ref = `origin/${TRUNK}`, cwd = process.cwd()) {
  const shas = must(["log", "--first-parent", `-n${BASE_DEPTH}`, "--format=%H", ref], `reading ${ref}`, cwd)
    .split("\n")
    .filter(Boolean);
  for (const sha of shas) {
    const parent = git(["rev-parse", "--verify", "-q", `${sha}^`], cwd);
    const files = parent.ok
      ? must(["diff", "--name-only", parent.out, sha], `reading ${sha}`, cwd)
      : must(["ls-tree", "-r", "--name-only", sha], `reading ${sha}`, cwd);
    if (!backlogOnly(files.split("\n").filter(Boolean))) return sha;
  }
  return refuse(`no commit in ${ref}'s last ${BASE_DEPTH} changes more than ${BACKLOG_PREFIX}`);
}

/** Refuses unless CI passed on SHA. */
const requireCi = (/** @type {string} */ sha) => {
  const v = ciVerdict(listRuns(realIo(), ["--commit", sha]), sha);
  if (!v.ok) refuse(v.why);
};

/** Refuses a version that isn't above origin's highest tag (TAGS without its own). */
const requireAbove = (/** @type {string} */ version, /** @type {Map<string, string>} */ tags) => {
  const highest = highestTag([...tags.keys()].filter((t) => t !== `v${version}`));
  if (highest && compareVersions(version, highest) <= 0)
    refuse(`${version} isn't above ${highest}, the highest tag on origin`);
};

/** The check verb. */
export function check(/** @type {string} */ version) {
  fetchTrunk();
  const tags = originTags();
  if (tags.has(`v${version}`))
    refuse(`v${version} is already tagged on origin (${tags.get(`v${version}`)?.slice(0, 8)})`);
  requireAbove(version, tags);
  const base = releaseBase();
  requireCi(base);
  say(`tip=${base}`);
}

/** package.json's text with its version set to VERSION, no other byte changed. */
export function bumpPackage(/** @type {string} */ text, /** @type {string} */ version) {
  const re = /("version"\s*:\s*")([^"]*)(")/;
  if (!re.test(text)) refuse("package.json has no version");
  const next = text.replace(re, `$1${version}$3`);
  if (JSON.parse(next).version !== version) refuse("package.json's first \"version\" isn't its own");
  return next;
}

/** CHANGELOG.md's text with `## Unreleased` become `## v<version>` under a new empty one. */
export function bumpChangelog(/** @type {string} */ text, /** @type {string} */ version) {
  const re = /^## Unreleased[ \t]*$/m;
  if (!re.test(text)) refuse("CHANGELOG.md has no `## Unreleased` heading");
  return text.replace(re, `## Unreleased\n\n## v${version}`);
}

const subjectOf = (/** @type {string} */ version) => `chore(release): v${version}`;

/** The package.json version at a commit, or null. */
const versionAt = (/** @type {string} */ sha, cwd = process.cwd()) => {
  const r = git(["show", `${sha}:package.json`], cwd);
  try {
    return r.ok ? String(JSON.parse(r.out).version) : null;
  } catch {
    return null;
  }
};

/** The ship verb. */
export function ship(/** @type {string} */ version) {
  const tag = `v${version}`;
  fetchTrunk();
  const tags = originTags();
  const tagged = tags.get(tag);
  if (tagged) {
    must(["fetch", "-q", "origin", `refs/tags/${tag}`], `fetching ${tag}`);
    const at = versionAt(tagged);
    if (at !== version)
      refuse(`${tag} is on origin at ${tagged.slice(0, 8)}, whose package.json says ${at ?? "nothing"}`);
    say(`${tag} is already on origin: nothing to do`);
    say(`tag=${tag}`);
    say(`commit=${tagged}`);
    return;
  }
  requireAbove(version, tags);
  const tip = must(["rev-parse", `origin/${TRUNK}`], `reading origin/${TRUNK}`);
  const dir = mkdtempSync(join(tmpdir(), "risa-ship-"));
  const cleanup = () => {
    git(["worktree", "remove", "--force", dir]);
    rmSync(dir, { recursive: true, force: true });
    git(["worktree", "prune"]);
  };
  const onSignal = (/** @type {NodeJS.Signals} */ sig) => {
    cleanup();
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    must(["worktree", "add", "-q", "--detach", dir, tip], "making the release worktree");
    const resumed =
      git(["log", "-1", "--format=%s", "HEAD"], dir).out === subjectOf(version) &&
      versionAt("HEAD", dir) === version;
    if (resumed) say(`origin/${TRUNK} is already the release commit: tagging it`);
    else {
      requireCi(releaseBase("HEAD", dir));
      const pkg = join(dir, "package.json");
      const log = join(dir, "CHANGELOG.md");
      writeFileSync(pkg, bumpPackage(readFileSync(pkg, "utf8"), version));
      writeFileSync(log, bumpChangelog(readFileSync(log, "utf8"), version));
      must(["add", "package.json", "CHANGELOG.md"], "staging the release", dir);
      must(["commit", "-q", "-m", subjectOf(version)], "committing the release", dir);
      must(
        ["push", "-q", "origin", `HEAD:refs/heads/${TRUNK}`],
        `pushing the release to ${TRUNK} (has origin's ${TRUNK} moved?)`,
        dir,
      );
    }
    const commit = must(["rev-parse", "HEAD"], "reading the release commit", dir);
    const local = git(["rev-parse", "--verify", "-q", `refs/tags/${tag}^{commit}`], dir);
    if (local.ok && local.out !== commit)
      refuse(`a local tag ${tag} is at ${local.out.slice(0, 8)}, not the release commit`);
    if (!local.ok) must(["tag", "-a", tag, "-m", tag, commit], `making ${tag}`, dir);
    must(["push", "-q", "origin", `refs/tags/${tag}`], `pushing ${tag}`, dir);
    say(`tag=${tag}`);
    say(`commit=${commit}`);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    cleanup();
  }
}

const USAGE = "usage: release/ship.mjs check|ship <version>";
const VERBS = /** @type {Record<string, (v: string) => void>} */ ({ check, ship });

if (isMain(import.meta.url)) {
  const [verb, version, ...rest] = process.argv.slice(2);
  const run = VERBS[verb ?? ""];
  if (!run || !version || rest.length || !parts(version) || version.startsWith("v")) {
    process.stderr.write(`ship: ${!run ? `no verb ${verb ?? ""}` : "which version (1.2.3)?"}\n${USAGE}\n`);
    process.exit(2);
  }
  try {
    run(version);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    process.stderr.write(`ship ${verb}: ${e.message}\n`);
    process.exit(1);
  }
}
