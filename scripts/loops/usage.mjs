// The usage reading: how much of the plan's 5-hour and weekly limits (and a Claude
// gateway's spend limit) is used, and when each resets, as Claude Code hands it to a
// status line; and which sessions stopped on a rate limit.
//
// The input, confirmed against the installed Claude Code (2.1.331):
//   status line  { session_id, transcript_path, cwd, model, …, rate_limits?: {
//                  five_hour?: { used_percentage, resets_at }, seven_day?: { … },
//                  spend_limit?: { used_percentage, resets_at, used_usd?, limit_usd?, period? } } }
//                resets_at in Unix seconds. rate_limits only for a subscriber (or behind a
//                gateway with a spend limit), after the first API response; each window only
//                while its reset hasn't passed. No per-model weekly window, and no overage flag.
//   StopFailure  the common hook fields (session_id, transcript_path, cwd, …),
//                hook_event_name "StopFailure", error (authentication_failed, billing_error,
//                rate_limit, overloaded, server_error, unknown, …), error_details?,
//                last_assistant_message?: no reset time of its own.
//
// context-settings.json and inbox-settings.json (session.sh: orchestrators, backlog and
// inbox sessions) run `usage.mjs statusline` as the status line, every 60 s as well as on
// Claude Code's own updates, and `usage.mjs stop-failure` on StopFailure. Both are found
// beside CARETOOK_CONTEXT_HOOK. Neither ever fails: any error is swallowed (exit 0).
//
// One reading per session, written atomically (a temp file renamed in, under a short lock):
//   .loops/.usage/<session>.json  (CARETOOK_USAGE_DIR; else .usage beside CARETOOK_SESSIONS_DIR)
//     session, pid, at, windows: { fiveHour?, sevenDay?, spend? } (each percent, resetsAt
//     ISO or null, at: when it was read, and for spend usedUsd, limitUsd, period),
//     stalled?: { at, error, resetsAt, pid }
//   A window the input leaves out keeps its last value and age; a new pid clears a stall.
//
// The merge (`mergeReadings`, pure): a window read more than CARETOOK_USAGE_STALE_MIN (15)
// ago, or past its reset, doesn't count; with none left the usage is unknown. Of the rest,
// the latest reset is the current window, and within one reset the highest percent wins,
// so an older reading never lowers a newer one. A stall lasts until its reset (one with
// none: STALL_NO_RESET_MS); it takes its reset from the input when that has one, else
// from the last reading (the most used window's).
//
//   node usage.mjs statusline     (stdin) write this session's reading; print a short line
//   node usage.mjs stop-failure   (stdin) on a rate_limit, mark this session stalled
//   node usage.mjs [--json]       pnpm prd usage: the merged reading
//   node usage.mjs status         the line pnpm prd status prints
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { span } from "./asks.mjs";
import { updateRecord } from "./context.mjs";

const MIN_MS = 60_000;
/** Two resets this close are the same window (a reading's rounding). */
const SAME_RESET_MS = MIN_MS;
/** How long a stall with no reset time lasts: the 5-hour window at most. */
export const STALL_NO_RESET_MS = 5 * 60 * MIN_MS;
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The windows: the input's key, the reading's, and the label people read. */
export const WINDOWS = /** @type {const} */ ([
  ["five_hour", "fiveHour", "5h"],
  ["seven_day", "sevenDay", "7d"],
  ["spend_limit", "spend", "spend"],
]);

/** How old a window's reading may be and still count. */
export const staleMsOf = (env = process.env) => {
  const n = Number(env.CARETOOK_USAGE_STALE_MIN);
  return (env.CARETOOK_USAGE_STALE_MIN && Number.isFinite(n) && n > 0 ? n : 15) * MIN_MS;
};

/** A time as ms: Unix seconds, ms (past 1e12), a numeric string or an ISO string; else null. */
export function timeOf(/** @type {unknown} */ v) {
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) v = Number(v);
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? (v > 1e12 ? v : v * 1000) : null;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

const finite = (/** @type {unknown} */ v) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/**
 * One window of the input: percent and reset (ms or null), or null without a percent.
 * @param {any} w @param {string} key
 */
function windowOf(w, key) {
  if (!w || typeof w !== "object") return null;
  const percent = finite(w.used_percentage);
  if (percent === null) return null;
  /** @type {{ percent: number, resetsAt: number | null, usedUsd?: number, limitUsd?: number, period?: string }} */
  const out = { percent: Math.max(0, percent), resetsAt: timeOf(w.resets_at) };
  if (key === "spend_limit") {
    const used = finite(w.used_usd);
    const limit = finite(w.limit_usd);
    if (used !== null) out.usedUsd = used;
    if (limit !== null) out.limitUsd = limit;
    if (typeof w.period === "string") out.period = w.period;
  }
  return out;
}

