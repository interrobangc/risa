// The folder form's test rules and gates by name (config.mjs RULE_FILES): an unset
// paths.tierData, checkPlanRules, brakeList or quarantine is .risa/<name> when that
// file exists, in loadConfig, `dump`, the tier data, the check plan and lib.sh's CI lists.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { checkPlanFor } from "./check-plan.mjs";
import { CONFIG_DIR, CONFIG_FILE, CONFIG_NAME, RULE_FILES, loadConfig } from "./config.mjs";
import { SAMPLE_CONFIG, makeRepo } from "./sample-project/repo.mjs";
import { tierData } from "../ci/tier-data.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_TOOLS = join(HERE, "sample-project", "tools");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "config-rules-test-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const KEYS = RULE_FILES.map(([key]) => key);
/** The four files by their default names, from the sample's own rules. */
const RULES = {
  "tiers.json": readFileSync(join(SAMPLE_TOOLS, "tiers.json"), "utf8"),
  "check-plan.json": readFileSync(join(SAMPLE_TOOLS, "check-plan-rules.json"), "utf8"),
  "brake-list.txt": "",
  "quarantine.txt": "",
};

/**
 * A temp repo on the sample config, the four keys dropped, `set` set, in the folder
 * form (else risa.json), with the rule files named in `have` under .risa/.
 * @param {string} name
 * @param {{ folder?: boolean, have?: string[], set?: Record<string, string> }} [opts]
 */
function repo(name, { folder = true, have = Object.keys(RULES), set = {} } = {}) {
  const raw = JSON.parse(readFileSync(SAMPLE_CONFIG, "utf8"));
  for (const key of KEYS) delete raw.paths[key];
  Object.assign(raw.paths, set);
  const config = join(tmp, `${name}.json`);
  writeFileSync(config, JSON.stringify(raw, null, 2));
  const main = join(tmp, name);
  makeRepo(main, { config });
  mkdirSync(join(main, CONFIG_DIR), { recursive: true });
  if (folder) renameSync(join(main, CONFIG_NAME), join(main, CONFIG_DIR, CONFIG_FILE));
  for (const file of have) writeFileSync(join(main, CONFIG_DIR, file), RULES[file]);
  for (const rel of Object.values(set)) {
    mkdirSync(dirname(join(main, rel)), { recursive: true });
    copyFileSync(
      join(SAMPLE_TOOLS, rel.endsWith("tiers.json") ? "tiers.json" : "check-plan-rules.json"),
      join(main, rel),
    );
  }
  return { main, file: join(main, folder ? `${CONFIG_DIR}/${CONFIG_FILE}` : CONFIG_NAME) };
}

/** A child's env in REPO: no pinned config (it finds the repo's own), no machine config. */
const childEnv = () => {
  const env = { ...process.env, RISA_MACHINE_CONFIG: "" };
  delete env.RISA_CONFIG;
  delete env.RISA_CONFIG_FOUND;
  return env;
};
const run = (/** @type {string} */ main, /** @type {string} */ cmd, /** @type {string[]} */ args) =>
  spawnSync(cmd, args, { cwd: main, encoding: "utf8", env: childEnv() });

const DEFAULTS = {
  tierData: ".risa/tiers.json",
  checkPlanRules: ".risa/check-plan.json",
  brakeList: ".risa/brake-list.txt",
  quarantine: ".risa/quarantine.txt",
};

describe("the folder form's rule files by name", () => {
  it("names the four files", () => {
    expect(Object.fromEntries(RULE_FILES.map(([key, name]) => [key, `${CONFIG_DIR}/${name}`]))).toEqual(
      DEFAULTS,
    );
  });

  it("fills each unset key whose file is there, in loadConfig and dump, and leaves the file alone", () => {
    const { main, file } = repo("all");
    const before = readFileSync(file, "utf8");
    expect(loadConfig({ path: file }).config.paths).toMatchObject(DEFAULTS);
    const dump = run(main, process.execPath, ["loops/config.mjs", "dump"]);
    expect(dump.status, dump.stderr).toBe(0);
    for (const [key, rel] of Object.entries(DEFAULTS))
      expect(dump.stdout).toContain(`\npaths.${key}=${rel}\n`);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("leaves a key unset when its file is missing", () => {
    const { file } = repo("some", { have: ["tiers.json", "quarantine.txt"] });
    const { paths } = loadConfig({ path: file }).config;
    expect(paths.tierData).toBe(DEFAULTS.tierData);
    expect(paths.quarantine).toBe(DEFAULTS.quarantine);
    expect(paths).not.toHaveProperty("checkPlanRules");
    expect(paths).not.toHaveProperty("brakeList");
  });

  it("keeps a set key's own path", () => {
    const { file } = repo("set", {
      set: { tierData: "tools/tiers.json", checkPlanRules: "tools/rules.json" },
    });
    const { paths } = loadConfig({ path: file }).config;
    expect(paths.tierData).toBe("tools/tiers.json");
    expect(paths.checkPlanRules).toBe("tools/rules.json");
    expect(paths.brakeList).toBe(DEFAULTS.brakeList);
  });

  it("gives the risa.json form none, with the same files in .risa/", () => {
    const { main, file } = repo("old", { folder: false });
    const { paths } = loadConfig({ path: file }).config;
    for (const key of KEYS) expect(paths).not.toHaveProperty(key);
    const dump = run(main, process.execPath, ["loops/config.mjs", "dump"]);
    expect(dump.status, dump.stderr).toBe(0);
    for (const key of KEYS) expect(dump.stdout).not.toContain(`paths.${key}=`);
  });

  it("is what the tier data, the check plan and lib.sh's CI lists read", () => {
    const { main, file } = repo("readers");
    const project = loadConfig({ path: file });
    expect(tierData(project).TIERS).toEqual(JSON.parse(RULES["tiers.json"]).tiers);
    // The sample's rules: web/ is the test tier, a migration the suite's (e2e).
    const plan = checkPlanFor(project);
    expect(plan.proposeTier(["web/a.js"]).tier).toBe("test");
    expect(plan.proposeTier(["db/migrations/1.sql"]).tier).toBe("e2e");
    expect(plan.isCiList(DEFAULTS.brakeList) && plan.isCiList(DEFAULTS.quarantine)).toBe(true);
    const lists = run(main, "bash", ["-c", 'source loops/lib.sh && printf "%s\\n" "${ci_lists[@]}"']);
    expect(lists.status, lists.stderr).toBe(0);
    expect(lists.stdout).toBe(`${DEFAULTS.brakeList}\n${DEFAULTS.quarantine}\n`);
  });
});
