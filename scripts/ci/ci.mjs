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
//       --force-flake <check> (candidate only) is the proof of the browser rerun: a
//       throwaway commit makes that check fail once, on its own ref. Expect exit 3
//       (flake); its verdict never counts as the branch's and writes no status.
//   pnpm prd ci [<branch>]
//       the latest whole-tier verdict for the branch's tip (exits by kind).
//   pnpm prd ci blame [<branch>] [--json]
//       splits a file or brake verdict against a run on dev's tip and files dev's
//       failures: exit 0 all dev's, 2 some the branch's, 5 unknown.
//   pnpm prd ci file [<branch>] [--base <sha>] [--run <id>] [--no-push]
//       files the verdict's flakes (--run: that run's); a file the branch touched
//       (against --base, else origin/dev) is the branch's and writes nothing: exit 0,
//       2 some the branch's, 5 unknown. --no-push leaves a quarantine commit on local dev.
//   pnpm prd ci gate <branch> --tier <t> --base <sha> [--fixes B-n,…] [--out <file>] [--peek]
//       the landing gate: finds a whole-tier verdict for <t> or higher on the tip (or
//       behind only docs and tooling commits), requests the run when there is none, and
//       decides (gate.mjs). Exit 0 lands; else the verdict kind's code. --out writes
//       key=value lines for land.sh; --peek reads only: no run, no blame, no filing.
//   pnpm prd ci status <branch>…
//       each branch's latest whole-tier verdict, cached, for pnpm prd status.
//   pnpm prd ci candidate cut [<commit>] | fix <commit> | status
//       a release candidate: an rc/ branch of a fixed dev commit, its PR into staging
//       and its candidate run (candidate.mjs). Exit 6 is a refusal.
//   pnpm prd ci promote
//       merges the open candidate into staging when the newest candidate verdict on
//       its exact tip passes (promote.mjs), then deletes its rc/ and ci/ refs. Exit 6
//       is a refusal; exit 5 means the merge couldn't be confirmed.
//   pnpm prd ci release [--wait <min>] [--rerun]
//       the main gate: the release tier on the head of the open staging to main PR
//       (its finished verdict if it has one), written as the release-gate status, and
//       its second-zone failures filed (release-gate.mjs). Exit 6 is a refusal.
//   pnpm prd ci override <commit> --reason "…"
//       the user's recorded way through the main gate: a real terminal, never an agent
//       session, and the typed short commit. Writes a PR comment, the status and a notice.
//   pnpm prd ci release-test <commit>
//       proves the release-gate write on a throwaway commit: always `error`, never a
//       pass, and refused for any commit reachable from staging or main.
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
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { keepsVerdict } from "../loops/check-plan.mjs";
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
import { runCandidate } from "./candidate.mjs";
import { decideGate, needsBlame, verdictMeets } from "./gate.mjs";
import { runPromote } from "./promote.mjs";
import { runOverride, runRelease, runReleaseTest } from "./release-gate.mjs";
import { zoneFindings } from "./release.mjs";
import {
  FORCED_FLAKE_FILE,
  NARROWED_FILE,
  TIERS,
  browserCheckFile,
  ciRefName,
  fileTier,
  isTier,
  parseCiRef,
} from "./tiers.mjs";
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
/** How many first-parent commits the gate looks back for a verdict that still holds. */
const GATE_WALK = 20;
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
 * @typedef {{ git: (args: string[], input?: string) => Result, gh: (args: string[], timeoutMs?: number) => Result, sleep: (ms: number) => Promise<void>, now: () => number, log: (line: string) => void, pollMs: number, fileFindings?: (findings: any[], push: boolean) => { filed: { key: string, id: string, created: boolean }[], removed: string[], pushed: boolean | null, missed?: string[] } | null, board?: () => Board, cache?: () => Cache, session?: () => string, terminal?: () => boolean, ask?: (question: string) => Promise<string> }} Io
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

