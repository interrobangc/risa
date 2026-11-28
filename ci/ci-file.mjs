// ci-file.mjs: part of `ci` (ci.mjs has the map). Filing in the
// backlog: `ci file` (a verdict's flakes) and `ci zone-file` (a release verdict's
// second-zone failures; the release gate files through fileZoneVerdict).
import { sortFlakes } from "./blame.mjs";
import { failureLabel, logFailure } from "./ci-blame.mjs";
import { EXIT } from "./ci-io.mjs";
import { findVerdict, readVerdict, unknown } from "./ci-runs.mjs";
import { zoneFindings } from "./release.mjs";

/**
 * @typedef {import("./ci-io.mjs").Io} Io
 * @typedef {import("./ci-io.mjs").Run} Run
 */

/**
 * `ci file`: file a verdict's flakes: the given run's, else the commit's latest. The
 * landing passes --run and --base (dev before its merge), since after the merge the
 * branch's diff is empty, and --no-push on a local landing. A list of runs (1,2: a
 * recheck and the verdict it carried) files each one's; the worst exit wins.
 * @param {{ branch: string, sha: string, base?: string | null, runId?: string | null, noPush?: boolean }} request
 * @param {Io} io
 */
export function fileFlakes({ runId = null, ...request }, io) {
  if (!runId?.includes(",")) return fileRunFlakes({ ...request, runId }, io);
  let code = EXIT.green;
  for (const id of runId.split(",")) code = Math.max(code, fileRunFlakes({ ...request, runId: id }, io));
  return code;
}

/**
 * One run's flakes (fileFlakes).
 * @param {{ branch: string, sha: string, base?: string | null, runId?: string | null, noPush?: boolean }} request
 * @param {Io} io
 */
function fileRunFlakes({ branch, sha, base = null, runId = null, noPush = false }, io) {
  const given = runId ? readVerdict(io, Number(runId)) : null;
  if (runId && (!given || given.narrowed)) return unknown(io, `no whole-tier verdict in run ${runId}`);
  const found = given ? { verdict: given, run: null } : findVerdict({ sha }, io);
  if (found === null) return unknown(io, "GitHub can't be reached");
  if (!found.verdict) return unknown(io, `no verdict for ${sha.slice(0, 8)}`);
  const flaky = found.verdict.flaky ?? [];
  if (!flaky.length) {
    io.log("no flakes to file");
    return EXIT.green;
  }
  if (!base && !io.git(["fetch", "--quiet", "origin", "dev"]).ok) return unknown(io, "could not fetch dev");
  const diff = io.git(["diff", "--name-only", `${base ?? "refs/remotes/origin/dev"}...${sha}`]);
  // Without the diff, nothing says whose the flake is: nothing is written.
  if (!diff.ok) return unknown(io, "could not read what the branch changed");
  const touched = diff.out ? diff.out.split("\n") : [];
  const sorted = sortFlakes(flaky, touched, { branch, ...(found.run?.url ? { url: found.run.url } : {}) });
  for (const t of sorted.branch) logFailure(io, `  the branch's flake: ${failureLabel(t)}`, t);
  if (sorted.findings.length) {
    const push = !noPush && sorted.findings.some((f) => f.quarantine);
    const out = io.fileFindings?.(sorted.findings, push) ?? null;
    if (!out) return unknown(io, "could not file the flakes");
    for (const f of out.filed) io.log(`  ${f.created ? "filed" : "noted on"} ${f.id}`);
    for (const line of out.removed) io.log(`  left the quarantine: ${line.replaceAll("\t", " ")}`);
    if (push && out.pushed === false) return unknown(io, "the quarantine commit is on dev but wasn't pushed");
  }
  return sorted.branch.length ? EXIT.file : EXIT.green;
}

/**
 * `ci zone-file`: file a release verdict's second-zone failures. Safe to rerun: a
 * file's key is stable and each item takes one note per commit.
 * @param {{ sha: string, runId?: string | null }} request
 * @param {Io} io
 */
export function fileSecondZone({ sha, runId = null }, io) {
  const isRelease = (/** @type {any} */ v) => v?.ranTier === "release" && !v.narrowed && !v.forcedFlake;
  const given = runId ? readVerdict(io, Number(runId)) : null;
  if (runId && !isRelease(given)) return unknown(io, `no whole release verdict in run ${runId}`);
  const found = given ? { verdict: given, run: null } : findVerdict({ sha, accept: isRelease }, io);
  if (found === null) return unknown(io, "GitHub can't be reached");
  if (!found.verdict) return unknown(io, `no release verdict for ${sha.slice(0, 8)}`);
  return fileZoneVerdict(found.verdict, found.run, io);
}

/**
 * File one release verdict's second-zone failures.
 * @param {any} verdict
 * @param {Run | null} run
 * @param {Io} io
 */
export function fileZoneVerdict(verdict, run, io) {
  const findings = zoneFindings(verdict, run?.url ? { url: run.url } : {});
  if (!findings.length) {
    io.log("no second-zone failures to file");
    return EXIT.green;
  }
  const out = io.fileFindings?.(findings, false) ?? null;
  if (!out) return unknown(io, "could not file the second-zone failures");
  for (const f of out.filed) io.log(`  ${f.created ? "filed" : "on"} ${f.id}`);
  if (out.missed?.length) return unknown(io, `no such item for the overflow: ${out.missed.join(", ")}`);
  return EXIT.green;
}
