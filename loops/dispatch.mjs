#!/usr/bin/env node
// prd dispatch: the dispatcher. Started once in a terminal tab of its own
// and left there; every tick it gathers the facts, asks the pick
// (dispatch-pick.mjs) for one action and does it, then logs the action and
// why it passed every other topic over.
//
//   prd dispatch [--every <seconds>]   tick every SECONDS (default 60) until stopped
//   prd dispatch --once                one tick, then exit
//   prd dispatch --dry-run             one tick's pick, printed: writes and opens nothing
//   prd dispatch --pause [<why>]       the running dispatcher (and any later one) does nothing
//   prd dispatch --resume              undo --pause
//   prd dispatch --stop                end the running dispatcher (TERM; waits
//                                           RISA_DISPATCH_STOP_SECS, 10, for it to go)
//   prd dispatch --restart [--every <s>] stop it as --stop does, then start one through the tool's
//                                           command (its current release) in a background tab, keeping
//                                           its --every and keep-alive state; none running: starts one;
//                                           no iTerm2: refuses before stopping anything
//   prd dispatch --cap <n>|default     the PRD cap (lanes), read every tick: running PRDs finish
//   prd dispatch --allow <topic>|none  between the drain line and the stop, TOPIC still starts, plans,
//                                           reopens and resumes (read every tick; drain.mjs drainHolds)
//
// The actions:
//   - start: `new.sh prd <topic>`, then a managed, run-through orchestrator
//     (session.sh prd-<t> --auto --managed, prompt.sh orchestrator <t> --auto)
//     in a background iTerm2 tab (the opener's --command … --background);
//   - plan: `new.sh plan <topic>`, then a managed, run-through planner
//     (session.sh plan-<t> --auto --managed, --model opus or fable for a `design` row, prompt.sh plan <t>
//     --auto) the same way; no item ids: the prompt reads the topic's items;
//   - reopen: the opener (`open-session.sh <worktree> --background`), counted
//     once its tab opens;
//   - keep-alive (keep-alive.mjs), beside the pick and outside the PRD slots:
//     a fresh managed backlog session, and the inbox session (once its folder
//     is trusted), through the opener when none is live, or its own question
//     after three quick deaths. RISA_KEEP_SESSIONS=off;
//   - session requests (session-requests.mjs), after the keep-alive and before
//     starts: the oldest pending one opens backlog-<name>, or is refused, with a
//     notice either way. RISA_MAX_BACKLOG_SESSIONS (4);
//   - ask: a reopen question filed with `prd ask` (session "dispatch"),
//     then a one-shot helper session (haiku, Remote Control, in a background
//     tab) whose prompt is "send this PushNotification, then prd end"; a
//     helper that can't start is ignored (the ask's own macOS notification and
//     RISA_ASK_NOTIFY still fire). Its answer is acted on in a later tick:
//     "reopen again" resets the count, "hold the topic" flags the row `hold`.
// The session record (managed, auto) is written before a new session's tab
// opens, so a tab that opens but never starts is reopened like a dead session.
// An opener that fails (the tab never opened) is no death: a reopen isn't
// counted, a kept session's quick deaths stay as they were, and a start's or
// plan's worktree made on that tick is removed (rm.sh); one line is logged and
// a later tick tries again. So is one whose new.sh failed after making it.
//
// Each tick also follows up on managed orchestrators, backlog and inbox sessions that
// stay over the context limit (dispatch-context.mjs): a nudge, a defaulting
// question, the rotation. RISA_CONTEXT_NUDGE_MIN (15); RISA_CONTEXT_WATCH=off stops it.
//
// Each tick also catches a stuck managed, run-through orchestrator (dispatch-stuck.mjs):
// one question per stall that never defaults ("rotate it now", the mid-wave
// rotation, or "leave it"). RISA_STUCK_MIN (30), RISA_STUCK_NOTIFIED_MIN (10: a
// notification with no turn after it); RISA_STUCK_WATCH=off stops it.
//
// Every RISA_PICKUP_EVERY seconds (300; `off` never), on a tick that isn't
// paused, it runs the pickup (`prd dev-sync`), so lines pushed to
// origin/dev reach the main checkout; a failed or refused one logs one line and
// the tick carries on.
//
// Every TIDY_EVERY_MS (six hours), on a tick that does nothing else (and isn't
// paused), it runs `prd tidy --yes`. Without iTerm2 it refuses to run (it
// couldn't open sessions); --dry-run works anywhere.
//
// Each tick first takes the drain decision (drain.mjs) from the usage readings
// (usage.mjs, .loops/.usage/): draining (RISA_USAGE_DRAIN, 85%) holds starts,
// plans, reopens and the keep-alive (--resume doesn't override it; --allow <topic> lets that
// one topic start, plan, reopen and resume, .loops/.drain-allow); limited
// (RISA_USAGE_STOP, 98%, overage, or a session stopped on a limit) also ends
// each managed prd or plan session not running a landing (marked stalled; KILL a tick
// later if it ignored TERM), files one report naming the live hand-opened, backlog and
// inbox ones (never ended), and opens no
// claude at all: no helper, session request, context or stuck follow-up. An
// unknown reading never drains; with a session live past RISA_USAGE_STALE_MIN,
// it files one report per incident. RISA_USAGE_WATCH=off turns it off.
//
// Then, before the pick, the resume after a limit (resume.mjs): each managed orchestrator
// or planner marked stalled whose reset has passed is claimed (its mark cleared), so the
// pick never counts it as a death; a live one is ended (TERM, KILL a tick later), and a
// dead one reopened through the opener with --continue and the carry-on prompt
// (open-session.sh --carry-on), one per tick, taking the tick's action, never counted
// toward the reopen limit. Never while paused, draining or limited, during a prd
// command or with a landing marker; a hand-opened session's mark is only reported.
//
// After the pick, the finish of a landed topic (finish.mjs, finishStep): a non-standing
// topic landed in the trunk (landedTopics or landedWithCode) with a worktree, a slot or a
// row not done left; the first in row order whose decision acts (ends its idle recorded
// sessions, runs rm, files one report) or reports (once per topic, reasons and tip:
// .dispatch.json `finish.reported`). Never while paused or draining; --dry-run prints
// `finish: would …`.
//
// Between ticks (never mid-tick) it compares the hash of its code (codeHash: the
// non-test .mjs files of loops/ and backlog/, hashed at its start) with its target's
// (staleness): a dispatcher run from a checkout targets that checkout, which a landing
// or the pickup changes; one run from a release install (~/.risa/releases/<tag>, or
// the folder the `risa` link resolved to at its start) targets the folder `risa` now
// points to (`risa --root`: bin/risa's own resolution), so a new install moves it
// (RISA-981). Changed, it logs one line and re-execs (process.execve: the same pid,
// tab and lock) on the target's dispatch.mjs, so it never runs old code past one tick
// (B-809). Its start writes the hash, its folder and whether it follows the link into
// .dispatch.json (`code`), and `prd status` says whether the running one's code is
// current or stale against the same target.
//
// Files, in the main checkout's .loops: .dispatch.lock (the running
// instance's pid; a lock whose pid is gone is taken over), .dispatch.json (the
// state: paused and why, reopen counts, the open reopen asks, the last tidy and pickup,
// keepAlive: each kept kind's quick deaths, last open, open ask and stop; inboxReported:
// the untrusted inbox's report filed; stopped: the last end's pid, time and why;
// home: for a project with `inbox`, this run's claims, the homes file's last fetch
// and the reports filed, home.mjs),
// .dispatch.log (each acting tick, and each idle one whose lines changed, and one
// line for every way it ends: a signal, an uncaught error, a lost lock, a re-exec;
// a gone pid with no stop mark crashed or was SIGKILLed, RISA-1037).
//
// Env: RISA_MAX_PRDS (4; a stored --cap, .loops/.prd-cap, wins over it), RISA_MAX_PLANNERS (1), RISA_FIXES_MIN (3):
// the pick's caps; RISA_LOAD_* (load-gate.mjs); RISA_SESSIONS_DIR,
// RISA_ASKS_DIR; RISA_ITERM_APP (the host layer's, host.mjs: where iTerm2 is);
// RISA_CLAUDE_BIN (the helper's claude; its config folder: host.mjs); RISA_CLOCK_FILE (tests: epoch
// seconds standing in for the clock).
//
// Home machines (home.mjs, loaded only for a project with `inbox`, at the start): each
// tick asks it whose home the project is. Another machine's (or unknown yet) makes the
// tick start, plan, reopen, resume, keep alive and open requested sessions for nothing,
// with a line each tick and one report; the inbox kind stays closed unless this repo
// keeps it and the `inbox` home is this machine's. A project without `inbox` is untouched.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dismissAsk, getAsk, listAsks, settleDue } from "./asks.mjs";
import { CAPTAIN_SESSION, nextCaptain } from "./captain.mjs";
import { contextDirOf, hardLimitOf, limitOf, sizeRecord, updateRecord } from "./context.mjs";
import { CONTEXT_OPTIONS, CONTEXT_SESSION, commandUnder, contextDecision } from "./dispatch-context.mjs";
import { DISPATCH_SESSION, KEEP_SESSION, REOPEN_OPTIONS, formatPick, pick } from "./dispatch-pick.mjs";
import {
  STUCK_OPTIONS,
  STUCK_SESSION,
  busyUnder,
  stuckClock,
  stuckDecision,
  stuckSettings,
  transcriptNotifiedAt,
} from "./dispatch-stuck.mjs";
import {
  LIMITED_ERROR,
  allowableTopic,
  drainDecision,
  drainSettings,
  landingUnder,
  limitActions,
  sessionAccount,
  readAllowance,
  sessionDrains,
  stalledSessions,
} from "./drain.mjs";
import { heartbeatDirOf, readHeartbeats } from "./heartbeat.mjs";
import { MACHINE_DIR, workSwitch } from "./machine.mjs";
import { listRecords as listLandings } from "./land-journal.mjs";
import {
  applyFinish,
  failedKey,
  finishDecision,
  finishPick,
  gatherFinish,
  landedWithCode,
} from "./finish.mjs";
import { doneFlags, landedTopics } from "./landed.mjs";
import { briefProblem } from "./rotate.mjs";
import { START_GRACE_MS, clearKeepStops, keepAliveDecision, keepAnswerAction } from "./keep-alive.mjs";
import { readLoadGate } from "./load-gate.mjs";
import { createNotice } from "./notices.mjs";
import {
  canOpenTabs,
  claudeAccount,
  claudeBin,
  claudeChoiceFor,
  claudeEnvPrefix,
  claudeName,
  itermApp,
} from "./host.mjs";
import { inboxDirOf, inboxUntrusted } from "./open-session.mjs";
import { plannerModel } from "./planner-model.mjs";
import { heldText } from "../backlog/registry.mjs";
import {
  DEFAULT_MAX_BACKLOG_SESSIONS,
  readRequests,
  requestDecision,
  requestLine,
  requestNotice,
  settleRequest,
} from "./session-requests.mjs";
import { isLive, processOf, processTable, readRecord, readRecords, writeRecord } from "./sessions.mjs";
import { resumeDecision, resumingOf, sessionOfBranch } from "./resume.mjs";
import { clearStalled, markStalled, readReadings, readUsage, staleMsOf } from "./usage.mjs";
import { branchKinds, inboxStore, loadConfig, toolCmd } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** How often an idle tick runs `prd tidy --yes`. */
export const TIDY_EVERY_MS = 6 * 3600_000;
/** How often the pickup (`prd dev-sync`) runs by default, in seconds (RISA_PICKUP_EVERY). */
export const PICKUP_EVERY_S = 300;
/** The longest a pickup may take before the tick gives up on it (a hung fetch). */
export const PICKUP_TIMEOUT_MS = 120_000;
/** A reopened session live this long has recovered: its reopen count is dropped. */
export const REOPEN_RESET_MS = 30 * 60_000;
/** The one-shot helper that pushes the dispatcher's own asks. */
export const HELPER_SESSION = "dispatch-push";
/** The marker of the home's reports (home.mjs). */
export const HOME_SESSION = "dispatch-home";

// ---- the pure parts ----------------------------------------------------------------

/** What a reopen ask's answer means: "reset" (reopen again), "hold", or null (unclear). */
export function answerAction(/** @type {string | null | undefined} */ answer) {
  const a = String(answer ?? "")
    .trim()
    .toLowerCase();
  if (a === REOPEN_OPTIONS[0] || /^(1|reopen|again|yes)\b/.test(a)) return "reset";
  if (a === REOPEN_OPTIONS[1] || /^(2|hold)\b/.test(a)) return "hold";
  return null;
}

/** The pickup's period in ms from RISA_PICKUP_EVERY (seconds), or null when it is off. */
export function pickupEvery(/** @type {string | undefined} */ value) {
  if (value === "off") return null;
  const n = Number(value);
  return (value && Number.isFinite(n) && n > 0 ? n : PICKUP_EVERY_S) * 1000;
}

/** Whether this tick runs the pickup: not paused, not off, a period since the last (or none yet). */
export function pickupDue(
  /** @type {{ lastPickup?: number }} */ state,
  /** @type {number} */ now,
  /** @type {{ paused: boolean, everyMs: number | null }} */ { paused, everyMs },
) {
  if (paused || everyMs === null) return false;
  return typeof state.lastPickup !== "number" || now - state.lastPickup >= everyMs;
}