/** One line from the terminal. */
async function askTerminal(/** @type {string} */ question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** @returns {Io} */
export const realIo = () => ({
  git: (args, input) => command("git", args, input),
  gh: (args, timeoutMs) => command("gh", args, undefined, timeoutMs),
  fileFindings,
  board: noticeBoard,
  cache: statusCache,
  session: () => process.env.CARETOOK_SESSION_NAME ?? "",
  terminal: () => !!process.stdin.isTTY && !!process.stdout.isTTY,
  ask: askTerminal,
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

const unknown = (/** @type {Io} */ io, /** @type {string} */ why) => {
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
 * The newest whole-tier verdict of a commit that `accept` takes, and its run; null
 * when GitHub can't be read.
 * @param {{ sha: string, accept?: (v: any) => boolean }} request
 * @param {Io} io
 * @returns {{ verdict: any, run: Run | null } | null}
 */
function findVerdict({ sha, accept = () => true }, io) {
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
  const needed = TIERS.indexOf(/** @type {any} */ (tier));
  const ours = runs
    .filter((r) => {
      const ref = parseCiRef(r.headBranch ?? "");
      return r.headSha === sha && !!ref && TIERS.indexOf(/** @type {any} */ (ref.tier)) >= needed;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const going = ours.find((r) => r.status !== "completed") ?? null;
  if (going) return { verdict: null, run: null, going };
  const run = ours.find((r) => r.conclusion !== "cancelled") ?? null;
  return { verdict: run ? readVerdict(io, run.databaseId) : null, run, going: null };
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
 * Split a found file or brake verdict against a run on dev's tip, and file dev's
 * failures. A string is why it couldn't.
 * @param {{ branch: string, verdict: any, run: Run | null, waitMin: number }} request
 * @param {Io} io
 */
async function splitAgainstDev({ branch, verdict, run, waitMin }, io) {
  if (!io.git(["fetch", "--quiet", "origin", "dev"]).ok) return "could not fetch dev";
  const devSha = io.git(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/dev^{commit}"]).out;
  if (!devSha) return "no origin/dev";

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
  return { devSha, failures, split, ids, code: blameExit(split, failures.partial) };
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
  const result = await splitAgainstDev({ branch, verdict, run, waitMin }, io);
  if (typeof result === "string") return unknown(realLog, result);
  const { devSha, failures, split, ids, code } = result;
  const merges = split.branch.length ? branchMerges(io, devSha, sha) : [];
  const slices = (/** @type {import("./blame.mjs").Placed} */ f) =>
    f.file ? slicesNear(merges, f.file) : [];

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

/**
 * `ci file`: file a verdict's flakes: the given run's, else the commit's latest. The
 * landing passes --run and --base (dev before its merge), since after the merge the
 * branch's diff is empty, and --no-push on a local landing.
 * @param {{ branch: string, sha: string, base?: string | null, runId?: string | null, noPush?: boolean }} request
 * @param {Io} io
 */
export function fileFlakes({ branch, sha, base = null, runId = null, noPush = false }, io) {
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
  for (const t of sorted.branch) io.log(`  the branch's flake: ${failureLabel(t)}`);
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

/** A cached JSON file, or null when it's missing or broken. */
function cachedJson(/** @type {Cache | undefined} */ cache, /** @type {string} */ name) {
  try {
    return JSON.parse(cache?.read(name) ?? "null");
  } catch {
    return null;
  }
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
  const held = cachedJson(cache, "runs.json");
  /** @type {Run[] | null} */ let runs = held && start - held.at < STATUS_TTL_MS ? held.runs : null;
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
    let v = cachedJson(cache, slot);
    const left = STATUS_TIMEOUT_MS - (io.now() - start);
    if (!v && left > 0) {
      const read = readVerdict(io, done.databaseId, left);
      if (read && !read.narrowed && !read.forcedFlake) {
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
  return throwawayCommit(
    io,
    sha,
    NARROWED_FILE,
    { target: sha, files },
    `chore(ci): narrowed run of ${sha.slice(0, 8)}`,
  );
}

/** A commit on top of `sha` that adds one JSON file, at the root or one directory down. Plumbing only. */
function throwawayCommit(
  /** @type {Io} */ io,
  /** @type {string} */ sha,
  /** @type {string} */ path,
  /** @type {unknown} */ content,
  /** @type {string} */ message,
) {
  const step = (/** @type {string[]} */ args, /** @type {string=} */ input) => {
    const r = io.git(args, input);
    if (!r.ok || !r.out) throw new Error(`git ${args[0]} failed for the throwaway commit`);
    return r.out;
  };
  const blob = step(["hash-object", "-w", "--stdin"], `${JSON.stringify(content, null, 2)}\n`);
  const withEntry = (
    /** @type {string} */ treeish,
    /** @type {string} */ name,
    /** @type {string} */ entry,
  ) => {
    const kept = step(["ls-tree", treeish])
      .split("\n")
      .filter((line) => !line.endsWith(`\t${name}`));
    return step(["mktree"], `${[...kept, `${entry}\t${name}`].join("\n")}\n`);
  };
  const [dir, name] = path.includes("/") ? path.split("/") : [null, path];
  const tree = dir
    ? withEntry(
        sha,
        dir,
        `040000 tree ${withEntry(`${sha}:${dir}`, /** @type {string} */ (name), `100644 blob ${blob}`)}`,
      )
    : withEntry(sha, path, `100644 blob ${blob}`);
  return step(["commit-tree", tree, "-p", sha, "-m", message]);
}

/**
 * The throwaway commit of a proof run: the target plus the marker that makes one
 * browser check fail once (browser-job.mjs).
 * @param {{ sha: string, check: string }} request
 * @param {Io} io
 */
export function forcedFlakeCommit({ sha, check }, io) {
  if (!/^[a-z0-9-]+$/.test(check) || !io.git(["cat-file", "-e", `${sha}:${browserCheckFile(check)}`]).ok)
    throw new Error(`--force-flake: no browser check ${check} in ${sha.slice(0, 8)}`);
  return throwawayCommit(
    io,
    sha,
    FORCED_FLAKE_FILE,
    { check },
    `chore(ci): proof run forcing ${check} to fail once on ${sha.slice(0, 8)}`,
  );
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
  /** @type {string | null} */ let forceFlake = null;
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
    } else if (rest[i] === "--force-flake") {
      forceFlake = rest[++i] ?? null;
      if (!forceFlake || forceFlake.startsWith("-")) throw new Error("--force-flake needs a browser check");
    } else throw new Error(`ci run: unknown argument ${rest[i]}`);
  }
  if (forceFlake && tier !== "candidate") throw new Error("--force-flake needs the candidate tier");
  if (forceFlake && files.length) throw new Error("--force-flake can't be narrowed with --files");
  return { tier, ref, waitMin, files, forceFlake };
}

/** The arguments of `blame` and `file`. */
function parseReadArgs(/** @type {string} */ command, /** @type {string[]} */ args) {
  /** @type {string | null} */ let ref = null;
  /** @type {string | null} */ let base = null;
  /** @type {string | null} */ let runId = null;
  let json = false;
  let noPush = false;
  for (let i = 0; i < args.length; i++) {
    const a = /** @type {string} */ (args[i]);
    if (a === "--json" && command === "blame") json = true;
    else if (a === "--no-push" && command === "file") noPush = true;
    else if (a === "--run" && command === "file") {
      runId = args[++i] ?? null;
      if (!runId || !/^\d+$/.test(runId)) throw new Error("--run needs a run id");
    } else if (a === "--base" && command === "file") {
      base = args[++i] ?? null;
      if (!base || base.startsWith("-")) throw new Error("--base needs a commit");
    } else if (!a.startsWith("-") && !ref) ref = a;
    else throw new Error(`ci ${command}: unknown argument ${a}`);
  }
  return { ref, json, base, runId, noPush };
}

function parseGateArgs(/** @type {string[]} */ args) {
  /** @type {string | null} */ let ref = null;
  let tier = "";
  let base = "";
  /** @type {string[]} */ let fixes = [];
  /** @type {string | null} */ let out = null;
  let peek = false;
  for (let i = 0; i < args.length; i++) {
    const a = /** @type {string} */ (args[i]);
    if (a === "--tier") tier = args[++i] ?? "";
    else if (a === "--base") base = args[++i] ?? "";
    else if (a === "--out") out = args[++i] ?? null;
    else if (a === "--peek") peek = true;
    else if (a === "--fixes") fixes = (args[++i] ?? "").split(",").filter(Boolean);
    else if (!a.startsWith("-") && !ref) ref = a;
    else throw new Error(`ci gate: unknown argument ${a}`);
  }
  if (!isTier(tier)) throw new Error(`ci gate: --tier needs one of ${TIERS.join(", ")}`);
  if (!base || base.startsWith("-")) throw new Error("ci gate: --base needs a commit");
  if (fixes.some((f) => !/^B-\d+$/.test(f))) throw new Error("ci gate: --fixes takes B-n,B-m");
  return { ref, tier, base, fixes, out, peek };
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
      const { tier, ref, waitMin, files, forceFlake } = parseRunArgs(argv.slice(1));
      const { branch, sha } = resolve(io, ref);
      if (forceFlake) {
        const forced = forcedFlakeCommit({ sha, check: forceFlake }, io);
        return await requestRun(
          { tier, branch: `${branch}-forced-${forced.slice(0, 8)}`, sha: forced, waitMin },
          io,
        );
      }
      if (!files.length) return await requestRun({ tier, branch, sha, waitMin }, io);
      const narrowed = narrowedCommit({ tier, sha, files }, io);
      return await requestRun(
        { tier, branch: `${branch}-narrowed-${narrowed.slice(0, 8)}`, sha: narrowed, waitMin },
        io,
      );
    }
    if (argv[0] === "candidate")
      return await runCandidate(argv.slice(1), io, {
        requestRun,
        findVerdict,
        deleteRef,
        verdictLines,
        exitFor,
      });
    if (argv[0] === "promote")
      return runPromote(argv.slice(1), io, { findTipVerdict, deleteRef, remoteSha, verdictLines });
    if (argv[0] === "release")
      return await runRelease(argv.slice(1), io, {
        findTipVerdict,
        requestRun,
        fileZoneVerdict,
        verdictLines,
        exitFor,
      });
    if (argv[0] === "override") return await runOverride(argv.slice(1), io);
    if (argv[0] === "release-test") return await runReleaseTest(argv.slice(1), io);
    if (argv[0] === "status") return ciStatus(argv.slice(1), io);
    if (argv[0] === "zone-file") {
      const { ref, runId } = parseReadArgs("file", argv.slice(1));
      return fileSecondZone({ sha: resolve(io, ref).sha, runId }, io);
    }
    if (argv[0] === "blame" || argv[0] === "file") {
      const { ref, json, base, runId, noPush } = parseReadArgs(argv[0], argv.slice(1));
      const { branch, sha } = resolve(io, ref);
      return argv[0] === "blame"
        ? await blame({ branch, sha, json }, io)
        : fileFlakes({ branch, sha, base, runId, noPush }, io);
    }
    if (argv[0] === "gate") {
      const { ref, ...request } = parseGateArgs(argv.slice(1));
      return await gate({ ...resolve(io, ref), ...request }, io);
    }
    if (argv.length > 1 || argv[0]?.startsWith("-"))
      throw new Error(
        'usage: pnpm prd ci [<branch>] | ci run <tier> [--ref <branch>] [--files <file>…] [--force-flake <check>] [--wait [min]] | ci blame [<branch>] [--json] | ci file [<branch>] [--base <sha>] [--run <id>] [--no-push] | ci gate <branch> --tier <t> --base <sha> [--fixes B-n,…] [--out <file>] [--peek] | ci status <branch>… | ci candidate cut [<commit>] [--wait [min]] | ci candidate fix <commit> [--wait [min]] | ci candidate status | ci promote | ci release [--wait <min>] [--rerun] | ci override <commit> --reason "…" | ci release-test <commit> | ci zone-file [<branch>] [--run <id>]',
      );
    return latestVerdict({ sha: resolve(io, argv[0] ?? null).sha }, io);
  } catch (e) {
    console.error(`ci: ${/** @type {Error} */ (e).message}`);
    return EXIT.usage;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exit(await main(process.argv.slice(2)));
