#!/usr/bin/env node
// prd ask | asks | answer: the asks queue's command line (the store is asks.mjs).
//
//   ask --topic <t> --question <text> [--option <a>]… [--recommend <a|n> --defaults|--waits]
//                                     file a question; one with a recommendation says whether it
//                                     takes it after RISA_ASK_DEFAULT_MIN (30) minutes unanswered
//                                     (--defaults) or waits for the user however long (--waits)
//                                     It needs --skeptic <id>: a skeptic's `ask` verdict on this
//                                     question, or a land `no` or plan `send-back` (each used once).
//                                     The dispatcher's own sessions (--session dispatch…) are exempt
//   ask --decided --skeptic <id> --topic <t> --question <text> --option <a>… --chose <a|n>
//                                     file what a skeptic decided: settled, never pushed, listed
//                                     under "decided for you"
//   ask --topic <t> --report <text>                                         file a report
//   ask --wait <id> [--timeout <s>]   print the answer once there is one (exit 0); 75 at the timeout.
//                                     It applies a due default (then says so on a second line)
//   asks [--json]                     the open asks, oldest first (a defaulting one with its
//                                     countdown), then the ones decided for you until dismissed
//   asks --short                      one line: open questions, oldest first, and counts
//   asks --done <id>                  dismiss one (a read report, a question no longer needed)
//   answer <id> <option number or text…>   (refused on a defaulted ask)
//
// The directory is RISA_ASKS_DIR (prd.sh sets the main checkout's
// .loops/.asks). `ask` takes --session <name> (default RISA_SESSION, else
// what prd.sh passes as --here-session) and the topic defaults to --here-topic.
//
// Filing one prints its id. A question then prints "Now send a PushNotification:
// …" for the asking session to push to the keeper's phone, led by its label
// (`Captain Sisko · `, session-names.mjs; none under the none flavor, without a
// session or for the dispatcher's asks; the ask keeps the bare text); a report prints no
// such line and is never pushed (the keeper wants pushes for questions only,
// and only this line). Either kind also shows a macOS notification
// (the host layer, host.mjs, when osascript is on the PATH), and runs `$RISA_ASK_NOTIFY <id> <kind>
// <topic> <text>` when that is set (a command line, run by sh), bounded by
// RISA_ASK_NOTIFY_TIMEOUT seconds (default 10); either one failing is only
// a warning. `--wait` polls every RISA_ASK_POLL seconds (default 2).
//
// RISA_CLOCK_FILE (tests, and the dispatcher's own under test): a file
// holding epoch seconds that `ask` files at and `asks` lists from, so a
// countdown or an age reads from a fixed now; `--wait` keeps the real clock.
import { readFileSync } from "node:fs";
import {
  AskError,
  DEFAULT_WAIT_MIN,
  DISPATCHER_SESSIONS,
  NEVER_DEFAULT,
  answerAsk,
  clock,
  createAsk,
  dismissAsk,
  formatAsks,
  formatAsksShort,
  getAsk,
  isDue,
  listAsks,
  settleAsk,
  shorten,
  span,
  validateAsk,
} from "./asks.mjs";
import { loadConfig, toolCmd } from "./config.mjs";
import { notify, runBounded } from "./host.mjs";
import { machineFlavor } from "./captain.mjs";
import { sessionLabel } from "./session-names.mjs";
import { defaultDir, readRecord } from "./sessions.mjs";
import { SkepticError, questionHash, useRecord } from "./skeptics.mjs";

const TIMED_OUT = 75;

const fail = (msg, code = 1) => {
  console.error(`${toolCmd.prd}: ${msg}`);
  process.exit(code);
};

/** Now, ms: RISA_CLOCK_FILE's epoch seconds when set (as dispatch.mjs reads it), else the real clock. */
const nowOf = () => {
  const file = process.env.RISA_CLOCK_FILE;
  if (file) {
    const s = Number(readFileSync(file, "utf8").trim());
    if (Number.isFinite(s)) return s * 1000;
  }
  return Date.now();
};

const dirOf = () =>
  process.env.RISA_ASKS_DIR || fail(`RISA_ASKS_DIR isn't set (run this through ${toolCmd.prd})`);

// Each option takes one value; --option repeats.
function parse(argv, valued, flags = []) {
  const opts = { option: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const name = a.startsWith("--") ? a.slice(2) : null;
    if (name && valued.includes(name)) {
      const v = argv[++i];
      if (v == null) fail(`--${name} needs a value`);
      if (name === "option") opts.option.push(v);
      else opts[name] = v;
    } else if (name && flags.includes(name)) opts[name] = true;
    else if (name) fail(`unknown option ${a}`);
    else rest.push(a);
  }
  return { opts, rest };
}

