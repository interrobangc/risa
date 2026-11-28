// `ci promote`: the staging gate. Merges the open candidate's PR only when
// the newest candidate verdict on its exact tip passes, pinned to that commit with a
// merge commit, then deletes its rc/ branch and its ci/candidate/ ref.
//
// Only an open PR from this repository's rc/* is a candidate (candidate.mjs), so a
// held dev PR into staging is never read, merged, closed or edited. The user's merge
// by hand on GitHub is the override; agents never merge a candidate any other way.
// Exit 6 is a refusal, with nothing changed. Exit 5 means the merge can't be confirmed
// and the refs are kept. A passing flake's tests are filed once the merge is
// confirmed, the way `ci file` files them (filing.mjs): an item per test, or a note on
// the open item that has it, the run linked.
import { toolCmd } from "../loops/config.mjs";
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
import { sortFlakes } from "./blame.mjs";
import { releasePasses } from "./gate.mjs";
import { ciTiers } from "./tier-data.mjs";

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
  const ref = ciTiers().ciRefName(TIER, branch);
  const at = deps.remoteSha(io, ref);
  if (at === "") return;
  if (at && deps.deleteRef(io, ref, at)) io.log(`deleted ${ref}`);
  else io.log(`warning: could not delete ${ref}; ${toolCmd.prd} tidy lists it`);
}

/**
 * File a merged candidate's flaky tests. The quarantine entries stay in the local
 * backlog commit, unpushed, as `ci zone-file` leaves them; a failure here is a
 * warning, since the merge already happened.
 * @param {Io} io
 * @param {string} branch
 * @param {any} verdict
 * @param {any} run
 */
function fileFlakes(io, branch, verdict, run) {
  const flaky = Array.isArray(verdict.flaky) ? verdict.flaky : [];
  if (!flaky.length) return;
  const { findings } = sortFlakes(flaky, [], { branch, ...(run?.url ? { url: run.url } : {}) });
  const out = io.fileFindings?.(findings, false) ?? null;
  if (!out) {
    io.log(`warning: could not file the flaky tests: ${toolCmd.prd} ci file --run ${verdict.runId}`);
    return;
  }
  for (const f of out.filed) io.log(`  ${f.created ? "filed" : "noted on"} ${f.id}`);
  for (const line of out.removed) io.log(`  left the quarantine: ${line.replaceAll("\t", " ")}`);
}

function promote(/** @type {Io} */ io, /** @type {Deps} */ deps) {
  fetchRefs(io);
  const open = currentCandidate(io);
  if (!open) return refuse(`no open candidate: ${toolCmd.prd} ci candidate cut`);
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
      `no readable ${TIER} verdict for ${short(tip)} (none ran, or its 7-day artifact expired). Run: ${toolCmd.prd} ci run ${TIER} --ref origin/${branch} --wait`,
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
    fileFlakes(io, branch, found.verdict, found.run);
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
  if (argv.length) throw new Error(`usage: ${toolCmd.prd} ci promote`);
  try {
    return promote(io, deps);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    io.log(`refused: ${e.message}`);
    return REFUSED;
  }
}
