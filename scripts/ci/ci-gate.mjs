// ci-gate.mjs: part of `pnpm prd ci` (ci.mjs has the map). `ci gate`, the landing
// gate: the verdict that still vouches for the tip, a run requested when there is
// none, blame when it's needed, then the decision (the pure rules are gate.mjs).
import { writeFileSync } from "node:fs";

import { keepsVerdict } from "../loops/check-plan.mjs";
import { splitAgainstDev } from "./ci-blame.mjs";
import { DEFAULT_WAIT_MIN, EXIT, exitFor } from "./ci-io.mjs";
import { findVerdict, requestRun, unknown, verdictLines } from "./ci-runs.mjs";
import { decideGate, needsBlame, verdictMeets } from "./gate.mjs";

/**
 * @typedef {import("./ci-io.mjs").Io} Io
 * @typedef {import("./ci-io.mjs").Run} Run
 */

/** How many first-parent commits the gate looks back for a verdict that still holds. */
const GATE_WALK = 20;

/**
 * The newest verdict that still vouches for the tip at this tier: on the tip, or on
 * a first-parent ancestor with only docs, tooling or CI's lists changed since.
 * @param {{ sha: string, base: string, tier: string }} request
 * @param {Io} io
 * @returns {{ verdict: any, run: Run | null } | null} null when git or GitHub can't be read
 */
function findGateVerdict({ sha, base, tier }, io) {
  const log = io.git(["rev-list", "--first-parent", `--max-count=${GATE_WALK}`, `${base}..${sha}`]);
  if (!log.ok) return null;
  for (const commit of log.out ? log.out.split("\n") : []) {
    const found = findVerdict({ sha: commit, accept: (v) => verdictMeets(v, tier) }, io);
    if (found === null || found.verdict) return found;
    const diff = io.git(["diff", "--name-only", "--no-renames", `${commit}^1`, commit]);
    if (!diff.ok || !keepsVerdict(diff.out ? diff.out.split("\n") : [])) break;
  }
  return { verdict: null, run: null };
}

/**
 * `ci gate`: whether this branch's tip may land at this tier.
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
  const found = findGateVerdict({ sha, base, tier }, io);
  if (found === null) return unknown(io, "GitHub can't be reached");
  let { verdict, run } = found;
  if (!verdict && peek) {
    io.log(`no ${tier} verdict for ${sha.slice(0, 8)}: the landing will request one`);
    return EXIT.unknown;
  }
  if (!verdict) {
    io.log(`no ${tier} verdict for ${sha.slice(0, 8)}: requesting one`);
    const code = await requestRun(
      {
        tier,
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
      io.log(`no verdict came back. Retry: pnpm prd ci run ${tier} --ref ${branch} --wait`);
      return code || EXIT.unknown;
    }
  }
  for (const line of verdictLines(verdict)) io.log(line);
  if (!verdictMeets(verdict, tier)) {
    io.log(`the run reached ${verdict.ranTier ?? "no tier"}, below ${tier}: refused`);
    return EXIT.unknown;
  }
  if (peek) return exitFor(verdict.kind);

  /** @type {import("./gate.mjs").Blamed | null} */ let blamed = null;
  if (needsBlame(verdict, touched)) {
    const result = await splitAgainstDev({ branch, verdict, run, waitMin }, io);
    if (typeof result === "string") io.log(`blame: ${result}`);
    else blamed = result;
  }
  const decision = decideGate({ verdict, tier, branch, touched, blamed, fixes });
  for (const line of decision.lines) io.log(line);
  if (out)
    writeFileSync(
      out,
      `${[
        `land=${decision.land ? 1 : 0}`,
        `kind=${verdict.kind}`,
        `ranTier=${verdict.ranTier}`,
        `commit=${verdict.commit}`,
        `run=${verdict.runId}`,
        `flakes=${decision.fileFlakes ? 1 : 0}`,
      ].join("\n")}\n`,
    );
  return decision.code;
}
