// `prd ci candidate`: a release candidate, a fixed dev commit on an rc/ branch
// with its PR into staging.
//
//   candidate cut [<commit>] [--wait [min]]   dev's tip by default
//   candidate fix <commit> [--wait [min]]     a `fix` commit already in dev
//   candidate status
//
// The open candidate is the open PR into staging whose head is this repository's
// rc/*. Any other PR into staging (a held dev PR, a fork's rc/ branch) isn't one, and
// these commands never close or edit a PR. Everything runs on plumbing or a temporary
// worktree, so the caller's checkout stays as it is. Exit 6 is a refusal.
import { toolCmd } from "../loops/config.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verdictMeets } from "./gate.mjs";

export const REFUSED = 6;
const USAGE = `usage: ${toolCmd.prd} ci candidate cut [<commit>] [--wait [min]] | fix <commit> [--wait [min]] | status`;
const DEV = "refs/remotes/origin/dev";
export const STAGING = "refs/remotes/origin/staging";
const DEFAULT_WAIT_MIN = 30;
/** How far back the first-parent walk looks for the dev commit under a candidate's fixes. */
const BASE_WALK = 100;
const FIX_SUBJECT = /^fix(\([^)]+\))?!?: /;

export class Refusal extends Error {}
export const refuse = (/** @type {string} */ why) => {
  throw new Refusal(why);
};
export const short = (/** @type {string} */ sha) => sha.slice(0, 8);

/**
 * @typedef {import("./ci.mjs").Io} Io
 * @typedef {{ requestRun: (r: any, io: Io) => Promise<number>, findVerdict: (r: any, io: Io) => { verdict: any, run: any } | null, deleteRef: (io: Io, ref: string, sha: string) => boolean, verdictLines: (v: any) => string[], exitFor: (kind: string) => number }} Deps
 * @typedef {{ number: number, url: string, headRefName: string, headRefOid?: string, isCrossRepository?: boolean }} Pr
 */

/** Only this repository's rc/ heads are candidates: PR #115's `dev` and a fork's rc/ aren't. */
export const candidatePrs = (/** @type {Pr[]} */ prs) =>
  prs.filter((pr) => pr.headRefName.startsWith("rc/") && pr.isCrossRepository !== true);

/** The branch name of a cut at this time, in UTC. */
export function candidateName(/** @type {number} */ ms) {
  const iso = new Date(ms).toISOString();
  return `rc/${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 16).replace(":", "")}`;
}

export function fetchRefs(/** @type {Io} */ io) {
  const r = io.git([
    "fetch",
    "--quiet",
    "--prune",
    "origin",
    `+refs/heads/dev:${DEV}`,
    `+refs/heads/staging:${STAGING}`,
    "+refs/heads/rc/*:refs/remotes/origin/rc/*",
  ]);
  if (!r.ok) refuse("could not fetch dev, staging and the candidates from origin");
}

/** @returns {Pr[]} the open candidates; refuses when GitHub can't say */
function openCandidates(/** @type {Io} */ io) {
  const r = io.gh([
    "pr",
    "list",
    "--base",
    "staging",
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,url,headRefName,headRefOid,isCrossRepository",
  ]);
  if (!r.ok) refuse("could not read the open PRs into staging");
  try {
    return candidatePrs(JSON.parse(r.out || "[]"));
  } catch {
    return refuse("could not read the open PRs into staging");
  }
}

