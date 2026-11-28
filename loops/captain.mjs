// A name for the main backlog session (B-733): its display name, the
// Remote Control name and the tab title, drawn at random for each
// new session (a start, a rotation or hand-off, a keep-alive reopen), never the
// same as the last one. Display name only: the session record stays
// `backlog`, so every lookup by name still finds it; the record's `remote`
// field (session.sh writes it at start) is the last captain the next draw reads.
// `backlog-<name>` request sessions, inbox and every other role keep their names.
// The pool is the flavor pack's backlog pool (flavor.mjs, RISA-914): admirals
// under starfleet, the bare `backlog` under none. CAPTAINS, the pool before the
// packs, stays for the matchers that recognise sessions named before them.
//
// CLI: node captain.mjs next   a new captain for the main backlog session,
//                              unlike its record's remote (RISA_SESSIONS_DIR)
import { pathToFileURL } from "node:url";
import { DEFAULT_FLAVOR, drawAdmiral, flavorOf, namesOf } from "./flavor.mjs";
import { loadMachineConfig } from "./machine.mjs";
import { defaultDir, readRecord } from "./sessions.mjs";

/** The pool before the flavor packs, in no order that matters. */
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

/** The machine's flavor; a machine config that doesn't load reads as the default. */
export function machineFlavor() {
  try {
    return flavorOf(loadMachineConfig());
  } catch {
    return DEFAULT_FLAVOR;
  }
}

/** Whether NAME is one the main backlog session has gone by: an admiral, or a captain from before the packs. */
export const isCaptain = (/** @type {unknown} */ name) =>
  typeof name === "string" && (CAPTAINS.includes(name) || namesOf("backlog").includes(name));

/**
 * A name from FLAVOR's backlog pool, never LAST (drawAdmiral): an admiral, or
 * `backlog` under none. RANDOM is a source of numbers in [0, 1) (Math.random;
 * tests pass a fixed one, so the choice is deterministic).
 */
export function pickCaptain(
  /** @type {string | null | undefined} */ last,
  /** @type {() => number} */ random = Math.random,
  flavor = machineFlavor(),
) {
  return drawAdmiral(last, random, flavor);
}

/** The main backlog session's last name: its record's Remote Control name, when that is one it has gone by. */
export function lastCaptain(/** @type {string} */ sessions) {
  const remote = readRecord(sessions, CAPTAIN_SESSION)?.remote;
  return isCaptain(remote) ? /** @type {string} */ (remote) : null;
}

/** A new captain for the main backlog session, unlike the one its record holds. */
export function nextCaptain(/** @type {string} */ sessions, random = Math.random, flavor = machineFlavor()) {
  return pickCaptain(lastCaptain(sessions), random, flavor);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd] = process.argv.slice(2);
  if (cmd !== "next") {
    console.error("usage: captain.mjs next");
    process.exit(2);
  }
  console.log(nextCaptain(process.env.RISA_SESSIONS_DIR || defaultDir()));
}
