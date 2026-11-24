#!/usr/bin/env node
// pnpm prd dispatch: the dispatcher. Started once in a terminal tab of its own
// and left there; every tick it gathers the facts, asks the pick
// (dispatch-pick.mjs) for one action and does it, then logs the action and
// why it passed every other topic over.
//
//   pnpm prd dispatch [--every <seconds>]   tick every SECONDS (default 60) until stopped
//   pnpm prd dispatch --once                one tick, then exit
//   pnpm prd dispatch --dry-run             one tick's pick, printed: writes and opens nothing
//   pnpm prd dispatch --pause [<why>]       the running dispatcher (and any later one) does nothing
//   pnpm prd dispatch --resume              undo --pause
//   pnpm prd dispatch --stop                end the running dispatcher (TERM)
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
//     a fresh managed backlog session through the opener when none is live, or
//     its own question after three quick deaths. CARETOOK_KEEP_SESSIONS=off;
//   - session requests (session-requests.mjs), after the keep-alive and before
//     starts: the oldest pending one opens backlog-<name>, or is refused, with a
//     notice either way. CARETOOK_MAX_BACKLOG_SESSIONS (4);
//   - ask: a reopen question filed with `pnpm prd ask` (session "dispatch"),
//     then a one-shot helper session (haiku, Remote Control, in a background
//     tab) whose prompt is "send this PushNotification, then pnpm prd end"; a
//     helper that can't start is ignored (the ask's own macOS notification and
//     CARETOOK_ASK_NOTIFY still fire). Its answer is acted on in a later tick:
//     "reopen again" resets the count, "hold the topic" flags the row `hold`.
// The session record (managed, auto) is written before a new session's tab
// opens, so a tab that opens but never starts is reopened like a dead session.
// An opener that fails (the tab never opened) is no death: a reopen isn't
// counted, a kept session's quick deaths stay as they were, and a start's or
// plan's worktree made on that tick is removed (rm.sh); one line is logged and
// a later tick tries again. So is one whose new.sh failed after making it.
//
// Each tick also follows up on managed orchestrators and backlog sessions that
// stay over the context limit (dispatch-context.mjs): a nudge, a defaulting
// question, the rotation. CARETOOK_CONTEXT_NUDGE_MIN (15); CARETOOK_CONTEXT_WATCH=off stops it.
//
// Every TIDY_EVERY_MS (six hours), on a tick that does nothing else (and isn't
// paused), it runs `pnpm prd tidy --yes`. A usage limit isn't detected: the
// user pauses and resumes. Without iTerm2 it refuses to run (it couldn't open
// sessions); --dry-run works anywhere.
//
// Files, in the main checkout's .loops: .dispatch.lock (the running
// instance's pid; a lock whose pid is gone is taken over), .dispatch.json (the
// state: paused and why, reopen counts, the open reopen asks, the last tidy,
// keepAlive: each kept kind's quick deaths, last open, open ask and stop),
// .dispatch.log (each acting tick, and each idle one whose lines changed).
//
// Env: CARETOOK_MAX_PRDS (4), CARETOOK_MAX_PLANNERS (1), CARETOOK_FIXES_MIN (3):
// the pick's caps; CARETOOK_LOAD_* (load-gate.mjs); CARETOOK_SESSIONS_DIR,
// CARETOOK_ASKS_DIR; CARETOOK_ITERM_APP (default /Applications/iTerm.app);
// CARETOOK_CLAUDE_BIN (the helper's claude); CARETOOK_CLOCK_FILE (tests: epoch
// seconds standing in for the clock).
import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dismissAsk, getAsk, listAsks, settleDue } from "./asks.mjs";
import { contextDirOf, limitOf, sizeRecord, updateRecord } from "./context.mjs";
import { CONTEXT_OPTIONS, CONTEXT_SESSION, commandUnder, contextDecision } from "./dispatch-context.mjs";
import { DISPATCH_SESSION, KEEP_SESSION, REOPEN_OPTIONS, formatPick, pick } from "./dispatch-pick.mjs";
import { briefProblem } from "./rotate.mjs";
import { START_GRACE_MS, clearKeepStops, keepAliveDecision, keepAnswerAction } from "./keep-alive.mjs";
import { readLoadGate } from "./load-gate.mjs";
import { createNotice } from "./notices.mjs";
import { plannerModel } from "./planner-model.mjs";
import {
  DEFAULT_MAX_BACKLOG_SESSIONS,
  readRequests,
  requestDecision,
  requestLine,
  requestNotice,
  settleRequest,
} from "./session-requests.mjs";
import { isLive, processOf, processTable, readRecord, readRecords, writeRecord } from "./sessions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** How often an idle tick runs `pnpm prd tidy --yes`. */
export const TIDY_EVERY_MS = 6 * 3600_000;
/** A reopened session live this long has recovered: its reopen count is dropped. */
export const REOPEN_RESET_MS = 30 * 60_000;
/** The one-shot helper that pushes the dispatcher's own asks. */
export const HELPER_SESSION = "dispatch-push";

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
  return s.kind === "plan"
    ? `${head}--model ${sh(s.model ?? "opus")} --remote-control ${name} "$(scripts/loops/prompt.sh plan ${sh(s.topic)} --auto)"`
    : `${head}--remote-control ${name} "$(scripts/loops/prompt.sh orchestrator ${sh(s.topic)} --auto)"`;
}

