// What rotation and `pnpm prd rm` decide from a plan and the registry. Pure;
// rotate-into.sh and rm.sh hand it the facts.
//
//   - slicesLeft(planText): the slices the plan's _Status_ table still has to
//     run (any State that isn't finished: merged, landed, done, dropped, moved,
//     split out, cut, skipped), or null when _Status_ has no slice table to read.
//   - doneFlags(rows, topic): the flags `pnpm prd rm` writes to mark TOPIC done
//     (its flags plus done, less hold), or why it writes none: no row, a
//     standing topic, or already done.
//   - clearsHot(rows, topic): whether removing TOPIC's worktree clears its row's
//     hot files: a standing topic (a fixes topic's wave sets them) that has some.
//   - contextHold({ planText, slices, record, hard }): the slices a mid-wave
//     rotation for context would cut off at work (a worktree whose _Status_ row
//     isn't handed off or finished; no row or no table: at work), or [] once the
//     session's size record is past the hard limit. Each one cut off comes back
//     as a --continue agent that reloads its base and reruns its check (B-877:
//     a 166k mid-wave rotation ended five slices waiting on their hand-off checks).
//
// CLI:
//   node rotate.mjs slices-left <plan file>   the slices left, one line, space-
//                                             separated (empty: none); exit 2
//                                             when there is no table to read
//   node rotate.mjs done-flags <topic>        stdin: `pnpm backlog prd list
//                                             --json`; prints the flags to set
//                                             (exit 0), or why not (exit 1)
//   node rotate.mjs clears-hot <topic>        stdin: as done-flags; exit 0 when
//                                             rm.sh clears the row's hot files
//   node rotate.mjs run-through <plan file>   exit 0 when _Status_ records the
//                                             run-through landing mode
//   node rotate.mjs brief-check <file>        exit 0 when the file can lead a new
//                                             prompt; else prints why (exit 1)
//   node rotate.mjs context-hold <plan file> <size record> <pid> <n>...
//                                             prints the slices at work and exits
//                                             1 when a context rotation waits
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { hardLimitOf } from "./context.mjs";
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

/** The most a brief may be: it travels as one argument, and a failed start would come after the old session ended. */
export const BRIEF_MAX_BYTES = 64 * 1024;

/** Why this brief file can't lead a prompt, or null when it can. */
export function briefProblem(/** @type {string} */ file) {
  let text;
  try {
    text = readFileSync(file);
  } catch {
    return `can't read the brief ${file}`;
  }
  if (text.length > BRIEF_MAX_BYTES) return `the brief ${file} is over ${BRIEF_MAX_BYTES / 1024} KB`;
  if (!text.toString("utf8").trim()) return `the brief ${file} is empty`;
  return null;
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

/**
 * @param {{ topic: string, flags: string[], hot?: string[] }[]} rows the registry (`prd list --json`)
 * @param {string} topic
 */
export function clearsHot(rows, topic) {
  const row = rows.find((r) => r.topic === topic);
  return Boolean(row?.flags.includes("standing") && row.hot?.length);
}

/** A State whose agent is done with it: handed off, or finished. */
const DONE_WITH = /^(handed off|merged|landed|done|dropped|moved|split out|cut|skipped)\b/i;

/**
 * The slices a mid-wave rotation for context would cut off at work, or [] past the hard limit.
 * @param {{ planText: string, slices: string[], record?: { size?: number, hardOverAt?: string } | null, hard?: number }} input
 *   `slices`: the topic's slice worktrees' numbers; `record`: the session's size record (context.mjs), when live
 */
export function contextHold({ planText, slices, record = null, hard = hardLimitOf() }) {
  if (record && (record.hardOverAt || (typeof record.size === "number" && record.size > hard))) return [];
  const states = new Map((sliceStates(planText) ?? []).map((r) => [r.slice, r.state]));
  return slices.filter((n) => !DONE_WITH.test(states.get(n) ?? ""));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, arg, ...more] = process.argv.slice(2);
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
    case "clears-hot":
      process.exit(clearsHot(JSON.parse(readFileSync(0, "utf8")), arg ?? "") ? 0 : 1);
      break;
    case "run-through":
      process.exit(runThrough(read(arg ?? "")) ? 0 : 1);
      break;
    case "brief-check": {
      const why = briefProblem(arg ?? "");
      if (why) {
        console.log(why);
        process.exit(1);
      }
      break;
    }
    case "context-hold": {
      const [recordFile, pid, ...slices] = more;
      let record = null;
      try {
        const r = JSON.parse(read(recordFile ?? ""));
        record = r?.pid === Number(pid) ? r : null;
      } catch {
        /* no record: its size is unknown */
      }
      const held = contextHold({ planText: read(arg ?? ""), slices, record });
      if (held.length) {
        console.log(held.join(" "));
        process.exit(1);
      }
      break;
    }
    default:
      console.error(
        "usage: rotate.mjs slices-left <plan> | done-flags <topic> | clears-hot <topic> | run-through <plan> | brief-check <file> | context-hold <plan> <record> <pid> <n>...",
      );
      process.exit(2);
  }
}
