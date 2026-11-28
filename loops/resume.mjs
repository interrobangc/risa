// The resume after a limit: once a stall's reset has passed, the dispatcher's tick brings back
// each managed orchestrator or planner marked stalled (usage.mjs: the drain's own `limited`
// marks, or a StopFailure's `rate_limit`), with `--continue` and the carry-on prompt
// (open-session.sh --carry-on), one per tick. A resume never counts toward the reopen limit.
//
// resumeDecision (pure), each tick:
//   - claims each managed prd-/plan- session whose mark's reset has passed (never while the
//     drain says limited): the dispatcher's state records the claim, then the mark is cleared,
//     so the pick sees it as resuming, never as a death to count;
//   - a mark on a session opened by hand is only reported (once: the mark is cleared after the
//     report is filed); one on another managed session (a kept backlog or inbox session) is
//     cleared, since the keep-alive brings those back;
//   - each claim then: dropped when its worktree, managed record or topic is gone, or the session
//     came back meanwhile (a record started after the stall); left alone while paused, draining,
//     on hold, being rotated, with a landing marker (a journal for its branch, or a landing
//     under it) or, while live, running a `prd` command; a live one is ended (TERM, KILL
//     END_WAIT_MS later), then resumed on a later tick; a dead one is resumed, the oldest claim
//     first, one per tick;
//   - a claim held by a landing journal whose pid is dead gets one report (naming the session,
//     the branch and `land --resume <branch>`) and records it (`journalReported`: the journal's
//     branch and start), so that journal is never reported again; a live journal only waits, and
//     a new journal for the branch (another start) reports again.
import { END_WAIT_MS, drainHolds } from "./drain.mjs";
import { ROTATING_GRACE_MS } from "./dispatch-pick.mjs";
import { stallHolds, timeOf } from "./usage.mjs";
import { branchKinds, toolCmd } from "./config.mjs";

/**
 * @typedef {{ session: string, branch: string, started: string | null, live: boolean }} ResumeJournal
 *   a landing journal: the session its branch belongs to, its start, whether its pid runs
 * @typedef {{ session: string, stalled: { at?: string | number | null, error?: string,
 *   resetsAt?: string | number | null, pid?: number | null } }} ResumeMark
 * @typedef {{ name: string, live: boolean, managed: boolean, pid?: number | null,
 *   started?: string | null, rotating?: boolean, rotatingAt?: number | string | null }} ResumeSession
 * @typedef {{ at: number, since: number | null, pid: number | null, error: string,
 *   termPid?: number | null, termAt?: number | null,
 *   journalReported?: { branch: string, started: string | null } }} Claim
 *   at: when it was claimed; since: when it stalled; pid: the stalled session's; termPid,
 *   termAt: the TERM this resume sent a live one; journalReported: the dead landing journal
 *   already reported for it
 * @typedef {{ type: "end" | "kill", session: string, pid: number }
 *   | { type: "open", session: string, worktree: string, why: string }} ResumeAct
 * @typedef {{ claim: { session: string, claim: Claim }[], clear: string[],
 *   report: { sessions: string[], text: string } | null, drop: { session: string, why: string }[],
 *   acts: ResumeAct[], waits: { session: string, why: string }[],
 *   reports: { session: string, text: string, journal: { branch: string, started: string | null } }[] }} ResumeDecision
 */

/** prd/<topic> or plan/<topic> → its session (prd-<topic>, plan-<topic>), else null. */
export const sessionOfBranch = (/** @type {string} */ branch) => {
  const kind = branchKinds().kindOf(branch);
  const topic = kind === "prd" || kind === "plan" ? branchKinds().nameOf(branch, kind) : null;
  return kind && topic && !topic.includes("/") ? `${kind}-${topic}` : null;
};

/**
 * This tick's resume. Pure.
 * @param {{ marks: ResumeMark[], sessions: ResumeSession[], worktrees: { name: string, branch: string }[],
 *   rows?: { topic: string, state?: string, flags?: string[] }[], claimed?: Record<string, Claim>,
 *   landing?: Set<string>, journals?: ResumeJournal[], commands?: Set<string> | null,
 *   drain: { state: "normal" | "draining" | "limited", why: string, allow?: string | null }, paused?: boolean, now: number,
 *   endWaitMs?: number }} facts
 *   landing: sessions with a landing marker or a landing under them; commands: live sessions
 *   running a `prd` command (null: the process table couldn't be read); journals: the landing
 *   journals, each with its session and whether its pid runs
 * @returns {ResumeDecision}
 */
