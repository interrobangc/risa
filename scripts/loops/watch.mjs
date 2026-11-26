// pnpm prd watch [<topic>] [--json] [--wait [--timeout <s>]] [--mark <slice> nudged|replied|restarted|left|asked]
// The watch: each slice agent of a topic, its state and the orchestrator's next
// action, from the worker reader's facts (workers.mjs).
//
// States: ok, slow (past the slowest usual slice), quiet (no tool call for the
// quiet limit), no-progress (calls, but no commit or tracked or unignored change
// for the no-progress limit), stopped (its stop recorded), unknown (no heartbeat
// names the worktree). Actions: none, nudge, restart, skeptic.
//
// Never acted on: a worker running a command or holding or queuing for a lease;
// a slice _Status_ marks handed off or merged; a stopped or unknown agent (shown
// only); a slice with an open ask (an `asked` mark, or a question of the topic
// naming the slice) or a `left` mark before its recheck time. Quiet first gets a
// nudge; still quiet RESTART minutes after an unreplied nudge, a restart, unless
// the tree is dirty, a migration changed or a merge is under way, or it is a
// second stall (a nudge or restart before this stall began): then the skeptic.
// No progress goes to the skeptic; slow gets one nudge. A `left` mark past its
// recheck time, an answered `asked` one, or a restart whose stop isn't confirmed
// (still quiet, not stopped, no new agent's call) for RESTART minutes go to the
// skeptic too. A slice is restarted once: `--mark restarted` refuses a second.
//
// Machine sleep: a gap over the sleep gap between two readings, or a wake later
// than a clock (macOS's kern.waketime), resets the clocks to then. All quiet at
// once: two or more quiet agents, or one and its orchestrator, quiet since within
// the quiet limit of each other (a usage limit, a network loss) are one finding
// and nothing is acted on; `--wait` raises a finding once.
//
// Files, per topic, in the main checkout's .loops/.watch/<topic>/ (RISA_WATCH_DIR):
//   marks.jsonl  what the orchestrator did, appended by --mark: { slice, mark, at,
//                until? (left: its recheck time), ask? (asked: its id), note? }
//   state.json   the last reading's time, the clock reset, each slice's pending
//                action and since when (the dispatcher reads it), raised findings
//
// Settings (minutes unless said): RISA_WATCH_QUIET_MIN (20),
// RISA_WATCH_RESTART_MIN (10), RISA_WATCH_NO_PROGRESS_MIN (45),
// RISA_WATCH_LEFT_MIN (60, a `left` mark's recheck without --until),
// RISA_WATCH_SLEEP_GAP (seconds, 600), RISA_WATCH_POLL (seconds, 60);
// RISA_WATCH_WAKE=off ignores the wake time (tests).
// `--wait` exits 0 with the actions once there is one, 75 at --timeout (14400 s).
//
// Pure: decide, watchFacts, planStates, readingClock, parseUntil. The rest
// gathers, reads and writes; a failed state write never fails the watch.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { awaitsAnswer, getAsk, listAsks, shorten, span } from "./asks.mjs";
import { readData, usualTime } from "./metrics.mjs";
import { isLive, processOf, readRecords } from "./sessions.mjs";
import { workerFacts } from "./workers.mjs";
import { branchKinds } from "./config.mjs";

export const MARKS = ["nudged", "replied", "restarted", "left", "asked"];
export const STATES = ["ok", "slow", "quiet", "no-progress", "stopped", "unknown"];
export const ACTIONS = ["none", "nudge", "restart", "skeptic"];

const MIN = 60_000;
const ms = (/** @type {string | null | undefined} */ t) => {
  const n = Date.parse(t ?? "");
  return Number.isNaN(n) ? null : n;
};
const iso = (/** @type {number} */ n) => new Date(n).toISOString();
const ago = (/** @type {number} */ n) => span(Math.max(0, n));

