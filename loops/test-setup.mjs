// The core's test setup, named in every core Vitest project (core:unit,
// tooling:unit, tooling:browser) and in the standalone run's config: no core test
// reads the checkout's own config or a session's state. The environment is
// hermeticEnv's (test-env.mjs): RISA_CONFIG is the fixture project's
// (config-fixture.mjs's FIXTURE_CONFIG: today's names, its own data files) unless
// RISA_TEST_CONFIG names another, whatever the shell held; there is no machine config
// (machine.mjs), never the machine's own ~/.risa; and a session's variables are gone.
// A test that wants another config or a machine config sets its own.
import { hermeticEnv } from "./test-env.mjs";

const env = hermeticEnv(process.env);
for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
Object.assign(process.env, env);