/** The helper's whole prompt: push LINE, then end. */
export const helperPrompt = (/** @type {string} */ line) =>
  `You are a one-shot helper for the Caretook dispatcher. Do exactly two things and nothing else: ` +
  `call the PushNotification tool once with this text: ${JSON.stringify(line)}. ` +
  `Then run \`pnpm prd end\` in Bash (it ends this session and closes its tab).`;

/** The helper's tab command. */
export const helperLine = (/** @type {{ main: string, claude: string, line: string }} */ h) =>
  `cd ${sh(h.main)} && ${sh(h.claude)} --model haiku --remote-control ${HELPER_SESSION} ${sh(helperPrompt(h.line))}`;

// ---- files -----------------------------------------------------------------------

/** The main checkout: the first worktree of the repo this file is in. */
export function mainCheckout(/** @type {string} */ from = HERE) {
  return execFileSync("git", ["-C", from, "worktree", "list", "--porcelain"], { encoding: "utf8" })
    .split("\n")[0]
    .replace(/^worktree /, "");
}

export function pathsOf(/** @type {string} */ main, env = process.env) {
  const loops = join(main, ".loops");
  return {
    main,
    loops,
    lock: join(loops, ".dispatch.lock"),
    state: join(loops, ".dispatch.json"),
    log: join(loops, ".dispatch.log"),
    sessions: env.CARETOOK_SESSIONS_DIR || join(loops, ".sessions"),
    asks: env.CARETOOK_ASKS_DIR || join(loops, ".asks"),
    requests: env.CARETOOK_REQUESTS_DIR || join(loops, ".requests"),
    notices: env.CARETOOK_NOTICES_DIR || join(loops, ".notices"),
  };
}

/** @typedef {{ paused?: { at: string, why: string } | null, reopens?: Record<string, number>,
 *   asked?: Record<string, { id: string, topic: string }>, lastTidy?: number,
 *   context?: Record<string, import("./dispatch-context.mjs").ContextEntry>,
 *   keepAlive?: import("./keep-alive.mjs").KeepState }} DispatchState */

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

const releaseLock = (/** @type {string} */ lock) => {
  try {
    if (Number(readFileSync(lock, "utf8").trim()) === process.pid) unlinkSync(lock);
  } catch {
    /* gone */
  }
};

// ---- facts -----------------------------------------------------------------------

const nowOf = (env = process.env) => {
  if (env.CARETOOK_CLOCK_FILE) {
    const s = Number(readFileSync(env.CARETOOK_CLOCK_FILE, "utf8").trim());
    if (Number.isFinite(s)) return s * 1000;
  }
  return Date.now();
};

