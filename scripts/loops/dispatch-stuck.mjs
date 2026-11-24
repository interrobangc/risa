// The dispatcher's stuck-orchestrator follow-up (B-408): an orchestrator can't
// watch itself, so the tick (dispatch.mjs) does. Pure: the tick gathers the
// session records, heartbeats (heartbeat.mjs), the commands under each session,
// the asks and the watch's files (watch.mjs), and acts.
//
// A live, managed, run-through (`auto`) orchestrator is stuck when either:
//   - quiet: no heartbeat of its own for the limit (CARETOOK_STUCK_MIN, 30), no
//     agent of its session with a heartbeat inside the limit (a hung slice agent's
//     old one doesn't count), and nothing running; or
//   - a watch action unhandled: a slice's pending action in the watch's state.json
//     (`actions[n].since`) older than the limit, with no mark for that slice since.
// Nothing running: no unfinished call of its own (an Agent call aside: its agent's
// heartbeat speaks for it) and no `pnpm prd` or `pnpm backlog` command under its
// pid, `watch --wait` and `ask --wait` aside (they wait for days). And no open
// question of its topic (anyone's, the context question too).
//
// Never: a session opened by hand (not managed, or not run-through), one rotating,
// or one with no heartbeat of its own ever (unknown: left alone).
//
// Each stall gets one question (session STUCK_SESSION, filed --waits: it never
// defaults; a restart burns usage). "rotate it now": the mid-wave rotation
// (rotate.sh <topic> --mid-wave, its own guards); a refusal is reported once and
// tried again only after the limit. "leave it", an unclear answer or a dismissal:
// nothing more for that stall. A stall that ends (the session is active again,
// ends or rotates) clears its entry and dismisses its open question.
//
// A tick gap over the gap (CARETOOK_STUCK_GAP seconds, 600, at least three ticks;
// a sleep, or a paused dispatcher) resets the clocks: every time counts from then.
// Two or more going quiet within the limit of each other (a usage limit, a network
// loss) raise one report and no question.
//
// The state is `stuck` in the dispatcher's state: { lastTickAt, clockFrom,
// sessions: { <name>: StuckEntry }, reported: [<key>…] }.
import { awaitsAnswer } from "./asks.mjs";
import { runsPrdCommand } from "./dispatch-context.mjs";

/** The `session` of the stuck questions and reports: apart from the reopen and context ones. */
export const STUCK_SESSION = "dispatch-stuck";
/** The answers a stuck question offers. */
export const STUCK_OPTIONS = ["rotate it now", "leave it"];

const MIN = 60_000;

/** The settings from ENV: the limit and the tick gap, in ms. */
export function stuckSettings(/** @type {NodeJS.ProcessEnv} */ env = {}, /** @type {number} */ everyS = 60) {
  const num = (/** @type {string} */ k, /** @type {number} */ d) => {
    const v = Number(env[k]);
    return env[k] && Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    limitMs: num("CARETOOK_STUCK_MIN", 30) * MIN,
    gapMs: Math.max(num("CARETOOK_STUCK_GAP", 600), 3 * everyS) * 1000,
  };
}

/** What a stuck question's answer means; anything unclear leaves the stall alone. */
export function stuckAnswer(/** @type {string | null | undefined} */ answer) {
  const a = String(answer ?? "")
    .trim()
    .toLowerCase();
  return a === STUCK_OPTIONS[0] || /^(1|rotate)\b/.test(a) ? "rotate" : "leave";
}

const WAIT = /(?:\bprd(?:\.sh)?\s+watch\b[^;&|]*\s--wait\b|\bprd(?:\.sh)?\s+ask\s+--wait\b)/;

/** Whether a command only waits (`pnpm prd watch … --wait`, `pnpm prd ask --wait`). */
export const onlyWaits = (/** @type {string | null | undefined} */ command) => WAIT.test(command ?? "");

/** Whether a process command line is a `pnpm prd`/`pnpm backlog` command that isn't only a wait. */
export const busyCommand = (/** @type {string} */ args) => runsPrdCommand(args) && !onlyWaits(args);

/**
 * Whether a process under PID (never PID itself) is busy (busyCommand).
 * @param {number} pid @param {Map<number, { ppid: number, args: string }>} table
 */
