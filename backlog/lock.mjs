// The backlog lock: a directory in the git common dir, made atomically. It agrees
// with lib.sh's with_backlog_lock on every rule, so a shell writer and this one
// share it safely:
//
//   - a lock older than 30 s is from a crashed writer and is taken over;
//   - the takeover is made under a guard (`<lock>.takeover`, also a directory):
//     only the guard's holder re-checks the lock and replaces a still-stale one,
//     so of two waiters on one stale lock exactly one takes it and the other
//     waits again (RISA-367, RISA-989);
//   - a guard older than 10 s is a crashed taker's and is removed;
//   - a waiter gives up after 20 s.
import { mkdirSync, rmSync, rmdirSync, statSync } from "node:fs";

const STALE_MS = 30_000;
const GUARD_STALE_MS = 10_000;
const WAIT_MS = 20_000;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The error a waiter throws when the lock stays held; the caller supplies its class. */
const lockedError = (Err, lockDir) => new Err(`backlog is locked (${lockDir}); try again`);

/** True when `path` exists and is older than `ms`. */
function older(path, ms) {
  try {
    return Date.now() - statSync(path).mtimeMs > ms;
  } catch {
    return false; // gone: released meanwhile
  }
}

/** True when this caller now holds `lockDir`, taken over from a stale holder under the guard. */
function takeStale(lockDir) {
  const guard = `${lockDir}.takeover`;
  try {
    mkdirSync(guard);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    if (older(guard, GUARD_STALE_MS)) {
      try {
        rmdirSync(guard);
      } catch {
        // another waiter removed it first
      }
    }
    return false;
  }
  let taken = false;
  try {
    // Re-checked under the guard: another waiter may have taken it fresh since.
    if (older(lockDir, STALE_MS)) {
      rmSync(lockDir, { recursive: true, force: true });
      try {
        mkdirSync(lockDir);
        taken = true;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
    }
  } finally {
    try {
      rmdirSync(guard);
    } catch {
      // already gone
    }
  }
  return taken;
}

/**
 * Run `fn` under `lockDir`, dropping it after, however `fn` ends.
 * `opts.Error` is the class a waiter's timeout throws; `opts.onStale` is a seam
 * that runs when a waiter has judged the lock stale, before its takeover (a test
 * lines two waiters up with it).
 * @template T
 * @param {string} lockDir
 * @param {() => T} fn
 * @param {{ Error?: new (msg: string) => Error, onStale?: () => void }} [opts]
 * @returns {T}
 */
export function withLock(lockDir, fn, opts = {}) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    if (older(lockDir, STALE_MS)) {
      opts.onStale?.();
      if (takeStale(lockDir)) break;
    }
    if (Date.now() > deadline) throw lockedError(opts.Error ?? Error, lockDir);
    sleep(150);
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}
