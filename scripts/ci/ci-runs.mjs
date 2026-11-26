// ci-runs.mjs: part of `prd ci` (ci.mjs has the map). Runs on GitHub:
// requesting one (a push to its ci/ ref), waiting for it (an infra verdict is
// rerun once), reading its verdict artifact, writing the commit status, and
// finding a commit's verdict (findVerdict, latestVerdict, findTipVerdict).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXIT, RUN_FIELDS, WORKFLOW_NAME, exitFor } from "./ci-io.mjs";
import { ciTiers } from "./tier-data.mjs";
import { sharedNames, toolCmd } from "../loops/config.mjs";

/**
 * @typedef {import("./ci-io.mjs").Io} Io
 * @typedef {import("./ci-io.mjs").Run} Run
 */

/** How long a pushed ref gets to show a run before it reads as unknown. */
const START_WAIT_MS = 120_000;
/** Polls in a row GitHub may fail before the run reads as unknown. */
const MAX_POLL_FAILURES = 3;
const COMMIT_STATE = /** @type {Record<string, string>} */ ({
  green: "success",
  flake: "success",
  file: "failure",
  brake: "failure",
  time: "failure",
});

/** The remote SHA of a ref: a string (empty when absent), or null when unreachable. */
export function remoteSha(/** @type {Io} */ io, /** @type {string} */ ref) {
  const r = io.git(["ls-remote", "origin", `refs/heads/${ref}`]);
  return r.ok ? (r.out.split(/\s+/)[0] ?? "") : null;
}

/** @returns {Run[] | null} null when GitHub can't be read */
export function listRuns(/** @type {Io} */ io, /** @type {string[]} */ filter) {
  const r = io.gh(["run", "list", ...filter, "--limit", "30", "--json", RUN_FIELDS]);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.out || "[]").filter((/** @type {Run} */ run) => run.workflowName === WORKFLOW_NAME);
  } catch {
    return null;
  }
}

/** The verdict file's version this reader knows. The project's CI writes the file. */
export const VERDICT_VERSION = 1;

/**
 * Whether a parsed verdict file is one this reader knows: its version, and the
 * fields every reader of it needs.
 * @param {unknown} v
 */
export function isVerdict(v) {
  const o = /** @type {Record<string, unknown> | null} */ (v);
  return (
    !!o &&
    o.version === VERDICT_VERSION &&
    typeof o.commit === "string" &&
    typeof o.tier === "string" &&
    typeof o.kind === "string"
  );
}

