// `git init` for the test fixtures that run git through spawnSync, which never
// throws: a failed init (an old git rejects `-b`) stops the fixture there, before a
// later git command can run in a folder that is no repo of its own, so walks up to
// whatever repo holds it. And an old git for the tests that show it (old-git.sh),
// first on PATH, that rejects `init -b` as git 2.24 does and records every call.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OLD_GIT = new URL("./old-git.sh", import.meta.url).pathname;

/**
 * Runs `git init ARGS` (spawnSync's OPTIONS) and returns its result; throws, naming
 * the init, when it fails.
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} [options]
 */
export function gitInit(args, options = {}) {
  const r = spawnSync("git", ["init", ...args], { encoding: "utf8", ...options });
  if (r.status !== 0) {
    const why = r.error ? r.error.message : `exit ${r.status}`;
    const said = String(r.stderr ?? "").trim();
    throw new Error(`git init ${args.join(" ")} failed (${why})${said ? `: ${said}` : ""}`);
  }
  return r;
}

/**
 * Runs FN with old-git.sh first on PATH as `git` (it rejects `init -b` with exit 129
 * and succeeds at anything else), then puts PATH back. Returns what FN threw (or
 * undefined) and the stub's calls, one argument string each. The stub is a link to
 * the one checked-in script, not a new file each time: a first exec of a new file
 * can cost seconds where the OS scans it.
 * @param {() => unknown} fn
 */
export function withOldGit(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "old-git-")));
  const log = join(dir, "calls");
  symlinkSync(OLD_GIT, join(dir, "git"));
  const saved = { PATH: process.env.PATH, RISA_OLD_GIT_LOG: process.env.RISA_OLD_GIT_LOG };
  process.env.PATH = `${dir}:${saved.PATH}`;
  process.env.RISA_OLD_GIT_LOG = log;
  /** @type {any} */ let error;
  try {
    fn();
  } catch (e) {
    error = e;
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  rmSync(dir, { recursive: true, force: true });
  return { error, calls };
}
