// Which project session.sh finds (RISA-1038): a session opened outside any
// repository (the inbox, in its own directory) takes its project from RISA_MAIN,
// which `prd.sh inbox` passes; inside a repo it goes by the current directory as
// before. Against two throwaway repos, a tool's (these scripts copied in) and a
// project's, both listed in a throwaway machine config, and a stub claude that
// writes down the config folder it was given.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_CONFIG } from "./config-fixture.mjs";
import { personaFor } from "./flavor.mjs";
import { processOf, writeRecord } from "./sessions.mjs";
import { BASE, scaledWait } from "./test-limits.mjs";

vi.setConfig({ testTimeout: scaledWait(BASE.testTimeout), hookTimeout: scaledWait(BASE.hookTimeout) });

const HERE = new URL(".", import.meta.url).pathname;
const SCRIPTS = [
  "lib.sh",
  "config.mjs",
  "session.sh",
  "sessions.mjs",
  "host.mjs",
  "captain.mjs",
  "flavor.mjs",
  "session-names.mjs",
  "machine.mjs",
  "inbox-settings.json",
  "context-settings.json",
];
const STUB = `#!/usr/bin/env bash
printf '%s\\n' "\${CLAUDE_CONFIG_DIR-unset}" > "$STUB_STATE/config-dir"
printf '%s\\n' "$@" > "$STUB_STATE/args"
`;

let root, tool, project, outside, state, env;

/** A throwaway repo at DIR with the fixture project's config, named NAME. */
function repo(dir, name) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "dev", dir]);
  const config = JSON.parse(readFileSync(FIXTURE_CONFIG, "utf8"));
  writeFileSync(join(dir, "risa.json"), JSON.stringify({ ...config, name }, null, 2));
  for (const f of ["tiers.json", "check-plan-rules.json", "brake-list.txt", "quarantine.txt"])
    if (existsSync(join(FIXTURE_CONFIG, "..", f))) copyFileSync(join(FIXTURE_CONFIG, "..", f), join(dir, f));
}

const record = (main) => JSON.parse(readFileSync(join(main, ".loops/.sessions/inbox.json"), "utf8"));
const session = (cwd, extra = {}) =>
  spawnSync("bash", [join(tool, "loops/session.sh"), "inbox", "--", "a prompt"], {
    cwd,
    encoding: "utf8",
    env: { ...env, ...extra },
  });

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "session-test-")));
  tool = join(root, "tool");
  project = join(root, "project");
  outside = join(root, "inbox");
  state = join(root, "state");
  repo(tool, "tool");
  repo(project, "project");
  mkdirSync(join(tool, "loops"));
  for (const f of SCRIPTS) copyFileSync(join(HERE, f), join(tool, "loops", f));
  cpSync(join(HERE, "prompts"), join(tool, "loops/prompts"), { recursive: true });
  mkdirSync(outside);
  const stub = join(root, "claude-stub");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  const machine = join(root, "machine.json");
  writeFileSync(
    machine,
    JSON.stringify({
      repos: [
        { path: tool, claudeConfigDir: "/acct/tool" },
        { path: project, claudeConfigDir: "/acct/project" },
      ],
    }),
  );
  env = { ...process.env, RISA_MACHINE_CONFIG: machine, RISA_CLAUDE_BIN: stub, STUB_STATE: state };
  // The config each repo's own: found by find_repo, never the tests' pin.
  delete env.RISA_CONFIG;
  delete env.RISA_CONFIG_FOUND;
  delete env.RISA_MAIN;
  delete env.RISA_SESSIONS_DIR;
  delete env.CLAUDE_CONFIG_DIR;
}, scaledWait(60_000));
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(state, { recursive: true, force: true });
  mkdirSync(state);
  for (const r of [tool, project]) rmSync(join(r, ".loops"), { recursive: true, force: true });
});

describe("session.sh's project", () => {
  it("outside any repo, takes RISA_MAIN's: its claude config folder and its sessions", () => {
    const r = session(outside, { RISA_MAIN: project });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(readFileSync(join(state, "config-dir"), "utf8").trim()).toBe("/acct/project");
    expect(record(project)).toMatchObject({ kind: "inbox", dir: outside, exit: 0 });
    expect(existsSync(join(tool, ".loops/.sessions/inbox.json"))).toBe(false);
  });

  it("inside a repo without RISA_MAIN, goes by the current directory as before", () => {
    const r = session(project);
    expect(r.status).toBe(0);
    expect(readFileSync(join(state, "config-dir"), "utf8").trim()).toBe("/acct/project");
    expect(record(project)).toMatchObject({ kind: "inbox", dir: project, exit: 0 });
    expect(existsSync(join(tool, ".loops/.sessions/inbox.json"))).toBe(false);
  });

  it("inside a repo, the current directory wins over an inherited RISA_MAIN", () => {
    const r = session(tool, { RISA_MAIN: project });
    expect(r.status).toBe(0);
    expect(readFileSync(join(state, "config-dir"), "utf8").trim()).toBe("/acct/tool");
    expect(record(tool)).toMatchObject({ kind: "inbox", dir: tool });
    expect(existsSync(join(project, ".loops/.sessions/inbox.json"))).toBe(false);
  });

  it("outside any repo without RISA_MAIN, falls back to the tool's own checkout", () => {
    expect(session(outside).status).toBe(0);
    expect(readFileSync(join(state, "config-dir"), "utf8").trim()).toBe("/acct/tool");
    expect(record(tool)).toMatchObject({ kind: "inbox", dir: outside });
  });
});

describe("session.sh's first record (RISA-1064)", () => {
  it("carries the persona its display name wears when stepped off its hash; one on its hash keeps none", () => {
    const name = "prd-harbor-docks";
    const hashed = /** @type {{ name: string }} */ (personaFor("prd", name)).name;
    // The tool repo's live session of the same name holds the hashed captain.
    const self = processOf(process.pid);
    const started = new Date(self?.startedMs ?? Date.now()).toISOString();
    writeRecord(join(tool, ".loops/.sessions"), name, { kind: "prd", pid: process.pid, started });
    const run = (/** @type {string} */ n) =>
      spawnSync("bash", [join(tool, "loops/session.sh"), n, "--", "--remote-control", n, "a prompt"], {
        cwd: project,
        encoding: "utf8",
        env,
      });
    const r = run(name);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const rec = JSON.parse(readFileSync(join(project, ".loops/.sessions", `${name}.json`), "utf8"));
    expect(rec.persona).toBeTruthy();
    expect(rec.persona).not.toBe(hashed);
    expect(readFileSync(join(state, "args"), "utf8")).toContain(`Capt ${rec.persona} · ${name} (project)`);
    // Nothing held: the hash, and no persona kept.
    expect(run("prd-lantern-wicks").status).toBe(0);
    const plain = JSON.parse(readFileSync(join(project, ".loops/.sessions/prd-lantern-wicks.json"), "utf8"));
    expect(plain.persona).toBeUndefined();
    expect(readFileSync(join(state, "args"), "utf8")).toContain(
      `Capt ${personaFor("prd", "prd-lantern-wicks")?.name} · prd-lantern-wicks (project)`,
    );
  });
});
