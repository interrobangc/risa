// The dispatcher's pick: what `pnpm prd dispatch` does this tick, and why it
// passed every other topic over. Pure: the facts in (the dispatcher gathers
// them), one action and its reasons out. No hold: a topic whose plan just
// landed is `planned` like any other and may start on the next tick.
//
// The rules, in order (plans/orchestration-3-prd.md, _The pick_):
//   1. Paused: nothing.
//   2. A prd/ or plan/ worktree whose session record is `managed` with no live
//      session, and not marked `rotating` in the last ROTATING_GRACE_MS:
//      `reopen`. After MAX_REOPENS reopens: an `ask` ("reopen again" or "hold
//      the topic"), and the topic is skipped while that ask is open. A row
//      flagged `hold` (the answer "hold the topic") is never reopened. A
//      worktree with no managed record was opened by hand: only reported, but
//      it still takes a slot and its hot files.
//   3. Busy: no start and no plan (reopens still happen).
//   4. A `planned` topic may `start` when a slot is free, every `After` topic
//      is `done`, no running topic shares a hot-file prefix with it, no
//      `alone` topic runs (and nothing runs when it is the `alone` one), and
//      it has no open question.
//   5. A fixes topic (`standing`) also needs no other fixes topic running, and
//      at least caps.fixesMin waiting items, or fewer when no other topic may
//      start this tick.
//   6. A `to-write` topic with waiting items may be `plan`ned when every
//      `After` topic is `done` and no planner runs, other than ones whose
//      topic has an open question (at most caps.planners + 1 planners).
//   7. Starts before plans; within each, row order. `hold`, `done` and `idle`
//      rows are never picked.
//
// Hot files collide when a prefix of one topic starts with a prefix of the
// other, as plain text (`scripts/loops/session` and
// `scripts/loops/session.sh`); a topic with no hot files collides with nothing.

import { isOpen } from "./asks.mjs";

/** A managed session that died is reopened this many times; the next death is an ask. */
export const MAX_REOPENS = 2;
/** A record marked `rotating` this recently is being rotated, not dead. */
export const ROTATING_GRACE_MS = 5 * 60_000;
/** The `session` of the asks the dispatcher files itself. */
export const DISPATCH_SESSION = "dispatch";
/** The answers a reopen ask offers. */
export const REOPEN_OPTIONS = ["reopen again", "hold the topic"];
/** The caps when the caller gives none: CARETOOK_MAX_PRDS, CARETOOK_MAX_PLANNERS, CARETOOK_FIXES_MIN. */
export const DEFAULT_CAPS = { prds: 3, planners: 1, fixesMin: 3 };

/**
 * @typedef {{ topic: string, flags?: string[], after?: string[], hot?: string[],
 *   state: string, waiting?: number }} PickRow
 *   a `pnpm backlog prd list --json` row: state worked out, waiting items counted
 * @typedef {{ name: string, branch: string }} PickWorktree
 *   a worktree in .loops: only prd/<topic> and plan/<topic> branches count
 * @typedef {{ name: string, live: boolean, managed?: boolean, rotating?: boolean,
 *   rotatingAt?: number | string | null }} PickSession
 *   a session record (prd-<topic>, plan-<topic>) with its liveness; rotatingAt
 *   is when it was marked rotating (ms or ISO; none counts as just now)
 * @typedef {{ id: string, kind: string, topic: string, session?: string | null,
 *   answeredAt?: string | null, doneAt?: string | null }} PickAsk
 * @typedef {{ rows: PickRow[], worktrees?: PickWorktree[], sessions?: PickSession[],
 *   asks?: PickAsk[], reopens?: Record<string, number>, busy?: boolean, paused?: boolean,
 *   caps?: Partial<typeof DEFAULT_CAPS>, now?: number }} PickFacts
 * @typedef {{ topic?: string, why: string }} Reason
 * @typedef {{ action: "start" | "plan" | "reopen" | "ask" | "none", topic?: string,
 *   session?: string, worktree?: string, why?: string, text?: string, options?: string[],
 *   reasons: Reason[] }} Pick
 */

const asTime = (/** @type {number | string | null | undefined} */ t) =>
  typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : NaN;

/** prd/<topic> or plan/<topic> → { kind, topic }; anything else → null. @param {string} branch */
export function worktreeKind(branch) {
  const m = /^(prd|plan)\/([^/]+)$/.exec(branch ?? "");
  return m ? { kind: /** @type {"prd" | "plan"} */ (m[1]), topic: m[2] } : null;
}

/**
 * The first pair of hot-file prefixes that collide (one starts with the other,
 * as plain text), the longer one first; null when none does.
 * @param {string[]} a @param {string[]} b @returns {string | null}
 */
export function hotCollision(a = [], b = []) {
  for (const x of a)
    for (const y of b) {
      if (!x || !y) continue;
      if (x.startsWith(y)) return x;
      if (y.startsWith(x)) return y;
    }
  return null;
}

