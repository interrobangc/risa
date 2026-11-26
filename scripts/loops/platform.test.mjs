// The shell helpers that differ between macOS and Linux (lib.sh).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkProjects } from "./check-tooling.mjs";
import { toolingProjects } from "./tooling-tests.mjs";
import { checkPlanFor } from "./check-plan.mjs";
import { loadConfig } from "./config.mjs";
import { SAMPLE_CONFIG } from "./sample-project/repo.mjs";

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

// On the sample project: its config names the projects, its rules what the harness
// tests (this repo's answers: scripts/project/check-plan-rules.test.mjs).
describe("what pnpm test:tooling runs", () => {
  const sample = loadConfig({ path: SAMPLE_CONFIG });
  const opts = { config: sample.config, plan: checkPlanFor(sample) };
  const BASE = ["tools:unit"];
  const WITH = [...BASE, "tools:browser"];

  it.each(["scripts/loops/browser.sh", "scripts/loops/lib.sh", "tools/harness/run.sh", "e2e/a.spec.js"])(
    "adds the browser harness for %s",
    (f) => {
      expect(toolingProjects(["docs/x.md", f], [], opts)).toEqual(WITH);
    },
  );

  it.each(["scripts/loops/land.sh", "tools/x.sh", "web/a.js"])("skips it for %s", (f) => {
    expect(toolingProjects([f], [], opts)).toEqual(BASE);
  });

  it("runs it when the base can't be determined, or files are named", () => {
    expect(toolingProjects(null, [], opts)).toEqual(WITH);
    expect(toolingProjects([], ["scripts/loops/lease.test.mjs"], opts)).toEqual(WITH);
  });

  it("runs no harness a config doesn't name, and nothing for a config with no projects", () => {
    const { browserHarness: _, ...tooling } = sample.config.testProjects;
    expect(
      toolingProjects(null, [], { ...opts, config: { ...sample.config, testProjects: tooling } }),
    ).toEqual(BASE);
    // As the check's tooling step (check-tooling.mjs's checkProjects): none named, none run.
    expect(
      toolingProjects(null, ["a.test.mjs"], {
        ...opts,
        config: { ...sample.config, testProjects: undefined },
      }),
    ).toEqual([]);
    expect(checkProjects({ ...sample.config, testProjects: undefined }, true)).toBeNull();
  });
});

describe("lib.sh under CDPATH", () => {
  it("resolves its own folder once, sourced by a relative path", () => {
    // A CDPATH that matches the relative folder makes `cd` print it.
    const r = spawnSync("bash", ["-c", 'source scripts/loops/lib.sh && printf "%s|" "$loops_lib_dir"'], {
      cwd: join(HERE, "..", ".."),
      encoding: "utf8",
      env: { ...process.env, CDPATH: join(HERE, "..", "..") },
    });
    expect(r.stdout).toBe(`${HERE}|`);
  });
});
