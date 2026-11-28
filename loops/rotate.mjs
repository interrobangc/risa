// What rotation and `prd rm` decide from a plan and the registry. Pure;
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
//   - standingClose(facts, topic): why a standing topic's hand-over closes it
//     (`prd rm`) instead of opening a fresh session, or null to rotate as now
//     (RISA-952: fixes-ui idled 4 h holding the one lane with only an item that
//     waited on another topic). Decided by the dispatcher's own pick
//     (dispatch-pick.mjs) on the facts as they'd be with the topic closed:
//     nothing waiting; or the pick wouldn't start it even with a lane free (an
//     After not done, a hot file a running topic shares, another fixes topic
//     running, `hold`); or it has fewer than caps.fixesMin waiting and the pick
//     would start another topic in its place. A non-standing topic: null.
//
// CLI:
//   node rotate.mjs clears-hot <topic>        stdin: `backlog prd list
//                                             --json`; exit 0 when
//                                             rm.sh clears the row's hot files
//   node rotate.mjs run-through <plan file>   exit 0 when _Status_ records the
//                                             run-through landing mode
//   node rotate.mjs brief-check <file>        exit 0 when the file can lead a new
//                                             prompt; else prints why (exit 1)
//   node rotate.mjs context-hold <plan file> <session name> <pid> <n>...
//                                             prints the slices at work and exits
//                                             1 when a context rotation waits
//   node rotate.mjs standing-close <topic> <main checkout>
//                                             stdin: `backlog prd list --json`;
//                                             exit 0 and prints why when the
//                                             hand-over closes the topic; exit 1
//                                             to rotate; exit 2 when the facts
//                                             can't be read (rotate as now)
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { contextDirOf, hardLimitOf, sizeRecord } from "./context.mjs";
import { runThrough } from "./open-session.mjs";
import { defaultDir } from "./sessions.mjs";
import { sliceStates } from "./landed.mjs";
import { DEFAULT_CAPS, pick, worktreeKind } from "./dispatch-pick.mjs";

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

/**
 * Why a standing topic's hand-over closes it rather than opening a fresh session, or null to rotate.
 * Call it with no slice in flight.
 * @param {import("./dispatch-pick.mjs").PickFacts} facts the dispatcher's (dispatch.mjs's gather)
 * @param {string} topic
 * @returns {string | null}
 */
export function standingClose(facts, topic) {
  const rows = facts.rows ?? [];
  const row = rows.find((r) => r.topic === topic);
  if (!row?.flags?.includes("standing")) return null;
  const waiting = row.waiting ?? 0;
  if (!waiting) return "no waiting items";
  // The facts with this topic closed: its prd/ worktree gone, its row back to what the registry
  // says of a standing topic with no worktree. Sessions are left out (a reopen isn't a start), and
  // so is its own open question (a fresh session would carry it).
  const worktrees = (facts.worktrees ?? []).filter((w) => {
    const k = worktreeKind(w.branch);
    return !(k?.kind === "prd" && k.topic === topic);
  });
  const ours = { ...row, state: row.flags.includes("hold") ? "hold" : "planned" };
  const asks = (facts.asks ?? []).filter((a) => a.topic !== topic);
  const caps = facts.caps ?? {};
  const whyOf = (/** @type {import("./dispatch-pick.mjs").Pick} */ p) =>
    p.reasons.find((r) => r.topic === topic)?.why ?? p.why ?? "not started";
  // Alone, with a lane free: what keeps the pick from starting it, whatever else waits.
  const solo = pick({
    rows: rows.map((r) =>
      r.topic === topic
        ? ours
        : r.state === "planned" || r.state === "to-write"
          ? { ...r, state: "idle" }
          : r,
    ),
    worktrees,
    asks,
    caps: { ...caps, prds: Infinity },
  });
  if (!(solo.action === "start" && solo.topic === topic)) return `nothing it could start: ${whyOf(solo)}`;
  // Short of the fixes minimum: the pick prefers another topic, which the lane it frees would start.
  const min = caps.fixesMin ?? DEFAULT_CAPS.fixesMin;
  if (waiting >= min) return null;
  const all = pick({ rows: rows.map((r) => (r.topic === topic ? ours : r)), worktrees, asks, caps });
  if (all.action === "start" && all.topic !== topic)
    return `${waiting} waiting, under ${min}, and ${all.topic} would start in its lane`;
  return null;
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
    case "standing-close": {
      let rows;
      try {
        rows = JSON.parse(readFileSync(0, "utf8"));
      } catch (e) {
        console.log(
          `the registry didn't read: ${String(/** @type {Error} */ (e)?.message ?? e).split("\n")[0]}`,
        );
        process.exit(2);
      }
      // A rotation of any other topic stays as cheap as before: no dispatcher facts.
      const row = rows.find((/** @type {{ topic: string }} */ r) => r.topic === arg);
      if (!row?.flags?.includes("standing")) process.exit(1);
      // The dispatcher's own facts. dispatch.mjs imports this module, so it loads once this one has
      // (a top-level await here would wait on itself).
      import("./dispatch.mjs")
        .then(({ gather, pathsOf }) => standingClose(gather(pathsOf(more[0] ?? "")).facts, arg ?? ""))
        .then(
          (why) => {
            if (!why) process.exit(1);
            console.log(why);
          },
          (e) => {
            console.log(String(e?.message ?? e).split("\n")[0]);
            process.exit(2);
          },
        );
      break;
    }
    default:
      console.error(
        "usage: rotate.mjs clears-hot <topic> | run-through <plan> | brief-check <file> | context-hold <plan> <name> <pid> <n>... | standing-close <topic> <main>",
      );
      process.exit(2);
  }
}
