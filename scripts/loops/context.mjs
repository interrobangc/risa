// The context watch: how large a recorded session has grown, and the reminders
// past its soft and hard limits.
//
// session.sh gives `prd` and `backlog` sessions context-settings.json, and the
// inbox session inbox-settings.json (claude --settings), hooks that run `context.mjs hook`
// on PreToolUse, PostToolUse, PostToolUseFailure, SubagentStop and Stop. Every event
// feeds the heartbeat (heartbeat.mjs); only PostToolUse is sized. The hook reads the transcript
// it is handed, writes the size record and stays silent under the limit. Over
// it, it adds a reminder to the agent's context. It never blocks a tool call
// and any error in it is swallowed (exit 0, no output).
//
// An orchestrator has two limits: past the soft one (CARETOOK_CONTEXT_LIMIT,
// 160k) a reminder asks it to judge, again every further 25k; past the hard one
// (CARETOOK_CONTEXT_HARD_LIMIT, 225k) it is told to rotate at the next safe
// point, at the crossing and every CARETOOK_CONTEXT_REMIND_MIN (10). A backlog
// session has only the soft one, and it is never a forced close: past it the
// session tells the user its size and asks whether to hand off or keep going,
// and no answer means keep going. The inbox session has one limit, the soft one
// (its hard limit equals it): past it, it hands off unasked, at the crossing and
// every CARETOOK_CONTEXT_REMIND_MIN. The dispatcher's follow-up starts at the hard
// limit (`hardOverAt`).
//
// A subagent's call (the hook input has `agent_id`) is sized from that agent's
// own transcript, and its state is kept apart, so it never counts as the
// session's. A backlog or inbox session's subagents get no reminder: they have no
// orchestrator to hand off to. The inbox session's reminder has it hand off by
// the command its prompt names (the main checkout's path: it runs outside it). Any other subagent has two fixed limits: past
// the soft one a reminder asks it to judge, again every further 25k; past the
// hard one it is told to hand off, on every tool call.
//
// Records, in .context beside the sessions folder (the main checkout's .loops):
//   <name>.json            pid, size, readAt, firstOverAt (past soft), remindedAt,
//                          remindedSize (where the next soft reminder counts
//                          from), hardOverAt (past hard), nudgeAt (a nudge is
//                          waiting), nudgeDeliveredAt, keep { reason, until }.
//                          One whose pid isn't the live session's is stale and
//                          ignored.
//   .agents/<name>/<id>.json   the same for one subagent of that session, with
//                          remindedSize (where its next soft reminder counts from)
//
//   pnpm prd context                the calling session's size and its limits
//   pnpm prd context --keep "<why>" leave it alone for CARETOOK_CONTEXT_KEEP_MIN (30)
//   pnpm prd context --all [--json] every live session
//
// CARETOOK_CONTEXT_LIMIT (the soft limit, 160000 tokens), CARETOOK_CONTEXT_HARD_LIMIT
// (225000; never below the soft one) and CARETOOK_CONTEXT_REMIND_MIN (10) are for
// orchestrators, backlog and inbox sessions; a subagent's limits are constants.
import { execFileSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { recordHeartbeat } from "./heartbeat.mjs";
import { defaultDir, isLive, processOf, readRecord, readRecords } from "./sessions.mjs";
import { branchKinds } from "./config.mjs";

const MIN_MS = 60_000;
/** How much of a transcript's end is read first; it doubles until a usage is found. */
const TAIL_BYTES = 256 * 1024;
const LOCK_WAIT_MS = 1000;
const LOCK_STALE_MS = 5000;
const LOOP_SOFT = 175_000;
const LOOP_HARD = 300_000;
const LOOP_REPEAT = 25_000;
/** How much further a session grows between two soft reminders. */
const SOFT_REPEAT = 25_000;

const positive = (/** @type {string | undefined} */ value, /** @type {number} */ fallback) => {
  const n = Number(value);
  return value && Number.isFinite(n) && n > 0 ? n : fallback;
};
/** An orchestrator's, backlog or inbox session's soft limit. */
export const limitOf = (env = process.env) => positive(env.CARETOOK_CONTEXT_LIMIT, 160_000);
/** An orchestrator's hard limit, never below the soft one. */
export const hardLimitOf = (env = process.env) =>
  Math.max(positive(env.CARETOOK_CONTEXT_HARD_LIMIT, 225_000), limitOf(env));
/** A session kind's hard limit: a backlog session has none (null); the inbox session's one limit is the soft one. */
export const hardLimitFor = (/** @type {string | undefined} */ kind, env = process.env) =>
  kind === "backlog" ? null : kind === "inbox" ? limitOf(env) : hardLimitOf(env);
const remindMsOf = (env = process.env) => positive(env.CARETOOK_CONTEXT_REMIND_MIN, 10) * MIN_MS;
const keepMsOf = (env = process.env) => positive(env.CARETOOK_CONTEXT_KEEP_MIN, 30) * MIN_MS;

export const contextDirOf = (/** @type {string} */ sessionsDir) => join(dirname(sessionsDir), ".context");
export const kilo = (/** @type {number} */ n) => `${Math.round(n / 1000)}k`;

/**
 * The context size in transcript text: the last assistant message's input,
 * cache read and cache creation tokens. Null when no line has a usage. A
 * session's own size skips subagent lines; `agent` reads an agent's transcript,
 * where every line is one.
 * @param {string} text @param {{ agent?: boolean }} [opts]
 * @returns {number | null}
 */
export function sizeFromTranscript(text, { agent = false } = {}) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue;
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (row?.type !== "assistant" || (!agent && row.isSidechain)) continue;
    const u = row.message?.usage;
    if (!u) continue;
    const size =
      (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    // A message the client made itself (an API error's) carries an all-zero usage.
    if (size > 0) return size;
  }
  return null;
}