async function tell(ask) {
  const name = loadConfig().config.name;
  const project = name.replace(/^./, (c) => c.toUpperCase());
  const shown = await notify(`${project} ${ask.kind}: ${ask.topic}`, shorten(ask.text, 200));
  if (shown && shown !== "ok") console.error(`warning: the macOS notification ${shown} (ignored)`);
  const hook = process.env.RISA_ASK_NOTIFY;
  if (hook) {
    const limit = Number(process.env.RISA_ASK_NOTIFY_TIMEOUT) || 10;
    const r = await runBounded(
      "sh",
      ["-c", `${hook} "$@"`, "sh", ask.id, ask.kind, ask.topic, ask.text],
      limit,
    );
    if (r !== "ok") console.error(`warning: RISA_ASK_NOTIFY ${r} (ignored)`);
  }
}

/** A session's kind from its name, as session.sh reads it. @type {[RegExp, string][]} */
const KIND_OF_NAME = [
  [/^prd-/, "prd"],
  [/^plan-/, "plan"],
  [/^hotfix-/, "hotfix"],
  [/^backlog(-|$)/, "backlog"],
  [/^inbox$/, "inbox"],
  [/^recover$/, "recovery"],
];

/**
 * The asking session's label for the push (`Captain Sisko · `): from its record
 * name (RISA_SESSION_NAME) and record, under the machine's flavor; "" under none,
 * without a session, or for the dispatcher's own asks.
 */
function pushLabel(/** @type {string | null} */ session) {
  const name = process.env.RISA_SESSION_NAME;
  if (!name || DISPATCHER_SESSIONS.includes(session ?? "") || DISPATCHER_SESSIONS.includes(name)) return "";
  /** @type {{ kind?: string, remote?: string } | null} */
  let record = null;
  try {
    record = readRecord(defaultDir(), name);
  } catch {
    // No records folder to read: the label from the name alone.
  }
  const kind = record?.kind || KIND_OF_NAME.find(([re]) => re.test(name))?.[1];
  if (!kind) return "";
  const lab = sessionLabel({ name, kind, remote: record?.remote ?? null }, machineFlavor());
  return lab ? `${lab} · ` : "";
}

/** RISA_ASK_DEFAULT_MIN: the minutes a defaulting question waits (fractions allowed). */
const waitMinutes = () => {
  const v = process.env.RISA_ASK_DEFAULT_MIN;
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) && n >= 0 ? n : DEFAULT_WAIT_MIN;
};

async function ask(argv) {
  const { opts, rest } = parse(
    argv,
    [
      "topic",
      "question",
      "report",
      "option",
      "recommend",
      "session",
      "wait",
      "timeout",
      "here-topic",
      "here-session",
      "skeptic",
      "chose",
    ],
    ["defaults", "waits", "decided"],
  );
  if (rest.length) fail(`ask: unexpected ${rest.join(" ")} (quote the text)`);
  const dir = dirOf();
  if (opts.wait != null) return wait(dir, opts.wait, opts.timeout);
  if ((opts.question == null) === (opts.report == null))
    fail("ask needs one of --question <text> or --report <text>");
  const kind = opts.question != null ? "question" : "report";
  const waitMin = waitMinutes();
  if (kind === "report" && (opts.defaults || opts.waits))
    fail("a report neither defaults nor waits: drop --defaults/--waits");
  if (opts.defaults && opts.waits) fail("a question takes --defaults or --waits, not both");
  if (kind === "question" && opts.recommend != null && !opts.defaults && !opts.waits)
    fail(
      `a question with a recommendation must say what silence means: --defaults (it takes the recommendation after ${waitMin} min with no answer) or --waits (it waits for the user however long it takes). Never --defaults for ${NEVER_DEFAULT}: those take --waits. Nothing was filed`,
    );
  if (kind === "report" && (opts.skeptic != null || opts.decided))
    fail("a report needs no skeptic: drop --skeptic/--decided");
  if (opts.decided && (opts.skeptic == null || opts.chose == null))
    fail("ask --decided needs --skeptic <id> and --chose <option>");
  if (!opts.decided && opts.chose != null) fail("--chose goes with --decided");
  const input = {
    kind,
    topic: opts.topic || opts["here-topic"] || fail("ask needs --topic <topic> outside a worktree"),
    text: opts.question ?? opts.report,
    options: opts.option,
    recommended: opts.recommend ?? null,
    defaults: Boolean(opts.defaults) && !opts.decided,
    waitMin,
    chose: opts.chose ?? null,
  };
  // Everything that can refuse the question comes first: using the record spends it.
  const { chose } = validateAsk(input);
  const skeptic = kind === "question" ? spendVerdict(opts, input, chose) : null;
  const session = opts.session || process.env.RISA_SESSION || opts["here-session"] || null;
  const record = createAsk(dir, {
    ...input,
    session,
    skeptic,
    now: nowOf(),
  });
  console.log(record.id);
  if (opts.decided) {
    console.log(
      `Decided by the skeptic: "${record.answer}" (${skeptic.why}). Carry on with it; the user can veto it under "decided for you". Nothing to push or wait for.`,
    );
    return;
  }
  if (kind === "question") {
    const when = record.defaults
      ? ` (takes "${shorten(record.recommended, 40)}" at ${clock(record.defaultAt)} unless answered)`
      : "";
    console.log(
      `Now send a PushNotification: ${pushLabel(session)}${record.topic}: ${shorten(record.text, 120)}${when}`,
    );
    console.log(`Then wait in the background: ${toolCmd.prd} ask --wait ${record.id}`);
  } else console.log("Filed. No PushNotification for a report: only questions are pushed.");
  await tell(record);
}

