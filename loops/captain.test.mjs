// The main backlog session's name (captain.mjs): the pack's admirals, the pure pick, the record it reads, the CLI.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CAPTAINS, CAPTAIN_SESSION, isCaptain, lastCaptain, nextCaptain, pickCaptain } from "./captain.mjs";
import { namesOf } from "./flavor.mjs";
import { writeRecord } from "./sessions.mjs";

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

describe("the backlog prompt's captain line", () => {
  const prompt = (/** @type {string | undefined} */ captain) =>
    spawnSync("bash", [join(HERE, "prompt.sh"), "backlog"], {
      encoding: "utf8",
      env: { ...process.env, RISA_CAPTAIN: captain ?? "" },
    }).stdout;

  it("names the captain when one is drawn, with its limits", () => {
    const out = prompt("Picard");
    expect(out).toContain("- You are Captain Picard: let a light touch of their manner color your replies");
    expect(out).toContain("never inside questions, options or commands");
  });

  it("adds nothing with no captain, or with something that isn't a name", () => {
    for (const c of [undefined, "", "Pi card", "$(x)"]) expect(prompt(c)).not.toContain("You are Captain");
  });
});
