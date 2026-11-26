// The drain (drain.mjs): the decision at the lines, the limited tick's actions and the
// landing test, pure; the pick holding starts, plans and reopens; and new.sh refusing a
// slice worktree while draining, against a throwaway repo with the stub stack hook and
// fake pnpm, lsof and nvm. Every reading here is made up; nothing reads the real .loops.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pick } from "./dispatch-pick.mjs";
import {
  DRAIN_PERCENT,
  END_WAIT_MS,
  STOP_PERCENT,
  drainDecision,
  drainSettings,
  isLanding,
  landingUnder,
  limitActions,
  probeAllowed,
} from "./drain.mjs";
import { mergeReadings } from "./usage.mjs";
import { stubHookConfig } from "./config-fixture.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const NOW = Date.parse("2026-11-22T12:00:00Z");
const MIN = 60_000;
const STALE = 15 * MIN;
const iso = (ms) => new Date(ms).toISOString();
const lines = { drain: DRAIN_PERCENT, stop: STOP_PERCENT };

/** The merged usage of one session's reading, read just now. */
const usageOf = (windows, extra = {}) =>
  mergeReadings(
    [
      {
        session: "prd-a",
        windows: Object.fromEntries(
          Object.entries(windows).map(([k, w]) => [
            k,
            { at: iso(NOW - MIN), resetsAt: iso(NOW + 60 * MIN), ...w },
          ]),
        ),
        ...extra,
      },
    ],
    { now: NOW, staleMs: STALE },
  );
const decide = (usage, opts = {}) => drainDecision(usage, { ...lines, now: NOW, staleMs: STALE, ...opts });

describe("the drain decision", () => {
  it("is normal under 95%, draining from 95%, limited from 98%, on the 5-hour or the weekly window", () => {
    for (const w of ["fiveHour", "sevenDay"]) {
      expect(decide(usageOf({ [w]: { percent: 94.9 } })).state).toBe("normal");
      expect(decide(usageOf({ [w]: { percent: 95 } })).state).toBe("draining");
      expect(decide(usageOf({ [w]: { percent: 97.9 } })).state).toBe("draining");
      expect(decide(usageOf({ [w]: { percent: 98 } })).state).toBe("limited");
    }
    const d = decide(usageOf({ fiveHour: { percent: 40 }, sevenDay: { percent: 96 } }));
    expect(d).toMatchObject({ state: "draining", resetsAt: NOW + 60 * MIN, unknown: false });
    expect(d.why).toMatch(/^7d 96%, at or over the drain line 95% \(until \d\d:\d\d\)$/);
  });

  it("the spend window never drains: only the plan's", () => {
    expect(decide(usageOf({ spend: { percent: 99 } })).state).toBe("normal");
  });

  it("overage (a plan window at 100%) is limited, whatever the stop line", () => {
    const d = decide(usageOf({ fiveHour: { percent: 100 } }), { stop: 120, drain: 85 });
    expect(d.state).toBe("limited");
    expect(d.why).toMatch(/^over the plan limit \(5h 100%\): extra usage/);
  });

  it("takes the reset of the latest window over the line", () => {
    const d = decide(
      usageOf({
        fiveHour: { percent: 99, resetsAt: iso(NOW + 30 * MIN) },
        sevenDay: { percent: 98, resetsAt: iso(NOW + 3 * 60 * MIN) },
      }),
    );
    expect(d).toMatchObject({ state: "limited", resetsAt: NOW + 3 * 60 * MIN });
    expect(d.why).toContain("5h 99%, 7d 98%, at or over the stop line 98%");
  });

  it("a session stopped on a limit is limited until its reset, with no current reading", () => {
    const stalled = (resetsAt) =>
      mergeReadings(
        [{ session: "prd-b", windows: {}, stalled: { at: iso(NOW - 5 * MIN), error: "limited", resetsAt } }],
        {
          now: NOW,
          staleMs: STALE,
        },
      );
    const d = decide(stalled(iso(NOW + 20 * MIN)));
    expect(d).toMatchObject({ state: "limited", resetsAt: NOW + 20 * MIN });
    expect(d.why).toMatch(/^stopped on a limit: prd-b/);
    expect(decide(stalled(iso(NOW - MIN))).state).toBe("normal");
  });

  it("RISA_USAGE_DRAIN, RISA_USAGE_STOP and RISA_USAGE_WATCH=off", () => {
    expect(drainSettings({})).toEqual({ drain: 95, stop: 98, off: false });
    expect(drainSettings({ RISA_USAGE_DRAIN: "70", RISA_USAGE_STOP: "95" })).toEqual({
      drain: 70,
      stop: 95,
      off: false,
    });
    expect(drainSettings({ RISA_USAGE_DRAIN: "nope", RISA_USAGE_STOP: "-1" })).toMatchObject({
      drain: 95,
      stop: 98,
    });
    // A drain line over the stop line drains at the stop line.
    expect(drainSettings({ RISA_USAGE_DRAIN: "99" }).drain).toBe(98);
    const off = drainSettings({ RISA_USAGE_WATCH: "off" });
    expect(decide(usageOf({ fiveHour: { percent: 100 } }), off)).toMatchObject({
      state: "normal",
      unknown: false,
    });
    expect(decide(usageOf({ fiveHour: { percent: 75 } }), { drain: 70, stop: 95 }).state).toBe("draining");
  });

  it("unknown (none, or stale) doesn't drain, and asks for a report only with a session live past the stale age", () => {
    const none = mergeReadings([], { now: NOW, staleMs: STALE });
    const stale = mergeReadings(
      [
        {
          session: "x",
          windows: { fiveHour: { percent: 99, at: iso(NOW - 20 * MIN), resetsAt: iso(NOW + MIN) } },
        },
      ],
      { now: NOW, staleMs: STALE },
    );
    for (const u of [none, stale]) {
      expect(decide(u, { sessions: [{ live: true, startedMs: NOW - 20 * MIN }] })).toMatchObject({
        state: "normal",
        unknown: true,
      });
      // Just started: its first reading comes after its first API response.
      expect(decide(u, { sessions: [{ live: true, startedMs: NOW - MIN }] }).unknown).toBe(false);
      expect(decide(u, { sessions: [{ live: false, startedMs: NOW - 60 * MIN }] }).unknown).toBe(false);
      expect(decide(u).why).toMatch(/^usage unknown/);
    }
  });

  it("allows no probe while limited", () => {
    expect(probeAllowed(decide(usageOf({ fiveHour: { percent: 99 } })))).toBe(false);
    expect(probeAllowed(decide(usageOf({ fiveHour: { percent: 90 } })))).toBe(true);
  });
});

