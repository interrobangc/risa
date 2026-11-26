// What rotation and `pnpm prd rm` decide from a plan and the registry. Pure;
// rotate-into.sh and rm.sh hand it the facts.
//
//   - slicesLeft and doneFlags: landed.mjs's, re-exported.
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
//   node rotate.mjs clears-hot <topic>        stdin: `pnpm backlog prd list
//                                             --json`; exit 0 when
//                                             rm.sh clears the row's hot files
//   node rotate.mjs run-through <plan file>   exit 0 when _Status_ records the
//                                             run-through landing mode
//   node rotate.mjs brief-check <file>        exit 0 when the file can lead a new
//                                             prompt; else prints why (exit 1)
//   node rotate.mjs context-hold <plan file> <session name> <pid> <n>...
//                                             prints the slices at work and exits
//                                             1 when a context rotation waits
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { contextDirOf, hardLimitOf, sizeRecord } from "./context.mjs";
import { runThrough } from "./open-session.mjs";
import { defaultDir } from "./sessions.mjs";
import { sliceStates } from "./landed.mjs";

// The plan and registry reads rm.sh and land.sh share live in landed.mjs (B-431).
export { doneFlags, sliceStates, slicesLeft } from "./landed.mjs";

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
      const [name, pid, ...slices] = more;
      let record = null;
      try {
        record = sizeRecord(contextDirOf(defaultDir()), name ?? "", Number(pid));
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
        "usage: rotate.mjs clears-hot <topic> | run-through <plan> | brief-check <file> | context-hold <plan> <name> <pid> <n>...",
      );
      process.exit(2);
  }
}