/**
 * The status line's input, parsed: the windows it has (resets in ms), the session id.
 * Null for anything that isn't a JSON object. Missing or malformed windows are left out. Pure.
 * @param {unknown} input the raw text or the parsed value
 */
export function parseInput(input) {
  let v = input;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = /** @type {any} */ (v);
  /** @type {Record<string, NonNullable<ReturnType<typeof windowOf>>>} */
  const windows = {};
  const rl = o.rate_limits;
  if (rl && typeof rl === "object")
    for (const [key, name] of WINDOWS) {
      const w = windowOf(rl[key], key);
      if (w) windows[name] = w;
    }
  return { sessionId: typeof o.session_id === "string" ? o.session_id : null, windows };
}

const iso = (/** @type {number | null} */ ms) => (ms === null ? null : new Date(ms).toISOString());

/**
 * This session's next reading: the input's windows read now, the others kept as they were;
 * a stall kept only while the pid is the same. Pure.
 * @param {any} current the session's last reading, or null
 * @param {NonNullable<ReturnType<typeof parseInput>>} parsed
 * @param {{ session: string, pid: number | null, now: number }} at
 */
export function nextReading(current, parsed, { session, pid, now }) {
  const windows = { ...(current?.windows && typeof current.windows === "object" ? current.windows : {}) };
  for (const [name, w] of Object.entries(parsed.windows))
    windows[name] = { ...w, resetsAt: iso(w.resetsAt), at: iso(now) };
  /** @type {any} */
  const next = { session, pid, at: iso(now), windows };
  if (current?.stalled && (current.stalled.pid ?? null) === pid) next.stalled = current.stalled;
  return next;
}

/**
 * The reset a stall takes when its input has none: the most used current window's (the one
 * that stopped it), from the readings however old, while it is still ahead. Null without one. Pure.
 * @param {any[]} readings @param {number} now
 */
export function resetFromReadings(readings, now) {
  /** @type {{ percent: number, resetsAt: number } | null} */
  let best = null;
  for (const r of readings)
    for (const [, name] of WINDOWS) {
      const w = r?.windows?.[name];
      const resetsAt = timeOf(w?.resetsAt);
      const percent = finite(w?.percent);
      if (resetsAt === null || percent === null || resetsAt <= now) continue;
      if (!best || percent > best.percent || (percent === best.percent && resetsAt > best.resetsAt))
        best = { percent, resetsAt };
    }
  return best?.resetsAt ?? null;
}

/**
 * A reset time in a StopFailure input, when it carries one: a resets_at field, or an
 * epoch or ISO time in error_details. Only a time ahead counts. Pure.
 * @param {any} input @param {number} now
 */
export function resetFromInput(input, now) {
  const found = [timeOf(input?.resets_at), timeOf(input?.rate_limits?.resets_at)];
  const details = typeof input?.error_details === "string" ? input.error_details : "";
  for (const m of details.matchAll(/\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)/g))
    found.push(timeOf(m[0]));
  for (const m of details.matchAll(/\b\d{10}\b/g)) found.push(timeOf(Number(m[0])));
  return found.find((t) => t !== null && t > now) ?? null;
}

/**
 * The session's reading with a stall marked: a StopFailure on a rate limit, or the
 * dispatcher stopping it (`error` says which). Pure.
 * @param {any} current the session's last reading, or null
 * @param {{ error: string, resetsAt: number | null, session: string, pid: number | null, now: number }} mark
 */
export function stalledReading(current, { error, resetsAt, session, pid, now }) {
  return {
    ...(current && typeof current === "object" ? current : { windows: {} }),
    session,
    stalled: { at: iso(now), error, resetsAt: iso(resetsAt), pid },
  };
}

/** Whether a stall still holds at NOW. Pure. */
export function stallHolds(/** @type {any} */ stalled, /** @type {number} */ now) {
  if (!stalled) return false;
  const reset = timeOf(stalled.resetsAt);
  if (reset !== null) return reset > now;
  const at = timeOf(stalled.at);
  return at !== null && now - at < STALL_NO_RESET_MS;
}

