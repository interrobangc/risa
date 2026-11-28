// A dispatcher run from a release install follows the `risa` link (RISA-981): two
// fake release folders in the OS temp dir, a link moved from one to the other, and
// a checkout-run dispatcher that keeps to its own code.
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeHash, codeTarget, followsLink, linkedRoot, staleness } from "./dispatch.mjs";

const RISA = new URL("../bin/risa", import.meta.url).pathname;

let root, home, bin, env;
/** A tool folder at DIR: bin/risa (the real one) and one code file per CODE_DIRS. */
const toolAt = (/** @type {string} */ dir, /** @type {string} */ body) => {
  for (const d of ["bin", "loops", "backlog"]) mkdirSync(join(dir, d), { recursive: true });
  copyFileSync(RISA, join(dir, "bin", "risa"));
  writeFileSync(join(dir, "loops", "dispatch.mjs"), `// ${body}\n`);
  writeFileSync(join(dir, "backlog", "backlog.mjs"), "// backlog\n");
  return dir;
};
const link = (/** @type {string} */ to) => {
  rmSync(join(bin, "risa"), { force: true });
  symlinkSync(join(to, "bin", "risa"), join(bin, "risa"));
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-release-")));
  home = join(root, "home");
  bin = join(root, "local-bin");
  mkdirSync(bin, { recursive: true });
  env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("a release-run dispatcher", () => {
  it("reads stale once the link moves, and re-execs onto the new folder's dispatch.mjs", () => {
    const v1 = toolAt(join(home, ".risa", "releases", "v1"), "v1");
    const v2 = toolAt(join(home, ".risa", "releases", "v2"), "v2");
    link(v1);
    // bin/risa's own resolution, asked of it through the link.
    expect(linkedRoot(env)).toBe(v1);
    const started = codeHash(v1);
    expect(followsLink(v1, linkedRoot(env), home)).toBe(true);
    expect(staleness({ started, own: v1, follows: true, env })).toEqual({
      root: v1,
      hash: started,
      stale: false,
      script: join(v1, "loops", "dispatch.mjs"),
    });

    link(v2);
    expect(linkedRoot(env)).toBe(v2);
    const now = staleness({ started, own: v1, follows: true, env });
    expect(now.stale).toBe(true);
    expect(now.hash).toBe(codeHash(v2));
    expect(now.script).toBe(join(v2, "loops", "dispatch.mjs"));
  });

  it("follows the link from a release folder even when the link pointed elsewhere at its start", () => {
    const v3 = toolAt(join(home, ".risa", "releases", "v3"), "v3");
    const other = toolAt(join(root, "elsewhere"), "elsewhere");
    expect(followsLink(v3, other, home)).toBe(true);
    // The folder the link resolves to, wherever it is, is followed too.
    expect(followsLink(other, other, home)).toBe(true);
  });

  it("keeps to its own code when no risa answers", () => {
    const v1 = join(home, ".risa", "releases", "v1");
    expect(codeTarget(v1, true, null)).toBe(v1);
    expect(linkedRoot({ ...process.env, PATH: join(root, "nothing") })).toBeNull();
  });
});

describe("a checkout-run dispatcher", () => {
  it("compares and re-execs on its own checkout, wherever the link points", () => {
    const checkout = toolAt(join(root, "checkout"), "checkout");
    link(toolAt(join(home, ".risa", "releases", "v4"), "v4"));
    expect(followsLink(checkout, linkedRoot(env), home)).toBe(false);
    const started = codeHash(checkout);
    expect(staleness({ started, own: checkout, follows: false, env }).stale).toBe(false);
    // A landing changes the checkout's code: stale, onto its own dispatch.mjs.
    writeFileSync(join(checkout, "loops", "dispatch.mjs"), "// landed\n");
    expect(staleness({ started, own: checkout, follows: false, env })).toEqual({
      root: checkout,
      hash: codeHash(checkout),
      stale: true,
      script: join(checkout, "loops", "dispatch.mjs"),
    });
  });
});
