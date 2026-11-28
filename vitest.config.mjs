// The tool's tests, in three projects (the names projects' risa.json files use):
//   core:unit        the check plan, the check times and the CI modules
//   tooling:unit     the rest of loops/ and backlog/, against throwaway git repos in
//                    the OS temp dir; each runs dozens of git commands, so 20 s each
//   tooling:browser  loops/browser.test.mjs alone: the browser gate, which waits on
//                    checks that hang on purpose
// Each reads the fixture project's config (loops/test-setup.mjs), never a checkout's.
// The test (20 s) and hook (10 s) limits grow with the machine's 5-minute load above 15,
// up to three times, as the check budget does (loops/test-limits.mjs; RISA_TEST_LOAD sets it).
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { testLimits, testLoad } from "./loops/test-limits.mjs";

// Once, before any file: a git under the floor stops the run (loops/test-global-setup.mjs).
const globalSetup = [fileURLToPath(new URL("./loops/test-global-setup.mjs", import.meta.url))];
const setupFiles = [fileURLToPath(new URL("./loops/test-setup.mjs", import.meta.url))];
// Off for every spawned script (they pass process.env on): new.sh and check-run.sh
// would otherwise poll the real machine's load. The gate's own tests set it back.
const env = { RISA_LOAD_GATE: "off" };
const { testTimeout, hookTimeout } = testLimits({ load: testLoad() });

export default defineConfig({
  test: {
    globalSetup,
    projects: [
      {
        test: {
          name: "core:unit",
          include: ["loops/check-times.test.mjs", "loops/check-plan.test.mjs", "ci/**/*.test.mjs"],
          testTimeout,
          hookTimeout,
          setupFiles,
        },
      },
      {
        test: {
          name: "tooling:unit",
          include: ["loops/**/*.test.mjs", "backlog/**/*.test.mjs"],
          exclude: ["loops/check-times.test.mjs", "loops/check-plan.test.mjs", "loops/browser.test.mjs"],
          testTimeout,
          hookTimeout,
          setupFiles,
          env,
        },
      },
      {
        test: {
          name: "tooling:browser",
          include: ["loops/browser.test.mjs"],
          testTimeout,
          hookTimeout,
          setupFiles,
          env,
        },
      },
    ],
  },
});
