// A session's name for the outside (RISA-799, RISA-914): the Remote Control
// name, claude's --name and the main backlog's tab title, which session.sh, the
// one place that qualifies names, asks this module for; and the label a pushed
// question leads with (ask.mjs).
//
// The display name is `<name> (<project>)`, then ` · <Rank> <Name>` when the
// session has a persona: the main backlog shows `backlog (<project>)` and its
// given admiral; a `backlog - <name>` request session gets no persona; any
// other role's comes from the flavor module on its record name. A name already
// qualified is kept. The record keeps the bare name the caller gave.
//
// CLI (the machine's flavor, from the machine config; one that doesn't load reads
// as the default):
//   node session-names.mjs display <name> <kind> <remote> <project>
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CAPTAIN_SESSION, machineFlavor } from "./captain.mjs";
import { DEFAULT_FLAVOR, ROLES, label, personaFor, poolOf } from "./flavor.mjs";

/** Whether NAME, KIND is the main backlog session (its record name and kind). */
const isMainBacklog = (/** @type {string} */ name, /** @type {string} */ kind) =>
  name === CAPTAIN_SESSION && kind === "backlog";

/**
 * The persona of the session NAME of KIND, whose Remote Control name is REMOTE:
 * the main backlog's given admiral (the backlog pool's rank, whatever name it was
 * given), none for any other backlog session, else the role's hashed one.
 * @param {{ name: string, kind: string, remote?: string | null }} session
 * @returns {import("./flavor.mjs").Persona | null}
 */
export function personaOf({ name, kind, remote }, flavor = DEFAULT_FLAVOR) {
  if (kind === "backlog") {
    // As flavor.mjs's sessionPersona (slice 3) reads it: one word of letters, not `backlog`.
    if (!isMainBacklog(name, kind) || !remote || remote === CAPTAIN_SESSION) return null;
    const rank = poolOf("backlog", flavor)[0]?.rank;
    return rank && /^[A-Za-z]+$/.test(remote) ? { rank, name: remote } : null;
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
  if (remote.endsWith(tag) || remote.includes(`${tag} · `)) return remote;
  const base = isMainBacklog(name, kind) ? CAPTAIN_SESSION : remote;
  const lab = sessionLabel({ name, kind, remote }, flavor);
  return `${base}${tag}${lab ? ` · ${lab}` : ""}`;
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
