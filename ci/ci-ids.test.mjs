// A former id prefix (backlog.formerIdPrefix) in CI: every place `pnpm prd ci` and
// its lists match an id also reads a former one, as its own (B-772 under RISA is
// RISA-772). The modules read the config once, so each case runs in a fresh Node
// on a throwaway config.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fixtureTierData } from "../loops/config-fixture.mjs";
import { backlogIds } from "../loops/config.mjs";
import { parseQuarantine } from "./ci-lists.mjs";

const here = dirname(new URL(import.meta.url).pathname);
let dir = "";
let config = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ci-ids-"));
  const raw = JSON.parse(readFileSync(/** @type {string} */ (process.env.RISA_CONFIG), "utf8"));
  Object.assign(raw.backlog, { idPrefix: "RISA", formerIdPrefix: "B", zoneOverflowItem: "RISA-750" });
  config = join(dir, "risa.json");
  // Its paths start from its own folder: the tier data goes there too.
  raw.paths.tierData = fixtureTierData(dir).path;
  writeFileSync(config, JSON.stringify(raw));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** What `code` prints (JSON), run as a module beside these files on the throwaway config. */
const run = (/** @type {string} */ code) => {
  const r = spawnSync("node", ["--input-type=module", "-e", code], {
    cwd: here,
    encoding: "utf8",
    env: { ...process.env, RISA_CONFIG: config },
  });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
};

describe("a former id prefix in CI", () => {
  it("ci gate's --fixes takes a former id and gives it the current prefix", () => {
    const got = run(
      `const { parseGateArgs } = await import("./ci-args.mjs");
       const ok = parseGateArgs(["--tier", "unit", "--base", "abc", "--fixes", "B-9,RISA-10"]).fixes;
       let refused = "";
       try { parseGateArgs(["--tier", "unit", "--base", "abc", "--fixes", "C-9"]); } catch (e) { refused = e.message; }
       console.log(JSON.stringify({ ok, refused }));`,
    );
    expect(got).toEqual({ ok: ["RISA-9", "RISA-10"], refused: expect.stringMatching(/RISA-n/) });
  });

  it("blame reads a dev-brake notice that names a former id", () => {
    const got = run(
      `const { noticeKey } = await import("./blame.mjs");
       console.log(JSON.stringify([noticeKey("dev brake B-5 [ci-key k1]"), noticeKey("dev brake RISA-5 [ci-key k2]"), noticeKey("dev brake C-5 [ci-key k3]")]));`,
    );
    expect(got).toEqual(["k1", "k2", null]);
  });

  it("the quarantine reads a former id as its own", () => {
    const ids = backlogIds({ backlog: { idPrefix: "RISA", formerIdPrefix: "B" } });
    expect(parseQuarantine("a.test.ts\tname\tB-7\nb.test.ts\tname\tRISA-8", ids)).toEqual([
      { file: "a.test.ts", name: "name", item: "RISA-7" },
      { file: "b.test.ts", name: "name", item: "RISA-8" },
    ]);
    expect(() => parseQuarantine("a.test.ts\tname\tC-7", ids)).toThrow(/<RISA-n>/);
  });
});
