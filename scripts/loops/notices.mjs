// The notice board's store: one-way, advisory lines sessions post for each
// other ("landed X: sync at your next wave boundary"), one JSON file per notice
// in a directory (`.loops/.notices/<id>.json` in the main checkout; machine
// local, untracked). `notice.mjs` is its command line (`pnpm prd notice`,
// `notices`); this module only reads and writes the files it is handed.
//
// A notice: { id, session, topic, text, postedAt, expiresAt }. Ids are n1, n2,
// …: a create takes the next free one exclusively (link(2) of a fully written
// temp file, so a reader never sees half a file and two creates never share an
// id), retrying the next id when another create won. `.seq` keeps the highest
// id handed out, so an id isn't reused after its notice expires and its file
// is pruned (a late `--done` can't withdraw someone else's newer notice).
// Every write and every list deletes the expired files first. Withdrawing a
// notice deletes its file. Nothing blocks on a notice: the claim and the leases
// do the blocking.
import { linkSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { age } from "./asks.mjs";

/** The default life, in minutes, and the longest a notice may live. */
export const DEFAULT_MINUTES = 60;
export const MAX_MINUTES = 24 * 60;
/** The longest line a notice may carry. */
export const MAX_TEXT = 200;

const ID_FILE = /^n(\d+)\.json$/;
/** The high-water marks (one empty file per number); `.seq`, a file holding one number, is the old form, read only. */
const SEQ_DIR = ".seq.d";
const LEGACY_SEQ = ".seq";

export class NoticeError extends Error {}

const tmpName = (dir) => join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
const gone = (file) => {
  try {
    unlinkSync(file);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
};

/** @param {string} dir @returns {number[]} the numbers of the ids in dir (none when dir is missing) */
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

const readLegacySeq = (dir) => {
  try {
    return Number(readFileSync(join(dir, LEGACY_SEQ), "utf8").trim()) || 0;
  } catch {
    return 0;
  }
};

const seqMarks = (dir) => {
  try {
    return readdirSync(join(dir, SEQ_DIR)).flatMap((n) => (/^\d+$/.test(n) ? [Number(n)] : []));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
};

/** The highest id number ever handed out in dir (0 for none). @param {string} dir */
export const readSeq = (dir) => Math.max(0, readLegacySeq(dir), ...seqMarks(dir));

/**
 * Raise the high-water mark to at least n; never lowers it, whatever other
 * raises run alongside (each deletes only marks below its own, so the highest
 * mark survives). @param {string} dir @param {number} n
 */
export function raiseSeq(dir, n) {
  const marks = join(dir, SEQ_DIR);
  mkdirSync(marks, { recursive: true });
  writeFileSync(join(marks, String(n)), "");
  for (const m of seqMarks(dir)) if (m < n) gone(join(marks, String(m)));
  const legacy = readLegacySeq(dir);
  if (legacy && legacy <= n) gone(join(dir, LEGACY_SEQ));
}

const read = (dir, n) => {
  try {
    return JSON.parse(readFileSync(join(dir, `n${n}.json`), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT" || e instanceof SyntaxError) return null;
    throw e;
  }
};

const expired = (notice, now) => !(Date.parse(notice.expiresAt) > now);

/**
 * Delete the expired notices' files; returns the live ones, oldest first.
 * @param {string} dir @param {number} [now]
 */
function prune(dir, now = Date.now()) {
  const live = [];
  for (const n of idNumbers(dir).sort((a, b) => a - b)) {
    const notice = read(dir, n);
    if (!notice) continue;
    if (expired(notice, now)) gone(join(dir, `n${n}.json`));
    else live.push(notice);
  }
  return live.sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt) || idOf(a) - idOf(b));
}
const idOf = (notice) => Number(String(notice.id).slice(1));

/** The line as stored: whitespace folded into one line. */
export const oneLine = (text) =>
  String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Post a notice; returns the stored notice.
 * @param {string} dir
 * @param {{ text: string, session?: string | null, topic?: string | null, minutes?: number, now?: number }} notice
 */
export function createNotice(dir, { text, session = null, topic = null, minutes = DEFAULT_MINUTES, now }) {
  const line = oneLine(text);
  if (!line) throw new NoticeError("a notice needs its text");
  if (line.length > MAX_TEXT)
    throw new NoticeError(
      `a notice is one line of at most ${MAX_TEXT} characters (this one has ${line.length})`,
    );
  const mins = Number(minutes);
  if (!(mins > 0)) throw new NoticeError("--for takes a number of minutes above 0");
  if (mins > MAX_MINUTES)
    throw new NoticeError(
      `a notice lives at most ${MAX_MINUTES} minutes (24 hours); --for ${minutes} is longer`,
    );
  const at = now ?? Date.now();
  mkdirSync(dir, { recursive: true });
  prune(dir, at);
  const base = {
    session: session || null,
    topic: topic || null,
    text: line,
    postedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + mins * 60_000).toISOString(),
  };
  let n = Math.max(readSeq(dir), ...idNumbers(dir)) + 1;
  for (;;) {
    const id = `n${n}`;
    const record = { id, ...base };
    const tmp = tmpName(dir);
    writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
    try {
      linkSync(tmp, join(dir, `${id}.json`));
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      n++;
      continue;
    } finally {
      gone(tmp);
    }
    raiseSeq(dir, n);
    return record;
  }
}

/** The live notices, oldest first; deletes the expired ones' files. @param {string} dir @param {{ now?: number }} [opts] */
export function listNotices(dir, { now } = {}) {
  return prune(dir, now ?? Date.now());
}

/** Withdraw a live notice (delete its file); returns it. @param {string} dir @param {string} id */
export function withdrawNotice(dir, id, { now } = {}) {
  const m = /^n(\d+)$/.exec(String(id ?? ""));
  const live = prune(dir, now ?? Date.now());
  const notice = m ? live.find((x) => x.id === id) : null;
  if (!notice) throw new NoticeError(`no live notice ${id} (pnpm prd notices lists them)`);
  gone(join(dir, `${id}.json`));
  return notice;
}

/** "45s", "12m", "3h" until iso (0s once past). */
export const left = (iso, now = Date.now()) => age(new Date(now).toISOString(), Date.parse(iso));

/** One notice as a line: id, session, topic, age, time left, the text. */
export function formatNotice(n, now = Date.now()) {
  return `${n.id}  ${n.session ?? "-"}  ${n.topic ?? "-"}  ${age(n.postedAt, now)} ago, ${left(n.expiresAt, now)} left: ${n.text}`;
}

/** The `pnpm prd notices` listing. */
export function formatNotices(notices, now = Date.now()) {
  if (!notices.length) return "No live notices.";
  return notices.map((n) => formatNotice(n, now)).join("\n");
}

/**
 * What a gated command (check, sync, slice, browser, pr, ready, land) prints
 * first: other sessions' live notices, at most `max` lines in all (the last
 * says how many more there are). Nothing when there are none.
 * @param {object[]} notices @param {string | null} self the calling session (its own are left out)
 */
export function gateLines(notices, self, { now = Date.now(), max = 5 } = {}) {
  const others = notices.filter((n) => !self || n.session !== self);
  if (!others.length) return [];
  const line = (n) =>
    `notice ${n.id} from ${n.session ?? "-"} (${n.topic ?? "-"}, ${age(n.postedAt, now)} ago): ${n.text}`;
  if (others.length <= max) return others.map(line);
  const shown = others.slice(0, max - 1).map(line);
  return [...shown, `… and ${others.length - shown.length} more: pnpm prd notices`];
}

/** `pnpm prd status`'s part: the live notices' count, or "" when there are none. */
export function statusPart(notices) {
  if (!notices.length) return "";
  return `NOTICES: ${notices.length} (pnpm prd notices)\n`;
}
