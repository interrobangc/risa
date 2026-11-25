// The core's copy of the lists parser: the quarantine, with the project's backlog
// ids, and the project's real list (paths.quarantine) through it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { backlogIds, loadConfig } from "../loops/config.mjs";
import { isQuarantined, parseQuarantine } from "./ci-lists.mjs";

const id = backlogIds().id(1);
const entry = { file: "a/b.test.ts", name: "suite breaks", item: id };

describe("the quarantine", () => {
  it("reads tab-separated lines and refuses a broken one", () => {
    expect(parseQuarantine(`# header\n\na/b.test.ts\tsuite breaks\t${id}\n`)).toEqual([entry]);
    expect(() => parseQuarantine("a/b.test.ts\tno item")).toThrow(/needs/);
    expect(() => parseQuarantine("a/b.test.ts\tname\tnot-an-item")).toThrow(/needs/);
  });

  it("takes the items' ids from the project's prefix", () => {
    const ids = backlogIds({ backlog: { idPrefix: "RISA" } });
    expect(parseQuarantine("a.test.ts\tname\tRISA-7", ids)).toEqual([
      { file: "a.test.ts", name: "name", item: "RISA-7" },
    ]);
    expect(() => parseQuarantine("a.test.ts\tname\tB-7", ids)).toThrow(/<RISA-n>/);
    expect(() => parseQuarantine("a.test.ts\tname\trisa-7", ids)).toThrow(/needs/);
  });

  it("matches a test by file and full name, from a relative or absolute path", () => {
    expect(isQuarantined([entry], "a/b.test.ts", "suite breaks")).toBe(true);
    expect(isQuarantined([entry], "/repo/a/b.test.ts", "suite breaks")).toBe(true);
    expect(isQuarantined([entry], "/repo/xa/b.test.ts", "suite breaks")).toBe(false);
    expect(isQuarantined([entry], "a/b.test.ts", "suite other")).toBe(false);
  });

  it("reads the project's list", () => {
    const { root, config } = loadConfig();
    const text = readFileSync(join(root, config.paths.quarantine), "utf8");
    expect(() => parseQuarantine(text)).not.toThrow();
  });
});
