// ci-args.mjs: part of `pnpm prd ci` (ci.mjs has the map). The commands'
// arguments (run, blame and file, gate) and the branch and commit a request
// means.
import { backlogIds } from "../loops/config.mjs";
import { DEFAULT_WAIT_MIN } from "./ci-io.mjs";
import { tierDataOrExit } from "./tier-data.mjs";

const { TIERS, isTier } = tierDataOrExit("ci");
const IDS = backlogIds();
const ID = new RegExp(`^${IDS.pattern}$`);

/** @typedef {import("./ci-io.mjs").Io} Io */

/**
 * The `run` command's arguments.
 * @param {string[]} args
 */
export function parseRunArgs(args) {
  const [tier, ...rest] = args;
  if (!tier || !isTier(tier)) throw new Error(`ci run needs a tier: ${TIERS.join(", ")}`);
  /** @type {string | null} */ let ref = null;
  /** @type {number | null} */ let waitMin = null;
  /** @type {string[]} */ const files = [];
  /** @type {string | null} */ let forceFlake = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--ref") {
      ref = rest[++i] ?? null;
      if (!ref || ref.startsWith("-")) throw new Error("--ref needs a branch");
    } else if (rest[i] === "--wait") {
      waitMin = DEFAULT_WAIT_MIN;
      if (/^\d+$/.test(rest[i + 1] ?? "")) waitMin = Number(rest[++i]);
    } else if (rest[i] === "--files") {
      while (rest[i + 1] && !rest[i + 1]?.startsWith("-")) files.push(/** @type {string} */ (rest[++i]));
      if (!files.length) throw new Error("--files needs at least one test file");
    } else if (rest[i] === "--force-flake") {
      forceFlake = rest[++i] ?? null;
      if (!forceFlake || forceFlake.startsWith("-")) throw new Error("--force-flake needs a browser check");
    } else throw new Error(`ci run: unknown argument ${rest[i]}`);
  }
  if (forceFlake && tier !== "candidate") throw new Error("--force-flake needs the candidate tier");
  if (forceFlake && files.length) throw new Error("--force-flake can't be narrowed with --files");
  return { tier, ref, waitMin, files, forceFlake };
}

/** The arguments of `blame` and `file`. */
export function parseReadArgs(/** @type {string} */ command, /** @type {string[]} */ args) {
  /** @type {string | null} */ let ref = null;
  /** @type {string | null} */ let base = null;
  /** @type {string | null} */ let runId = null;
  let json = false;
  let noPush = false;
  for (let i = 0; i < args.length; i++) {
    const a = /** @type {string} */ (args[i]);
    if (a === "--json" && command === "blame") json = true;
    else if (a === "--no-push" && command === "file") noPush = true;
    else if (a === "--run" && command === "file") {
      runId = args[++i] ?? null;
      if (!runId || !/^\d+(,\d+)*$/.test(runId)) throw new Error("--run needs a run id (or ids: 1,2)");
    } else if (a === "--base" && command === "file") {
      base = args[++i] ?? null;
      if (!base || base.startsWith("-")) throw new Error("--base needs a commit");
    } else if (!a.startsWith("-") && !ref) ref = a;
    else throw new Error(`ci ${command}: unknown argument ${a}`);
  }
  return { ref, json, base, runId, noPush };
}

export function parseGateArgs(/** @type {string[]} */ args) {
  /** @type {string | null} */ let ref = null;
  let tier = "";
  let base = "";
  /** @type {string[]} */ let fixes = [];
  /** @type {string | null} */ let out = null;
  let peek = false;
  for (let i = 0; i < args.length; i++) {
    const a = /** @type {string} */ (args[i]);
    if (a === "--tier") tier = args[++i] ?? "";
    else if (a === "--base") base = args[++i] ?? "";
    else if (a === "--out") out = args[++i] ?? null;
    else if (a === "--peek") peek = true;
    else if (a === "--fixes") fixes = (args[++i] ?? "").split(",").filter(Boolean);
    else if (!a.startsWith("-") && !ref) ref = a;
    else throw new Error(`ci gate: unknown argument ${a}`);
  }
  if (!isTier(tier)) throw new Error(`ci gate: --tier needs one of ${TIERS.join(", ")}`);
  if (!base || base.startsWith("-")) throw new Error("ci gate: --base needs a commit");
  if (fixes.some((f) => !ID.test(f))) throw new Error(`ci gate: --fixes takes ${IDS.prefix}n,${IDS.prefix}m`);
  return { ref, tier, base, fixes, out, peek };
}

/** The branch name and commit a request means. */
export function resolve(/** @type {Io} */ io, /** @type {string | null} */ ref) {
  const branch = ref ?? io.git(["branch", "--show-current"]).out;
  if (!branch) throw new Error("not on a branch: name one with --ref");
  const sha = io.git(["rev-parse", "--verify", "--quiet", `${branch}^{commit}`]);
  if (!sha.ok || !sha.out) throw new Error(`no such branch: ${branch}`);
  return { branch, sha: sha.out };
}