/** @param {PickFacts} facts @returns {Pick} */
export function pick(facts) {
  const rows = facts.rows ?? [];
  const caps = { ...DEFAULT_CAPS, ...facts.caps };
  const now = facts.now ?? Date.now();
  const byTopic = new Map(rows.map((r) => [r.topic, r]));
  const order = new Map(rows.map((r, i) => [r.topic, i]));
  const sessions = new Map((facts.sessions ?? []).map((s) => [s.name, s]));
  const reopens = facts.reopens ?? {};
  const flags = (/** @type {PickRow | undefined} */ r) => r?.flags ?? [];

  const asks = (facts.asks ?? []).filter((a) => a.kind === "question" && isOpen(a));
  const questionOf = (/** @type {string} */ topic) => asks.find((a) => a.topic === topic);
  const reopenAskOf = (/** @type {string} */ topic) =>
    asks.find((a) => a.topic === topic && a.session === DISPATCH_SESSION);

  const worktrees = (facts.worktrees ?? [])
    .flatMap((w) => {
      const k = worktreeKind(w.branch);
      return k ? [{ ...w, ...k, session: `${k.kind}-${k.topic}` }] : [];
    })
    .sort((a, b) => (order.get(a.topic) ?? Infinity) - (order.get(b.topic) ?? Infinity));
  const prdWorktrees = worktrees.filter((w) => w.kind === "prd");
  const planWorktrees = worktrees.filter((w) => w.kind === "plan");
  const running = new Set([
    ...prdWorktrees.map((w) => w.topic),
    ...rows.filter((r) => r.state === "running").map((r) => r.topic),
  ]);
  const runningRows = [...running].map((t) => byTopic.get(t) ?? { topic: t, state: "running" });

  /** @type {Reason[]} */
  const reasons = [];
  /** @type {Pick | null} */
  let reopen = null;

  // ---- rule 2: the sessions in the worktrees ----
  /** @type {Map<string, string>} why each worktree's topic is passed over */
  const worktreeWhy = new Map();
  for (const w of worktrees) {
    const s = sessions.get(w.session);
    const what = w.kind === "plan" ? "its planner" : "its orchestrator";
    const row = byTopic.get(w.topic);
    const finished = w.kind === "plan" ? row && row.state !== "to-write" : row?.state === "done";
    const rotatedAt = asTime(s?.rotatingAt);
    let why;
    // A landed planner's worktree is tidy's; the topic speaks for itself.
    if (finished && w.kind === "plan") continue;
    if (finished) why = "done; its worktree is left over";
    // The user's brake (or the answer "hold the topic"): a dead session stays down.
    else if (flags(row).includes("hold") && !s?.live) why = `on hold; ${what} isn't live (not reopened)`;
    else if (!s?.managed)
      why = s?.live ? `running, opened by hand` : `opened by hand, ${what} isn't live (left alone)`;
    else if (s.live) why = w.kind === "plan" ? "being planned" : "running";
    else if (s.rotating && (Number.isNaN(rotatedAt) || now - rotatedAt < ROTATING_GRACE_MS))
      why = `${what} is being rotated`;
    else if ((reopens[w.session] ?? 0) >= MAX_REOPENS) {
      const open = reopenAskOf(w.topic);
      if (open) why = `${what} died after ${MAX_REOPENS} reopens; waits on ask ${open.id}`;
      else {
        why = `${what} died after ${MAX_REOPENS} reopens`;
        reopen ??= {
          action: "ask",
          topic: w.topic,
          session: w.session,
          worktree: w.name,
          why: `${w.session} died again after ${MAX_REOPENS} reopens`,
          text: `${w.session} (${w.name}) died again after ${MAX_REOPENS} reopens. Reopen it once more, or hold ${w.topic}?`,
          options: REOPEN_OPTIONS,
          reasons: [],
        };
      }
    } else {
      why = `${what} died`;
      reopen ??= {
        action: "reopen",
        topic: w.topic,
        session: w.session,
        worktree: w.name,
        why: `${w.session} died (reopen ${(reopens[w.session] ?? 0) + 1} of ${MAX_REOPENS})`,
        reasons: [],
      };
    }
    worktreeWhy.set(w.topic, worktreeWhy.has(w.topic) ? `${worktreeWhy.get(w.topic)}; ${why}` : why);
  }

  if (facts.paused)
    return {
      action: "none",
      why: "the dispatcher is paused",
      reasons: [{ why: "the dispatcher is paused" }],
    };

  // ---- rules 4 and 5: who may start ----
  const aloneRunning = runningRows.find((r) => flags(r).includes("alone"));
  const fixesRunning = runningRows.find((r) => flags(r).includes("standing"));
  const slotFree = running.size < caps.prds;
  const unmet = (/** @type {PickRow} */ r) => (r.after ?? []).filter((t) => byTopic.get(t)?.state !== "done");

  /** Why `r` may not start, or null when it may. @param {PickRow} r */
  const startBlock = (r) => {
    const q = questionOf(r.topic);
    if (q) return `has an open question (${q.id})`;
    const waits = unmet(r);
    if (waits.length) return `waits for ${waits.join(", ")}`;
    if (!slotFree) return `no free slot (${running.size} of ${caps.prds} running)`;
    if (aloneRunning) return `${aloneRunning.topic} runs alone`;
    if (flags(r).includes("alone") && runningRows.length)
      return `runs alone, and ${runningRows.map((x) => x.topic).join(", ")} ${runningRows.length > 1 ? "are" : "is"} running`;
    for (const o of runningRows) {
      const hot = hotCollision(r.hot, o.hot);
      if (hot) return `shares ${hot} with ${o.topic}`;
    }
    if (flags(r).includes("standing") && fixesRunning)
      return `another fixes topic (${fixesRunning.topic}) is running`;
    return null;
  };

  const planned = rows.filter((r) => r.state === "planned" && !running.has(r.topic));
  const mayStart = planned.filter((r) => !startBlock(r));
  const short = (/** @type {PickRow} */ r) =>
    flags(r).includes("standing") && (r.waiting ?? 0) < caps.fixesMin;
  const strong = mayStart.filter((r) => !short(r));
  const startPick = strong[0] ?? mayStart[0] ?? null;

  // ---- rule 6: who may be planned ----
  const planners = planWorktrees.filter((w) => {
    const state = byTopic.get(w.topic)?.state;
    return !running.has(w.topic) && (state === undefined || state === "to-write");
  });
  const activePlanners = planners.filter((w) => !questionOf(w.topic));
  const plannerFree = activePlanners.length < caps.planners && planners.length < caps.planners + 1;
  /** Why `r` may not be planned, or null when it may. @param {PickRow} r */
  const planBlock = (r) => {
    if (!(r.waiting ?? 0)) return "nothing waiting to plan";
    if (planWorktrees.some((w) => w.topic === r.topic)) return "being planned";
    const q = questionOf(r.topic);
    if (q) return `has an open question (${q.id})`;
    const waits = unmet(r);
    if (waits.length) return `waits for ${waits.join(", ")}`;
    if (!plannerFree)
      return `a planner is running (${activePlanners.map((w) => w.session).join(", ") || planners.map((w) => w.session).join(", ")})`;
    return null;
  };
  const toWrite = rows.filter((r) => r.state === "to-write");
  const planPick = toWrite.find((r) => !planBlock(r)) ?? null;

  const chosen = reopen
    ? null
    : facts.busy
      ? null
      : startPick
        ? { action: /** @type {const} */ ("start"), row: startPick }
        : planPick
          ? { action: /** @type {const} */ ("plan"), row: planPick }
          : null;

  // ---- the reasons, in row order ----
  for (const r of rows) {
    if (chosen?.row === r) continue;
    const wt = worktreeWhy.get(r.topic);
    if (reopen?.topic === r.topic) continue;
    let why;
    if (wt) why = wt;
    else if (running.has(r.topic)) why = "running";
    else if (r.state === "done") continue;
    else if (r.state === "hold") why = "on hold";
    else if (r.state === "idle") why = "no waiting items";
    else if (r.state === "planned") {
      why = startBlock(r);
      if (!why && short(r))
        why = `${r.waiting ?? 0} waiting, under ${caps.fixesMin}, and ${startPick?.topic ?? "another topic"} may start`;
      if (!why && facts.busy) why = "the machine is busy";
      if (!why && reopen) why = `waits a tick: ${reopen.why}`;
      if (!why) why = `waits a tick: ${startPick?.topic} starts first`;
    } else if (r.state === "to-write") {
      why = planBlock(r);
      if (!why && facts.busy) why = "the machine is busy";
      if (!why && reopen) why = `waits a tick: ${reopen.why}`;
      if (!why)
        why = `waits a tick: ${chosen?.row.topic} ${chosen?.action === "start" ? "starts" : "is planned"} first`;
    } else why = `state ${r.state}`;
    reasons.push({ topic: r.topic, why });
  }
  for (const w of worktrees)
    if (!byTopic.has(w.topic) && reopen?.topic !== w.topic)
      reasons.push({ topic: w.topic, why: `${worktreeWhy.get(w.topic)} (no registry row)` });

  if (reopen) return { ...reopen, reasons };
  if (chosen) {
    const r = chosen.row;
    const why =
      chosen.action === "plan"
        ? `${r.waiting} waiting, no plan yet`
        : flags(r).includes("standing")
          ? `${r.waiting ?? 0} waiting fixes`
          : "planned, and nothing stops it";
    return { action: chosen.action, topic: r.topic, why, reasons };
  }
  return { action: "none", why: facts.busy ? "the machine is busy" : "nothing to do", reasons };
}

/** The pick as lines a person reads: the action, then each topic passed over. @param {Pick} p */
export function formatPick(p) {
  const head =
    p.action === "none"
      ? `nothing: ${p.why}`
      : `${p.action} ${p.action === "reopen" || p.action === "ask" ? p.session : p.topic}: ${p.why}`;
  return [head, ...p.reasons.filter((r) => r.topic).map((r) => `  ${r.topic}: ${r.why}`)];
}
