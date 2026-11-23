import { describe, expect, it } from "vitest";
import { describeRun, isTopicRun, outstandingRuns } from "./outstanding.mjs";

const SHA = "a".repeat(40);
const io = (/** @type {any} */ runs, { origin = true, listed = true, ghOk = true } = {}) => ({
  git: (/** @type {string[]} */ args) =>
    args[0] === "remote"
      ? { ok: origin, out: "" }
      : { ok: listed, out: `${SHA}\trefs/heads/ci/full/prd-x\n` },
  gh: () => ({ ok: ghOk, out: JSON.stringify(runs) }),
});
const run = (status = "in_progress", over = {}) => ({
  databaseId: 7,
  headSha: SHA,
  status,
  url: "https://ci.example/7",
  workflowName: "CI",
  ...over,
});

describe("outstandingRuns", () => {
  it("counts a run going, and a pushed ref with no run yet", () => {
    expect(outstandingRuns(io([run()]))?.[0]).toMatchObject({ ref: "ci/full/prd-x", run: 7 });
    expect(outstandingRuns(io([]))?.[0]).toMatchObject({ ref: "ci/full/prd-x", run: null });
  });

  it("doesn't count a finished run, and ignores another commit's or workflow's", () => {
    expect(outstandingRuns(io([run("completed")]))).toEqual([]);
    expect(outstandingRuns(io([run("completed"), run("queued", { headSha: "b" })]))).toEqual([]);
    expect(outstandingRuns(io([run("completed"), run("queued", { workflowName: "Deploy" })]))).toEqual([]);
  });

  it("no origin is none; an unreadable GitHub is unknown, never none", () => {
    expect(outstandingRuns(io([], { origin: false }))).toEqual([]);
    expect(outstandingRuns(io([], { listed: false }))).toBeNull();
    expect(outstandingRuns(io([], { ghOk: false }))).toBeNull();
  });
});

describe("isTopicRun", () => {
  it("takes the topic's PRD branch and slices, narrowed too, and no other topic's", () => {
    for (const n of ["prd-x", "prd-x-narrowed-abc123", "slice-x-3", "slice-x-3-narrowed-abc123"])
      expect(isTopicRun(n, "x"), n).toBe(true);
    for (const n of ["prd-x-2", "slice-x-2-3", "prd-y", "dev"]) expect(isTopicRun(n, "x"), n).toBe(false);
  });
});

describe("describeRun", () => {
  it("names the link, or that no run has started", () => {
    const base = { ref: "ci/full/prd-x", name: "prd-x", sha: SHA };
    expect(describeRun({ ...base, run: 7, url: "https://ci.example/7" })).toBe(
      "ci/full/prd-x (https://ci.example/7)",
    );
    expect(describeRun({ ...base, run: null, url: null })).toBe("ci/full/prd-x (no run started yet)");
  });
});
