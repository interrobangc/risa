// The landing journal's resume decision (land-journal.mjs), for every step on
// the PR and local paths, and its record writes. land.test.mjs runs land.sh
// itself, killed after each step and resumed.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { decide, listRecords, LOCAL_STEPS, PR_STEPS, readRecord, recordStep } from "./land-journal.mjs";

const TIP = "a".repeat(40);
const OTHER = "b".repeat(40);
const rec = (path, step) => ({ branch: "prd/fictional-topic", path, tip: TIP, step });
const after = (steps) => steps.slice(steps.indexOf("merge") + 1, -1);

describe("decide on the PR path", () => {
  const open = { pr: "open", originHas: false, devHas: false };
  const merged = { pr: "merged", originHas: true, devHas: false };
  const synced = { ...merged, devHas: true };

  for (const step of ["push", "merge"]) {
    it(`at ${step}, an open unmerged PR is undone, with nothing to abort`, () => {
      expect(decide(rec("pr", step), open)).toMatchObject({ action: "undo" });
      expect(decide(rec("pr", step), open).abort).toBeUndefined();
    });
    it(`at ${step}, a merged PR finishes from the step after the merge`, () => {
      expect(decide(rec("pr", step), merged)).toMatchObject({ action: "finish", from: "mark" });
    });
  }

  for (const step of after(PR_STEPS))
    it(`at ${step}, merged and synced, finishes from ${step}`, () => {
      expect(decide(rec("pr", step), synced)).toMatchObject({ action: "finish", from: step });
    });

  it("a PR merged with no dev sync finishes through dev-sync", () => {
    for (const step of ["mark", "to-test", "notice", "dev-sync"])
      expect(decide(rec("pr", step), merged)).toMatchObject({ action: "finish", from: step });
    expect(decide(rec("pr", "flakes"), merged)).toMatchObject({ action: "finish", from: "dev-sync" });
  });

  it("origin/dev holding the tip counts as merged when GitHub can't be read", () => {
    expect(decide(rec("pr", "merge"), { pr: "unknown", originHas: true })).toMatchObject({
      action: "finish",
      from: "mark",
    });
  });

  it("an unknown state asks: GitHub unreadable and origin/dev without the tip", () => {
    expect(decide(rec("pr", "merge"), { pr: "unknown", originHas: false }).action).toBe("ask");
    expect(decide(rec("pr", "merge"), { pr: "unknown", originHas: null }).action).toBe("ask");
    expect(decide(rec("pr", "push"), {}).action).toBe("ask");
  });

  it("a PR closed without a merge asks", () => {
    expect(decide(rec("pr", "merge"), { pr: "closed", originHas: false }).action).toBe("ask");
  });

  it("past the merge with no merge to be seen asks", () => {
    for (const step of after(PR_STEPS)) expect(decide(rec("pr", step), open).action).toBe("ask");
  });

  it("any MERGE_HEAD in the main checkout asks, never undoes", () => {
    for (const step of PR_STEPS.slice(0, -1)) {
      expect(decide(rec("pr", step), { ...open, mergeHead: OTHER }).action).toBe("ask");
      expect(decide(rec("pr", step), { ...open, mergeHead: TIP }).action).toBe("ask");
    }
  });
});

describe("decide on the local path", () => {
  it("at merge, a cut-off merge of the recorded tip is undone and aborted", () => {
    expect(decide(rec("local", "merge"), { mergeHead: TIP, devHas: false })).toMatchObject({
      action: "undo",
      abort: true,
    });
  });

  it("at merge, a MERGE_HEAD other than the recorded tip asks and is never aborted", () => {
    const d = decide(rec("local", "merge"), { mergeHead: OTHER, devHas: false });
    expect(d.action).toBe("ask");
    expect(d.abort).toBeUndefined();
    expect(d.why).toContain("never aborted");
  });

  it("at merge, dev without the branch and no merge under way is undone, nothing to abort", () => {
    const d = decide(rec("local", "merge"), { devHas: false });
    expect(d).toMatchObject({ action: "undo" });
    expect(d.abort).toBeUndefined();
  });

  it("at merge, dev holding the branch finishes from the step after", () => {
    expect(decide(rec("local", "merge"), { devHas: true })).toMatchObject({ action: "finish", from: "mark" });
  });

  for (const step of after(LOCAL_STEPS))
    it(`at ${step}, merged, finishes from ${step}; unmerged asks`, () => {
      expect(decide(rec("local", step), { devHas: true })).toMatchObject({ action: "finish", from: step });
      expect(decide(rec("local", step), { devHas: false }).action).toBe("ask");
      expect(decide(rec("local", step), { devHas: true, mergeHead: OTHER }).action).toBe("ask");
    });

  it("MERGE_HEAD at the tip while dev already has it asks", () => {
    expect(decide(rec("local", "merge"), { mergeHead: TIP, devHas: true }).action).toBe("ask");
  });
});

describe("decide on any path", () => {
  it("no record is done; a record at end is done", () => {
    expect(decide(null, {}).action).toBe("done");
    expect(decide(rec("pr", "end"), {}).action).toBe("done");
    expect(decide(rec("local", "end"), {}).action).toBe("done");
  });

  it("an unknown step, path or a missing tip asks", () => {
    expect(decide(rec("pr", "teleport"), {}).action).toBe("ask");
    expect(decide(rec("local", "push"), {}).action).toBe("ask");
    expect(decide(rec("sideways", "merge"), {}).action).toBe("ask");
    expect(decide({ path: "pr", step: "merge" }, { pr: "open" }).action).toBe("ask");
  });

  it("a landing or resume still running asks", () => {
    expect(decide(rec("pr", "merge"), { pr: "open", running: true }).action).toBe("ask");
  });
});

describe("the record", () => {
  let dir;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps its fields across steps and lists with its file", () => {
    dir = mkdtempSync(join(tmpdir(), "land-journal-"));
    const file = join(dir, "prd-fictional-topic.json");
    recordStep(file, "push", { branch: "prd/fictional-topic", path: "pr", tip: TIP });
    recordStep(file, "merge");
    const r = readRecord(file);
    expect(r).toMatchObject({ branch: "prd/fictional-topic", path: "pr", tip: TIP, step: "merge" });
    expect(r.started).toBeTruthy();
    expect(listRecords(dir)).toEqual([expect.objectContaining({ step: "merge", file })]);
    expect(JSON.parse(readFileSync(file, "utf8")).step).toBe("merge");
  });

  it("an unreadable record or folder reads as none", () => {
    dir = mkdtempSync(join(tmpdir(), "land-journal-"));
    expect(readRecord(join(dir, "missing.json"))).toBeNull();
    expect(listRecords(join(dir, "missing"))).toEqual([]);
  });
});