export function busyUnder(pid, table) {
  /** @type {Map<number, number[]>} */
  const children = new Map();
  for (const [p, row] of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), p]);
  const seen = new Set([pid]);
  const todo = [...(children.get(pid) ?? [])];
  while (todo.length) {
    const p = /** @type {number} */ (todo.pop());
    if (seen.has(p)) continue;
    seen.add(p);
    if (busyCommand(table.get(p)?.args ?? "")) return true;
    todo.push(...(children.get(p) ?? []));
  }
  return false;
}

/** This tick's clock reset: now after a gap since the last tick, else the last reset. Pure. */
export function stuckClock(
  /** @type {{ lastTickAt?: number, clockFrom?: number | null } | undefined} */ prev,
  /** @type {number} */ now,
  /** @type {number} */ gapMs,
) {
  const last = typeof prev?.lastTickAt === "number" ? prev.lastTickAt : null;
  if (last !== null && now - last > gapMs) return now;
  return typeof prev?.clockFrom === "number" ? prev.clockFrom : null;
}

const ms = (/** @type {unknown} */ t) => {
  const n = typeof t === "number" ? t : Date.parse(String(t ?? ""));
  return Number.isNaN(n) ? null : n;
};
const latest = (/** @type {unknown[]} */ ts) => {
  const all = ts.map(ms).filter((n) => n !== null);
  return all.length ? Math.max(.../** @type {number[]} */ (all)) : null;
};
const iso = (/** @type {number} */ n) => new Date(n).toISOString();
const mins = (/** @type {number} */ n) => `${Math.max(0, Math.round(n / MIN))}m`;

/**
 * @typedef {{ pid: number, since: number, askId?: string, answer?: "rotate" | "leave",
 *   triedAt?: number, reported?: boolean }} StuckEntry
 * @typedef {{ name: string, pid: number, kind?: string, topic?: string, managed?: boolean,
 *   auto?: boolean, live: boolean, rotating?: boolean }} StuckSession
 * @typedef {{ actions?: Record<string, { action: string, since: string }> } | null} WatchState
 * @typedef {{ type: "clear", session: string, askId: string | null }
 *   | { type: "ask", session: string, pid: number, topic: string, text: string, since: number }
 *   | { type: "answered", session: string, answer: "rotate" | "leave", askId: string }
 *   | { type: "rotate", session: string, pid: number, topic: string }
 *   | { type: "report", key: string, sessions: string[], text: string }} StuckAction
 */

/**
 * The stall a watched session is in, or null. Pure.
 * @returns {{ kind: "quiet" | "watch", since: number, why: string } | null}
 */
function stallOf(
  /** @type {StuckSession} */ s,
  /** @type {any[]} */ beats,
  /** @type {{ busy: boolean, openAsk: boolean, watch: WatchState, marks: { slice: string, at: string }[],
   *   eff: (t: number | null) => number | null, limitMs: number, now: number }} */ f,
) {
  const own = beats.find((h) => !h.agent);
  if (!own) return null;
  const calls = Object.values(own.running ?? {}).filter(
    (c) => !["Agent", "Task"].includes(c?.tool) && !onlyWaits(c?.command),
  );
  if (f.busy || calls.length || f.openAsk) return null;
  const last = f.eff(latest([own.lastStart, own.lastEnd, own.stoppedAt]));
  const agentRecent = beats.some((h) => {
    if (!h.agent) return false;
    const t = f.eff(latest([h.lastStart, h.lastEnd, h.stoppedAt]));
    return t !== null && f.now - t < f.limitMs;
  });
  if (last !== null && !agentRecent && f.now - last >= f.limitMs)
    return {
      kind: "quiet",
      since: last,
      why: `no tool call for ${mins(f.now - last)}, no agent of it active and nothing running`,
    };
  let oldest = null;
  for (const [n, a] of Object.entries(f.watch?.actions ?? {})) {
    const since = f.eff(ms(a?.since));
    if (since === null || f.now - since < f.limitMs) continue;
    if (f.marks.some((m) => String(m.slice) === n && (ms(m.at) ?? 0) >= (ms(a.since) ?? 0))) continue;
    if (!oldest || since < oldest.since) oldest = { n, action: a.action, since };
  }
  if (oldest)
    return {
      kind: "watch",
      since: oldest.since,
      why: `slice ${oldest.n}'s watch action (${oldest.action}) has waited ${mins(f.now - oldest.since)} unhandled`,
    };
  return null;
}

