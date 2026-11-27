// with_backlog_lock (lib.sh): a stale lock is taken over under its guard, so of
// two waiters on one stale lock exactly one takes it and the other waits for it
// (RISA-367). A throwaway repo with the scripts copied in; nothing here reaches
// the real repository.
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./config-fixture.mjs";

const HERE = new URL(".", import.meta.url).pathname;
let root, repo, lock;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "backlog-lock-")));
  repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "dev", repo]);
  cpSync(HERE, join(repo, "loops"), { recursive: true, filter: (src) => !src.endsWith(".test.mjs") });
  const name = execFileSync("bash", ["-c", "source loops/lib.sh && echo $project_name"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  lock = join(repo, ".git", `${name}-backlog.lock`);
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
    const script = `source loops/lib.sh
_backlog_lock_seen_stale() {
  touch "$B/seen-$ID"
  until ${all.map((w) => `[[ -e $B/seen-${w} ]]`).join(" && ")}; do sleep 0.05; done
}
hold() { echo "in $ID" >> "$B/log"; sleep 0.5; echo "out $ID" >> "$B/log"; }
with_backlog_lock hold`;
    const child = spawn("bash", ["-c", script], { cwd: repo, env: { ...process.env, B: root, ID: id } });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (status) => resolve({ status, err }));
  });
const log = () => readFileSync(join(root, "log"), "utf8").trim().split("\n");

describe("with_backlog_lock over a stale lock", () => {
  it("takes it over alone and drops it after", async () => {
    expect(await waiter("a", ["a"])).toEqual({ status: 0, err: "" });
    expect(log()).toEqual(["in a", "out a"]);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.takeover`)).toBe(false);
  });

  it("two waiters on it: exactly one takes it, the other waits its turn", async () => {
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
});