/**
 * The readings merged. Pure.
 * @param {any[]} readings every session's
 * @param {{ now: number, staleMs: number }} opts
 * @returns {{ known: boolean, at: number | null, sessions: number,
 *   fiveHour: Window | null, sevenDay: Window | null, spend: Window | null,
 *   overage: boolean, spendLimit: boolean,
 *   stalled: { session: string, at: number | null, error: string, resetsAt: number | null }[],
 *   resetsAt: number | null }}
 *   known: a current reading of some window; overage: a plan window at 100% or more (extra
 *   usage, if it's on, is being spent); resetsAt: when the binding limit resets (a stall's
 *   latest, else the most used window's)
 * @typedef {{ percent: number, resetsAt: number | null, at: number, usedUsd?: number, limitUsd?: number, period?: string }} Window
 */
export function mergeReadings(readings, { now, staleMs }) {
  /** @type {Record<string, Window | null>} */
  const merged = { fiveHour: null, sevenDay: null, spend: null };
  let newest = null;
  const sessions = new Set();
  for (const [, name] of WINDOWS) {
    /** @type {Window | null} */
    let best = null;
    for (const r of readings) {
      const w = r?.windows?.[name];
      if (!w || typeof w !== "object") continue;
      const at = timeOf(w.at);
      const percent = finite(w.percent);
      const resetsAt = w.resetsAt == null ? null : timeOf(w.resetsAt);
      if (at === null || percent === null || now - at > staleMs || at - now > staleMs) continue;
      if (resetsAt !== null && resetsAt <= now) continue;
      sessions.add(r.session);
      if (newest === null || at > newest) newest = at;
      const cand = { ...w, percent, resetsAt, at };
      if (!best) best = cand;
      else if (
        resetsAt !== null &&
        best.resetsAt !== null &&
        Math.abs(resetsAt - best.resetsAt) <= SAME_RESET_MS
      ) {
        // One window: usage only grows within it, so the higher reading is the later truth.
        if (percent > best.percent || (percent === best.percent && at > best.at))
          best = { ...cand, resetsAt: Math.max(resetsAt, best.resetsAt) };
      } else if ((resetsAt ?? -1) > (best.resetsAt ?? -1)) best = cand;
      else if (resetsAt === null && best.resetsAt === null && at > best.at) best = cand;
    }
    merged[name] = best;
  }
  const stalled = readings
    .filter((r) => stallHolds(r?.stalled, now))
    .map((r) => ({
      session: String(r.session ?? "?"),
      at: timeOf(r.stalled.at),
      error: String(r.stalled.error ?? "rate_limit"),
      resetsAt: timeOf(r.stalled.resetsAt),
    }))
    .sort((a, b) => a.session.localeCompare(b.session));
  const plan = [merged.fiveHour, merged.sevenDay].filter((w) => w !== null);
  const stallReset = stalled.map((s) => s.resetsAt).filter((t) => t !== null);
  const most = [...plan, ...(merged.spend ? [merged.spend] : [])]
    .filter((w) => w.resetsAt !== null)
    .sort((a, b) => b.percent - a.percent || (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0];
  return {
    known: plan.length > 0 || merged.spend !== null,
    at: newest,
    sessions: sessions.size,
    fiveHour: merged.fiveHour,
    sevenDay: merged.sevenDay,
    spend: merged.spend,
    overage: plan.some((w) => w.percent >= 100),
    spendLimit: merged.spend !== null,
    stalled,
    resetsAt: stallReset.length ? Math.max(...stallReset) : (most?.resetsAt ?? null),
  };
}

// ---- formatting

/** "14:05", or "Fri 09:00" when not on NOW's day, in TIMEZONE (default: local). */
export function clock(
  /** @type {number} */ ms,
  /** @type {number} */ now,
  /** @type {string | undefined} */ timeZone,
) {
  const opts = /** @type {const} */ ({ timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const time = new Intl.DateTimeFormat("en-GB", opts).format(ms);
  const day = (/** @type {number} */ t) =>
    new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "short" }).format(t);
  if (day(ms) === day(now)) return time;
  return `${new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short" }).format(ms)} ${time}`;
}

/** "resets 14:05, in 2h" or "reset unknown". */
const resetNote = (
  /** @type {number | null} */ ms,
  /** @type {number} */ now,
  /** @type {string | undefined} */ tz,
) => (ms === null ? "reset unknown" : `resets ${clock(ms, now, tz)}, in ${span(ms - now)}`);

const pct = (/** @type {number} */ p) => `${Math.round(p)}%`;

/** The stalled sessions in a phrase, or "". */
function stalledNote(
  /** @type {ReturnType<typeof mergeReadings>} */ u,
  /** @type {number} */ now,
  /** @type {string | undefined} */ tz,
) {
  if (!u.stalled.length) return "";
  const names = u.stalled.map((s) => s.session).join(", ");
  const reset = u.stalled.map((s) => s.resetsAt).filter((t) => t !== null);
  const when = reset.length ? `, ${resetNote(Math.max(...reset), now, tz)}` : "";
  return `stopped on a limit: ${names}${when}`;
}

/**
 * `pnpm prd status`'s line: each window's use and reset, or unknown. Pure.
 * @param {ReturnType<typeof mergeReadings>} u
 * @param {{ now: number, staleMs: number, timeZone?: string }} opts
 */
export function statusLine(u, { now, staleMs, timeZone }) {
  const parts = [];
  if (!u.known) parts.push(`unknown (no reading in the last ${span(staleMs)})`);
  for (const [, name, label] of WINDOWS) {
    const w = u[/** @type {"fiveHour" | "sevenDay" | "spend"} */ (name)];
    if (w) parts.push(`${label} ${pct(w.percent)} (${resetNote(w.resetsAt, now, timeZone)})`);
  }
  if (u.known && u.at !== null) parts.push(`read ${span(now - u.at)} ago`);
  let line = `USAGE: ${parts.join(" · ")}`;
  if (u.overage) line += "; over the plan limit (extra usage)";
  const stalled = stalledNote(u, now, timeZone);
  if (stalled) line += `; ${stalled}`;
  return `${line} (pnpm prd usage)`;
}

/**
 * `pnpm prd usage`: the merged reading in lines. Pure.
 * @param {ReturnType<typeof mergeReadings>} u
 * @param {{ now: number, staleMs: number, timeZone?: string }} opts
 */
export function report(u, { now, staleMs, timeZone }) {
  const lines = [];
  if (!u.known)
    lines.push(
      `Usage: unknown: no current reading (none in the last ${span(staleMs)}; a status line writes one per session)`,
    );
  else
    lines.push(
      `Usage, read ${u.at === null ? "?" : `${span(now - u.at)} ago`} from ${u.sessions} session${u.sessions === 1 ? "" : "s"}:`,
    );
  const labels = { fiveHour: "5-hour", sevenDay: "weekly", spend: "spend limit" };
  for (const [, name] of WINDOWS) {
    const w = u[/** @type {"fiveHour" | "sevenDay" | "spend"} */ (name)];
    if (!w) continue;
    const usd =
      w.usedUsd !== undefined && w.limitUsd !== undefined
        ? ` ($${w.usedUsd.toFixed(2)} of $${w.limitUsd.toFixed(2)}${w.period ? `, ${w.period}` : ""})`
        : "";
    lines.push(
      `  ${labels[/** @type {keyof typeof labels} */ (name)].padEnd(11)} ${pct(w.percent).padStart(4)}${usd}  ${resetNote(w.resetsAt, now, timeZone)}`,
    );
  }
  if (u.overage) lines.push("Over the plan limit: anything more is extra usage, if it's on.");
  for (const s of u.stalled)
    lines.push(
      `Stopped on a limit: ${s.session}${s.at === null ? "" : ` ${span(now - s.at)} ago`} (${s.error}), ${resetNote(s.resetsAt, now, timeZone)}`,
    );
  if (u.spendLimit)
    lines.push(
      "A spend limit is set: only turning extra usage off in the account fully guarantees nothing is spent past the plan.",
    );
  return `${lines.join("\n")}\n`;
}

/** The status line's own text: this input's windows, or "". Pure. */
export function ownLine(/** @type {NonNullable<ReturnType<typeof parseInput>>} */ parsed) {
  return WINDOWS.flatMap(([, name, label]) => {
    const w = parsed.windows[name];
    return w ? [`${label} ${pct(w.percent)}`] : [];
  }).join(" · ");
}

// ---- the store

/** The readings folder. */
export function usageDirOf(env = process.env) {
  if (env.CARETOOK_USAGE_DIR) return env.CARETOOK_USAGE_DIR;
  if (env.CARETOOK_SESSIONS_DIR) return join(dirname(env.CARETOOK_SESSIONS_DIR), ".usage");
  return null;
}

/** Every session's reading; unreadable files are left out. */
export function readReadings(/** @type {string} */ dir) {
  /** @type {any[]} */
  const out = [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (r && typeof r === "object") out.push({ ...r, session: r.session ?? f.slice(0, -5) });
    } catch {
      /* half-gone or not ours: skip it */
    }
  }
  return out;
}

