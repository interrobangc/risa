// A backlog session's peers (peers.mjs, RISA-984): the machine config's other
// repos by their own configs' names, its CLI's lines, and the backlog prompt's peer
// rule rendered from them. Temp repos and a temp machine config; never ~/.risa.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { peersOf } from "./peers.mjs";
import { SAMPLE_CONFIG, makeRepo } from "./sample-project/repo.mjs";

const PEERS = fileURLToPath(new URL("./peers.mjs", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "peers-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sample = JSON.parse(readFileSync(SAMPLE_CONFIG, "utf8"));
/** A folder at ROOT/DIR holding a risa.json named NAME (TEXT: the file's text instead). */
const repo = (/** @type {string} */ dir, /** @type {string} */ name, text = "") => {
  const path = join(root, dir);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "risa.json"), text || JSON.stringify({ ...sample, name }));
  return path;
};
const main = join(root, "main");
makeRepo(main);
const alpha = repo("alpha", "alpha-app");
const beta = repo("beta", "beta-site");
const broken = repo("broken", "", "{ not json");

/** A machine config listing REPOS (paths), as RISA_MACHINE_CONFIG. */
const machine = (/** @type {string} */ file, /** @type {string[]} */ repos) => {
  const path = join(root, file);
  writeFileSync(path, JSON.stringify({ repos: repos.map((p) => ({ path: p })) }));
  return { RISA_MACHINE_CONFIG: path };
};

/** peersOf MAIN on ENV, with the warnings it gave. */
const peers = (/** @type {Record<string, string>} */ env) => {
  /** @type {string[]} */
  const warnings = [];
  return { peers: peersOf(main, env, (l) => void warnings.push(l)), warnings };
};

describe("peersOf", () => {
  it("has none without a machine config", () => {
    expect(peers({ RISA_MACHINE_CONFIG: "" })).toEqual({ peers: [], warnings: [] });
    expect(peers({ RISA_MACHINE_CONFIG: join(root, "missing.json") })).toEqual({ peers: [], warnings: [] });
  });

  it("has none when the machine config lists only this repo", () => {
    expect(peers(machine("only.json", [main]))).toEqual({ peers: [], warnings: [] });
  });

  it("names each other repo by its own config's name", () => {
    expect(peers(machine("two.json", [alpha, main, beta]))).toEqual({
      peers: [
        { name: "alpha-app", main: alpha, backlog: sample.tool.backlog },
        { name: "beta-site", main: beta, backlog: sample.tool.backlog },
      ],
      warnings: [],
    });
  });

  it("leaves out a repo whose config won't load, with a warning", () => {
    const { peers: got, warnings } = peers(machine("broken.json", [main, broken, alpha]));
    expect(got.map((p) => p.name)).toEqual(["alpha-app"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(new RegExp(`^peers: ${broken} left out: its project config doesn't load`));
  });

  it("has none, with a warning, when the machine config won't load", () => {
    const path = join(root, "bad-machine.json");
    writeFileSync(path, JSON.stringify({ repos: "no" }));
    const { peers: got, warnings } = peers({ RISA_MACHINE_CONFIG: path });
    expect(got).toEqual([]);
    expect(warnings[0]).toMatch(/^peers: the machine config doesn't load/);
  });
});

describe("node peers.mjs --main", () => {
  const cli = (/** @type {string[]} */ args, /** @type {Record<string, string>} */ env) =>
    spawnSync("node", [PEERS, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    });

  it("prints one line per peer, and the warnings on stderr", () => {
    const r = cli(["--main", main], machine("cli.json", [main, alpha, broken, beta]));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(
      `alpha-app\t${alpha}\t${sample.tool.backlog}\nbeta-site\t${beta}\t${sample.tool.backlog}\n`,
    );
    expect(r.stderr).toContain(`peers: ${broken} left out`);
  });

  it("prints nothing without a machine config, and refuses a bad usage", () => {
    expect(cli(["--main", main], { RISA_MACHINE_CONFIG: "" })).toMatchObject({ status: 0, stdout: "" });
    expect(cli([], { RISA_MACHINE_CONFIG: "" }).status).toBe(2);
  });
});

describe("the backlog prompt's peer rule", () => {
  const prompt = (/** @type {Record<string, string>} */ env) =>
    spawnSync("bash", [join(main, "loops/prompt.sh"), "backlog"], {
      cwd: main,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, RISA_CAPTAIN: "", ...env },
    });

  it("names a peer, its session, the inbox fallback and that its word isn't the user's", () => {
    const r = prompt(machine("prompt.json", [main, alpha]));
    expect(r.status).toBe(0);
    const line = r.stdout.split("\n").find((l) => l.startsWith("- **Peers**")) ?? "";
    expect(line).toContain(`**alpha-app** (its session \`backlog (alpha-app)\`, main checkout \`${alpha}\`)`);
    expect(line).toContain("ListAgents");
    expect(line).toContain("Remote Control lists other machines' sessions too");
    expect(line).toContain("told when a fix is deployed");
    expect(line).toContain(
      `for alpha-app, \`${sample.tool.backlog} inbox add <type> <text>\` in \`${alpha}\``,
    );
    expect(line).toContain("else report to the user, naming the peer and the message");
    expect(line).toContain("never the user's word");
  });

  it("says none on a machine with no other project", () => {
    for (const env of [{ RISA_MACHINE_CONFIG: "" }, machine("alone.json", [main])]) {
      const r = prompt(env);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("- **Peers:** none on this machine");
      expect(r.stdout).not.toContain("ListAgents by that name");
    }
  });
});
