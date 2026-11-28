// The main backlog session's name (captain.mjs): the pack's admirals, the pure pick, the record it reads, the CLI.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  CAPTAINS,
  CAPTAIN_SESSION,
  isCaptain,
  lastCaptain,
  machineHeld,
  machinePersona,
  nextCaptain,
  pickCaptain,
  wornBy,
} from "./captain.mjs";
import { namesOf, personaFor } from "./flavor.mjs";
import { processOf, readRecord, writeRecord } from "./sessions.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "captain-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A random source that returns these numbers in turn. */
const fixed =
  (...xs) =>
  () =>
    xs.shift() ?? 0;

const ADMIRALS = namesOf("backlog");

describe("the pool", () => {
  it("is the pack's admirals; the captains from before stay known, and only the main backlog session gets one", () => {
    expect(ADMIRALS).toEqual([
      "Nechayev",
      "Ross",
      "Cartwright",
      "Nogura",
      "Komack",
      "Marcus",
      "Satie",
      "Hayes",
      "Quinn",
      "Morrow",
    ]);
    expect(CAPTAINS).toContain("Picard");
    expect(CAPTAIN_SESSION).toBe("backlog");
    for (const n of ["Picard", "Ross"]) expect(isCaptain(n)).toBe(true);
    for (const n of ["backlog", "picard", "Sisko", "backlog - x", "", undefined])
      expect(isCaptain(n)).toBe(false);
  });
});

describe("pickCaptain", () => {
  it("is deterministic with a fixed random source", () => {
    expect(pickCaptain(null, fixed(0))).toBe("Nechayev");
    expect(pickCaptain(null, fixed(0.99))).toBe("Morrow");
    expect(pickCaptain(null, fixed(0.75))).toBe("Hayes");
    expect(pickCaptain("Nechayev", fixed(0))).toBe("Ross");
    expect(pickCaptain("Nogura", fixed(0.3))).toBe("Cartwright");
  });

  it("never picks the last one", () => {
    for (const last of ADMIRALS)
      for (let i = 0; i < 9; i++) {
        const c = pickCaptain(last, fixed(i / 9));
        expect(ADMIRALS).toContain(c);
        expect(c).not.toBe(last);
      }
  });

  it("with no last one (or one from before the packs), can pick any admiral", () => {
    for (const last of [null, undefined, "backlog", "Picard"]) {
      const seen = new Set(ADMIRALS.map((_, i) => pickCaptain(last, fixed(i / 10))));
      expect(seen).toEqual(new Set(ADMIRALS));
    }
  });

  it("stays in the pool at the random source's edges", () => {
    expect(pickCaptain("Morrow", fixed(0.999999))).toBe("Quinn");
    expect(pickCaptain(null, fixed(-1))).toBe("Nechayev");
    expect(pickCaptain(null, fixed(1))).toBe("Morrow");
  });

  it("under none, is the bare backlog", () => {
    for (const last of [null, "backlog", "Ross"])
      expect(pickCaptain(last, fixed(0.5), "none")).toBe("backlog");
  });
});

