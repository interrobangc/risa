// The asks store: questions and reports for the dev keeper, one JSON file per
// ask in a directory (`.loops/.asks/<id>.json` in the main checkout; machine
// local, untracked). `ask.mjs` is its command line (`pnpm prd ask`, `asks`,
// `answer`); this module only reads and writes the files it is handed.
//
// An ask: { id, kind: "question" | "report", session, topic, text, options,
// recommended, askedAt, answer, answeredAt, doneAt }. Ids are a1, a2, …: a
// create takes the next free one exclusively (link(2) of a fully written temp
// file, so a reader never sees half a file and two creates never share an id),
// retrying the next id when another create won. A question is open until it is
// answered or dismissed; a report until it is dismissed (it can't be answered).
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const ID_FILE = /^a(\d+)\.json$/;

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

/**
 * File a question or a report; returns the stored ask.
 * @param {string} dir
 * @param {{ kind: "question" | "report", topic: string, text: string, session?: string | null,
 *   options?: string[], recommended?: string | null, now?: number }} ask
 */
export function createAsk(dir, { kind, topic, text, session = null, options = [], recommended = null, now }) {
  if (kind !== "question" && kind !== "report") throw new AskError(`unknown kind ${kind}`);
  if (!topic) throw new AskError("an ask needs a topic");
  if (!text?.trim()) throw new AskError(`a ${kind} needs its text`);
  if (kind === "report" && (options.length || recommended)) throw new AskError("a report has no options");
  if (new Set(options).size !== options.length) throw new AskError("options must differ");
  let rec = recommended ?? null;
  if (rec != null) {
    // --recommend takes an option's text or its number.
    if (/^\d+$/.test(rec) && !options.includes(rec)) rec = options[Number(rec) - 1] ?? rec;
    if (!options.includes(rec))
      throw new AskError(`the recommendation "${recommended}" isn't one of the options`);
  }
  mkdirSync(dir, { recursive: true });
  const base = { kind, session, topic, text, options, recommended: rec, askedAt: nowIso(now) };
  let n = Math.max(0, ...idNumbers(dir)) + 1;
  for (;;) {
    const id = `a${n}`;
    const record = { id, ...base, answer: null, answeredAt: null, doneAt: null };
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

export const isOpen = (ask) => !ask.doneAt && !(ask.kind === "question" && ask.answeredAt);

/** @param {string} dir @param {{ all?: boolean }} [opts] the asks (open ones unless all), oldest first */
export function listAsks(dir, { all = false } = {}) {
  return idNumbers(dir)
    .sort((a, b) => a - b)
    .map((n) => getAsk(dir, `a${n}`))
    .filter((a) => a && (all || isOpen(a)));
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

/**
 * Answer a question by an option's number (1-based) or by text; returns the ask.
 * @param {string} dir @param {string} id @param {string} reply @param {{ now?: number }} [opts]
 */
export function answerAsk(dir, id, reply, { now } = {}) {
  const ask = mustGet(dir, id);
  if (ask.kind !== "question")
    throw new AskError(`${id} is a report: it can't be answered (dismiss it with --done)`);
  if (ask.answeredAt) throw new AskError(`${id} is already answered: ${ask.answer}`);
  if (ask.doneAt) throw new AskError(`${id} was dismissed`);
  const text = String(reply ?? "").trim();
  if (!text) throw new AskError("an answer needs a number or some text");
  const answer =
    /^\d+$/.test(text) && ask.options[Number(text) - 1] != null ? ask.options[Number(text) - 1] : text;
  return save(dir, { ...ask, answer, answeredAt: nowIso(now) });
}

/** Dismiss an ask (a read report, a question no longer needed); returns the ask. */
export function dismissAsk(dir, id, { now } = {}) {
  const ask = mustGet(dir, id);
  if (ask.doneAt) throw new AskError(`${id} was already dismissed`);
  return save(dir, { ...ask, doneAt: nowIso(now) });
}

/** "45s", "12m", "3h", "2d" since iso */
export function age(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
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

/** The `pnpm prd asks` listing of asks (as listAsks returns them). */
export function formatAsks(asks, now = Date.now()) {
  if (!asks.length) return "No open asks.";
  return asks
    .map((a) => {
      const who = a.session ? `, ${a.session}` : "";
      const lines = [`${a.id}  ${a.kind}  ${a.topic}  ${age(a.askedAt, now)} ago${who}`];
      for (const l of a.text.trim().split("\n")) lines.push(`    ${l}`);
      a.options.forEach((o, i) =>
        lines.push(`    ${i + 1}. ${o}${o === a.recommended ? "  (recommended)" : ""}`),
      );
      return lines.join("\n");
    })
    .join("\n\n");
}
