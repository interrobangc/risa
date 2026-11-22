#!/usr/bin/env node
// pnpm prd ci: ask GitHub for a CI run of a branch, and read its verdict.
//
//   pnpm prd ci run <tier> [--ref <branch>] [--wait [min]]
//       pushes the commit to ci/<tier>/<branch>, the only thing that starts the
//       workflow. A ref already at the commit reuses its live run, or is deleted
//       and pushed again (a push of the same commit starts nothing). With --wait
//       (default 30 min) it blocks until the verdict: exit 0 green, 1 not green,
//       75 at the timeout. The ref is deleted only after a final verdict; at a
//       timeout it stays for `pnpm prd tidy`.
//   pnpm prd ci [<branch>]
//       the latest whole-tier verdict for the branch's tip (exit 0 green, else 1).
//
// A cancelled run, a run with no verdict and an unreachable GitHub read as
// unknown, never green. Env: CARETOOK_CI_POLL (seconds between polls, 15).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { TIERS, ciRefName, isTier, parseCiRef } from "./tiers.mjs";
import { isVerdict } from "./verdict.mjs";

export const WORKFLOW = "ci.yml";
export const EXIT = { green: 0, notGreen: 1, usage: 2, timeout: 75 };
const DEFAULT_WAIT_MIN = 30;
/** How long a pushed ref gets to show a run before it reads as unknown. */
const START_WAIT_MS = 120_000;
/** Polls in a row GitHub may fail before the run reads as unknown. */
const MAX_POLL_FAILURES = 3;
const RUN_FIELDS = "databaseId,headSha,headBranch,status,conclusion,createdAt,url";

/**
 * @typedef {{ ok: boolean, out: string }} Result
 * @typedef {{ databaseId: number, headSha: string, headBranch?: string, status: string, conclusion?: string, createdAt: string, url?: string }} Run
 * @typedef {{ git: (args: string[]) => Result, gh: (args: string[]) => Result, sleep: (ms: number) => Promise<void>, now: () => number, log: (line: string) => void, pollMs: number }} Io
 */

const command = (/** @type {string} */ bin, /** @type {string[]} */ args) => {
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
};

/** @returns {Io} */
export const realIo = () => ({
  git: (args) => command("git", args),
  gh: (args) => command("gh", args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  log: (line) => console.log(line),
  pollMs: Number(process.env.CARETOOK_CI_POLL || 15) * 1000,
});

/** The remote SHA of a ref: a string (empty when absent), or null when unreachable. */
export function remoteSha(/** @type {Io} */ io, /** @type {string} */ ref) {
  const r = io.git(["ls-remote", "origin", `refs/heads/${ref}`]);
  return r.ok ? (r.out.split(/\s+/)[0] ?? "") : null;
}

/** @returns {Run[] | null} null when GitHub can't be read */
function listRuns(/** @type {Io} */ io, /** @type {string[]} */ filter) {
  const r = io.gh(["run", "list", "--workflow", WORKFLOW, ...filter, "--limit", "30", "--json", RUN_FIELDS]);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.out || "[]");
  } catch {
    return null;
  }
}

/** The verdict artifact of a run, or null. */
export function readVerdict(/** @type {Io} */ io, /** @type {number} */ runId) {
  const dir = mkdtempSync(join(tmpdir(), "caretook-ci-"));
  try {
    const r = io.gh(["run", "download", String(runId), "--name", "verdict", "--dir", dir]);
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
  if (v.notBuilt?.length)
    lines.push(`  ran up to ${v.ranTier}; not built yet, so not run: ${v.notBuilt.join(", ")}`);
  if (v.failed?.jobs?.length) lines.push(`  failed jobs: ${v.failed.jobs.join(", ")}`);
  for (const t of v.failed?.tests ?? []) lines.push(`  ${t.job}: ${t.file}: ${t.name}`);
  const named = new Set((v.failed?.tests ?? []).map((/** @type {{ file: string }} */ t) => t.file));
  for (const f of v.failed?.files ?? []) if (!named.has(f)) lines.push(`  failed file: ${f}`);
  if (v.failed?.truncated) lines.push("  (more failures: see the run)");
  return lines;
}

const unknown = (/** @type {Io} */ io, /** @type {string} */ why) => {
  io.log(`verdict: unknown (${why})`);
  return EXIT.notGreen;
};

/** Wait for a run and read its result. */
async function awaitRun(
  /** @type {Io} */ io,
  /** @type {{ run: Run, ref: string, sha: string, deadline: number }} */ { run, ref, sha, deadline },
) {
  let failures = 0;
  for (;;) {
    const r = io.gh(["run", "view", String(run.databaseId), "--json", "status,conclusion,url"]);
    /** @type {{ status?: string, conclusion?: string } | null} */ let state = null;
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
      if (state.status === "completed") {
        if (state.conclusion === "cancelled") return unknown(io, "the run was cancelled");
        const verdict = readVerdict(io, run.databaseId);
        if (!verdict) return unknown(io, "the run left no verdict");
        if (verdict.commit !== sha) return unknown(io, "the verdict is for another commit");
        for (const line of verdictLines(verdict)) io.log(line);
        if (!deleteRef(io, ref, sha)) io.log(`could not delete ${ref}; pnpm prd tidy lists it`);
        return verdict.kind === "green" ? EXIT.green : EXIT.notGreen;
      }
    }
    if (io.now() >= deadline) {
      io.log(`timed out waiting for run ${run.databaseId}; ${ref} is kept (pnpm prd tidy lists it)`);
      return EXIT.timeout;
    }
    await io.sleep(io.pollMs);
  }
}

