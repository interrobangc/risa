// The Vitest limits (vitest.config.mjs): each test's and each hook's time limit,
// scaled for the machine's load the way the check budget scales (loadScale in
// check-budget.mjs: the load against 15, at least 1 and at most 3 times), so a
// busy machine's slow git commands don't time out files that pass alone. At a
// load of 15 or under they are the fixed 20 s and 10 s.
//
// The load: the higher of the 1-minute and 5-minute loads (RISA-1088: the
// 5-minute alone lags a second check starting beside this one, so a run at a
// 1-minute load near 50 got the idle limits). From RISA_TEST_LOAD when set
// (tests, one shell, or the check's tooling rerun: check-tooling.mjs), else
// RISA_LOAD_FILE (as the load gate reads it, load-gate.mjs), else the OS.
//
// scaledWait is the same scale for a wait inside a test (a poll's timeout, a
// script's wait knob), whose fixed clock the Vitest limits don't reach.
import { readFileSync } from "node:fs";
import { loadavg } from "node:os";
import { loadScale } from "./check-budget.mjs";

export const BASE = Object.freeze({ testTimeout: 20_000, hookTimeout: 10_000 });

/**
 * The load the limits scale for from a loadavg-style text ("1m 5m 15m", or one
 * number): the higher of the first two, or the one number; null when unreadable.
 * @param {string} text
 */
export function peakLoad(text) {
  const nums = String(text).replace(/[{},]/g, " ").trim().split(/\s+/).filter(Boolean).map(Number);
  if (!nums.length || nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return Math.max(...nums.slice(0, 2));
}

/** The load the limits scale for, or null when it can't be read. */
export function testLoad(env = process.env) {
  if (env.RISA_TEST_LOAD !== undefined && env.RISA_TEST_LOAD !== "") return peakLoad(env.RISA_TEST_LOAD);
  if (env.RISA_LOAD_FILE) {
    try {
      return peakLoad(readFileSync(env.RISA_LOAD_FILE, "utf8"));
    } catch {
      return null;
    }
  }
  return peakLoad(loadavg().join(" "));
}

/**
 * @param {{ load?: number | null }} [facts]
 * @returns {{ testTimeout: number, hookTimeout: number, scale: number }}
 */
export function testLimits({ load = null } = {}) {
  const scale = loadScale(load);
  return {
    testTimeout: Math.round(BASE.testTimeout * scale),
    hookTimeout: Math.round(BASE.hookTimeout * scale),
    scale,
  };
}

/**
 * MS, a test's own wait, scaled as the limits are: unchanged at a load of 15 or
 * under, up to three times above it. The load is read at each call unless given.
 * @param {number} ms
 * @param {{ load?: number | null }} [facts]
 */
export function scaledWait(ms, { load = testLoad() } = {}) {
  return Math.round(ms * loadScale(load));
}