/** The size from a transcript file, reading only as much of its end as it takes. */
export function readSize(/** @type {string} */ file, /** @type {{ agent?: boolean }} */ opts = {}) {
  const fd = openSync(file, "r");
  try {
    const total = fstatSync(fd).size;
    for (let want = TAIL_BYTES; ; want *= 2) {
      const n = Math.min(want, total);
      const buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, total - n);
      const size = sizeFromTranscript(buf.toString("utf8"), opts);
      if (size !== null || n === total) return size;
    }
  } finally {
    closeSync(fd);
  }
}

/** Where a subagent's own transcript is, or null when its id can't be part of a path. */
export function agentTranscript(/** @type {any} */ input) {
  const id = String(input.agent_id ?? "").replace(/^agent-/, "");
  if (!/^[\w-]+$/.test(id)) return null;
  if (typeof input.agent_transcript_path === "string") return input.agent_transcript_path;
  if (typeof input.transcript_path !== "string") return null;
  const file = `agent-${id}.jsonl`;
  if (basename(input.transcript_path) === file) return input.transcript_path;
  return join(input.transcript_path.replace(/\.jsonl$/, ""), "subagents", file);
}

export function orchestratorSoftReminder(
  /** @type {number} */ size,
  /** @type {number} */ soft,
  /** @type {number} */ hard,
) {
  return `Context watch: this session is at ${kilo(size)} tokens of context, past the soft limit of ${kilo(soft)} (the hard limit is ${kilo(hard)}). Judge whether to rotate now: go on if a step in hand can't resume from _Status_ (a landing under way) or the wave is nearly done; otherwise, at the next safe point, finish the step in hand, commit _Status_ and run \`pnpm prd rotate --mid-wave --reason "context"\` (plain \`pnpm prd rotate\` with no slice in flight), without asking. Past the hard limit you rotate at the next safe point.`;
}