/**
 * @param {{ tier: string, branch: string, sha: string, waitMin: number | null }} request
 * @param {Io} io
 */
export async function requestRun({ tier, branch, sha, waitMin }, io) {
  const ref = ciRefName(tier, branch);
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
  return awaitRun(io, { run, ref, sha, deadline: io.now() + waitMin * 60_000 });
}

/**
 * The latest whole-tier verdict for a commit.
 * @param {{ sha: string }} request
 * @param {Io} io
 */
export function latestVerdict({ sha }, io) {
  const runs = listRuns(io, ["--commit", sha]);
  if (runs === null) return unknown(io, "GitHub can't be reached");
  const ours = runs
    .filter((r) => r.headSha === sha && parseCiRef(r.headBranch ?? ""))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const going = ours.find((r) => r.status !== "completed");
  if (going) io.log(`a run is going: ${going.url ?? going.databaseId} (${going.headBranch})`);
  for (const r of ours) {
    if (r.status !== "completed" || r.conclusion === "cancelled") continue;
    const verdict = readVerdict(io, r.databaseId);
    if (!verdict || verdict.commit !== sha || verdict.narrowed) continue;
    for (const line of verdictLines(verdict)) io.log(line);
    return verdict.kind === "green" ? EXIT.green : EXIT.notGreen;
  }
  return unknown(io, `no verdict for ${sha.slice(0, 8)}`);
}

/**
 * The `run` command's arguments.
 * @param {string[]} args
 */
export function parseRunArgs(args) {
  const [tier, ...rest] = args;
  if (!tier || !isTier(tier)) throw new Error(`ci run needs a tier: ${TIERS.join(", ")}`);
  /** @type {string | null} */ let ref = null;
  /** @type {number | null} */ let waitMin = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--ref") {
      ref = rest[++i] ?? null;
      if (!ref || ref.startsWith("-")) throw new Error("--ref needs a branch");
    } else if (rest[i] === "--wait") {
      waitMin = DEFAULT_WAIT_MIN;
      if (/^\d+$/.test(rest[i + 1] ?? "")) waitMin = Number(rest[++i]);
    } else throw new Error(`ci run: unknown argument ${rest[i]}`);
  }
  return { tier, ref, waitMin };
}

/** The branch name and commit a request means. */
function resolve(/** @type {Io} */ io, /** @type {string | null} */ ref) {
  const branch = ref ?? io.git(["branch", "--show-current"]).out;
  if (!branch) throw new Error("not on a branch: name one with --ref");
  const sha = io.git(["rev-parse", "--verify", "--quiet", `${branch}^{commit}`]);
  if (!sha.ok || !sha.out) throw new Error(`no such branch: ${branch}`);
  return { branch, sha: sha.out };
}

export async function main(/** @type {string[]} */ argv, io = realIo()) {
  try {
    if (argv[0] === "run") {
      const { tier, ref, waitMin } = parseRunArgs(argv.slice(1));
      return await requestRun({ tier, ...resolve(io, ref), waitMin }, io);
    }
    if (argv.length > 1 || argv[0]?.startsWith("-"))
      throw new Error(
        "usage: pnpm prd ci [<branch>] | pnpm prd ci run <tier> [--ref <branch>] [--wait [min]]",
      );
    return latestVerdict({ sha: resolve(io, argv[0] ?? null).sha }, io);
  } catch (e) {
    console.error(`ci: ${/** @type {Error} */ (e).message}`);
    return EXIT.usage;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exit(await main(process.argv.slice(2)));
