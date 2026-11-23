#!/usr/bin/env node
// pnpm prd skeptic | prompt skeptic: the skeptic's command line (the store, the
// checker and the brief are skeptics.mjs).
//
//   record --kind ask|land|plan --verdict <v> --why "<one line>"
//          [--option <the decided option>]                  decide
//          [--question <text> [--offer <a>]… --defaults|--waits]   ask: what it judged
//          [--tip <full sha> --action force|no-review|"decline <thread>"]   land
//          [--topic <t>] [--session <s>]                    prints the id
//   [list] [--topic <t>] [--json]                           the verdicts, oldest first
//   brief ask|land|plan --evidence <file>                   (pnpm prd prompt skeptic …)
//
// The directory is CARETOOK_SKEPTIC_DIR (prd.sh sets the main checkout's
// .loops/.skeptic). The topic and session default to what prd.sh passes as
// --here-topic and --here-session.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SkepticError,
  formatRecords,
  listRecords,
  readRules,
  recordVerdict,
  skepticBrief,
} from "./skeptics.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const fail = (msg) => {
  console.error(`pnpm prd: ${msg}`);
  process.exit(1);
};

const dirOf = () =>
  process.env.CARETOOK_SKEPTIC_DIR || fail("CARETOOK_SKEPTIC_DIR isn't set (run this through pnpm prd)");

function parse(argv, valued, flags = []) {
  const opts = { offer: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const name = a.startsWith("--") ? a.slice(2) : null;
    if (name && valued.includes(name)) {
      const v = argv[++i];
      if (v == null) fail(`--${name} needs a value`);
      if (name === "offer") opts.offer.push(v);
      else opts[name] = v;
    } else if (name && flags.includes(name)) opts[name] = true;
    else if (name) fail(`unknown option ${a}`);
    else rest.push(a);
  }
  return { opts, rest };
}

function record(argv) {
  const { opts, rest } = parse(
    argv,
    [
      "kind",
      "verdict",
      "why",
      "option",
      "question",
      "offer",
      "tip",
      "action",
      "topic",
      "session",
      "here-topic",
      "here-session",
    ],
    ["defaults", "waits"],
  );
  if (rest.length) fail(`skeptic record: unexpected ${rest.join(" ")} (quote the text)`);
  if (opts.defaults && opts.waits) fail("a question takes --defaults or --waits, not both");
  const r = recordVerdict(dirOf(), {
    kind: opts.kind,
    verdict: opts.verdict,
    why: opts.why,
    topic:
      opts.topic || opts["here-topic"] || fail("skeptic record needs --topic <topic> outside a worktree"),
    session: opts.session || process.env.CARETOOK_SESSION || opts["here-session"] || null,
    option: opts.option ?? null,
    tip: opts.tip ?? null,
    action: opts.action ?? null,
    question: opts.question ?? null,
    offers: opts.offer,
    askerClass: opts.defaults ? "defaults" : opts.waits ? "waits" : null,
  });
  console.log(r.id);
}

function list(argv) {
  const { opts, rest } = parse(argv, ["topic"], ["json"]);
  if (rest.length) fail(`skeptic: unexpected ${rest.join(" ")}`);
  const records = listRecords(dirOf(), { topic: opts.topic });
  console.log(opts.json ? JSON.stringify(records, null, 2) : formatRecords(records));
}

function brief(argv) {
  const { opts, rest } = parse(argv, ["evidence"]);
  if (rest.length !== 1) fail("usage: pnpm prd prompt skeptic ask|land|plan --evidence <file>");
  if (!opts.evidence) fail("the skeptic's brief needs --evidence <file>");
  let evidence;
  try {
    evidence = readFileSync(opts.evidence, "utf8");
  } catch {
    fail(`can't read the evidence file ${opts.evidence}`);
  }
  process.stdout.write(skepticBrief(rest[0], { evidence, rules: readRules(ROOT) }));
}

const [cmd, ...argv] = process.argv.slice(2);
try {
  if (cmd === "record") record(argv);
  else if (cmd === "brief") brief(argv);
  else if (cmd === "list") list(argv);
  else list(process.argv.slice(2));
} catch (e) {
  if (e instanceof SkepticError) fail(e.message);
  throw e;
}