/** Whether this tick runs tidy: nothing else happened, not paused, six hours since the last. */
export function tidyDue(
  /** @type {{ lastTidy?: number }} */ state,
  /** @type {number} */ now,
  /** @type {{ action: string, paused: boolean }} */ tick,
) {
  if (tick.action !== "none" || tick.paused) return false;
  return typeof state.lastTidy === "number" && now - state.lastTidy >= TIDY_EVERY_MS;
}

/** A word safe in a shell line as is, else single-quoted. */
export const sh = (/** @type {string} */ s) =>
  /^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

/** The command a new managed, run-through session's tab runs. */
export function sessionLine(
  /** @type {{ kind: "prd" | "plan", topic: string, dir: string, wrapper: string, model?: string }} */ s,
) {
  const name = `${s.kind}-${s.topic}`;
  const head = `cd ${sh(s.dir)} && ${sh(s.wrapper)} ${name} --auto --managed -- `;
  // The prompt script beside the wrapper: the tool's own, which the project doesn't have.
  const prompt = sh(join(dirname(s.wrapper), "prompt.sh"));
  return s.kind === "plan"
    ? `${head}--model ${sh(s.model ?? "opus")} --remote-control ${name} "$(${prompt} plan ${sh(s.topic)} --auto)"`
    : `${head}--remote-control ${name} "$(${prompt} orchestrator ${sh(s.topic)} --auto)"`;
}

/** The helper's whole prompt: push LINE, then end. */
export const helperPrompt = (/** @type {string} */ line) =>
  `You are a one-shot helper for the dispatcher. Do exactly two things and nothing else: ` +
  `call the PushNotification tool once with this text: ${JSON.stringify(line)}. ` +
  `Then run \`${toolCmd.prd} end\` in Bash (it ends this session and closes its tab).`;

/**
 * The helper's claude: claudeBin, after the Claude config folder it gets for MAIN's
 * repo (host.mjs; its role is `helper`). The sessions the dispatcher starts get theirs
 * from session.sh.
 */
const helperClaude = (/** @type {string} */ main, /** @type {NodeJS.ProcessEnv} */ env) => ({
  claude: claudeBin(env),
  prefix: claudeEnvPrefix(claudeChoiceFor({ main, role: "helper", env })),
});

/** The helper's tab command; PREFIX (host.mjs claudeEnvPrefix) sets its claude's config folder. */
export const helperLine = (
  /** @type {{ main: string, claude: string, line: string, prefix?: string }} */ h,
) =>
  `cd ${sh(h.main)} && ${h.prefix ?? ""}${sh(h.claude)} --model haiku --remote-control ${HELPER_SESSION} ${sh(helperPrompt(h.line))}`;

// ---- files -----------------------------------------------------------------------

/** The main checkout: the first worktree of the repo this file is in. */
export function mainCheckout(/** @type {string | undefined} */ from) {
  // The repo lib.sh found for this command (RISA_MAIN), else the one this file is in.
  if (!from && process.env.RISA_MAIN) return process.env.RISA_MAIN;
  return execFileSync("git", ["-C", from ?? HERE, "worktree", "list", "--porcelain"], { encoding: "utf8" })
    .split("\n")[0]
    .replace(/^worktree /, "");
}

/** The code files whose hash says which dispatcher runs: non-test, non-fixture .mjs files. */
const CODE_DIRS = ["loops", "backlog"];

/**
 * The hash of the dispatcher's code under ROOT (a checkout): every non-test .mjs
 * file in CODE_DIRS, by name and content; null when it can't be read.
 */
