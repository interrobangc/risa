// The flavor packs (flavor.mjs): the pools, the stable persona, the admiral draw,
// the label and prompt line, the machine config's key, and the CLI.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_FLAVOR,
  FLAVORS,
  ROLES,
  drawAdmiral,
  flavorLine,
  flavorOf,
  label,
  namesOf,
  personaFor,
  poolOf,
  sessionPersona,
} from "./flavor.mjs";
import { machineProblems } from "./machine.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "flavor-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A random source that returns these numbers in turn. */
const fixed =
  (...xs) =>
  () =>
    xs.shift() ?? 0;

describe("the starfleet pack", () => {
  it("gives every role a non-empty pool of single-word names, no name in two roles", () => {
    /** @type {Map<string, string>} */
    const owner = new Map();
    for (const role of ROLES) {
      const pool = poolOf(role, "starfleet");
      expect(pool.length, role).toBeGreaterThan(0);
      for (const { rank, name } of pool) {
        expect(name).toMatch(/^[A-Z][A-Za-z]+$/);
        expect(rank).toMatch(/^[A-Z][a-z]+(?: [A-Z][a-z]+)*$/);
        expect(owner.get(name) ?? role, `${name} in ${owner.get(name)} and ${role}`).toBe(role);
        owner.set(name, role);
      }
      expect(new Set(namesOf(role)).size).toBe(pool.length);
    }
  });

  it("ranks the backlog's admirals and the orchestrators' captains; the inbox's entries carry their own", () => {
    expect(new Set(poolOf("backlog").map((p) => p.rank))).toEqual(new Set(["Admiral"]));
    expect(new Set(poolOf("prd").map((p) => p.rank))).toEqual(new Set(["Captain"]));
    expect(new Set(poolOf("inbox").map((p) => p.rank)).size).toBeGreaterThan(1);
  });

  it("is the default, and the machine config's flavor picks one", () => {
    expect(DEFAULT_FLAVOR).toBe("starfleet");
    expect([...FLAVORS].sort()).toEqual(["none", "starfleet"]);
    expect(flavorOf(null)).toBe("starfleet");
    expect(flavorOf({})).toBe("starfleet");
    expect(flavorOf({ flavor: "none" })).toBe("none");
    expect(flavorOf({ flavor: "starfleet" })).toBe("starfleet");
  });
});

describe("personaFor", () => {
  it("is the same for a name every time, from the role's pool", () => {
    for (const role of ROLES)
      for (const name of ["prd-risa-next", "inbox", "hotfix-login", "x"]) {
        const p = personaFor(role, name);
        expect(poolOf(role)).toContainEqual(p);
        for (let i = 0; i < 3; i++) expect(personaFor(role, name)).toEqual(p);
      }
    expect(personaFor("prd", "prd-risa-next")).toEqual(personaFor("prd", "prd-risa-next", "starfleet"));
  });

  it("spreads names over the pool", () => {
    for (const role of ROLES) {
      const pool = poolOf(role);
      const seen = new Set(
        Array.from({ length: 200 }, (_, i) => personaFor(role, `${role}-topic-${i}`)?.name),
      );
      expect(seen.size, role).toBeGreaterThanOrEqual(Math.ceil(pool.length * 0.75));
    }
  });

  it("is null under none, and for a role the pack doesn't name", () => {
    for (const role of ROLES) expect(personaFor(role, "prd-x", "none")).toBeNull();
    expect(personaFor("dispatcher", "x")).toBeNull();
    expect(personaFor("constructor", "x")).toBeNull();
  });
});

describe("sessionPersona", () => {
  it("wears the backlog's drawn admiral with the pool's rank; personaFor for every other role", () => {
    expect(sessionPersona("backlog", "Janeway")).toEqual({ rank: "Admiral", name: "Janeway" });
    for (const name of ["", "backlog", "Pi card", "$(x)", "backlog - triage"])
      expect(sessionPersona("backlog", name), name).toBeNull();
    expect(sessionPersona("backlog", "Janeway", "none")).toBeNull();
    expect(sessionPersona("prd", "prd-t")).toEqual(personaFor("prd", "prd-t"));
    expect(sessionPersona("inbox", "inbox", "none")).toBeNull();
  });
});

