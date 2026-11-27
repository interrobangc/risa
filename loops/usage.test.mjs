// The usage reading (usage.mjs): the parser, the merge and the stall, pure; then the
// status line and StopFailure hooks, `pnpm prd usage` and status's line as commands,
// against throwaway folders. Every reading here is made up; nothing reads or writes
// the real .loops.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mergeReadings,
  nextReading,
  parseInput,
  resetFromInput,
  resetFromReadings,
  stalledReading,
  statusLine,
} from "./usage.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const NOW = Date.parse("2026-11-22T12:00:00Z");
const MIN = 60_000;
const STALE = 15 * MIN;
const sec = (ms) => Math.floor(ms / 1000);
const isoAt = (ms) => new Date(ms).toISOString();

/** A status-line input with the given windows (resets in ms). */
const input = ({ five, week, spend } = {}) => ({
  session_id: "0000-fictional",
  transcript_path: "/nowhere/t.jsonl",
  cwd: "/nowhere",
  model: { id: "claude-test", display_name: "Test" },
  rate_limits: {
    ...(five && { five_hour: { used_percentage: five[0], resets_at: sec(five[1]) } }),
    ...(week && { seven_day: { used_percentage: week[0], resets_at: sec(week[1]) } }),
    ...(spend && { spend_limit: { used_percentage: spend[0], resets_at: sec(spend[1]), ...spend[2] } }),
  },
});

/** A stored reading for SESSION, each window read at AT. */
const reading = (session, at, windows, extra = {}) => ({
  session,
  pid: 99_999_999,
  at: isoAt(at),
  windows: Object.fromEntries(
    Object.entries(windows).map(([k, [percent, reset]]) => [
      k,
      { percent, resetsAt: reset === null ? null : isoAt(reset), at: isoAt(at) },
    ]),
  ),
  ...extra,
});

describe("parseInput", () => {
  it("reads every window of a full input, resets in ms, and the spend limit's dollars", () => {
    const p = parseInput(
      JSON.stringify(
        input({
          five: [42.4, NOW + 2 * 60 * MIN],
          week: [18, NOW + 3 * 24 * 60 * MIN],
          spend: [12, NOW + 9 * 24 * 60 * MIN, { used_usd: 6, limit_usd: 50, period: "monthly" }],
        }),
      ),
    );
    expect(p).toEqual({
      sessionId: "0000-fictional",
      windows: {
        fiveHour: { percent: 42.4, resetsAt: NOW + 2 * 60 * MIN },
        sevenDay: { percent: 18, resetsAt: NOW + 3 * 24 * 60 * MIN },
        spend: {
          percent: 12,
          resetsAt: NOW + 9 * 24 * 60 * MIN,
          usedUsd: 6,
          limitUsd: 50,
          period: "monthly",
        },
      },
    });
  });

  it("keeps what a partial input has: one window, a window with no reset", () => {
    expect(parseInput(input({ five: [7, NOW + MIN] })).windows).toEqual({
      fiveHour: { percent: 7, resetsAt: NOW + MIN },
    });
    expect(parseInput({ rate_limits: { seven_day: { used_percentage: "30" } } }).windows).toEqual({
      sevenDay: { percent: 30, resetsAt: null },
    });
  });

  it("gives no windows when rate_limits is missing (an API key, before the first response)", () => {
    expect(parseInput({ session_id: "s", model: {} })).toEqual({ sessionId: "s", windows: {} });
    expect(parseInput({ rate_limits: null }).windows).toEqual({});
  });

  it("is null for malformed input, and drops malformed windows", () => {
    for (const bad of ["", "{", "not json", "[]", "null", "42", '"text"']) expect(parseInput(bad)).toBeNull();
    expect(
      parseInput({
        rate_limits: {
          five_hour: { used_percentage: "lots", resets_at: 1 },
          seven_day: "full",
          spend_limit: { resets_at: sec(NOW) },
        },
      }).windows,
    ).toEqual({});
    expect(
      parseInput({ rate_limits: { five_hour: { used_percentage: 5, resets_at: "soon" } } }).windows,
    ).toEqual({
      fiveHour: { percent: 5, resetsAt: null },
    });
  });
});

