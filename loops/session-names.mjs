// A session's name for the outside (RISA-799, RISA-914): the Remote Control
// name, claude's --name and the main backlog's tab title, which session.sh, the
// one place that qualifies names, asks this module for; and the label a pushed
// question leads with (ask.mjs).
//
// The display name is `<name> (<project>)`, led by `<Abbr> <Name> · ` when the
// session has a persona (RISA-1039: `Adm Morrow · backlog (caretook)`, the rank's
// short form from the flavor pack): the main backlog shows `backlog (<project>)`
// and its given admiral; a `backlog - <name>` request session gets no persona;
// any other role's comes from the flavor module on its record name. A name
// already qualified is kept, in either order: the old one,
// `<name> (<project>) · <Rank> <Name>`, still reads back (readDisplayName). The
// record keeps the bare name the caller gave.
//
// CLI (the machine's flavor, from the machine config; one that doesn't load reads
// as the default):
//   node session-names.mjs display <name> <kind> <remote> <project>
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CAPTAIN_SESSION, machineFlavor } from "./captain.mjs";
import {
  DEFAULT_FLAVOR,
  ROLES,
  label,
  personaFor,
  personaOfLabel,
  sessionPersona,
  shortLabel,
} from "./flavor.mjs";

/** Whether NAME, KIND is the main backlog session (its record name and kind). */
const isMainBacklog = (/** @type {string} */ name, /** @type {string} */ kind) =>
  name === CAPTAIN_SESSION && kind === "backlog";

/**
 * A display name read back, in either order (`Adm Morrow · backlog (caretook)`, or
 * the old `backlog (caretook) · Admiral Morrow`): the bare name, the project, and
 * the persona (null without one, or a label FLAVOR doesn't know); null for a name
 * that isn't qualified.
 * @param {string} display
 * @returns {{ name: string, project: string, persona: import("./flavor.mjs").Persona | null } | null}
 */
export function readDisplayName(display, flavor = DEFAULT_FLAVOR) {
  const old = /^(.+) \(([^()]+)\) · (.+)$/.exec(display);
  if (old) return { name: old[1], project: old[2], persona: personaOfLabel(old[3], flavor) };
  const m = /^(?:(.+?) · )?(.+) \(([^()]+)\)$/.exec(display);
  if (!m) return null;
  return { name: m[2], project: m[3], persona: m[1] ? personaOfLabel(m[1], flavor) : null };
}

/**
 * The persona of the session NAME of KIND, whose Remote Control name is REMOTE:
 * the main backlog's given admiral (one word of letters, worn with the backlog
 * pool's rank, or the persona a qualified REMOTE carries), none for any other
 * backlog session, else the role's hashed one.
 * @param {{ name: string, kind: string, remote?: string | null }} session
 * @returns {import("./flavor.mjs").Persona | null}
 */
export function personaOf({ name, kind, remote }, flavor = DEFAULT_FLAVOR) {
  if (kind === "backlog") {
    if (!isMainBacklog(name, kind) || !remote || remote === CAPTAIN_SESSION) return null;
    const read = readDisplayName(remote, flavor);
    if (read) return read.persona;
    return sessionPersona("backlog", remote, flavor);
  }
  return ROLES.includes(kind) ? personaFor(kind, name, flavor) : null;
}

/** The session's label (`Captain Sisko`), or "". @param {Parameters<typeof personaOf>[0]} session */
export const sessionLabel = (session, flavor = DEFAULT_FLAVOR) => label(personaOf(session, flavor));

/**
 * The display name for the session NAME of KIND given the Remote Control name
 * REMOTE, in PROJECT: REMOTE itself when it is already qualified.
 * @param {{ name: string, kind: string, remote: string, project: string }} session
 */
export function displayName({ name, kind, remote, project }, flavor = DEFAULT_FLAVOR) {
  const tag = ` (${project})`;
  // The new order ends with the project; the old one carries it before ` · `.
  if (remote.endsWith(tag) || remote.includes(`${tag} · `)) return remote;
  const base = isMainBacklog(name, kind) ? CAPTAIN_SESSION : remote;
  const lab = shortLabel(personaOf({ name, kind, remote }, flavor), flavor);
  return `${lab ? `${lab} · ` : ""}${base}${tag}`;
}

const isMain = () => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  const [verb, name, kind, remote, project] = process.argv.slice(2);
  if (verb !== "display" || !name || !kind || !remote || !project) {
    console.error("usage: session-names.mjs display <name> <kind> <remote> <project>");
    process.exit(2);
  }
  console.log(displayName({ name, kind, remote, project }, machineFlavor()));
}
