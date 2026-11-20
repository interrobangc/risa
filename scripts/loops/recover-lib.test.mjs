// recover-lib.mjs: the down record and the --at clock, as pure functions.
import { describe, expect, it } from "vitest";
import { mergeRecord, nextTime, upNow } from "./recover-lib.mjs";

describe("upNow", () => {
  it("lists stacks with a running container, servers that answer, and the test Postgres", () => {
    const inv = {
      worktrees: [
        { name: "a", stack: "caretook-loop1", containersUp: 2, webPort: 6173, serverRunning: true },
        { name: "b", stack: "caretook-loop2", containersUp: 0, webPort: 6273, serverRunning: false },
        { name: "c", stack: null, containersUp: 0, webPort: null, serverRunning: false },
      ],
      testDb: { running: true },
    };
    expect(upNow(inv)).toEqual({ stacks: ["a"], servers: ["a"], testDb: true });
  });
});

describe("mergeRecord", () => {
  const now = { stacks: ["a"], servers: [], testDb: false };
  it("is what's up now when there's no record", () => {
    expect(mergeRecord(now, null, "T")).toEqual({ at: "T", stacks: ["a"], servers: [], testDb: false });
  });
  it("keeps what an earlier down recorded", () => {
    expect(mergeRecord(now, { stacks: ["b", "a"], servers: ["b"], testDb: true }, "T")).toEqual({
      at: "T",
      stacks: ["b", "a"],
      servers: ["b"],
      testDb: true,
    });
  });
});

describe("nextTime", () => {
  // Local time: the test runs under whatever TZ the machine has, so build the times locally.
  const at = (/** @type {number} */ d, /** @type {number} */ h, /** @type {number} */ m) =>
    new Date(2026, 10, d, h, m, 0, 0).getTime() / 1000;
  it("is today's time when it's still ahead", () => {
    expect(nextTime("15:00", at(19, 12, 0))).toBe(at(19, 15, 0));
  });
  it("is tomorrow's when it has passed, or is now", () => {
    expect(nextTime("9:30", at(19, 12, 0))).toBe(at(20, 9, 30));
    expect(nextTime("12:00", at(19, 12, 0))).toBe(at(20, 12, 0));
  });
  it("refuses anything but HH:MM", () => {
    for (const t of ["24:00", "12:60", "noon", "12"]) expect(() => nextTime(t, 0)).toThrow(/not a time/);
  });
});
