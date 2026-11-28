// The project's pinned Risa against the release running (RISA-1050): the config's
// `risaVersion` (config.mjs, through its loader) is the pin, and the running version
// is the tag of the release folder this code runs from (~/.risa/releases/<tag>, as
// dispatch.mjs's followsLink reads one). Both known and different: one warning
// line, which `risa status` (ls.sh) prints and the dispatcher logs at its start and
// after each re-exec. A warning only: nothing is refused (that is RISA-1017's).
// No pin, or a run from a checkout rather than a release: nothing.
//
//   node pin.mjs [--root <tool folder>]   prints the line, or nothing (exit 0 either way)
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";

/** A version without its `v` prefix (v0.2.0 and 0.2.0 are one version). @param {string} v */
const bare = (v) => String(v).trim().replace(/^v/, "");

/**
 * The warning when PIN (the config's risaVersion) and RUNNING (the release's tag)
 * are both known and differ, else null. Pure.
 * @param {string | null | undefined} pin @param {string | null | undefined} running
 */
export function pinWarning(pin, running) {
  if (!pin || !running || bare(pin) === bare(running)) return null;
  return `risa version: this project pins v${bare(pin)} (risaVersion) but release v${bare(running)} is running`;
}

/** A path with its symlinks resolved, when it exists. @param {string} p */
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * The release ROOT runs as: its folder's tag when ROOT is a folder of
 * HOME/.risa/releases (its package.json version when the name isn't one), else null
 * (a checkout, the main one included).
 * @param {string} root @param {string} [home]
 */
export function runningRelease(root, home = homedir()) {
  const r = real(root);
  if (dirname(r) !== real(join(home, ".risa", "releases"))) return null;
  const tag = basename(r);
  if (/^v?\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(tag)) return tag;
  try {
    return String(JSON.parse(readFileSync(join(r, "package.json"), "utf8")).version || "") || null;
  } catch {
    return null;
  }
}

/**
 * The warning for the tool at ROOT on the config ENV finds (loadConfig), or null; a
 * config that doesn't load has no pin to compare.
 * @param {string} root @param {NodeJS.ProcessEnv} [env]
 */
export function pinWarningAt(root, env = process.env) {
  let pin;
  try {
    pin = loadConfig({ env }).config.risaVersion ?? null;
  } catch {
    return null;
  }
  return pinWarning(pin, runningRelease(root, env.HOME || homedir()));
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const i = process.argv.indexOf("--root");
  const root =
    i > 0 && process.argv[i + 1] ? process.argv[i + 1] : join(dirname(fileURLToPath(import.meta.url)), "..");
  const line = pinWarningAt(root);
  if (line) console.log(line);
}