/**
 * Spend the --skeptic record this question needs; returns what the ask keeps of
 * it, or null for a dispatcher's question. Only an explicit --session exempts,
 * so an inherited RISA_SESSION can't.
 */
function spendVerdict(opts, input, chose) {
  if (opts.skeptic == null) {
    if (DISPATCHER_SESSIONS.includes(opts.session)) return null;
    fail(
      `a question goes to a skeptic first. Nothing was filed. Write the question, options, recommendation and evidence to a file; run a fresh agent on Opus with the brief from ${toolCmd.prd} prompt skeptic ask --evidence <file>; record its answer with ${toolCmd.prd} skeptic record --kind ask --verdict decide|ask --why "<its line>" --question "<text>" --offer "<a>"… --defaults|--waits [--option "<chosen>"]. On ask, file this again with --skeptic <id>; on decide, file it with ${toolCmd.prd} ask --decided --skeptic <id> --chose "<a>"`,
    );
  }
  const dir =
    process.env.RISA_SKEPTIC_DIR || fail(`RISA_SKEPTIC_DIR isn't set (run this through ${toolCmd.prd})`);
  const hash = questionHash(input.text, input.options);
  const wanted = opts.decided
    ? {
        use: "decided",
        topic: input.topic,
        questionHash: hash,
        chose,
        askerClass: opts.waits ? "waits" : "defaults",
      }
    : {
        use: "ask",
        topic: input.topic,
        questionHash: hash,
        // A question with no recommendation can't default, so it counts as --waits.
        askerClass: opts.defaults ? "defaults" : "waits",
        question: input.text,
      };
  const { id, verdict, why } = useRecord(dir, opts.skeptic, wanted);
  return { id, verdict, why };
}

async function wait(dir, id, timeout) {
  const limit = timeout == null ? Infinity : Number(timeout);
  if (!(limit >= 0)) fail("--timeout takes a number of seconds");
  const poll = (Number(process.env.RISA_ASK_POLL) || 2) * 1000;
  const end = Date.now() + limit * 1000;
  for (;;) {
    let a = getAsk(dir, id) ?? fail(`no ask ${id}`);
    if (a.kind !== "question") fail(`${id} is a report: there's no answer to wait for`);
    if (isDue(a)) {
      // A waiting session applies its own default once due (a user's answer that got there first stands).
      try {
        a = settleAsk(dir, id).ask;
      } catch (e) {
        if (!(e instanceof AskError)) throw e;
      }
    }
    if (a.answeredAt) {
      console.log(a.answer);
      if (a.defaulted && a.skeptic?.verdict === "decide")
        console.log(`(decided by skeptic ${a.skeptic.id}: ${a.skeptic.why}; listed under "decided for you")`);
      else if (a.defaulted)
        console.log(
          `(defaulted: no answer in ${span(Date.parse(a.defaultAt) - Date.parse(a.askedAt))}, so it took the recommendation at ${clock(a.answeredAt)}; the user sees it under "decided for you")`,
        );
      return;
    }
    if (a.doneAt) fail(`${id} was dismissed without an answer`);
    if (Date.now() >= end) fail(`no answer to ${id} after ${limit}s`, TIMED_OUT);
    await new Promise((r) => setTimeout(r, Math.min(poll, Math.max(0, end - Date.now()))));
  }
}

function asks(argv) {
  const { opts, rest } = parse(argv, ["done"], ["json", "short"]);
  if (rest.length) fail(`asks: unexpected ${rest.join(" ")}`);
  const dir = dirOf();
  if (opts.done != null) {
    const a = dismissAsk(dir, opts.done);
    console.log(`${a.id} dismissed`);
    return;
  }
  const open = listAsks(dir);
  const now = nowOf();
  if (opts.short) console.log(formatAsksShort(open, now));
  else console.log(opts.json ? JSON.stringify(open, null, 2) : formatAsks(open, now));
}

function answer(argv) {
  const [id, ...words] = argv;
  if (!id || !words.length) fail(`usage: ${toolCmd.prd} answer <id> <option number or text>`);
  const a = answerAsk(dirOf(), id, words.join(" "));
  console.log(`${a.id} answered: ${a.answer}`);
}

const [cmd, ...argv] = process.argv.slice(2);
try {
  if (cmd === "ask") await ask(argv);
  else if (cmd === "asks") asks(argv);
  else if (cmd === "answer") answer(argv);
  else fail(`ask.mjs: unknown command ${cmd ?? ""} (ask, asks, answer)`);
} catch (e) {
  if (e instanceof AskError || e instanceof SkepticError) fail(e.message);
  throw e;
}