export function orchestratorReminder(/** @type {number} */ size, /** @type {number} */ hard) {
  return `Context watch: this session is at ${kilo(size)} tokens of context, past the hard limit of ${kilo(hard)}. Finish the step in hand, commit _Status_, then run \`pnpm prd rotate --mid-wave --reason "context"\` (plain \`pnpm prd rotate\` with no slice in flight), without asking. Only a step that can't resume from _Status_ may finish first: run \`pnpm prd context --keep "<why>"\` and write the reason in _Status_.`;
}

export function orchestratorNudge(/** @type {number} */ size, /** @type {number} */ hard) {
  return `Context watch, second notice: this session is still at ${kilo(size)} tokens, past the hard limit of ${kilo(hard)}, and hasn't rotated. Rotate now: commit _Status_ and run \`pnpm prd rotate --mid-wave --reason "context"\` (plain \`pnpm prd rotate\` with no slice in flight). If the step in hand can't resume from _Status_, run \`pnpm prd context --keep "<why>"\` and write the reason in _Status_. Otherwise the user is asked next, and the session is rotated if they don't answer.`;
}

export function backlogReminder(/** @type {number} */ size, /** @type {number} */ soft) {
  return `Context watch: this session is at ${kilo(size)} tokens of context, past the soft limit of ${kilo(soft)}. This limit is soft: never hand off on your own. At the next pause in the talk with the user, never in the middle of a question, tell them the size and ask whether to hand off or keep going; if they don't answer, keep going. Only on their word to hand off: run \`pnpm prd rotate --self --brief-path\` for where to write a brief, write what's in hand, what was decided and what's next (at most about 40 lines), then run \`pnpm prd rotate --self --brief <that file>\`. You are reminded again every further ${kilo(SOFT_REPEAT)}.`;
}

export function backlogNudge(/** @type {number} */ size, /** @type {number} */ soft) {
  return `Context watch, second notice: this session is still at ${kilo(size)} tokens, well past the soft limit of ${kilo(soft)}. Never hand off on your own: at the next pause in the talk, never in the middle of a question, tell the user the size and ask whether to hand off or keep going; if they don't answer, keep going. The dispatcher also asks the user, and with no answer it leaves the session running. Only on the user's word to hand off: write the brief to the path \`pnpm prd rotate --self --brief-path\` prints and run \`pnpm prd rotate --self --brief <that file>\`.`;
}

/** The inbox session's hand-off: it runs outside the repository, so by the main checkout's path. */
export const inboxRotate = (/** @type {string} */ main) => `pnpm -s -C ${main} prd rotate --self`;

export function inboxReminder(
  /** @type {number} */ size,
  /** @type {number} */ limit,
  /** @type {string} */ rotate,
) {
  return `Context watch: this session is at ${kilo(size)} tokens of context, past the ${kilo(limit)} limit. At the next pause in the talk with the user, never in the middle of a request, hand off without asking: say in one line that a fresh inbox session takes over, then run \`${rotate}\` and do nothing after it.`;
}

export function inboxNudge(
  /** @type {number} */ size,
  /** @type {number} */ limit,
  /** @type {string} */ rotate,
) {
  return `Context watch, second notice: this session is still at ${kilo(size)} tokens, past the ${kilo(limit)} limit, and hasn't handed off. At the next pause in the talk, run \`${rotate}\`. Otherwise the user is asked next, and the session is rotated if they don't answer.`;
}

export function loopSoftReminder(/** @type {number} */ size) {
  return `Context watch: this agent is at ${kilo(size)} tokens of context, past the soft limit of ${kilo(LOOP_SOFT)} (the hard limit is ${kilo(LOOP_HARD)}; \`pnpm prd context\` shows your orchestrator's size, not yours). Judge whether to go on: continue if you are mid-change or hold understanding a fresh agent would pay to rebuild; otherwise hand off at the next natural boundary. Say which you chose and why in your hand-off. To hand off, commit any changes you were asked to make and write your hand-off as your final message; if this is a slice, tell your orchestrator to continue it with a fresh \`--continue\` agent.`;
}

