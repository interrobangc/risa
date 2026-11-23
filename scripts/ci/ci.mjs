#!/usr/bin/env node
// pnpm prd ci: ask GitHub for a CI run of a branch, and read its verdict.
//
//   pnpm prd ci run <tier> [--ref <branch>] [--files <file>…] [--wait [min]]
//       pushes the commit to ci/<tier>/<branch>, the only thing that starts the
//       workflow. A ref already at the commit reuses its live run, or is deleted
//       and pushed again (a push of the same commit starts nothing). With --wait
//       (default 30 min) it blocks until the verdict: exit 0 green, 1 brake, 2 file,
//       3 flake, 4 infra, 5 unknown, 75 at the timeout. The ref is deleted only
//       after a final verdict; at a timeout it stays for `pnpm prd tidy`.
//       --files narrows the run to those test files: a throwaway commit on top of
//       the target adds the list, on its own ref, and its verdict never counts as
//       the branch's.
//   pnpm prd ci [<branch>]
//       the latest whole-tier verdict for the branch's tip (exits by kind).
//   pnpm prd ci blame [<branch>] [--json]
//       splits a file or brake verdict against a run on dev's tip and files dev's
//       failures: exit 0 all dev's, 2 some the branch's, 5 unknown.
//   pnpm prd ci file [<branch>] [--base <sha>]
//       files the verdict's flakes; a file the branch touched (against --base, else
//       origin/dev) is the branch's and writes nothing: exit 0, 2 some the branch's, 5 unknown.
//   pnpm prd ci status <branch>…
//       each branch's latest whole-tier verdict, cached, for pnpm prd status.
//
// An infra verdict is rerun once (--failed). A whole-tier run's final verdict is
// written as the commit status caretook-ci/<tier>; a narrowed run gets none.
//
// A cancelled run, a run with no verdict and an unreachable GitHub read as
// unknown, never green. Env: CARETOOK_CI_POLL (seconds between polls, 15).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createNotice, listNotices, withdrawNotice } from "../loops/notices.mjs";
import {
  blameExit,
  brakeNotice,
  devFindings,
  devResultUsable,
  devRunPlan,
  noticeKey,
  slicesNear,
  sortFlakes,
  splitFailures,
  verdictFailures,
} from "./blame.mjs";
import { NARROWED_FILE, TIERS, ciRefName, fileTier, isTier, parseCiRef } from "./tiers.mjs";
import { isVerdict } from "./verdict.mjs";

/** The workflow's name. Runs are filtered by it: `gh run list --workflow` 404s until ci.yml is on the default branch. */
export const WORKFLOW_NAME = "CI";
export const EXIT = { green: 0, brake: 1, file: 2, flake: 3, infra: 4, unknown: 5, usage: 64, timeout: 75 };
/** A verdict's exit code; a kind this version doesn't know is unknown, never green. */
export const exitFor = (/** @type {string} */ kind) =>
  kind !== "usage" && kind !== "timeout" && Object.hasOwn(EXIT, kind)
    ? EXIT[/** @type {keyof typeof EXIT} */ (kind)]
    : EXIT.unknown;
const DEFAULT_WAIT_MIN = 30;
/** How long a pushed ref gets to show a run before it reads as unknown. */
const START_WAIT_MS = 120_000;
/** Polls in a row GitHub may fail before the run reads as unknown. */
const MAX_POLL_FAILURES = 3;
const RUN_FIELDS = "databaseId,headSha,headBranch,status,conclusion,createdAt,url,workflowName,attempt";
/** `pnpm prd status` redraws every 5 s: GitHub is asked at most this often, and never for longer. */
const STATUS_TTL_MS = 30_000;
const STATUS_TIMEOUT_MS = 10_000;
const STATUS_KEEP_MS = 7 * 24 * 3600_000;
const COMMIT_STATE = /** @type {Record<string, string>} */ ({
  green: "success",
  flake: "success",
  file: "failure",
  brake: "failure",
});

