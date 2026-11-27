// For tests that run the tooling from a throwaway repo: import this file, and
// copy config.mjs in beside lib.sh. The scripts they start then read the fixture
// project's config (fixture-project/risa.json: today's names, its own data files)
// through RISA_CONFIG, which the core's test setup (test-setup.mjs) defaults to it
// and they pass on in process.env, since the throwaway repo has none of its own.
//
//   stubHookConfig(dir, { copy })   writes DIR/risa.json: that config with its
//                         stack hooks (stackUp … stackLeftovers, serve, testDb) on
//                         the sample project's stub (sample-project/tools/stack-hook.sh,
//                         its state in $SAMPLE_STACK_STATE), and returns its path, for
//                         RISA_CONFIG. With copy, the stub goes into DIR too (at
//                         tools/stack-hook.sh) and the hooks name it by that relative
//                         path, as a project's do. Its browser hook is the sample's
//                         (sample-project/tools/browser-hook.sh). The core's tests run no
//                         project script.
//
//   sampleFoldersConfig(dir)  writes DIR/risa.json: that config with its check plan's
//                         rules on the sample project's folders (web/, db/), and returns
//                         its path, for a test whose made-up files sit there.
//
//   fixtureTierData(dir?) the tier data the config in RISA_CONFIG names (paths.tierData,
//                         from that config's folder): { path, text }; with DIR, also
//                         written there at that path, for a throwaway repo.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_NAME } from "./config.mjs";

/** The config the throwaway repos use: the fixture project's, never the checkout's. */
export const FIXTURE_CONFIG = fileURLToPath(new URL(`./fixture-project/${CONFIG_NAME}`, import.meta.url));

/** The sample project's stub for every stack hook. */
export const STUB_HOOK = fileURLToPath(new URL("./sample-project/tools/stack-hook.sh", import.meta.url));

/** The sample project's browser hook: a plain runner with no browser behind it. */
export const BROWSER_HOOK = fileURLToPath(new URL("./sample-project/tools/browser-hook.sh", import.meta.url));

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
 *   (the fixture project's); copy the stub into DIR and name it relatively
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
  raw.hooks.browser = `bash '${BROWSER_HOOK}'`;
  const path = join(dir, CONFIG_NAME);
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
  return path;
}

// The check plan's rules on the sample project's folders (web/ app code, db/
// server code), with the fixture config's tiers.
const RULES = {
  ownTests: "\\.(int\\.test\\.ts|browser\\.test\\.tsx)$",
  suite: {
    tier: "full",
    rules: [
      { match: "^db/migrations/", why: "a migration" },
      { match: "^db/.*seed", flags: "i", why: "seeds" },
      { match: "^pnpm-lock\\.yaml$", why: "the lockfile" },
      { match: "(^|/)package\\.json$", why: "a package.json" },
      { match: "^vitest\\.config\\.ts$", why: "the Vitest config" },
      { match: "^\\.github/(workflows|actions)/", why: "the CI workflow" },
      { match: "^scripts/ci/", why: "scripts/ci" },
    ],
  },
  byPath: [
    { match: "^web/", tier: "components", why: "app code" },
    { match: "^db/", tier: "integration", why: "server code" },
  ],
  reachesCode: [
    { match: "^(db|web)/test/", why: "test setup" },
    { match: "(^|/)tsconfig[^/]*\\.json$", why: "a TypeScript config" },
    { match: "(^|/)eslint\\.config\\.[^/]+$", why: "the ESLint config" },
  ],
};

/**
 * A copy of the fixture config in DIR, its tier data beside it and its check
 * plan's rules the sample folders' (RULES), for a test whose made-up files sit
 * there: a config's paths start from its own folder.
 * @param {string} dir
 * @returns {string} its path
 */
export function sampleFoldersConfig(dir) {
  const raw = JSON.parse(readFileSync(FIXTURE_CONFIG, "utf8"));
  const put = (/** @type {string} */ rel, /** @type {string} */ text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  put(raw.paths.tierData, readFileSync(join(dirname(FIXTURE_CONFIG), raw.paths.tierData), "utf8"));
  put(raw.paths.checkPlanRules, `${JSON.stringify(RULES, null, 2)}\n`);
  put("risa.json", `${JSON.stringify(raw, null, 2)}\n`);
  return join(dir, "risa.json");
}

/**
 * The tier data the config in RISA_CONFIG names: its path from that config's
 * folder and its text. Given a throwaway repo, it is written there at that path.
 * @param {string} [dir] the throwaway repo
 * @returns {{ path: string, text: string }}
 */
export function fixtureTierData(dir) {
  const config = process.env.RISA_CONFIG || FIXTURE_CONFIG;
  const path = JSON.parse(readFileSync(config, "utf8")).paths.tierData;
  const text = readFileSync(join(dirname(config), path), "utf8");
  if (dir) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return { path, text };
}