describe("the pick while draining or limited", () => {
  const facts = (state, extra = {}) => ({
    rows: [
      { topic: "a", state: "planned" },
      { topic: "p", state: "to-write", waiting: 3 },
      { topic: "d", state: "running" },
    ],
    worktrees: [{ name: "d", branch: "prd/d" }],
    sessions: [{ name: "prd-d", live: false, managed: true }],
    now: NOW,
    drain: { state, why: "5h 90%, at or over the drain line 85% (until 13:00)" },
    ...extra,
  });

  it("normal: the dead session is reopened, then a start and a plan may follow", () => {
    expect(pick(facts("normal")).action).toBe("reopen");
    expect(
      pick({ ...facts("normal"), sessions: [{ name: "prd-d", live: true, managed: true }] }).action,
    ).toBe("start");
  });

  for (const state of ["draining", "limited"])
    it(`${state}: no start, no plan, no reopen, and no reopen ask; each says why`, () => {
      const p = pick(facts(state));
      expect(p.action).toBe("none");
      expect(p.why).toBe(`usage is ${state}: 5h 90%, at or over the drain line 85% (until 13:00)`);
      const why = Object.fromEntries(p.reasons.map((r) => [r.topic, r.why]));
      expect(why.a).toBe(
        `no start while usage is ${state}: 5h 90%, at or over the drain line 85% (until 13:00)`,
      );
      expect(why.p).toMatch(new RegExp(`^no plan while usage is ${state}`));
      expect(why.d).toMatch(new RegExp(`^its orchestrator died; not reopened while usage is ${state}`));
      // Past the reopen limit there is no ask either.
      expect(pick(facts(state, { reopens: { "prd-d": 5 } })).action).toBe("none");
    });

  it("a pause still wins", () => {
    expect(pick({ ...facts("draining"), paused: true }).why).toBe("the dispatcher is paused");
  });
});

