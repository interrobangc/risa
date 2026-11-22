// The dispatcher's context follow-up: what it does about a managed orchestrator
// or backlog session that stays over the context limit. Pure: the tick (dispatch.mjs) gathers the
// size records, session records, asks and running commands, and acts.
//
// For a live managed orchestrator or backlog session over the limit with no keep:
//   1. the wait (CARETOOK_CONTEXT_NUDGE_MIN, 15) after `firstOverAt`: a nudge,
//      left in the size record for the hook to deliver at the next tool call;
//   2. the same wait after its delivery: one defaulting question. A nudge never
//      delivered (the session is inside one long command) never gets this far;
//   3. on "rotate it now", the rotation at the first tick with no `pnpm prd` or
//      `pnpm backlog` command under the session (a backlog write commits in the
//      main checkout). `ask --wait` doesn't count: it can wait for days, and the
//      fresh session finds the answer in the asks queue. An orchestrator rotates
//      mid-wave; a backlog session into a fresh one, with its brief only when it
//      was written after the nudge's delivery.
//      A refusal is reported once and tried again only after the wait;
//   4. on "leave it", an unclear answer or a dismissal: nothing more until the
//      session ends, even if it dips under the limit and crosses it again.
//
// A session that drops under the limit (unless left alone) or ends clears its
// entry and dismisses its open question. The entry is `context` in the
// dispatcher's state; its asks carry the session CONTEXT_SESSION, so the reopen
// question's matching (session "dispatch") never sees them.
import { awaitsAnswer } from "./asks.mjs";
import { kilo } from "./context.mjs";

/** The `session` of the context questions: not DISPATCH_SESSION, so a reopen never reads one. */
export const CONTEXT_SESSION = "dispatch-context";
/** The answers a context question offers, the recommended one first. */
export const CONTEXT_OPTIONS = ["rotate it now", "leave it"];

/**
 * @typedef {{ pid: number, askId?: string, answer?: "rotate" | "leave", triedAt?: number,
 *   reported?: boolean }} ContextEntry
 * @typedef {{ name: string, pid: number, kind?: string, topic?: string, managed?: boolean,
 *   live: boolean, rotating?: boolean }} ContextSession
 * @typedef {{ type: "clear", session: string, askId: string | null }
 *   | { type: "nudge", session: string, pid: number }
 *   | { type: "ask", session: string, pid: number, topic: string, text: string }
 *   | { type: "answered", session: string, pid: number, answer: "rotate" | "leave", askId: string }
 *   | { type: "hold", session: string }
 *   | { type: "rotate", session: string, pid: number, topic: string }
 *   | { type: "rotate-backlog", session: string, pid: number, topic: string, brief: boolean }} ContextAction
 */

/** What a context question's answer means; anything unclear leaves the session alone. */
export function contextAnswer(/** @type {string | null | undefined} */ answer) {
  const a = String(answer ?? "")
    .trim()
    .toLowerCase();
  return a === CONTEXT_OPTIONS[0] || /^(1|rotate)\b/.test(a) ? "rotate" : "leave";
}

export const contextQuestion = (/** @type {string} */ session, /** @type {number} */ size) =>
  `${session} is at ${kilo(size)} context and hasn't rotated`;

const PRD_COMMAND =
  /(?:\bpnpm(?:\.c?js)?\s+(?:run\s+)?(?:prd|backlog)|scripts\/loops\/prd\.sh|scripts\/backlog\/backlog\.mjs)\b((?:\s+[^\s;&|]+){0,2})/g;

/** Whether a command line runs a `pnpm prd` or `pnpm backlog` command that a rotation must not cut. */
export function runsPrdCommand(/** @type {string} */ args) {
  return [...(args ?? "").matchAll(PRD_COMMAND)].some((m) => !/^\s+ask\s+--wait\b/.test(m[1]));
}

/**
 * Whether a process under PID (never PID itself: its arguments hold the prompt) runs one.
 * @param {number} pid @param {Map<number, { ppid: number, args: string }>} table
 */
