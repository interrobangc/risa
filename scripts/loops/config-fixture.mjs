// For tests that run the tooling from a throwaway repo: import this file, and
// copy config.mjs in beside lib.sh. The scripts they start then read this repo's
// risa.json through RISA_CONFIG (they pass process.env on), since the throwaway
// repo has none of its own.
//
//   stubHookConfig(dir)   writes DIR/risa.json: that config with its stack hooks
//                         (stackUp … stackLeftovers, serve, testDb) on the sample
//                         project's stub (sample-project/tools/stack-hook.sh, its
//                         state in $SAMPLE_STACK_STATE), and returns its path, for
//                         RISA_CONFIG. The core's tests run no project script.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_NAME } from "./config.mjs";

/** The config the throwaway repos use. */
export const FIXTURE_CONFIG = fileURLToPath(new URL(`../../${CONFIG_NAME}`, import.meta.url));

process.env.RISA_CONFIG ??= FIXTURE_CONFIG;

/** The sample project's stub for every stack hook. */
export const STUB_HOOK = fileURLToPath(new URL("./sample-project/tools/stack-hook.sh", import.meta.url));

const STUB_VERBS = {
  stackUp: "stack up",
  stackDown: "stack down",
  stackStatus: "stack status",
  stackReady: "stack ready",
  stackStop: "stack stop",
  stackStart: "stack start",
  stackEngine: "stack engine",
  stackLeftovers: "stack leftovers",
  serve: "serve",
  testDb: "test-db",
};

/**
 * @param {string} dir where the config goes
 * @param {string} [base] the config it starts from (this repo's)
 * @returns {string} its path
 */
export function stubHookConfig(dir, base = FIXTURE_CONFIG) {
  const raw = JSON.parse(readFileSync(base, "utf8"));
  for (const [hook, verb] of Object.entries(STUB_VERBS)) raw.hooks[hook] = `bash '${STUB_HOOK}' ${verb}`;
  const path = join(dir, CONFIG_NAME);
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
  return path;
}