/** The settings from ENV, defaults filled in. */
export function settingsFrom(/** @type {NodeJS.ProcessEnv} */ env = {}) {
  const num = (/** @type {string} */ k, /** @type {number} */ d) => {
    const v = Number(env[k]);
    return env[k] && Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    quietMin: num("RISA_WATCH_QUIET_MIN", 20),
    restartMin: num("RISA_WATCH_RESTART_MIN", 10),
    noProgressMin: num("RISA_WATCH_NO_PROGRESS_MIN", 45),
    leftMin: num("RISA_WATCH_LEFT_MIN", 60),
    sleepGapSec: num("RISA_WATCH_SLEEP_GAP", 600),
    pollSec: num("RISA_WATCH_POLL", 60),
  };
}

/**
 * This reading's clock reset. Pure. A gap over the sleep gap since the last reading
 * resets the clocks to now; else the last reset stands. A wake (kern.waketime)
 * later than both is the reset.
 * @param {{ lastReadingAt?: string | null, clockFrom?: string | null } | null} state
 * @param {number} now @param {number} sleepGapSec @param {number | null} [wokeAt]
 * @returns {{ clockFrom: number | null, gapSeconds: number | null }}
 */
export function readingClock(state, now, sleepGapSec, wokeAt = null) {
  const last = ms(state?.lastReadingAt);
  const gap = last === null ? null : Math.round((now - last) / 1000);
  let from = gap !== null && gap > sleepGapSec ? now : ms(state?.clockFrom);
  if (wokeAt !== null && wokeAt <= now && (from === null || wokeAt > from)) from = wokeAt;
  return { clockFrom: from, gapSeconds: gap !== null && gap > sleepGapSec ? gap : null };
}

/** Each slice's _Status_ state from a plan's text: { "<n>": "<state>" }. Pure. */
export function planStates(/** @type {string} */ text) {
  /** @type {Record<string, string>} */
  const out = {};
  const status = /^## Status\s*$([\s\S]*?)(?=^## )/m.exec(`${text}\n## `)?.[1] ?? "";
  for (const line of status.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length > 4 && /^\d+$/.test(cells[1])) out[cells[1]] = cells[3];
  }
  return out;
}

/** A `left` mark's recheck time from --until (an ISO time, or +<n>m / +<n>h), or null. Pure. */
export function parseUntil(/** @type {string | undefined} */ until, /** @type {number} */ now) {
  if (!until) return null;
  const rel = /^\+(\d+)([mh])$/.exec(until);
  if (rel) return iso(now + Number(rel[1]) * (rel[2] === "h" ? 60 : 1) * MIN);
  const abs = ms(until);
  return abs === null ? null : iso(abs);
}

/** Whether a changed path is a migration (a risky step to restart over). */
const isMigration = (/** @type {string} */ p) => /(^|\/)(migrations|drizzle)\//.test(p);

/**
 * The watch's facts for TOPIC, from the worker reader's. Pure.
 * @param {{ topic: string, facts: ReturnType<typeof workerFacts>, plan: Record<string, string>,
 *   asks: any[], merging?: Record<string, boolean> }} input `asks`: the open questions of the topic
 */
export function watchFacts({ topic, facts, plan, asks, merging = {} }) {
  const re = new RegExp(`^${topic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`);
  const workers = [];
  /** @type {{ lastActivityAt: string | null, stopped: boolean, running: boolean } | null} */
  let orchestrator = null;
  for (const f of facts) {
    if (f.name === topic) {
      const own = f.agents.filter((a) => !a.agent && a.session === `prd-${topic}`);
      if (own.length) {
        const a = own[0];
        orchestrator = {
          lastActivityAt: a.lastActivityAt,
          stopped: Boolean(a.stoppedAt && a.stoppedAt === a.lastActivityAt && !a.running.length),
          running: a.running.length > 0,
        };
      }
      continue;
    }
    const n = re.exec(f.name)?.[1];
    if (!n || f.branch !== branchKinds().branch("slice", topic, n)) continue;
    const agents = f.agents.filter((a) => a.agent);
    const firsts = agents.map((a) => ms(a.firstAt)).filter((t) => t !== null);
    const names = new RegExp(`\\b(slice ${n}|${f.name})\\b`, "i");
    const migration = f.changes.find(isMigration);
    workers.push({
      n,
      name: f.name,
      status: plan[n] ?? null,
      unknown: f.unknown,
      stopped: agents.length > 0 && agents.every((a) => a.stoppedAt && !a.running.length),
      // The latest agent's first call: a restarted agent starts its own clocks.
      firstAt: firsts.length ? iso(Math.max(...firsts)) : null,
      startedAt: firsts.length ? iso(Math.min(...firsts)) : null,
      lastActivityAt: f.lastActivityAt,
      lastProgressAt: f.lastProgressAt,
      running: f.running.map((r) => r.command ?? r.tool ?? "?"),
      leases: f.leases.map((l) => `${l.kind}${l.waiting ? " (queued)" : ""}`),
      dirty: f.changes.length > 0,
      risky: migration ? `a changed migration (${migration})` : merging[f.name] ? "a merge under way" : null,
      openAsk: asks.find((a) => names.test(a.text ?? ""))?.id ?? null,
    });
  }
  return { workers, orchestrator };
}

