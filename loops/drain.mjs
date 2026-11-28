// The drain: how close the plan's limits are, and what the dispatcher does about it.
//
// drainDecision (pure) turns the usage reading (usage.mjs mergeReadings) into one of
//   normal    nothing held;
//   draining  a plan window (5-hour or weekly) at RISA_USAGE_DRAIN (95%) or more:
//             no start, plan or reopen (`prd dispatch --resume` doesn't override it),
//             and a new slice worktree is refused (new.sh slice runs `drain.mjs check`);
//   limited   a plan window at RISA_USAGE_STOP (98%) or more, a reading showing overage
//             (a plan window at 100%: extra usage, if it's on, is being spent), or a session
//             stopped on a limit whose reset hasn't passed: as draining, and the tick ends
//             each managed session (marked stalled, error "limited"), except one running a
//             landing, which finishes first. Hand-opened sessions, and backlog and inbox
//             sessions (the kept kinds: keep-alive.mjs), are never ended: one report names them. Nothing opens a claude while limited (no helper, keep-alive,
//             session request, rotation or `claude -p` probe: a probe would spend on extra
//             usage and succeed, so it can't show the limit has reset); resuming goes by the
//             reading's reset time.
// with the reset time. An unknown reading (none, or all over RISA_USAGE_STALE_MIN old)
// never drains: with a session live longer than that, it files one report per incident.
// RISA_USAGE_WATCH=off: always normal.
// The allowance (`prd dispatch --allow <topic>`, .loops/.drain-allow, read every tick): while
// draining, that one topic still starts, plans, reopens, resumes and makes slice worktrees
// (drainHolds); at the stop (limited) it ends like the rest.
//
// sessionDrains (pure): each session's drain on its own account's readings (a reading's
// `account`, usage.mjs), so a session on another Claude config folder is drained, and ended
// when limited, on that account's numbers, not the dispatcher's.
// limitActions (pure): what a limited tick does to each live session.
// landingUnder (pure): whether a session runs a landing (land.sh, or a landing journal's pid,
// among its descendants).
//
//   node drain.mjs [--json]   the drain state, from the readings (RISA_USAGE_DIR)
//   node drain.mjs check [<topic> [<allow-file>]]
//                             new.sh slice's gate: exit 3 with the reason while draining (unless
//                             TOPIC is the allowance in ALLOW-FILE) or limited; else 0 (and 0 on
//                             any error: watching never hurts the work)
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { span } from "./asks.mjs";
import { toolCmd } from "./config.mjs";
import { KEPT_KINDS } from "./keep-alive.mjs";
import { clock, mergeReadings, readUsage, stallHolds, staleMsOf, timeOf, usageDirOf } from "./usage.mjs";

export const DRAIN_PERCENT = 95;
export const STOP_PERCENT = 98;
/** A session sent TERM this long ago and still live is sent KILL (as `prd end`). */
export const END_WAIT_MS = 10_000;
/** The stall error the dispatcher's own stop writes. */
export const LIMITED_ERROR = "limited";

const percentOf = (/** @type {string | undefined} */ v, /** @type {number} */ d) => {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : d;
};

/** The lines and the switch, from the environment. */
export function drainSettings(env = process.env) {
  const drain = percentOf(env.RISA_USAGE_DRAIN, DRAIN_PERCENT);
  const stop = percentOf(env.RISA_USAGE_STOP, STOP_PERCENT);
  return { drain: Math.min(drain, stop), stop, off: env.RISA_USAGE_WATCH === "off" };
}

/** The topic name an allowance may hold (a registry topic: letters, digits, dashes). */
const TOPIC_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Whether TEXT is a topic an allowance may name. */
export const allowableTopic = (/** @type {string} */ text) => TOPIC_RE.test(text);

