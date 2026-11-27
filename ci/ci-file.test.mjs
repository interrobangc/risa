// `ci zone-file` against a finished item: a landed or dropped item whose fix the
// tested commit lacks takes the run as a note; one whose fix is in it is a new failure.
import { describe, expect, it } from "vitest";

import { fileZoneVerdict } from "./ci-file.mjs";
import { EXIT } from "./ci-io.mjs";
import { applyFindings, findingKey, keyMark } from "./filing.mjs";

const TESTED = "c".repeat(40);
const FIX = "f".repeat(40);
const ZONE = "Pacific/Auckland";
const FILE = "src/a.browser.test.tsx";
const KEY = findingKey({ file: FILE, name: `second zone ${ZONE}` });
const verdict = { commit: TESTED, secondZone: { zone: ZONE, mode: "report", files: [FILE] } };

/**
 * A backlog of one finished item for the zone's file, filed through fileZoneVerdict.
 * @param {{ status: string, commit?: string }} old
 * @param {string[]} fixesIn the fix commits the tested commit contains
 */
function file(old, fixesIn) {
  const b = { items: [{ id: "X-1", title: "old", notes: `${keyMark(KEY)} first`, ...old }] };
  /** @type {{ item: string, commit: string }[]} */ const asked = [];
  const write = {
    add: (/** @type {any} */ f) => {
      const item = { id: `X-${b.items.length + 1}`, title: f.title, status: "triaged", notes: f.note };
      b.items.push(item);
      return item;
    },
    note: (/** @type {any} */ item, /** @type {string} */ text) => {
      item.notes += `\n${text}`;
    },
    hasFix: (/** @type {any} */ item, /** @type {string} */ commit) => {
      asked.push({ item: item.id, commit });
      return fixesIn.includes(item.commit);
    },
  };
  /** @type {string[]} */ const lines = [];
  const io = /** @type {any} */ ({
    log: (/** @type {string} */ line) => lines.push(line),
    fileFindings: (/** @type {any[]} */ findings) => applyFindings(b, null, findings, write),
  });
  const code = fileZoneVerdict(verdict, { url: "https://ci.example/run/7" }, io);
  return { b, code, lines, asked };
}

describe("zone filing on a finished item", () => {
  it("notes a landed item whose fix the tested commit lacks", () => {
    const { b, code, lines, asked } = file({ status: "landed", commit: FIX }, []);
    expect(code).toBe(EXIT.green);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]?.notes).toContain("https://ci.example/run/7");
    expect(b.items[0]?.notes).toContain("Its fix isn't in the tested commit.");
    expect(asked).toEqual([{ item: "X-1", commit: TESTED }]);
    expect(lines).toEqual(["  on X-1"]);
  });

  it("files a new item, naming the old, when the fix is in the tested commit", () => {
    const { b, lines } = file({ status: "landed", commit: FIX }, [FIX]);
    expect(b.items).toHaveLength(2);
    expect(b.items[0]?.notes).toBe(`${keyMark(KEY)} first`);
    expect(b.items[1]?.notes).toContain(keyMark(KEY));
    expect(b.items[1]?.notes).toContain("Fails again with X-1's fix in.");
    expect(lines).toEqual(["  filed X-2"]);
  });

  it("notes a dropped item, which has no fix", () => {
    const { b, asked } = file({ status: "dropped" }, []);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]?.notes).toContain("[ci-zone cccccccc]");
    expect(asked).toEqual([]);
  });

  it("writes nothing new on a rerun of the same commit", () => {
    const { b } = file({ status: "landed", commit: FIX }, []);
    const wrote = () => {
      throw new Error("wrote on a rerun");
    };
    const io = /** @type {any} */ ({
      log: () => {},
      fileFindings: (/** @type {any[]} */ f) =>
        applyFindings(b, null, f, { add: wrote, note: wrote, hasFix: () => false }),
    });
    expect(fileZoneVerdict(verdict, { url: "https://ci.example/run/7" }, io)).toBe(EXIT.green);
  });
});