export function loopHardReminder(/** @type {number} */ size) {
  return `Context watch: this agent is at ${kilo(size)} tokens of context, past the hard limit of ${kilo(LOOP_HARD)} (\`pnpm prd context\` shows your orchestrator's size, not yours). Hand off now: commit any changes you were asked to make, start no check, and write your hand-off as your final message, with your size, which checks did not run and any unfinished fix. If this is a slice, tell your orchestrator to continue it with a fresh \`--continue\` agent.`;
}

/** A subagent's reminder for its size, or null; updates its record. */
function loopMessage(/** @type {any} */ record, /** @type {number} */ size, /** @type {string} */ at) {
  if (size <= LOOP_SOFT) {
    for (const k of ["firstOverAt", "remindedAt", "remindedSize"]) delete record[k];
    return null;
  }
  record.firstOverAt ??= at;
  if (size <= LOOP_HARD && record.remindedSize !== undefined && size < record.remindedSize + LOOP_REPEAT) {
    // Shrunk between the limits: the next reminder counts from here.
    record.remindedSize = Math.min(record.remindedSize, size);
    return null;
  }
  record.remindedAt = at;
  record.remindedSize = size;
  return size > LOOP_HARD ? loopHardReminder(size) : loopSoftReminder(size);
}

/** A soft reminder for SIZE, or null inside the repeat; updates the record's size mark. */
function softMessage(/** @type {any} */ record, /** @type {number} */ size, /** @type {string} */ at) {
  if (record.remindedSize !== undefined && size < record.remindedSize + SOFT_REPEAT) {
    // Shrunk since the last reminder: the next one counts from here.
    record.remindedSize = Math.min(record.remindedSize, size);
    return false;
  }
  record.remindedAt = at;
  record.remindedSize = size;
  return true;
}

/**
 * What the hook does with a new size. Pure. `limit` is the soft limit and `hard` the
 * orchestrator's hard one (a backlog session has none).
 * @param {any} current the record, or null
 * @param {{ pid: number, size: number, now: number, limit: number, hard?: number, remindMs: number,
 *   loop?: boolean, backlog?: boolean, inbox?: string }} facts `inbox`: the inbox session's hand-off
 *   command; its one limit is the soft one (`hard` is ignored)
 * @returns {{ record: any, message: string | null }}
 */
export function hookDecision(
  current,
  {
    pid,
    size,
    now,
    limit,
    hard = Math.max(limit, 225_000),
    remindMs,
    loop = false,
    backlog = false,
    inbox = "",
  },
) {
  const at = new Date(now).toISOString();
  const record = { ...(current?.pid === pid ? current : {}), pid, size, readAt: at };
  if (record.keep && !(Date.parse(record.keep.until) > now)) delete record.keep;
  if (loop) return { record, message: loopMessage(record, size, at) };
  if (size <= limit) {
    for (const k of [
      "firstOverAt",
      "remindedAt",
      "remindedSize",
      "hardOverAt",
      "nudgeAt",
      "nudgeDeliveredAt",
    ])
      delete record[k];
    return { record, message: null };
  }
  record.firstOverAt ??= at;
  // The dispatcher's follow-up watches the hard limit, for a backlog session too; the
  // inbox session's is its soft one.
  const overHard = size > (inbox ? limit : Math.max(hard, limit));
  if (overHard) record.hardOverAt ??= at;
  else for (const k of ["hardOverAt", "nudgeAt", "nudgeDeliveredAt"]) delete record[k];
  if (record.keep) return { record, message: null };
  if (record.nudgeAt && !record.nudgeDeliveredAt) {
    record.nudgeDeliveredAt = at;
    record.remindedAt = at;
    if (inbox) return { record, message: inboxNudge(size, limit, inbox) };
    return { record, message: backlog ? backlogNudge(size, limit) : orchestratorNudge(size, hard) };
  }
  if (backlog)
    return { record, message: softMessage(record, size, at) ? backlogReminder(size, limit) : null };
  if (!overHard)
    return {
      record,
      message: softMessage(record, size, at) ? orchestratorSoftReminder(size, limit, hard) : null,
    };
  // Past hard: at the crossing, then every remindMs.
  const crossed = record.hardOverAt === at;
  if (!crossed && record.remindedAt && now - Date.parse(record.remindedAt) < remindMs)
    return { record, message: null };
  record.remindedAt = at;
  if (inbox) return { record, message: inboxReminder(size, limit, inbox) };
  return { record, message: orchestratorReminder(size, hard) };
}