export function codeHash(/** @type {string} */ root) {
  try {
    const h = createHash("sha256");
    for (const d of CODE_DIRS) {
      const names = readdirSync(join(root, d))
        .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs") && !f.endsWith("-fixture.mjs"))
        .sort();
      for (const f of names)
        h.update(`${d}/${f}\0`)
          .update(readFileSync(join(root, d, f)))
          .update("\0");
    }
    return h.digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

/** This dispatcher's own tool folder: a checkout or a release install. */
const OWN_ROOT = join(HERE, "..");

/** The hash this dispatcher's code had when it started (read now, before any landing). */
const CODE_AT_START = codeHash(OWN_ROOT);

/** A path with its symlinks resolved, when it exists. @param {string} p */
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * The tool folder the `risa` on PATH runs from now, asked of bin/risa itself
 * (`risa --root` prints the folder its own link resolution found), so a moved
 * install link is seen; null when no `risa` answers with one.
 */
export function linkedRoot(env = process.env) {
  try {
    const out = execFileSync("risa", ["--root"], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    return out && !out.includes("\n") && isAbsolute(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Whether a dispatcher whose code is in OWN follows the `risa` link: it runs from
 * a release install (a folder of HOME/.risa/releases) or from the folder the link
 * (LINKED: linkedRoot's) resolves to now. A checkout elsewhere follows its own code.
 * @param {string} own @param {string | null} linked @param {string} [home]
 */
export function followsLink(own, linked, home = homedir()) {
  const o = real(own);
  return (linked !== null && real(linked) === o) || dirname(o) === real(join(home, MACHINE_DIR, "releases"));
}

/** The folder a dispatcher compares and re-execs into: the link's when it follows one that answers, else its own. */
export const codeTarget = (
  /** @type {string} */ own,
  /** @type {boolean | undefined} */ follows,
  /** @type {string | null} */ linked,
) => (follows && linked ? linked : own);

/**
 * The staleness check between ticks: the target folder (codeTarget, the link read
 * now when FOLLOWS), its code's hash, whether that differs from STARTED, and the
 * dispatch.mjs a re-exec runs.
 * @param {{ started: string | null, own: string, follows: boolean, env?: NodeJS.ProcessEnv }} o
 */
export function staleness({ started, own, follows, env = process.env }) {
  const root = codeTarget(own, follows, follows ? linkedRoot(env) : null);
  const hash = codeHash(root);
  return { root, hash, stale: staleCode(started, hash), script: join(root, "loops", "dispatch.mjs") };
}

/** Stale: both hashes known and different (an unreadable one is never stale). */
export const staleCode = (
  /** @type {string | null | undefined} */ started,
  /** @type {string | null} */ now,
) => Boolean(started && now && started !== now);

/**
 * The dispatcher's loop: STEP (one tick), then a sleep of EVERY seconds, until
 * stopped. Before each tick but the first, CURRENT (the tool's own code
 * hash) is compared with STARTED: changed, it returns { stale: true } without
 * ticking, so the caller re-execs between ticks. --once ticks once.
 */
export async function runLoop(
  /** @type {{ every: number, once?: boolean, step: () => void, started: string | null,
   *   current: () => string | null, sleep?: (ms: number) => Promise<unknown> }} */ {
    every,
    once = false,
    step,
    started,
    current,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  },
) {
  for (let n = 0; ; n++) {
    if (n > 0) {
      const now = current();
      if (staleCode(started, now)) return { stale: true, from: started, to: now };
    }
    step();
    if (once) return { stale: false };
    await sleep(every * 1000);
  }
}

export function pathsOf(/** @type {string} */ main, env = process.env) {
  const loops = join(main, ".loops");
  return {
    main,
    loops,
    lock: join(loops, ".dispatch.lock"),
    state: join(loops, ".dispatch.json"),
    log: join(loops, ".dispatch.log"),
    sessions: env.RISA_SESSIONS_DIR || join(loops, ".sessions"),
    asks: env.RISA_ASKS_DIR || join(loops, ".asks"),
    requests: env.RISA_REQUESTS_DIR || join(loops, ".requests"),
    notices: env.RISA_NOTICES_DIR || join(loops, ".notices"),
    cap: join(loops, ".prd-cap"),
    allow: join(loops, ".drain-allow"),
    watch: env.RISA_WATCH_DIR || join(loops, ".watch"),
    usage: env.RISA_USAGE_DIR || join(dirname(env.RISA_SESSIONS_DIR || join(loops, ".sessions")), ".usage"),
    landing: env.RISA_LANDING_DIR || join(loops, ".landing"),
  };
}

/** The highest --cap: the slots (lib.sh, 1-19). */
export const MAX_CAP = 19;

/** The stored --cap (.loops/.prd-cap, lib.sh reads it too), or null when none or not 1-MAX_CAP. */
export function storedCap(/** @type {string} */ file) {
  let text;
  try {
    text = readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
  const n = /^[1-9][0-9]?$/.test(text) ? Number(text) : 0;
  return n >= 1 && n <= MAX_CAP ? n : null;
}

/** The PRD cap and what set it: the stored --cap, else RISA_MAX_PRDS, else 4. */
export function prdCapOf(/** @type {string} */ file, env = process.env) {
  const stored = storedCap(file);
  if (stored !== null) return { cap: stored, from: `${toolCmd.prd} dispatch --cap` };
  const fromEnv = positive(env.RISA_MAX_PRDS, 0);
  return fromEnv ? { cap: fromEnv, from: "RISA_MAX_PRDS" } : { cap: 4, from: "default" };
}

/** @typedef {{ paused?: { at: string, why: string } | null, lastTickAt?: number,
 *   reopens?: Record<string, number>,
 *   asked?: Record<string, { id: string, topic: string }>, lastTidy?: number,
 *   context?: Record<string, import("./dispatch-context.mjs").ContextEntry>,
 *   stuck?: { lastTickAt?: number, clockFrom?: number | null,
 *     sessions?: Record<string, import("./dispatch-stuck.mjs").StuckEntry>, reported?: string[] },
 *   keepAlive?: import("./keep-alive.mjs").KeepState,
 *   drain?: { state?: string, unknownReported?: boolean, reported?: string[], allow?: string | null },
 *   inboxReported?: boolean,
 *   home?: import("./home.mjs").HomeState,
 *   resume?: { claimed?: Record<string, import("./resume.mjs").Claim> },
 *   finish?: { reported?: string[] },
 *   code?: { hash: string | null, pid: number, at: string, root?: string, follows?: boolean,
 *     every?: number },
 *   stopped?: { pid: number, stoppedAt: string, why: string } | null,
 *   stopRequest?: { pid: number, by: string } | null }} DispatchState */

/** @returns {DispatchState} */
export function readState(/** @type {string} */ file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** Re-reads the state, applies FN, writes it atomically: a --pause written mid-tick survives. */
export function updateState(/** @type {string} */ file, /** @type {(s: DispatchState) => void} */ fn) {
  const s = readState(file);
  fn(s);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, file);
  return s;
}

const alive = (/** @type {number} */ pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
};

/** The running dispatcher's pid, or null (no lock, or its pid is gone). */
export function lockHolder(/** @type {string} */ lock) {
  try {
    const pid = Number(readFileSync(lock, "utf8").trim());
    return alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** How long a takeover guard may stand before it counts as a crashed taker's and is removed. */
export const TAKEOVER_STALE_MS = 10_000;
/** How long a taker waits for another's takeover guard before it gives up. */
const TAKEOVER_WAIT_MS = 2_000;

const pause = (/** @type {number} */ ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Takes the lock: { ok: true } or { ok: false, pid } (another runs; 0 when a
 * racing taker's takeover outlasts the wait). A dead holder's lock is taken over
 * under a guard directory (`<lock>.takeover`, made atomically): only the guard's
 * holder re-reads the lock, removes a still-dead holder's and writes its own, so
 * of two takers racing over one stale lock exactly one holds it (B-454). A guard
 * older than TAKEOVER_STALE_MS is a crashed taker's and is removed.
 * `between` (tests only) runs after the stale holder is read, before the takeover.
 */
export function takeLock(
  /** @type {string} */ lock,
  /** @type {{ pid?: number, between?: () => void }} */ { pid = process.pid, between } = {},
) {
  mkdirSync(dirname(lock), { recursive: true });
  const guard = `${lock}.takeover`;
  const deadline = Date.now() + TAKEOVER_WAIT_MS;
  for (;;) {
    try {
      writeFileSync(lock, `${pid}\n`, { flag: "wx" });
      return { ok: true };
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") throw e;
    }
    const holder = lockHolder(lock);
    if (holder && holder !== pid) return { ok: false, pid: holder };
    between?.();
    try {
      mkdirSync(guard);
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") throw e;
      // Another taker is mid-takeover: wait for it, or clear a crashed one's guard.
      try {
        if (Date.now() - statSync(guard).mtimeMs > TAKEOVER_STALE_MS) rmdirSync(guard);
      } catch {
        /* its taker just finished */
      }
      if (Date.now() > deadline) return { ok: false, pid: lockHolder(lock) ?? 0 };
      pause(20);
      continue;
    }
    try {
      // Re-read under the guard: a racing taker may have taken it since.
      const now = lockHolder(lock);
      if (now && now !== pid) return { ok: false, pid: now };
      try {
        unlinkSync(lock);
      } catch {
        /* already gone */
      }
      writeFileSync(lock, `${pid}\n`, { flag: "wx" });
      return { ok: true };
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") throw e;
      return { ok: false, pid: lockHolder(lock) ?? 0 };
    } finally {
      try {
        rmdirSync(guard);
      } catch {
        /* gone */
      }
    }
  }
}

/**
 * Sends HOLDER TERM and waits RISA_DISPATCH_STOP_SECS (10) for it to free the lock:
 * true once it has. It releases the lock on its way out (a zombie still answers kill 0).
 * BY (--stop, --restart) goes in the state first, for the stop mark's why (RISA-1037).
 */
async function stopHolder(
  /** @type {{ lock: string, state: string }} */ { lock, state },
  /** @type {number} */ holder,
  /** @type {string} */ by,
) {
  try {
    updateState(state, (s) => {
      s.stopRequest = { pid: holder, by };
    });
  } catch {
    /* the TERM still stops it; its mark just won't say who sent it */
  }
  process.kill(holder, "SIGTERM");
  const held = () => lockHolder(lock) === holder;
  const waits = Math.max(1, Math.round(Number(process.env.RISA_DISPATCH_STOP_SECS || 10) * 10));
  for (let i = 0; i < waits && held(); i++) await new Promise((r) => setTimeout(r, 100));
  return !held();
}

/** The running dispatcher's --every: the one its start wrote, else its command line's, else null. */
export function everyOf(/** @type {number} */ pid, /** @type {DispatchState} */ state) {
  const kept = state.code?.pid === pid ? Number(state.code?.every) : 0;
  if (kept > 0) return kept;
  const r = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
  const m = /(?:^|\s)--every\s+([0-9.]+)(?:\s|$)/.exec(r.stdout ?? "");
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}

/** An error's first line, for a log line or a stop mark: "Error: boom". */
export const firstLine = (/** @type {unknown} */ e) =>
  (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).split("\n")[0];

/** The end hook a running dispatcher sets (RISA-1037): main's own rejection reaches it too. */
let onEnd = /** @type {((why: string) => void) | null} */ (null);

/** home.mjs, when the project has `inbox` (main loads it); null: no homes. */
let homeModule = /** @type {typeof import("./home.mjs") | null} */ (null);

/** Loads home.mjs for a project whose config has `inbox`; else null, loading nothing new. */
export async function loadHome(env = process.env) {
  try {
    if (!inboxStore(loadConfig({ env }).config)) return null;
  } catch {
    return null;
  }
  homeModule = await import("./home.mjs");
  return homeModule;
}

const releaseLock = (/** @type {string} */ lock) => {
  try {
    if (Number(readFileSync(lock, "utf8").trim()) === process.pid) unlinkSync(lock);
  } catch {
    /* gone */
  }
};

// ---- facts -----------------------------------------------------------------------

const nowOf = (env = process.env) => {
  if (env.RISA_CLOCK_FILE) {
    const s = Number(readFileSync(env.RISA_CLOCK_FILE, "utf8").trim());
    if (Number.isFinite(s)) return s * 1000;
  }
  return Date.now();
};

const run = (/** @type {string} */ cmd, /** @type {string[]} */ args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
  return { ok: r.status === 0, code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};

const backlog = (/** @type {string} */ main, /** @type {string[]} */ args) =>
  run("node", [join(HERE, "../backlog/backlog.mjs"), ...args], { cwd: main });

/** The .loops worktrees: { name, branch, dir }. */
export function worktreesOf(/** @type {string} */ main) {
  const loops = join(main, ".loops");
  const out = [];
  let dir = "";
  for (const l of execFileSync("git", ["-C", main, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
  }).split("\n")) {
    if (l.startsWith("worktree ")) dir = l.slice(9);
    else if (l.startsWith("branch ") && dirname(dir) === loops)
      out.push({ name: basename(dir), branch: l.slice(7).replace(/^refs\/heads\//, ""), dir });
  }
  return out;
}

const positive = (/** @type {string | undefined} */ s, /** @type {number} */ d) =>
  s && Number(s) > 0 ? Number(s) : d;

/** Everything the pick needs, and the records for the bookkeeping. */
export function gather(/** @type {ReturnType<typeof pathsOf>} */ p, env = process.env) {
  const listed = backlog(p.main, ["prd", "list", "--json"]);
  if (!listed.ok) throw new Error(`${toolCmd.backlog} prd list failed: ${listed.err || listed.out}`);
  const rows = JSON.parse(listed.out);
  const records = readRecords(p.sessions).map(({ name, record }) => {
    // When it went rotating: the record's own time if it has one, else the file's mtime (the
    // last write is rotate-into.sh's marking), so an old marking reads as old, never as just now.
    let rotatingAt = record.rotating
      ? (/** @type {{ rotatingAt?: string }} */ (record).rotatingAt ?? null)
      : null;
    if (record.rotating && rotatingAt === null)
      try {
        rotatingAt = statSync(join(p.sessions, `${name}.json`)).mtimeMs;
      } catch {
        /* gone */
      }
    return { name, record, live: isLive(record, processOf(record.pid ?? 0)), rotatingAt };
  });
  const state = readState(p.state);
  const gate = readLoadGate(env);
  const worktrees = worktreesOf(p.main);
  // The landed guard's candidates (dispatch-pick.mjs, rule 8): a planned row, or a prd/ worktree's topic.
  const candidates = new Set([
    ...rows
      .filter(
        (/** @type {{ state: string, flags?: string[] }} */ r) =>
          r.state === "planned" && !r.flags?.includes("standing"),
      )
      .map((/** @type {{ topic: string }} */ r) => r.topic),
    ...worktrees.flatMap((w) => {
      const t = branchKinds().nameOf(w.branch, "prd");
      return t && !t.includes("/") ? [t] : [];
    }),
  ]);
  return {
    state,
    records,
    gate,
    facts: {
      rows,
      worktrees,
      landed: landedTopics(p.main, [...candidates]),
      sessions: records.map((r) => ({
        name: r.name,
        live: r.live,
        managed: r.record.managed === true,
        rotating: r.record.rotating === true,
        rotatingAt: r.rotatingAt,
      })),
      asks: listAsks(p.asks),
      reopens: state.reopens ?? {},
      busy: gate.busy,
      paused: Boolean(state.paused),
      caps: {
        prds: prdCapOf(p.cap, env).cap,
        planners: positive(env.RISA_MAX_PLANNERS, 1),
        fixesMin: positive(env.RISA_FIXES_MIN, 3),
      },
      now: nowOf(env),
      // The work switch (machine.mjs): off, nothing starts or is planned here.
      work: workSwitch({ main: p.main, env }),
    },
  };
}

// ---- the context follow-up -------------------------------------------------------

/** Gathers the context facts and applies the decision. Returns whether it did anything. */
function contextStep(
  /** @type {ReturnType<typeof pathsOf>} */ p,
  /** @type {ReturnType<typeof gather>} */ g,
  /** @type {{ dryRun: boolean, env: NodeJS.ProcessEnv, out: (l: string) => void }} */ { dryRun, env, out },
) {
  if (env.RISA_CONTEXT_WATCH === "off") return false;
  const now = g.facts.now;
  const dir = contextDirOf(p.sessions);
  // The follow-up starts at the hard limit; the hook alone handles the soft one.
  const limit = hardLimitOf(env);
  const waitMs = positive(env.RISA_CONTEXT_NUDGE_MIN, 15) * 60_000;
  const entries = readState(p.state).context ?? {};
  const sessions = g.records.map((r) => ({
    name: r.name,
    pid: r.record.pid ?? 0,
    kind: r.record.kind,
    topic: r.record.topic,
    managed: r.record.managed === true,
    live: r.live,
    rotating: r.record.rotating === true,
  }));
  /** @type {Record<string, any>} */
  const sizes = {};
  for (const s of sessions) if (s.live) sizes[s.name] = sizeRecord(dir, s.name, s.pid);
  /** @type {Record<string, any>} */
  const asks = {};
  for (const e of Object.values(entries)) if (e.askId) asks[e.askId] = getAsk(p.asks, e.askId);
  // The process table only when a rotation could follow; unreadable holds every rotation.
  const running = new Set();
  if (Object.values(entries).some((e) => e.askId)) {
    let table = null;
    try {
      table = processTable();
    } catch {
      /* held below */
    }
    for (const s of sessions) if (s.live && (!table || commandUnder(s.pid, table))) running.add(s.name);
  }
  // A backlog session's brief, when it could be used: a bad one is no brief, never a failed rotation.
  const briefFile = (/** @type {string} */ name) => join(dirname(p.sessions), ".briefs", `${name}.md`);
  /** @type {Record<string, number>} */
  const briefs = {};
  for (const s of sessions) {
    if (!s.live || s.kind !== "backlog" || !entries[s.name]?.askId) continue;
    const file = briefFile(s.name);
    if (!briefProblem(file)) briefs[s.name] = statSync(file).mtimeMs;
  }
  const actions = contextDecision({
    sessions,
    sizes,
    entries,
    asks,
    running,
    briefs,
    paused: g.facts.paused,
    limit,
    // The inbox session's one limit is the soft one: its follow-up starts there.
    inboxLimit: limitOf(env),
    waitMs,
    now,
  });

  const setEntry = (/** @type {string} */ name, /** @type {Record<string, unknown>} */ fields) =>
    updateState(p.state, (s) => {
      s.context = {
        ...s.context,
        [name]: { .../** @type {any} */ (s.context?.[name]), .../** @type {any} */ (fields) },
      };
    });
  const askTool = (/** @type {string[]} */ args) =>
    run("node", [join(HERE, "ask.mjs"), ...args], {
      cwd: p.main,
      env: { ...env, RISA_ASKS_DIR: p.asks },
    });
  const lastLine = (/** @type {{ out: string, err: string }} */ r) =>
    (r.err || r.out).split("\n").pop() ?? "";

  let acted = false;
  for (const a of actions) {
    if (a.type === "hold") {
      out(
        `context: ${a.session} waits to rotate: a ${toolCmd.prd} or ${toolCmd.backlog} command is running under it`,
      );
      continue;
    }
    if (dryRun) {
      if (a.type !== "answered") out(`context: would ${a.type} ${a.session}`);
      continue;
    }
    acted = true;
    if (a.type === "clear") {
      if (a.askId) dismissAsk(p.asks, a.askId, { now });
      updateState(p.state, (s) => void delete s.context?.[a.session]);
      out(`context: ${a.session} cleared`);
    } else if (a.type === "nudge") {
      updateRecord(join(dir, `${a.session}.json`), (r) =>
        r?.pid === a.pid && r.size > limit && !r.nudgeAt ? { ...r, nudgeAt: new Date(now).toISOString() } : r,
      );
      out(`context: ${a.session} nudged`);
    } else if (a.type === "answered") {
      setEntry(a.session, { answer: a.answer });
      out(`context: ask ${a.askId} means ${a.answer} for ${a.session}`);
    } else if (a.type === "ask") {
      const r = askTool([
        "ask",
        "--topic",
        a.topic,
        "--question",
        a.text,
        "--session",
        CONTEXT_SESSION,
        ...CONTEXT_OPTIONS.flatMap((o) => ["--option", o]),
        "--recommend",
        a.recommend,
        "--defaults",
      ]);
      const id = r.ok ? r.out.split("\n")[0].trim() : "";
      if (!/^a\d+$/.test(id)) {
        out(`context: filing the question for ${a.session} failed: ${lastLine(r)}`);
        continue;
      }
      updateState(p.state, (s) => {
        s.context = { ...s.context, [a.session]: { pid: a.pid, askId: id } };
      });
      out(`context: ${a.session} asked (${id})`);
      const push =
        r.out
          .split("\n")
          .find((l) => l.startsWith("Now send a PushNotification: "))
          ?.slice("Now send a PushNotification: ".length) ?? `${a.topic}: ${a.text}`;
      const helper = run(
        "bash",
        [
          join(HERE, "open-session.sh"),
          "--command",
          helperLine({ main: p.main, ...helperClaude(p.main, env), line: push }),
          "--title",
          HELPER_SESSION,
          "--background",
        ],
        { cwd: p.main },
      );
      if (!helper.ok) out(`  ${HELPER_SESSION} didn't start (ignored): ${lastLine(helper)}`);
    } else if (a.type === "rotate" || a.type === "rotate-backlog" || a.type === "rotate-inbox") {
      // A backlog or inbox session: `rotate --self` finds its caller by ancestry, so the tick opens its line.
      const brief =
        a.type === "rotate-backlog" ? (a.brief ? ` --brief ${sh(briefFile(a.session))}` : " --no-brief") : "";
      // The main backlog session comes back as a new captain: its tab title and Remote Control name.
      const captain =
        a.type === "rotate-backlog" && a.session === CAPTAIN_SESSION ? nextCaptain(p.sessions) : null;
      const r =
        a.type === "rotate"
          ? run("bash", [join(HERE, "rotate.sh"), a.topic, "--mid-wave", "--reason", "context"], {
              cwd: p.main,
            })
          : run(
              "bash",
              [
                join(HERE, "open-session.sh"),
                "--command",
                `cd ${sh(p.main)} && ${sh(join(HERE, "rotate-into.sh"))} ${sh(a.session)} ${a.pid} --reason context${brief}` +
                  (captain ? ` --captain ${captain}` : ""),
                "--title",
                captain ?? a.session,
                "--background",
              ],
              { cwd: p.main },
            );
      const reported = entries[a.session]?.reported === true;
      setEntry(a.session, { triedAt: now, ...(r.ok ? {} : { reported: true }) });
      if (r.ok) out(`context: ${a.session} rotating`);
      else {
        out(`context: rotating ${a.session} was refused: ${lastLine(r)}`);
        if (!reported)
          askTool([
            "ask",
            "--topic",
            a.topic,
            "--report",
            `${a.session} is over the context limit, and its rotation was refused: ${lastLine(r)}`,
            "--session",
            CONTEXT_SESSION,
          ]);
      }
    }
  }
  return acted;
}

// ---- the stuck orchestrator -------------------------------------------------------

/** A file's JSON, or null. */
const readJson = (/** @type {string} */ file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** A topic's watch marks (watch.mjs's marks.jsonl): { slice, at } lines; a bad line is skipped. */
function watchMarks(/** @type {string} */ file) {
  /** @type {{ slice: string, at: string }[]} */
  const out = [];
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n"))
    try {
      const m = JSON.parse(line);
      if (m && m.slice !== undefined && typeof m.at === "string")
        out.push({ slice: String(m.slice), at: m.at });
    } catch {
      /* not a mark */
    }
  return out;
}

/** Gathers the stuck facts and applies the decision. Returns whether it did anything. */
function stuckStep(
  /** @type {ReturnType<typeof pathsOf>} */ p,
  /** @type {ReturnType<typeof gather>} */ g,
  /** @type {{ dryRun: boolean, env: NodeJS.ProcessEnv, out: (l: string) => void, every: number }} */ {
    dryRun,
    env,
    out,
    every,
  },
) {
  if (env.RISA_STUCK_WATCH === "off") return false;
  const now = g.facts.now;
  const { limitMs, gapMs, notifiedMs } = stuckSettings(env, every);
  const prev = readState(p.state).stuck ?? {};
  const clockFrom = stuckClock(prev, now, gapMs);
  const sessions = g.records.map((r) => ({
    name: r.name,
    pid: r.record.pid ?? 0,
    kind: r.record.kind,
    topic: r.record.topic,
    managed: r.record.managed === true,
    auto: r.record.auto === true,
    live: r.live,
    rotating: r.record.rotating === true,
    notifiedAt: /** @type {number | null} */ (null),
  }));
  const watched = sessions.filter((s) => s.live && s.managed && s.auto && s.kind === "prd" && s.topic);
  const heartbeats = watched.length ? readHeartbeats(heartbeatDirOf(p.sessions)) : [];
  // A watched session's newest notification with no reply after it (RISA-1033).
  for (const s of watched) {
    const own = heartbeats.find((h) => h.session === s.name && h.pid === s.pid && !h.agent);
    s.notifiedAt = transcriptNotifiedAt(own?.transcript);
  }
  // The process table only when a session is watched; unreadable holds every one (busy).
  const running = new Set();
  if (watched.length) {
    let table = null;
    try {
      table = processTable();
    } catch {
      /* held below */
    }
    for (const s of watched) if (!table || busyUnder(s.pid, table)) running.add(s.name);
  }
  /** @type {Record<string, { state: any, marks: { slice: string, at: string }[] }>} */
  const watch = {};
  for (const s of watched) {
    const dir = join(p.watch, /** @type {string} */ (s.topic));
    watch[/** @type {string} */ (s.topic)] = {
      state: readJson(join(dir, "state.json")),
      marks: watchMarks(join(dir, "marks.jsonl")),
    };
  }
  const entries = prev.sessions ?? {};
  // The open asks, and each entry's own (an answered or dismissed one isn't listed).
  const asks = [...g.facts.asks];
  for (const e of Object.values(entries))
    if (e.askId && !asks.some((a) => a.id === e.askId)) {
      const a = getAsk(p.asks, e.askId);
      if (a) asks.push(a);
    }
  const actions = stuckDecision({
    sessions,
    heartbeats,
    running,
    asks,
    watch,
    entries,
    reported: prev.reported ?? [],
    paused: g.facts.paused,
    clockFrom,
    limitMs,
    notifiedMs,
    now,
  });
  if (dryRun) {
    for (const a of actions)
      if (a.type !== "answered") out(`stuck: would ${a.type} ${a.type === "report" ? a.key : a.session}`);
    return false;
  }
  // The clocks: a paused tick writes nothing, so a long pause is a gap too.
  if (!g.facts.paused)
    updateState(p.state, (s) => {
      s.stuck = { ...s.stuck, lastTickAt: now, clockFrom };
    });

  /** @param {(st: NonNullable<DispatchState["stuck"]>) => void} fn */
  const setStuck = (fn) =>
    updateState(p.state, (s) => {
      s.stuck = { ...s.stuck, sessions: { ...s.stuck?.sessions } };
      fn(/** @type {any} */ (s.stuck));
    });
  const askTool = (/** @type {string[]} */ args) =>
    run("node", [join(HERE, "ask.mjs"), ...args], {
      cwd: p.main,
      env: { ...env, RISA_ASKS_DIR: p.asks },
    });
  const lastLine = (/** @type {{ out: string, err: string }} */ r) =>
    (r.err || r.out).split("\n").pop() ?? "";

  let acted = false;
  for (const a of actions) {
    acted = true;
    if (a.type === "clear") {
      if (a.askId) dismissAsk(p.asks, a.askId, { now });
      setStuck((st) => void delete st.sessions?.[a.session]);
      out(`stuck: ${a.session} cleared`);
    } else if (a.type === "answered") {
      setStuck((st) => {
        const e = st.sessions?.[a.session];
        if (e) e.answer = a.answer;
      });
      out(`stuck: ask ${a.askId} means ${a.answer === "rotate" ? "rotate" : "leave it"} for ${a.session}`);
    } else if (a.type === "report") {
      const r = askTool(["ask", "--topic", "dispatch", "--report", a.text, "--session", STUCK_SESSION]);
      if (!r.ok) {
        out(`stuck: filing the report failed: ${lastLine(r)}`);
        continue;
      }
      setStuck((st) => void (st.reported = [...(st.reported ?? []), a.key].slice(-20)));
      out(`stuck: reported ${a.sessions.join(", ")} quiet together`);
    } else if (a.type === "ask") {
      // It waits, like the reopen question: a rotation burns usage, so it never defaults.
      const r = askTool([
        "ask",
        "--topic",
        a.topic,
        "--question",
        a.text,
        "--session",
        STUCK_SESSION,
        ...STUCK_OPTIONS.flatMap((o) => ["--option", o]),
        "--waits",
      ]);
      const id = r.ok ? r.out.split("\n")[0].trim() : "";
      if (!/^a\d+$/.test(id)) {
        out(`stuck: filing the question for ${a.session} failed: ${lastLine(r)}`);
        continue;
      }
      setStuck((st) => {
        /** @type {any} */ (st.sessions)[a.session] = { pid: a.pid, since: a.since, askId: id };
      });
      out(`stuck: ${a.session} asked (${id})`);
      const push =
        r.out
          .split("\n")
          .find((l) => l.startsWith("Now send a PushNotification: "))
          ?.slice("Now send a PushNotification: ".length) ?? `${a.topic}: ${a.text}`;
      const helper = run(
        "bash",
        [
          join(HERE, "open-session.sh"),
          "--command",
          helperLine({ main: p.main, ...helperClaude(p.main, env), line: push }),
          "--title",
          HELPER_SESSION,
          "--background",
        ],
        { cwd: p.main },
      );
      if (!helper.ok) out(`  ${HELPER_SESSION} didn't start (ignored): ${lastLine(helper)}`);
    } else if (a.type === "rotate") {
      const r = run("bash", [join(HERE, "rotate.sh"), a.topic, "--mid-wave", "--reason", "stuck"], {
        cwd: p.main,
      });
      const reported = entries[a.session]?.reported === true;
      setStuck((st) => {
        const e = st.sessions?.[a.session];
        if (e) Object.assign(e, { triedAt: now }, r.ok ? {} : { reported: true });
      });
      if (r.ok) out(`stuck: ${a.session} rotating`);
      else {
        out(`stuck: rotating ${a.session} was refused: ${lastLine(r)}`);
        if (!reported)
          askTool([
            "ask",
            "--topic",
            a.topic,
            "--report",
            `${a.session} looks stuck, and its rotation was refused: ${lastLine(r)}`,
            "--session",
            STUCK_SESSION,
          ]);
      }
    }
  }
  return acted;
}

/** Every process's command line, or null when they can't be read. RISA_PROCESS_FILE stands in (tests). */
export function processLines(env = process.env) {
  try {
    if (env.RISA_PROCESS_FILE) return readFileSync(env.RISA_PROCESS_FILE, "utf8").split("\n").filter(Boolean);
    return [...processTable().values()].map((r) => r.args);
  } catch {
    return null;
  }
}

/** Applies the answers to the keep-alive's own questions. */
function settleKeepAnswers(
  /** @type {ReturnType<typeof pathsOf>} */ p,
  /** @type {(l: string) => void} */ out,
) {
  for (const [kind, entry] of Object.entries(readState(p.state).keepAlive ?? {})) {
    if (!entry.asked) continue;
    const { id } = entry.asked;
    const a = getAsk(p.asks, id);
    if (a && !a.answeredAt && !a.doneAt) continue;
    const what = a?.answeredAt ? keepAnswerAction(a.answer) : null;
    updateState(p.state, (s) => {
      const keep = (s.keepAlive ??= {});
      if (what === "open") delete keep[kind];
      else if (what === "stop") keep[kind] = { stopped: true };
      else if (keep[kind]) delete keep[kind].asked;
    });
    out(
      what === "open"
        ? `ask ${id} answered "${a?.answer}": ${kind} may be opened again`
        : what === "stop"
          ? `ask ${id} answered "${a?.answer}": ${kind} isn't kept alive until the dispatcher next starts`
          : `ask ${id} ${a?.answeredAt ? `answered "${a.answer}" (unclear)` : a ? "dismissed" : "is gone"}: asking again`,
    );
  }
}

/** The oldest pending session request: opened or refused, with a notice either way. Returns whether it acted. */
function requestStep(
  /** @type {ReturnType<typeof pathsOf>} */ p,
  /** @type {ReturnType<typeof gather>} */ g,
  /** @type {{ dryRun: boolean, env: NodeJS.ProcessEnv, out: (l: string) => void, starting: string[] }} */ {
    dryRun,
    env,
    out,
    starting,
  },
) {
  const now = g.facts.now;
  const state = readState(p.state);
  // A kept session opened moments ago counts until it is up.
  const opening = Object.entries(state.keepAlive ?? {})
    .filter(([, e]) => typeof e.openedAt === "number" && now - e.openedAt < START_GRACE_MS)
    .map(([kind]) => kind);
  const d = requestDecision({
    requests: readRequests(p.requests),
    sessions: g.records.map((r) => ({
      name: r.name,
      kind: r.record.kind,
      live: r.live,
      rotating: r.record.rotating === true,
      rotatingAt: r.rotatingAt,
    })),
    processes: processLines(env),
    starting: [...starting, ...opening],
    paused: Boolean(state.paused),
    max: positive(env.RISA_MAX_BACKLOG_SESSIONS, DEFAULT_MAX_BACKLOG_SESSIONS),
    now,
    claude: claudeName(env),
    work: g.facts.work,
  });
  if (d.action === "none") {
    if (dryRun && d.why !== "no pending request") out(`session request: waits (${d.why})`);
    return false;
  }
  const { request } = d;
  if (dryRun) {
    out(`session request ${request.id}: would ${d.action} ${request.session} (${d.why})`);
    return false;
  }
  let opened = false;
  let why = d.why;
  if (d.action === "open") {
    const line = requestLine({ request, main: p.main, wrapper: join(HERE, "session.sh"), sh });
    const r = run(
      "bash",
      [join(HERE, "open-session.sh"), "--command", line, "--title", request.session, "--background"],
      { cwd: p.main },
    );
    opened = r.ok;
    if (!r.ok) why = `its tab didn't open (${(r.err || r.out).split("\n").pop()})`;
  }
  settleRequest(p.requests, request.id, {
    state: opened ? "opened" : "refused",
    ...(opened ? {} : { why }),
    now,
  });
  out(`session request ${request.id}: ${opened ? `opened ${request.session}` : `refused (${why})`}`);
  try {
    createNotice(p.notices, {
      text: requestNotice(request, { opened, why }),
      session: DISPATCH_SESSION,
      minutes: 360,
      now,
    });
  } catch (e) {
    // The requester reads it in `prd session requests`.
    const noticeFailed = e instanceof Error ? e.message : String(e);
    out(`  its notice failed: ${noticeFailed}`);
    try {
      settleRequest(p.requests, request.id, {
        state: opened ? "opened" : "refused",
        ...(opened ? {} : { why }),
        noticeFailed,
        now,
      });
    } catch {
      // The request is settled already; only its note is lost.
    }
  }
  return true;
}

// ---- the untrusted inbox ------------------------------------------------------------

/**
 * One report while the inbox session can't open (WHY: inboxUntrusted's line, naming the
 * folder and the command), recorded as inboxReported; a tick with it trusted clears the
 * record, so a later untrusted spell reports again. Returns whether it filed one.
 */
function inboxReportStep(
  /** @type {ReturnType<typeof pathsOf>} */ p,
  /** @type {string | null} */ why,
  /** @type {{ dryRun: boolean, env: NodeJS.ProcessEnv, out: (l: string) => void }} */ { dryRun, env, out },
) {
  const reported = readState(p.state).inboxReported === true;
  if (!why) {
    if (reported && !dryRun)
      updateState(p.state, (s) => {
        delete s.inboxReported;
      });
    return false;
  }
  if (reported) return false;
  if (dryRun) {
    out("keep-alive inbox: would report it can't open");
    return false;
  }
  const r = run(
    "node",
    [
      join(HERE, "ask.mjs"),
      "ask",
      "--topic",
      "dispatch",
      "--report",
      `The inbox session can't open: ${why}. Until then the dispatcher doesn't keep it open.`,
      "--session",
      KEEP_SESSION,
    ],
    { cwd: p.main, env: { ...env, RISA_ASKS_DIR: p.asks } },
  );
  if (!r.ok) {
    out(`keep-alive inbox: filing the report failed: ${(r.err || r.out).split("\n").pop()}`);
    return false;
  }
  updateState(p.state, (s) => {
    s.inboxReported = true;
  });
  out("keep-alive inbox: reported it can't open");
  return true;
}

// ---- the drain -------------------------------------------------------------------

/** The `session` of the drain's own reports. */
export const DRAIN_SESSION = "dispatch-usage";

/** The drain decision from the usage readings (an unreadable one is unknown: never drains). */
function drainOf(
  /** @type {ReturnType<typeof pathsOf>} */ p,
  /** @type {ReturnType<typeof gather>} */ g,
  /** @type {NodeJS.ProcessEnv} */ env,
) {
  const now = g.facts.now;
  return drainDecision(readUsage(p.usage, { now, env }), {
    ...drainSettings(env),
    now,
    staleMs: staleMsOf(env),
    sessions: g.records.map((r) => ({ live: r.live, startedMs: Date.parse(r.record.started ?? "") })),
    allow: readAllowance(p.allow),
  });
}

/**
 * The drain's actions: one report for an unknown reading, and each managed prd or plan session whose
 * own account is limited (sessionDrains: its reading's account) ended (marked stalled first)
 * unless it runs a landing, and one report naming the hand-opened, backlog and inbox ones
 * (never ended). Returns whether it
 * did anything.
 */
function drainStep(
  /** @type {ReturnType<typeof pathsOf>} */ p,
  /** @type {ReturnType<typeof gather>} */ g,
  /** @type {import("./drain.mjs").Drain} */ drain,
  /** @type {{ dryRun: boolean, env: NodeJS.ProcessEnv, out: (l: string) => void }} */ { dryRun, env, out },
) {
  const now = g.facts.now;
  const prev = readState(p.state).drain ?? {};
  const report = (/** @type {string} */ text) => {
    const r = run(
      "node",
      [join(HERE, "ask.mjs"), "ask", "--topic", "dispatch", "--report", text, "--session", DRAIN_SESSION],
      { cwd: p.main, env: { ...env, RISA_ASKS_DIR: p.asks } },
    );
    if (!r.ok) out(`usage: filing the report failed: ${(r.err || r.out).split("\n").pop()}`);
    return r.ok;
  };
  let acted = false;
  let unknownReported = drain.unknown ? prev.unknownReported === true : false;
  if (drain.unknown && !unknownReported) {
    if (dryRun) out("usage: would report an unknown reading");
    else if (
      report(
        `The usage reading is unknown (${drain.why}) while sessions are live: the dispatcher can't drain before a limit. Check the sessions' status lines (${toolCmd.prd} usage).`,
      )
    ) {
      unknownReported = true;
      acted = true;
      out("usage: reported an unknown reading");
    }
  }
  const readings = readReadings(p.usage);
  const drains = sessionDrains(
    readings,
    g.records.map((r) => r.name),
    { ...drainSettings(env), now, staleMs: staleMsOf(env), account: claudeAccount(env) },
  );
  const limited =
    drain.state === "limited" || g.records.some((r) => r.live && drains[r.name]?.state === "limited");
  /** @type {string[]} */
  let reported = limited ? (prev.reported ?? []) : [];
  if (limited) {
    /** @type {Map<number, { ppid: number, args: string }> | null} */
    let table = null;
    try {
      table = processTable();
    } catch {
      /* held below */
    }
    const sessions = g.records.map((r) => ({
      name: r.name,
      pid: r.record.pid ?? 0,
      live: r.live,
      managed: r.record.managed === true,
      kind: r.record.kind,
    }));
    if (!table && sessions.some((s) => s.live && s.managed))
      // A landing can't be told apart: none is ever stopped, so nothing is ended.
      out("usage limited: the process table can't be read, so nothing is ended this tick");
    else {
      const journalPids = new Set(
        listLandings(p.landing)
          .map((r) => Number(r.pid))
          .filter((n) => Number.isInteger(n) && n > 0),
      );
      const landing = new Set(
        sessions.filter((s) => s.live && table && landingUnder(s.pid, table, journalPids)).map((s) => s.name),
      );
      /** @type {Record<string, any>} */
      const stalls = {};
      for (const r of readings) if (r?.stalled) stalls[String(r.session)] = r.stalled;
      for (const a of limitActions({ sessions, landing, stalls, reported, drain, drains, now })) {
        if (a.type === "wait") {
          out(`usage limited: ${a.session} left running (${a.why})`);
          continue;
        }
        if (dryRun) {
          out(`usage limited: would ${a.type} ${a.type === "report" ? a.sessions.join(", ") : a.session}`);
          continue;
        }
        acted = true;
        if (a.type === "report") {
          if (report(a.text)) {
            reported = [...reported, ...a.sessions];
            out(
              `usage limited: reported ${a.sessions.join(", ")} (opened by hand, or backlog or inbox: never ended)`,
            );
          }
          continue;
        }
        if (a.type === "end") {
          // Marked first: the resume (after the reset) finds it by its mark.
          let marked = "marked stalled";
          try {
            markStalled(p.usage, a.session, {
              error: LIMITED_ERROR,
              resetsAt: (drains[a.session] ?? drain).resetsAt,
              pid: a.pid,
              now,
              // A default-account session's null is kept: never the dispatcher's account.
              account: sessionAccount(readings, a.session, claudeAccount(env)),
            });
          } catch (e) {
            marked = `its stall mark failed: ${e instanceof Error ? e.message : String(e)}`;
          }
          let sent = "TERM";
          try {
            process.kill(a.pid, "SIGTERM");
          } catch (e) {
            sent = `TERM failed (${/** @type {NodeJS.ErrnoException} */ (e).code ?? e})`;
          }
          out(`usage limited: ended ${a.session} (pid ${a.pid}, ${sent}; ${marked})`);
        } else {
          try {
            process.kill(a.pid, "SIGKILL");
          } catch {
            /* gone meanwhile */
          }
          out(`usage limited: ${a.session} ignored TERM: killed it (pid ${a.pid})`);
        }
      }
    }
  }
  const allow = drain.allow ?? null;
  const allowChanged = (prev.allow ?? null) !== allow;
  if (
    !dryRun &&
    (prev.state !== drain.state || prev.unknownReported !== unknownReported || acted || allowChanged)
  )
    updateState(p.state, (s) => {
      s.drain = { state: drain.state, unknownReported, reported, allow };
    });
  if (
    (prev.state !== drain.state && (prev.state !== undefined || drain.state !== "normal")) ||
    (allowChanged && drain.state === "draining")
  )
    out(`usage: now ${drain.state}: ${drain.why}`);
  if (dryRun) {
    const stored = readAllowance(p.allow);
    if (stored)
      out(
        `usage: allowance: ${stored} (${toolCmd.prd} dispatch --allow) ${
          drain.state === "draining"
            ? "starts, plans, reopens and resumes past the drain line"
            : drain.state === "limited"
              ? "ended at the stop: nothing starts"
              : "not in use: under the drain line"
        }`,
      );
  }
  return acted;
}

// ---- the resume after a limit -----------------------------------------------------

/** Files one report under the drain's session. Returns whether it was filed. */
function fileReport(
  /** @type {ReturnType<typeof pathsOf>} */ p,
  /** @type {NodeJS.ProcessEnv} */ env,
  /** @type {string} */ text,
  /** @type {(l: string) => void} */ out,
) {
  const r = run(
    "node",
    [join(HERE, "ask.mjs"), "ask", "--topic", "dispatch", "--report", text, "--session", DRAIN_SESSION],
    { cwd: p.main, env: { ...env, RISA_ASKS_DIR: p.asks } },
  );
  if (!r.ok) out(`resume: filing the report failed: ${(r.err || r.out).split("\n").pop()}`);
  return r.ok;
}

/**
 * The resume's decision, and its claims and marks applied (before the pick, so a claimed
 * session is never a death the reopen rule counts). Returns the decision and the sessions
 * the pick leaves to it.
 */
function resumePrep(
  /** @type {ReturnType<typeof pathsOf>} */ p,
  /** @type {ReturnType<typeof gather>} */ g,
  /** @type {import("./drain.mjs").Drain} */ drain,
  /** @type {{ dryRun: boolean, env: NodeJS.ProcessEnv, out: (l: string) => void }} */ { dryRun, env, out },
) {
  const now = g.facts.now;
  const claimed = readState(p.state).resume?.claimed ?? {};
  const marks = readReadings(p.usage)
    .filter((r) => r?.stalled && typeof r.stalled === "object")
    .map((r) => ({ session: String(r.session), stalled: r.stalled }));
  if (!marks.length && !Object.keys(claimed).length) return null;
  /** @type {Map<number, { ppid: number, args: string }> | null} */
  let table = null;
  try {
    table = processTable();
  } catch {
    /* commands: null below */
  }
  const journals = listLandings(p.landing);
  const journalPids = new Set(journals.map((r) => Number(r.pid)).filter((n) => Number.isInteger(n) && n > 0));
  /** @type {Set<string>} */
  const landing = new Set();
  /** @type {import("./resume.mjs").ResumeJournal[]} */
  const held = [];
  for (const j of journals) {
    const branch = String(j.branch ?? "");
    const s = sessionOfBranch(branch);
    if (!s) continue;
    landing.add(s);
    const pid = Number(j.pid);
    const runs = Number.isInteger(pid) && pid > 0 && (table ? table.has(pid) : alive(pid));
    held.push({ session: s, branch, started: j.started == null ? null : String(j.started), live: runs });
  }
  /** @type {Set<string> | null} */
  const commands = table ? new Set() : null;
  for (const r of g.records) {
    if (!r.live || !r.record.pid || !table) continue;
    if (landingUnder(r.record.pid, table, journalPids)) landing.add(r.name);
    if (commandUnder(r.record.pid, table)) commands?.add(r.name);
  }
  const d = resumeDecision({
    marks,
    sessions: g.records.map((r) => ({
      name: r.name,
      live: r.live,
      managed: r.record.managed === true,
      pid: r.record.pid ?? null,
      started: r.record.started ?? null,
      rotating: r.record.rotating === true,
      rotatingAt: r.rotatingAt,
    })),
    worktrees: g.facts.worktrees,
    rows: g.facts.rows,
    claimed,
    landing,
    journals: held,
    commands,
    drain,
    paused: g.facts.paused,
    now,
  });
  const clear = (/** @type {string} */ session) => {
    try {
      clearStalled(/** @type {string} */ (p.usage), session);
    } catch (e) {
      out(`resume: clearing ${session}'s stall mark failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  if (dryRun) {
    for (const c of d.claim)
      out(`resume: would claim ${c.session} (stalled on a limit; its reset has passed)`);
    for (const x of d.drop) out(`resume: would drop ${x.session} (${x.why})`);
    if (d.report) out(`resume: would report ${d.report.sessions.join(", ")} (opened by hand, never resumed)`);
    for (const r of d.reports)
      out(
        `resume: would report ${r.session} (a dead landing journal for ${r.journal.branch}: land --resume)`,
      );
  } else {
    // The claim is written before the mark goes, so neither a crash nor a failed write loses it.
    if (d.claim.length || d.drop.length)
      updateState(p.state, (s) => {
        const c = { ...s.resume?.claimed };
        for (const x of d.claim) c[x.session] = x.claim;
        for (const x of d.drop) delete c[x.session];
        s.resume = { ...s.resume, claimed: c };
      });
    for (const x of d.claim) {
      clear(x.session);
      out(`resume: claimed ${x.session} (stalled on a limit, ${x.claim.error}; its reset has passed)`);
    }
    for (const x of d.drop) out(`resume: dropped ${x.session} (${x.why})`);
    for (const session of d.clear) clear(session);
    if (d.report && fileReport(p, env, d.report.text, out)) {
      for (const session of d.report.sessions) clear(session);
      out(`resume: reported ${d.report.sessions.join(", ")} (opened by hand, never resumed)`);
    }
    for (const r of d.reports) {
      if (!fileReport(p, env, r.text, out)) continue;
      // Recorded once filed, so this journal is never reported again (a failed filing retries).
      updateState(p.state, (s) => {
        const c = s.resume?.claimed?.[r.session];
        if (c) c.journalReported = r.journal;
      });
      out(`resume: reported ${r.session} (a dead landing journal for ${r.journal.branch}: land --resume)`);
    }
  }
  for (const w of d.waits) out(`resume: ${w.session} waits (${w.why})`);
  return { decision: d, resuming: resumingOf(claimed, d) };
}

/** The resume's acts: TERM or KILL a live stalled session, or reopen one. Returns whether it acted. */
function resumeActs(
  /** @type {ReturnType<typeof pathsOf>} */ p,
  /** @type {import("./resume.mjs").ResumeDecision} */ d,
  /** @type {{ now: number, out: (l: string) => void }} */ { now, out },
) {
  let acted = false;
  for (const a of d.acts) {
    acted = true;
    if (a.type === "end") {
      let sent = "TERM";
      try {
        process.kill(a.pid, "SIGTERM");
      } catch (e) {
        sent = `TERM failed (${/** @type {NodeJS.ErrnoException} */ (e).code ?? e})`;
      }
      updateState(p.state, (s) => {
        const c = s.resume?.claimed?.[a.session];
        if (c) c.termPid = a.pid;
        if (c) c.termAt = now;
      });
      out(`resume: ended ${a.session} (pid ${a.pid}, ${sent}): resumed once it has ended`);
    } else if (a.type === "kill") {
      try {
        process.kill(a.pid, "SIGKILL");
      } catch {
        /* gone meanwhile */
      }
      out(`resume: ${a.session} ignored TERM: killed it (pid ${a.pid})`);
    } else {
      const r = run("bash", [join(HERE, "open-session.sh"), a.worktree, "--background", "--carry-on"], {
        cwd: p.main,
      });
      // Never counted. The claim goes once its tab opened; one that never did is retried.
      if (r.ok)
        updateState(p.state, (s) => {
          delete s.resume?.claimed?.[a.session];
        });
      const last = (r.err || r.out).split("\n").pop() || "ok";
      out(
        `  ${a.session}: ${r.ok ? last : `its tab never opened (failed (exit ${r.code}): ${last}); a later tick retries`}`,
      );
    }
  }
  return acted;
}

// ---- the finish of a landed topic --------------------------------------------------

/**
 * The finish step: gathers each landed topic's facts, decides, picks one, and acts
 * on it (or, dry, prints what it would do). Returns whether it acted.
 */
function finishStep(
  /** @type {ReturnType<typeof pathsOf>} */ p,
  /** @type {ReturnType<typeof gather>} */ g,
  /** @type {import("./drain.mjs").Drain} */ drain,
  /** @type {{ dryRun: boolean, env: NodeJS.ProcessEnv, out: (l: string) => void }} */ { dryRun, env, out },
) {
  const paused = g.facts.paused;
  const draining = drain.state !== "normal";
  if (paused || draining) return false;
  const kinds = branchKinds();
  /** @type {{ topic: string, flags: string[] }[]} */
  const rows = g.facts.rows;
  const standing = new Set(rows.filter((r) => r.flags?.includes("standing")).map((r) => r.topic));
  const worktreeOf = new Map(
    g.facts.worktrees.flatMap((w) => {
      const t = kinds.nameOf(w.branch, "prd");
      return t && !t.includes("/") ? [[t, w.name]] : [];
    }),
  );
  /** @type {Set<string>} */
  const slots = new Set();
  const slotDir = join(p.loops, ".slots");
  for (const n of existsSync(slotDir) ? readdirSync(slotDir) : [])
    try {
      slots.add(readFileSync(join(slotDir, n, "name"), "utf8").trim());
    } catch {
      /* not a slot */
    }
  const open = (/** @type {string} */ t) => "flags" in doneFlags(rows, t);
  // Row order first, then the worktrees and slots no row names.
  const topics = [
    ...new Set([
      ...rows.map((r) => r.topic),
      ...[...worktreeOf.keys()].sort(),
      ...[...slots].filter((n) => n && !n.startsWith("plan-") && !n.includes("/")).sort(),
    ]),
  ].filter((t) => !standing.has(t) && (worktreeOf.has(t) || slots.has(t) || open(t)));
  const reported = readState(p.state).finish?.reported ?? [];
  const trunk = env.TRUNK || kinds.trunk;
  const plain = landedTopics(p.main, topics, trunk);
  const code = landedWithCode(
    p.main,
    topics.filter((t) => !plain[t]),
    trunk,
  );
  /** @type {Map<number, { ppid: number, args: string }> | undefined} */
  let table;
  try {
    table = processTable();
  } catch {
    /* gatherFinish reads it itself */
  }
  const candidates = topics
    .filter((t) => plain[t] || code[t])
    .map((topic) => {
      const facts = gatherFinish(topic, { main: p.main, env, now: g.facts.now, reported, rows, table });
      return {
        topic,
        tip: facts.tip,
        name: facts.worktree?.name ?? topic,
        decision: finishDecision(facts),
      };
    });
  // A key whose topic is no longer a candidate is spent: the topic finished or moved on.
  const live = new Set(candidates.map((c) => c.topic));
  const kept = reported.filter((k) => live.has(k.split("\t")[0]));
  const c = finishPick(candidates, { paused, draining, reported });
  if (dryRun) {
    for (const x of candidates)
      if (x.decision?.kind === "wait") out(`finish: ${x.topic} waits (${x.decision.why})`);
    const d = c?.decision;
    if (d?.kind === "act")
      out(`finish: would end ${d.end.length ? d.end.join(", ") : "no session"}, rm ${c?.name} (${d.why})`);
    else if (d?.kind === "report") out(`finish: would report ${d.topic}: ${d.why}`);
    return false;
  }
  /** @type {string[]} */
  const filed = [];
  if (c?.decision) {
    const d = c.decision;
    const did = applyFinish(d, { main: p.main, env: { ...env, RISA_ASKS_DIR: p.asks }, name: c.name });
    if (d.kind === "report" && did.filed) filed.push(d.key);
    if (d.kind === "act" && !did.ok) filed.push(failedKey(d.topic, c.tip));
    const [first, ...rest] = (did.report ?? "").split("\n");
    out(`finish: ${first}${did.filed ? "" : " (its report wasn't filed)"}`);
    for (const l of rest) out(`  ${l}`);
  }
  if (filed.length || kept.length !== reported.length)
    updateState(p.state, (s) => {
      s.finish = { ...s.finish, reported: [...new Set([...kept, ...filed])] };
    });
  return !!c;
}

// ---- one tick --------------------------------------------------------------------

/**
 * One tick: the answers to its asks, the pick, the action, tidy. Returns the
 * lines it printed and the pick. With dryRun it only picks and prints.
 */
export function tick(
  /** @type {ReturnType<typeof pathsOf>} */ p,
  {
    dryRun = false,
    env = process.env,
    say = (/** @type {string} */ l) => console.log(l),
    every = 60,
    home = homeModule,
  } = {},
) {
  const lines = [];
  const out = (/** @type {string} */ l) => lines.push(l);
  let g;
  try {
    g = gather(p, env);
  } catch (e) {
    out(`nothing: couldn't gather the facts (${e instanceof Error ? e.message : String(e)})`);
    for (const l of lines) say(l);
    return { lines, action: "none", acted: false };
  }
  const { facts, records } = g;
  const now = facts.now;

  if (!dryRun) {
    // The heartbeat (`risa status`'s last tick): every tick writes it, paused,
    // limited or not; the stuck watch keeps its own `stuck.lastTickAt`.
    updateState(p.state, (s) => void (s.lastTickAt = now));
    // Due defaults first, so a question whose session died still settles and
    // its reopened session finds the answer (a dry run writes nothing).
    let settled = [];
    try {
      settled = settleDue(p.asks, { now });
    } catch (e) {
      out(`couldn't apply the due defaults (${e instanceof Error ? e.message : String(e)})`);
    }
    for (const a of settled) out(`ask ${a.id} (${a.topic}) defaulted to "${a.answer}": no answer came`);
    if (settled.length) facts.asks = listAsks(p.asks);
    // The answers to the dispatcher's own asks, from earlier ticks.
    const asked = g.state.asked ?? {};
    for (const [session, { id, topic }] of Object.entries(asked)) {
      const a = getAsk(p.asks, id);
      if (a && !a.answeredAt && !a.doneAt) continue;
      const what = a?.answeredAt ? answerAction(a.answer) : null;
      if (what === "hold") {
        const row = facts.rows.find((r) => r.topic === topic);
        const flags = [...new Set([...(row?.flags ?? []), "hold"])];
        const r = backlog(p.main, ["prd", "set", topic, "flags+=hold"]);
        out(
          r.ok
            ? `ask ${id} answered "${a.answer}": ${topic} flagged hold`
            : `ask ${id} answered "${a.answer}", but flagging ${topic} hold failed (retried next tick): ${r.err || r.out}`,
        );
        if (!r.ok) {
          // Kept for the next tick's retry: the answer and the count stay, and
          // this tick's pick sees the ask as still open, so the topic is skipped.
          facts.asks = [
            ...facts.asks.filter((x) => x.id !== id),
            { ...a, answeredAt: null, doneAt: null, defaulted: false },
          ];
          continue;
        }
        if (row) row.flags = flags;
      } else if (what === "reset") out(`ask ${id} answered "${a.answer}": ${session} may be reopened again`);
      else
        out(
          a
            ? `ask ${id} ${a.answeredAt ? `answered "${a.answer}" (unclear)` : "dismissed"}: asking again`
            : `ask ${id} is gone: asking again`,
        );
      updateState(p.state, (s) => {
        delete s.asked?.[session];
        if (what) delete s.reopens?.[session];
      });
      if (what) delete facts.reopens[session];
    }
    // A reopened session live long enough has recovered; a count without a worktree is stale.
    const wtSessions = new Set(facts.worktrees.map((w) => w.branch.replace(/^(prd|plan)\/(.*)$/, "$1-$2")));
    const stale = Object.keys(facts.reopens).filter((name) => {
      const r = records.find((x) => x.name === name);
      if (!wtSessions.has(name)) return true;
      return r?.live && now - Date.parse(r.record.started ?? "") >= REOPEN_RESET_MS;
    });
    if (stale.length) {
      updateState(p.state, (s) => {
        for (const n of stale) delete s.reopens?.[n];
      });
      for (const n of stale) delete facts.reopens[n];
    }
    settleKeepAnswers(p, out);
    if (g.state.lastTidy === undefined) updateState(p.state, (s) => void (s.lastTidy ??= now));
  }

  // The drain decision (drain.mjs): near a limit nothing new opens; past it, nothing opens a claude.
  const drain = drainOf(p, g, env);
  facts.drain = { state: drain.state, why: drain.why, allow: drain.allow ?? null };
  const limited = drain.state === "limited";
  // The resume after a limit: its claims before the pick, so the pick never counts them.
  /** @type {ReturnType<typeof resumePrep>} */
  let resume;
  // Its lines follow the pick's head.
  /** @type {string[]} */
  const resumeLines = [];
  const resumeOut = (/** @type {string} */ l) => void resumeLines.push(l);
  try {
    resume = resumePrep(p, g, drain, { dryRun, env, out: resumeOut });
  } catch (e) {
    resumeOut(`resume: ${e instanceof Error ? e.message : String(e)}`);
    // Whatever was claimed before stays the resume's.
    resume = {
      decision: { claim: [], clear: [], report: null, drop: [], acts: [], waits: [], reports: [] },
      resuming: new Set(Object.keys(readState(p.state).resume?.claimed ?? {})),
    };
  }
  for (const s of facts.sessions) if (resume?.resuming.has(s.name)) s.resuming = true;
  // A dead session stalled on a limit still ahead (its own account's) waits for the resume;
  // with the usage watch off (RISA_USAGE_WATCH=off) none does: the pick reopens it.
  /** @type {Set<string>} */
  let stalls = new Set();
  try {
    if (p.usage && !drainSettings(env).off) stalls = stalledSessions(readReadings(p.usage), facts.now);
  } catch {
    /* no readings: none stalled */
  }
  for (const s of facts.sessions) if (!s.live && stalls.has(s.name)) s.stalled = true;
  // The home (home.mjs, a project with `inbox` only): another machine's stops this one.
  /** @type {string[]} */
  const homeLines = [];
  /** @type {string | null} */
  let homeBlocked = null;
  /** @type {string | null} */
  let homeInbox = null;
  if (home)
    try {
      const h = home.homeTick({
        main: p.main,
        state: g.state.home,
        now,
        dryRun,
        env,
        report: (text) => {
          const r = run(
            "node",
            [
              join(HERE, "ask.mjs"),
              "ask",
              "--topic",
              "dispatch",
              "--report",
              text,
              "--session",
              HOME_SESSION,
            ],
            { cwd: p.main, env: { ...env, RISA_ASKS_DIR: p.asks } },
          );
          if (!r.ok) homeLines.push(`home: filing the report failed: ${(r.err || r.out).split("\n").pop()}`);
          return r.ok;
        },
      });
      if (h) {
        homeLines.push(...h.lines);
        homeBlocked = h.blocked;
        homeInbox = h.inboxWhy;
        if (!dryRun) updateState(p.state, (s) => void (s.home = h.state));
      }
    } catch (e) {
      homeBlocked = `the home couldn't be read (${e instanceof Error ? e.message : String(e)})`;
      homeLines.push(`home: ${homeBlocked}: nothing starts, plans, reopens or is kept alive here`);
    }
  /** @type {import("./dispatch-pick.mjs").Pick} */
  let choice = pick(facts);
  // A resume takes the tick's action: the pick's waits a tick.
  const resumeOpen = resume?.decision.acts.find((a) => a.type === "open");
  if (resumeOpen?.type === "open")
    choice = {
      action: "resume",
      session: resumeOpen.session,
      worktree: resumeOpen.worktree,
      why: resumeOpen.why,
      reasons: [
        ...(choice.topic && choice.action !== "none"
          ? [{ topic: choice.topic, why: `waits a tick: the resume of ${resumeOpen.session} goes first` }]
          : []),
        ...choice.reasons,
      ],
    };
  // Another machine's home: the pick's start, plan, reopen, ask or resume waits.
  if (homeBlocked && choice.action !== "none")
    choice = {
      action: "none",
      why: homeBlocked,
      reasons: [
        ...(choice.topic ? [{ topic: choice.topic, why: `waits: ${homeBlocked}` }] : []),
        ...choice.reasons,
      ],
    };
  // A dry run names a hold's date and reason beside it (prd list's rows carry them; a bare hold prints as it was).
  if (dryRun) {
    const since = new Map(
      facts.rows
        .filter((/** @type {{ held?: unknown }} */ r) => r.held)
        .map((/** @type {{ topic: string, held?: { date: string, why: string } }} */ r) => [
          r.topic,
          heldText(r),
        ]),
    );
    choice = {
      ...choice,
      reasons: choice.reasons.map((r) =>
        r.topic && since.has(r.topic) && r.why.startsWith("on hold")
          ? { ...r, why: `on hold since ${since.get(r.topic)}${r.why.slice("on hold".length)}` }
          : r,
      ),
    };
  }
  const head = formatPick(choice);
  if (g.gate.busy)
    head.splice(
      1,
      0,
      `  (the 5-minute load ${Math.round((g.gate.load ?? 0) * 10) / 10} is over ${g.gate.threshold})`,
    );
  lines.push(...head, ...resumeLines, ...homeLines);

  // The pickup: lines pushed to origin/dev reach the main checkout. Beside the
  // pick, never in its way: a failure is one line.
  const everyMs = pickupEvery(env.RISA_PICKUP_EVERY);
  if (pickupDue(g.state, now, { paused: facts.paused, everyMs })) {
    if (dryRun) out(`pickup: would run ${toolCmd.prd} dev-sync`);
    else {
      updateState(p.state, (s) => void (s.lastPickup = now));
      const r = run("bash", [join(HERE, "prd.sh"), "dev-sync", "the dispatcher's pickup"], {
        cwd: p.main,
        timeout: PICKUP_TIMEOUT_MS,
      });
      const last = (r.err || r.out).split("\n").pop() || "";
      if (!r.ok) out(`pickup: failed (exit ${r.code ?? "timeout"}): ${last}`);
      else if (!/already has/.test(last)) out(`pickup: ${last}`);
    }
  }

  // The drain's actions: beside the pick; a failure is one line.
  let watched = false;
  try {
    watched = drainStep(p, g, drain, { dryRun, env, out });
  } catch (e) {
    out(`usage: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The context follow-up: apart from the pick, and never in the way of its action.
  // Not while limited: a rotation or its question's helper opens a claude.
  try {
    if (!limited && contextStep(p, g, { dryRun, env, out })) watched = true;
  } catch (e) {
    out(`context: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The stuck orchestrator: apart from the pick, like the context follow-up.
  try {
    if (!limited && stuckStep(p, g, { dryRun, env, out, every })) watched = true;
  } catch (e) {
    out(`stuck: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The finish of a landed topic: after the pick, one topic a tick.
  try {
    if (finishStep(p, g, drain, { dryRun, env, out })) watched = true;
  } catch (e) {
    out(`finish: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The keep-alive, beside the pick: it takes no slot, so the pick's action still happens.
  // The inbox session waits until its folder is trusted (Claude Code's own files, only read).
  /** @type {Record<string, string>} */
  const unready = {};
  if (homeBlocked) for (const kind of ["backlog", "inbox"]) unready[kind] = homeBlocked;
  else if (homeInbox) unready.inbox = homeInbox;
  if (env.RISA_KEEP_SESSIONS !== "off" && !unready.inbox) {
    const why = inboxUntrusted(inboxDirOf(records.find((r) => r.name === "inbox")?.record, env));
    if (why) unready.inbox = why;
    try {
      if (inboxReportStep(p, why, { dryRun, env, out })) watched = true;
    } catch (e) {
      out(`keep-alive inbox: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const keepDecisions = keepAliveDecision({
    unready,
    sessions: facts.sessions,
    processes: processLines(env),
    keep: readState(p.state).keepAlive ?? {},
    // Draining or limited holds it like a pause: a kept session is a reopen.
    paused: facts.paused || drain.state !== "normal",
    off: env.RISA_KEEP_SESSIONS === "off",
    now,
    claude: claudeName(env),
    work: facts.work,
  });
  for (const d of keepDecisions)
    if (dryRun || d.action !== "none")
      out(`keep-alive ${d.kind}: ${d.action === "none" ? d.why : `${d.action} (${d.why})`}`);

  // Session requests: after the keep-alive (a kept session it opens counts), before starts.
  const requested = (/** @type {boolean} */ dry) => {
    // Limited: a request waits until the reset (opening it would spend extra usage).
    if (limited) return false;
    // Another machine's home: a requested session waits with the rest.
    if (homeBlocked) {
      if (dry) out(`session request: waits (${homeBlocked})`);
      return false;
    }
    try {
      const starting = keepDecisions.filter((d) => d.action === "open").map((d) => d.kind);
      return requestStep(p, g, { dryRun: dry, env, out, starting });
    } catch (e) {
      out(`session request: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };

  if (dryRun) {
    requested(true);
    out("(dry run: nothing written, nothing opened)");
    for (const l of lines) say(l);
    return { lines, action: choice.action, acted: false };
  }

  const bin = HERE;
  const openTab = (/** @type {string} */ line, /** @type {string} */ title) =>
    run("bash", [join(bin, "open-session.sh"), "--command", line, "--title", title, "--background"], {
      cwd: p.main,
    });
  const result = (/** @type {{ ok: boolean, code: number | null, out: string, err: string }} */ r) =>
    r.ok ? r.out.split("\n").pop() || "ok" : `failed (exit ${r.code}): ${(r.err || r.out).split("\n").pop()}`;
  /** An opener that exited non-zero: the tab never opened (no death, no count; a later tick retries). */
  const neverOpened = (/** @type {{ ok: boolean, code: number | null, out: string, err: string }} */ r) =>
    `its tab never opened, not counted as a death (${result(r)}); a later tick retries`;

  let keptActed = false;
  for (const d of keepDecisions) {
    if (d.reset)
      updateState(p.state, (s) => {
        delete s.keepAlive?.[d.kind];
      });
    if (d.action === "open") {
      // A session that came up since the facts were read keeps its record.
      const current = readRecord(p.sessions, d.kind);
      if (current && isLive(current, processOf(current.pid ?? 0))) {
        out(`  ${d.kind}: came up meanwhile, nothing opened`);
        continue;
      }
      keptActed = true;
      const before = readState(p.state).keepAlive?.[d.kind];
      writeRecord(p.sessions, d.kind, {
        kind: d.kind,
        managed: true,
        pid: undefined,
        started: undefined,
        ended: undefined,
        exit: undefined,
        rotating: undefined,
      });
      updateState(p.state, (s) => {
        s.keepAlive = { ...s.keepAlive, [d.kind]: { deaths: d.deaths ?? 0, openedAt: now } };
      });
      const r = run("bash", [join(bin, "open-session.sh"), d.kind, "--background"], { cwd: p.main });
      // A tab that never opened is no quick death: the entry goes back as it was.
      if (!r.ok)
        updateState(p.state, (s) => {
          s.keepAlive = { ...s.keepAlive };
          if (before) s.keepAlive[d.kind] = before;
          else delete s.keepAlive[d.kind];
        });
      out(`  ${d.kind}: ${r.ok ? result(r) : neverOpened(r)}`);
    } else if (d.action === "ask") {
      keptActed = true;
      // It waits, like the reopen question: an open burns usage, so it never defaults.
      const args = [
        "ask",
        "--topic",
        d.kind,
        "--question",
        d.text ?? "",
        "--session",
        KEEP_SESSION,
        "--waits",
      ];
      for (const o of d.options ?? []) args.push("--option", o);
      const r = run("node", [join(bin, "ask.mjs"), ...args], {
        cwd: p.main,
        env: { ...env, RISA_ASKS_DIR: p.asks },
      });
      const id = r.ok ? r.out.split("\n")[0].trim() : "";
      if (!/^a\d+$/.test(id)) {
        out(`  filing the keep-alive ask failed: ${result(r)}`);
        continue;
      }
      updateState(p.state, (s) => {
        s.keepAlive = {
          ...s.keepAlive,
          [d.kind]: { ...s.keepAlive?.[d.kind], deaths: d.deaths, asked: { id } },
        };
      });
      out(`  filed ask ${id}`);
      const push =
        r.out
          .split("\n")
          .find((l) => l.startsWith("Now send a PushNotification: "))
          ?.slice("Now send a PushNotification: ".length) ?? `${d.kind}: ${d.text}`;
      const helper = openTab(
        helperLine({ main: p.main, ...helperClaude(p.main, env), line: push }),
        HELPER_SESSION,
      );
      if (!helper.ok) out(`  ${HELPER_SESSION} didn't start (ignored): ${result(helper)}`);
    }
  }

  if (requested(false)) keptActed = true;

  // The resume's acts: ending a live stalled session, or this tick's one resume.
  if (resume?.decision.acts.length && !homeBlocked)
    try {
      if (resumeActs(p, resume.decision, { now, out })) keptActed = true;
    } catch (e) {
      out(`resume: ${e instanceof Error ? e.message : String(e)}`);
    }

  switch (choice.action) {
    case "start":
    case "plan": {
      const topic = /** @type {string} */ (choice.topic);
      const kind = choice.action === "start" ? "prd" : "plan";
      const name = kind === "prd" ? topic : `plan-${topic}`;
      const session = `${kind}-${topic}`;
      const dir = join(p.loops, name);
      const fresh = !existsSync(dir);
      // Undoes this tick's worktree (rm.sh takes its record too), leaving the
      // registry row alone (--no-registry: a fresh prd/ branch counts as merged,
      // so rm.sh could mark the topic done or clear a standing row's hot files).
      const undo = (/** @type {boolean} */ force) => {
        const gone = run("bash", [join(bin, "rm.sh"), name, "--no-registry", ...(force ? ["--force"] : [])], {
          cwd: p.main,
        });
        return gone.ok ? `; ${name} removed` : `; removing ${name} ${result(gone)}`;
      };
      if (fresh) {
        const made = run("bash", [join(bin, "new.sh"), kind, topic], { cwd: p.main });
        // A new.sh that failed after making the worktree: it goes (forced: it
        // holds nothing but this tick's half setup), so no worktree without a
        // managed record holds a slot as one opened by hand; a later tick retries.
        const partial = !made.ok && existsSync(dir) ? undo(true) : "";
        out(`  new.sh ${kind} ${topic}: ${result(made)}${partial}`);
        if (!made.ok) break;
      }
      writeRecord(p.sessions, session, { kind, topic, managed: true, auto: true });
      const model = plannerModel(facts.rows.find((r) => r.topic === topic));
      const opened = openTab(
        sessionLine({ kind, topic, dir, wrapper: join(bin, "session.sh"), model }),
        session,
      );
      if (opened.ok) out(`  ${session}: ${result(opened)}`);
      else {
        // The tab never opened: not a death. The worktree made for it goes, so it
        // holds no slot and a later tick starts again.
        out(`  ${session}: ${neverOpened(opened)}${fresh ? undo(false) : ""}`);
      }
      break;
    }
    case "reopen": {
      const session = /** @type {string} */ (choice.session);
      const r = run(
        "bash",
        [join(bin, "open-session.sh"), /** @type {string} */ (choice.worktree), "--background"],
        {
          cwd: p.main,
        },
      );
      // Counted only once its tab opened: one that never did is retried uncounted.
      if (r.ok)
        updateState(p.state, (s) => {
          s.reopens = { ...s.reopens, [session]: (s.reopens?.[session] ?? 0) + 1 };
        });
      out(`  ${session}: ${r.ok ? result(r) : neverOpened(r)}`);
      break;
    }
    case "ask": {
      const session = /** @type {string} */ (choice.session);
      const topic = /** @type {string} */ (choice.topic);
      // Its own question waits: a reopen burns usage (money), so it never defaults.
      const args = [
        "ask",
        "--topic",
        topic,
        "--question",
        choice.text ?? "",
        "--session",
        DISPATCH_SESSION,
        "--waits",
      ];
      for (const o of choice.options ?? []) args.push("--option", o);
      const r = run("node", [join(bin, "ask.mjs"), ...args], {
        cwd: p.main,
        env: { ...env, RISA_ASKS_DIR: p.asks },
      });
      const id = r.ok ? r.out.split("\n")[0].trim() : "";
      if (!/^a\d+$/.test(id)) {
        out(`  filing the ask failed: ${result(r)}`);
        break;
      }
      updateState(p.state, (s) => {
        s.asked = { ...s.asked, [session]: { id, topic } };
      });
      const push =
        r.out
          .split("\n")
          .find((l) => l.startsWith("Now send a PushNotification: "))
          ?.slice("Now send a PushNotification: ".length) ?? `${topic}: ${choice.text}`;
      out(`  filed ask ${id}`);
      const helper = openTab(
        helperLine({ main: p.main, ...helperClaude(p.main, env), line: push }),
        HELPER_SESSION,
      );
      out(
        helper.ok
          ? `  ${HELPER_SESSION}: ${result(helper)}`
          : `  ${HELPER_SESSION} didn't start (ignored): ${result(helper)}`,
      );
      break;
    }
    default:
      if (!keptActed && tidyDue(readState(p.state), now, { action: choice.action, paused: facts.paused })) {
        const r = run("node", [join(bin, "tidy-cli.mjs"), "--yes"], { cwd: p.main });
        updateState(p.state, (s) => void (s.lastTidy = now));
        out(`tidy --yes: ${result(r)}`);
        for (const l of lines) say(l);
        return { lines, action: "tidy", acted: true };
      }
  }
  for (const l of lines) say(l);
  return { lines, action: choice.action, acted: choice.action !== "none" || watched || keptActed };
}

// ---- the command line ------------------------------------------------------------

const stamp = (/** @type {number} */ ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

function parse(/** @type {string[]} */ argv) {
  const o = {
    every: 60,
    once: false,
    dryRun: false,
    pause: /** @type {string | null} */ (null),
    resume: false,
    stop: false,
    restart: false,
    everySet: false,
    restarted: /** @type {string | null} */ (null),
    cap: /** @type {string | null} */ (null),
    allow: /** @type {string | null} */ (null),
    reexec: /** @type {string | null} */ (null),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--every") {
      o.every = Number(argv[++i]);
      if (!(o.every > 0)) throw new Error("--every takes a number of seconds");
      o.everySet = true;
    } else if (a === "--once") o.once = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--pause") o.pause = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "";
    else if (a === "--resume") o.resume = true;
    else if (a === "--stop") o.stop = true;
    else if (a === "--restart") o.restart = true;
    else if (a === "--restarted") o.restarted = argv[++i] ?? "";
    // (internal: the stopped one's pid, passed by --restart: its keep-alive stops are kept)
    else if (a === "--cap") {
      const v = argv[++i] ?? "";
      if (v !== "default" && !(/^[0-9]+$/.test(v) && Number(v) >= 1 && Number(v) <= MAX_CAP))
        throw new Error(`--cap takes a number from 1 to ${MAX_CAP}, or default`);
      o.cap = v;
    } else if (a === "--allow") {
      const v = argv[++i] ?? "";
      if (v !== "none" && !allowableTopic(v)) throw new Error("--allow takes a topic, or none");
      o.allow = v;
    } else if (a === "--reexec") o.reexec = argv[++i] ?? "";
    // (internal: the old code's hash, passed by the re-exec)
    else if (a === "-h" || a === "--help") o.help = true;
    else
      throw new Error(
        `dispatch: unknown argument ${a} (--every <s>, --once, --dry-run, --pause [<why>], --resume, --stop, --restart, --cap <n>|default, --allow <topic>|none)`,
      );
  }
  return o;
}

async function main() {
  let o;
  try {
    o = parse(process.argv.slice(2));
  } catch (e) {
    console.error(`${toolCmd.prd}: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  if (o.help) {
    const text = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
    console.log(
      text
        .slice(1, 19)
        .map((l) => l.replace(/^\/\/ ?/, ""))
        .join("\n"),
    );
    return;
  }
  const p = pathsOf(mainCheckout());
  const log = (/** @type {string[]} */ lines, /** @type {number} */ now) => {
    mkdirSync(p.loops, { recursive: true });
    appendFileSync(
      p.log,
      lines.map((l, i) => (i ? (l.startsWith("  ") ? l : `  ${l}`) : `${stamp(now)} ${l}`)).join("\n") + "\n",
    );
  };

  if (o.cap !== null) {
    const now = nowOf();
    const before = prdCapOf(p.cap);
    mkdirSync(p.loops, { recursive: true });
    if (o.cap === "default") {
      if (existsSync(p.cap)) unlinkSync(p.cap);
    } else {
      const tmp = `${p.cap}.${process.pid}`;
      writeFileSync(tmp, `${o.cap}\n`);
      renameSync(tmp, p.cap);
    }
    const after = prdCapOf(p.cap);
    const line = `PRD cap ${after.cap} (${after.from}; was ${before.cap})`;
    log([line], now);
    try {
      createNotice(p.notices, { text: `${line}: running PRDs finish; new starts wait under it`, now });
    } catch {
      /* the cap is stored; a notice that can't post changes nothing */
    }
    const holder = lockHolder(p.lock);
    const running = worktreesOf(p.main).filter((w) => branchKinds().is(w.branch, "prd")).length;
    console.log(
      `${line}. ${running} PRD worktrees now: ${
        running >= after.cap
          ? `none start until fewer than ${after.cap} remain (running ones finish)`
          : `${after.cap - running} more may start`
      }; ${holder ? `the dispatcher (pid ${holder}) reads it on its next tick` : "no dispatcher is running"}.`,
    );
    return;
  }
  if (o.allow !== null) {
    const now = nowOf();
    const before = readAllowance(p.allow);
    mkdirSync(p.loops, { recursive: true });
    if (o.allow === "none") {
      if (existsSync(p.allow)) unlinkSync(p.allow);
    } else {
      const tmp = `${p.allow}.${process.pid}`;
      writeFileSync(tmp, `${o.allow}\n`);
      renameSync(tmp, p.allow);
    }
    const after = readAllowance(p.allow);
    const line = after
      ? `drain allowance: ${after} starts, plans, reopens and resumes past the drain line, until the stop (was ${before ?? "none"})`
      : `drain allowance: none (was ${before ?? "none"})`;
    log([line], now);
    const holder = lockHolder(p.lock);
    console.log(
      `${line}; ${holder ? `the dispatcher (pid ${holder}) reads it on its next tick` : "no dispatcher is running"}.`,
    );
    return;
  }
  if (o.pause !== null || o.resume) {
    if (o.pause !== null && o.resume) throw new Error("--pause or --resume, not both");
    const now = nowOf();
    updateState(p.state, (s) => {
      s.paused = o.pause !== null ? { at: stamp(now), why: o.pause || "paused by hand" } : null;
    });
    const line = o.pause !== null ? `paused${o.pause ? `: ${o.pause}` : ""}` : "resumed";
    log([line], now);
    const holder = lockHolder(p.lock);
    console.log(
      `Dispatcher ${line}${holder ? ` (pid ${holder} reads it on its next tick)` : " (none is running)"}.`,
    );
    return;
  }
  if (o.stop) {
    const holder = lockHolder(p.lock);
    if (!holder) {
      console.log("No dispatcher is running.");
      return;
    }
    console.log(
      (await stopHolder(p, holder, "--stop"))
        ? `Stopped the dispatcher (pid ${holder}).`
        : `Sent TERM to the dispatcher (pid ${holder}); it hasn't exited yet.`,
    );
    return;
  }
  if (o.restart) {
    const was = lockHolder(p.lock);
    // No tab to open (no iTerm2): refuse before stopping anything. A detached one
    // would end at the start's own check below, so either way none would run.
    if (!canOpenTabs()) {
      console.error(
        `${toolCmd.prd}: --restart needs iTerm2 (${itermApp()}) to open the new dispatcher's tab, as dispatch does to open sessions; ${was ? `the running one (pid ${was}) was left running` : "none was started"}`,
      );
      process.exit(1);
    }
    const every = o.everySet ? o.every : (was && everyOf(was, readState(p.state))) || 60;
    if (was && !(await stopHolder(p, was, "--restart"))) {
      console.error(
        `${toolCmd.prd}: sent TERM to the dispatcher (pid ${was}); it hasn't exited, so none was started`,
      );
      process.exit(1);
    }
    // Through the tool's command, so the new one runs the release it points to now.
    const line = `cd ${sh(p.main)} && ${toolCmd.prd} dispatch --every ${every}${was ? ` --restarted ${was}` : ""}`;
    const r = run(
      "bash",
      [join(HERE, "open-session.sh"), "--command", line, "--title", "dispatch", "--background"],
      {
        cwd: p.main,
      },
    );
    if (!r.ok) {
      console.error(
        `${toolCmd.prd}: couldn't open the dispatcher's tab: ${(r.err || r.out).split("\n").pop()}`,
      );
      process.exit(1);
    }
    const limit = Number(process.env.RISA_DISPATCH_START_SECS || 60) * 1000;
    const deadline = Date.now() + limit;
    /** @type {{ pid: number, hash: string | null } | null} */
    let now = null;
    while (!now && Date.now() < deadline) {
      const pid = lockHolder(p.lock);
      const code = readState(p.state).code;
      if (pid && pid !== was && code?.pid === pid) now = { pid, hash: code.hash };
      else await new Promise((res) => setTimeout(res, 100));
    }
    if (!now) {
      console.error(
        `${toolCmd.prd}: the new dispatcher didn't take its lock within ${limit / 1000}s (its tab opened)`,
      );
      process.exit(1);
    }
    log([`restart: pid ${was ?? "none"} -> ${now.pid}, code ${now.hash ?? "unknown"}`], nowOf());
    console.log(
      `Restarted the dispatcher: pid ${was ?? "none"} -> ${now.pid}, code ${now.hash ?? "unknown"} (every ${every}s${was ? ", keep-alive kept" : ""}).`,
    );
    return;
  }
  await loadHome();
  if (o.dryRun) {
    tick(p, { dryRun: true });
    return;
  }

  if (!canOpenTabs()) {
    console.error(
      `${toolCmd.prd}: dispatch needs iTerm2 (${itermApp()}) to open sessions; --dry-run shows what it would do`,
    );
    process.exit(1);
  }
  const lock = takeLock(p.lock);
  if (!lock.ok) {
    console.error(`${toolCmd.prd}: a dispatcher is already running (pid ${lock.pid}); --stop ends it`);
    process.exit(1);
  }
  // Every way out logs why and marks the state stopped (RISA-1037), once: a gone pid
  // with no mark is then a crash or a SIGKILL.
  let ended = false;
  const markEnd = (
    /** @type {string} */ why,
    /** @type {{ line?: string | null, release?: boolean }} */ {
      line = `stopped (${why})`,
      release = true,
    } = {},
  ) => {
    if (ended) return;
    ended = true;
    const now = nowOf();
    try {
      if (line) log([line], now);
    } catch {
      /* no log: the mark still says why */
    }
    try {
      updateState(p.state, (s) => {
        s.stopped = { pid: process.pid, stoppedAt: stamp(now), why };
        s.stopRequest = null;
      });
    } catch {
      /* an unwritable state: the log line says why */
    }
    if (release) releaseLock(p.lock);
  };
  onEnd = markEnd;
  const stop = (/** @type {string} */ sig) => {
    if (ended) return;
    const req = readState(p.state).stopRequest;
    const by = req?.pid === process.pid ? req.by : "";
    markEnd(by ? `${sig} by ${by}` : sig, { line: `stopped (${sig})${by ? ` by ${by}` : ""}` });
    process.exit(0);
  };
  const crash = (/** @type {string} */ what, /** @type {unknown} */ e) => {
    console.error(e instanceof Error ? (e.stack ?? firstLine(e)) : e);
    markEnd(`${what}: ${firstLine(e)}`);
    process.exit(1);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGHUP", () => stop("SIGHUP"));
  process.on("uncaughtException", (e) => crash("uncaught exception", e));
  process.on("unhandledRejection", (e) => crash("unhandled rejection", e));
  process.on("exit", (code) => {
    if (!o.once) markEnd(`exit ${code}`);
    releaseLock(p.lock);
  });

  const reexeced = o.reexec;
  // Whether it follows the `risa` link (a release install) or its own checkout.
  const follows = !o.once && followsLink(OWN_ROOT, linkedRoot());
  if (!o.once) {
    // A start begins again after "stop keeping it alive" (a re-exec or a --restart is no start).
    updateState(p.state, (s) => {
      if (s.keepAlive && !reexeced && o.restarted === null) s.keepAlive = clearKeepStops(s.keepAlive);
      s.stopped = null;
      s.stopRequest = null;
      s.code = {
        hash: CODE_AT_START,
        pid: process.pid,
        at: stamp(nowOf()),
        root: OWN_ROOT,
        follows,
        every: o.every,
      };
    });
    const what = reexeced
      ? `re-exec'd on new code ${CODE_AT_START} (was ${reexeced}; `
      : o.restarted !== null
        ? `restarted (was pid ${o.restarted}; `
        : "started (";
    log([`${what}pid ${process.pid}, every ${o.every}s)`], nowOf());
    console.log(
      `Dispatcher ${reexeced ? `re-exec'd on new code ${CODE_AT_START}` : "running"} (pid ${process.pid}, every ${o.every}s). --pause, --resume, --stop from any shell.`,
    );
  }
  let last = "";
  /** @type {ReturnType<typeof staleness> | null} */
  let check = null;
  const end = await runLoop({
    every: o.every,
    once: o.once,
    started: CODE_AT_START,
    current: () => (check = staleness({ started: CODE_AT_START, own: OWN_ROOT, follows })).hash,
    step: () => {
      // Another took the lock (or it was removed): this one ends rather than tick beside it.
      let held = null;
      try {
        held = readFileSync(p.lock, "utf8").trim();
      } catch {
        /* removed */
      }
      if (held !== String(process.pid)) {
        markEnd(`lost its lock (${held ? `it names pid ${held}` : "the lock file is gone"})`, {
          release: false,
        });
        process.exit(1);
      }
      const now = nowOf();
      const quiet = [];
      const t = tick(p, { say: (l) => quiet.push(l), every: o.every });
      const text = t.lines.join("\n");
      if (o.once || t.acted || text !== last) {
        log(t.lines, now);
        console.log(`${stamp(now)} ${quiet.join("\n")}`);
      }
      last = text;
    },
  });
  if (end.stale) {
    log(
      [
        `re-exec: the tool's code changed (${end.from} -> ${end.to}); restarting between ticks on ${check?.script}`,
      ],
      nowOf(),
    );
    const script = check?.script ?? join(HERE, "dispatch.mjs");
    console.log(
      `${stamp(nowOf())} re-exec: new code ${end.to} in ${dirname(dirname(script))} (was ${end.from})`,
    );
    const own = process.argv.slice(2).filter((a, i, all) => a !== "--reexec" && all[i - 1] !== "--reexec");
    const args = [...process.execArgv, script, ...own, "--reexec", end.from ?? "-"];
    const env = process.env;
    // The re-exec's line is above; the new code's start clears the mark.
    markEnd(`re-exec onto new code ${end.to}`, { line: null, release: false });
    // The same pid keeps the lock (takeLock takes its own pid's back) and the tab.
    if (typeof process.execve === "function")
      process.execve(process.execPath, [process.execPath, ...args], env);
    releaseLock(p.lock);
    const r = spawnSync(process.execPath, args, { stdio: "inherit", env });
    process.exit(r.status ?? 1);
  }
  releaseLock(p.lock);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(`${toolCmd.prd}: ${e instanceof Error ? e.message : String(e)}`);
    onEnd?.(`error: ${firstLine(e)}`);
    process.exit(1);
  });
}
