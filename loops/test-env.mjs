// The tests' own environment, built from the one they inherit: the core's test
// setup (test-setup.mjs) runs it before any test. A shell that a risa command or a
// session set up carries that session's config and state (every session has
// RISA_CONFIG); none of it is a test's. This is the only place that knows the list.
import { FIXTURE_CONFIG } from "./config-fixture.mjs";

/** A session's state variables, by name: none reaches a test. */
export const SESSION_VARS = [
  "RISA_SESSION",
  "RISA_SESSION_PID",
  "RISA_SESSION_NAME",
  "RISA_SESSIONS_DIR",
  "RISA_ASKS_DIR",
  "RISA_NOTICES_DIR",
  "RISA_REQUESTS_DIR",
  "RISA_LANDING_DIR",
  "RISA_SKEPTIC_DIR",
  "RISA_CONTEXT_HOOK",
  "RISA_RUN_LOG",
  "RISA_CHECK_LOG",
  "RISA_MAIN",
  "RISA_DISPATCH_MAIN",
  "RISA_CONFIG_FOUND",
  "CLAUDECODE",
];
/** A session's state variables, by prefix: the usage watch's and Claude Code's own. */
export const SESSION_PREFIXES = ["RISA_USAGE_", "CLAUDE_CODE_"];

/**
 * The tests' environment from ENV (a new object; ENV is untouched): RISA_CONFIG is the
 * fixture project's unless RISA_TEST_CONFIG names another, never an inherited one; no
 * machine config; none of a session's state variables. Everything else passes through.
 */
export function hermeticEnv(env) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (SESSION_VARS.includes(name)) continue;
    if (SESSION_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    out[name] = value;
  }
  out.RISA_CONFIG = env.RISA_TEST_CONFIG || FIXTURE_CONFIG;
  out.RISA_MACHINE_CONFIG = "";
  return out;
}
