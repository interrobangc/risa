#!/usr/bin/env node
// The cost record (RISA-560): tokens by model for each PRD's planning, its
// orchestration and each slice, from Claude Code's transcripts and the ledger.
//
//   node loops/cost.mjs report [<topic>] [--json]   the table (no topic: one total line per topic)
//   node loops/cost.mjs ledger <topic>              merge what's on disk into the ledger
//
// A topic's transcripts are in the projects folders of its worktrees
// (<main>/.loops/<topic>, plan-<topic>, <topic>-<n>, in Claude Code's encoding:
// every character but a letter or digit as `-`), each session's .jsonl and the
// subagents/agent-*.jsonl beside it with its meta.json. The projects folder is
// RISA_CLAUDE_PROJECTS, else $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects
// (host.mjs's claudeProjects). The ledger, .loops/.cost/<topic>.json, keeps the rows
// (by message id: model, the four counts, the line) after the transcripts are gone.
// Each assistant message counts once, by its id, across every file and the ledger:
// the last line of a streamed message wins, a --continue copy adds nothing.
//
// The pure parts (parseTranscript, attribute, mergeRows, summarise) take what the
// CLI read; the CLI only reads, and writes only the ledger (a temp file, then a
// rename). The main checkout is RISA_MAIN, else the first worktree of this repo.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { branchKinds } from "./config.mjs";
import { claudeProjects, projectFolder } from "./host.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The four counts, in the order the table shows them. */
export const COUNTS = /** @type {const} */ (["input", "output", "cacheRead", "cacheWrite"]);
const COUNT_NAMES = { input: "input", output: "output", cacheRead: "cache read", cacheWrite: "cache write" };

/**
 * @typedef {{ input: number, output: number, cacheRead: number, cacheWrite: number }} Counts
 * @typedef {Counts & { id: string, model: string, file?: string, worktree?: string,
 *   subagent?: boolean, description?: string, prompt?: string, line?: string }} Row
 */

const num = (/** @type {unknown} */ v) => (typeof v === "number" && v > 0 ? v : 0);

/** The text of a user message's content: a string, or its text blocks joined. */
const textOf = (/** @type {unknown} */ content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n")
      : "";

/**
 * One transcript's TEXT (JSONL) as rows, one per assistant message id (the last
 * line of a message wins), each with FILE, WORKTREE (its worktree's name) and,
 * for a subagent (META, its meta.json), the meta's description. Also the first
 * user prompt (on each row too), the first git branch seen, and how many lines
 * weren't JSON. Claude Code's own <synthetic> replies aren't billed and are left out.
 * @param {string} text
 * @param {{ file?: string, worktree?: string, meta?: { description?: string } | null }} [opts]
 */
export function parseTranscript(text, { file = "", worktree = "", meta = null } = {}) {
  /** @type {Map<string, Row>} */
  const byId = new Map();
  let malformed = 0;
  let prompt = "";
  let branch = "";
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      malformed++;
      return;
    }
    if (!entry || typeof entry !== "object") {
      malformed++;
      return;
    }
    if (!branch && typeof entry.gitBranch === "string") branch = entry.gitBranch;
    if (!prompt && entry.type === "user") prompt = textOf(entry.message?.content);
    const msg = entry.message;
    if (entry.type !== "assistant" || !msg?.usage || typeof msg.model !== "string") return;
    if (msg.model.startsWith("<")) return;
    const id = String(msg.id ?? entry.requestId ?? `${file}:${i + 1}`);
    const u = msg.usage;
    byId.delete(id); // re-inserted: the order is each message's last line
    byId.set(id, {
      id,
      model: msg.model,
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
      file,
      worktree,
      subagent: !!meta,
      ...(meta?.description ? { description: meta.description } : {}),
    });
  });
  const rows = [...byId.values()].map((r) => ({ ...r, prompt }));
  return { rows, malformed, prompt, branch };
}

