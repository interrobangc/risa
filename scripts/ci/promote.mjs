// `pnpm prd ci promote`: the staging gate. Merges the open candidate's PR only when
// the newest candidate verdict on its exact tip passes, pinned to that commit with a
// merge commit, then deletes its rc/ branch and its ci/candidate/ ref.
//
// Only an open PR from this repository's rc/* is a candidate (candidate.mjs), so a
// held dev PR into staging is never read, merged, closed or edited. The user's merge
// by hand on GitHub is the override; agents never merge a candidate any other way.
// Exit 6 is a refusal, with nothing changed. Exit 5 means the merge can't be confirmed
// and the refs are kept.
import {
  REFUSED,
  Refusal,
  STAGING,
  currentCandidate,
  fetchRefs,
  isAncestor,
  refuse,
  short,
} from "./candidate.mjs";
import { releasePasses } from "./gate.mjs";
import { tierDataOrExit } from "./tier-data.mjs";

const { ciRefName } = tierDataOrExit("ci");

const TIER = "candidate";
const UNCONFIRMED = 5;

/**
 * @typedef {import("./ci.mjs").Io} Io
 * @typedef {{ findTipVerdict: (r: { sha: string, tier: string }, io: Io) => { verdict: any, run: any, going: any } | null, deleteRef: (io: Io, ref: string, sha: string) => boolean, remoteSha: (io: Io, ref: string) => string | null, verdictLines: (v: any) => string[] }} Deps
 */

/** The PR's state on GitHub, or null when it can't be read. */
function readMerge(/** @type {Io} */ io, /** @type {number} */ number) {
  const r = io.gh(["pr", "view", String(number), "--json", "state,headRefOid,mergeCommit"]);
  if (!r.ok) return null;
  try {
    return /** @type {{ state?: string, headRefOid?: string, mergeCommit?: { oid?: string } | null }} */ (
      JSON.parse(r.out)
    );
  } catch {
    return null;
  }
}

/** Delete the merged rc/ branch, only while it's still at the merged commit. */
function deleteBranch(
  /** @type {Io} */ io,
  /** @type {Deps} */ deps,
  /** @type {string} */ branch,
  /** @type {string} */ tip,
) {
  const at = deps.remoteSha(io, branch);
  if (at === "") return;
  if (at === tip && deps.deleteRef(io, branch, tip)) io.log(`deleted ${branch}`);
  else if (at !== null && at !== tip)
    io.log(`warning: ${branch} moved to ${short(at)} after the merge; it is kept`);
  else io.log(`warning: could not delete ${branch}: git push origin :refs/heads/${branch}`);
}

/** Delete the candidate's CI ref, wherever it points: it belongs to this candidate alone. */
function deleteCiRef(/** @type {Io} */ io, /** @type {Deps} */ deps, /** @type {string} */ branch) {
  const ref = ciRefName(TIER, branch);
  const at = deps.remoteSha(io, ref);
  if (at === "") return;
  if (at && deps.deleteRef(io, ref, at)) io.log(`deleted ${ref}`);
  else io.log(`warning: could not delete ${ref}; pnpm prd tidy lists it`);
}

function promote(/** @type {Io} */ io, /** @type {Deps} */ deps) {
  fetchRefs(io);
  const open = currentCandidate(io);
  if (!open) return refuse("no open candidate: pnpm prd ci candidate cut");
  const { pr, branch, tip } = open;
  if (pr.headRefOid !== tip)
    refuse(
      `${branch} (#${pr.number}) is at ${short(pr.headRefOid ?? "unknown")} on the PR, ${short(tip)} here`,
    );
  // Only then is the merge's tree exactly the tree the verdict tested.
  if (!isAncestor(io, STAGING, tip))
    refuse(`staging moved since ${branch} was cut: close it and cut a new candidate`);

  const found = deps.findTipVerdict({ sha: tip, tier: TIER }, io);
  if (!found) return refuse(`GitHub can't be reached, so ${short(tip)} has no verdict to read`);
  if (found.going)
    refuse(`a run is still going on ${short(tip)}: ${found.going.url ?? found.going.databaseId}`);
  if (!found.verdict)
    refuse(
      `no readable ${TIER} verdict for ${short(tip)} (none ran, or its 7-day artifact expired). Run: pnpm prd ci run ${TIER} --ref origin/${branch} --wait`,
    );
  for (const line of deps.verdictLines(found.verdict)) io.log(line);
  const decision = releasePasses(found.verdict, TIER, tip);
  if (!decision.pass) refuse(`${branch} at ${short(tip)}: ${decision.why}`);

  const merged = io.gh([
    "pr",
    "merge",
    String(pr.number),
    "--merge",
    "--match-head-commit",
    tip,
    "--subject",
    `chore(release): promote ${branch} to staging (#${pr.number})`,
    "--body",
    `Candidate ${tip}, ${found.verdict.kind} in run ${found.verdict.runId}.`,
  ]);

  // The merge's answer can be lost, and a merged PR must not be read as refused.
  const state = readMerge(io, pr.number);
  if (state?.state === "MERGED" && state.headRefOid === tip) {
    io.log(`promoted ${branch} at ${short(tip)} into staging (${pr.url})`);
    if (state.mergeCommit?.oid) io.log(`merge commit: ${short(state.mergeCommit.oid)}`);
    deleteBranch(io, deps, branch, tip);
    deleteCiRef(io, deps, branch);
    return 0;
  }
  if (!merged.ok && state?.state === "OPEN")
    refuse(`GitHub refused the merge of #${pr.number}: nothing was merged (${pr.url})`);
  io.log(`could not confirm the merge of #${pr.number}; ${branch} is kept. Look at ${pr.url}`);
  return UNCONFIRMED;
}

/**
 * @param {string[]} argv the arguments after `promote`
 * @param {Io} io
 * @param {Deps} deps
 */
export function runPromote(argv, io, deps) {
  if (argv.length) throw new Error("usage: pnpm prd ci promote");
  try {
    return promote(io, deps);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    io.log(`refused: ${e.message}`);
    return REFUSED;
  }
}