const readJson = (/** @type {string} */ file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** Read, change and write FILE under a short lock: the hook, `--keep` and the dispatcher all write it. */
export function updateRecord(/** @type {string} */ file, /** @type {(r: any) => any} */ change) {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmdirSync(lock);
      } catch {
        /* its holder just let go */
      }
      if (Date.now() > deadline) throw new Error(`${file} is locked`, { cause: e });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    const next = change(readJson(file));
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, file);
    return next;
  } finally {
    rmdirSync(lock);
  }
}

/** NAME's size record while it is the session PID's, else null (stale). */
export function sizeRecord(/** @type {string} */ dir, /** @type {string} */ name, /** @type {number} */ pid) {
  const record = readJson(join(dir, `${name}.json`));
  return record?.pid === pid ? record : null;
}

/**
 * A live session's size for its status line: "over soft" past the soft limit, "OVER hard"
 * past the hard one. `hard` null: the session has none (a backlog session).
 * @param {any} record @param {{ limit?: number, hard?: number | null, now?: number }} [opts]
 */
export function sizeNote(record, { limit = limitOf(), hard = hardLimitOf(), now = Date.now() } = {}) {
  if (typeof record?.size !== "number") return "no size yet";
  const over = hard !== null && record.size > hard ? " OVER hard" : record.size > limit ? " over soft" : "";
  const kept = record.keep && Date.parse(record.keep.until) > now ? `, kept: ${record.keep.reason}` : "";
  return `${kilo(record.size)}${over}${kept}`;
}

/** The hook: its output for this input (the JSON for claude, or ""). Throws on anything unreadable. */
export function runHook(/** @type {string} */ raw, env = process.env, now = Date.now()) {
  const name = env.CARETOOK_SESSION_NAME;
  const pid = Number(env.CARETOOK_SESSION_PID);
  const sessions = env.CARETOOK_SESSIONS_DIR;
  if (!name || !pid || !sessions) return "";
  const session = readRecord(sessions, name);
  if (session?.pid !== pid) return "";
  const input = JSON.parse(raw);
  try {
    recordHeartbeat(input, env, now, session);
  } catch {
    /* the heartbeat never hurts the size watch */
  }
  // Only a finished call is sized; the other events are the heartbeat's alone.
  const event = input?.hook_event_name;
  if (event !== undefined && event !== "PostToolUse") return "";
  const dir = contextDirOf(sessions);
  const loop = Boolean(input.agent_id);
  const backlog = session.kind === "backlog";
  const inbox = session.kind === "inbox" ? inboxRotate(dirname(dirname(sessions))) : "";
  if (loop && (backlog || inbox)) return "";
  const transcript = loop ? agentTranscript(input) : input.transcript_path;
  if (typeof transcript !== "string") return "";
  const size = readSize(transcript, { agent: loop });
  if (size === null) return "";
  const id = String(input.agent_id ?? "").replace(/^agent-/, "");
  const file = loop ? join(dir, ".agents", name, `${id}.json`) : join(dir, `${name}.json`);
  /** @type {string | null} */
  let message = null;
  updateRecord(file, (current) => {
    // A new session under this name: its old agents' records go too.
    if (!loop && current && current.pid !== pid)
      rmSync(join(dir, ".agents", name), { recursive: true, force: true });
    const d = hookDecision(current, {
      pid,
      size,
      now,
      limit: limitOf(env),
      hard: inbox ? limitOf(env) : hardLimitOf(env),
      remindMs: remindMsOf(env),
      loop,
      backlog,
      inbox,
    });
    message = d.message;
    return d.record;
  });
  if (!message) return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message } });
}