/**
 * @typedef {{ ok: boolean, out: string }} Result
 * @typedef {{ databaseId: number, headSha: string, headBranch?: string, status: string, conclusion?: string, createdAt: string, url?: string, workflowName?: string, attempt?: number }} Run
 * @typedef {{ list: () => { id: string, text: string }[], post: (text: string) => void, withdraw: (id: string) => void }} Board
 * @typedef {{ read: (name: string) => string | null, write: (name: string, text: string) => void }} Cache
 * @typedef {{ git: (args: string[], input?: string) => Result, gh: (args: string[], timeoutMs?: number) => Result, sleep: (ms: number) => Promise<void>, now: () => number, log: (line: string) => void, pollMs: number, fileFindings?: (findings: any[], push: boolean) => { filed: { key: string, id: string, created: boolean }[], removed: string[], pushed: boolean | null } | null, board?: () => Board, cache?: () => Cache }} Io
 */

const command = (
  /** @type {string} */ bin,
  /** @type {string[]} */ args,
  /** @type {string=} */ input,
  timeout = 120_000,
) => {
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    input,
    timeout,
  });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
};

/** The main checkout: the backlog, the board and the status cache live there, for every worktree. */
const mainCheckout = () =>
  dirname(command("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]).out);

/** The status cache: small files under the main checkout's .loops/, old ones pruned on write. */
function statusCache() {
  const dir = join(mainCheckout(), ".loops", ".ci-status");
  return {
    read: (/** @type {string} */ name) => {
      try {
        return readFileSync(join(dir, name), "utf8");
      } catch {
        return null;
      }
    },
    write: (/** @type {string} */ name, /** @type {string} */ text) => {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, name), text);
        for (const f of readdirSync(dir))
          if (Date.now() - statSync(join(dir, f)).mtimeMs > STATUS_KEEP_MS)
            rmSync(join(dir, f), { force: true });
      } catch {
        // A status line is never worth failing over.
      }
    },
  };
}

function noticeBoard() {
  const dir = process.env.CARETOOK_NOTICES_DIR || join(mainCheckout(), ".loops", ".notices");
  return {
    list: () => listNotices(dir),
    post: (/** @type {string} */ text) => {
      createNotice(dir, { text, session: "ci", minutes: 24 * 60 });
    },
    withdraw: (/** @type {string} */ id) => {
      withdrawNotice(dir, id);
    },
  };
}

/** The backlog's locked write (`pnpm backlog ci-file`). */
function fileFindings(/** @type {any[]} */ findings, /** @type {boolean} */ push) {
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "backlog", "backlog.mjs");
  const r = spawnSync(process.execPath, [cli, "ci-file", ...(push ? ["--push"] : [])], {
    encoding: "utf8",
    input: JSON.stringify({ findings }),
    timeout: 120_000,
  });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    return null;
  }
}

/** @returns {Io} */
export const realIo = () => ({
  git: (args, input) => command("git", args, input),
  gh: (args, timeoutMs) => command("gh", args, undefined, timeoutMs),
  fileFindings,
  board: noticeBoard,
  cache: statusCache,
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
  const r = io.gh(["run", "list", ...filter, "--limit", "30", "--json", RUN_FIELDS]);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.out || "[]").filter((/** @type {Run} */ run) => run.workflowName === WORKFLOW_NAME);
  } catch {
    return null;
  }
}

/** The verdict artifact of a run, or null. */
export function readVerdict(
  /** @type {Io} */ io,
  /** @type {number} */ runId,
  /** @type {number=} */ timeoutMs,
) {
  const dir = mkdtempSync(join(tmpdir(), "caretook-ci-"));
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
  if (v.infra?.jobs?.length) lines.push(`  died before any test: ${v.infra.jobs.join(", ")}`);
  for (const t of v.quarantined ?? []) lines.push(`  quarantined (${t.status}): ${t.file}: ${t.name}`);
  return lines;
}

const unknown = (/** @type {Io} */ io, /** @type {string} */ why) => {
  io.log(`verdict: unknown (${why})`);
  return EXIT.unknown;
};

