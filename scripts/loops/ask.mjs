#!/usr/bin/env node
// pnpm prd ask | asks | answer: the asks queue's command line (the store is asks.mjs).
//
//   ask --topic <t> --question <text> [--option <a>]… [--recommend <a|n>]   file a question
//   ask --topic <t> --report <text>                                         file a report
//   ask --wait <id> [--timeout <s>]   print the answer once there is one (exit 0); 75 at the timeout
//   asks [--json]                     the open asks, oldest first
//   asks --done <id>                  dismiss one (a read report, a question no longer needed)
//   answer <id> <option number or text…>
//
// The directory is CARETOOK_ASKS_DIR (prd.sh sets the main checkout's
// .loops/.asks). `ask` takes --session <name> (default CARETOOK_SESSION, else
// what prd.sh passes as --here-session) and the topic defaults to --here-topic.
//
// Filing one prints its id, then "Now send a PushNotification: …" for the asking
// session to push to the keeper's phone. It also shows a macOS notification
// when osascript is on the PATH, and runs `$CARETOOK_ASK_NOTIFY <id> <kind>
// <topic> <text>` when that is set (a command line, run by sh), bounded by
// CARETOOK_ASK_NOTIFY_TIMEOUT seconds (default 10); either one failing is only
// a warning. `--wait` polls every CARETOOK_ASK_POLL seconds (default 2).
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import {
  AskError,
  answerAsk,
  createAsk,
  dismissAsk,
  formatAsks,
  getAsk,
  listAsks,
  shorten,
} from "./asks.mjs";

const TIMED_OUT = 75;

const fail = (msg, code = 1) => {
  console.error(`pnpm prd: ${msg}`);
  process.exit(code);
};

const dirOf = () =>
  process.env.CARETOOK_ASKS_DIR || fail("CARETOOK_ASKS_DIR isn't set (run this through pnpm prd)");

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

const onPath = (cmd) => {
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    if (!d) continue;
    try {
      accessSync(join(d, cmd), constants.X_OK);
      return join(d, cmd);
    } catch {
      /* not here */
    }
  }
  return null;
};

// run(cmd, args, seconds) → "ok", "exit <n>" or "timed out": in its own process
// group, so a hook that hangs (and anything it started) is killed at the limit.
const run = (cmd, args, seconds) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: ["ignore", "ignore", "inherit"] });
    } catch (e) {
      resolve(`failed: ${e.message}`);
      return;
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* gone */
      }
      resolve("timed out");
    }, seconds * 1000);
    child.once("error", (e) => {
      clearTimeout(timer);
      resolve(`failed: ${e.message}`);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(code === 0 ? "ok" : `exit ${code ?? signal}`);
    });
  });

async function tell(ask) {
  const osascript = onPath("osascript");
  if (osascript) {
    const title = `Caretook ${ask.kind}: ${ask.topic}`;
    const r = await run(
      osascript,
      [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        title,
        shorten(ask.text, 200),
      ],
      5,
    );
    if (r !== "ok") console.error(`warning: the macOS notification ${r} (ignored)`);
  }
  const hook = process.env.CARETOOK_ASK_NOTIFY;
  if (hook) {
    const limit = Number(process.env.CARETOOK_ASK_NOTIFY_TIMEOUT) || 10;
    const r = await run("sh", ["-c", `${hook} "$@"`, "sh", ask.id, ask.kind, ask.topic, ask.text], limit);
    if (r !== "ok") console.error(`warning: CARETOOK_ASK_NOTIFY ${r} (ignored)`);
  }
}

async function ask(argv) {
  const { opts, rest } = parse(argv, [
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
  ]);
  if (rest.length) fail(`ask: unexpected ${rest.join(" ")} (quote the text)`);
  const dir = dirOf();
  if (opts.wait != null) return wait(dir, opts.wait, opts.timeout);
  if ((opts.question == null) === (opts.report == null))
    fail("ask needs one of --question <text> or --report <text>");
  const kind = opts.question != null ? "question" : "report";
  const record = createAsk(dir, {
    kind,
    topic: opts.topic || opts["here-topic"] || fail("ask needs --topic <topic> outside a worktree"),
    text: opts.question ?? opts.report,
    session: opts.session || process.env.CARETOOK_SESSION || opts["here-session"] || null,
    options: opts.option,
    recommended: opts.recommend ?? null,
  });
  console.log(record.id);
  console.log(`Now send a PushNotification: ${record.topic}: ${shorten(record.text, 120)}`);
  if (kind === "question") console.log(`Then wait in the background: pnpm prd ask --wait ${record.id}`);
  await tell(record);
}

async function wait(dir, id, timeout) {
  const limit = timeout == null ? Infinity : Number(timeout);
  if (!(limit >= 0)) fail("--timeout takes a number of seconds");
  const poll = (Number(process.env.CARETOOK_ASK_POLL) || 2) * 1000;
  const end = Date.now() + limit * 1000;
  for (;;) {
    const a = getAsk(dir, id) ?? fail(`no ask ${id}`);
    if (a.kind !== "question") fail(`${id} is a report: there's no answer to wait for`);
    if (a.answeredAt) {
      console.log(a.answer);
      return;
    }
    if (a.doneAt) fail(`${id} was dismissed without an answer`);
    if (Date.now() >= end) fail(`no answer to ${id} after ${limit}s`, TIMED_OUT);
    await new Promise((r) => setTimeout(r, Math.min(poll, Math.max(0, end - Date.now()))));
  }
}

function asks(argv) {
  const { opts, rest } = parse(argv, ["done"], ["json"]);
  if (rest.length) fail(`asks: unexpected ${rest.join(" ")}`);
  const dir = dirOf();
  if (opts.done != null) {
    const a = dismissAsk(dir, opts.done);
    console.log(`${a.id} dismissed`);
    return;
  }
  const open = listAsks(dir);
  console.log(opts.json ? JSON.stringify(open, null, 2) : formatAsks(open));
}

function answer(argv) {
  const [id, ...words] = argv;
  if (!id || !words.length) fail("usage: pnpm prd answer <id> <option number or text>");
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
  if (e instanceof AskError) fail(e.message);
  throw e;
}
