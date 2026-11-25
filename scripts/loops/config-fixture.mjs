// For tests that run the tooling from a throwaway repo: import this file, and
// copy config.mjs in beside lib.sh. The scripts they start then read this repo's
// risa.json through RISA_CONFIG (they pass process.env on), since the throwaway
// repo has none of its own.
import { fileURLToPath } from "node:url";
import { CONFIG_NAME } from "./config.mjs";

/** The config the throwaway repos use. */
export const FIXTURE_CONFIG = fileURLToPath(new URL(`../../${CONFIG_NAME}`, import.meta.url));

process.env.RISA_CONFIG ??= FIXTURE_CONFIG;
