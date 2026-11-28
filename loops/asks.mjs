// The asks store: questions and reports for the dev keeper, one JSON file per
// ask in a directory (`.loops/.asks/<id>.json` in the main checkout; machine
// local, untracked). `ask.mjs` is its command line (`ask`, `asks`,
// `answer`); this module only reads and writes the files it is handed.
//
// An ask: { id, kind: "question" | "report", session, topic, text, options,
// recommended, defaults, defaultAt, askedAt, answer, answeredAt, defaulted,
// doneAt }. Ids are a1, a2, …: a create takes the next free one exclusively
// (link(2) of a fully written temp file, so a reader never sees half a file and
// two creates never share an id), retrying the next id when another create won.
//
// A question awaits an answer until it is answered or dismissed; a report is
// listed until it is dismissed (it can't be answered). A question filed with
// `defaults` (it needs a recommendation) may take its recommendation once
// `defaultAt` (askedAt plus the wait at filing) has passed: settleAsk writes it
// as the answer and marks the ask `defaulted`, only while the ask is still
// unanswered and not dismissed. A defaulted ask stays listed ("decided for
// you") until dismissed, and can't be answered afterwards. Answering, settling
// and dismissing each take the ask's lock (`.<id>.lock`, created exclusively;
// a dead holder's is taken over under `.<id>.takeover`, so two takers never
// both remove it and a fresh lock is never removed), re-read the ask inside
// it and write before letting go, so neither overwrites the other: whichever
// comes first stands and the other reports it. Reading never settles: only a
// waiting session (`ask --wait`) and the dispatcher's tick call settleAsk.
//
// A question that went past a skeptic carries `skeptic: { id, verdict, why }`.
// One the skeptic decided is filed already settled (`chose`): its answer is the
// option, `defaulted` is true so it lists and dismisses with the defaulted ones
// under "decided for you", and it is never pushed.
import { toolCmd } from "./config.mjs";
import {
  closeSync,
  fstatSync,
  linkSync,
  openSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const ID_FILE = /^a(\d+)\.json$/;

/** How long a defaulting question waits for an answer, in minutes (RISA_ASK_DEFAULT_MIN). */
export const DEFAULT_WAIT_MIN = 30;
/** The questions that never default: they take --waits. */
export const NEVER_DEFAULT =
  "money (a paid service too), data loss or a change to existing data, a live deploy (staging or production), a destructive step (deleting unmerged work, a forced push), a new dependency (AGENTS.md: the user's approval), and compliance";
/** How long answering, settling or dismissing waits for another one's lock on the same ask. */
export const LOCK_WAIT_MS = 5000;
/** The dispatcher's own sessions: code, so their questions need no skeptic (the honor system). */
export const DISPATCHER_SESSIONS = ["dispatch", "dispatch-context", "dispatch-keep", "dispatch-stuck"];
/** A lock this old is taken over even if its holder looks alive (a reused pid). */
const LOCK_STALE_MS = 60_000;

export class AskError extends Error {}

const nowIso = (now) => new Date(now ?? Date.now()).toISOString();
const tmpName = (dir) => join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);

/** @param {string} dir @returns {number[]} the numbers of the ids in dir */
const idNumbers = (dir) => {
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  return names.flatMap((n) => {
    const m = ID_FILE.exec(n);
    return m ? [Number(m[1])] : [];
  });
};

// An option given by its text or its 1-based number.
const pickOption = (options, value) =>
  /^\d+$/.test(value) && !options.includes(value) ? (options[Number(value) - 1] ?? value) : value;

/**
 * Throws an AskError unless the ask can be filed, and returns its recommendation
 * and chosen option as option text. Writes nothing, so a caller can check before
 * it spends a skeptic's record.
 */
