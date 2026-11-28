// The dispatcher's keep-alive: one session of each kept kind (`backlog`, `inbox`)
// stays open, outside the PRD slots. Pure: the facts in, one decision per kind
// out; dispatch.mjs gathers and acts.
//
// A kind with a reason in `unready` isn't opened: the inbox session's bare
// directory before Claude Code has been told once, by hand, to trust it (its
// "trust this folder?" prompt defaults to "No, exit", so an unattended open
// would stop there). dispatch.mjs reads that from Claude Code's own files,
// never writing them.
//
// A kind is live with a live record under its name, a record `rotating` within
// ROTATING_GRACE_MS, or a claude process with `--remote-control <kind>` (a
// session opened by hand that has no record, or lost it to a newer one; for
// backlog also a captain's name, captain.mjs, the main session's display name). An
// unreadable process list counts as live: two sessions under one Remote Control
// name would fight over the main checkout.
//
// A session that dies within QUICK_DEATH_MS of being opened is a quick death.
// The third gets a question ("open again" or "stop keeping it alive") with its
// own marker (KEEP_SESSION) and state entry, so it is never read as a reopen
// question. "Stop" holds until the dispatcher next starts.
import { CAPTAINS, CAPTAIN_SESSION } from "./captain.mjs";
import { ROTATING_GRACE_MS } from "./dispatch-pick.mjs";
import { runs } from "./sessions.mjs";
import { CLAUDE } from "./host.mjs";

/**
 * The two-letter machine tag v0.1.3 and v0.1.4 put before a backlog or inbox Remote Control name
 * (`NA-inbox`). Nothing adds it now; the matchers still accept it so a session named then is kept
 * alive and found until it rotates. Drop it once no machine runs those releases.
 */
export const MACHINE_TAG = "[A-Z]{2}-";

/** The kinds kept alive; each one's session is named after it. */
export const KEPT_KINDS = ["backlog", "inbox"];
/** The answers the keep-alive question offers. */
export const KEEP_OPTIONS = ["open again", "stop keeping it alive"];
/** This many quick deaths in a row get the question instead of another open. */
export const MAX_QUICK_DEATHS = 3;
/** A session that dies this soon after opening died quickly; one that outlives it resets the count. */
export const QUICK_DEATH_MS = 30 * 60_000;
/** A tab just opened has this long to start before it counts as dead. */
export const START_GRACE_MS = 2 * 60_000;

/**
 * @typedef {{ deaths?: number, openedAt?: number, asked?: { id: string }, stopped?: boolean }} KeepEntry
 * @typedef {Record<string, KeepEntry>} KeepState
 * @typedef {{ name: string, live: boolean, rotating?: boolean, rotatingAt?: number | string | null }} KeepSession
 * @typedef {{ kind: string, action: "open" | "ask" | "none", why: string, deaths?: number,
 *   reset?: boolean, text?: string, options?: string[] }} KeepDecision
 */

const asTime = (/** @type {number | string | null | undefined} */ t) =>
  typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : NaN;

/**
 * Whether a ps command line is a claude process under exactly this Remote
 * Control name (`backlog`, not `backlog-x` or `backlog - x`). A prompt that only
 * quotes the flag in backticks doesn't match.
 */
export function hasRemoteControl(
  /** @type {string} */ args,
  /** @type {string} */ name,
  /** @type {string} */ claude = CLAUDE,
) {
  if (!runs(args, claude)) return false;
  const word = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)--remote-control[ =](?:${MACHINE_TAG})?${word}(?=\\s|$)(?!\\s+-\\s)`).test(
    args,
  );
}

/** The Remote Control names a kept kind's session may run under: its own, and for backlog each captain's. */
export const remoteNamesOf = (/** @type {string} */ kind) =>
  kind === CAPTAIN_SESSION ? [kind, ...CAPTAINS] : [kind];

/** What the keep-alive question's answer means: "open", "stop", or null (unclear). */
export function keepAnswerAction(/** @type {string | null | undefined} */ answer) {
  const a = String(answer ?? "")
    .trim()
    .toLowerCase();
  if (a === KEEP_OPTIONS[0] || /^(1|open|again|yes)\b/.test(a)) return "open";
  if (a === KEEP_OPTIONS[1] || /^(2|stop)\b/.test(a)) return "stop";
  return null;
}

/** The state with every "stop keeping it alive" dropped: a dispatcher start begins again. */
export function clearKeepStops(/** @type {KeepState | undefined} */ keep) {
  /** @type {KeepState} */
  const next = {};
  for (const [kind, entry] of Object.entries(keep ?? {})) if (!entry.stopped) next[kind] = entry;
  return next;
}

/**
 * One decision per kept kind.
 * @param {{ kinds?: string[], sessions?: KeepSession[], processes?: string[] | null, keep?: KeepState,
 *   paused?: boolean, off?: boolean, now: number, claude?: string, unready?: Record<string, string> }} facts
 * @returns {KeepDecision[]}
 */
export function keepAliveDecision({
  kinds = KEPT_KINDS,
  sessions = [],
  processes = null,
  keep = {},
  paused = false,
  off = false,
  now,
  claude = CLAUDE,
  unready = {},
}) {
  return kinds.map((kind) => {
    const none = (/** @type {string} */ why, reset = false) => ({
      kind,
      action: /** @type {const} */ ("none"),
      why,
      ...(reset ? { reset } : {}),
    });
    if (off) return none("RISA_KEEP_SESSIONS is off");
    if (paused) return none("the dispatcher is paused");
    const e = keep[kind] ?? {};
    if (e.stopped) return none("stopped until the dispatcher next starts");

    // A session that has outlived the quick window clears the count.
    const recovered = (e.deaths ?? 0) > 0 && !e.asked && now - (e.openedAt ?? now) >= QUICK_DEATH_MS;
    const s = sessions.find((x) => x.name === kind);
    if (s?.live) return none("live", recovered);
    if (s?.rotating) {
      const at = asTime(s.rotatingAt);
      if (Number.isNaN(at) || now - at < ROTATING_GRACE_MS) return none("being rotated");
    }
    if (processes === null) return none("the process list can't be read");
    if (processes.some((args) => remoteNamesOf(kind).some((n) => hasRemoteControl(args, n, claude))))
      return none("live, opened by hand", recovered);

    if (e.asked) return none(`waits on ask ${e.asked.id}`);
    if (unready[kind]) return none(unready[kind]);
    const sinceOpen = e.openedAt === undefined ? Infinity : now - e.openedAt;
    if ((e.deaths ?? 0) < MAX_QUICK_DEATHS && sinceOpen < START_GRACE_MS) return none("just opened");

    const deaths =
      (e.deaths ?? 0) >= MAX_QUICK_DEATHS ? e.deaths : sinceOpen < QUICK_DEATH_MS ? (e.deaths ?? 0) + 1 : 0;
    if (/** @type {number} */ (deaths) >= MAX_QUICK_DEATHS)
      return {
        kind,
        action: /** @type {const} */ ("ask"),
        why: `${kind} died ${MAX_QUICK_DEATHS} times soon after opening`,
        deaths,
        text: `The ${kind} session died ${MAX_QUICK_DEATHS} times within ${QUICK_DEATH_MS / 60_000} minutes of opening. Open it again, or stop keeping it alive until the dispatcher next starts?`,
        options: KEEP_OPTIONS,
      };
    return {
      kind,
      action: /** @type {const} */ ("open"),
      why: deaths
        ? `${kind} died soon after opening (${deaths} of ${MAX_QUICK_DEATHS})`
        : `no live ${kind} session`,
      deaths,
    };
  });
}