describe("the last captain, from the backlog record", () => {
  it("is the record's Remote Control name when it is a captain", () => {
    const dir = join(root, "a");
    expect(lastCaptain(dir)).toBeNull();
    writeRecord(dir, "backlog", { kind: "backlog", remote: "backlog" });
    expect(lastCaptain(dir)).toBeNull();
    // A captain from before the packs still reads as the last one.
    writeRecord(dir, "backlog", { remote: "Shelby" });
    expect(lastCaptain(dir)).toBe("Shelby");
    for (let i = 0; i < 5; i++) expect(ADMIRALS).toContain(nextCaptain(dir));
    writeRecord(dir, "backlog", { remote: "Ross" });
    expect(lastCaptain(dir)).toBe("Ross");
    for (let i = 0; i < 20; i++) expect(nextCaptain(dir)).not.toBe("Ross");
    writeRecord(dir, "backlog", { remote: "Shelby" });
    // A backlog-<name> record is never read.
    writeRecord(dir, "backlog-x", { kind: "backlog", remote: "Kirk" });
    expect(lastCaptain(dir)).toBe("Shelby");
    for (let i = 0; i < 20; i++) expect(nextCaptain(dir)).not.toBe("Shelby");
  });

  it("the CLI prints a new admiral unlike the record's", () => {
    const dir = join(root, "b");
    writeRecord(dir, "backlog", { kind: "backlog", remote: "Komack" });
    for (let i = 0; i < 5; i++) {
      const r = spawnSync("node", [join(HERE, "captain.mjs"), "next"], {
        encoding: "utf8",
        env: { ...process.env, RISA_SESSIONS_DIR: dir },
      });
      expect(r.status).toBe(0);
      const c = r.stdout.trim();
      expect(ADMIRALS).toContain(c);
      expect(c).not.toBe("Komack");
    }
    expect(spawnSync("node", [join(HERE, "captain.mjs")], { encoding: "utf8" }).status).toBe(2);
  });

  it("the CLI under a machine config's none prints the bare backlog", () => {
    const dir = join(root, "c");
    const machine = join(root, "machine-none.json");
    writeFileSync(machine, JSON.stringify({ flavor: "none", repos: [] }));
    writeRecord(dir, "backlog", { kind: "backlog", remote: "backlog" });
    const r = spawnSync("node", [join(HERE, "captain.mjs"), "next"], {
      encoding: "utf8",
      env: { ...process.env, RISA_SESSIONS_DIR: dir, RISA_MACHINE_CONFIG: machine },
    });
    expect(r.stdout.trim()).toBe("backlog");
  });
});