export function validateAsk({
  kind,
  topic,
  text,
  options = [],
  recommended = null,
  defaults = false,
  waitMin = DEFAULT_WAIT_MIN,
  chose = null,
}) {
  if (kind !== "question" && kind !== "report") throw new AskError(`unknown kind ${kind}`);
  if (!topic) throw new AskError("an ask needs a topic");
  if (!text?.trim()) throw new AskError(`a ${kind} needs its text`);
  if (kind === "report" && (options.length || recommended)) throw new AskError("a report has no options");
  if (new Set(options).size !== options.length) throw new AskError("options must differ");
  let rec = recommended ?? null;
  if (rec != null) {
    // --recommend takes an option's text or its number.
    rec = pickOption(options, rec);
    if (!options.includes(rec))
      throw new AskError(`the recommendation "${recommended}" isn't one of the options`);
  }
  if (defaults && kind === "report") throw new AskError("a report has no answer to default to");
  if (defaults && rec == null)
    throw new AskError("a question that defaults needs a recommendation (--recommend) to take");
  if (defaults && !(Number.isFinite(waitMin) && waitMin >= 0))
    throw new AskError(`the wait before a default is a number of minutes, not ${waitMin}`);
  let picked = null;
  if (chose != null) {
    if (kind !== "question") throw new AskError("only a question can be decided");
    if (rec != null || defaults) throw new AskError("a decided question has no recommendation or default");
    picked = pickOption(options, chose);
    if (!options.includes(picked)) throw new AskError(`the choice "${chose}" isn't one of the options`);
  }
  return { recommended: rec, chose: picked };
}

/**
 * File a question or a report; returns the stored ask.
 * @param {string} dir
 * defaults: the question may take its recommendation after waitMin minutes unanswered.
 * skeptic: the verdict it went past. chose: the option a skeptic decided (files it settled).
 * @param {{ kind: "question" | "report", topic: string, text: string, session?: string | null,
 *   options?: string[], recommended?: string | null, defaults?: boolean, waitMin?: number,
 *   skeptic?: { id: string, verdict: string, why: string } | null, chose?: string | null,
 *   now?: number }} ask
 */
export function createAsk(
  dir,
  {
    kind,
    topic,
    text,
    session = null,
    options = [],
    recommended = null,
    defaults = false,
    waitMin = DEFAULT_WAIT_MIN,
    skeptic = null,
    chose = null,
    now,
  },
) {
  const valid = validateAsk({ kind, topic, text, options, recommended, defaults, waitMin, chose });
  const rec = valid.recommended;
  if (valid.chose != null && skeptic?.verdict !== "decide")
    throw new AskError("only a skeptic's decide files a decided question");
  mkdirSync(dir, { recursive: true });
  const at = now ?? Date.now();
  const base = {
    kind,
    session,
    topic,
    text,
    options,
    recommended: rec,
    defaults: Boolean(defaults),
    defaultAt: defaults ? nowIso(at + waitMin * 60_000) : null,
    askedAt: nowIso(at),
    ...(skeptic ? { skeptic } : {}),
  };
  const settled =
    valid.chose != null
      ? { answer: valid.chose, answeredAt: nowIso(at), defaulted: true }
      : { answer: null, answeredAt: null, defaulted: false };
  let n = Math.max(0, ...idNumbers(dir)) + 1;
  for (;;) {
    const id = `a${n}`;
    const record = { id, ...base, ...settled, doneAt: null };
    const tmp = tmpName(dir);
    writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
    try {
      linkSync(tmp, join(dir, `${id}.json`));
      return record;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      n++;
    } finally {
      unlinkSync(tmp);
    }
  }
}