describe("drawAdmiral", () => {
  it("draws from the backlog's admirals, never the last one", () => {
    const admirals = namesOf("backlog");
    for (const last of [...admirals, null, "Picard"])
      for (let i = 0; i < admirals.length; i++) {
        const a = drawAdmiral(last, fixed(i / admirals.length));
        expect(admirals).toContain(a);
        expect(a).not.toBe(last);
      }
    for (let i = 0; i < 50; i++) expect(drawAdmiral("Ross")).not.toBe("Ross");
    expect(drawAdmiral(null, fixed(0))).toBe(admirals[0]);
    expect(drawAdmiral(null, fixed(1))).toBe(admirals.at(-1));
  });

  it("is the bare backlog under none", () => {
    expect(drawAdmiral(null, Math.random, "none")).toBe("backlog");
    expect(drawAdmiral("backlog", Math.random, "none")).toBe("backlog");
  });
});

describe("label and flavorLine", () => {
  it("labels a persona Rank Name, and no persona with nothing", () => {
    expect(label({ rank: "Captain", name: "Sisko" })).toBe("Captain Sisko");
    expect(label({ rank: "Lieutenant Commander", name: "Scott" })).toBe("Lieutenant Commander Scott");
    expect(label(null)).toBe("");
  });

  it("names the persona, the address and where the flavor never goes", () => {
    const persona = personaFor("prd", "prd-risa-next");
    const line = flavorLine("prd", persona);
    expect(line.startsWith(`- You are ${label(persona)}: `)).toBe(true);
    expect(line).toContain("your replies to the user");
    expect(line).toContain("address the user as Fleet Admiral");
    expect(line).toContain("never inside questions, options or commands");
    expect(line.split("\n")).toHaveLength(1);
  });

  it("is empty under none, with no persona, or for a role the pack doesn't name", () => {
    expect(flavorLine("prd", personaFor("prd", "prd-x", "none"), "none")).toBe("");
    expect(flavorLine("prd", { rank: "Captain", name: "Sisko" }, "none")).toBe("");
    expect(flavorLine("prd", null)).toBe("");
    expect(flavorLine("dispatcher", { rank: "Captain", name: "Sisko" })).toBe("");
  });
});

describe("the machine config's flavor", () => {
  it("accepts starfleet and none, and refuses anything else", () => {
    expect(machineProblems({ flavor: "starfleet", repos: [] })).toEqual([]);
    expect(machineProblems({ flavor: "none", repos: [] })).toEqual([]);
    expect(machineProblems({ repos: [] })).toEqual([]);
    expect(machineProblems({ flavor: "klingon", repos: [] })).toEqual([
      "flavor: must be one of starfleet, none",
    ]);
    expect(machineProblems({ flavor: true, repos: [] })).toEqual(["flavor: must be one of starfleet, none"]);
  });
});

describe("the CLI", () => {
  /** @param {string[]} args @param {string | undefined} [machine] a machine config's JSON */
  const cli = (args, machine) => {
    let env = { ...process.env, RISA_MACHINE_CONFIG: "" };
    if (machine !== undefined) {
      const file = join(root, `machine-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(file, machine);
      env = { ...env, RISA_MACHINE_CONFIG: file };
    }
    return spawnSync("node", [join(HERE, "flavor.mjs"), ...args], { encoding: "utf8", env });
  };

  it("prints a persona, a label and a line for a role and session name", () => {
    const p = /** @type {{ rank: string, name: string }} */ (personaFor("hotfix", "hotfix-login"));
    expect(cli(["persona", "hotfix", "hotfix-login"])).toMatchObject({
      status: 0,
      stdout: `${p.rank}\t${p.name}\n`,
    });
    expect(cli(["label", "hotfix", "hotfix-login"]).stdout).toBe(`${label(p)}\n`);
    expect(cli(["line", "hotfix", "hotfix-login"]).stdout).toBe(`${flavorLine("hotfix", p)}\n`);
  });

  it("prints nothing under a machine config's none; a config that doesn't load reads as starfleet", () => {
    const none = JSON.stringify({ flavor: "none", repos: [] });
    for (const verb of ["persona", "label", "line"])
      expect(cli([verb, "prd", "prd-x"], none)).toMatchObject({ status: 0, stdout: "" });
    expect(cli(["label", "prd", "prd-x"], "{ not json").stdout).toBe(
      `${label(personaFor("prd", "prd-x"))}\n`,
    );
  });

  it("refuses a bad verb, an unknown role or no name", () => {
    for (const args of [[], ["who", "prd", "x"], ["label", "dispatcher", "x"], ["label", "prd"]])
      expect(cli(args).status).toBe(2);
  });
});
