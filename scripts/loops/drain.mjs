// The drain: how close the plan's limits are, and what the dispatcher does about it.
//
// drainDecision (pure) turns the usage reading (usage.mjs mergeReadings) into one of
//   normal    nothing held;
//   draining  a plan window (5-hour or weekly) at CARETOOK_USAGE_DRAIN (95%) or more:
//             no start, plan or reopen (`pnpm prd dispatch --resume` doesn't override it),
//             and a new slice worktree is refused (new.sh slice runs `drain.mjs check`);
//   limited   a plan window at CARETOOK_USAGE_STOP (98%) or more, a reading showing overage
//             (a plan window at 100%: extra usage, if it's on, is being spent), or a session
//             stopped on a limit whose reset hasn't passed: as draining, and the tick ends
//             each managed session (marked stalled, error "limited"), except one running a
//             landing, which finishes first. Hand-opened sessions are never ended: one report
//             names them. Nothing opens a claude while limited (no helper, keep-alive,
//             session request, rotation or `claude -p` probe: a probe would spend on extra
//             usage and succeed, so it can't show the limit has reset); resuming goes by the
//             reading's reset time.
// with the reset time. An unknown reading (none, or all over CARETOOK_USAGE_STALE_MIN old)
// never drains: with a session live longer than that, it files one report per incident.
// CARETOOK_USAGE_WATCH=off: always normal.
//
// limitActions (pure): what a limited tick does to each live session.
// landingUnder (pure): whether a session runs a landing (land.sh, or a landing journal's pid,
// among its descendants).
//
//   node drain.mjs [--json]   the drain state, from the readings (CARETOOK_USAGE_DIR)
//   node drain.mjs check      new.sh slice's gate: exit 3 with the reason while draining or
//                             limited; else 0 (and 0 on any error: watching never hurts the work)
import { pathToFileURL } from "node:url";
import { span } from "./asks.mjs";
import { clock, readUsage, staleMsOf, timeOf, usageDirOf } from "./usage.mjs";

export const DRAIN_PERCENT = 95;
export const STOP_PERCENT = 98;
/** A session sent TERM this long ago and still live is sent KILL (as `pnpm prd end`). */
export const END_WAIT_MS = 10_000;
/** The stall error the dispatcher's own stop writes. */
export const LIMITED_ERROR = "limited";

const percentOf = (/** @type {string | undefined} */ v, /** @type {number} */ d) => {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : d;
};

/** The lines and the switch, from the environment. */
export function drainSettings(env = process.env) {
  const drain = percentOf(env.CARETOOK_USAGE_DRAIN, DRAIN_PERCENT);
  const stop = percentOf(env.CARETOOK_USAGE_STOP, STOP_PERCENT);
  return { drain: Math.min(drain, stop), stop, off: env.CARETOOK_USAGE_WATCH === "off" };
}

/**
 * @typedef {{ state: "normal" | "draining" | "limited", resetsAt: number | null, why: string,
 *   unknown: boolean }} Drain
 *   unknown: no current reading while a session has been live longer than staleMs (report it)
 */

/**
 * The drain state. Pure.
 * @param {ReturnType<typeof import("./usage.mjs").mergeReadings>} usage
 * @param {{ drain: number, stop: number, off?: boolean, now: number, staleMs: number,
 *   sessions?: { live: boolean, startedMs?: number | null }[], timeZone?: string }} opts
 * @returns {Drain}
 */
export function drainDecision(usage, { drain, stop, off = false, now, staleMs, sessions = [], timeZone }) {
  const normal = (/** @type {string} */ why, unknown = false) => ({
    state: /** @type {const} */ ("normal"),
    resetsAt: null,
    why,
    unknown,
  });
  if (off) return normal("the usage watch is off (CARETOOK_USAGE_WATCH=off)");
  // No "in 2h": the dispatcher logs an idle tick only when its lines change.
  const until = (/** @type {number | null} */ t) =>
    t === null ? "reset unknown" : `until ${clock(t, now, timeZone)}`;
  // mergeReadings keeps only the stalls that still hold.
  const stalled = usage.stalled ?? [];
  if (stalled.length) {
    const resets = stalled.map((s) => s.resetsAt).filter((t) => t !== null);
    const resetsAt = resets.length ? Math.max(...resets) : (usage.resetsAt ?? null);
    return {
      state: "limited",
      resetsAt,
      why: `stopped on a limit: ${stalled.map((s) => s.session).join(", ")} (${until(resetsAt)})`,
      unknown: false,
    };
  }
  /** @type {[string, { percent: number, resetsAt: number | null } | null][]} */
  const plan = [
    ["5h", usage.fiveHour],
    ["7d", usage.sevenDay],
  ];
  const over = (/** @type {number} */ line) =>
    plan.flatMap(([label, w]) => (w && w.percent >= line ? [{ label, ...w }] : []));
  const say = (/** @type {{ label: string, percent: number }[]} */ ws) =>
    ws.map((w) => `${w.label} ${Math.round(w.percent)}%`).join(", ");
  const latest = (/** @type {{ resetsAt: number | null }[]} */ ws) => {
    const r = ws.map((w) => w.resetsAt).filter((t) => t !== null);
    return r.length ? Math.max(...r) : null;
  };
  const overage = over(100);
  if (overage.length) {
    const resetsAt = latest(overage);
    return {
      state: "limited",
      resetsAt,
      why: `over the plan limit (${say(overage)}): extra usage (${until(resetsAt)})`,
      unknown: false,
    };
  }
  const stopped = over(stop);
  if (stopped.length) {
    const resetsAt = latest(stopped);
    return {
      state: "limited",
      resetsAt,
      why: `${say(stopped)}, at or over the stop line ${stop}% (${until(resetsAt)})`,
      unknown: false,
    };
  }
  const draining = over(drain);
  if (draining.length) {
    const resetsAt = latest(draining);
    return {
      state: "draining",
      resetsAt,
      why: `${say(draining)}, at or over the drain line ${drain}% (${until(resetsAt)})`,
      unknown: false,
    };
  }
  if (!usage.known) {
    const longLive = sessions.some(
      (s) => s.live && typeof s.startedMs === "number" && now - s.startedMs > staleMs,
    );
    return normal(`usage unknown (no reading in the last ${span(staleMs)}): not draining`, longLive);
  }
  return normal("under the drain line");
}

