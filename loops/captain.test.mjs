// The main backlog session's captain (captain.mjs): the pure pick, the record it reads, the CLI.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CAPTAINS, CAPTAIN_SESSION, isCaptain, lastCaptain, nextCaptain, pickCaptain } from "./captain.mjs";
import { writeRecord } from "./sessions.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "captain-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A random source that returns these numbers in turn. */
const fixed =
  (...xs) =>
  () =>
    xs.shift() ?? 0;

describe("the pool", () => {
  it("holds the ten captains, and only the main backlog session gets one", () => {
    expect([...CAPTAINS]).toEqual([
      "Archer",
      "April",
      "Pike",
      "Kirk",
      "Decker",
      "Harriman",
      "Garrett",
      "Picard",
      "Shelby",
      "Riker",
    ]);
    expect(CAPTAIN_SESSION).toBe("backlog");
    expect(isCaptain("Picard")).toBe(true);
    for (const n of ["backlog", "picard", "backlog - x", "", undefined]) expect(isCaptain(n)).toBe(false);
  });
});

describe("pickCaptain", () => {
  it("is deterministic with a fixed random source", () => {
    expect(pickCaptain(null, fixed(0))).toBe("Archer");
    expect(pickCaptain(null, fixed(0.99))).toBe("Riker");
    expect(pickCaptain(null, fixed(0.75))).toBe("Picard");
    expect(pickCaptain("Archer", fixed(0))).toBe("April");
    expect(pickCaptain("Pike", fixed(0.3))).toBe("Kirk");
  });

  it("never picks the last one", () => {
    for (const last of CAPTAINS)
      for (let i = 0; i < 9; i++) {
        const c = pickCaptain(last, fixed(i / 9));
        expect(CAPTAINS).toContain(c);
        expect(c).not.toBe(last);
      }
  });

  it("with no last one (or one that isn't a captain), can pick any of the ten", () => {
    for (const last of [null, undefined, "backlog"]) {
      const seen = new Set(CAPTAINS.map((_, i) => pickCaptain(last, fixed(i / 10))));
      expect(seen).toEqual(new Set(CAPTAINS));
    }
  });

  it("stays in the pool at the random source's edges", () => {
    expect(pickCaptain("Riker", fixed(0.999999))).toBe("Shelby");
    expect(pickCaptain(null, fixed(-1))).toBe("Archer");
    expect(pickCaptain(null, fixed(1))).toBe("Riker");
  });
});

describe("the last captain, from the backlog record", () => {
  it("is the record's Remote Control name when it is a captain", () => {
    const dir = join(root, "a");
    expect(lastCaptain(dir)).toBeNull();
    writeRecord(dir, "backlog", { kind: "backlog", remote: "backlog" });
    expect(lastCaptain(dir)).toBeNull();
    writeRecord(dir, "backlog", { remote: "Shelby" });
    expect(lastCaptain(dir)).toBe("Shelby");
    // A backlog-<name> record is never read.
    writeRecord(dir, "backlog-x", { kind: "backlog", remote: "Kirk" });
    expect(lastCaptain(dir)).toBe("Shelby");
    for (let i = 0; i < 20; i++) expect(nextCaptain(dir)).not.toBe("Shelby");
  });

  it("the CLI prints a new one unlike the record's", () => {
    const dir = join(root, "b");
    writeRecord(dir, "backlog", { kind: "backlog", remote: "Decker" });
    for (let i = 0; i < 5; i++) {
      const r = spawnSync("node", [join(HERE, "captain.mjs"), "next"], {
        encoding: "utf8",
        env: { ...process.env, RISA_SESSIONS_DIR: dir },
      });
      expect(r.status).toBe(0);
      const c = r.stdout.trim();
      expect(CAPTAINS).toContain(c);
      expect(c).not.toBe("Decker");
    }
    expect(spawnSync("node", [join(HERE, "captain.mjs")], { encoding: "utf8" }).status).toBe(2);
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