export function resumeDecision({
  marks,
  sessions,
  worktrees,
  rows = [],
  claimed = {},
  landing = new Set(),
  journals = [],
  commands = new Set(),
  drain,
  paused = false,
  now,
  endWaitMs = END_WAIT_MS,
}) {
  /** @type {ResumeDecision} */
  const out = { claim: [], clear: [], report: null, drop: [], acts: [], waits: [], reports: [] };
  const records = new Map(sessions.map((s) => [s.name, s]));
  /** @type {Map<string, string>} session → its worktree */
  const trees = new Map();
  for (const w of worktrees) {
    const s = sessionOfBranch(w.branch);
    if (s) trees.set(s, w.name);
  }
  const rowOf = (/** @type {string} */ session) =>
    rows.find((r) => r.topic === session.replace(/^(prd|plan)-/, ""));
  /** @type {Record<string, Claim>} */
  const claims = { ...claimed };

  // ---- the marks whose reset has passed ----
  /** @type {string[]} */
  const hand = [];
  if (drain.state !== "limited")
    for (const m of [...marks].sort((a, b) => a.session.localeCompare(b.session))) {
      if (!m.stalled || stallHolds(m.stalled, now)) continue;
      const rec = records.get(m.session);
      if (claims[m.session]) out.clear.push(m.session);
      else if (trees.has(m.session) && rec?.managed) {
        const pid = Number(m.stalled.pid);
        const claim = {
          at: now,
          since: timeOf(m.stalled.at),
          pid: Number.isInteger(pid) && pid > 0 ? pid : null,
          error: String(m.stalled.error ?? "rate_limit"),
        };
        claims[m.session] = claim;
        out.claim.push({ session: m.session, claim });
      } else if (rec && !rec.managed) hand.push(m.session);
      else out.clear.push(m.session);
    }
  if (hand.length)
    out.report = {
      sessions: hand,
      text: `${hand.join(", ")} stopped on a usage limit that has now reset. The dispatcher resumes only the sessions it started, never one opened by hand: carry on in ${hand.length === 1 ? "it" : "them"} (${toolCmd.prd} open <name> if ${hand.length === 1 ? "it has" : "they have"} ended).`,
    };

  // ---- each claim ----
  /** @type {{ session: string, worktree: string, at: number }[]} */
  const ready = [];
  for (const [session, c] of Object.entries(claims)) {
    const rec = records.get(session);
    const worktree = trees.get(session);
    const row = rowOf(session);
    const started = timeOf(rec?.started ?? null);
    if (!worktree) out.drop.push({ session, why: "its worktree is gone" });
    else if (!rec?.managed) out.drop.push({ session, why: "it has no managed record" });
    else if (row?.state === "done") out.drop.push({ session, why: "its topic is done" });
    else if (started !== null && c.since !== null && started > c.since && !(rec.pid && rec.pid === c.pid))
      out.drop.push({ session, why: "it came back meanwhile (a session started after the stall)" });
    else if (paused) out.waits.push({ session, why: "the dispatcher is paused" });
    else if (drainHolds(drain, session.replace(/^(prd|plan)-/, "")))
      out.waits.push({ session, why: `usage is ${drain.state}` });
    else if (row?.flags?.includes("hold")) out.waits.push({ session, why: "its topic is on hold" });
    else if (landing.has(session) || journals.some((j) => j.session === session)) {
      out.waits.push({ session, why: "it has a landing marker: a landing first" });
      const mine = journals.filter((j) => j.session === session);
      const gone = mine.find(
        (j) =>
          !j.live && !(c.journalReported?.branch === j.branch && c.journalReported?.started === j.started),
      );
      if (gone && !mine.some((j) => j.live))
        out.reports.push({
          session,
          journal: { branch: gone.branch, started: gone.started },
          text: `${session} stopped on a usage limit that has reset, but its resume waits on a landing journal for ${gone.branch}${gone.started ? ` (started ${gone.started})` : ""} whose landing is no longer running. Run ${toolCmd.prd} land --resume ${gone.branch} from the main checkout to finish or undo that landing; the resume follows on a later tick.`,
        });
    } else if (rec.live) {
      const pid = Number(rec.pid);
      if (commands === null) out.waits.push({ session, why: "the process table can't be read" });
      else if (commands.has(session)) out.waits.push({ session, why: `it runs a ${toolCmd.prd} command` });
      else if (c.termPid === pid && c.termAt != null && now - c.termAt >= endWaitMs)
        out.acts.push({ type: "kill", session, pid });
      else if (c.termPid === pid) out.waits.push({ session, why: "sent TERM; waiting for it to end" });
      else out.acts.push({ type: "end", session, pid });
    } else {
      const rotatedAt = timeOf(rec.rotatingAt ?? null);
      if (rec.rotating && (rotatedAt === null || now - rotatedAt < ROTATING_GRACE_MS))
        out.waits.push({ session, why: "it is being rotated" });
      else ready.push({ session, worktree, at: c.at });
    }
  }
  ready.sort((a, b) => a.at - b.at || a.session.localeCompare(b.session));
  const [first, ...rest] = ready;
  if (first)
    out.acts.push({
      type: "open",
      session: first.session,
      worktree: first.worktree,
      why: `stopped on a usage limit that has reset: --continue with the carry-on prompt (not counted toward the reopen limit)`,
    });
  for (const r of rest)
    out.waits.push({ session: r.session, why: `one resume a tick: ${first?.session} first` });
  return out;
}

/** The sessions the pick must leave to the resume: claimed now or before. Pure. */
export function resumingOf(/** @type {Record<string, Claim>} */ claimed, /** @type {ResumeDecision} */ d) {
  const dropped = new Set(d.drop.map((x) => x.session));
  return new Set([...Object.keys(claimed), ...d.claim.map((x) => x.session)].filter((s) => !dropped.has(s)));
}
