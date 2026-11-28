// The run log: one append-only JSON-lines file, .loops/.run-log.jsonl in the
// main checkout (RISA_RUN_LOG moves it; tests always do). Each line is an
// event: { time, kind, topic, …its own fields }. metrics.mjs reads it.
//
// Kinds and who writes them:
//   slice-start  new.sh, creating a slice worktree: name, branch, slice, base
//   slice-end    rm.sh, removing one: name, branch, merged
//   land-start   land.sh, once its arguments are read: branch, path
//   land-end     land.sh, on every exit: branch, path, exit, landed, seconds
//   browser      browser.sh, each check's result: check, result (pass, ended,
//                flaky, fail, timeout), seconds, retried, worktree, mode
//   codex        review.sh, Codex's verdict once per PR and head: pr, head,
//                state (clean, findings, out-of-credits), findings, carried
//
// Watching never hurts the work: a write that fails returns false (the CLI
// exits 0 and prints nothing), so no command fails or waits on it.
//
//   node run-log.mjs append [--log <file>] [--once <field,…>] <kind> [key=value | key:=<json>]…
//
// The shell side is run_log in lib.sh: --log is $RISA_RUN_LOG, else the main
// checkout's; its output and failures are dropped.
//
// key=value is a string; key:=<json> a number, boolean or null (exit:=1).
// --once skips the event when the log already holds one of its kind with the
// same values for those fields (a verdict polled again on the same head).
// A branch gives the topic when none is passed (slice/<t>/<n>, prd/<t>, …).
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { branchKinds } from "./config.mjs";
import { isMain } from "./is-main.mjs";

/** The topic of a branch: slice/<t>/<n>, prd/<t>, plan/<t> and hotfix/<t> give <t>; others none. */
export function topicOfBranch(branch) {
  return branchKinds().topicOf(branch);
}

/** The event as it's written: time and kind first, a topic from its branch when it has none. */
export function makeEvent(kind, fields = {}, now = new Date()) {
  const { time, topic, ...rest } = fields;
  return {
    time: time ?? now.toISOString(),
    kind,
    topic: topic ?? topicOfBranch(rest.branch),
    ...rest,
  };
}

const sameOn = (a, b, keys) => keys.every((k) => String(a[k] ?? "") === String(b[k] ?? ""));

/** Whether the log text already holds an event of this kind with the same values for keys. */
export function holds(text, event, keys) {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e && e.kind === event.kind && sameOn(e, event, keys)) return true;
  }
  return false;
}

/**
 * Append one event. Never throws: false when the write failed or --once found it already.
 * @param {string} file
 * @param {string} kind
 * @param {Record<string, unknown>} [fields]
 * @param {{ once?: string[], now?: Date }} [options]
 */
export function appendEvent(file, kind, fields = {}, { once = [], now } = {}) {
  try {
    if (!file || !kind) return false;
    const event = makeEvent(kind, fields, now);
    if (once.length) {
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {
        // no log yet
      }
      if (holds(text, event, once)) return false;
    }
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(event)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** key=value and key:=<json> arguments as fields; anything else is ignored. */
export function parseFields(args) {
  const fields = {};
  for (const a of args) {
    const m = /^([A-Za-z][\w-]*)(:?=)([\s\S]*)$/.exec(a);
    if (!m) continue;
    if (m[2] === "=") fields[m[1]] = m[3];
    else
      try {
        fields[m[1]] = JSON.parse(m[3]);
      } catch {
        fields[m[1]] = m[3];
      }
  }
  return fields;
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.shift() === "append") {
      let file = process.env.RISA_RUN_LOG;
      let once = [];
      while (args[0]?.startsWith("--")) {
        const flag = args.shift();
        if (flag === "--log") file = args.shift() ?? file;
        else if (flag === "--once") once = (args.shift() ?? "").split(",").filter(Boolean);
      }
      const kind = args.shift();
      appendEvent(file, kind, parseFields(args), { once });
    }
  } catch {
    // never fail the caller
  }
  process.exit(0);
}