describe("mergeReadings", () => {
  const merge = (rs, now = NOW) => mergeReadings(rs, { now, staleMs: STALE });
  const reset = NOW + 2 * 60 * MIN;

  it("is unknown with no reading, and when every reading is stale", () => {
    expect(merge([])).toMatchObject({ known: false, fiveHour: null, sevenDay: null, resetsAt: null });
    const old = reading("prd-a", NOW - 20 * MIN, { fiveHour: [50, reset] });
    expect(merge([old])).toMatchObject({ known: false, fiveHour: null, at: null });
    expect(merge([old], NOW - 10 * MIN)).toMatchObject({ known: true, fiveHour: { percent: 50 } });
  });

  it("leaves out a window whose reset has passed", () => {
    expect(
      merge([reading("prd-a", NOW - MIN, { fiveHour: [99, NOW - 1000], sevenDay: [20, reset] })]),
    ).toMatchObject({
      known: true,
      fiveHour: null,
      sevenDay: { percent: 20 },
    });
  });

  it("never lets an older reading lower a newer one for the same reset", () => {
    const newer = reading("prd-a", NOW - MIN, { fiveHour: [60, reset] });
    const older = reading("backlog", NOW - 5 * MIN, { fiveHour: [40, reset + 20_000] });
    expect(merge([older, newer]).fiveHour).toMatchObject({ percent: 60 });
    expect(merge([newer, older]).fiveHour).toMatchObject({ percent: 60 });
    // A newer reading with a lower figure for that window (a session's cached headers) doesn't lower it either.
    const lagging = reading("inbox", NOW, { fiveHour: [55, reset] });
    expect(merge([newer, lagging]).fiveHour).toMatchObject({ percent: 60 });
  });

  it("takes the later reset as the current window, whatever its percent", () => {
    const before = reading("prd-a", NOW - 3 * MIN, { fiveHour: [97, NOW + MIN] });
    const after = reading("prd-b", NOW - MIN, { fiveHour: [2, NOW + 5 * 60 * MIN] });
    expect(merge([before, after]).fiveHour).toMatchObject({ percent: 2, resetsAt: NOW + 5 * 60 * MIN });
  });

  it("flags overage at 100% of a plan window and a spend limit when one is read", () => {
    const u = merge([
      reading("prd-a", NOW, { fiveHour: [100, reset], spend: [10, NOW + 24 * 60 * MIN] }),
      reading("prd-b", NOW, { sevenDay: [40, NOW + 3 * 24 * 60 * MIN] }),
    ]);
    expect(u).toMatchObject({ known: true, overage: true, spendLimit: true, sessions: 2, resetsAt: reset });
    expect(merge([reading("prd-a", NOW, { fiveHour: [99.9, reset] })])).toMatchObject({
      overage: false,
      spendLimit: false,
    });
  });

  it("holds a stall until its reset, and one with no reset for five hours", () => {
    const stalled = (resetsAt, at = NOW - MIN) =>
      reading(
        "prd-a",
        NOW - 30 * MIN,
        {},
        {
          stalled: {
            at: isoAt(at),
            error: "rate_limit",
            resetsAt: resetsAt && isoAt(resetsAt),
            pid: 99_999_999,
          },
        },
      );
    expect(merge([stalled(reset)])).toMatchObject({
      known: false,
      stalled: [{ session: "prd-a", resetsAt: reset, error: "rate_limit" }],
      resetsAt: reset,
    });
    expect(merge([stalled(reset)], reset + 1).stalled).toEqual([]);
    expect(merge([stalled(null)]).stalled).toHaveLength(1);
    expect(merge([stalled(null, NOW - 5 * 60 * MIN)]).stalled).toEqual([]);
  });
});