/** @param {string} dir @param {string} id @returns {object | null} the ask, or null when there's none */
export function getAsk(dir, id) {
  if (!/^a\d+$/.test(id)) return null;
  try {
    return JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/** A question nobody has answered (or defaulted) and nobody dismissed. */
export const awaitsAnswer = (ask) => ask.kind === "question" && !ask.doneAt && !ask.answeredAt;

/** Still shown to the user: an awaiting question, an undismissed report or defaulted question. */
export const isListed = (ask) =>
  !ask.doneAt && (ask.kind === "report" || !ask.answeredAt || ask.defaulted === true);

/** An awaiting question that may default and whose time has come. */
export const isDue = (ask, now = Date.now()) =>
  awaitsAnswer(ask) && ask.defaults === true && Date.parse(ask.defaultAt ?? "") <= now;

/** @param {string} dir @param {{ all?: boolean }} [opts] the asks (listed ones unless all), oldest first */
export function listAsks(dir, { all = false } = {}) {
  return idNumbers(dir)
    .sort((a, b) => a - b)
    .map((n) => getAsk(dir, `a${n}`))
    .filter((a) => a && (all || isListed(a)));
}

const save = (dir, ask) => {
  const tmp = tmpName(dir);
  writeFileSync(tmp, JSON.stringify(ask, null, 2) + "\n");
  renameSync(tmp, join(dir, `${ask.id}.json`));
  return ask;
};

const mustGet = (dir, id) => {
  const ask = getAsk(dir, id);
  if (!ask) throw new AskError(`no ask ${id}`);
  return ask;
};

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A lock file's text and mtime, read from one open file, or null when it's gone. */
const readLock = (path) => {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  try {
    return { mtimeMs: fstatSync(fd).mtimeMs, text: readFileSync(fd, "utf8") };
  } finally {
    closeSync(fd);
  }
};

/** Whether a read lock's holder is gone: its pid is dead, or it is older than LOCK_STALE_MS. */
const holderGone = ({ text, mtimeMs }) => {
  if (Date.now() - mtimeMs > LOCK_STALE_MS) return true;
  const pid = Number(text.split(" ")[0]);
  if (!Number.isInteger(pid) || pid <= 0) return false; // being written
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === "ESRCH";
  }
};

const lockIsStale = (lock) => {
  const read = readLock(lock);
  return read !== null && holderGone(read);
};

/** A takeover mutex this old belongs to a taker that died inside it (it holds one for a read and an unlink). */
const TAKEOVER_STALE_MS = 5000;

/**
 * Remove a stale lock under the ask's takeover mutex (`.<id>.takeover`, created
 * exclusively), judging it again inside: two takers that both saw it stale can't
 * both remove it, so neither deletes the lock the other took fresh after. Only
 * takers remove another's lock, and only here, so a lock judged inside the mutex
 * stays the one removed. Returns false when another taker holds the mutex.
 * @returns {boolean}
 */
const takeOver = (lock, mutex) => {
  try {
    writeFileSync(mutex, String(process.pid), { flag: "wx" });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const held = readLock(mutex);
    if (held && Date.now() - held.mtimeMs > TAKEOVER_STALE_MS) rmSync(mutex, { force: true });
    return false;
  }
  try {
    if (lockIsStale(lock)) rmSync(lock, { force: true });
    return true;
  } finally {
    rmSync(mutex, { force: true });
  }
};

/**
 * Run fn with the ask's lock held: the one exclusive step answering, settling
 * and dismissing share. Waits up to waitMs for another holder (a dead one is
 * taken over, atomically: see takeOver), then throws. `afterStaleCheck` is a
 * test hook, called between judging a lock stale and taking it over.
 * @template T @param {string} dir @param {string} id @param {() => T} fn
 * @param {{ waitMs?: number, afterStaleCheck?: () => void }} [opts] @returns {T}
 */
export function withAskLock(dir, id, fn, { waitMs = LOCK_WAIT_MS, afterStaleCheck } = {}) {
  if (!/^a\d+$/.test(id)) throw new AskError(`no ask ${id}`);
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, `.${id}.lock`);
  const mutex = join(dir, `.${id}.takeover`);
  const token = `${process.pid} ${Math.random().toString(36).slice(2)}`;
  const end = Date.now() + waitMs;
  for (;;) {
    try {
      writeFileSync(lock, token, { flag: "wx" });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    if (lockIsStale(lock)) {
      afterStaleCheck?.();
      if (takeOver(lock, mutex)) continue;
    }
    if (Date.now() >= end)
      throw new AskError(`${id} is busy: another answer or default holds it (try again)`);
    pause(20);
  }
  try {
    return fn();
  } finally {
    try {
      if (readFileSync(lock, "utf8") === token) unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Answer a question by an option's number (1-based) or by text; returns the ask.
 * @param {string} dir @param {string} id @param {string} reply @param {{ now?: number }} [opts]
 */
export function answerAsk(dir, id, reply, { now, lockWaitMs } = {}) {
  const text = String(reply ?? "").trim();
  return withAskLock(
    dir,
    id,
    () => {
      const ask = mustGet(dir, id);
      if (ask.kind !== "question")
        throw new AskError(`${id} is a report: it can't be answered (dismiss it with --done)`);
      if (ask.defaulted && ask.skeptic?.verdict === "decide")
        throw new AskError(
          `${id} was decided by a skeptic: it took "${ask.answer}" (${ask.skeptic.why}), and its session has acted on it, so it can't be answered now. Tell that session if you disagree; dismiss it with ${toolCmd.prd} asks --done ${id}`,
        );
      if (ask.defaulted)
        throw new AskError(
          `${id} was decided for you: it took "${ask.answer}" at ${clock(ask.answeredAt)} after no answer, and its session has acted on it, so it can't be answered now. Tell that session if you disagree; dismiss it with ${toolCmd.prd} asks --done ${id}`,
        );
      if (ask.answeredAt) throw new AskError(`${id} is already answered: ${ask.answer}`);
      if (ask.doneAt) throw new AskError(`${id} was dismissed`);
      if (!text) throw new AskError("an answer needs a number or some text");
      const answer =
        /^\d+$/.test(text) && ask.options[Number(text) - 1] != null ? ask.options[Number(text) - 1] : text;
      return save(dir, { ...ask, answer, answeredAt: nowIso(now) });
    },
    { waitMs: lockWaitMs },
  );
}

/**
 * Apply the ask's default if it is due: write its recommendation as the answer
 * and mark it defaulted, only while it still awaits an answer. Returns
 * { settled, ask, why } (why: what stopped it, when nothing was written).
 * @param {string} dir @param {string} id @param {{ now?: number, lockWaitMs?: number }} [opts]
 */
export function settleAsk(dir, id, { now, lockWaitMs } = {}) {
  const at = now ?? Date.now();
  return withAskLock(
    dir,
    id,
    () => {
      const ask = mustGet(dir, id);
      if (isDue(ask, at))
        return {
          settled: true,
          ask: save(dir, { ...ask, answer: ask.recommended, answeredAt: nowIso(at), defaulted: true }),
        };
      const why =
        ask.kind !== "question"
          ? "a report"
          : ask.defaulted
            ? "already defaulted"
            : ask.answeredAt
              ? "answered"
              : ask.doneAt
                ? "dismissed"
                : ask.defaults !== true
                  ? "waits for an answer"
                  : `not due until ${clock(ask.defaultAt)}`;
      return { settled: false, ask, why };
    },
    { waitMs: lockWaitMs },
  );
}

/** Settle every due ask in dir; returns the asks it defaulted. A busy one is left for next time. */
export function settleDue(dir, { now } = {}) {
  const at = now ?? Date.now();
  const settled = [];
  for (const a of listAsks(dir)) {
    if (!isDue(a, at)) continue;
    try {
      const r = settleAsk(dir, a.id, { now: at, lockWaitMs: 500 });
      if (r.settled) settled.push(r.ask);
    } catch (e) {
      if (!(e instanceof AskError)) throw e;
    }
  }
  return settled;
}

/** Dismiss an ask (a read report, a question no longer needed); returns the ask. */
export function dismissAsk(dir, id, { now, lockWaitMs } = {}) {
  return withAskLock(
    dir,
    id,
    () => {
      const ask = mustGet(dir, id);
      if (ask.doneAt) throw new AskError(`${id} was already dismissed`);
      return save(dir, { ...ask, doneAt: nowIso(now) });
    },
    { waitMs: lockWaitMs },
  );
}

/** "45s", "12m", "3h", "2d" since iso */
export function age(iso, now = Date.now()) {
  return span(now - Date.parse(iso));
}

/** A length of time, ms: "45s", "12m", "3h", "2d" (never negative). */
export function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** One line of at most max characters (whitespace folded, an ellipsis when cut). */
export function shorten(text, max = 100) {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : one.slice(0, max - 1).trimEnd() + "…";
}

/** The local time of day of iso, "14:05". */
export function clock(iso) {
  const d = new Date(Date.parse(iso ?? ""));
  if (Number.isNaN(d.getTime())) return "?";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * When an awaiting, defaulting question takes its recommendation: `takes "<a>" in 18m`, or due.
 * The time left is span's: to the nearest second, then whole minutes rounded down (29m59s
 * left reads "29m"); the clock time beside it is exact.
 */
export function countdown(ask, now = Date.now()) {
  const left = Date.parse(ask.defaultAt ?? "") - now;
  return left > 0
    ? `takes "${ask.recommended}" in ${span(left)} (at ${clock(ask.defaultAt)}) unless answered`
    : `takes "${ask.recommended}": due (still answerable)`;
}

/** One line on what waits on the user (`asks --short`): open questions oldest first, then counts. */
export function formatAsksShort(asks, now = Date.now()) {
  if (!asks.length) return "No open asks.";
  const decided = asks.filter((a) => a.defaulted).length;
  const reports = asks.filter((a) => !a.defaulted && a.kind === "report").length;
  const questions = asks
    .filter((a) => !a.defaulted && a.kind !== "report")
    .sort((x, y) => Date.parse(x.askedAt) - Date.parse(y.askedAt))
    .map((a) => `${a.id} ${a.topic} ${age(a.askedAt, now)}`);
  const open = questions.length
    ? `${questions.length} open question${questions.length === 1 ? "" : "s"} (${questions.join(", ")})`
    : "No open questions";
  return `${open}, ${reports} report${reports === 1 ? "" : "s"}, ${decided} decided for you.`;
}

/** The `asks` listing of asks (as listAsks returns them): open ones, then the defaulted. */
export function formatAsks(asks, now = Date.now()) {
  if (!asks.length) return "No open asks.";
  const one = (a) => {
    const who = a.session ? `, ${a.session}` : "";
    const lines = [`${a.id}  ${a.kind}  ${a.topic}  ${age(a.askedAt, now)} ago${who}`];
    if (awaitsAnswer(a) && a.defaults) lines[0] += `, ${countdown(a, now)}`;
    for (const l of a.text.trim().split("\n")) lines.push(`    ${l}`);
    a.options.forEach((o, i) =>
      lines.push(`    ${i + 1}. ${o}${o === a.recommended ? "  (recommended)" : ""}`),
    );
    if (a.defaulted && a.skeptic?.verdict === "decide")
      lines.push(
        `    → a skeptic chose "${a.answer}" at ${clock(a.answeredAt)}, ${age(a.answeredAt, now)} ago: ${a.skeptic.why}`,
      );
    else if (a.defaulted)
      lines.push(
        `    → took "${a.answer}" at ${clock(a.answeredAt)}, ${age(a.answeredAt, now)} ago, unanswered`,
      );
    return lines.join("\n");
  };
  const open = asks.filter((a) => !a.defaulted).map(one);
  const decided = asks.filter((a) => a.defaulted).map(one);
  const parts = [...open];
  if (decided.length) {
    const how = asks.some((a) => a.defaulted && a.skeptic?.verdict === "decide")
      ? "by a skeptic, or no answer came"
      : "no answer came";
    parts.push(
      [`DECIDED FOR YOU (${how}; dismiss each once read: ${toolCmd.prd} asks --done <id>)`, ...decided].join(
        "\n\n",
      ),
    );
  }
  return parts.join("\n\n");
}
