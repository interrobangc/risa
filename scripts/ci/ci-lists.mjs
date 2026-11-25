// The core's copy of the CI lists parser: the quarantine (the project's
// paths.quarantine), as filing and blame read it. The project keeps its own copy
// (lists.mjs, for its jobs and its Vitest setup); a small pure module is copied,
// not shared, so neither side imports the other. Its item ids are the project's
// backlog ids (backlog.idPrefix).
import { backlogIds } from "../loops/config.mjs";

const COMMENT = /^\s*(#|$)/;

/**
 * @typedef {{ file: string, name: string, item: string }} QuarantineEntry
 * @param {string} text
 * @param {{ prefix: string, pattern: string }} [ids] the project's backlog ids
 * @returns {QuarantineEntry[]}
 */
export function parseQuarantine(text, ids = backlogIds()) {
  const item = new RegExp(`^${ids.pattern}$`);
  return text
    .split("\n")
    .filter((line) => !COMMENT.test(line))
    .map((line) => {
      const fields = line.split("\t");
      const [file, name, id] = fields;
      if (fields.length !== 3 || !file || !name || !item.test(id ?? ""))
        throw new Error(`quarantine: a line needs <file><TAB><test name><TAB><${ids.prefix}n>: ${line}`);
      return { file, name, item: /** @type {string} */ (id) };
    });
}

/**
 * @param {QuarantineEntry[]} entries
 * @param {string} file repo-relative, or an absolute path ending in it
 * @param {string} name the test's full name
 */
export const isQuarantined = (entries, file, name) =>
  entries.some((e) => e.name === name && (file === e.file || file.endsWith(`/${e.file}`)));
