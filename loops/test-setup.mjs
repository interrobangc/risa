// The core's test setup, named in every core Vitest project (core:unit,
// tooling:unit, tooling:browser) and in the standalone run's config: no core test
// reads the checkout's own config. RISA_CONFIG defaults to the fixture project's
// (config-fixture.mjs's FIXTURE_CONFIG: today's names, its own data files), and
// there is no machine config (machine.mjs) unless a test names one, never the
// machine's own ~/.risa. A test that wants another config sets its own.
import { FIXTURE_CONFIG } from "./config-fixture.mjs";

process.env.RISA_CONFIG ??= FIXTURE_CONFIG;
process.env.RISA_MACHINE_CONFIG ??= "";
// The repo a parent command found (lib.sh's RISA_MAIN) is never a test's.
delete process.env.RISA_MAIN;