/** The merged reading from DIR. */
export function readUsage(/** @type {string | null} */ dir, { now = Date.now(), env = process.env } = {}) {
  return mergeReadings(dir ? readReadings(dir) : [], { now, staleMs: staleMsOf(env) });
}

/**
 * Mark SESSION stalled (the dispatcher's stop, or a StopFailure). RESETS_AT null takes the
 * last reading's. Throws on a bad name or an unwritable folder.
 * @param {string} dir @param {string} session
 * @param {{ error?: string, resetsAt?: number | null, pid?: number | null, now?: number }} [opts]
 */
export function markStalled(
  dir,
  session,
  { error = "rate_limit", resetsAt = null, pid = null, now = Date.now() } = {},
) {
  if (!NAME_OK.test(session)) throw new Error(`usage: a bad session name ${session}`);
  const reset = resetsAt ?? resetFromReadings(readReadings(dir), now);
  return updateRecord(join(dir, `${session}.json`), (current) =>
    stalledReading(current, { error, resetsAt: reset, session, pid, now }),
  );
}

/** Clear SESSION's stall (a resume). */
export function clearStalled(/** @type {string} */ dir, /** @type {string} */ session) {
  if (!NAME_OK.test(session)) throw new Error(`usage: a bad session name ${session}`);
  return updateRecord(join(dir, `${session}.json`), (current) => {
    const { stalled: _, ...rest } =
      current && typeof current === "object" ? current : { session, windows: {} };
    return rest;
  });
}

