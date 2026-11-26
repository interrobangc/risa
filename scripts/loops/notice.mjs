#!/usr/bin/env node
// prd notice | notices: the notice board's command line (the store is notices.mjs).
//
//   notice "<text>" [--for <minutes>] [--topic <t>]   post one; prints its id (60 minutes, 24 hours at most)
//   notices [--json]                                 the live ones, oldest first
//   notices --done <id>                              withdraw one
//   gate [--self <session>]   (prd.sh, before check, sync, slice, browser, pr, ready and land)
//                             other sessions' live notices, five lines at most
//   status                    (ls.sh) every live notice under a heading
//
// The directory is RISA_NOTICES_DIR (prd.sh sets the main checkout's
// .loops/.notices). `notice` takes --session <name> (default RISA_SESSION,
// else what prd.sh passes as --here-session) and the topic defaults to
// --here-topic. `gate` and `status` never fail: whatever goes wrong (an
// unreadable directory, a broken file), they print nothing and exit 0, so they
// can't change the exit code of the command they decorate.
import { toolCmd } from "./config.mjs";
import { pathToFileURL } from "node:url";
import {
  NoticeError,
  createNotice,
  formatNotices,
  gateLines,
  listNotices,
  statusPart,
  withdrawNotice,
} from "./notices.mjs";

const fail = (msg, code = 1) => {
  console.error(`${toolCmd.prd}: ${msg}`);
  process.exit(code);
};

const dirOf = () =>
  process.env.RISA_NOTICES_DIR || fail(`RISA_NOTICES_DIR isn't set (run this through ${toolCmd.prd})`);

function parse(argv, valued, flags = []) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const name = a.startsWith("--") ? a.slice(2) : null;
    if (name && valued.includes(name)) {
      const v = argv[++i];
      if (v == null) fail(`--${name} needs a value`);
      opts[name] = v;
    } else if (name && flags.includes(name)) opts[name] = true;
    else if (name) fail(`unknown option ${a}`);
    else rest.push(a);
  }
  return { opts, rest };
}

function notice(argv) {
  const { opts, rest } = parse(argv, ["for", "topic", "session", "here-topic", "here-session"]);
  if (rest.length !== 1)
    fail(`usage: ${toolCmd.prd} notice "<text>" [--for <minutes>] [--topic <t>] (quote the text)`);
  if (opts.for != null && !/^\d+(\.\d+)?$/.test(opts.for)) fail("--for takes a number of minutes");
  const n = createNotice(dirOf(), {
    text: rest[0],
    session: opts.session || process.env.RISA_SESSION || opts["here-session"] || null,
    topic: opts.topic || opts["here-topic"] || null,
    ...(opts.for != null ? { minutes: Number(opts.for) } : {}),
  });
  console.log(n.id);
}

function notices(argv) {
  const { opts, rest } = parse(argv, ["done"], ["json"]);
  if (rest.length) fail(`notices: unexpected ${rest.join(" ")}`);
  const dir = dirOf();
  if (opts.done != null) {
    const n = withdrawNotice(dir, opts.done);
    console.log(`${n.id} withdrawn`);
    return;
  }
  const live = listNotices(dir);
  console.log(opts.json ? JSON.stringify(live, null, 2) : formatNotices(live));
}

// Never fails: prints what it can, else nothing.
function quietly(fn) {
  try {
    const dir = process.env.RISA_NOTICES_DIR;
    if (!dir) return;
    const out = fn(listNotices(dir));
    if (out) process.stdout.write(out);
  } catch {
    /* advisory only */
  }
}

const main = (cmd, argv) => {
  if (cmd === "notice") return notice(argv);
  if (cmd === "notices") return notices(argv);
  if (cmd === "gate") {
    const i = argv.indexOf("--self");
    const self = i >= 0 ? argv[i + 1] || null : null;
    return quietly((live) =>
      gateLines(live, self)
        .map((l) => l + "\n")
        .join(""),
    );
  }
  if (cmd === "status") return quietly((live) => statusPart(live));
  fail(`notice.mjs: unknown command ${cmd ?? ""} (notice, notices)`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...argv] = process.argv.slice(2);
  try {
    main(cmd, argv);
  } catch (e) {
    if (cmd === "gate" || cmd === "status") process.exit(0);
    if (e instanceof NoticeError) fail(e.message);
    throw e;
  }
}
