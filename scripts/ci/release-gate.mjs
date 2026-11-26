// The main gate: the `release-gate` commit status on the head of the open staging to
// main PR. GitHub's required check reads it; the Mac is what writes it.
//
//   release [--wait <min>] [--rerun]     runs the release tier on the PR's head (or reads
//                                        its finished verdict) and writes the status
//   override <commit> --reason "…"       the user's recorded way through, from a terminal
//   release-test <commit>                proves the status write on a throwaway commit:
//                                        never a pass, and never on staging's or main's history
//
// A verdict only ever speaks for its own commit: one for another commit, a narrowed run
// or a proof run writes nothing. Second-zone failures are filed and never change the
// status. No command here edits a ruleset, or opens or merges a PR. Exit 6 is a refusal.
import { REFUSED, Refusal, isAncestor, refuse, short } from "./candidate.mjs";
import { releasePasses } from "./gate.mjs";

export const GATE_CONTEXT = "release-gate";
const TIER = "release";
const DEFAULT_WAIT_MIN = 60;
const UNKNOWN = 5;
/** GitHub refuses a longer status description. */
const MAX_DESCRIPTION = 140;
/** The notice board refuses a longer line. */
const MAX_NOTICE = 200;
const STAGING = "refs/remotes/origin/staging";
const OPEN_PR = "gh pr create --base main --head staging --title 'chore(release): staging to main'";
const MAIN = "refs/remotes/origin/main";
const USAGE =
  'usage: pnpm prd ci release [--wait <min>] [--rerun] | ci override <commit> --reason "…" | ci release-test <commit>';
/** The proof's status: `error`, so a test commit that later reached a PR could never pass on it. */
export const TEST_STATUS = { state: "error", description: "test of the status write, not a verdict" };

/**
 * @typedef {import("./ci.mjs").Io} Io
 * @typedef {{ number: number, url: string, headRefName: string, headRefOid?: string, isCrossRepository?: boolean }} Pr
 * @typedef {{ findTipVerdict: (r: { sha: string, tier: string }, io: Io) => { verdict: any, run: any, going: any } | null, requestRun: (r: any, io: Io) => Promise<number>, fileZoneVerdict: (verdict: any, run: any, io: Io) => number, verdictLines: (v: any) => string[], exitFor: (kind: string) => number }} Deps
 */

const clip = (/** @type {string} */ text, /** @type {number} */ max) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Whether a verdict speaks for exactly this commit. */
const speaksFor = (/** @type {any} */ v, /** @type {string} */ sha) =>
  !!v && v.commit === sha && !v.narrowed && !v.forcedFlake;

/**
 * The status a verdict of this commit writes. A failure is what the tests found;
 * an error is a run that proved nothing either way.
 * @param {any} v
 * @param {string} sha
 */
export function gateStatus(v, sha) {
  const decision = releasePasses(v, TIER, sha);
  if (decision.pass)
    return {
      pass: true,
      state: "success",
      description: clip(`${decision.why} (release run ${v.runId})`, MAX_DESCRIPTION),
    };
  const failed = ["file", "brake", "flake", "time"].includes(v?.kind);
  return {
    pass: false,
    state: failed ? "failure" : "error",
    description: clip(`blocked: ${decision.why}`, MAX_DESCRIPTION),
  };
}

/** The one place `release-gate` is written. */
export const writeGateStatus = (
  /** @type {Io} */ io,
  /** @type {string} */ sha,
  /** @type {{ state: string, description: string }} */ { state, description },
  /** @type {string=} */ url,
) =>
  io.gh([
    "api",
    "-X",
    "POST",
    `repos/{owner}/{repo}/statuses/${sha}`,
    "-f",
    `state=${state}`,
    "-f",
    `context=${GATE_CONTEXT}`,
    "-f",
    `description=${description}`,
    ...(url ? ["-f", `target_url=${url}`] : []),
  ]).ok;

