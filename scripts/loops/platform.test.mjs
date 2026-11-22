// The shell helpers that differ between macOS and Linux (lib.sh).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toolingProjects } from "./tooling-tests.mjs";
import { needsBrowserHarness } from "./check-plan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let dir, file;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "platform-test-"));
  file = join(dir, "a-file");
  writeFileSync(file, "x");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const lib = (code, path = process.env.PATH) =>
  spawnSync("bash", ["-c", `set -euo pipefail; source "${HERE}/lib.sh"; ${code}`], {
    encoding: "utf8",
    env: { ...process.env, PATH: path },
  });

// A `stat` that prints junk and fails for one form, and answers 1234567 for the other.
const fakeStat = (name, junkFlag) => {
  const bin = join(dir, name);
  spawnSync("mkdir", ["-p", bin]);
  writeFileSync(
    join(bin, "stat"),
    `#!/bin/sh\nif [ "$1" = "${junkFlag}" ]; then echo '  File: "x"'; exit 1; fi\necho 1234567\n`,
  );
  chmodSync(join(bin, "stat"), 0o755);
  return `${bin}:${process.env.PATH}`;
};

describe("file_mtime", () => {
  it("reads a real file's mtime on this system", () => {
    const r = lib(`file_mtime "${file}"`);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(String(Math.floor(statSync(file).mtimeMs / 1000)));
  });

  it("is a number when the first stat form prints junk", () => {
    expect(lib(`file_mtime "${file}"`, fakeStat("gnu-junk", "-c")).stdout).toBe("1234567\n");
  });

  it("is a number when the BSD form prints junk, as it does on Linux", () => {
    expect(lib(`file_mtime "${file}"`, fakeStat("bsd-junk", "-f")).stdout).toBe("1234567\n");
  });

  it("fails and prints nothing for a missing file", () => {
    const r = lib(`file_mtime "${dir}/missing" || echo fallback`);
    expect(r.stdout).toBe("fallback\n");
  });

  it("is the only stat -f %m in the tooling", () => {
    const sites = readdirSync(HERE)
      .filter((f) => f.endsWith(".sh"))
      .flatMap((f) =>
        readFileSync(join(HERE, f), "utf8")
          .split("\n")
          .filter((l) => /stat -f %m/.test(l) && !l.trimStart().startsWith("#"))
          .map(() => f),
      );
    expect(sites).toEqual(["lib.sh"]);
  });
});

describe("load_avg", () => {
  it("prints one line of three numbers", () => {
    expect(lib("load_avg").stdout).toMatch(/^\d+[.,]\d+ \d+[.,]\d+ \d+[.,]\d+\n$/);
  });
});

describe("what pnpm test:tooling runs", () => {
  const BASE = ["tooling:unit", "scripts:unit"];
  const WITH = [...BASE, "tooling:browser"];

  it.each([
    "scripts/loops/browser.sh",
    "scripts/loops/browser.test.mjs",
    "scripts/loops/lib.sh",
    "scripts/loops/lease.sh",
    "scripts/loops/serve.sh",
    "scripts/loops/checks",
    "scripts/loops/check-areas.mjs",
    "scripts/loops/check-areas.d/timeline",
    "scripts/browser-checks/fixtures.mjs",
  ])("adds the browser harness for %s", (f) => {
    expect(needsBrowserHarness([f])).toBe(true);
    expect(toolingProjects(["docs/x.md", f])).toEqual(WITH);
  });

  it.each([
    "scripts/loops/land.sh",
    "scripts/loops/checks.mjs",
    "scripts/backlog/backlog.mjs",
    ".githooks/commit-msg",
  ])("skips it for %s", (f) => {
    expect(toolingProjects([f])).toEqual(BASE);
  });

  it("runs it when the base can't be determined, or files are named", () => {
    expect(toolingProjects(null)).toEqual(WITH);
    expect(toolingProjects([], ["scripts/loops/lease.test.mjs"])).toEqual(WITH);
  });
});
