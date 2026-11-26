// The load gate: is the machine too busy to start more work? Busy is the
// 5-minute load above RISA_LOAD_BUSY (default twice the core count, or
// LIGHT_BUSY with RISA_LOAD_LANE=light: quick and slice checks, slice starts);
// RISA_LOAD_GATE=off is never busy, and a load that can't be read isn't
// busy either. A check (check-run.sh, inside its lease) and a slice worktree's
// creation (new.sh) wait while it's busy, for at most RISA_LOAD_WAIT
// seconds (load_gate_wait in lib.sh); `pnpm prd start` only warns; the
// dispatcher starts nothing new; `pnpm prd status` prints it.
//
//   node load-gate.mjs          one line for scripts: "<busy|ok|off|unread> <load or -> <threshold> <cores>"
//   node load-gate.mjs --say    one line for people (pnpm prd status)
//   node load-gate.mjs --json   the whole result
//
// RISA_LOAD_FILE stands in for the reading (tests): the file's numbers are
// the 1, 5 and 15 minute loads (one number alone is the 5-minute load).
import { readFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { pathToFileURL } from "node:url";

/** @typedef {{ busy: boolean, off: boolean, load: number | null, threshold: number, cores: number,
 *   setting: boolean }} Gate */

/** The load quick and slice checks and slice starts wait above: they are short. */
export const LIGHT_BUSY = 30;

const positive = (s) =>
  s !== undefined && s !== "" && Number.isFinite(Number(s)) && Number(s) > 0 ? Number(s) : null;

/**
 * @param {{ load: number | null, cores: number, env?: Record<string, string | undefined> }} facts
 *   load: the 5-minute load (null when unreadable); env: the settings
 * @returns {Gate}
 */
export function loadGate({ load, cores, env = {} }) {
  const off = env.RISA_LOAD_GATE === "off";
  const set = positive(env.RISA_LOAD_BUSY);
  const threshold = set ?? (env.RISA_LOAD_LANE === "light" ? LIGHT_BUSY : 2 * cores);
  const readable = typeof load === "number" && Number.isFinite(load);
  return {
    busy: !off && readable && load > threshold,
    off,
    load: readable ? load : null,
    threshold,
    cores,
    setting: set !== null,
  };
}

/** The 5-minute load from a loadavg-style text ("1m 5m 15m", or one number), or null. */
export function parseLoad(text) {
  const nums = String(text).replace(/[{},]/g, " ").trim().split(/\s+/).filter(Boolean).map(Number);
  if (!nums.length || nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return nums.length >= 2 ? nums[1] : nums[0];
}

/** The gate on this machine: the load from RISA_LOAD_FILE, else the OS. */
export function readLoadGate(env = process.env) {
  let load;
  if (env.RISA_LOAD_FILE) {
    try {
      load = parseLoad(readFileSync(env.RISA_LOAD_FILE, "utf8"));
    } catch {
      load = null;
    }
  } else {
    const l = loadavg()[1];
    load = Number.isFinite(l) ? l : null;
  }
  return loadGate({ load, cores: availableParallelism(), env });
}

const fmt = (n) => (n === null ? "-" : String(Math.round(n * 100) / 100));

/** @param {Gate} g */
export function stateOf(g) {
  return g.off ? "off" : g.load === null ? "unread" : g.busy ? "busy" : "ok";
}

/** @param {Gate} g @param {Record<string, string | undefined>} [env] */
export function sayGate(g, env = {}) {
  const against = g.setting
    ? `${fmt(g.threshold)} (RISA_LOAD_BUSY)`
    : `${fmt(g.threshold)} (twice ${g.cores} cores)`;
  if (g.off) return "load gate: off (RISA_LOAD_GATE=off)";
  if (g.load === null) return `load gate: can't read the load; not busy (threshold ${against})`;
  const wait = positive(env.RISA_LOAD_WAIT) ?? 600;
  const waiting = g.setting
    ? "checks and slice starts wait"
    : `full checks wait (quick checks and slices above ${LIGHT_BUSY})`;
  return g.busy
    ? `load gate: 5-minute load ${fmt(g.load)} over ${against}: BUSY, ${waiting} up to ${wait}s`
    : `load gate: 5-minute load ${fmt(g.load)} against ${against}: not busy`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const arg = process.argv[2];
  const g = readLoadGate();
  if (arg === "--json") console.log(JSON.stringify({ state: stateOf(g), ...g }));
  else if (arg === "--say") console.log(sayGate(g, process.env));
  else if (arg === undefined) console.log(`${stateOf(g)} ${fmt(g.load)} ${fmt(g.threshold)} ${g.cores}`);
  else {
    console.error(`load-gate.mjs: unknown argument ${arg} (--say, --json)`);
    process.exit(2);
  }
}
