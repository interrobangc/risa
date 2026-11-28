// The home gate between ticks (RISA-1083): a running dispatcher stats its config each
// tick and gates a project moved to an inbox store. Pure: no dispatch fixture repo.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHome, refreshHome, runLoop } from "./dispatch.mjs";
import { FIXTURE_CONFIG } from "./config-fixture.mjs";

describe("the home gate between ticks (RISA-1083)", () => {
  const STOP = new Error("stop");
  /** @type {string} */
  let dir;
  /** @type {string} */
  let cfg;
  /** @type {NodeJS.ProcessEnv} */
  let env;
  const writeConfig = (/** @type {boolean} */ inbox) => {
    const c = JSON.parse(readFileSync(FIXTURE_CONFIG, "utf8"));
    if (inbox) c.inbox = { repo: "git@example.invalid:fictional/inbox.git" };
    else delete c.inbox;
    writeFileSync(cfg, JSON.stringify(c, null, 2));
  };
  /** Ticks the loop TICKS times; CHANGE(n) runs in the sleep after tick n; each tick's home and the reads. */
  const drive = async (ticks, change = (/** @type {number} */ _n) => {}) => {
    const homes = [];
    let reads = 0;
    const load = (/** @type {NodeJS.ProcessEnv} */ e) => (reads++, loadHome(e));
    const end = await runLoop({
      every: 60,
      started: null,
      current: () => null,
      step: async () => void homes.push(await refreshHome(env, load)),
      sleep: async () => {
        if (homes.length >= ticks) throw STOP;
        change(homes.length);
      },
    }).catch((e) => (e === STOP ? "ran on" : Promise.reject(e)));
    expect(end).toBe("ran on");
    return { homes, reads };
  };
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-home-")));
    cfg = join(dir, "risa.json");
    env = { ...process.env, RISA_CONFIG: cfg };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a dispatcher started with no inbox group gates from the first tick after it appears", async () => {
    writeConfig(false);
    expect(await loadHome(env)).toBeNull();
    const { homes, reads } = await drive(4, (n) => n === 2 && writeConfig(true));
    expect(homes.slice(0, 2)).toEqual([null, null]);
    expect(typeof homes[2]?.homeTick).toBe("function");
    expect(homes[3]).toBe(homes[2]);
    // Read once: the tick after the change; the unchanged ticks only stat the file.
    expect(reads).toBe(1);
    // The group gone again: the gate drops the same way.
    writeConfig(false);
    expect(await refreshHome(env)).toBeNull();
  });

  it("one whose group was there at start stays gated, reading nothing again", async () => {
    writeConfig(true);
    const home = await loadHome(env);
    expect(typeof home?.homeTick).toBe("function");
    const { homes, reads } = await drive(3);
    expect(homes).toEqual([home, home, home]);
    expect(reads).toBe(0);
  });

  it("a config that doesn't load keeps the gate and is read again next tick", async () => {
    writeConfig(true);
    const home = await loadHome(env);
    writeFileSync(cfg, "{ half");
    expect(await refreshHome(env)).toBe(home);
    writeConfig(false);
    expect(await refreshHome(env)).toBeNull();
  });
});