/** The session this hook runs for: session.sh's name, else Claude Code's id. */
const sessionOf = (/** @type {NodeJS.ProcessEnv} */ env, /** @type {string | null} */ id) => {
  const name = env.CARETOOK_SESSION_NAME || id || "";
  return NAME_OK.test(name) ? name : null;
};
const pidOf = (/** @type {NodeJS.ProcessEnv} */ env) => {
  const n = Number(env.CARETOOK_SESSION_PID);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * The status line: write this session's reading, return its text. Throws on anything
 * unwritable (the caller swallows it); bad input writes nothing.
 * @param {string} raw @param {NodeJS.ProcessEnv} env @param {number} now
 */
export function runStatusLine(raw, env = process.env, now = Date.now()) {
  const parsed = parseInput(raw);
  if (!parsed) return "";
  const dir = usageDirOf(env);
  const session = sessionOf(env, parsed.sessionId);
  if (dir && session) {
    const pid = pidOf(env);
    updateRecord(join(dir, `${session}.json`), (current) =>
      nextReading(current, parsed, { session, pid, now }),
    );
  }
  return ownLine(parsed);
}

/**
 * The StopFailure hook: on a rate limit, mark this session stalled. Returns whether it marked.
 * @param {string} raw @param {NodeJS.ProcessEnv} env @param {number} now
 */
export function runStopFailure(raw, env = process.env, now = Date.now()) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return false;
  }
  if (input?.error !== "rate_limit") return false;
  const dir = usageDirOf(env);
  const session = sessionOf(env, typeof input.session_id === "string" ? input.session_id : null);
  if (!dir || !session) return false;
  markStalled(dir, session, {
    error: "rate_limit",
    resetsAt: resetFromInput(input, now),
    pid: pidOf(env),
    now,
  });
  return true;
}

const readStdin = () => {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd = "", ...rest] = process.argv.slice(2);
  const now = Date.now();
  if (cmd === "statusline" || cmd === "stop-failure") {
    // A status line or hook: never fails, never says anything a session depends on.
    try {
      const raw = readStdin();
      if (cmd === "statusline") {
        const line = runStatusLine(raw, process.env, now);
        if (line) process.stdout.write(`${line}\n`);
      } else runStopFailure(raw, process.env, now);
    } catch {
      /* watching never hurts the work */
    }
    process.exit(0);
  }
  const staleMs = staleMsOf();
  const u = readUsage(usageDirOf(), { now });
  if (cmd === "status") process.stdout.write(`${statusLine(u, { now, staleMs })}\n`);
  else if (cmd === "--json" || rest.includes("--json"))
    process.stdout.write(`${JSON.stringify(u, null, 2)}\n`);
  else if (cmd === "") process.stdout.write(report(u, { now, staleMs }));
  else {
    console.error(
      "usage: pnpm prd usage [--json]   (usage.mjs statusline|stop-failure|status: the hooks' and status's)",
    );
    process.exit(2);
  }
}
