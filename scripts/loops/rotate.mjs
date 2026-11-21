// What rotation and `pnpm prd rm` decide from a plan and the registry. Pure;
// rotate-into.sh and rm.sh hand it the facts.
//
//   - slicesLeft(planText): the slices the plan's _Status_ table still has to
//     run (any State that isn't finished: merged, landed, done, dropped, moved,
//     split out, cut, skipped), or null when _Status_ has no slice table to read.
//   - doneFlags(rows, topic): the flags `pnpm prd rm` writes to mark TOPIC done
//     (its flags plus done, less hold), or why it writes none: no row, a
//     standing topic, or already done.
//
// CLI:
//   node rotate.mjs slices-left <plan file>   the slices left, one line, space-
//                                             separated (empty: none); exit 2
//                                             when there is no table to read
//   node rotate.mjs done-flags <topic>        stdin: `pnpm backlog prd list
//                                             --json`; prints the flags to set
//                                             (exit 0), or why not (exit 1)
//   node rotate.mjs run-through <plan file>   exit 0 when _Status_ records the
//                                             run-through landing mode
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runThrough } from "./open-session.mjs";

/** A State that means the slice has nothing left to run. */
const FINISHED = /^(merged|landed|done|dropped|moved|split out|cut|skipped)\b/i;

/** A table row's cells: "| a | b |" → ["a", "b"]. */
const cells = (/** @type {string} */ line) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** The _Status_ section's slice table as {slice, state} rows, or null when it has none. */
export function sliceStates(/** @type {string} */ planText) {
  const m = /^## Status[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(planText ?? "");
  if (!m) return null;
  const lines = m[1].split("\n").filter((l) => l.trim().startsWith("|"));
  const head = lines.findIndex((l) => /^slice$/i.test(cells(l)[0] ?? ""));
  if (head < 0) return null;
  const col = cells(lines[head]).findIndex((c) => /^state$/i.test(c));
  if (col < 0) return null;
  return lines
    .slice(head + 1)
    .map(cells)
    .filter((c) => /^\d+$/.test(c[0] ?? ""))
    .map((c) => ({ slice: c[0], state: (c[col] ?? "").replace(/[*_`✅]/g, "").trim() }));
}

/** The slices still to run, or null when the plan's _Status_ has no slice table. */
export function slicesLeft(/** @type {string} */ planText) {
  const rows = sliceStates(planText);
  if (!rows) return null;
  return rows.filter((r) => !FINISHED.test(r.state)).map((r) => r.slice);
}

/**
 * @param {{ topic: string, flags: string[] }[]} rows the registry (`prd list --json`)
 * @param {string} topic
 * @returns {{ flags: string[] } | { skip: string }}
 */
export function doneFlags(rows, topic) {
  const row = rows.find((r) => r.topic === topic);
  if (!row) return { skip: `the PRD table has no row ${topic}` };
  if (row.flags.includes("standing")) return { skip: `${topic} is standing: it never finishes` };
  if (row.flags.includes("done")) return { skip: `${topic} is already done` };
  return { flags: [...row.flags.filter((f) => f !== "hold"), "done"] };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, arg] = process.argv.slice(2);
  const read = (/** @type {string} */ f) => {
    try {
      return readFileSync(f, "utf8");
    } catch {
      return "";
    }
  };
  switch (cmd) {
    case "slices-left": {
      const left = slicesLeft(read(arg ?? ""));
      if (!left) process.exit(2);
      console.log(left.join(" "));
      break;
    }
    case "done-flags": {
      const d = doneFlags(JSON.parse(readFileSync(0, "utf8")), arg ?? "");
      if ("skip" in d) {
        console.log(d.skip);
        process.exit(1);
      }
      console.log(d.flags.join(","));
      break;
    }
    case "run-through":
      process.exit(runThrough(read(arg ?? "")) ? 0 : 1);
      break;
    default:
      console.error("usage: rotate.mjs slices-left <plan> | done-flags <topic> | run-through <plan>");
      process.exit(2);
  }
}