/**
 * Every live session with its size and limits (`hard` null for a backlog session, the soft
 * limit for the inbox session).
 * @param {string} sessions @param {{ limit?: number, hardLimit?: number, now?: number }} [opts]
 */
export function liveSizes(sessions, { limit = limitOf(), hardLimit = hardLimitOf(), now = Date.now() } = {}) {
  const dir = contextDirOf(sessions);
  // Each process's start by its own ps call's clock: a `now` taken before every call
  // would date the later ones earlier by however long the calls took under load.
  return readRecords(sessions)
    .filter(({ record }) => isLive(record, processOf(record.pid ?? 0), now))
    .map(({ name, record }) => {
      const size = sizeRecord(dir, name, record.pid ?? 0);
      const keep = size?.keep && Date.parse(size.keep.until) > now ? size.keep : null;
      const hard = record.kind === "backlog" ? null : record.kind === "inbox" ? limit : hardLimit;
      return {
        name,
        pid: record.pid,
        size: size?.size ?? null,
        limit,
        hard,
        over: (size?.size ?? 0) > limit,
        overHard: hard !== null && (size?.size ?? 0) > hard,
        readAt: size?.readAt ?? null,
        keep,
        note: sizeNote(size, { limit, hard, now }),
      };
    });
}

function cli(/** @type {string[]} */ args) {
  const sessions = defaultDir();
  const dir = contextDirOf(sessions);
  const limit = limitOf();
  if (args[0] === "--all") {
    const rows = liveSizes(sessions, { limit, hardLimit: hardLimitOf() });
    if (args.includes("--json")) console.log(JSON.stringify(rows));
    else for (const r of rows) console.log(`${r.name}  ${r.note}`);
    return 0;
  }
  if (args.length && args[0] !== "--keep") {
    console.error('usage: pnpm prd context [--keep "<why>" | --all [--json]]');
    return 2;
  }
  const keeping = args[0] === "--keep";
  const why = (args[1] ?? "").trim();
  if (keeping && !why) {
    console.error('context --keep needs the reason: pnpm prd context --keep "<why>"');
    return 2;
  }
  const name = process.env.CARETOOK_SESSION_NAME;
  const pid = Number(process.env.CARETOOK_SESSION_PID);
  const session = name ? readRecord(sessions, name) : null;
  if (!name || !pid || session?.pid !== pid) {
    console.error("context: this shell isn't in a session the wrapper started with the context watch");
    return keeping ? 1 : 0;
  }
  if (keeping) {
    // A loop's shell carries its orchestrator's session: its keep would silence the wrong one.
    let branch = "";
    try {
      branch = execFileSync("git", ["branch", "--show-current"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      /* not in a repo: nothing to refuse on */
    }
    if (branchKinds().is(branch, "slice")) {
      console.error("context --keep is the orchestrator's: a loop hands off instead");
      return 1;
    }
    const until = new Date(Date.now() + keepMsOf()).toISOString();
    updateRecord(join(dir, `${name}.json`), (current) => ({
      ...(current?.pid === pid ? current : { pid }),
      keep: { reason: why, until },
    }));
    console.log(`${name}: left alone until ${until}: ${why}`);
    return 0;
  }
  const record = sizeRecord(dir, name, pid);
  const hard = hardLimitFor(session.kind);
  const limits = `soft ${kilo(limit)}, ${hard === null ? "no hard limit" : `hard ${kilo(hard)}`}`;
  console.log(`${name}: ${sizeNote(record, { limit, hard })} (${limits})`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (args[0] === "hook") {
    // The hook can never hurt a session: no output and exit 0 on any error.
    try {
      const out = runHook(readFileSync(0, "utf8"));
      if (out) process.stdout.write(out);
    } catch {
      /* swallowed */
    }
    process.exit(0);
  }
  try {
    process.exit(cli(args));
  } catch (e) {
    console.error(`context: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