describe("names held on the machine (RISA-1063)", () => {
  // Two fictional projects on one machine config, each with its records' folder.
  const machineRoot = join(root, "machine");
  const repoA = join(machineRoot, "harbor");
  const repoB = join(machineRoot, "lantern");
  const sessionsOf = (/** @type {string} */ repo) => join(repo, ".loops", ".sessions");
  const machine = { path: join(machineRoot, "machine.json"), repos: [{ path: repoA }, { path: repoB }] };
  writeFileSync(join(root, "machine-two.json"), JSON.stringify({ repos: machine.repos }));
  // A record live for sessions.mjs's isLive: this process, at its start.
  const self = processOf(process.pid);
  const live = { pid: process.pid, started: new Date(self?.startedMs ?? Date.now()).toISOString() };
  const saved = process.env.RISA_MACHINE_CONFIG;
  afterEach(() => {
    process.env.RISA_MACHINE_CONFIG = saved;
  });

  it("are the live records' of every repo the config lists, never SELF's nor an ended one's", () => {
    writeRecord(sessionsOf(repoB), "backlog", { kind: "backlog", remote: "Cartwright", ...live });
    writeRecord(sessionsOf(repoB), "prd-account-security", { kind: "prd", ...live });
    writeRecord(sessionsOf(repoB), "prd-old", { kind: "prd", ...live, ended: "2026-11-01T00:00:00Z" });
    writeRecord(sessionsOf(repoB), "backlog-triage", { kind: "backlog", remote: "Ross", ...live });
    writeRecord(sessionsOf(repoA), "plan-x", { kind: "plan", persona: "Kira", ...live });
    writeRecord(sessionsOf(repoA), "prd-stale", { kind: "prd", pid: 999999, started: live.started });
    const held = machineHeld({ machine, self: { dir: sessionsOf(repoA), name: "plan-x" } });
    expect(held).toContain("Cartwright");
    expect(held).toContain(personaFor("prd", "prd-account-security")?.name);
    // Not the ended, the stale-pid or the backlog-<name> request session's.
    expect(held).not.toContain("Ross");
    expect(held).not.toContain("Kira");
    expect(held).toHaveLength(2);
    expect(machineHeld({ machine })).toContain("Kira");
    expect(machineHeld({ machine: null })).toEqual([]);
    expect(wornBy("backlog-triage", { kind: "backlog", remote: "Ross" })).toBeNull();
    expect(wornBy("prd-t", { kind: "prd", persona: "Shaw" })).toBe("Shaw");
  });

  it("the admiral draw never returns one another project's live backlog session holds", () => {
    process.env.RISA_MACHINE_CONFIG = join(root, "machine-two.json");
    writeRecord(sessionsOf(repoB), "backlog", { kind: "backlog", remote: "Cartwright", ...live });
    writeRecord(sessionsOf(repoA), "backlog", { kind: "backlog", remote: "Ross" });
    for (let i = 0; i < 10; i++) {
      const c = nextCaptain(sessionsOf(repoA), fixed(i / 10), "starfleet");
      expect(ADMIRALS).toContain(c);
      expect(["Cartwright", "Ross"]).not.toContain(c);
    }
    // This project's own record is never one held: its admiral is only the last one.
    writeRecord(sessionsOf(repoA), "backlog", { kind: "backlog", remote: "Ross", ...live });
    for (let i = 0; i < 10; i++) expect(nextCaptain(sessionsOf(repoA), fixed(i / 10))).not.toBe("Ross");
    // Every admiral held: still one, unlike the last.
    const all = ADMIRALS.map((n) => ({ kind: "prd", persona: n }));
    all.forEach((r, i) => writeRecord(sessionsOf(repoB), `prd-all-${i}`, { ...r, ...live }));
    expect(pickCaptain("Ross", fixed(0), "starfleet", ADMIRALS)).toBe("Nechayev");
    for (let i = 0; i < 10; i++) {
      const c = nextCaptain(sessionsOf(repoA), fixed(i / 10), "starfleet");
      expect(ADMIRALS).toContain(c);
      expect(c).not.toBe("Ross");
    }
    all.forEach((_, i) => writeRecord(sessionsOf(repoB), `prd-all-${i}`, { ended: "2026-11-01T00:00:00Z" }));
    expect(nextCaptain(sessionsOf(repoA), fixed(0), "none")).toBe("backlog");
  });

  it("a PRD whose hashed captain another project's live session holds gets another, and keeps it", () => {
    const name = "prd-harbor-docks";
    const hashed = /** @type {{ name: string }} */ (personaFor("prd", name)).name;
    const mine = sessionsOf(repoA);
    // Another project's live session with the same name holds the hashed captain.
    writeRecord(sessionsOf(repoB), name, { kind: "prd", ...live });
    const p = machinePersona("prd", name, "starfleet", { sessions: mine, machine });
    expect(p?.rank).toBe("Captain");
    expect(p?.name).not.toBe(hashed);
    // Not started yet: nothing kept, the same draw every time.
    expect(readRecord(mine, name)).toBeNull();
    expect(machinePersona("prd", name, "starfleet", { sessions: mine, machine })).toEqual(p);
    // Started: its record keeps the stepped one, which stays when the holder ends.
    writeRecord(mine, name, { kind: "prd", ...live });
    expect(machinePersona("prd", name, "starfleet", { sessions: mine, machine })).toEqual(p);
    expect(readRecord(mine, name)?.persona).toBe(p?.name);
    writeRecord(sessionsOf(repoB), name, { ended: "2026-11-01T00:00:00Z" });
    for (let i = 0; i < 3; i++)
      expect(machinePersona("prd", name, "starfleet", { sessions: mine, machine })).toEqual(p);
    // Its own live record never holds a name against it.
    expect(machineHeld({ machine, self: { dir: mine, name } })).not.toContain(p?.name);
    // A newcomer elsewhere steps past the kept one too.
    writeRecord(sessionsOf(repoB), name, { kind: "prd", ...live, ended: undefined });
    expect(machinePersona("prd", name, "starfleet", { sessions: sessionsOf(repoB), machine })?.name).not.toBe(
      p?.name,
    );
  });

  it("with every captain held, still one; under none, none; with no machine config, the hash", () => {
    const name = "prd-lantern-wicks";
    const all = namesOf("prd");
    all.forEach((n, i) =>
      writeRecord(sessionsOf(repoB), `prd-cap-${i}`, { kind: "prd", persona: n, ...live }),
    );
    const p = machinePersona("prd", name, "starfleet", { sessions: sessionsOf(repoA), machine });
    expect(p).toEqual(personaFor("prd", name));
    expect(machinePersona("prd", name, "none", { sessions: sessionsOf(repoA), machine })).toBeNull();
    expect(machinePersona("prd", name, "starfleet", { sessions: null, machine: null })).toEqual(
      personaFor("prd", name),
    );
    expect(machinePersona("backlog", "Morrow", "starfleet", { machine })).toEqual({
      rank: "Admiral",
      name: "Morrow",
    });
    all.forEach((_, i) => writeRecord(sessionsOf(repoB), `prd-cap-${i}`, { ended: "2026-11-01T00:00:00Z" }));
  });
});