/**
 * The watch decision. Pure.
 * @param {{
 *   now: number,
 *   workers: ReturnType<typeof watchFacts>["workers"],
 *   orchestrator: ReturnType<typeof watchFacts>["orchestrator"],
 *   marks: Record<string, { mark: string, at: string, until?: string | null, ask?: string | null }[]>,
 *   usual: { samples: number, slowestSeconds: number | null } | null,
 *   settings: ReturnType<typeof settingsFrom>,
 *   clockFrom?: number | null,
 *   askOpen?: (id: string) => boolean,
 *   raised?: string[],
 * }} input `askOpen`: whether an `asked` mark's ask still awaits an answer (default: yes)
 */
export function decide({
  now,
  workers,
  orchestrator,
  marks,
  usual,
  settings,
  clockFrom = null,
  askOpen = () => true,
  raised = [],
}) {
  const quietMs = settings.quietMin * MIN;
  const restartMs = settings.restartMin * MIN;
  /** A clock, reset by a sleep: the later of T and the reset; null stays null. */
  const eff = (/** @type {string | null | undefined} */ t) => {
    const n = ms(t);
    if (n === null) return clockFrom;
    return clockFrom === null ? n : Math.max(n, clockFrom);
  };
  const isQuiet = (/** @type {number | null} */ last) => last !== null && now - last >= quietMs;

  const out = workers.map((w) => {
    const base = { n: w.n, name: w.name };
    const busy = [...w.running, ...w.leases.map((l) => `a ${l} lease`)];
    const last = eff(w.lastActivityAt);
    const first = ms(w.firstAt);
    const progress = Math.max(eff(w.lastProgressAt) ?? 0, first ?? 0) || null;
    /** @type {{ state: string, since: number | null, reason: string }} */
    let s;
    if (w.unknown) s = { state: "unknown", since: null, reason: "no heartbeat names it" };
    else if (w.stopped) s = { state: "stopped", since: last, reason: "its stop is recorded" };
    else if (busy.length) s = { state: "ok", since: null, reason: `running ${shorten(busy[0], 80)}` };
    else if (isQuiet(last))
      s = { state: "quiet", since: last, reason: `no tool call for ${ago(now - (last ?? now))}` };
    else if (progress !== null && now - progress >= settings.noProgressMin * MIN)
      s = {
        state: "no-progress",
        since: progress,
        reason: `calls, but no commit or change for ${ago(now - progress)}`,
      };
    else if (
      usual &&
      usual.samples >= 3 &&
      usual.slowestSeconds !== null &&
      ms(w.startedAt) !== null &&
      now - (ms(w.startedAt) ?? now) > usual.slowestSeconds * 1000
    )
      s = {
        state: "slow",
        since: ms(w.startedAt),
        reason: `${ago(now - (ms(w.startedAt) ?? now))}, past the slowest usual slice (${ago(usual.slowestSeconds * 1000)})`,
      };
    else s = { state: "ok", since: null, reason: last === null ? "" : `last call ${ago(now - last)} ago` };

    const result = (/** @type {string} */ action, /** @type {string} */ why = "") => ({
      ...base,
      state: s.state,
      action,
      reason: [s.reason, why].filter(Boolean).join("; "),
      since: s.since === null ? null : iso(s.since),
    });

    if (w.status && /handed off|merged/i.test(w.status)) return result("none", `_Status_: ${w.status}`);
    if (s.state === "stopped") {
      const newest = [...(marks[w.n] ?? [])].sort((a, b) => (ms(a.at) ?? 0) - (ms(b.at) ?? 0)).pop();
      const restarted = newest?.mark === "restarted";
      return result("none", restarted ? "stop confirmed: spawn its --continue agent" : "");
    }
    if (s.state === "ok" || s.state === "unknown") return result("none");
    if (w.openAsk) return result("none", `open ask ${w.openAsk}`);

    const all = [...(marks[w.n] ?? [])].sort((a, b) => (ms(a.at) ?? 0) - (ms(b.at) ?? 0));
    const lastOf = (/** @type {typeof all} */ list, /** @type {string[]} */ kinds) =>
      [...list].reverse().find((m) => kinds.includes(m.mark));
    const newest = all[all.length - 1];
    const left = lastOf(all, ["left"]);
    if (left && newest === left && (ms(left.until) ?? 0) > now)
      return result("none", `left until ${left.until}`);

    const since = s.since ?? 0;
    const inStall = all.filter((m) => (ms(m.at) ?? 0) >= since);
    const latest = inStall[inStall.length - 1];
    if (latest?.mark === "asked") {
      if (!latest.ask || askOpen(latest.ask))
        return result("none", `asked${latest.ask ? ` (${latest.ask})` : ""}`);
      return result("skeptic", `ask ${latest.ask} is answered and nothing is marked since`);
    }
    if (latest?.mark === "left") return result("skeptic", `left until ${latest.until}: its recheck`);
    if (latest?.mark === "restarted") {
      // Still quiet, not stopped, no new agent's call: the old agent's stop isn't confirmed.
      const markedFor = now - (ms(latest.at) ?? now);
      if (markedFor < restartMs) return result("none", "restart under way: confirm its stop, then spawn");
      return result("skeptic", `its stop isn't confirmed ${ago(markedFor)} after the restart: spawn nothing`);
    }

    if (s.state === "slow") {
      const nudged = all.some((m) => m.mark === "nudged" && (ms(m.at) ?? 0) >= (ms(w.startedAt) ?? 0));
      return nudged ? result("none", "nudged once for being slow") : result("nudge");
    }
    if (s.state === "no-progress") return result("skeptic");

    // Quiet.
    const nudge = lastOf(inStall, ["nudged"]);
    if (!nudge) return result("nudge");
    if (inStall.some((m) => m.mark === "replied" && (ms(m.at) ?? 0) >= (ms(nudge.at) ?? 0)))
      return result("none", "it replied to the nudge");
    const nudgedFor = now - (ms(nudge.at) ?? now);
    if (nudgedFor < restartMs) return result("none", `nudged ${ago(nudgedFor)} ago, no reply yet`);
    const before = all.some(
      (m) => (m.mark === "nudged" || m.mark === "restarted") && (ms(m.at) ?? 0) < since,
    );
    if (w.dirty) return result("skeptic", "uncommitted changes");
    if (w.risky) return result("skeptic", w.risky);
    if (before) return result("skeptic", "a second stall");
    return result("restart", `no reply ${ago(nudgedFor)} after the nudge`);
  });

  // All quiet at once: quiet ones (and a quiet orchestrator) quiet since within the
  // quiet limit of another are one finding, and none of them is acted on.
  const orchLast = orchestrator ? eff(orchestrator.lastActivityAt) : null;
  const orchQuiet = Boolean(
    orchestrator && !orchestrator.stopped && !orchestrator.running && isQuiet(orchLast),
  );
  /** @type {{ who: string, since: number }[]} */
  const quiet = out
    .filter((w) => w.state === "quiet" && !/_Status_/.test(w.reason))
    .map((w) => ({ who: w.n, since: ms(w.since) ?? 0 }));
  if (orchQuiet && orchLast !== null) quiet.push({ who: "orchestrator", since: orchLast });
  const members = quiet.filter((a) => quiet.some((b) => b !== a && Math.abs(a.since - b.since) <= quietMs));
  let finding = null;
  if (members.length >= 2) {
    const sinceMs = Math.min(...members.map((m) => m.since));
    const who = members.map((m) => m.who).sort();
    const key = `${who.join(",")}@${iso(sinceMs)}`;
    finding = {
      key,
      slices: who.filter((x) => x !== "orchestrator"),
      orchestrator: who.includes("orchestrator"),
      since: iso(sinceMs),
      raised: raised.includes(key),
      text: `all quiet at once since ${iso(sinceMs)} (${who.join(", ")}): a usage limit or a network loss? One finding; nothing is restarted`,
    };
    for (const w of out)
      if (members.some((m) => m.who === w.n)) {
        w.action = "none";
        w.reason += "; all quiet at once";
      }
  }
  return {
    workers: out,
    orchestrator: orchestrator
      ? { state: orchQuiet ? "quiet" : "ok", lastActivityAt: orchestrator.lastActivityAt }
      : null,
    finding,
  };
}

