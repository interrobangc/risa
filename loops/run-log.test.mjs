// The run log's writer (run-log.mjs) and its shell side (run_log in lib.sh):
// events append, --once keeps one per key, and a write that fails is silent and
// leaves the caller's exit alone. Everything lives in a temp dir.
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendEvent, makeEvent, parseFields, topicOfBranch } from "./run-log.mjs";
import "./config-fixture.mjs";

const HERE = new URL(".", import.meta.url).pathname;
let root;
const lines = (file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "run-log-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("appendEvent", () => {
  it("appends events, time and kind first, the topic from the branch", () => {
    const log = join(root, "deep", "run-log.jsonl");
    const now = new Date("2026-03-01T10:00:00Z");
    expect(
      appendEvent(log, "slice-start", { name: "garden-2", branch: "slice/garden/2", slice: 2 }, { now }),
    ).toBe(true);
    expect(appendEvent(log, "land-end", { branch: "prd/garden", exit: 0, landed: true }, { now })).toBe(true);
    const [a, b] = lines(log);
    expect(Object.keys(a).slice(0, 3)).toEqual(["time", "kind", "topic"]);
    expect(a).toEqual({
      time: "2026-03-01T10:00:00.000Z",
      kind: "slice-start",
      topic: "garden",
      name: "garden-2",
      branch: "slice/garden/2",
      slice: 2,
    });
    expect(b).toMatchObject({ kind: "land-end", topic: "garden", exit: 0, landed: true });
  });

  it("--once skips an event already in the log with the same key", () => {
    const log = join(root, "run-log.jsonl");
    const verdict = { pr: 7, head: "abc123", answer: "review", state: "clean" };
    expect(appendEvent(log, "codex", verdict, { once: ["pr", "head", "answer"] })).toBe(true);
    expect(appendEvent(log, "codex", verdict, { once: ["pr", "head", "answer"] })).toBe(false);
    expect(
      appendEvent(log, "codex", { ...verdict, head: "def456" }, { once: ["pr", "head", "answer"] }),
    ).toBe(true);
    expect(lines(log).map((e) => e.head)).toEqual(["abc123", "def456"]);
  });

  it("returns false, never throws, when it can't write", () => {
    writeFileSync(join(root, "a-file"), "x");
    expect(appendEvent(join(root, "a-file", "run-log.jsonl"), "browser", { check: "x" })).toBe(false);
    expect(appendEvent("", "browser")).toBe(false);
  });

  it("reads fields and topics", () => {
    expect(parseFields(["a=b", "n:=3", "ok:=true", "s:=not json", "bad", "e="])).toEqual({
      a: "b",
      n: 3,
      ok: true,
      s: "not json",
      e: "",
    });
    expect(topicOfBranch("hotfix/tidy-up")).toBe("tidy-up");
    expect(topicOfBranch("dev")).toBe("");
    expect(makeEvent("x", { topic: "given", branch: "prd/other" }).topic).toBe("given");
  });
});

describe("run_log in lib.sh", () => {
  let repo;
  beforeEach(() => {
    repo = join(root, "repo");
    mkdirSync(join(repo, "loops"), { recursive: true });
    for (const f of ["lib.sh", "config.mjs", "run-log.mjs", "is-main.mjs"])
      copyFileSync(join(HERE, f), join(repo, "loops", f));
    execFileSync("git", ["init", "-q", repo]);
  });
  const sh = (script, env = {}) =>
    spawnSync("bash", ["-c", `set -euo pipefail; source loops/lib.sh; ${script}`], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, RISA_RUN_LOG: "", ...env },
    });

  it("appends to the main checkout's .loops/.run-log.jsonl by default", () => {
    const r = sh(`run_log browser check=sign-in result=pass seconds:=12 branch=slice/garden/1`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
    expect(lines(join(repo, ".loops/.run-log.jsonl"))).toEqual([
      expect.objectContaining({
        kind: "browser",
        topic: "garden",
        check: "sign-in",
        result: "pass",
        seconds: 12,
      }),
    ]);
  });

  it("RISA_RUN_LOG moves it, and --once passes through", () => {
    const log = join(root, "elsewhere.jsonl");
    const r = sh(`run_log --once pr,head codex pr:=3 head=aa; run_log --once pr,head codex pr:=3 head=aa`, {
      RISA_RUN_LOG: log,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(lines(log)).toHaveLength(1);
  });

  it("a failed write leaves the caller's exit unchanged and prints nothing", () => {
    writeFileSync(join(root, "a-file"), "x");
    const bad = { RISA_RUN_LOG: join(root, "a-file", "run-log.jsonl") };
    let r = sh(`run_log land-end exit:=0; echo after; exit 7`, bad);
    expect(r.status).toBe(7);
    expect(r.stdout).toBe("after\n");
    expect(r.stderr).toBe("");
    r = sh(`run_log land-end exit:=0; echo after`, bad);
    expect(r.status).toBe(0);
    // No writer at all (a script copied without it): still silent, still going.
    rmSync(join(repo, "loops/run-log.mjs"));
    r = sh(`run_log land-end exit:=0; exit 3`);
    expect(r.status).toBe(3);
    expect(r.stdout + r.stderr).toBe("");
  });
});
