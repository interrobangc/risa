// ci-gate.mjs: part of `prd ci` (ci.mjs has the map). `ci gate`, the landing
// gate: the verdict that still vouches for the tip, a run requested when there is
// none, blame when it's needed, then the decision (the pure rules are gate.mjs).
import { toolCmd } from "../loops/config.mjs";
import { writeFileSync } from "node:fs";

import { keepsVerdict, syncTier } from "../loops/check-plan.mjs";
import { splitAgainstDev } from "./ci-blame.mjs";
import { DEFAULT_WAIT_MIN, EXIT, exitFor } from "./ci-io.mjs";
import { findVerdict, requestRun, unknown, verdictLines } from "./ci-runs.mjs";
import { decideGate, needsBlame, verdictMeets, walkVerdicts } from "./gate.mjs";

/**
 * @typedef {import("./ci-io.mjs").Io} Io
 * @typedef {import("./ci-io.mjs").Run} Run
 */

/** How many first-parent commits the gate looks back for a verdict that still holds. */
const GATE_WALK = 20;

/**
 * The verdicts that still vouch for the tip at this tier (walkVerdicts): on the tip,
 * behind only docs, tooling or CI's lists, or behind dev syncs with a recheck of what
 * they brought and the pre-sync verdict carried.
 * @param {{ sha: string, base: string, tier: string, touched: string[] }} request
 * @param {Io} io
 * @returns {import("./gate.mjs").Walked | null} null when git or GitHub can't be read
 */
function findGateVerdict({ sha, base, tier, touched }, io) {
  const log = io.git(["rev-list", "--first-parent", `--max-count=${GATE_WALK}`, `${base}..${sha}`]);
  if (!log.ok) return null;
  return walkVerdicts({
    commits: log.out ? log.out.split("\n") : [],
    tier,
    touched,
    verdictAt: (commit, t) => findVerdict({ sha: commit, accept: (v) => verdictMeets(v, t) }, io),
    changeOf: (commit) => {
      const diff = io.git(["diff", "--name-only", "--no-renames", `${commit}^1`, commit]);
      if (!diff.ok) return null;
      const files = diff.out ? diff.out.split("\n") : [];
      // A dev sync: a merge whose second parent dev already holds.
      const second = io.git(["rev-parse", "--verify", "--quiet", `${commit}^2`]);
      if (second.ok && second.out && io.git(["merge-base", "--is-ancestor", second.out, base]).ok)
        return syncTier(files, touched).tier;
      return keepsVerdict(files) ? "none" : null;
    },
  });
}

/**
 * `ci gate`: whether this branch's tip may land at this tier. Behind a dev sync it may
 * wait for less: a recheck of what dev brought.
 * @param {{ branch: string, sha: string, tier: string, base: string, fixes?: string[], out?: string | null, peek?: boolean, waitMin?: number }} request
 * @param {Io} io
 */
export async function gate(
  { branch, sha, tier, base, fixes = [], out = null, peek = false, waitMin = DEFAULT_WAIT_MIN },
  io,
) {
  const diff = io.git(["diff", "--name-only", "--no-renames", `${base}...${sha}`]);
  if (!diff.ok) return unknown(io, "could not read what the branch changed");
  const touched = diff.out ? diff.out.split("\n") : [];
  const found = findGateVerdict({ sha, base, tier, touched }, io);
  if (found === null) return unknown(io, "GitHub can't be reached");
  let { verdict, run } = found;
  const { carried, need } = found;
  if (found.why) io.log(found.why);
  if (carried)
    io.log(
      `dev synced in since the ${carried.verdict.ranTier} verdict on ${String(carried.verdict.commit).slice(0, 8)}: ` +
        `carrying its ${carried.verdict.kind}, with a recheck at ${need} of what dev brought`,
    );
  if (!verdict && peek) {
    io.log(`no ${need} verdict for ${sha.slice(0, 8)}: the landing will request one`);
    return EXIT.unknown;
  }
  if (!verdict) {
    io.log(`no ${need} verdict for ${sha.slice(0, 8)}: requesting one`);
    const code = await requestRun(
      {
        tier: need,
        branch,
        sha,
        waitMin,
        onVerdict: (v, r) => {
          verdict = v;
          run = r;
        },
      },
      io,
    );
    if (!verdict) {
      io.log(`no verdict came back. Retry: ${toolCmd.prd} ci run ${need} --ref ${branch} --wait`);
      return code || EXIT.unknown;
    }
  }
  for (const line of verdictLines(verdict)) io.log(line);
  if (!verdictMeets(verdict, need)) {
    io.log(`the run reached ${verdict.ranTier ?? "no tier"}, below ${need}: refused`);
    return EXIT.unknown;
  }
  if (peek) return exitFor(verdict.kind);

  /** @type {import("./gate.mjs").Blamed | null} */ let blamed = null;
  if (needsBlame(verdict, touched)) {
    const result = await splitAgainstDev({ branch, verdict, run, waitMin }, io);
    if (typeof result === "string") io.log(`blame: ${result}`);
    else blamed = result;
  }
  const decision = decideGate({ verdict, tier: need, branch, touched, blamed, fixes });
  for (const line of decision.lines) io.log(line);
  // With a carried verdict: the wave's tier, both runs (ci file files each one's
  // flakes), and a flake if either flaked.
  const prior = carried?.verdict;
  const kind = prior?.kind === "flake" && verdict.kind === "green" ? "flake" : verdict.kind;
  if (out)
    writeFileSync(
      out,
      `${[
        `land=${decision.land ? 1 : 0}`,
        `kind=${kind}`,
        `ranTier=${prior ? `${prior.ranTier} (${verdict.ranTier} recheck)` : verdict.ranTier}`,
        `commit=${verdict.commit}`,
        `run=${prior ? `${verdict.runId},${prior.runId}` : verdict.runId}`,
        `flakes=${decision.fileFlakes || (decision.land && (prior?.flaky ?? []).length > 0) ? 1 : 0}`,
      ].join("\n")}\n`,
    );
  return decision.code;
}
