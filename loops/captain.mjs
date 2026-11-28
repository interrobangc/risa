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
// Names held on the machine (RISA-1063): a draw skips the names every other live
// session on the machine wears (machineHeld: the live records of each repo the
// machine config lists), so two projects' sessions don't share one. The admiral
// comes from the pool minus those; any other role's persona (machinePersona) starts
// at its hash and steps to the next free entry, keeping a stepped one in its own
// record's `persona` so it stays while the session that held its hashed one ends.
// With every name held, the draw is today's. No machine config: nothing is held.
//
// CLI: node captain.mjs next   a new captain for the main backlog session,
//                              unlike its record's remote (RISA_SESSIONS_DIR)
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_FLAVOR,
  ROLES,
  drawAdmiral,
  flavorOf,
  namesOf,
  personaFor,
  poolOf,
  sessionPersona,
} from "./flavor.mjs";
import { loadMachineConfig } from "./machine.mjs";
import { defaultDir, isLive, processOf, readRecord, readRecords, writeRecord } from "./sessions.mjs";

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

/** The machine config, or null when there is none or it doesn't load. */
function machineOrNull() {
  try {
    return loadMachineConfig();
  } catch {
    return null;
  }
}

/** A path with its symlinks resolved, when it exists. @param {string} p */
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** Whether RECORD's session is running (sessions.mjs's isLive on its pid's process). */
const recordLive = (/** @type {import("./sessions.mjs").SessionRecord} */ record) =>
  !!record?.pid && !record.ended && isLive(record, processOf(record.pid));

/**
 * The name the session NAME, whose record is RECORD, wears: its kept `persona`, the
 * main backlog's admiral (its Remote Control name), none for another backlog session,
 * else its role's hashed one; null for none.
 * @param {string} name @param {import("./sessions.mjs").SessionRecord} record
 */
export function wornBy(name, record, flavor = DEFAULT_FLAVOR) {
  if (typeof record?.persona === "string" && record.persona) return record.persona;
  const kind = record?.kind ?? "";
  if (kind === "backlog")
    return name === CAPTAIN_SESSION && isCaptain(record.remote)
      ? /** @type {string} */ (record.remote)
      : null;
  return ROLES.includes(kind) ? (personaFor(kind, name, flavor)?.name ?? null) : null;
}

/**
 * The names the live sessions of every repo the machine config lists wear
 * (wornBy), but SELF's (its records' folder and name). No machine config: none.
 * @param {{ machine?: import("./machine.mjs").Machine | null,
 *   self?: { dir: string, name: string } | null,
 *   live?: (record: import("./sessions.mjs").SessionRecord) => boolean, flavor?: string }} [facts]
 *   MACHINE (default: the machine config's), LIVE (default: the record's pid is its process)
 * @returns {string[]}
 */
export function machineHeld({ machine = machineOrNull(), self = null, live = recordLive, flavor } = {}) {
  if (!machine) return [];
  const mine = self ? real(self.dir) : null;
  const held = new Set();
  const seen = new Set();
  for (const repo of machine.repos) {
    const dir = join(repo.path, ".loops", ".sessions");
    const at = real(dir);
    if (seen.has(at)) continue;
    seen.add(at);
    for (const { name, record } of readRecords(dir)) {
      if (at === mine && name === self?.name) continue;
      if (!record?.pid || record.ended || !live(record)) continue;
      const worn = wornBy(name, record, flavor ?? machineFlavor());
      if (worn) held.add(worn);
    }
  }
  return [...held];
}

/** The calling session's records' folder (RISA_SESSIONS_DIR, else RISA_MAIN's), or null. */
const ownSessions = () =>
  process.env.RISA_SESSIONS_DIR ||
  (process.env.RISA_MAIN ? join(process.env.RISA_MAIN, ".loops", ".sessions") : null);

/**
 * The persona of the ROLE session NAME on this machine: the backlog's is its given
 * admiral (sessionPersona); any other role's is the one its record keeps while no
 * other live session holds it, else the hashed one stepped past the names held
 * (machineHeld). A stepped persona is kept in the session's own record (when it has
 * one), so it stays the same for the session's life; one back on the hash clears it.
 * @param {string} role @param {string} name
 * @param {{ sessions?: string | null, machine?: import("./machine.mjs").Machine | null,
 *   live?: (record: import("./sessions.mjs").SessionRecord) => boolean }} [facts]
 *   SESSIONS, this session's records' folder (default: RISA_SESSIONS_DIR, else RISA_MAIN's)
 * @returns {import("./flavor.mjs").Persona | null}
 */
export function machinePersona(role, name, flavor = machineFlavor(), facts = {}) {
  if (role === "backlog") return sessionPersona(role, name, flavor);
  const sessions = facts.sessions === undefined ? ownSessions() : facts.sessions;
  const held = machineHeld({
    machine: facts.machine === undefined ? machineOrNull() : facts.machine,
    self: sessions ? { dir: sessions, name } : null,
    ...(facts.live ? { live: facts.live } : {}),
    flavor,
  });
  if (!held.length && !sessions) return personaFor(role, name, flavor);
  /** @type {import("./sessions.mjs").SessionRecord | null} */
  let record;
  try {
    record = sessions ? readRecord(sessions, name) : null;
  } catch {
    record = null; // Not a session name readRecord takes.
  }
  const kept = typeof record?.persona === "string" ? record.persona : null;
  const entry = kept && !held.includes(kept) ? poolOf(role, flavor).find((q) => q.name === kept) : null;
  const p = entry ? { rank: entry.rank, name: entry.name } : personaFor(role, name, flavor, held);
  if (!p) return null;
  const keep = p.name === personaFor(role, name, flavor)?.name ? undefined : p.name;
  if (record && sessions && keep !== (kept ?? undefined)) {
    try {
      writeRecord(sessions, name, { persona: keep });
    } catch {
      // A folder it can't write: the persona still stands for this call.
    }
  }
  return p;
}

/**
 * A name from FLAVOR's backlog pool, never LAST, nor one of HELD while one is free
 * (drawAdmiral): an admiral, or `backlog` under none. RANDOM is a source of numbers
 * in [0, 1) (Math.random; tests pass a fixed one, so the choice is deterministic).
 */
export function pickCaptain(
  /** @type {string | null | undefined} */ last,
  /** @type {() => number} */ random = Math.random,
  flavor = machineFlavor(),
  /** @type {Iterable<string>} */ held = [],
) {
  return drawAdmiral(last, random, flavor, held);
}

/** The main backlog session's last name: its record's Remote Control name, when that is one it has gone by. */
export function lastCaptain(/** @type {string} */ sessions) {
  const remote = readRecord(sessions, CAPTAIN_SESSION)?.remote;
  return isCaptain(remote) ? /** @type {string} */ (remote) : null;
}

/**
 * A new captain for the main backlog session, unlike the one its record holds and
 * the ones other live sessions on the machine wear (machineHeld).
 */
export function nextCaptain(/** @type {string} */ sessions, random = Math.random, flavor = machineFlavor()) {
  const held = machineHeld({ self: { dir: sessions, name: CAPTAIN_SESSION }, flavor });
  return pickCaptain(lastCaptain(sessions), random, flavor, held);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd] = process.argv.slice(2);
  if (cmd !== "next") {
    console.error("usage: captain.mjs next");
    process.exit(2);
  }
  console.log(nextCaptain(process.env.RISA_SESSIONS_DIR || defaultDir()));
}