/** The commit status of a whole-tier run; a failed write only warns. */
function writeCommitStatus(/** @type {Io} */ io, /** @type {any} */ v, /** @type {string=} */ url) {
  if (v.narrowed) return;
  const r = io.gh([
    "api",
    "-X",
    "POST",
    `repos/{owner}/{repo}/statuses/${v.commit}`,
    "-f",
    `state=${COMMIT_STATE[v.kind] ?? "error"}`,
    "-f",
    `context=caretook-ci/${v.tier}`,
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
          if (!deleteRef(io, ref, sha)) io.log(`could not delete ${ref}; pnpm prd tidy lists it`);
          return exitFor(verdict.kind);
        }
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
 * @param {{ tier: string, branch: string, sha: string, waitMin: number | null, onVerdict?: (v: any, run: Run) => void }} request
 * @param {Io} io
 */
export async function requestRun({ tier, branch, sha, waitMin, onVerdict }, io) {
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
 * The newest whole-tier verdict of a commit and its run; null when GitHub can't be read.
 * @param {{ sha: string }} request
 * @param {Io} io
 * @returns {{ verdict: any, run: Run | null } | null}
 */
function findVerdict({ sha }, io) {
  const runs = listRuns(io, ["--commit", sha]);
  if (runs === null) return null;
  const ours = runs
    .filter((r) => r.headSha === sha && parseCiRef(r.headBranch ?? ""))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const going = ours.find((r) => r.status !== "completed");
  if (going) io.log(`a run is going: ${going.url ?? going.databaseId} (${going.headBranch})`);
  for (const r of ours) {
    if (r.status !== "completed" || r.conclusion === "cancelled") continue;
    const verdict = readVerdict(io, r.databaseId);
    if (!verdict || verdict.commit !== sha || verdict.narrowed) continue;
    return { verdict, run: r };
  }
  return { verdict: null, run: null };
}

/** The merges on a branch since dev, with the files each changed. */
function branchMerges(/** @type {Io} */ io, /** @type {string} */ devSha, /** @type {string} */ sha) {
  const log = io.git(["log", "--merges", "--format=%H%x09%s", `${devSha}..${sha}`]);
  if (!log.ok || !log.out) return [];
  return log.out.split("\n").map((line) => {
    const [hash = "", subject = ""] = line.split("\t");
    const diff = io.git(["diff", "--name-only", `${hash}^1`, hash]);
    return { subject, files: diff.ok && diff.out ? diff.out.split("\n") : [] };
  });
}

const failureLabel = (/** @type {import("./blame.mjs").Failure} */ f) =>
  f.file ? `${f.file}${f.name ? `: ${f.name}` : ""}` : `${f.job} job`;

/** File dev's failures, post one notice per dev brake, and withdraw the ones a pass cleared. */
function fileDevFailures(
  /** @type {Io} */ io,
  /** @type {import("./blame.mjs").Split} */ split,
  /** @type {{ branch: string, url?: string }} */ from,
) {
  /** @type {Map<string, string>} */ const ids = new Map();
  if (split.dev.length) {
    const out = io.fileFindings?.(devFindings(split.dev, from), false) ?? null;
    if (!out) io.log("warning: could not file dev's failures in the backlog");
    for (const f of out?.filed ?? []) ids.set(f.key, f.id);
  }
  const board = io.board?.();
  if (!board) return ids;
  try {
    const live = board.list();
    const posted = new Set(live.map((n) => noticeKey(n.text)).filter(Boolean));
    for (const f of split.dev) {
      const id = ids.get(f.key);
      if (!f.brake || !id || posted.has(f.key)) continue;
      board.post(brakeNotice(id, f));
      posted.add(f.key);
    }
    const passed = new Set(split.branch.filter((f) => !f.absent).map((f) => f.key));
    for (const n of live) {
      const key = noticeKey(n.text);
      if (key && passed.has(key)) board.withdraw(n.id);
    }
  } catch (e) {
    io.log(`warning: the notice board: ${/** @type {Error} */ (e).message}`);
  }
  return ids;
}

/**
 * `ci blame`: split the latest file or brake verdict against dev's tip.
 * @param {{ branch: string, sha: string, json?: boolean, waitMin?: number }} request
 * @param {Io} realLog
 */
export async function blame({ branch, sha, json = false, waitMin = DEFAULT_WAIT_MIN }, realLog) {
  const io = json ? { ...realLog, log: () => {} } : realLog;
  const found = findVerdict({ sha }, io);
  if (found === null) return unknown(realLog, "GitHub can't be reached");
  const { verdict, run } = found;
  if (!verdict) return unknown(realLog, `no verdict for ${sha.slice(0, 8)}`);
  if (verdict.kind !== "file" && verdict.kind !== "brake")
    return unknown(realLog, `blame reads a file or brake verdict; this one is ${verdict.kind}`);
  if (!io.git(["fetch", "--quiet", "origin", "dev"]).ok) return unknown(realLog, "could not fetch dev");
  const devSha = io.git(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/dev^{commit}"]).out;
  if (!devSha) return unknown(realLog, "no origin/dev");

  const failures = verdictFailures(verdict);
  const { run: plan, absent } = devRunPlan(
    failures,
    (file) => io.git(["cat-file", "-e", `${devSha}:${file}`]).ok,
  );
  /** @type {any} */ let dev = null;
  if (plan) {
    const onVerdict = (/** @type {any} */ v) => {
      dev = v;
    };
    if (plan.whole) await requestRun({ tier: plan.tier, branch: "dev", sha: devSha, waitMin, onVerdict }, io);
    else {
      const narrowed = narrowedCommit({ tier: plan.tier, sha: devSha, files: plan.files }, io);
      await requestRun(
        {
          tier: plan.tier,
          branch: `dev-narrowed-${narrowed.slice(0, 8)}`,
          sha: narrowed,
          waitMin,
          onVerdict,
        },
        io,
      );
    }
    if (!devResultUsable(dev, devSha, plan)) dev = null;
  }

  const split = splitFailures(failures, dev, absent);
  const from = { branch, ...(run?.url ? { url: run.url } : {}) };
  const ids = fileDevFailures(io, split, from);
  const merges = split.branch.length ? branchMerges(io, devSha, sha) : [];
  const slices = (/** @type {import("./blame.mjs").Placed} */ f) =>
    f.file ? slicesNear(merges, f.file) : [];
  const code = blameExit(split, failures.partial);

  if (json)
    realLog.log(
      JSON.stringify({
        branch,
        commit: sha,
        dev: devSha,
        partial: failures.partial,
        devFailures: split.dev.map((f) => ({ ...f, item: ids.get(f.key) ?? null })),
        branchFailures: split.branch.map((f) => ({ ...f, slices: slices(f) })),
        unknown: split.unknown,
      }),
    );
  else {
    io.log(`blame: ${branch} at ${sha.slice(0, 8)} against dev ${devSha.slice(0, 8)}`);
    for (const f of split.dev)
      io.log(
        `  dev's${f.brake ? " (brake)" : ""}: ${failureLabel(f)}${ids.get(f.key) ? ` (${ids.get(f.key)})` : ""}`,
      );
    for (const f of split.branch) {
      const near = slices(f);
      io.log(
        `  the branch's: ${failureLabel(f)}${f.absent ? " (not on dev)" : ""}${
          near.length ? ` (slices ${near.join(", ")})` : ""
        }`,
      );
    }
    for (const f of split.unknown) io.log(`  unknown: ${failureLabel(f)}`);
    if (failures.partial) io.log("  the verdict's list is partial: see the run");
  }
  return code;
}

/**
 * `ci file`: file the latest verdict's flakes. Slice 6 passes --base (dev before
 * its merge), since after the merge the branch's diff is empty.
 * @param {{ branch: string, sha: string, base?: string | null }} request
 * @param {Io} io
 */
export function fileFlakes({ branch, sha, base = null }, io) {
  const found = findVerdict({ sha }, io);
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
  for (const t of sorted.branch) io.log(`  the branch's flake: ${failureLabel(t)}`);
  if (sorted.findings.length) {
    const push = sorted.findings.some((f) => f.quarantine);
    const out = io.fileFindings?.(sorted.findings, push) ?? null;
    if (!out) return unknown(io, "could not file the flakes");
    for (const f of out.filed) io.log(`  ${f.created ? "filed" : "noted on"} ${f.id}`);
    for (const line of out.removed) io.log(`  left the quarantine: ${line.replaceAll("\t", " ")}`);
    if (push && out.pushed === false) return unknown(io, "the quarantine commit is on dev but wasn't pushed");
  }
  return sorted.branch.length ? EXIT.file : EXIT.green;
}

/**
 * `ci status`: one line per branch with a whole-tier verdict. One `gh run list`,
 * cached; verdicts cached by run and attempt. Prints nothing when GitHub is away.
 * @param {string[]} branches
 * @param {Io} io
 */
export function ciStatus(branches, io) {
  const cache = io.cache?.();
  const start = io.now();
  /** @type {Run[] | null} */ let runs = null;
  try {
    const held = JSON.parse(cache?.read("runs.json") ?? "null");
    if (held && start - held.at < STATUS_TTL_MS) runs = held.runs;
  } catch {
    runs = null;
  }
  if (!runs) {
    const r = io.gh(["run", "list", "--limit", "100", "--json", RUN_FIELDS], STATUS_TIMEOUT_MS);
    if (!r.ok) return EXIT.green;
    try {
      runs = /** @type {Run[]} */ (JSON.parse(r.out || "[]")).filter((x) => x.workflowName === WORKFLOW_NAME);
    } catch {
      return EXIT.green;
    }
    cache?.write("runs.json", JSON.stringify({ at: start, runs }));
  }
  /** @type {string[]} */ const lines = [];
  for (const branch of new Set(branches)) {
    const name = branch.replaceAll("/", "-");
    const ours = /** @type {Run[]} */ (runs)
      .filter((x) => parseCiRef(x.headBranch ?? "")?.name === name)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const done = ours.find((x) => x.status === "completed" && x.conclusion !== "cancelled");
    const going = ours.some((x) => x.status !== "completed") ? " (a run is going)" : "";
    if (!done) {
      if (going) lines.push(`  ${branch}: running`);
      continue;
    }
    const slot = `v-${done.databaseId}-${done.attempt ?? 1}.json`;
    /** @type {any} */ let v = null;
    try {
      v = JSON.parse(cache?.read(slot) ?? "null");
    } catch {
      v = null;
    }
    const left = STATUS_TIMEOUT_MS - (io.now() - start);
    if (!v && left > 0) {
      const read = readVerdict(io, done.databaseId, left);
      if (read && !read.narrowed) {
        v = { kind: read.kind, tier: read.tier, commit: read.commit };
        cache?.write(slot, JSON.stringify(v));
      }
    }
    if (!v) lines.push(`  ${branch}: unknown (no verdict read)${going}`);
    else {
      const tip = io.git(["rev-parse", "--verify", "--quiet", `${branch}^{commit}`]).out;
      const stale = tip && tip !== v.commit ? ", not the tip" : "";
      lines.push(`  ${branch}: ${v.kind} · ${v.tier} · ${String(v.commit).slice(0, 8)}${stale}${going}`);
    }
  }
  if (lines.length) for (const line of ["CI (latest whole-tier verdicts)", ...lines]) io.log(line);
  return EXIT.green;
}

/**
 * The throwaway commit of a narrowed run: the target plus the file list at the
 * root. Plumbing only, so the worktree, the index and the branch stay as they are.
 * @param {{ tier: string, sha: string, files: string[] }} request
 * @param {Io} io
 */
export function narrowedCommit({ tier, sha, files }, io) {
  for (const file of files) {
    if (!/\.test\.(ts|tsx|mjs)$/.test(file)) throw new Error(`--files takes test files: ${file}`);
    if (TIERS.indexOf(fileTier(file)) > TIERS.indexOf(/** @type {(typeof TIERS)[number]} */ (tier)))
      throw new Error(`${file} needs the ${fileTier(file)} tier`);
    if (!io.git(["cat-file", "-e", `${sha}:${file}`]).ok)
      throw new Error(`${file} is not in ${sha.slice(0, 8)}`);
  }
  const step = (/** @type {string[]} */ args, /** @type {string=} */ input) => {
    const r = io.git(args, input);
    if (!r.ok || !r.out) throw new Error(`git ${args[0]} failed for the narrowed commit`);
    return r.out;
  };
  const blob = step(["hash-object", "-w", "--stdin"], `${JSON.stringify({ target: sha, files }, null, 2)}\n`);
  const entries = step(["ls-tree", sha])
    .split("\n")
    .filter((line) => !line.endsWith(`\t${NARROWED_FILE}`));
  const tree = step(["mktree"], `${[...entries, `100644 blob ${blob}\t${NARROWED_FILE}`].join("\n")}\n`);
  return step(["commit-tree", tree, "-p", sha, "-m", `chore(ci): narrowed run of ${sha.slice(0, 8)}`]);
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
  /** @type {string[]} */ const files = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--ref") {
      ref = rest[++i] ?? null;
      if (!ref || ref.startsWith("-")) throw new Error("--ref needs a branch");
    } else if (rest[i] === "--wait") {
      waitMin = DEFAULT_WAIT_MIN;
      if (/^\d+$/.test(rest[i + 1] ?? "")) waitMin = Number(rest[++i]);
    } else if (rest[i] === "--files") {
      while (rest[i + 1] && !rest[i + 1]?.startsWith("-")) files.push(/** @type {string} */ (rest[++i]));
      if (!files.length) throw new Error("--files needs at least one test file");
    } else throw new Error(`ci run: unknown argument ${rest[i]}`);
  }
  return { tier, ref, waitMin, files };
}

/** The arguments of `blame` and `file`. */
function parseReadArgs(/** @type {string} */ command, /** @type {string[]} */ args) {
  /** @type {string | null} */ let ref = null;
  /** @type {string | null} */ let base = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = /** @type {string} */ (args[i]);
    if (a === "--json" && command === "blame") json = true;
    else if (a === "--base" && command === "file") {
      base = args[++i] ?? null;
      if (!base || base.startsWith("-")) throw new Error("--base needs a commit");
    } else if (!a.startsWith("-") && !ref) ref = a;
    else throw new Error(`ci ${command}: unknown argument ${a}`);
  }
  return { ref, json, base };
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
      const { tier, ref, waitMin, files } = parseRunArgs(argv.slice(1));
      const { branch, sha } = resolve(io, ref);
      if (!files.length) return await requestRun({ tier, branch, sha, waitMin }, io);
      const narrowed = narrowedCommit({ tier, sha, files }, io);
      return await requestRun(
        { tier, branch: `${branch}-narrowed-${narrowed.slice(0, 8)}`, sha: narrowed, waitMin },
        io,
      );
    }
    if (argv[0] === "status") return ciStatus(argv.slice(1), io);
    if (argv[0] === "blame" || argv[0] === "file") {
      const { ref, json, base } = parseReadArgs(argv[0], argv.slice(1));
      const { branch, sha } = resolve(io, ref);
      return argv[0] === "blame"
        ? await blame({ branch, sha, json }, io)
        : fileFlakes({ branch, sha, base }, io);
    }
    if (argv.length > 1 || argv[0]?.startsWith("-"))
      throw new Error(
        "usage: pnpm prd ci [<branch>] | ci run <tier> [--ref <branch>] [--files <file>…] [--wait [min]] | ci blame [<branch>] [--json] | ci file [<branch>] [--base <sha>] | ci status <branch>…",
      );
    return latestVerdict({ sha: resolve(io, argv[0] ?? null).sha }, io);
  } catch (e) {
    console.error(`ci: ${/** @type {Error} */ (e).message}`);
    return EXIT.usage;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exit(await main(process.argv.slice(2)));