/**
 * This tick's stuck actions, in the order to apply them. Pure.
 * @param {{ sessions: StuckSession[], heartbeats?: any[], running?: Set<string>, asks?: any[],
 *   watch?: Record<string, { state: WatchState, marks: { slice: string, at: string }[] }>,
 *   entries?: Record<string, StuckEntry>, reported?: string[], paused?: boolean,
 *   clockFrom?: number | null, limitMs: number, now: number }} facts `heartbeats`: every
 *   record (heartbeat.mjs), stale ones too; `running`: sessions with a busy command under
 *   them; `asks`: every ask; `watch`: each topic's watch state and marks
 * @returns {StuckAction[]}
 */
export function stuckDecision({
  sessions,
  heartbeats = [],
  running = new Set(),
  asks = [],
  watch = {},
  entries = {},
  reported = [],
  paused = false,
  clockFrom = null,
  limitMs,
  now,
}) {
  if (paused) return [];
  /** @type {StuckAction[]} */
  const actions = [];
  const byId = new Map(asks.map((a) => [a.id, a]));
  const openOf = (/** @type {StuckEntry | undefined} */ e) => {
    const a = e?.askId ? byId.get(e.askId) : null;
    return a && awaitsAnswer(a) ? /** @type {string} */ (e?.askId) : null;
  };
  const eff = (/** @type {number | null} */ t) =>
    t === null ? clockFrom : clockFrom === null ? t : Math.max(t, clockFrom);
  const watched = sessions.filter(
    (s) => s.live && s.managed && s.auto && s.kind === "prd" && s.topic && !s.rotating,
  );

  /** @type {{ s: StuckSession, stall: NonNullable<ReturnType<typeof stallOf>> }[]} */
  const fresh = [];
  /** @type {Set<string>} */
  const stuck = new Set();
  for (const s of watched) {
    const topic = /** @type {string} */ (s.topic);
    const e = entries[s.name]?.pid === s.pid ? entries[s.name] : undefined;
    const stall = stallOf(
      s,
      heartbeats.filter((h) => h.session === s.name && h.pid === s.pid),
      {
        busy: running.has(s.name),
        openAsk: asks.some((a) => a.topic === topic && a.id !== e?.askId && awaitsAnswer(a)),
        watch: watch[topic]?.state ?? null,
        marks: watch[topic]?.marks ?? [],
        eff,
        limitMs,
        now,
      },
    );
    if (!stall) continue;
    if (!e) {
      fresh.push({ s, stall });
      continue;
    }
    stuck.add(s.name);
    let answer = e.answer ?? null;
    if (!answer && e.askId) {
      const a = byId.get(e.askId);
      if (a && awaitsAnswer(a)) continue;
      answer = a?.answeredAt ? stuckAnswer(a.answer) : "leave";
      actions.push({ type: "answered", session: s.name, answer, askId: e.askId });
    }
    if (answer === "rotate" && !(e.triedAt && now - e.triedAt < limitMs))
      actions.push({ type: "rotate", session: s.name, pid: s.pid, topic });
  }

  // An entry whose stall is over, or whose session is gone or another, clears first.
  const clears = Object.entries(entries)
    .filter(([session]) => !stuck.has(session))
    .map(([session, e]) => /** @type {StuckAction} */ ({ type: "clear", session, askId: openOf(e) }));
  actions.unshift(...clears);

  // Several quiet at once: one report, no question.
  const quiet = fresh.filter((f) => f.stall.kind === "quiet");
  const together = quiet.filter((a) =>
    quiet.some((b) => b !== a && Math.abs(a.stall.since - b.stall.since) <= limitMs),
  );
  if (together.length >= 2) {
    const names = together.map((t) => t.s.name).sort();
    const since = Math.min(...together.map((t) => t.stall.since));
    const key = `${names.join(",")}@${iso(since)}`;
    if (!reported.includes(key))
      actions.push({
        type: "report",
        key,
        sessions: names,
        text: `${names.join(", ")} went quiet together since ${iso(since)}: a usage limit or a network loss? No question asked; nothing is rotated`,
      });
  }
  for (const { s, stall } of fresh) {
    if (together.some((t) => t.s === s)) continue;
    actions.push({
      type: "ask",
      session: s.name,
      pid: s.pid,
      topic: /** @type {string} */ (s.topic),
      since: stall.since,
      text: `${s.name} looks stuck: ${stall.why}. Rotate it now (mid-wave), or leave it?`,
    });
  }
  return actions;
}