export function commandUnder(pid, table) {
  /** @type {Map<number, number[]>} */
  const children = new Map();
  for (const [p, row] of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), p]);
  const seen = new Set([pid]);
  const todo = [...(children.get(pid) ?? [])];
  while (todo.length) {
    const p = /** @type {number} */ (todo.pop());
    if (seen.has(p)) continue;
    seen.add(p);
    if (runsPrdCommand(table.get(p)?.args ?? "")) return true;
    todo.push(...(children.get(p) ?? []));
  }
  return false;
}

/**
 * This tick's context actions, in the order to apply them.
 * @param {{ sessions: ContextSession[], sizes?: Record<string, any>,
 *   entries?: Record<string, ContextEntry>, asks?: Record<string, any>, running?: Set<string>,
 *   briefs?: Record<string, number>, paused?: boolean, limit: number, waitMs: number,
 *   now: number }} facts `briefs`: a session's usable brief file, by when it was written (ms)
 * @returns {ContextAction[]}
 */
export function contextDecision({
  sessions,
  sizes = {},
  entries = {},
  asks = {},
  running = new Set(),
  briefs = {},
  paused = false,
  limit,
  waitMs,
  now,
}) {
  if (paused) return [];
  /** @type {ContextAction[]} */
  const actions = [];
  const openAsk = (/** @type {ContextEntry} */ e) => {
    const ask = e.askId ? asks[e.askId] : null;
    return ask && awaitsAnswer(ask) ? /** @type {string} */ (e.askId) : null;
  };
  const watched = new Map(
    sessions
      .filter((s) => s.live && s.managed && ((s.kind === "prd" && s.topic) || s.kind === "backlog"))
      .map((s) => [s.name, s]),
  );
  for (const [session, e] of Object.entries(entries)) {
    const s = watched.get(session);
    if (!s || s.pid !== e.pid) actions.push({ type: "clear", session, askId: openAsk(e) });
  }

  for (const s of watched.values()) {
    const session = s.name;
    const pid = s.pid;
    // A backlog session has no topic: its questions and reports go under its name.
    const topic = s.kind === "backlog" ? session : /** @type {string} */ (s.topic);
    const e = entries[session]?.pid === pid ? entries[session] : null;
    const rec = sizes[session]?.pid === pid ? sizes[session] : null;
    if (!(typeof rec?.size === "number" && rec.size > limit)) {
      if (e && e.answer !== "leave") actions.push({ type: "clear", session, askId: openAsk(e) });
      continue;
    }
    if (s.rotating) continue;

    let answer = e?.answer ?? null;
    if (!answer && e?.askId) {
      const ask = asks[e.askId];
      if (ask && awaitsAnswer(ask)) continue;
      answer = ask?.answeredAt ? contextAnswer(ask.answer) : "leave";
      actions.push({ type: "answered", session, pid, answer, askId: e.askId });
    }
    if (answer === "leave") continue;
    if (rec.keep && Date.parse(rec.keep.until) > now) continue;

    if (answer === "rotate") {
      if (e?.triedAt && now - e.triedAt < waitMs) continue;
      if (running.has(session)) actions.push({ type: "hold", session });
      else if (s.kind === "backlog") {
        const delivered = Date.parse(rec.nudgeDeliveredAt ?? "");
        const brief = briefs[session] !== undefined && briefs[session] > delivered;
        actions.push({ type: "rotate-backlog", session, pid, topic, brief });
      } else actions.push({ type: "rotate", session, pid, topic });
      continue;
    }
    if (rec.nudgeDeliveredAt) {
      if (now - Date.parse(rec.nudgeDeliveredAt) >= waitMs)
        actions.push({ type: "ask", session, pid, topic, text: contextQuestion(session, rec.size) });
    } else if (!rec.nudgeAt && rec.firstOverAt && now - Date.parse(rec.firstOverAt) >= waitMs)
      actions.push({ type: "nudge", session, pid });
  }
  return actions;
}
