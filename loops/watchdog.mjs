#!/usr/bin/env node
// watchdog: decide whether the machine needs `recover`, and
// run it unattended when it does. The LaunchAgent (`autostart
// install`) runs it at login and every five minutes from the main checkout.
//
//   node watchdog.mjs [--main DIR]            decide; on `recover`, run
//                                             recover.sh --unattended, then
//                                             record the attempt
//   node watchdog.mjs --dry-run [--json]      only the decision and its reason
//
// `decide` is pure: the facts (the last boot, the down record and its time, the
// stay-down mark, the session records, the dispatcher's lock and pause, a kept
// dispatcher intent, a running recover, the usage reading, the last attempts)
// in, `recover` or `nothing` and a reason out. It acts only on evidence of a
// crash or a reboot:
//   - a down record older than the last boot (down, then a restart);
//   - the dispatcher's lock with its pid gone, or its kept intent to reopen;
//   - a hand-opened orchestrator or planner record with no end and its pid gone,
//     started after the last good recover (an older one is history the last
//     recover already saw; a managed one is the dispatcher's to reopen).
// A deliberate stop wins: `down --stay` (.loops/.stay-down.json), a
// paused dispatcher, a down record with no reboot since, or a clean
// `dispatch --stop` (its lock gone) leave everything alone. So does a usage
// reading that says limited (a recover would open sessions that spend): the
// drain's own rule (drain.mjs readDrain, probeAllowed), so the watchdog and the
// dispatcher never disagree. And a recover already running.
//
// A failed recover backs off (10, 20, then every 30 minutes) and only the first
// failure of an incident files recover's report (RISA_RECOVER_REPORT=off for
// the rest); a healthy tick or a good recover ends the incident. recover exiting
// 75 means another one runs: no failure. State: .loops/.watchdog.json. It prints
// a line only when its decision changes (launchd's log, .loops/.watchdog.log),
// and it never fails: a reading or write that breaks is logged and it exits 0.
//
// Env: the drain's (RISA_USAGE_STOP, RISA_USAGE_DRAIN, RISA_USAGE_WATCH,
// RISA_USAGE_STALE_MIN: drain.mjs),
// RISA_BOOT_TIME (tests: the last boot, epoch seconds), RISA_CLOCK_FILE
// (tests: the current epoch second), RISA_RECOVER_BIN (tests: recover.sh),
// RISA_SESSIONS_DIR, RISA_USAGE_DIR.
import { toolCmd } from "./config.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { probeAllowed, readDrain } from "./drain.mjs";

const MIN_MS = 60_000;
/** Back-off after the nth failed recover, in minutes: 10, 20, then 30. */
export const BACKOFF_MAX_MIN = 30;
export const backoffMs = (/** @type {number} */ failures) =>
  failures > 0 ? Math.min(5 * 2 ** failures, BACKOFF_MAX_MIN) * MIN_MS : 0;
/** The session kinds a recover brings back (the recovery agent reopens them). */
const RECOVERED_KINDS = new Set(["prd", "plan"]);

/**
 * @typedef {{ name: string, kind?: string, managed?: boolean, started?: string, ended?: string, live: boolean }} SessionFact
 * @typedef {{ since?: number, lastSuccess?: number, lastAttempt?: number, failures?: number,
 *   incident?: { since: number, reported: boolean } | null, lastLine?: string }} WatchdogState
 * @typedef {{ now: number, bootAt: number | null,
 *   stayDown: { at?: string, why?: string } | null,
 *   downRecord: { at?: string } | null,
 *   dispatcher: { lock: "none" | "live" | "stale", pid: number | null, paused: { at?: string, why?: string } | null },
 *   intent: boolean,
 *   recover: { running: boolean, pid: number | null },
 *   sessions: SessionFact[],
 *   usage: { limited: boolean, why: string },
 *   state: WatchdogState }} WatchdogFacts
 * @typedef {{ action: "recover" | "nothing", reason: string, report?: boolean, healthy?: boolean }} Decision
 */

const ms = (/** @type {unknown} */ v) => {
  const t = typeof v === "number" ? v : Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? t : null;
};
const hhmm = (/** @type {number} */ t) => new Date(t).toISOString().slice(0, 16).replace("T", " ") + "Z";

/**
 * Whether the drain says limited: the dispatcher's own rule (drain.mjs), so the two never
 * disagree; nothing may open a claude then. Pure.
 * @param {import("./drain.mjs").Drain | null | undefined} d
 */
export function limitedOf(d) {
  if (!d) return { limited: false, why: "no reading" };
  return { limited: !probeAllowed(d), why: d.why };
}