describe("the reading and the stall", () => {
  it("replaces the windows the input has, keeps the rest with their age, and a stall only for the same pid", () => {
    const current = {
      ...reading("prd-a", NOW - 5 * MIN, { fiveHour: [10, NOW + MIN], sevenDay: [30, NOW + 60 * MIN] }),
      stalled: { at: isoAt(NOW - 5 * MIN), error: "rate_limit", resetsAt: null, pid: 99_999_999 },
    };
    const next = nextReading(current, parseInput(input({ five: [12, NOW + MIN] })), {
      session: "prd-a",
      pid: 99_999_999,
      now: NOW,
    });
    expect(next.windows.fiveHour).toEqual({ percent: 12, resetsAt: isoAt(NOW + MIN), at: isoAt(NOW) });
    expect(next.windows.sevenDay).toEqual(current.windows.sevenDay);
    expect(next.stalled).toEqual(current.stalled);
    expect(
      nextReading(current, parseInput({}), { session: "prd-a", pid: 99_999_998, now: NOW }).stalled,
    ).toBeUndefined();
  });

  it("a stall with no reset takes the last reading's: the most used window still ahead, stale or not", () => {
    const readings = [
      reading("prd-a", NOW - 60 * MIN, {
        fiveHour: [40, NOW + 60 * MIN],
        sevenDay: [100, NOW + 2 * 24 * 60 * MIN],
      }),
      reading("prd-b", NOW - 2 * MIN, { fiveHour: [100, NOW - MIN] }),
    ];
    expect(resetFromReadings(readings, NOW)).toBe(NOW + 2 * 24 * 60 * MIN);
    expect(resetFromReadings([], NOW)).toBeNull();
    const marked = stalledReading(readings[0], {
      error: "rate_limit",
      resetsAt: resetFromInput({ error: "rate_limit" }, NOW) ?? resetFromReadings(readings, NOW),
      session: "prd-a",
      pid: 99_999_999,
      now: NOW,
    });
    expect(marked.stalled).toEqual({
      at: isoAt(NOW),
      error: "rate_limit",
      resetsAt: isoAt(NOW + 2 * 24 * 60 * MIN),
      pid: 99_999_999,
    });
    expect(marked.windows).toEqual(readings[0].windows);
  });

  it("takes a reset from the StopFailure input when it carries one ahead", () => {
    expect(resetFromInput({ resets_at: sec(NOW + 60 * MIN) }, NOW)).toBe(NOW + 60 * MIN);
    expect(resetFromInput({ error_details: `limit reached; resets ${isoAt(NOW + 30 * MIN)}` }, NOW)).toBe(
      NOW + 30 * MIN,
    );
    expect(resetFromInput({ error_details: `retry after ${sec(NOW + 10 * MIN)}` }, NOW)).toBe(NOW + 10 * MIN);
    expect(resetFromInput({ error_details: `reset ${isoAt(NOW - MIN)}` }, NOW)).toBeNull();
    expect(resetFromInput({}, NOW)).toBeNull();
  });
});

describe("statusLine", () => {
  const opts = { now: NOW, staleMs: STALE, timeZone: "UTC" };
  it("shows each window's use and reset time, and the reading's age", () => {
    const u = mergeReadings(
      [
        reading("prd-a", NOW - 2 * MIN, {
          fiveHour: [42, NOW + 130 * MIN],
          sevenDay: [18, Date.parse("2026-11-25T09:00:00Z")],
        }),
      ],
      { now: NOW, staleMs: STALE },
    );
    expect(statusLine(u, opts)).toBe(
      "USAGE: 5h 42% (resets 14:10, in 2h) · 7d 18% (resets Wed 09:00, in 2d) · read 2m ago (pnpm prd usage)",
    );
  });

  it("says unknown, and names a stalled session with its reset", () => {
    const u = mergeReadings(
      [
        reading(
          "prd-a",
          NOW - 60 * MIN,
          {},
          {
            stalled: { at: isoAt(NOW - MIN), error: "rate_limit", resetsAt: isoAt(NOW + 90 * MIN), pid: 1 },
          },
        ),
      ],
      { now: NOW, staleMs: STALE },
    );
    expect(statusLine(u, opts)).toBe(
      "USAGE: unknown (no reading in the last 15m); stopped on a limit: prd-a, resets 13:30, in 1h (pnpm prd usage)",
    );
  });
});

