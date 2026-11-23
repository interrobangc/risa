// What a CI failure files: pure, so the backlog's locked write and the tests share it.
//
// A finding is one failing test, file or job. Its key is stable across runs and
// sits in the item's first note as `[ci-key <key>]`, so an open item gets a note
// on a later find instead of a second item. A finding may carry a quarantine
// entry; an entry whose item is finished leaves on any write.
import { createHash } from "node:crypto";

import { isQuarantined, parseQuarantine } from "./lists.mjs";

/** Item statuses that count as finished: the fix is in dev, or the item was dropped. */
const FINISHED = new Set(["landed", "staging", "live", "dropped"]);
/** Verdicts cap a name at this length, so a longer one can't match its test. */
const MAX_QUARANTINE_NAME = 299;

/**
 * `item` notes that item instead of filing one; `once` skips the note on an item
 * that already carries that mark, so a rerun of one commit writes nothing new.
 * @typedef {{ key: string, title: string, prd: string, note: string, quarantine?: { file: string, name: string } | null, item?: string, once?: string }} Finding
 * @typedef {{ id: string, title: string, status: string, notes: string }} Item
 */

/** The stable key of a failing test, a whole file, or a job. */
export const findingKey = (/** @type {{ file?: string | null, name?: string | null, job?: string }} */ f) =>
  f.file
    ? createHash("sha256")
        .update(`${f.file}\0${f.name ?? ""}`)
        .digest("hex")
        .slice(0, 12)
    : `job-${f.job}`;

export const keyMark = (/** @type {string} */ key) => `[ci-key ${key}]`;

/** Whether a test can be listed: the quarantine is tab-separated and matches whole names. */
export const canQuarantine = (/** @type {string | null | undefined} */ name) =>
  !!name && name.length <= MAX_QUARANTINE_NAME && !/[\t\r\n]/.test(name);

/** The open item carrying a key, if any. */
export const openItem = (/** @type {Item[]} */ items, /** @type {string} */ key) =>
  items.find((i) => !FINISHED.has(i.status) && (i.notes ?? "").includes(keyMark(key)));

/**
 * The quarantine text without entries whose item is finished or archived. An
 * entry naming an item nobody knows stays: it's not known to be done.
 * @param {string} text
 * @param {Item[]} items
 * @param {string[]} archived
 */
export function pruneQuarantine(text, items, archived = []) {
  const status = new Map(items.map((i) => [i.id, i.status]));
  const gone = new Set(archived);
  /** @type {string[]} */ const removed = [];
  const lines = text.split("\n").filter((line) => {
    if (/^\s*(#|$)/.test(line)) return true;
    const item = line.split("\t")[2] ?? "";
    if (!gone.has(item) && !FINISHED.has(status.get(item) ?? "")) return true;
    removed.push(line);
    return false;
  });
  return { text: lines.join("\n"), removed };
}

/**
 * Apply findings to a parsed backlog and the quarantine text.
 * @param {{ items: Item[], archived?: string[] }} backlog changed in place
 * @param {string | null} quarantineText null when the repo has no list
 * @param {Finding[]} findings
 * @param {{ add: (f: Finding) => Item, note: (item: Item, text: string) => void }} write
 */
export function applyFindings(backlog, quarantineText, findings, write) {
  /** @type {{ key: string, id: string, created: boolean }[]} */ const filed = [];
  const pruned =
    quarantineText === null
      ? { text: null, removed: /** @type {string[]} */ ([]) }
      : pruneQuarantine(quarantineText, backlog.items, backlog.archived ?? []);
  let text = pruned.text;
  /** @type {string[]} */ const missed = [];
  const noted = (/** @type {Item} */ item, /** @type {Finding} */ f) =>
    !!f.once && (item.notes ?? "").includes(f.once);
  for (const f of findings) {
    if (f.item) {
      const target = backlog.items.find((i) => i.id === f.item);
      if (!target) missed.push(f.item);
      else {
        if (!noted(target, f)) write.note(target, f.note);
        filed.push({ key: f.key, id: target.id, created: false });
      }
      continue;
    }
    const open = openItem(backlog.items, f.key);
    if (open && !noted(open, f)) write.note(open, f.note);
    const item = open ?? write.add({ ...f, note: `${keyMark(f.key)} ${f.note}` });
    filed.push({ key: f.key, id: item.id, created: !open });
    if (text !== null && f.quarantine && canQuarantine(f.quarantine.name)) {
      const { file, name } = f.quarantine;
      if (!isQuarantined(parseQuarantine(text), file, name))
        text = `${text.replace(/\n*$/, "\n")}${file}\t${name}\t${item.id}\n`;
    }
  }
  return { filed, removed: pruned.removed, quarantine: text, missed };
}