/** Whether a decision has something for the orchestrator to do now. */
export const hasAction = (/** @type {ReturnType<typeof decide>} */ d) =>
  d.workers.some((w) => w.action !== "none") || Boolean(d.finding && !d.finding.raised);

// ---- files ----

const topicDir = (/** @type {string} */ dir, /** @type {string} */ topic) => join(dir, topic);

/** Every mark of TOPIC, by slice. A bad line is skipped. */
export function readMarks(/** @type {string} */ dir, /** @type {string} */ topic) {
  /** @type {Record<string, any[]>} */
  const out = {};
  let text;
  try {
    text = readFileSync(join(topicDir(dir, topic), "marks.jsonl"), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    try {
      const m = JSON.parse(line);
      if (m && MARKS.includes(m.mark) && /^\d+$/.test(String(m.slice))) (out[String(m.slice)] ??= []).push(m);
    } catch {
      /* not a mark */
    }
  }
  return out;
}

/** Append a mark (one line: an append never loses another writer's). */
export function writeMark(
  /** @type {string} */ dir,
  /** @type {string} */ topic,
  /** @type {{ slice: string, mark: string, at: string, until?: string | null, ask?: string | null, note?: string | null }} */ m,
) {
  mkdirSync(topicDir(dir, topic), { recursive: true });
  const clean = Object.fromEntries(Object.entries(m).filter(([, v]) => v !== null && v !== undefined));
  appendFileSync(join(topicDir(dir, topic), "marks.jsonl"), `${JSON.stringify(clean)}\n`);
}

/** The topic's state file, or null. */
export function readState(/** @type {string} */ dir, /** @type {string} */ topic) {
  try {
    return JSON.parse(readFileSync(join(topicDir(dir, topic), "state.json"), "utf8"));
  } catch {
    return null;
  }
}

/** The state after a reading: its time, the reset, each pending action and since when. Pure. */
export function nextState(
  /** @type {any} */ prev,
  /** @type {ReturnType<typeof decide>} */ d,
  /** @type {number} */ now,
  /** @type {number | null} */ clockFrom,
  { raise = false } = {},
) {
  /** @type {Record<string, { action: string, since: string }>} */
  const actions = {};
  for (const w of d.workers) {
    if (w.action === "none") continue;
    const before = prev?.actions?.[w.n];
    actions[w.n] = { action: w.action, since: before?.action === w.action ? before.since : iso(now) };
  }
  let findings = Array.isArray(prev?.findings) ? prev.findings : [];
  if (raise && d.finding && !d.finding.raised) findings = [...findings, d.finding.key].slice(-20);
  return {
    lastReadingAt: iso(now),
    clockFrom: clockFrom === null ? null : iso(clockFrom),
    actions,
    findings,
  };
}

function writeState(/** @type {string} */ dir, /** @type {string} */ topic, /** @type {any} */ state) {
  try {
    mkdirSync(topicDir(dir, topic), { recursive: true });
    const file = join(topicDir(dir, topic), "state.json");
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, file);
  } catch {
    /* watching never hurts the work */
  }
}

