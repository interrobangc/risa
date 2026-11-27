// A captain's name for the main backlog session (B-733): its display name, the
// Remote Control name and the tab title, drawn at random from CAPTAINS for each
// new session (a start, a rotation or hand-off, a keep-alive reopen), never the
// same as the last one. Display name only: the session record stays
// `backlog`, so every lookup by name still finds it; the record's `remote`
// field (session.sh writes it at start) is the last captain the next draw reads.
// `backlog-<name>` request sessions, inbox and every other role keep their names.
//
// CLI: node captain.mjs next   a new captain for the main backlog session,
//                              unlike its record's remote (RISA_SESSIONS_DIR)
import { pathToFileURL } from "node:url";
import { defaultDir, readRecord } from "./sessions.mjs";

/** The pool, in no order that matters. */
export const CAPTAINS = Object.freeze([
  "Archer",
  "April",
  "Pike",
  "Kirk",
  "Decker",
  "Harriman",
  "Garrett",
  "Picard",
  "Shelby",
  "Riker",
]);

/** The one session that gets a captain: the main backlog session's record name. */
export const CAPTAIN_SESSION = "backlog";

/** Whether NAME is one of the captains. */
export const isCaptain = (/** @type {unknown} */ name) => typeof name === "string" && CAPTAINS.includes(name);

/**
 * A captain from the pool, never LAST. RANDOM is a source of numbers in [0, 1)
 * (Math.random; tests pass a fixed one, so the choice is deterministic).
 */
export function pickCaptain(
  /** @type {string | null | undefined} */ last,
  /** @type {() => number} */ random = Math.random,
) {
  const pool = CAPTAINS.filter((c) => c !== last);
  const i = Math.floor(random() * pool.length);
  return pool[Math.min(Math.max(i, 0), pool.length - 1)];
}

/** The main backlog session's last captain: its record's Remote Control name, when that is a captain. */
export function lastCaptain(/** @type {string} */ sessions) {
  const remote = readRecord(sessions, CAPTAIN_SESSION)?.remote;
  return isCaptain(remote) ? /** @type {string} */ (remote) : null;
}

/** A new captain for the main backlog session, unlike the one its record holds. */
export function nextCaptain(/** @type {string} */ sessions, random = Math.random) {
  return pickCaptain(lastCaptain(sessions), random);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd] = process.argv.slice(2);
  if (cmd !== "next") {
    console.error("usage: captain.mjs next");
    process.exit(2);
  }
  console.log(nextCaptain(process.env.RISA_SESSIONS_DIR || defaultDir()));
}
