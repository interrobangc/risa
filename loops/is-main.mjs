// The main guard for an entry point (RISA-1048): `if (isMain(import.meta.url))`.
// Comparing import.meta.url with "file://" plus process.argv[1] misses a script
// run through a symlink (pnpm's node_modules/.bin and a project's node_modules
// link to the real .pnpm path, which import.meta.url names), so this compares the
// realpaths of both instead.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when the script node was started with is the module at `url`, through
 * any symlink; false when there is no script argument or it doesn't exist.
 * @param {string} url the module's import.meta.url
 * @param {string | undefined} [script] the script argument (process.argv[1])
 */
export function isMain(url, script = process.argv[1]) {
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}