describe("the commands", () => {
  let root;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "usage-")));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const node = (args, { stdin = "", env = {} } = {}) =>
    spawnSync(process.execPath, [join(HERE, "usage.mjs"), ...args], {
      input: stdin,
      encoding: "utf8",
      env: { PATH: process.env.PATH, RISA_CONFIG: process.env.RISA_CONFIG, HOME: root, TZ: "UTC", ...env },
    });
  const prd = (args, env) =>
    spawnSync("bash", [join(HERE, "prd.sh"), ...args], {
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC", RISA_USAGE_DIR: "", ...env },
    });
  const fresh = () => {
    const main = mkdtempSync(join(root, "main-"));
    const sessions = join(main, ".loops", ".sessions");
    mkdirSync(sessions, { recursive: true });
    return {
      dir: join(main, ".loops", ".usage"),
      env: {
        RISA_SESSIONS_DIR: sessions,
        RISA_SESSION_NAME: "prd-a",
        RISA_SESSION_PID: "99999999",
      },
    };
  };
  const files = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);

  it("the status line writes this session's reading and prints its windows", () => {
    const { dir, env } = fresh();
    const now = Date.now();
    const r = node(["statusline"], {
      stdin: JSON.stringify(input({ five: [42, now + 60 * MIN], week: [18, now + 2 * 24 * 60 * MIN] })),
      env,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("5h 42% · 7d 18%\n");
    expect(files(dir)).toEqual(["prd-a.json"]);
    const saved = JSON.parse(readFileSync(join(dir, "prd-a.json"), "utf8"));
    expect(saved).toMatchObject({
      session: "prd-a",
      pid: 99_999_999,
      windows: { fiveHour: { percent: 42 }, sevenDay: { percent: 18 } },
    });
  });

  it("exits 0 on bad input, leaves the last reading whole and no temp file behind", () => {
    const { dir, env } = fresh();
    const now = Date.now();
    expect(
      node(["statusline"], { stdin: JSON.stringify(input({ five: [10, now + 60 * MIN] })), env }).status,
    ).toBe(0);
    const before = readFileSync(join(dir, "prd-a.json"), "utf8");
    for (const bad of ["", "{ half", "[1,2]", "\u0000\u0001"]) {
      const r = node(["statusline"], { stdin: bad, env });
      expect(r.status).toBe(0);
      expect(r.stdout + r.stderr).toBe("");
    }
    expect(readFileSync(join(dir, "prd-a.json"), "utf8")).toBe(before);
    expect(files(dir)).toEqual(["prd-a.json"]);
    // No folder to write to, or none named: still 0 and silent but for its own line.
    expect(node(["statusline"], { stdin: JSON.stringify(input()), env: {} }).status).toBe(0);
    const blocked = join(root, "a-file");
    writeFileSync(blocked, "not a folder\n");
    const r = node(["statusline"], {
      stdin: JSON.stringify(input({ five: [1, now + MIN] })),
      env: { ...env, RISA_USAGE_DIR: join(blocked, "usage") },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("StopFailure marks a rate-limited session stalled with the last reading's reset, and ignores other failures", () => {
    const { dir, env } = fresh();
    const now = Date.now();
    const reset = sec(now + 90 * MIN) * 1000;
    node(["statusline"], {
      stdin: JSON.stringify(input({ five: [100, reset], week: [30, now + 3 * 24 * 60 * MIN] })),
      env,
    });
    const other = node(["stop-failure"], {
      stdin: JSON.stringify({ hook_event_name: "StopFailure", error: "server_error" }),
      env,
    });
    expect(other.status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "prd-a.json"), "utf8")).stalled).toBeUndefined();
    const hit = node(["stop-failure"], {
      stdin: JSON.stringify({
        session_id: "0000-fictional",
        hook_event_name: "StopFailure",
        error: "rate_limit",
      }),
      env,
    });
    expect(hit.status).toBe(0);
    expect(hit.stdout + hit.stderr).toBe("");
    expect(JSON.parse(readFileSync(join(dir, "prd-a.json"), "utf8")).stalled).toMatchObject({
      error: "rate_limit",
      resetsAt: isoAt(reset),
      pid: 99_999_999,
    });
    expect(node(["stop-failure"], { stdin: "garbage", env }).status).toBe(0);
    expect(files(dir)).toEqual(["prd-a.json"]);
  });

  it("pnpm prd usage and status's line show usage, unknown and the reset time", () => {
    const main = mkdtempSync(join(root, "prd-"));
    const usage = join(main, "usage");
    const status = (env) => node(["status"], { env: { RISA_USAGE_DIR: usage, ...env } });
    const none = status();
    expect(none.status).toBe(0);
    expect(none.stdout).toBe("USAGE: unknown (no reading in the last 15m) (pnpm prd usage)\n");

    mkdirSync(usage);
    const now = Date.now();
    const reset = sec(now + 150 * MIN) * 1000;
    writeFileSync(
      join(usage, "prd-a.json"),
      JSON.stringify(reading("prd-a", now - MIN, { fiveHour: [61, reset] })),
    );
    writeFileSync(join(usage, "broken.json"), "{ not json");
    const clockOf = (ms) => isoAt(ms).slice(11, 16);
    const line = status().stdout;
    expect(line).toMatch(
      new RegExp(`^USAGE: 5h 61% \\(resets (\\w{3} )?${clockOf(reset)}, in 2h\\) · read 1m ago`),
    );

    const r = prd(["usage"], { RISA_USAGE_DIR: usage });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^Usage, read 1m ago from 1 session:\n {2}5-hour +61% {2}resets /);
    expect(r.stdout).toContain(`${clockOf(reset)}, in 2h`);
    const json = JSON.parse(prd(["usage", "--json"], { RISA_USAGE_DIR: usage }).stdout);
    expect(json).toMatchObject({ known: true, fiveHour: { percent: 61, resetsAt: reset }, resetsAt: reset });

    // A stale reading reads as unknown, and the stale-age setting is honoured.
    expect(status({ RISA_USAGE_STALE_MIN: "0.5" }).stdout).toBe(
      "USAGE: unknown (no reading in the last 30s) (pnpm prd usage)\n",
    );
    expect(prd(["usage"], { RISA_USAGE_DIR: join(main, "none") }).stdout).toMatch(
      /^Usage: unknown: no current reading/,
    );
  });

  it("the settings files run the status line every minute and the StopFailure hook, both beside the context hook", () => {
    for (const f of ["context-settings.json", "inbox-settings.json"]) {
      const s = JSON.parse(readFileSync(join(HERE, f), "utf8"));
      expect(s.statusLine).toMatchObject({ type: "command", refreshInterval: 60 });
      expect(s.statusLine.command).toContain('"$(dirname "$RISA_CONTEXT_HOOK")/usage.mjs" statusline');
      expect(s.hooks.StopFailure[0].hooks[0].command).toContain('usage.mjs" stop-failure');
    }
    // The command as a shell runs it: the hook's folder found from RISA_CONTEXT_HOOK, silent without it.
    const s = JSON.parse(readFileSync(join(HERE, "context-settings.json"), "utf8"));
    const { dir, env } = fresh();
    const now = Date.now();
    const run = (extra) =>
      spawnSync("bash", ["-c", s.statusLine.command], {
        input: JSON.stringify(input({ five: [5, now + MIN] })),
        encoding: "utf8",
        env: { PATH: process.env.PATH, ...env, ...extra },
      });
    expect(run({}).stdout).toBe("");
    expect(files(dir)).toEqual([]);
    const r = run({ RISA_CONTEXT_HOOK: join(HERE, "context.mjs") });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("5h 5%\n");
    expect(files(dir)).toEqual(["prd-a.json"]);
  });
});
