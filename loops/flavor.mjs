// The flavor packs (RISA-914): per role a rank and a pool of canon single-word
// names, and how to address the user. The only code that knows the packs; every
// other file asks it. `starfleet` is the default; `none` is the empty pack (no
// persona, no line). The machine config's `flavor` picks one for the machine
// (machine.mjs validates it against FLAVORS).
//
// The flavor lives only in replies to the user and in labels: a persona's line
// keeps it out of questions, options, commands, commits, files and whatever an
// agent reads, and the session record keeps its bare name.
//
// CLI (the machine's flavor, from the machine config; a config that doesn't load
// reads as the default):
//   node flavor.mjs persona <role> <name>   `<rank>\t<name>`; nothing under none
//   node flavor.mjs label <role> <name>     `<Rank> <Name>`; nothing under none
//   node flavor.mjs line <role> <name>      the prompt's flavor line; nothing under none
// Each takes the session's persona (sessionPersona): for the backlog role, <name> is
// its drawn admiral (RISA_CAPTAIN), not a session name to hash.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The roles a pack names. */
export const ROLES = Object.freeze(["backlog", "prd", "slice", "inbox", "hotfix", "plan", "recovery"]);

/** @typedef {{ rank: string, name: string }} Persona */
/** @typedef {{ address: string, roles: Record<string, readonly Persona[]> }} Pack */

/** One rank for every name. @param {string} rank @param {string[]} names */
const ranked = (rank, names) => Object.freeze(names.map((name) => Object.freeze({ rank, name })));

/** @type {Readonly<Record<string, Pack>>} */
export const PACKS = Object.freeze({
  starfleet: Object.freeze({
    // A high-ranking officer, not President.
    address: "Fleet Admiral",
    roles: Object.freeze({
      // The main backlog session's per-session draw (drawAdmiral), not a hash.
      backlog: ranked("Admiral", [
        "Nechayev",
        "Ross",
        "Cartwright",
        "Nogura",
        "Komack",
        "Marcus",
        "Satie",
        "Hayes",
        "Quinn",
        "Morrow",
      ]),
      prd: ranked("Captain", [
        "Sisko",
        "Janeway",
        "Freeman",
        "Burnham",
        "Saru",
        "Shaw",
        "Jellico",
        "Rios",
        "Terrell",
        "DeSoto",
      ]),
      // Pilots; a slice never talks to the user, so the pool waits for a later use.
      slice: ranked("Lieutenant", [
        "Paris",
        "Mayweather",
        "Detmer",
        "Ortegas",
        "Chekov",
        "Reed",
        "Yar",
        "Barclay",
      ]),
      // The inbox's entries carry their own ranks.
      inbox: Object.freeze([
        ...ranked("Ensign", ["Sato", "Kim", "Mariner"]),
        ...ranked("Lieutenant", ["Uhura", "Palmer"]),
        ...ranked("Yeoman", ["Rand"]),
      ]),
      hotfix: ranked("Lieutenant Commander", [
        "Scott",
        "Tucker",
        "Stamets",
        "Hemmer",
        "Reno",
        "Torres",
        "LaForge",
      ]),
      plan: ranked("Commander", ["Spock", "Data", "Dax", "Saavik", "Kira", "Chakotay"]),
      recovery: ranked("Doctor", ["McCoy", "Crusher", "Bashir", "Phlox", "Pulaski", "Culber"]),
    }),
  }),
  none: Object.freeze({ address: "", roles: Object.freeze({}) }),
});

/** The flavors a machine config may name. */
export const FLAVORS = Object.freeze(Object.keys(PACKS));
/** The flavor with no machine config, or one that names none. */
export const DEFAULT_FLAVOR = "starfleet";

/** The pack for FLAVOR (an unknown one reads as none). @param {string} flavor */
const packOf = (flavor) => PACKS[flavor] ?? PACKS.none;

/**
 * The machine's flavor: the machine config's `flavor`, else the default.
 * @param {{ flavor?: string } | null | undefined} machine what loadMachineConfig gave
 */
export const flavorOf = (machine) =>
  machine?.flavor && FLAVORS.includes(machine.flavor) ? machine.flavor : DEFAULT_FLAVOR;

/** ROLE's pool under FLAVOR: its entries, empty for none or a role it doesn't name. */
export const poolOf = (/** @type {string} */ role, flavor = DEFAULT_FLAVOR) =>
  Object.hasOwn(packOf(flavor).roles, role) ? packOf(flavor).roles[role] : Object.freeze([]);