/** The stored allowance (`prd dispatch --allow`, .loops/.drain-allow): its topic, or null when none. */
export function readAllowance(/** @type {string | null | undefined} */ file) {
  if (!file) return null;
  let text;
  try {
    text = readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
  return allowableTopic(text) ? text : null;
}

/**
 * @typedef {{ state: "normal" | "draining" | "limited", resetsAt: number | null, why: string,
 *   unknown: boolean, allow?: string | null }} Drain
 *   unknown: no current reading while a session has been live longer than staleMs (report it);
 *   allow: the topic let past the drain line (drainHolds), set only while draining
 */

/**
 * Whether DRAIN holds TOPIC (no start, plan, reopen, resume or slice worktree): limited always;
 * draining unless TOPIC is its allowance. Pure.
 * @param {Pick<Drain, "state"> & { allow?: string | null }} drain @param {string | null | undefined} topic
 */
export function drainHolds(drain, topic) {
  if (drain.state === "limited") return true;
  if (drain.state !== "draining") return false;
  return !topic || drain.allow !== topic;
}

/**
 * The drain state. Pure.
 * @param {ReturnType<typeof import("./usage.mjs").mergeReadings>} usage
 * @param {{ drain: number, stop: number, off?: boolean, now: number, staleMs: number,
 *   sessions?: { live: boolean, startedMs?: number | null }[], timeZone?: string,
 *   allow?: string | null }} opts
 *   allow: the stored allowance (readAllowance): kept only while draining
 * @returns {Drain}
 */
export function drainDecision(
  usage,
  { drain, stop, off = false, now, staleMs, sessions = [], timeZone, allow = null },
) {
  const normal = (/** @type {string} */ why, unknown = false) => ({
    state: /** @type {const} */ ("normal"),
    resetsAt: null,
    why,
    unknown,
  });
  if (off) return normal("the usage watch is off (RISA_USAGE_WATCH=off)");
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
      why:
        `${say(stopped)}, at or over the stop line ${stop}% (${until(resetsAt)})` +
        (allow ? `; the allowance for ${allow} ends here` : ""),
      unknown: false,
    };
  }
  const draining = over(drain);
  if (draining.length) {
    const resetsAt = latest(draining);
    return {
      state: "draining",
      resetsAt,
      why:
        `${say(draining)}, at or over the drain line ${drain}% (${until(resetsAt)})` +
        (allow
          ? `; ${allow} is allowed past it (${toolCmd.prd} dispatch --allow), until the stop ${stop}%`
          : ""),
      unknown: false,
      allow,
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

/**
 * SESSION's account: its reading's (`account`; a reading without one is Claude Code's
 * default, null, never FALLBACK), else FALLBACK (the dispatcher's own) when it has no reading. Pure.
 * @param {any[]} readings @param {string} session @param {string | null} fallback
 */
export function sessionAccount(readings, session, fallback) {
  const r = readings.find((x) => x && typeof x === "object" && String(x.session) === session);
  return r ? (r.account ?? null) : fallback;
}

/**
 * Each session's drain, from its own account's readings only. A session's account is its
 * reading's (`account`, absent for Claude Code's default); one with no reading takes ACCOUNT
 * (the dispatcher's own: host.mjs claudeAccount). Pure.
 * @param {any[]} readings every session's (usage.mjs readReadings)
 * @param {string[]} names the sessions
 * @param {{ drain: number, stop: number, off?: boolean, now: number, staleMs: number,
 *   timeZone?: string, account?: string | null }} opts
 * @returns {Record<string, Drain>}
 */
export function sessionDrains(readings, names, { account = null, ...opts }) {
  /** @type {Map<string | null, Drain>} */
  const byAccount = new Map();
  /** @type {Record<string, Drain>} */
  const out = {};
  for (const name of names) {
    const a = sessionAccount(readings, name, account);
    let d = byAccount.get(a);
    if (!d) {
      const mine = readings.filter((r) => (r?.account ?? null) === a);
      d = drainDecision(mergeReadings(mine, { now: opts.now, staleMs: opts.staleMs }), opts);
      byAccount.set(a, d);
    }
    out[name] = d;
  }
  return out;
}

/**
 * The sessions whose stall mark still holds at NOW (its reset ahead): a dead one is never
 * reopened by the pick (dispatch-pick.mjs `stalled`), only resumed after its reset
 * (resume.mjs), so a session ended on its own limited account isn't reopened at once. Pure.
 * @param {any[]} readings @param {number} now
 */
export function stalledSessions(readings, now) {
  return new Set(readings.filter((r) => stallHolds(r?.stalled, now)).map((r) => String(r.session)));
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
 * @typedef {{ name: string, pid: number, live: boolean, managed: boolean, kind?: string }} LimitSession
 *   kind: the record's (backlog and inbox sessions are never ended)
 * @typedef {{ type: "end", session: string, pid: number }
 *   | { type: "kill", session: string, pid: number }
 *   | { type: "wait", session: string, why: string }
 *   | { type: "report", sessions: string[], text: string }} LimitAction
 */

/**
 * What a limited tick does to each live session. Pure.
 * @param {{ sessions: LimitSession[], landing: Set<string>,
 *   stalls: Record<string, { pid?: number | null, at?: string | number | null, error?: string } | null | undefined>,
 *   reported?: string[], drain: Drain, drains?: Record<string, Drain>, now: number, endWaitMs?: number }} facts
 *   stalls: each session's stall mark (its usage reading's); reported: hand-opened, backlog
 *   and inbox sessions already named in this incident's report; drains: each session's own (sessionDrains),
 *   DRAIN for one it leaves out
 * @returns {LimitAction[]}
 */
export function limitActions({
  sessions,
  landing,
  stalls,
  reported = [],
  drain,
  drains = {},
  now,
  endWaitMs = END_WAIT_MS,
}) {
  /** @type {LimitAction[]} */
  const out = [];
  const hand = [];
  const kept = [];
  /** @type {string[]} */
  const whys = [];
  for (const s of sessions) {
    if (!s.live || !s.pid) continue;
    const own = drains[s.name] ?? drain;
    if (own.state !== "limited") continue;
    const isKept = KEPT_KINDS.includes(s.kind ?? s.name);
    if (!s.managed || isKept) {
      (isKept ? kept : hand).push(s.name);
      if (!reported.includes(s.name) && !whys.includes(own.why)) whys.push(own.why);
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
  const freshHand = hand.filter((n) => !reported.includes(n));
  const freshKept = kept.filter((n) => !reported.includes(n));
  const fresh = [...freshHand, ...freshKept].sort();
  if (fresh.length) {
    const never = [
      ...(freshHand.length ? ["one opened by hand"] : []),
      ...(freshKept.length ? ["a backlog or inbox session"] : []),
    ].join(", or ");
    out.push({
      type: "report",
      sessions: fresh,
      text: `Usage is limited (${whys.join("; ")}). The dispatcher ended its managed sessions, but never ends ${never}: ${fresh.join(", ")} ${fresh.length === 1 ? "is" : "are"} still live and can spend extra usage. End ${fresh.length === 1 ? "it" : "them"}, or turn extra usage off in the account.`,
    });
  }
  return out;
}

/** The drain state from the readings in DIR, for scripts. */
export function readDrain(
  /** @type {string | null} */ dir,
  { now = Date.now(), env = process.env, allow = /** @type {string | null} */ (null) } = {},
) {
  const staleMs = staleMsOf(env);
  return drainDecision(readUsage(dir, { now, env }), { ...drainSettings(env), now, staleMs, allow });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd = "", topic = "", allowFile = ""] = process.argv.slice(2);
  if (cmd === "check") {
    let d;
    try {
      d = readDrain(usageDirOf(), { allow: readAllowance(allowFile) });
    } catch {
      process.exit(0);
    }
    if (!drainHolds(d, topic)) process.exit(0);
    process.stdout.write(
      `usage is ${d.state}: ${d.why}; no new slice worktree until it resets (RISA_USAGE_WATCH=off overrides; while draining, ${toolCmd.prd} dispatch --allow <topic> lets one topic past)\n`,
    );
    process.exit(3);
  }
  const d = readDrain(usageDirOf());
  if (cmd === "--json") process.stdout.write(`${JSON.stringify(d, null, 2)}\n`);
  else if (cmd === "") process.stdout.write(`Drain: ${d.state}: ${d.why}\n`);
  else {
    console.error("usage: drain.mjs [--json] | check [<topic> [<allow-file>]]");
    process.exit(2);
  }
}
