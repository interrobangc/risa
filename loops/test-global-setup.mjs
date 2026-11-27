// The Vitest global setup (vitest.config.mjs's globalSetup): it runs once, before any
// test file, and stops the whole run with machine.mjs's one line on a git under
// GIT_FLOOR, so no fixture's `git init -b` ever falls back on an older git's ways.
import { gitFloorLine } from "./machine.mjs";

/**
 * Throws the one line when the git on ENV's PATH is under the floor; returns otherwise.
 * @param {Record<string, string | undefined>} [env]
 */
export function checkGit(env = process.env) {
  const line = gitFloorLine(env);
  if (line) throw new Error(line);
}

export default function setup() {
  checkGit();
}
