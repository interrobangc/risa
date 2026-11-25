// For tests that run the tooling from a throwaway repo: import this file, and
// copy config.mjs in beside lib.sh. The scripts they start then read this repo's
// risa.json through RISA_CONFIG (they pass process.env on), since the throwaway
// repo has none of its own.
//
//   stubHookConfig(dir, { copy })   writes DIR/risa.json: that config with its
//                         stack hooks (stackUp … stackLeftovers, serve, testDb) on
//                         the sample project's stub (sample-project/tools/stack-hook.sh,
//                         its state in $SAMPLE_STACK_STATE), and returns its path, for
//                         RISA_CONFIG. With copy, the stub goes into DIR too (at
//                         tools/stack-hook.sh) and the hooks name it by that relative
//                         path, as a project's do. The core's tests run no project script.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** Where stubHookConfig's copy puts the stub, from the config's folder. */
export const STUB_HOOK_COPY = "tools/stack-hook.sh";

/**
 * @param {string} dir where the config goes
 * @param {{ base?: string, copy?: boolean }} [opts] the config it starts from
 *   (this repo's); copy the stub into DIR and name it relatively
 * @returns {string} its path
 */
export function stubHookConfig(dir, { base = FIXTURE_CONFIG, copy = false } = {}) {
  const raw = JSON.parse(readFileSync(base, "utf8"));
  let hook = `'${STUB_HOOK}'`;
  if (copy) {
    mkdirSync(join(dir, "tools"), { recursive: true });
    copyFileSync(STUB_HOOK, join(dir, STUB_HOOK_COPY));
    hook = STUB_HOOK_COPY;
  }
  for (const [name, verb] of Object.entries(STUB_VERBS)) raw.hooks[name] = `bash ${hook} ${verb}`;
  const path = join(dir, CONFIG_NAME);
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
  return path;
}
