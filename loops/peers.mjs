// A backlog session's peers (RISA-984): the other projects on this machine, each
// repo in the machine config other than the one asked from, by its own project
// config's `name`, with its main checkout and its backlog command (`tool.backlog`,
// for the inbox fallback). None without a machine config. A repo whose config
// won't load is left out with one warning line; so is every peer when the machine
// config itself doesn't load (`machine.mjs check` names its problems).
//
//   node peers.mjs --main <m>   one `<name>\t<main>\t<backlog>` line per peer; warnings
//                               on stderr; exit 0 (2 on a usage error)
//
// The backlog prompt (prompts/backlog.sh) renders its peer rule from these lines.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_NAME, ConfigError, loadConfig } from "./config.mjs";
import { MachineConfigError, loadMachineConfig, repoEntry } from "./machine.mjs";

/** @typedef {{ name: string, main: string, backlog: string }} Peer */

/**
 * The peers of the repo whose main checkout is MAIN, in the machine config's order.
 * @param {string} main
 * @param {Record<string, string | undefined>} [env] where the machine config is (RISA_MACHINE_CONFIG)
 * @param {(line: string) => void} [warn] gets one line per repo left out
 * @returns {Peer[]}
 */
export function peersOf(main, env = process.env, warn = (line) => void process.stderr.write(`${line}\n`)) {
  let machine;
  try {
    machine = loadMachineConfig({ env });
  } catch (e) {
    if (!(e instanceof MachineConfigError)) throw e;
    warn(`peers: the machine config doesn't load, so no peers (${e.problems.join("; ")})`);
    return [];
  }
  if (!machine) return [];
  const own = repoEntry(machine, main);
  /** @type {Peer[]} */
  const peers = [];
  for (const repo of machine.repos) {
    if (repo === own) continue;
    try {
      const { config } = loadConfig({ path: join(repo.path, CONFIG_NAME), env });
      peers.push({ name: config.name, main: repo.path, backlog: config.tool.backlog });
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      warn(`peers: ${repo.path} left out: its project config doesn't load (${e.problems.join("; ")})`);
    }
  }
  return peers;
}

const isMain = () => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  const args = process.argv.slice(2);
  const main = args[0] === "--main" && args.length === 2 ? args[1] : undefined;
  if (!main) {
    console.error("usage: peers.mjs --main <main>");
    process.exit(2);
  }
  for (const p of peersOf(main)) console.log(`${p.name}\t${p.main}\t${p.backlog}`);
}
