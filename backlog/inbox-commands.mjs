// The inbox commands on an inbox store's file (backlog/inbox-store.mjs): `add`, `move`,
// `edit`, `remove` and the list, as `backlog inbox …` runs them for a project with an
// `inbox` group and as the store CLI runs them with `--project`. Same arguments, same
// refusals and the same look-alike stop (exit 3 at the caller) as the trunk writer's;
// each write is one store commit, its line naming it: `on <repo> <file> as <sha>`.
// This runs no git: it asks the store it is given.
import * as fmt from "./format.mjs";
import * as edits from "./inbox-edit.mjs";
import { LookAlikeStop } from "./inbox-edit.mjs";
import { toolCmd } from "../loops/config.mjs";

/**
 * @typedef {{ id: string, status: string, prd: string, title: string, archived?: boolean }} PoolItem
 * @typedef {{
 *   store: ReturnType<typeof import("./inbox-store.mjs").storeFor>,
 *   file: string,
 *   by: string,
 *   pool: () => PoolItem[],
 * }} StoreAt the store, the project's file there, who writes, and the backlog's items
 *   to compare a new line with (none when the backlog isn't on this machine)
 */

/** The bullets of `text` not filed yet, as pool items. @param {string | null} text */
const unfiledPool = (text) =>
  text === null
    ? []
    : fmt.newInboxEntries(text).map((e) => ({ id: "inbox", status: "unfiled", prd: "", title: e.text }));

/**
 * One inbox command on the store's file; the lines to print. A refusal throws a
 * BacklogError, a look-alike a LookAlikeStop, a store that can't be written a StoreError.
 * @param {StoreAt} at
 * @param {string | undefined} sub add, move, edit, remove, or undefined for the list
 * @param {string[]} args
 * @param {Record<string, string | boolean | undefined>} opts
 * @returns {string[]}
 */
