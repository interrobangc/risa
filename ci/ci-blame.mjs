// ci-blame.mjs: part of `prd ci` (ci.mjs has the map). `ci blame`: a file or
// brake verdict split against a run on dev's tip, dev's failures filed and their
// brake notices posted or withdrawn (the pure rules are blame.mjs). The gate
// shares splitAgainstDev.
import {
  blameExit,
  brakeNotice,
  devFindings,
  devResultUsable,
  devRunPlan,
  messageLine,
  noticeKey,
  slicesNear,
  splitFailures,
  verdictFailures,
} from "./blame.mjs";
import { narrowedCommit } from "./ci-commits.mjs";
import { DEFAULT_WAIT_MIN } from "./ci-io.mjs";
import { findVerdict, requestRun, unknown } from "./ci-runs.mjs";

/**
 * @typedef {import("./ci-io.mjs").Io} Io
 * @typedef {import("./ci-io.mjs").Run} Run
 */

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

export const failureLabel = (/** @type {import("./blame.mjs").Failure} */ f) =>
  f.file ? `${f.file}${f.name ? `: ${f.name}` : ""}` : `${f.job} job`;

/** A failure's line, then its message indented beneath when the verdict kept one. */
export function logFailure(
  /** @type {Io} */ io,
  /** @type {string} */ line,
  /** @type {import("./blame.mjs").Failure} */ f,
) {
  io.log(line);
  const message = messageLine(f);
  if (message) io.log(`      ${message}`);
}

/** File dev's failures, post one notice per dev brake, and withdraw the ones a pass cleared. */
function fileDevFailures(
  /** @type {Io} */ io,
  /** @type {import("./blame.mjs").Split} */ split,
  /** @type {{ branch: string, url?: string }} */ from,
) {
  /** @type {Map<string, string>} */ const ids = new Map();
  if (split.dev.length) {
    let findings = null;
    try {
      findings = devFindings(split.dev, from);
    } catch (e) {
      io.log(`warning: dev's failures are not filed: ${e instanceof Error ? e.message : e}`);
    }
    const out = findings && (io.fileFindings?.(findings, false) ?? null);
    if (findings && !out) io.log("warning: could not file dev's failures in the backlog");
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
export async function splitAgainstDev({ branch, verdict, run, waitMin }, io) {
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
      logFailure(
        io,
        `  dev's${f.brake ? " (brake)" : ""}: ${failureLabel(f)}${ids.get(f.key) ? ` (${ids.get(f.key)})` : ""}`,
        f,
      );
    for (const f of split.branch) {
      const near = slices(f);
      logFailure(
        io,
        `  the branch's: ${failureLabel(f)}${f.absent ? " (not on dev)" : ""}${
          near.length ? ` (slices ${near.join(", ")})` : ""
        }`,
        f,
      );
    }
    for (const f of split.unknown) logFailure(io, `  unknown: ${failureLabel(f)}`, f);
    if (failures.partial) io.log("  the verdict's list is partial: see the run");
  }
  return code;
}