/** ROLE's names under FLAVOR. */
export const namesOf = (/** @type {string} */ role, flavor = DEFAULT_FLAVOR) =>
  poolOf(role, flavor).map((p) => p.name);

/** A stable 32-bit hash (FNV-1a) of TEXT. @param {string} text */
function hash(text) {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= /** @type {number} */ (ch.codePointAt(0));
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The persona for a ROLE session named SESSIONNAME: the same entry of the role's
 * pool every time (a stable hash of the name); null under none or for a role
 * the pack doesn't name.
 * @param {string} role @param {string} sessionName
 * @returns {Persona | null}
 */
export function personaFor(role, sessionName, flavor = DEFAULT_FLAVOR) {
  const pool = poolOf(role, flavor);
  if (!pool.length) return null;
  const p = pool[hash(String(sessionName)) % pool.length];
  return { rank: p.rank, name: p.name };
}

/**
 * The persona of a ROLE session named NAME: the backlog's NAME is its drawn admiral
 * (drawAdmiral; one word, not the bare `backlog`), worn with the pool's rank;
 * every other role's comes from personaFor. Null under none or for no persona.
 * @param {string} role @param {string} name
 * @returns {Persona | null}
 */
export function sessionPersona(role, name, flavor = DEFAULT_FLAVOR) {
  if (role !== "backlog") return personaFor(role, name, flavor);
  const rank = poolOf(role, flavor)[0]?.rank;
  return rank && /^[A-Za-z]+$/.test(name) && name !== "backlog" ? { rank, name } : null;
}

/**
 * The main backlog session's name for a new session: an admiral from the pack's
 * backlog pool, never LAST; under none (an empty pool), the bare `backlog`.
 * RANDOM is a source of numbers in [0, 1) (Math.random; tests pass a fixed one).
 * @param {string | null | undefined} last
 * @param {() => number} [random]
 */
export function drawAdmiral(last, random = Math.random, flavor = DEFAULT_FLAVOR) {
  const pool = namesOf("backlog", flavor).filter((n) => n !== last);
  if (!pool.length) return "backlog";
  const i = Math.floor(random() * pool.length);
  return pool[Math.min(Math.max(i, 0), pool.length - 1)];
}

/** `Rank Name`, or "" for no persona. @param {Persona | null | undefined} persona */
export const label = (persona) => (persona ? `${persona.rank} ${persona.name}` : "");

/**
 * The one prompt line for ROLE's PERSONA: who the session is, the light touch in
 * replies only, how to address the user, and where the flavor never goes; "" for
 * no persona or a role the pack doesn't name.
 * @param {string} role @param {Persona | null | undefined} persona
 */
export function flavorLine(role, persona, flavor = DEFAULT_FLAVOR) {
  const pack = packOf(flavor);
  if (!persona || !Object.hasOwn(pack.roles, role)) return "";
  return (
    `- You are ${label(persona)}: let a light touch of their manner color your replies to the user, ` +
    `at most one per reply, and address the user as ${pack.address}; ` +
    "never inside questions, options or commands, nor in commits, files or anything an agent reads. " +
    "Substance, rules and brevity are unchanged."
  );
}

const isMain = () => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  const [verb, role, name] = process.argv.slice(2);
  if (!["persona", "label", "line"].includes(verb ?? "") || !ROLES.includes(role ?? "") || !name) {
    console.error(`usage: flavor.mjs persona|label|line <role> <name>   (role: ${ROLES.join(", ")})`);
    process.exit(2);
  }
  // Loaded here, not at the top, and without a top-level await: machine.mjs asks
  // this module for FLAVORS, and an await here would hold its import forever.
  import("./machine.mjs").then(({ loadMachineConfig }) => {
    let flavor = DEFAULT_FLAVOR;
    try {
      flavor = flavorOf(loadMachineConfig());
    } catch {
      // A machine config that doesn't load: `machine.mjs check` reports it; the default here.
    }
    const persona = sessionPersona(/** @type {string} */ (role), name, flavor);
    const out =
      verb === "persona"
        ? persona && `${persona.rank}\t${persona.name}`
        : verb === "label"
          ? label(persona)
          : flavorLine(/** @type {string} */ (role), persona, flavor);
    if (out) console.log(out);
  });
}