/**
 * The watchdog's decision. Pure.
 * @param {WatchdogFacts} f
 * @returns {Decision}
 */
export function decide(f) {
  const s = f.state ?? {};
  if (f.stayDown)
    return {
      action: "nothing",
      reason: `stay-down: ${toolCmd.prd} down --stay${f.stayDown.why ? ` (${f.stayDown.why})` : ""}; ${toolCmd.prd} recover by hand brings it back`,
    };
  if (f.recover.running) return { action: "nothing", reason: `a recover is running (pid ${f.recover.pid})` };
  if (f.dispatcher.paused)
    return {
      action: "nothing",
      reason: `the dispatcher is paused${f.dispatcher.paused.why ? ` (${f.dispatcher.paused.why})` : ""}`,
    };
  const downAt = f.downRecord ? ms(f.downRecord.at) : null;
  const rebootedSinceDown =
    f.downRecord !== null && f.bootAt !== null && (downAt === null || f.bootAt > downAt);
  if (f.downRecord && !rebootedSinceDown)
    return {
      action: "nothing",
      reason: `${toolCmd.prd} down at ${downAt ? hhmm(downAt) : "?"} and no reboot since: left down`,
    };
  if (f.usage.limited) return { action: "nothing", reason: `limited: ${f.usage.why}` };

  /** @type {string[]} */
  const evidence = [];
  if (rebootedSinceDown) evidence.push(`a reboot since ${toolCmd.prd} down`);
  if (f.dispatcher.lock === "stale") evidence.push(`the dispatcher's pid ${f.dispatcher.pid ?? "?"} is gone`);
  else if (f.intent && f.dispatcher.lock !== "live") evidence.push("the dispatcher's kept intent to reopen");
  const baseline = Math.max(s.since ?? f.now, s.lastSuccess ?? 0);
  const crashed = f.sessions
    .filter((r) => RECOVERED_KINDS.has(r.kind ?? "") && !r.managed && !r.ended && !r.live)
    .filter((r) => (ms(r.started) ?? 0) > baseline)
    .map((r) => r.name);
  if (crashed.length) evidence.push(`crashed: ${crashed.join(", ")}`);
  if (!evidence.length)
    return {
      action: "nothing",
      healthy: true,
      reason: f.dispatcher.lock === "none" ? "all healthy (the dispatcher isn't running)" : "all healthy",
    };

  const failures = s.failures ?? 0;
  const next = (s.lastAttempt ?? 0) + backoffMs(failures);
  if (failures > 0 && f.now < next)
    return {
      action: "nothing",
      reason: `backing off after ${failures} failed recover${failures > 1 ? "s" : ""}, until ${hhmm(next)} (${evidence.join("; ")})`,
    };
  return { action: "recover", reason: evidence.join("; "), report: !s.incident?.reported };
}

/**
 * The state after a tick. CODE is recover's exit (null when it didn't run). Pure.
 * @param {WatchdogState} state @param {Decision} d @param {number | null} code @param {number} now
 * @returns {WatchdogState}
 */
export function nextState(state, d, code, now) {
  const s = { ...state, since: state.since ?? now };
  if (d.action === "nothing") return d.healthy ? { ...s, failures: 0, incident: null } : s;
  if (code === 75) return s;
  if (code === 0) return { ...s, lastAttempt: now, lastSuccess: now, failures: 0, incident: null };
  return {
    ...s,
    lastAttempt: now,
    failures: (s.failures ?? 0) + 1,
    incident: { since: s.incident?.since ?? now, reported: true },
  };
}

// ---- the facts