const escape = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * ROWS with the line of TOPIC each belongs to: a plan-<topic> worktree's are
 * "planning"; a subagent's go to the slice its description names (`slice 2`),
 * else the slice worktree its first prompt names (.loops/<topic>-<n>); a slice
 * worktree's own session to its slice; the rest are "orchestration". A row that
 * already has a line (the ledger's) keeps it. Each row out is the ledger's
 * shape: id, model, the four counts, line.
 * @param {Row[]} rows
 * @param {string} topic
 */
export function attribute(rows, topic) {
  const named = new RegExp(`\\.loops/${escape(topic)}-(\\d+)(?![\\w.-])`);
  const sliceDir = new RegExp(`^${escape(topic)}-(\\d+)$`);
  return rows.map((r) => {
    let line = r.line;
    if (!line) {
      const n =
        r.worktree === `plan-${topic}`
          ? null
          : r.subagent
            ? (/slice\s*(\d+)/i.exec(r.description ?? "")?.[1] ?? named.exec(r.prompt ?? "")?.[1])
            : sliceDir.exec(r.worktree ?? "")?.[1];
      line = r.worktree === `plan-${topic}` ? "planning" : n ? `slice ${Number(n)}` : "orchestration";
    }
    const { id, model, input, output, cacheRead, cacheWrite } = r;
    return { id, model, input, output, cacheRead, cacheWrite, line };
  });
}

/**
 * One row per message id from LISTS in order: a later list's (or a later row's)
 * wins.
 * @param {...Row[]} lists
 */
export function mergeRows(...lists) {
  /** @type {Map<string, Row>} */
  const byId = new Map();
  for (const list of lists) for (const r of list ?? []) byId.set(r.id, r);
  return [...byId.values()];
}

const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const lineOrder = (/** @type {string} */ line) =>
  line === "planning" ? -2 : line === "orchestration" ? -1 : Number(/\d+/.exec(line)?.[0] ?? 1e9);

/**
 * ROWS (attributed) summed: each line (planning, orchestration, the slices in
 * order) and the total, as tokens by model and the number of messages.
 * @param {Row[]} rows
 */
export function summarise(rows) {
  /** @type {Map<string, { line: string, messages: number, models: Record<string, Counts> }>} */
  const lines = new Map();
  const total = { messages: 0, models: /** @type {Record<string, Counts>} */ ({}) };
  for (const r of rows) {
    const name = r.line ?? "orchestration";
    let l = lines.get(name);
    if (!l) lines.set(name, (l = { line: name, messages: 0, models: {} }));
    for (const into of [l, total]) {
      into.messages++;
      const m = (into.models[r.model] ??= zero());
      for (const k of COUNTS) m[k] += num(r[k]);
    }
  }
  return {
    lines: [...lines.values()].sort((a, b) => lineOrder(a.line) - lineOrder(b.line)),
    total,
  };
}

/** SUMMARY as a table: a row per line and model, then the total's. */
export function formatSummary(/** @type {string} */ topic, /** @type {ReturnType<typeof summarise>} */ s) {
  const rows = [["", "model", ...COUNTS.map((k) => COUNT_NAMES[k])]];
  for (const l of [...s.lines, { line: "total", ...s.total }])
    for (const [model, c] of Object.entries(l.models).sort())
      rows.push([l.line, model, ...COUNTS.map((k) => c[k].toLocaleString("en-US"))]);
  if (rows.length === 1) return `${topic}: no transcripts or ledger rows`;
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const body = rows.map((r) =>
    r.map((cell, i) => (i < 2 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join("  "),
  );
  return [`${topic} (${s.total.messages} messages)`, ...body.map((l) => `  ${l.trimEnd()}`)].join("\n");
}

/** A topic's total as one line. */
export function formatTotal(/** @type {string} */ topic, /** @type {ReturnType<typeof summarise>} */ s) {
  const models = Object.entries(s.total.models)
    .sort()
    .map(([m, c]) => `${m} ${COUNTS.map((k) => `${COUNT_NAMES[k]} ${c[k]}`).join(", ")}`);
  return `${topic}: ${s.total.messages} messages${models.length ? `; ${models.join("; ")}` : ""}`;
}

// --- reading what's on disk ---

const readJson = (/** @type {string} */ path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
const list = (/** @type {string} */ dir) => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};
const isDir = (/** @type {string} */ p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * A projects FOLDER's transcripts for the worktree named WORKTREE, parsed: each
 * session's .jsonl, and each subagents/agent-*.jsonl with its meta.json.
 */
export function readFolder(/** @type {string} */ folder, /** @type {string} */ worktree) {
  const parsed = [];
  for (const f of list(folder)) {
    const path = join(folder, f);
    if (f.endsWith(".jsonl"))
      parsed.push(parseTranscript(readFileSync(path, "utf8"), { file: path, worktree }));
    const subs = join(folder, f, "subagents");
    if (!isDir(subs)) continue;
    for (const s of list(subs).filter((n) => /^agent-.*\.jsonl$/.test(n))) {
      const meta = readJson(join(subs, s.replace(/\.jsonl$/, ".meta.json"))) ?? {};
      parsed.push(
        parseTranscript(readFileSync(join(subs, s), "utf8"), { file: join(subs, s), worktree, meta }),
      );
    }
  }
  return parsed;
}

/** The first git branch a FOLDER's session transcripts name, else "". */
function branchOf(/** @type {string} */ folder) {
  for (const f of list(folder).filter((n) => n.endsWith(".jsonl"))) {
    const b = parseTranscript(readFileSync(join(folder, f), "utf8")).branch;
    if (b) return b;
  }
  return "";
}

const loopsPrefix = (/** @type {string} */ main) => `${projectFolder(join(main, ".loops"))}-`;

/**
 * The projects folders of TOPIC's worktrees under PROJECTS, each with its
 * worktree's name. A folder whose sessions' branch says it is another kind (a
 * <topic>-<n> folder that is topic <topic>-<n>'s own, say) is left out.
 */
export function topicFolders(
  /** @type {string} */ main,
  /** @type {string} */ topic,
  /** @type {string} */ projects,
  kinds = branchKinds(),
) {
  const prefix = loopsPrefix(main);
  const want = projectFolder(topic);
  /** @type {{ folder: string, worktree: string }[]} */
  const out = [];
  for (const name of list(projects)) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    const folder = join(projects, name);
    const slice = rest.startsWith(`${want}-`) ? /^(\d+)$/.exec(rest.slice(want.length + 1))?.[1] : undefined;
    const worktree =
      rest === want ? topic : rest === `plan-${want}` ? `plan-${topic}` : slice ? `${topic}-${slice}` : null;
    if (!worktree) continue;
    const branch = branchOf(folder);
    const s = kinds.sliceOf(branch);
    const theirs = slice ? !!branch && !(s?.topic === topic && s.n === slice) : !!s;
    if (theirs) continue;
    out.push({ folder, worktree });
  }
  return out;
}

/** The topics with transcripts under PROJECTS (by their prd or plan branch) or a ledger. */
export function findTopics(
  /** @type {string} */ main,
  /** @type {string} */ projects,
  kinds = branchKinds(),
) {
  const found = new Set(list(ledgerDir(main)).flatMap((f) => (f.endsWith(".json") ? [f.slice(0, -5)] : [])));
  const prefix = loopsPrefix(main);
  for (const name of list(projects)) {
    if (!name.startsWith(prefix)) continue;
    const branch = branchOf(join(projects, name));
    const topic = kinds.nameOf(branch, "prd") ?? kinds.nameOf(branch, "plan");
    if (topic) found.add(topic);
  }
  return [...found].sort();
}

const ledgerDir = (/** @type {string} */ main) => join(main, ".loops/.cost");
export const ledgerPath = (/** @type {string} */ main, /** @type {string} */ topic) =>
  join(ledgerDir(main), `${topic}.json`);

/** The ledger's rows for TOPIC, [] when there is none or it can't be read. */
export function readLedger(/** @type {string} */ main, /** @type {string} */ topic) {
  const rows = readJson(ledgerPath(main, topic))?.rows;
  return Array.isArray(rows) ? rows : [];
}

/** TOPIC's rows (the ledger's, then the transcripts', attributed) and the malformed count. */
export function collect(/** @type {string} */ main, /** @type {string} */ topic, env = process.env) {
  const parsed = topicFolders(main, topic, claudeProjects(env)).flatMap(({ folder, worktree }) =>
    readFolder(folder, worktree),
  );
  const fresh = attribute(
    parsed.flatMap((p) => p.rows),
    topic,
  );
  return {
    rows: mergeRows(readLedger(main, topic), fresh),
    malformed: parsed.reduce((n, p) => n + p.malformed, 0),
    files: parsed.length,
  };
}

/** Merges what's on disk into TOPIC's ledger (a temp file, then a rename); the row count. */
export function writeLedger(/** @type {string} */ main, /** @type {string} */ topic, env = process.env) {
  const { rows } = collect(main, topic, env);
  const path = ledgerPath(main, topic);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ topic, rows }, null, 1)}\n`);
  renameSync(tmp, path);
  return rows.length;
}

const mainCheckout = (env = process.env) =>
  env.RISA_MAIN ||
  execFileSync("git", ["-C", HERE, "worktree", "list", "--porcelain"], { encoding: "utf8" })
    .split("\n")[0]
    .replace(/^worktree /, "");

const USAGE = "usage: cost.mjs report [<topic>] [--json] | cost.mjs ledger <topic>";

function main() {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;
  const json = rest.includes("--json");
  const args = rest.filter((a) => a !== "--json");
  if (cmd === "-h" || cmd === "--help") return console.log(USAGE);
  if (args.some((a) => a.startsWith("-")) || args.length > 1 || (cmd !== "report" && cmd !== "ledger")) {
    console.error(USAGE);
    process.exit(2);
  }
  const mainDir = mainCheckout();
  const [topic] = args;
  if (cmd === "ledger") {
    if (!topic || json) {
      console.error(USAGE);
      process.exit(2);
    }
    const n = writeLedger(mainDir, topic);
    return console.log(`cost: ${n} messages in ${ledgerPath(mainDir, topic)}`);
  }
  if (topic) {
    const { rows, malformed, files } = collect(mainDir, topic);
    const s = summarise(rows);
    if (json) return console.log(JSON.stringify({ topic, ...s, malformed, files }, null, 2));
    console.log(formatSummary(topic, s));
    if (malformed) console.log(`  ${malformed} malformed line${malformed === 1 ? "" : "s"} skipped`);
    return;
  }
  const all = findTopics(mainDir, claudeProjects()).map((t) => {
    const { rows, malformed } = collect(mainDir, t);
    return { topic: t, ...summarise(rows), malformed };
  });
  if (json) return console.log(JSON.stringify(all, null, 2));
  if (!all.length) return console.log("cost: no topics with transcripts or a ledger");
  for (const t of all) console.log(formatTotal(t.topic, t));
}

if (existsSync(process.argv[1] ?? "") && import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main();
