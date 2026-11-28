// The pinned risa against the release running (RISA-1050): the pure comparison, the
// release a folder runs as (fake release folders in the OS temp dir), the config's
// pin read through the loader, and the dispatcher's start entry carrying the line.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_CONFIG } from "./config-fixture.mjs";
import { startLines } from "./dispatch.mjs";
import { pinWarning, pinWarningAt, runningRelease } from "./pin.mjs";

const WARNING = "risa version: this project pins v0.1.8 (risaVersion) but release v0.2.0 is running";

let root, home;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pin-test-")));
  home = join(root, "home");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The fixture config with risaVersion PIN (undefined: none), as RISA_CONFIG. */
const configWith = (/** @type {string | undefined} */ pin) => {
  const raw = JSON.parse(readFileSync(FIXTURE_CONFIG, "utf8"));
  if (pin === undefined) delete raw.risaVersion;
  else raw.risaVersion = pin;
  const file = join(root, `risa-${pin ?? "none"}.json`);
  writeFileSync(file, `${JSON.stringify(raw)}\n`);
  return file;
};

describe("pinWarning", () => {
  it("names both versions when they differ", () => {
    expect(pinWarning("0.1.8", "v0.2.0")).toBe(WARNING);
  });

  it("is null for equal versions, a v prefix on either side included", () => {
    for (const [pin, running] of [
      ["0.2.0", "0.2.0"],
      ["0.2.0", "v0.2.0"],
      ["v0.2.0", "0.2.0"],
      ["v0.2.0", "v0.2.0"],
    ])
      expect(pinWarning(pin, running)).toBeNull();
  });

  it("is null with no pin or no release running", () => {
    expect(pinWarning(null, "v0.2.0")).toBeNull();
    expect(pinWarning(undefined, "v0.2.0")).toBeNull();
    expect(pinWarning("0.1.8", null)).toBeNull();
  });
});

describe("runningRelease", () => {
  it("reads a release folder's tag, its package.json version when the name isn't one, and null elsewhere", () => {
    const tagged = join(home, ".risa", "releases", "v0.2.0");
    const named = join(home, ".risa", "releases", "current");
    const checkout = join(root, "checkout");
    for (const d of [tagged, named, checkout]) mkdirSync(d, { recursive: true });
    writeFileSync(join(named, "package.json"), '{ "version": "0.2.1" }\n');
    expect(runningRelease(tagged, home)).toBe("v0.2.0");
    expect(runningRelease(named, home)).toBe("0.2.1");
    expect(runningRelease(checkout, home)).toBeNull();
  });
});

describe("pinWarningAt", () => {
  it("compares the config's pin with the release the tool runs from", () => {
    const release = join(home, ".risa", "releases", "v0.2.0");
    mkdirSync(release, { recursive: true });
    const at = (/** @type {string} */ tool, /** @type {string | undefined} */ pin) =>
      pinWarningAt(tool, { HOME: home, RISA_CONFIG: configWith(pin) });
    expect(at(release, "0.1.8")).toBe(WARNING);
    expect(at(release, "0.2.0")).toBeNull();
    expect(at(release, undefined)).toBeNull();
    // A run from a checkout (the main one included) is no release.
    expect(at(join(root, "checkout"), "0.1.8")).toBeNull();
    // A config that doesn't load has no pin.
    expect(pinWarningAt(release, { HOME: home, RISA_CONFIG: join(root, "missing.json") })).toBeNull();
  });
});

describe("the dispatcher's start entry", () => {
  it("carries the warning after its first line once, and nothing more without one", () => {
    const head = "started (pid 42, every 60s)";
    expect(startLines(head, pinWarning("0.1.8", "v0.2.0"))).toEqual([head, WARNING]);
    expect(startLines(head, pinWarning("0.2.0", "v0.2.0"))).toEqual([head]);
  });
});