/** The one open PR from this repository's staging into main; null when there is none. */
function openReleasePr(/** @type {Io} */ io) {
  const r = io.gh([
    "pr",
    "list",
    "--base",
    "main",
    "--head",
    "staging",
    "--state",
    "open",
    "--limit",
    "10",
    "--json",
    "number,url,headRefName,headRefOid,isCrossRepository",
  ]);
  if (!r.ok) return refuse("could not read the open PRs into main");
  /** @type {Pr[]} */ let prs;
  try {
    prs = JSON.parse(r.out || "[]");
  } catch {
    return refuse("could not read the open PRs into main");
  }
  const ours = prs.filter((pr) => pr.headRefName === "staging" && pr.isCrossRepository !== true);
  if (ours.length > 1) refuse(`more than one open staging PR: ${ours.map((p) => `#${p.number}`).join(", ")}`);
  return ours[0] ?? null;
}

/** The open PR and its head, which must be staging's tip on origin. */
function releaseHead(/** @type {Io} */ io) {
  const pr = openReleasePr(io);
  if (!pr) return refuse(`no open staging to main PR. The user opens it: ${OPEN_PR}`);
  if (!io.git(["fetch", "--quiet", "origin", `+refs/heads/staging:${STAGING}`]).ok)
    refuse("could not fetch staging from origin");
  const tip = io.git(["rev-parse", "--verify", "--quiet", `${STAGING}^{commit}`]);
  if (!tip.ok || !tip.out) refuse("no staging branch on origin");
  if (pr.headRefOid !== tip.out)
    refuse(
      `#${pr.number} is at ${short(pr.headRefOid ?? "unknown")} on the PR, staging at ${short(tip.out)}`,
    );
  return { pr, sha: tip.out };
}

async function release(
  /** @type {{ waitMin: number, rerun: boolean }} */ { waitMin, rerun },
  /** @type {Io} */ io,
  /** @type {Deps} */ deps,
) {
  const { pr, sha } = releaseHead(io);
  io.log(`release: #${pr.number} at ${short(sha)}`);

  /** @type {any} */ let verdict = null;
  /** @type {any} */ let run = null;
  if (!rerun) {
    const found = deps.findTipVerdict({ sha, tier: TIER }, io);
    if (!found) return refuse(`GitHub can't be reached, so ${short(sha)} has no verdict to read`);
    // infra and unknown proved nothing, so they get a new run.
    if (!found.going && speaksFor(found.verdict, sha) && !["infra", "unknown"].includes(found.verdict.kind)) {
      ({ verdict, run } = found);
      for (const line of deps.verdictLines(verdict)) io.log(line);
    }
  }
  if (!verdict) {
    const code = await deps.requestRun(
      {
        tier: TIER,
        branch: "staging",
        sha,
        waitMin,
        onVerdict: (/** @type {any} */ v, /** @type {any} */ r) => {
          verdict = v;
          run = r;
        },
      },
      io,
    );
    if (!speaksFor(verdict, sha)) {
      io.log(`no verdict for ${short(sha)}: ${GATE_CONTEXT} is unchanged. Retry: pnpm prd ci release`);
      return code || UNKNOWN;
    }
  }

  const status = gateStatus(verdict, sha);
  if (!writeGateStatus(io, sha, status, run?.url)) {
    io.log(`could not write ${GATE_CONTEXT} on ${short(sha)}. Retry: pnpm prd ci release`);
    return UNKNOWN;
  }
  io.log(`${GATE_CONTEXT}: ${status.state} on ${short(sha)} (${status.description})`);

  if (deps.fileZoneVerdict(verdict, run, io) !== 0)
    io.log(
      `warning: the second-zone failures aren't all filed. Retry: pnpm prd ci zone-file origin/staging --run ${verdict.runId}`,
    );

  const now = openReleasePr(io);
  if (now?.headRefOid !== sha) {
    io.log(`#${pr.number} moved on from ${short(sha)}: a newer commit needs a new run`);
    return REFUSED;
  }
  return status.pass ? 0 : deps.exitFor(verdict.kind) || UNKNOWN;
}

async function override(
  /** @type {{ commit: string, reason: string }} */ { commit, reason },
  /** @type {Io} */ io,
) {
  // Before anything is read or written: these are the accident guards.
  if (io.session?.()) refuse("an agent session can't override the main gate");
  if (!io.terminal?.() || !io.ask) refuse("the override needs a real terminal");

  const { pr, sha } = releaseHead(io);
  const named = io.git(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
  if (!named.ok || named.out !== sha) refuse(`${commit} is not the head of #${pr.number} (${short(sha)})`);

  const code = short(sha);
  io.log(`Override ${GATE_CONTEXT} on ${code} (${pr.url}).`);
  io.log("The reason is public: leave out health details and names.");
  io.log(`Reason: ${reason}`);
  const typed = await io.ask(`Type ${code} to override: `);
  if (typed.trim() !== code) refuse("the typed commit doesn't match: nothing was written");

  // The record goes first, so a status can't exist without it.
  const body = `**${GATE_CONTEXT} overridden** on \`${code}\`.\n\nReason: ${reason}`;
  if (!io.gh(["pr", "comment", String(pr.number), "--body", body]).ok)
    refuse(`could not comment on #${pr.number}: nothing was overridden`);
  const written = writeGateStatus(io, sha, {
    state: "success",
    description: clip(`OVERRIDE: ${reason}`, MAX_DESCRIPTION),
  });
  if (!written) {
    io.log(`could not write ${GATE_CONTEXT} on ${code}; #${pr.number} has the comment. Run it again.`);
    return UNKNOWN;
  }
  io.log(`${GATE_CONTEXT}: success on ${code} (OVERRIDE)`);
  try {
    io.board?.().post(clip(`${GATE_CONTEXT} OVERRIDE on ${code} (#${pr.number}): ${reason}`, MAX_NOTICE));
  } catch (e) {
    io.log(`warning: the notice board: ${/** @type {Error} */ (e).message}`);
  }
  return 0;
}

/** Write the proof status on a commit that neither staging nor main holds. */
function releaseTest(/** @type {string} */ commit, /** @type {Io} */ io) {
  const fetched = io.git([
    "fetch",
    "--quiet",
    "origin",
    `+refs/heads/staging:${STAGING}`,
    `+refs/heads/main:${MAIN}`,
  ]);
  if (!fetched.ok) refuse("could not fetch staging and main, so the commit can't be cleared");
  const named = io.git(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
  if (!named.ok || !named.out) return refuse(`no such commit: ${commit}`);
  const sha = named.out;
  // A failed merge-base also reads as "not an ancestor": both refs must exist first.
  for (const [name, ref] of [
    ["staging", STAGING],
    ["main", MAIN],
  ]) {
    const at = io.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (!at.ok || !at.out) refuse(`no ${name} on origin, so the commit can't be cleared`);
    if (isAncestor(io, sha, /** @type {string} */ (ref)))
      refuse(`${short(sha)} is reachable from ${name}: release-test takes a throwaway commit`);
  }
  if (!writeGateStatus(io, sha, TEST_STATUS)) {
    io.log(`could not write ${GATE_CONTEXT} on ${short(sha)}`);
    return UNKNOWN;
  }
  io.log(`${GATE_CONTEXT}: ${TEST_STATUS.state} on ${short(sha)} (${TEST_STATUS.description})`);
  return 0;
}

/** The arguments after `release`. */
export function parseReleaseArgs(/** @type {string[]} */ args) {
  let waitMin = DEFAULT_WAIT_MIN;
  let rerun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rerun") rerun = true;
    else if (args[i] === "--wait" && /^[1-9]\d*$/.test(args[i + 1] ?? "")) waitMin = Number(args[++i]);
    else throw new Error(USAGE);
  }
  return { waitMin, rerun };
}

/** The arguments after `override`. */
export function parseOverrideArgs(/** @type {string[]} */ args) {
  /** @type {string | null} */ let commit = null;
  let reason = "";
  for (let i = 0; i < args.length; i++) {
    const a = /** @type {string} */ (args[i]);
    if (a === "--reason") reason = (args[++i] ?? "").replace(/\s+/g, " ").trim();
    else if (!a.startsWith("-") && !commit) commit = a;
    else throw new Error(USAGE);
  }
  if (!commit || !reason) throw new Error(USAGE);
  return { commit, reason };
}

const refusing = async (/** @type {Io} */ io, /** @type {() => Promise<number>} */ action) => {
  try {
    return await action();
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    io.log(`refused: ${e.message}`);
    return REFUSED;
  }
};

export const runRelease = (/** @type {string[]} */ argv, /** @type {Io} */ io, /** @type {Deps} */ deps) => {
  const request = parseReleaseArgs(argv);
  return refusing(io, () => release(request, io, deps));
};

export const runOverride = (/** @type {string[]} */ argv, /** @type {Io} */ io) => {
  const request = parseOverrideArgs(argv);
  return refusing(io, () => override(request, io));
};

export const runReleaseTest = (/** @type {string[]} */ argv, /** @type {Io} */ io) => {
  const [commit, ...rest] = argv;
  if (!commit || commit.startsWith("-") || rest.length) throw new Error(USAGE);
  return refusing(io, async () => releaseTest(commit, io));
};