/** Whether anything may run a claude to probe the limit (`claude -p`): never while limited. Pure. */
export const probeAllowed = (/** @type {Drain} */ d) => d.state !== "limited";

/**
 * Whether a session runs a landing: a land.sh (or `prd land`) process, or a landing journal's
 * live pid, among PID's descendants. Pure.
 * @param {number} pid
 * @param {Map<number, { ppid: number, args: string }>} table
 * @param {Set<number>} [journalPids]
 */
export function landingUnder(pid, table, journalPids = new Set()) {
  /** @type {Map<number, number[]>} */
  const children = new Map();
  for (const [p, row] of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), p]);
  const seen = new Set([pid]);
  const todo = [...(children.get(pid) ?? [])];
  while (todo.length) {
    const p = /** @type {number} */ (todo.pop());
    if (seen.has(p)) continue;
    seen.add(p);
    if (journalPids.has(p) || isLanding(table.get(p)?.args ?? "")) return true;
    todo.push(...(children.get(p) ?? []));
  }
  return false;
}

/** A ps command line that runs a landing: land.sh (as a script), or `prd land`. */
export function isLanding(/** @type {string} */ args) {
  const [first = "", second = ""] = args.trim().split(/\s+/);
  const base = (/** @type {string} */ w) => w.slice(w.lastIndexOf("/") + 1);
  if (base(first) === "land.sh") return true;
  if (["bash", "sh", "zsh"].includes(base(first)) && base(second) === "land.sh") return true;
  return /(?:^|\/|\s)prd(?:\.sh)?\s+land(?:\s|$)/.test(args);
}

/**
 * @typedef {{ name: string, pid: number, live: boolean, managed: boolean }} LimitSession
 * @typedef {{ type: "end", session: string, pid: number }
 *   | { type: "kill", session: string, pid: number }
 *   | { type: "wait", session: string, why: string }
 *   | { type: "report", sessions: string[], text: string }} LimitAction
 */

/**
 * What a limited tick does to each live session. Pure.
 * @param {{ sessions: LimitSession[], landing: Set<string>,
 *   stalls: Record<string, { pid?: number | null, at?: string | number | null, error?: string } | null | undefined>,
 *   reported?: string[], drain: Drain, now: number, endWaitMs?: number }} facts
 *   stalls: each session's stall mark (its usage reading's); reported: hand-opened sessions
 *   already named in this incident's report
 * @returns {LimitAction[]}
 */
export function limitActions({
  sessions,
  landing,
  stalls,
  reported = [],
  drain,
  now,
  endWaitMs = END_WAIT_MS,
}) {
  if (drain.state !== "limited") return [];
  /** @type {LimitAction[]} */
  const out = [];
  const hand = [];
  for (const s of sessions) {
    if (!s.live || !s.pid) continue;
    if (!s.managed) {
      hand.push(s.name);
      continue;
    }
    if (landing.has(s.name)) {
      out.push({ type: "wait", session: s.name, why: "it runs a landing: ended once that finishes" });
      continue;
    }
    const mark = stalls[s.name];
    const ours = mark && mark.error === LIMITED_ERROR && (mark.pid ?? null) === s.pid;
    const at = ours ? timeOf(mark.at) : null;
    if (ours && at !== null && now - at >= endWaitMs) out.push({ type: "kill", session: s.name, pid: s.pid });
    else if (ours) out.push({ type: "wait", session: s.name, why: "sent TERM; waiting for it to end" });
    else out.push({ type: "end", session: s.name, pid: s.pid });
  }
  const fresh = hand.filter((n) => !reported.includes(n)).sort();
  if (fresh.length)
    out.push({
      type: "report",
      sessions: fresh,
      text: `Usage is limited (${drain.why}). The dispatcher ended its managed sessions, but never ends one opened by hand: ${fresh.join(", ")} ${fresh.length === 1 ? "is" : "are"} still live and can spend extra usage. End ${fresh.length === 1 ? "it" : "them"}, or turn extra usage off in the account.`,
    });
  return out;
}

/** The drain state from the readings in DIR, for scripts. */
export function readDrain(/** @type {string | null} */ dir, { now = Date.now(), env = process.env } = {}) {
  const staleMs = staleMsOf(env);
  return drainDecision(readUsage(dir, { now, env }), { ...drainSettings(env), now, staleMs });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd = ""] = process.argv.slice(2);
  if (cmd === "check") {
    let d;
    try {
      d = readDrain(usageDirOf());
    } catch {
      process.exit(0);
    }
    if (d.state === "normal") process.exit(0);
    process.stdout.write(
      `usage is ${d.state}: ${d.why}; no new slice worktree until it resets (CARETOOK_USAGE_WATCH=off overrides)\n`,
    );
    process.exit(3);
  }
  const d = readDrain(usageDirOf());
  if (cmd === "--json") process.stdout.write(`${JSON.stringify(d, null, 2)}\n`);
  else if (cmd === "") process.stdout.write(`Drain: ${d.state}: ${d.why}\n`);
  else {
    console.error("usage: drain.mjs [--json] | check");
    process.exit(2);
  }
}