/** macOS's last wake (sysctl kern.waketime), or null; RISA_WATCH_WAKE=off: none. */
function wakeTime(/** @type {NodeJS.ProcessEnv} */ env) {
  if (env.RISA_WATCH_WAKE === "off") return null;
  try {
    const out = execFileSync("sysctl", ["-n", "kern.waketime"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const sec = Number(/sec = (\d+)/.exec(out)?.[1]);
    return sec > 0 ? sec * 1000 : null;
  } catch {
    return null;
  }
}

/** Whether a worktree has a merge under way. */
function mergingIn(/** @type {string} */ dir) {
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "-q", "--verify", "MERGE_HEAD"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * One reading: gather, decide, write the state. Never throws on a failed write.
 * @param {{ topic: string, env: NodeJS.ProcessEnv, now?: number, raise?: boolean }} opts
 */
export function reading({ topic, env, now = Date.now(), raise = false }) {
  const settings = settingsFrom(env);
  const sessionsDir = env.RISA_SESSIONS_DIR ?? "";
  const loops = dirname(sessionsDir);
  const watchDir = env.RISA_WATCH_DIR || join(loops, ".watch");
  const asksDir = env.RISA_ASKS_DIR || join(loops, ".asks");
  /** @type {Map<number, string>} */
  const live = new Map();
  for (const { name, record } of readRecords(sessionsDir))
    if (record.pid && isLive(record, processOf(record.pid, now), now)) live.set(record.pid, name);
  const facts = workerFacts({
    loops,
    sessionsDir,
    leaseRoot: env.RISA_LEASE_ROOT || join(loops, ".lease"),
    browserRoot: env.RISA_BROWSER_LEASES || undefined,
    live: (session, pid) => live.get(pid) === session,
    now,
  });
  let plan = {};
  try {
    plan = planStates(readFileSync(join(loops, topic, "plans", `${topic}-plan.md`), "utf8"));
  } catch {
    /* no plan: no _Status_ states */
  }
  /** @type {any[]} */
  let asks = [];
  try {
    asks = listAsks(asksDir).filter((a) => a.topic === topic && awaitsAnswer(a));
  } catch {
    /* unreadable asks: none known */
  }
  /** @type {Record<string, boolean>} */
  const merging = {};
  for (const f of facts)
    if (f.branch.startsWith(branchKinds().branch("slice", topic, ""))) merging[f.name] = mergingIn(f.dir);
  const { workers, orchestrator } = watchFacts({ topic, facts, plan, asks, merging });
  const data = readData({
    runLog: env.RISA_RUN_LOG || join(loops, ".run-log.jsonl"),
    checkLog: env.RISA_CHECK_LOG || join(loops, ".check-times.log"),
    flakeLog: "",
  });
  const prev = readState(watchDir, topic);
  const { clockFrom, gapSeconds } = readingClock(prev, now, settings.sleepGapSec, wakeTime(env));
  const d = decide({
    now,
    workers,
    orchestrator,
    marks: readMarks(watchDir, topic),
    usual: usualTime(data, { kind: "slice", branchKind: "slice" }),
    settings,
    clockFrom,
    askOpen: (id) => {
      try {
        const a = getAsk(asksDir, id);
        return a ? awaitsAnswer(a) : false;
      } catch {
        return true;
      }
    },
    raised: Array.isArray(prev?.findings) ? prev.findings : [],
  });
  writeState(watchDir, topic, nextState(prev, d, now, clockFrom, { raise: raise && hasAction(d) }));
  return { topic, at: iso(now), clockFrom: clockFrom === null ? null : iso(clockFrom), gapSeconds, ...d };
}

/** The reading as text. */
export function formatReading(/** @type {ReturnType<typeof reading>} */ r) {
  const lines = [`WATCH ${r.topic} (state, action, why)`];
  if (r.gapSeconds !== null) lines.push(`clocks reset: ${ago(r.gapSeconds * 1000)} since the last reading`);
  if (!r.workers.length) lines.push("no slice worktree");
  const w = Math.max(...r.workers.map((x) => x.name.length), 4);
  for (const x of r.workers)
    lines.push(`${x.name.padEnd(w)}  ${x.state.padEnd(11)}  ${x.action.padEnd(7)}  ${x.reason}`.trimEnd());
  if (r.orchestrator) lines.push(`orchestrator: ${r.orchestrator.state}`);
  if (r.finding) lines.push(`finding${r.finding.raised ? " (raised)" : ""}: ${r.finding.text}`);
  return `${lines.join("\n")}\n`;
}

function usage(/** @type {string} */ why) {
  console.error(`watch: ${why}
usage: pnpm prd watch [<topic>] [--json] [--wait [--timeout <s>]]
       pnpm prd watch [<topic>] --mark <slice> nudged|replied|restarted|left|asked [--until <ISO|+30m>] [--ask <id>] [--note <text>]`);
  process.exit(2);
}

async function main(/** @type {string[]} */ argv) {
  const [topic, ...rest] = argv;
  if (!topic || topic.startsWith("-")) usage("name a topic");
  let json = false;
  let wait = false;
  let timeout = 14_400;
  /** @type {string[] | null} */
  let mark = null;
  /** @type {Record<string, string>} */
  const opt = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json") json = true;
    else if (a === "--wait") wait = true;
    else if (a === "--timeout") timeout = Number(rest[++i]);
    else if (a === "--mark") mark = [rest[++i], rest[++i]];
    else if (["--until", "--ask", "--note"].includes(a)) opt[a.slice(2)] = rest[++i];
    else usage(`unknown argument ${a}`);
  }
  const env = process.env;
  if (!env.RISA_SESSIONS_DIR) usage("RISA_SESSIONS_DIR must be set");
  const watchDir = env.RISA_WATCH_DIR || join(dirname(env.RISA_SESSIONS_DIR ?? ""), ".watch");

  if (mark) {
    const [slice, what] = mark;
    const n = /^(?:.*-)?(\d+)$/.exec(slice ?? "")?.[1];
    if (!n) usage(`--mark takes a slice number, not ${slice ?? "nothing"}`);
    if (!MARKS.includes(what ?? "")) usage(`--mark takes ${MARKS.join(", ")}, not ${what ?? "nothing"}`);
    const now = Date.now();
    const until =
      what === "left" ? (parseUntil(opt.until, now) ?? iso(now + settingsFrom(env).leftMin * MIN)) : null;
    if (what === "left" && opt.until && !parseUntil(opt.until, now))
      usage(`--until ${opt.until}: not a time`);
    if (opt.ask && !/^a\d+$/.test(opt.ask)) usage(`--ask ${opt.ask}: not an ask id`);
    const before =
      what === "restarted" && readMarks(watchDir, topic)[String(n)]?.find((m) => m.mark === "restarted");
    if (before) {
      console.error(
        `watch: ${topic}-${n} was restarted once already (${before.at}): a second restart is refused; leave it or ask`,
      );
      return 1;
    }
    writeMark(watchDir, topic, {
      slice: String(n),
      mark: String(what),
      at: iso(now),
      until,
      ask: what === "asked" ? (opt.ask ?? null) : null,
      note: opt.note ?? null,
    });
    console.log(`${topic}-${n}: ${what}${until ? ` until ${until}` : ""}`);
    return 0;
  }

  const deadline = Date.now() + timeout * 1000;
  for (;;) {
    const r = reading({ topic, env, raise: wait });
    if (!wait || hasAction(r)) {
      process.stdout.write(json ? `${JSON.stringify(r, null, 2)}\n` : formatReading(r));
      return 0;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      console.error(`watch: nothing to act on in ${timeout}s`);
      return 75;
    }
    await new Promise((res) => setTimeout(res, Math.min(left, settingsFrom(env).pollSec * 1000)));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2)).then((code) => process.exit(code));
