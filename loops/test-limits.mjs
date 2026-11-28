// The Vitest limits (vitest.config.mjs): each test's and each hook's time limit,
// scaled for the machine's load the way the check budget scales (loadScale in
// check-budget.mjs: the 5-minute load against 15, at least 1 and at most 3
// times), so a busy machine's slow git commands don't time out files that pass
// alone. At a load of 15 or under they are the fixed 20 s and 10 s.
//
// The load: RISA_TEST_LOAD when set (tests, or one shell), else the load gate's
// reading (readLoadGate in load-gate.mjs: RISA_LOAD_FILE, else the OS).
//
// scaledWait is the same scale for a wait inside a test (a poll's timeout, a
// script's wait knob), whose fixed clock the Vitest limits don't reach.
import { loadScale } from "./check-budget.mjs";
import { parseLoad, readLoadGate } from "./load-gate.mjs";

export const BASE = Object.freeze({ testTimeout: 20_000, hookTimeout: 10_000 });

/** The 5-minute load the limits scale for, or null when it can't be read. */
export function testLoad(env = process.env) {
  if (env.RISA_TEST_LOAD !== undefined && env.RISA_TEST_LOAD !== "") return parseLoad(env.RISA_TEST_LOAD);
  return readLoadGate(env).load;
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