export function storeInbox(at, sub, args, opts) {
  const { store, file } = at;
  const where = (/** @type {string} */ sha) => `on ${store.repo} ${file} as ${sha.slice(0, 7)}`;
  const write = (/** @type {string} */ subject, /** @type {(t: string | null) => string | null} */ edit) =>
    store.write(file, edit, `${subject}\n\nBy: ${at.by}\n`);
  /** The one unfiled bullet `words` find in `t`; a filed one throws `filed(entry, id)`. */
  const findUnfiled = (
    /** @type {string | null} */ t,
    /** @type {string} */ words,
    /** @type {(e: import("./format.mjs").InboxEntry, id: string) => Error} */ filed,
  ) => {
    const hits = edits.findEntries(t ?? "", words);
    if (!hits.length) throw new fmt.BacklogError(`no inbox line in ${store.repo} ${file} has "${words}"`);
    if (hits.length > 1)
      throw new fmt.BacklogError(
        `"${words}" is in ${hits.length} inbox lines (${hits.map((e) => `"${fmt.titleFromBullet(e.text)}"`).join(", ")}): give more of its words`,
      );
    const e = hits[0];
    if (e.id) throw filed(e, e.id);
    return e;
  };
  const filedAs = (/** @type {{ text: string }} */ e, /** @type {string} */ id, /** @type {string} */ then) =>
    new fmt.BacklogError(`"${fmt.titleFromBullet(e.text)}" is filed as ${id}: ${then}`);

  switch (sub) {
    case undefined: {
      const entries = fmt.newInboxEntries(store.read(file) ?? "");
      return [
        ...entries.map((e) => `${e.type.padEnd(8)}  ${e.text}`),
        entries.length
          ? `${entries.length} not filed yet (${toolCmd.backlog} ingest)`
          : "nothing new in the inbox",
      ];
    }
    case "add": {
      const [type, ...words] = args;
      const text = words.join(" ");
      if (!type || !text.trim())
        throw new fmt.BacklogError("usage: inbox add <type> <text…> [--details TEXT]");
      fmt.checkType(type);
      const details = typeof opts.details === "string" ? opts.details : "";
      edits.addEntry("", type, text, details); // a bad line fails here, before any network
      /** @type {PoolItem[] | null} */
      let items = null;
      let after = "";
      const sha = write(`inbox: add (${type}) ${fmt.titleFromBullet(text)}`, (t) => {
        if (!opts.anyway) {
          items ??= at.pool();
          const matches = fmt.similarItems(text, [...items, ...unfiledPool(t)]);
          if (matches.length) throw new LookAlikeStop(matches);
        }
        after = edits.addEntry(t ?? "# Inbox\n", type, text, details);
        return after;
      });
      if (!sha) return ["nothing changed"];
      return [`added under ${edits.headingFor(after, type)} ${where(sha)}: ${fmt.titleFromBullet(text)}`];
    }
    case "move": {
      const type = args.at(-1);
      const words = args.slice(0, -1).join(" ");
      if (!type || !words.trim()) throw new fmt.BacklogError("usage: inbox move <words…> <type>");
      fmt.checkType(type);
      /** @type {{ text: string, after: string } | null} */
      let moved = null;
      const sha = write(`inbox: move "${fmt.titleFromBullet(words)}" to ${type}`, (t) => {
        moved = null;
        const e = findUnfiled(t, words, (x, id) =>
          filedAs(x, id, `change the item instead: ${toolCmd.backlog} set ${id} type=${type}`),
        );
        if (e.type === type) return t;
        const after = edits.moveEntry(/** @type {string} */ (t), e.line, type);
        moved = { text: e.text, after };
        return after;
      });
      if (!sha || !moved) return [`already under ${type}: nothing to move`];
      const { text, after } = /** @type {{ text: string, after: string }} */ (moved);
      return [`moved to ${edits.headingFor(after, type)} ${where(sha)}: ${fmt.titleFromBullet(text)}`];
    }
    case "edit": {
      const words = args.join(" ");
      const to = typeof opts.to === "string" ? opts.to : undefined;
      const details = typeof opts.details === "string" ? opts.details : undefined;
      if (!words.trim() || (to === undefined && details === undefined))
        throw new fmt.BacklogError("usage: inbox edit <words…> --to TEXT [--details TEXT]");
      if (to !== undefined) edits.addEntry("", "bug", to); // a bad line fails here, before any network
      /** @type {{ was: string, now: string } | null} */
      let changed = null;
      const sha = write(`inbox: edit "${fmt.titleFromBullet(words)}"`, (t) => {
        changed = null;
        const e = findUnfiled(t, words, (x, id) =>
          filedAs(x, id, "change the item instead, in the backlog session"),
        );
        const out = edits.rewordEntry(/** @type {string} */ (t), e.line, to ?? e.text, details);
        if (out !== t)
          changed = { was: e.text, now: to === undefined ? e.text : to.replace(/\s+/g, " ").trim() };
        return out;
      });
      if (!sha || !changed) return ["the line already says that: nothing to change"];
      const { was, now } = /** @type {{ was: string, now: string }} */ (changed);
      return [
        `edited ${where(sha)}: ${was === now ? fmt.titleFromBullet(now) : `"${fmt.titleFromBullet(was)}" is now "${fmt.titleFromBullet(now)}"`}`,
      ];
    }
    case "remove": {
      const words = args.join(" ");
      if (!words.trim()) throw new fmt.BacklogError("usage: inbox remove <words…>");
      /** @type {string | null} */
      let removed = null;
      const sha = write(`inbox: remove "${fmt.titleFromBullet(words)}"`, (t) => {
        const e = findUnfiled(t, words, (x, id) =>
          filedAs(x, id, "drop the item instead, in the backlog session"),
        );
        removed = e.text;
        return edits.removeEntry(/** @type {string} */ (t), e.line);
      });
      if (!sha || removed === null) return ["nothing changed"];
      return [`removed ${where(sha)}: ${fmt.titleFromBullet(removed)}`];
    }
    default:
      throw new fmt.BacklogError(`unknown inbox command "${sub}" (add, move, edit, remove)`);
  }
}