/** The verdict artifact of a run (its `verdict.json`), or null. */
export function readVerdict(
  /** @type {Io} */ io,
  /** @type {number} */ runId,
  /** @type {number=} */ timeoutMs,
) {
  const dir = mkdtempSync(join(tmpdir(), "risa-ci-"));
  try {
    const r = io.gh(["run", "download", String(runId), "--name", "verdict", "--dir", dir], timeoutMs);
    if (!r.ok) return null;
    const verdict = JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8"));
    return isVerdict(verdict) ? verdict : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Delete a ref only while it's still at SHA: a newer request's push is left alone. */
export const deleteRef = (/** @type {Io} */ io, /** @type {string} */ ref, /** @type {string} */ sha) =>
  io.git(["push", `--force-with-lease=refs/heads/${ref}:${sha}`, "origin", `:refs/heads/${ref}`]).ok;

export function verdictLines(/** @type {any} */ v) {
  const lines = [`verdict: ${v.kind} · ${v.tier} · ${String(v.commit).slice(0, 8)} · run ${v.runId}`];
  if (v.forcedFlake) lines.push(`  a proof run that forced ${v.forcedFlake} to fail once, never a gate`);
  if (v.narrowed)
    lines.push(
      `  narrowed run of ${String(v.target).slice(0, 8)}, never a gate: ${(v.narrowedFiles ?? []).join(", ")}`,
    );
  // A verdict from before the components and full jobs existed (artifacts last 7 days).
  if (v.notBuilt?.length)
    lines.push(`  ran up to ${v.ranTier}; not built yet, so not run: ${v.notBuilt.join(", ")}`);
  if (v.failed?.jobs?.length) lines.push(`  failed jobs: ${v.failed.jobs.join(", ")}`);
  for (const t of v.failed?.tests ?? []) lines.push(`  ${t.job}: ${t.file}: ${t.name}`);
  const named = new Set((v.failed?.tests ?? []).map((/** @type {{ file: string }} */ t) => t.file));
  for (const f of v.failed?.files ?? []) if (!named.has(f)) lines.push(`  failed file: ${f}`);
  if (v.failed?.truncated) lines.push("  (more failures: see the run)");
  for (const t of v.flaky ?? [])
    lines.push(`  flaky${t.brake ? " (brake list)" : ""}: ${t.file}${t.name ? `: ${t.name}` : ""}`);
  if (v.infra?.notRun?.length) lines.push(`  browser checks not run: ${v.infra.notRun.join(", ")}`);
  else if (v.infra?.jobs?.length) lines.push(`  died before any test: ${v.infra.jobs.join(", ")}`);
  for (const t of v.time?.breaches ?? [])
    lines.push(
      `  time: ${t.job} (${t.measure}) ${t.seconds} s, ${t.verdict}${t.verdict === "warn" && !t.armed ? ", not armed" : ""}`,
    );
  if (v.browser?.length) {
    const count = (/** @type {string} */ result) =>
      v.browser.filter((/** @type {{ result: string }} */ c) => c.result === result).length;
    lines.push(
      `  browser checks: ${count("pass")} passed, ${count("flake")} flaky, ${count("fail")} failed, ${count("not-run")} not run`,
    );
  }
  for (const t of v.quarantined ?? []) lines.push(`  quarantined (${t.status}): ${t.file}: ${t.name}`);
  return lines;
}

export const unknown = (/** @type {Io} */ io, /** @type {string} */ why) => {
  io.log(`verdict: unknown (${why})`);
  return EXIT.unknown;
};

/** The commit status of a whole-tier run; a failed write only warns. */
function writeCommitStatus(/** @type {Io} */ io, /** @type {any} */ v, /** @type {string=} */ url) {
  if (v.narrowed || v.forcedFlake) return;
  const r = io.gh([
    "api",
    "-X",
    "POST",
    `repos/{owner}/{repo}/statuses/${v.commit}`,
    "-f",
    `state=${COMMIT_STATE[v.kind] ?? "error"}`,
    "-f",
    `context=${sharedNames().ciContext}/${v.tier}`,
    "-f",
    `description=${v.kind} (${v.tier})`,
    ...(url ? ["-f", `target_url=${url}`] : []),
  ]);
  if (!r.ok) io.log(`warning: could not write the commit status for ${String(v.commit).slice(0, 8)}`);
}

/** Wait for a run and read its result; an infra verdict is rerun once. */
async function awaitRun(
  /** @type {Io} */ io,
  /** @type {{ run: Run, ref: string, sha: string, deadline: number, onVerdict?: (v: any, run: Run) => void }} */ {
    run,
    ref,
    sha,
    deadline,
    onVerdict,
  },
) {
  let failures = 0;
  let reran = false;
  // After a rerun, the old attempt's completed state and verdict don't count.
  let minAttempt = 0;
  for (;;) {
    const r = io.gh(["run", "view", String(run.databaseId), "--json", "status,conclusion,url,attempt"]);
    /** @type {{ status?: string, conclusion?: string, attempt?: number } | null} */ let state = null;
    if (r.ok) {
      try {
        state = JSON.parse(r.out);
      } catch {
        state = null;
      }
    }
    if (!state) {
      if (++failures >= MAX_POLL_FAILURES) return unknown(io, "GitHub can't be reached; the ref is kept");
    } else {
      failures = 0;
      if (state.status === "completed" && (state.attempt ?? 1) >= minAttempt) {
        if (state.conclusion === "cancelled") return unknown(io, "the run was cancelled");
        const verdict = readVerdict(io, run.databaseId);
        if (!verdict) return unknown(io, "the run left no verdict");
        if (verdict.commit !== sha) return unknown(io, "the verdict is for another commit");
        for (const line of verdictLines(verdict)) io.log(line);
        const rerun =
          verdict.kind === "infra" && !reran
            ? (io.log(`infra: rerunning the failed jobs of run ${run.databaseId} once`),
              io.gh(["run", "rerun", String(run.databaseId), "--failed"]).ok)
            : false;
        if (rerun) {
          reran = true;
          minAttempt = (state.attempt ?? 1) + 1;
        } else {
          if (verdict.kind === "infra")
            io.log(reran ? "still infra after its one rerun" : "infra: the rerun could not be started");
          writeCommitStatus(io, verdict, run.url);
          onVerdict?.(verdict, run);
          if (!deleteRef(io, ref, sha)) io.log(`could not delete ${ref}; ${toolCmd.prd} tidy lists it`);
          return exitFor(verdict.kind);
        }
      }
    }
    if (io.now() >= deadline) {
      io.log(`timed out waiting for run ${run.databaseId}; ${ref} is kept (${toolCmd.prd} tidy lists it)`);
      return EXIT.timeout;
    }
    await io.sleep(io.pollMs);
  }
}

/**
 * @param {{ tier: string, branch: string, sha: string, waitMin: number | null, onVerdict?: (v: any, run: Run) => void }} request
 * @param {Io} io
 */
export async function requestRun({ tier, branch, sha, waitMin, onVerdict }, io) {
  const ref = ciTiers().ciRefName(tier, branch);
  const at = remoteSha(io, ref);
  if (at === null) return unknown(io, "GitHub can't be reached");
  const before = listRuns(io, ["--branch", ref]);
  if (before === null) return unknown(io, "GitHub can't be reached");

  let run = at === sha ? before.find((r) => r.headSha === sha && r.status !== "completed") : undefined;
  if (run) io.log(`${ref} is already running this commit: run ${run.databaseId}`);
  else {
    if (at === sha && !deleteRef(io, ref, sha))
      return unknown(io, `could not delete ${ref} to push it again`);
    const expected = at === sha ? "" : at;
    const pushed = io.git([
      "push",
      `--force-with-lease=refs/heads/${ref}:${expected}`,
      "origin",
      `${sha}:refs/heads/${ref}`,
    ]);
    if (!pushed.ok) return unknown(io, `could not push ${ref}`);
    io.log(`pushed ${sha.slice(0, 8)} to ${ref}`);

    const seen = new Set(before.map((r) => r.databaseId));
    const startBy = io.now() + START_WAIT_MS;
    for (;;) {
      run = (listRuns(io, ["--branch", ref]) ?? []).find((r) => r.headSha === sha && !seen.has(r.databaseId));
      if (run || io.now() >= startBy) break;
      await io.sleep(Math.min(io.pollMs, 5000));
    }
    if (!run) return unknown(io, `no run started for ${ref}; the ref is kept`);
  }
  if (run.url) io.log(run.url);
  if (waitMin === null) return EXIT.green;
  return awaitRun(io, { run, ref, sha, deadline: io.now() + waitMin * 60_000, onVerdict });
}

/**
 * The latest whole-tier verdict for a commit.
 * @param {{ sha: string }} request
 * @param {Io} io
 */
export function latestVerdict({ sha }, io) {
  const found = findVerdict({ sha }, io);
  if (found === null) return unknown(io, "GitHub can't be reached");
  if (!found.verdict) return unknown(io, `no verdict for ${sha.slice(0, 8)}`);
  for (const line of verdictLines(found.verdict)) io.log(line);
  return exitFor(found.verdict.kind);
}

/**
 * The newest whole-tier verdict of a commit that `accept` takes, and its run; null
 * when GitHub can't be read.
 * @param {{ sha: string, accept?: (v: any) => boolean }} request
 * @param {Io} io
 * @returns {{ verdict: any, run: Run | null } | null}
 */
export function findVerdict({ sha, accept = () => true }, io) {
  const runs = listRuns(io, ["--commit", sha]);
  if (runs === null) return null;
  const ours = runs
    .filter((r) => r.headSha === sha && ciTiers().parseCiRef(r.headBranch ?? ""))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const going = ours.find((r) => r.status !== "completed");
  if (going) io.log(`a run is going: ${going.url ?? going.databaseId} (${going.headBranch})`);
  for (const r of ours) {
    if (r.status !== "completed" || r.conclusion === "cancelled") continue;
    const verdict = readVerdict(io, r.databaseId);
    if (!verdict || verdict.commit !== sha || verdict.narrowed || verdict.forcedFlake || !accept(verdict))
      continue;
    return { verdict, run: r };
  }
  return { verdict: null, run: null };
}

/**
 * What a release gate reads: the newest finished run of this tier or higher on the
 * commit, and only that one. Unlike findVerdict, an unreadable newest verdict never
 * falls back to an older run's, and a run still going is reported. Null when GitHub
 * can't be read.
 * @param {{ sha: string, tier: string }} request
 * @param {Io} io
 * @returns {{ verdict: any, run: Run | null, going: Run | null } | null}
 */
export function findTipVerdict({ sha, tier }, io) {
  const runs = listRuns(io, ["--commit", sha]);
  if (runs === null) return null;
  const needed = ciTiers().TIERS.indexOf(/** @type {any} */ (tier));
  const ours = runs
    .filter((r) => {
      const ref = ciTiers().parseCiRef(r.headBranch ?? "");
      return r.headSha === sha && !!ref && ciTiers().TIERS.indexOf(/** @type {any} */ (ref.tier)) >= needed;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const going = ours.find((r) => r.status !== "completed") ?? null;
  if (going) return { verdict: null, run: null, going };
  const run = ours.find((r) => r.conclusion !== "cancelled") ?? null;
  return { verdict: run ? readVerdict(io, run.databaseId) : null, run, going: null };
}