describe("a session in a landing", () => {
  const table = (rows) => new Map(rows.map(([pid, ppid, args]) => [pid, { ppid, args }]));

  it("is one with land.sh, or `prd land`, among its descendants", () => {
    expect(isLanding("bash /repo/scripts/loops/land.sh prd/x -m done")).toBe(true);
    expect(isLanding("land.sh prd/x")).toBe(true);
    expect(isLanding("bash /repo/scripts/loops/prd.sh land prd/x")).toBe(true);
    expect(isLanding("node /pnpm.cjs prd land prd/x")).toBe(true);
    expect(isLanding("bash /repo/scripts/loops/prd.sh check --quick")).toBe(false);
    expect(isLanding("grep land.sh notes")).toBe(false);
    const t = table([
      [100, 1, "claude"],
      [101, 100, "zsh -c pnpm prd land prd/x"],
      [102, 101, "bash /r/scripts/loops/land.sh prd/x"],
      [200, 1, "claude"],
      [201, 200, "bash /r/scripts/loops/prd.sh check"],
    ]);
    expect(landingUnder(100, t)).toBe(true);
    expect(landingUnder(200, t)).toBe(false);
    // A landing journal's pid under it counts too, whatever it runs.
    expect(landingUnder(200, t, new Set([201]))).toBe(true);
    expect(landingUnder(100, table([[100, 1, "claude"]]))).toBe(false);
  });
});

describe("the limited tick's actions", () => {
  const limited = {
    state: /** @type {const} */ ("limited"),
    resetsAt: NOW + MIN,
    why: "5h 99%",
    unknown: false,
  };
  const sessions = [
    { name: "prd-a", pid: 11, live: true, managed: true },
    { name: "prd-b", pid: 12, live: true, managed: true },
    { name: "backlog", pid: 13, live: true, managed: true },
    { name: "hotfix-h", pid: 14, live: true, managed: false },
    { name: "prd-dead", pid: 15, live: false, managed: true },
    { name: "mine", pid: 16, live: true, managed: false },
  ];

  it("ends each live managed session but one in a landing, and reports the hand-opened ones once", () => {
    const a = limitActions({ sessions, landing: new Set(["prd-b"]), stalls: {}, drain: limited, now: NOW });
    expect(a).toEqual([
      { type: "end", session: "prd-a", pid: 11 },
      { type: "wait", session: "prd-b", why: "it runs a landing: ended once that finishes" },
      { type: "end", session: "backlog", pid: 13 },
      expect.objectContaining({ type: "report", sessions: ["hotfix-h", "mine"] }),
    ]);
    expect(a[3].text).toContain("never ends one opened by hand: hotfix-h, mine are still live");
    const again = limitActions({
      sessions,
      landing: new Set(),
      stalls: {},
      reported: ["hotfix-h", "mine"],
      drain: limited,
      now: NOW,
    });
    expect(again.some((x) => x.type === "report")).toBe(false);
    // Its landing over, the session is ended.
    expect(again.find((x) => x.session === "prd-b")).toEqual({ type: "end", session: "prd-b", pid: 12 });
  });

  it("waits a sent TERM out, then KILLs; a mark for an older pid is no mark", () => {
    const one = [sessions[0]];
    const mark = (at, pid = 11, error = "limited") => ({ "prd-a": { at: iso(at), pid, error } });
    const act = (stalls) =>
      limitActions({ sessions: one, landing: new Set(), stalls, drain: limited, now: NOW });
    expect(act(mark(NOW - 1000))).toEqual([
      { type: "wait", session: "prd-a", why: "sent TERM; waiting for it to end" },
    ]);
    expect(act(mark(NOW - END_WAIT_MS))).toEqual([{ type: "kill", session: "prd-a", pid: 11 }]);
    expect(act(mark(NOW - END_WAIT_MS, 99))).toEqual([{ type: "end", session: "prd-a", pid: 11 }]);
    expect(act(mark(NOW - END_WAIT_MS, 11, "rate_limit"))).toEqual([
      { type: "end", session: "prd-a", pid: 11 },
    ]);
  });

  it("does nothing unless limited", () => {
    for (const state of ["normal", "draining"])
      expect(
        limitActions({ sessions, landing: new Set(), stalls: {}, drain: { ...limited, state }, now: NOW }),
      ).toEqual([]);
  });
});

const PLAN = `# Plan: T

## Slice 1: Stackless

Stack: no · Reads: none · Tests: unit
`;

