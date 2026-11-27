// The standalone run's pure parts (standalone.mjs): which files it copies, and how
// it reads a run's report.
import { describe, expect, it } from "vitest";
import { coreFiles, failedFrom } from "./standalone.mjs";

describe("coreFiles", () => {
  it("keeps only the manifest's core lines, in order", () => {
    const text = [
      "web/app.ts project",
      "scripts/backlog/backlog.mjs core",
      "tools/tiers.json project",
      "scripts/loops/lease.sh core",
      "",
      "scripts/loops/odd line core extra",
    ].join("\n");
    expect(coreFiles(text)).toEqual(["scripts/backlog/backlog.mjs", "scripts/loops/lease.sh"]);
  });
});

describe("failedFrom", () => {
  const file = (name, statuses, status = statuses.includes("failed") ? "failed" : "passed") => ({
    name,
    status,
    assertionResults: statuses.map((s) => ({ status: s })),
  });

  it("counts failed tests per file and in all", () => {
    const r = failedFrom({
      testResults: [
        file("/r/a.test.mjs", ["passed", "failed", "failed"]),
        file("/r/b.test.mjs", ["passed", "skipped"]),
        file("/r/c.test.mjs", ["failed"]),
      ],
    });
    expect(r.failed).toEqual({ "/r/a.test.mjs": 2, "/r/c.test.mjs": 1 });
    expect(r).toMatchObject({ tests: 6, failedTests: 3, files: 3, hung: [] });
  });

  it("counts a failed file with no failed test (an import or hook error) as one", () => {
    expect(failedFrom({ testResults: [file("/r/a.test.mjs", [], "failed")] }).failed).toEqual({
      "/r/a.test.mjs": 1,
    });
  });

  it("names an expected file with no result as hung", () => {
    const r = failedFrom({ testResults: [file("/r/a.test.mjs", ["passed"])] }, [
      "/r/a.test.mjs",
      "/r/b.test.mjs",
    ]);
    expect(r.hung).toEqual(["/r/b.test.mjs"]);
    expect(r.failedTests).toBe(0);
  });
});
