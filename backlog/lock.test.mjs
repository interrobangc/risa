// The backlog lock (lock.mjs): a stale lock is taken over under its guard, so of
// two waiters on one stale lock exactly one takes it and the other waits for it
// (RISA-989, as lib.sh's with_backlog_lock does since RISA-367). Each waiter is
// its own node process; the lock is in a throwaway dir in the OS temp dir.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LOCK_MJS = new URL("./lock.mjs", import.meta.url).href;
let root, lock;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "backlog-lock-mjs-")));
  lock = join(root, "risa-backlog.lock");
  // A crashed writer's lock: a minute old.
  mkdirSync(lock);
  const old = Date.now() / 1000 - 60;
  utimesSync(lock, old, old);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// A waiter: once it judges the lock stale it waits until every waiter in `all`
// has too, so their takeovers race; under the lock it logs its stay.
const waiter = (id, all) =>
  new Promise((resolve) => {
    const script = `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { withLock } from ${JSON.stringify(LOCK_MJS)};
const { B, ID, ALL, LOCK } = process.env;
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const onStale = () => {
  writeFileSync(B + "/seen-" + ID, "");
  while (!ALL.split(",").every((w) => existsSync(B + "/seen-" + w))) nap(20);
};
withLock(LOCK, () => {
  appendFileSync(B + "/log", "in " + ID + "\\n");
  nap(500);
  appendFileSync(B + "/log", "out " + ID + "\\n");
}, { onStale });
`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, B: root, ID: id, ALL: all.join(","), LOCK: lock },
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (status) => resolve({ status, err }));
  });
const log = () => readFileSync(join(root, "log"), "utf8").trim().split("\n");

describe("withLock over a stale lock", () => {
  it("takes it over alone and drops it after", async () => {
    expect(await waiter("a", ["a"])).toEqual({ status: 0, err: "" });
    expect(log()).toEqual(["in a", "out a"]);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.takeover`)).toBe(false);
  });

  it("two waiters on it: exactly one takes it, the other waits and takes it after release", async () => {
    const results = await Promise.all([waiter("a", ["a", "b"]), waiter("b", ["a", "b"])]);
    expect(results).toEqual([
      { status: 0, err: "" },
      { status: 0, err: "" },
    ]);
    const [first, ...rest] = log();
    const id = first.slice(3);
    const other = id === "a" ? "b" : "a";
    // Never two holders at once: one stay ends before the other starts.
    expect([first, ...rest]).toEqual([`in ${id}`, `out ${id}`, `in ${other}`, `out ${other}`]);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.takeover`)).toBe(false);
  });

  it("a fresh lock is waited for, not taken over", async () => {
    utimesSync(lock, new Date(), new Date());
    setTimeout(() => rmSync(lock, { recursive: true, force: true }), 400);
    expect(await waiter("a", ["a"])).toEqual({ status: 0, err: "" });
    expect(existsSync(join(root, "seen-a"))).toBe(false);
    expect(log()).toEqual(["in a", "out a"]);
  });
});