describe("new.sh slice while draining", () => {
  let root, main, loops, usage, env;
  const git = (cwd, ...a) =>
    execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" }).trim();
  const newSlice = (extra = {}) => {
    const r = spawnSync("bash", [join(main, "scripts/loops/new.sh"), "slice", "t", "1"], {
      cwd: main,
      env: { ...env, ...extra },
      encoding: "utf8",
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const reading = (percent) => {
    mkdirSync(usage, { recursive: true });
    writeFileSync(
      join(usage, "prd-t.json"),
      JSON.stringify({
        session: "prd-t",
        windows: { fiveHour: { percent, at: iso(Date.now()), resetsAt: iso(Date.now() + 60 * MIN) } },
      }),
    );
  };
  const fresh = () => {
    rmSync(join(loops, "t-1"), { recursive: true, force: true });
    git(main, "worktree", "prune");
    if (git(main, "branch", "--list", "slice/t/1")) git(main, "branch", "-q", "-D", "slice/t/1");
  };

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "drain-sh-")));
    main = join(root, "repo");
    loops = join(main, ".loops");
    usage = join(loops, ".usage");
    const bin = join(root, "bin");
    const nvm = join(root, "nvm");
    mkdirSync(bin);
    mkdirSync(nvm);
    writeFileSync(join(bin, "pnpm"), "#!/usr/bin/env bash\nexit 0\n");
    writeFileSync(join(bin, "lsof"), "#!/usr/bin/env bash\nexit 1\n");
    for (const f of ["pnpm", "lsof"]) chmodSync(join(bin, f), 0o755);
    writeFileSync(join(nvm, "nvm.sh"), "nvm() { :; }\n");
    env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      SAMPLE_STACK_STATE: join(root, "stack-state"),
      NVM_DIR: nvm,
      TRUNK: "dev",
      RISA_FREE_GB: "100",
      RISA_MIN_FREE_GB: "",
      RISA_MAX_PRDS: "",
      RISA_LOAD_GATE: "off",
      RISA_LEASE_ROOT: join(root, "leases"),
      RISA_USAGE_DIR: "",
      RISA_SESSIONS_DIR: "",
      RISA_USAGE_WATCH: "",
      RISA_USAGE_DRAIN: "",
      RISA_USAGE_STOP: "",
      RISA_USAGE_STALE_MIN: "",
    };
    execFileSync("git", ["init", "-q", "-b", "dev", main]);
    for (const [k, v] of [
      ["user.email", "test@example.com"],
      ["user.name", "Test"],
      ["commit.gpgsign", "false"],
    ])
      git(main, "config", k, v);
    mkdirSync(join(main, "scripts/loops"), { recursive: true });
    for (const f of readdirSync(HERE).filter(
      (f) => f.endsWith(".sh") || (f.endsWith(".mjs") && !f.endsWith(".test.mjs")),
    ))
      copyFileSync(join(HERE, f), join(main, "scripts/loops", f));
    // The stack and test DB hooks: the sample project's stub.
    env.RISA_CONFIG = stubHookConfig(main);
    writeFileSync(join(main, ".gitignore"), ".loops/\n.env\n.env.*\n.postgres/\n");
    mkdirSync(join(main, "plans"));
    writeFileSync(join(main, "plans/t-plan.md"), PLAN);
    git(main, "add", ".");
    git(main, "commit", "-q", "-m", "chore: init");
    git(main, "branch", "prd/t");
    mkdirSync(join(main, "packages/data"), { recursive: true });
    mkdirSync(join(main, "apps/web"), { recursive: true });
    writeFileSync(join(main, "packages/data/.env"), 'DATABASE_URL="x"\nSEED_USER_PASSWORD="pw-fictional"\n');
    writeFileSync(join(main, "apps/web/.env"), 'BETTER_AUTH_URL="x"\nCRON_SECRET="s"\n');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("refuses a new slice worktree while draining or limited, with the reason", () => {
    for (const percent of [96, 99]) {
      reading(percent);
      try {
        const r = newSlice();
        expect(r.status, r.out).toBe(1);
        expect(r.out).toMatch(
          new RegExp(
            `refused: slice t-1: usage is ${percent === 96 ? "draining" : "limited"}: 5h ${percent}%`,
          ),
        );
        expect(r.out).toContain("no new slice worktree until it resets");
        expect(existsSync(join(loops, "t-1"))).toBe(false);
      } finally {
        fresh();
      }
    }
  });

  it("makes it under the line, with RISA_USAGE_WATCH=off, or on an unknown or unreadable reading", () => {
    const cases = [
      [() => reading(50), {}],
      [() => reading(99), { RISA_USAGE_WATCH: "off" }],
      [() => rmSync(usage, { recursive: true, force: true }), {}],
      [
        () => {
          mkdirSync(usage, { recursive: true });
          writeFileSync(join(usage, "prd-t.json"), "{ not json");
        },
        {},
      ],
    ];
    for (const [setup, extra] of cases) {
      setup();
      try {
        const r = newSlice(extra);
        expect(r.status, r.out).toBe(0);
        expect(r.out).not.toContain("refused");
        expect(existsSync(join(loops, "t-1"))).toBe(true);
      } finally {
        fresh();
      }
    }
  });
});