const run = (/** @type {string} */ cmd, /** @type {string[]} */ args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
  return { ok: r.status === 0, code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};

const backlog = (/** @type {string} */ main, /** @type {string[]} */ args) =>
  run("node", [join(main, "scripts/backlog/backlog.mjs"), ...args], { cwd: main });

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
  if (!listed.ok) throw new Error(`pnpm backlog prd list failed: ${listed.err || listed.out}`);
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
  return {
    state,
    records,
    gate,
    facts: {
      rows,
      worktrees: worktreesOf(p.main),
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
        prds: positive(env.CARETOOK_MAX_PRDS, 4),
        planners: positive(env.CARETOOK_MAX_PLANNERS, 1),
        fixesMin: positive(env.CARETOOK_FIXES_MIN, 3),
      },
      now: nowOf(env),
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
  if (env.CARETOOK_CONTEXT_WATCH === "off") return false;
  const now = g.facts.now;
  const dir = contextDirOf(p.sessions);
  const limit = limitOf(env);
  const waitMs = positive(env.CARETOOK_CONTEXT_NUDGE_MIN, 15) * 60_000;
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
      env: { ...env, CARETOOK_ASKS_DIR: p.asks },
    });
  const lastLine = (/** @type {{ out: string, err: string }} */ r) =>
    (r.err || r.out).split("\n").pop() ?? "";

  let acted = false;
  for (const a of actions) {
    if (a.type === "hold") {
      out(`context: ${a.session} waits to rotate: a pnpm prd or pnpm backlog command is running under it`);
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
        CONTEXT_OPTIONS[0],
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
          helperLine({ main: p.main, claude: env.CARETOOK_CLAUDE_BIN || "claude", line: push }),
          "--title",
          HELPER_SESSION,
          "--background",
        ],
        { cwd: p.main },
      );
      if (!helper.ok) out(`  ${HELPER_SESSION} didn't start (ignored): ${lastLine(helper)}`);
    } else if (a.type === "rotate" || a.type === "rotate-backlog") {
      // A backlog session: `rotate --self` finds its caller by ancestry, so the tick opens its line.
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
                `cd ${sh(p.main)} && ${sh(join(HERE, "rotate-into.sh"))} ${sh(a.session)} ${a.pid} --reason context ${
                  a.brief ? `--brief ${sh(briefFile(a.session))}` : "--no-brief"
                }`,
                "--title",
                a.session,
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

/** Every process's command line, or null when they can't be read. CARETOOK_PROCESS_FILE stands in (tests). */
export function processLines(env = process.env) {
  try {
    if (env.CARETOOK_PROCESS_FILE)
      return readFileSync(env.CARETOOK_PROCESS_FILE, "utf8").split("\n").filter(Boolean);
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
    max: positive(env.CARETOOK_MAX_BACKLOG_SESSIONS, DEFAULT_MAX_BACKLOG_SESSIONS),
    now,
    claude: basename(env.CARETOOK_CLAUDE_BIN || "claude"),
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
    out(`  its notice failed (ignored): ${e instanceof Error ? e.message : String(e)}`);
  }
  return true;
}

// ---- one tick --------------------------------------------------------------------

/**
 * One tick: the answers to its asks, the pick, the action, tidy. Returns the
 * lines it printed and the pick. With dryRun it only picks and prints.
 */
export function tick(
  /** @type {ReturnType<typeof pathsOf>} */ p,
  { dryRun = false, env = process.env, say = (/** @type {string} */ l) => console.log(l) } = {},
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
        const r = backlog(p.main, ["prd", "set", topic, `flags=${flags.join(",")}`]);
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

  const choice = pick(facts);
  const head = formatPick(choice);
  if (g.gate.busy)
    head.splice(
      1,
      0,
      `  (the 5-minute load ${Math.round((g.gate.load ?? 0) * 10) / 10} is over ${g.gate.threshold})`,
    );
  lines.push(...head);

  // The context follow-up: apart from the pick, and never in the way of its action.
  let watched = false;
  try {
    watched = contextStep(p, g, { dryRun, env, out });
  } catch (e) {
    out(`context: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The keep-alive, beside the pick: it takes no slot, so the pick's action still happens.
  const keepDecisions = keepAliveDecision({
    sessions: facts.sessions,
    processes: processLines(env),
    keep: readState(p.state).keepAlive ?? {},
    paused: facts.paused,
    off: env.CARETOOK_KEEP_SESSIONS === "off",
    now,
    claude: basename(env.CARETOOK_CLAUDE_BIN || "claude"),
  });
  for (const d of keepDecisions)
    if (dryRun || d.action !== "none")
      out(`keep-alive ${d.kind}: ${d.action === "none" ? d.why : `${d.action} (${d.why})`}`);

  // Session requests: after the keep-alive (a kept session it opens counts), before starts.
  const requested = (/** @type {boolean} */ dry) => {
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
        env: { ...env, CARETOOK_ASKS_DIR: p.asks },
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
        helperLine({ main: p.main, claude: env.CARETOOK_CLAUDE_BIN || "claude", line: push }),
        HELPER_SESSION,
      );
      if (!helper.ok) out(`  ${HELPER_SESSION} didn't start (ignored): ${result(helper)}`);
    }
  }

  if (requested(false)) keptActed = true;

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
        env: { ...env, CARETOOK_ASKS_DIR: p.asks },
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
        helperLine({ main: p.main, claude: env.CARETOOK_CLAUDE_BIN || "claude", line: push }),
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

const onPath = (/** @type {string} */ cmd) =>
  (process.env.PATH ?? "").split(delimiter).some((d) => {
    try {
      accessSync(join(d, cmd), constants.X_OK);
      return Boolean(d);
    } catch {
      return false;
    }
  });

const stamp = (/** @type {number} */ ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

function parse(/** @type {string[]} */ argv) {
  const o = {
    every: 60,
    once: false,
    dryRun: false,
    pause: /** @type {string | null} */ (null),
    resume: false,
    stop: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--every") {
      o.every = Number(argv[++i]);
      if (!(o.every > 0)) throw new Error("--every takes a number of seconds");
    } else if (a === "--once") o.once = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--pause") o.pause = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "";
    else if (a === "--resume") o.resume = true;
    else if (a === "--stop") o.stop = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else
      throw new Error(
        `dispatch: unknown argument ${a} (--every <s>, --once, --dry-run, --pause [<why>], --resume, --stop)`,
      );
  }
  return o;
}

async function main() {
  let o;
  try {
    o = parse(process.argv.slice(2));
  } catch (e) {
    console.error(`pnpm prd: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  if (o.help) {
    const text = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
    console.log(
      text
        .slice(1, 12)
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
    process.kill(holder, "SIGTERM");
    // It releases the lock on its way out (a zombie still answers kill 0).
    const held = () => lockHolder(p.lock) === holder;
    for (let i = 0; i < 100 && held(); i++) await new Promise((r) => setTimeout(r, 100));
    console.log(
      held()
        ? `Sent TERM to the dispatcher (pid ${holder}); it hasn't exited yet.`
        : `Stopped the dispatcher (pid ${holder}).`,
    );
    return;
  }
  if (o.dryRun) {
    tick(p, { dryRun: true });
    return;
  }

  const iterm = process.env.CARETOOK_ITERM_APP || "/Applications/iTerm.app";
  if (!existsSync(iterm) || !onPath("osascript")) {
    console.error(
      `pnpm prd: dispatch needs iTerm2 (${iterm}) to open sessions; --dry-run shows what it would do`,
    );
    process.exit(1);
  }
  const lock = takeLock(p.lock);
  if (!lock.ok) {
    console.error(`pnpm prd: a dispatcher is already running (pid ${lock.pid}); --stop ends it`);
    process.exit(1);
  }
  let stopping = false;
  const stop = (/** @type {string} */ sig) => {
    if (stopping) return;
    stopping = true;
    log([`stopped (${sig})`], nowOf());
    releaseLock(p.lock);
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("exit", () => releaseLock(p.lock));

  if (!o.once) {
    // A start begins again after "stop keeping it alive".
    updateState(p.state, (s) => {
      if (s.keepAlive) s.keepAlive = clearKeepStops(s.keepAlive);
    });
    log([`started (pid ${process.pid}, every ${o.every}s)`], nowOf());
    console.log(
      `Dispatcher running (pid ${process.pid}, every ${o.every}s). --pause, --resume, --stop from any shell.`,
    );
  }
  let last = "";
  for (;;) {
    const now = nowOf();
    const quiet = [];
    const t = tick(p, { say: (l) => quiet.push(l) });
    const text = t.lines.join("\n");
    if (o.once || t.acted || text !== last) {
      log(t.lines, now);
      console.log(`${stamp(now)} ${quiet.join("\n")}`);
    }
    last = text;
    if (o.once) break;
    await new Promise((r) => setTimeout(r, o.every * 1000));
  }
  releaseLock(p.lock);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(`pnpm prd: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