/** The one open candidate and its tip, or null. */
export function currentCandidate(/** @type {Io} */ io) {
  const open = openCandidates(io);
  if (open.length > 1)
    refuse(
      `more than one open candidate: ${open.map((pr) => `${pr.headRefName} (#${pr.number})`).join(", ")}`,
    );
  const pr = open[0];
  if (!pr) return null;
  const tip = io.git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${pr.headRefName}^{commit}`]);
  if (!tip.ok || !tip.out) refuse(`${pr.headRefName} (#${pr.number}) has no branch on origin`);
  return { pr, branch: pr.headRefName, tip: tip.out };
}

export const isAncestor = (/** @type {Io} */ io, /** @type {string} */ a, /** @type {string} */ b) =>
  io.git(["merge-base", "--is-ancestor", a, b]).ok;

function resolveCommit(/** @type {Io} */ io, /** @type {string} */ name) {
  if (name.startsWith("-")) refuse(`not a commit: ${name}`);
  const r = io.git(["rev-parse", "--verify", "--quiet", `${name}^{commit}`]);
  if (!r.ok || !r.out) refuse(`no such commit: ${name}`);
  return r.out;
}

/**
 * The first non-merge commit on staging that the chosen commit lacks, by patch or by
 * its `cherry picked from` trailer. Measured against the chosen commit, not dev's tip:
 * `-s ours` drops whatever the chosen commit doesn't hold.
 */
export function stagingOnlyCommit(/** @type {Io} */ io, /** @type {string} */ commit) {
  const r = io.git(["cherry", commit, STAGING]);
  if (!r.ok) refuse("could not compare staging with the commit");
  for (const line of r.out ? r.out.split("\n") : []) {
    const [mark, sha = ""] = line.split(" ");
    if (mark !== "+") continue;
    const body = io.git(["log", "-1", "--format=%B", sha]).out;
    const picked = [...body.matchAll(/\(cherry picked from commit ([0-9a-f]{40})\)/g)];
    if (!picked.some((m) => isAncestor(io, /** @type {string} */ (m[1]), commit))) return sha;
  }
  return null;
}

/** The dev commit under a candidate's fixes. */
function candidateBase(/** @type {Io} */ io, /** @type {string} */ tip) {
  const log = io.git(["rev-list", "--first-parent", `--max-count=${BASE_WALK}`, tip]);
  for (const sha of log.out ? log.out.split("\n") : []) if (isAncestor(io, sha, DEV)) return sha;
  return null;
}

const retryLine = (/** @type {string} */ branch) =>
  `no run came back. Retry: ${toolCmd.prd} ci run candidate --ref origin/${branch} --wait`;

async function requestCandidateRun(
  /** @type {{ branch: string, sha: string, waitMin: number | null }} */ { branch, sha, waitMin },
  /** @type {Io} */ io,
  /** @type {Deps} */ deps,
) {
  const code = await deps.requestRun({ tier: "candidate", branch, sha, waitMin }, io);
  if (code !== 0 && waitMin === null) io.log(retryLine(branch));
  return code;
}

async function cut(
  /** @type {{ commit: string | null, waitMin: number | null }} */ { commit, waitMin },
  /** @type {Io} */ io,
  /** @type {Deps} */ deps,
) {
  fetchRefs(io);
  const open = currentCandidate(io);
  if (open) refuse(`a candidate is open: ${open.branch} (${open.pr.url})`);

  const sha = resolveCommit(io, commit ?? DEV);
  if (!isAncestor(io, sha, DEV)) refuse(`${short(sha)} is not in dev`);
  if (isAncestor(io, sha, STAGING)) refuse(`${short(sha)} is already in staging: nothing to release`);
  const only = stagingOnlyCommit(io, sha);
  if (only) {
    const subject = io.git(["log", "-1", "--format=%s", only]).out;
    refuse(`staging holds ${short(only)} (${subject}), which ${short(sha)} lacks; the cut would drop it`);
  }

  const branch = candidateName(io.now());
  let tip = sha;
  if (!isAncestor(io, STAGING, sha)) {
    // What `merge -s ours` makes: the chosen commit's tree, with staging as a parent.
    const merged = io.git([
      "commit-tree",
      `${sha}^{tree}`,
      "-p",
      sha,
      "-p",
      STAGING,
      "-m",
      `chore(release): merge staging into ${branch}`,
    ]);
    if (!merged.ok || !merged.out) refuse("could not make the merge of staging");
    tip = merged.out;
  }
  if (
    !io.git(["push", `--force-with-lease=refs/heads/${branch}:`, "origin", `${tip}:refs/heads/${branch}`]).ok
  )
    refuse(`could not push ${branch}`);
  io.log(`cut ${branch} at ${short(tip)} from dev ${short(sha)}`);

  const pr = io.gh([
    "pr",
    "create",
    "--base",
    "staging",
    "--head",
    branch,
    "--title",
    `chore(release): candidate ${branch}`,
    "--body",
    `Release candidate of dev ${sha}. Merge with a merge commit, never squash.`,
  ]);
  if (!pr.ok) {
    const gone = deps.deleteRef(io, branch, tip);
    refuse(
      `could not open the PR into staging; ${gone ? `${branch} was deleted` : `${branch} is left on origin`}`,
    );
  }
  if (pr.out) io.log(pr.out);
  return requestCandidateRun({ branch, sha: tip, waitMin }, io, deps);
}

/** Cherry-pick in a temporary worktree; the new commit, or a refusal after an abort. */
function pick(
  /** @type {Io} */ io,
  /** @type {{ tip: string, sha: string, merge: boolean }} */ { tip, sha, merge },
) {
  const dir = mkdtempSync(join(tmpdir(), "risa-candidate-"));
  const tree = join(dir, "tree");
  try {
    if (!io.git(["worktree", "add", "--quiet", "--detach", tree, tip]).ok)
      refuse("could not make a worktree for the cherry-pick");
    const picked = io.git(["-C", tree, "cherry-pick", "-x", ...(merge ? ["-m", "1"] : []), sha]);
    if (!picked.ok) {
      io.git(["-C", tree, "cherry-pick", "--abort"]);
      refuse(`${short(sha)} doesn't apply cleanly to the candidate (a conflict, or nothing to change)`);
    }
    const head = io.git(["-C", tree, "rev-parse", "HEAD"]);
    if (!head.ok || !head.out) refuse("could not read the cherry-pick");
    return head.out;
  } finally {
    io.git(["worktree", "remove", "--force", tree]);
    rmSync(dir, { recursive: true, force: true });
    io.git(["worktree", "prune"]);
  }
}

async function fix(
  /** @type {{ commit: string, waitMin: number | null }} */ { commit, waitMin },
  /** @type {Io} */ io,
  /** @type {Deps} */ deps,
) {
  fetchRefs(io);
  const open = currentCandidate(io);
  if (!open) return refuse(`no open candidate: ${toolCmd.prd} ci candidate cut`);
  const { branch, tip } = open;

  const sha = resolveCommit(io, commit);
  if (!isAncestor(io, sha, DEV)) refuse(`${short(sha)} is not in dev: land the fix there first`);
  const subject = io.git(["log", "-1", "--format=%s", sha]).out;
  if (!FIX_SUBJECT.test(subject)) refuse(`only fix commits reach a candidate: ${short(sha)} is "${subject}"`);
  const parents = io.git(["rev-list", "--parents", "-n", "1", sha]).out.split(" ").length - 1;
  if (parents > 2) refuse(`${short(sha)} has ${parents} parents`);

  const base = candidateBase(io, tip);
  const picks = base ? io.git(["log", "--format=%B", `${base}..${tip}`]).out : "";
  if (isAncestor(io, sha, tip) || picks.includes(`(cherry picked from commit ${sha})`))
    refuse(`${short(sha)} is already on ${branch}`);

  const next = pick(io, { tip, sha, merge: parents === 2 });
  if (
    !io.git([
      "push",
      `--force-with-lease=refs/heads/${branch}:${tip}`,
      "origin",
      `${next}:refs/heads/${branch}`,
    ]).ok
  )
    refuse(`could not push ${branch}`);
  io.log(`${branch} is now ${short(next)}, with fix ${short(sha)}`);
  return requestCandidateRun({ branch, sha: next, waitMin }, io, deps);
}

function status(/** @type {Io} */ io, /** @type {Deps} */ deps) {
  fetchRefs(io);
  const open = currentCandidate(io);
  if (!open) {
    io.log("no open candidate");
    return 0;
  }
  const { pr, branch, tip } = open;
  const base = candidateBase(io, tip);
  io.log(`candidate: ${branch} (${pr.url})`);
  io.log(`commit: ${short(tip)}`);
  io.log(`base: ${base ? `dev ${short(base)}` : "unknown"}`);
  const found = deps.findVerdict(
    { sha: tip, accept: (/** @type {any} */ v) => verdictMeets(v, "candidate") },
    io,
  );
  if (!found?.verdict) {
    io.log(
      found
        ? "verdict: unknown (no candidate verdict for this commit)"
        : "verdict: unknown (GitHub can't be reached)",
    );
    return deps.exitFor("unknown");
  }
  for (const line of deps.verdictLines(found.verdict)) io.log(line);
  return deps.exitFor(found.verdict.kind);
}

/** The arguments after `cut` or `fix`. */
export function parseCandidateArgs(/** @type {string[]} */ args) {
  /** @type {string | null} */ let commit = null;
  /** @type {number | null} */ let waitMin = null;
  for (let i = 0; i < args.length; i++) {
    const a = /** @type {string} */ (args[i]);
    if (a === "--wait") {
      waitMin = DEFAULT_WAIT_MIN;
      if (/^\d+$/.test(args[i + 1] ?? "")) waitMin = Number(args[++i]);
    } else if (!a.startsWith("-") && !commit) commit = a;
    else throw new Error(USAGE);
  }
  return { commit, waitMin };
}

/**
 * @param {string[]} argv the arguments after `candidate`
 * @param {Io} io
 * @param {Deps} deps
 */
export async function runCandidate(argv, io, deps) {
  const [action, ...rest] = argv;
  try {
    if (action === "status" && !rest.length) return status(io, deps);
    if (action === "cut") return await cut(parseCandidateArgs(rest), io, deps);
    if (action === "fix") {
      const { commit, waitMin } = parseCandidateArgs(rest);
      if (!commit) throw new Error(USAGE);
      return await fix({ commit, waitMin }, io, deps);
    }
    throw new Error(USAGE);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    io.log(`refused: ${e.message}`);
    return REFUSED;
  }
}
