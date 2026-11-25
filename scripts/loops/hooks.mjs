// The project's hooks from Node, as lib.sh's stack_hook runs them from bash: the
// config's hooks.NAME, run by bash from the top of the checkout this file is in
// (the tool's own, which always has the hook scripts it was written with), ARGs
// after it. A hook prints facts as key=value lines and exits non-zero on failure.
//
//   runHook(name, args, { env })   { status, ok, out, err }: status 127 when the
//                                  config sets no such hook
//   fact(key, out)                 a key's value, the last when there are several
//   factList(key, out)             every value of a repeated key (volume=, orphan=)
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** @type {string | undefined} */
let top;
/** The top of the checkout this file is in (lib.sh's stack_hook: git rev-parse there). */
function toolTop() {
  if (top === undefined) {
    const r = spawnSync("git", ["-C", HERE, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
    top = r.status === 0 ? r.stdout.trim() : HERE;
  }
  return top;
}

/**
 * @param {string} name the hook (stackReady, testDb…)
 * @param {string[]} [args]
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ status: number, ok: boolean, out: string, err: string }}
 */
export function runHook(name, args = [], { env = process.env } = {}) {
  const cmd = loadConfig({ env }).config.hooks?.[name];
  if (typeof cmd !== "string" || !cmd)
    return { status: 127, ok: false, out: "", err: `no hooks.${name} in the config` };
  const r = spawnSync("bash", ["-c", `${cmd} "$@"`, name, ...args], {
    cwd: toolTop(),
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const status = r.status ?? 1;
  return { status, ok: status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

/** Every value of KEY in a hook's key=value lines, in order. */
export function factList(/** @type {string} */ key, /** @type {string} */ out) {
  return out
    .split("\n")
    .filter((l) => l.startsWith(`${key}=`))
    .map((l) => l.slice(key.length + 1));
}

/** KEY's value in a hook's key=value lines (the last one), or "" (lib.sh's fact). */
export function fact(/** @type {string} */ key, /** @type {string} */ out) {
  return factList(key, out).at(-1) ?? "";
}