const readObject = (/** @type {string} */ p) => {
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

/** The last boot, in ms: RISA_BOOT_TIME (epoch seconds), else sysctl kern.boottime; null if unknown. */
export function bootTime(env = process.env) {
  if (env.RISA_BOOT_TIME) {
    const n = Number(env.RISA_BOOT_TIME);
    return Number.isFinite(n) && n > 0 ? n * 1000 : null;
  }
  try {
    const out = execFileSync("sysctl", ["-n", "kern.boottime"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = /sec\s*=\s*(\d+)/.exec(out);
    return m ? Number(m[1]) * 1000 : null;
  } catch {
    return null;
  }
}

/** Now, in ms: RISA_CLOCK_FILE's epoch second, else the clock. */
export function nowOf(env = process.env) {
  if (env.RISA_CLOCK_FILE)
    try {
      const n = Number(readFileSync(env.RISA_CLOCK_FILE, "utf8").trim());
      if (Number.isFinite(n)) return n * 1000;
    } catch {
      /* the clock */
    }
  return Date.now();
}

/** Paths in the main checkout's .loops. */
export function pathsOf(/** @type {string} */ main, env = process.env) {
  const loops = join(main, ".loops");
  return {
    loops,
    state: join(loops, ".watchdog.json"),
    stayDown: join(loops, ".stay-down.json"),
    dispatchState: join(loops, ".dispatch.json"),
    sessions: env.RISA_SESSIONS_DIR || join(loops, ".sessions"),
    usage: env.RISA_USAGE_DIR || join(loops, ".usage"),
  };
}

/**
 * Gather the facts. Read-only.
 * @param {string} main @param {NodeJS.ProcessEnv} env
 * @returns {Promise<WatchdogFacts>}
 */
export async function collect(main, env = process.env) {
  const now = nowOf(env);
  const p = pathsOf(main, env);
  const { collectFacts } = await import("./inventory-facts.mjs");
  const { readRecords, isLive, processOf } = await import("./sessions.mjs");
  const inv = collectFacts({ main, env, now });
  const lock = inv.locks.find((l) => l.kind === "dispatch");
  return {
    now,
    bootAt: bootTime(env),
    stayDown: readObject(p.stayDown),
    downRecord: inv.downRecord ?? (inv.downRecordError ? {} : null),
    dispatcher: {
      lock: lock ? (lock.alive ? "live" : "stale") : "none",
      pid: inv.dispatcher.pid,
      paused: readObject(p.dispatchState)?.paused ?? null,
    },
    intent: inv.dispatchIntent !== null,
    recover: { running: inv.recover.running, pid: inv.recover.pid },
    sessions: readRecords(p.sessions).map(({ name, record }) => ({
      name,
      kind: record.kind,
      managed: record.managed === true,
      started: record.started,
      ended: record.ended,
      live: !record.ended && isLive(record, processOf(record.pid ?? 0, Date.now()), Date.now()),
    })),
    usage: limitedOf(readDrain(p.usage, { now, env })),
    state: readObject(p.state) ?? {},
  };
}

function writeState(/** @type {string} */ file, /** @type {WatchdogState} */ state) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

const stamp = (/** @type {number} */ t) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");

async function main() {
  const argv = process.argv.slice(2);
  let mainDir = "";
  let dry = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--main") mainDir = argv[++i] ?? "";
    else if (a === "--dry-run" || a === "-n") dry = true;
    else if (a === "--json") json = true;
    else if (a === "-h" || a === "--help") {
      console.log(
        `${toolCmd.prd} watchdog [--dry-run [--json]]: recover after a reboot or crash (autostart runs it)`,
      );
      return;
    } else {
      console.error(`watchdog: unknown argument ${a} (--dry-run, --json)`);
      process.exit(2);
    }
  }
  const here = dirname(fileURLToPath(import.meta.url));
  if (!mainDir) mainDir = process.env.RISA_MAIN ?? "";
  if (!mainDir)
    mainDir = execFileSync("git", ["-C", here, "worktree", "list", "--porcelain"], { encoding: "utf8" })
      .split("\n")[0]
      .replace(/^worktree /, "");
  const env = process.env;
  const p = pathsOf(mainDir, env);
  const facts = await collect(mainDir, env);
  const d = decide(facts);
  if (dry) {
    console.log(json ? JSON.stringify({ ...d, facts }, null, 2) : `${d.action}: ${d.reason}`);
    return;
  }
  const line = `${d.action}: ${d.reason}`;
  if (line !== facts.state.lastLine || d.action === "recover") console.log(`${stamp(facts.now)} ${line}`);
  let code = null;
  if (d.action === "recover") {
    const recover = env.RISA_RECOVER_BIN || join(here, "recover.sh");
    const r = spawnSync(recover, ["--unattended"], {
      cwd: mainDir,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...env, ...(d.report ? {} : { RISA_RECOVER_REPORT: "off" }) },
    });
    code = r.status ?? 1;
    const end = nowOf(env);
    console.log(
      `${stamp(end)} recover ${code === 0 ? "succeeded" : code === 75 ? "was already running" : `failed (exit ${code})${d.report ? "; reported" : "; already reported this incident"}`}`,
    );
  }
  writeState(p.state, { ...nextState(facts.state, d, code, nowOf(env)), lastLine: line });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // Watching never hurts the work: a broken reading or write is one line, exit 0.
  main().catch((e) => {
    console.error(`watchdog: ${e instanceof Error ? e.message : String(e)}`);
  });
}
