// Token use priced by model and cache kind (RISA-883). Token counts hide cost: cache
// writes are a few percent of the tokens a session uses but a large share of what it
// costs. This reads Claude Code's JSONL transcripts (a config folder's `projects/`,
// as host.mjs's claudeProjects finds it) and prices every assistant reply's usage by
// its model and by kind (input, output, cache write, cache read), before and after a
// cutoff date, with the totals and the change.
//
//   node loops/token-price.mjs --since <date> --cutoff <date> [--dir <projects folder>]
//
// Replies from SINCE up to CUTOFF are "before", from CUTOFF on "after". A reply
// Claude Code wrote over several lines (one per content block) counts once, by its
// message id. A model the table doesn't price is counted in tokens and listed as
// unpriced. Not loops/cost* (RISA-560's): this is a one-off reading, no command.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeProjects } from "./host.mjs";

/** When PRICES was read: the claude-api skill's pricing reference (its cache of 2026-11-03). */
export const PRICES_READ = "2026-11-27";

/**
 * US dollars per million tokens, Anthropic first-party rates: input, output, a
 * 5-minute and a 1-hour cache write, a cache read. Haiku 5.5 is its rate card for
 * prompts of 100K tokens or fewer. A dated id (claude-opus-4-5-20251101) prices as
 * its longest key prefix.
 */
export const PRICES = {
  "claude-fable-5-2": { input: 8, output: 40, write5m: 10, write1h: 16, read: 0.2 },
  "claude-mythos-5-2": { input: 8, output: 40, write5m: 10, write1h: 16, read: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, write5m: 12.5, write1h: 20, read: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, write5m: 12.5, write1h: 20, read: 0.25 },
  "claude-fable-5": { input: 10, output: 50, write5m: 12.5, write1h: 20, read: 1 },
  "claude-mythos-5": { input: 10, output: 50, write5m: 12.5, write1h: 20, read: 1 },
  "claude-opus-5-5": { input: 4, output: 20, write5m: 5, write1h: 8, read: 0.2 },
  "claude-opus-5": { input: 5, output: 25, write5m: 6.25, write1h: 10, read: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, write5m: 6.25, write1h: 10, read: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, write5m: 6.25, write1h: 10, read: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, write5m: 6.25, write1h: 10, read: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, write5m: 2.5, write1h: 4, read: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10, write5m: 2.5, write1h: 4, read: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, write5m: 3.75, write1h: 6, read: 0.3 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, write5m: 0.125, write1h: 0.2, read: 0.01 },
  "claude-haiku-4-5": { input: 1, output: 5, write5m: 1.25, write1h: 2, read: 0.1 },
};

/** The kinds a reading reports, in order. */
export const KINDS = /** @type {const} */ (["input", "output", "cacheWrite", "cacheRead"]);
const KIND_NAMES = { input: "input", output: "output", cacheWrite: "cache write", cacheRead: "cache read" };
const DAY_MS = 86_400_000;

/** MODEL's prices: its own row, else the longest key it starts with; null when none. */
export function priceOf(/** @type {string} */ model, prices = PRICES) {
  if (prices[model]) return prices[model];
  const key = Object.keys(prices)
    .filter((k) => model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? prices[key] : null;
}

/**
 * One reply's usage as tokens: input, output, the two cache writes (an unsplit
 * cache_creation_input_tokens counts as 5-minute, Claude Code's default), cache read.
 */
export function tokensOf(/** @type {any} */ usage) {
  const n = (/** @type {unknown} */ v) => (typeof v === "number" && v > 0 ? v : 0);
  const split = usage.cache_creation;
  const write1h = n(split?.ephemeral_1h_input_tokens);
  const write5m = split ? n(split.ephemeral_5m_input_tokens) : n(usage.cache_creation_input_tokens);
  return {
    input: n(usage.input_tokens),
    output: n(usage.output_tokens),
    write5m,
    write1h,
    read: n(usage.cache_read_input_tokens),
  };
}

/** Every .jsonl file under DIR (a session's subagents folder too). */
function transcripts(/** @type {string} */ dir, /** @type {number} */ sinceMs) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...transcripts(path, sinceMs));
    else if (e.name.endsWith(".jsonl") && statSync(path).mtimeMs >= sinceMs) out.push(path);
  }
  return out;
}

/**
 * The assistant replies in the transcripts under DIR from SINCE (ms) on: { at, model,
 * tokens }, one per message id.
 */
export function readUses(/** @type {string} */ dir, { since = 0 } = {}) {
  /** @type {Map<string, { at: number, model: string, tokens: ReturnType<typeof tokensOf> }>} */
  const uses = new Map();
  let anon = 0;
  for (const file of transcripts(dir, since)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"usage"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = entry?.message;
      if (entry?.type !== "assistant" || !msg?.usage || typeof msg.model !== "string") continue;
      if (msg.model.startsWith("<")) continue; // <synthetic>: Claude Code's own, not billed
      const at = Date.parse(entry.timestamp);
      if (!Number.isFinite(at) || at < since) continue;
      const id = msg.id ?? entry.requestId ?? `anon-${anon++}`;
      uses.set(id, { at, model: msg.model, tokens: tokensOf(msg.usage) });
    }
  }
  return [...uses.values()];
}

const emptyKinds = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

/**
 * USES split at CUTOFF (ms) and summed: for each period, per model and in total,
 * tokens and dollars by kind; unpriced models' tokens are kept, their dollars 0.
 */
export function tally(uses, { cutoff, prices = PRICES }) {
  const period = () => ({
    /** @type {Record<string, { priced: boolean, tokens: Record<string, number>, cost: Record<string, number> }>} */
    models: {},
    tokens: emptyKinds(),
    cost: emptyKinds(),
    replies: 0,
  });
  const out = { before: period(), after: period() };
  for (const u of uses) {
    const p = u.at < cutoff ? out.before : out.after;
    const price = priceOf(u.model, prices);
    const m = (p.models[u.model] ??= { priced: !!price, tokens: emptyKinds(), cost: emptyKinds() });
    const t = u.tokens;
    const tokens = { input: t.input, output: t.output, cacheWrite: t.write5m + t.write1h, cacheRead: t.read };
    const cost = price
      ? {
          input: (t.input * price.input) / 1e6,
          output: (t.output * price.output) / 1e6,
          cacheWrite: (t.write5m * price.write5m + t.write1h * price.write1h) / 1e6,
          cacheRead: (t.read * price.read) / 1e6,
        }
      : emptyKinds();
    for (const k of KINDS) {
      m.tokens[k] += tokens[k];
      m.cost[k] += cost[k];
      p.tokens[k] += tokens[k];
      p.cost[k] += cost[k];
    }
    p.replies++;
  }
  return out;
}

const sum = (/** @type {Record<string, number>} */ kinds) => KINDS.reduce((s, k) => s + kinds[k], 0);
const usd = (/** @type {number} */ v) => `$${v.toFixed(2)}`;
const pct = (/** @type {number} */ part, /** @type {number} */ whole) =>
  whole ? `${((100 * part) / whole).toFixed(1)}%` : "-";
const change = (/** @type {number} */ a, /** @type {number} */ b) =>
  a ? `${b >= a ? "+" : ""}${((100 * (b - a)) / a).toFixed(1)}%` : "-";
const mtok = (/** @type {number} */ v) => `${(v / 1e6).toFixed(2)}M`;

/** Fixed-width rows, the first column left-aligned. */
function table(/** @type {string[][]} */ rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows
    .map((r) => r.map((c, i) => (i ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join("  "))
    .join("\n");
}

/** The report: each period by model and by kind, then the change, totals and per day. */
export function format(t, { since, cutoff, now }) {
  const days = { before: (cutoff - since) / DAY_MS, after: Math.max(now - cutoff, 0) / DAY_MS };
  const day = (/** @type {number} */ ms) => new Date(ms).toISOString().slice(0, 10);
  const lines = [`Prices read ${PRICES_READ} (US$ per million tokens, first-party rates).`];
  for (const name of /** @type {const} */ (["before", "after"])) {
    const p = t[name];
    const span = name === "before" ? `${day(since)} to ${day(cutoff)}` : `${day(cutoff)} on`;
    lines.push("", `${name} (${span}, ${days[name].toFixed(1)} days, ${p.replies} replies)`);
    const rows = [["model", ...KINDS.map((k) => KIND_NAMES[k]), "total"]];
    for (const [model, m] of Object.entries(p.models).sort((a, b) => sum(b[1].cost) - sum(a[1].cost)))
      rows.push(
        m.priced
          ? [model, ...KINDS.map((k) => usd(m.cost[k])), usd(sum(m.cost))]
          : [`${model} (unpriced)`, ...KINDS.map((k) => mtok(m.tokens[k])), "-"],
      );
    rows.push(["all", ...KINDS.map((k) => usd(p.cost[k])), usd(sum(p.cost))]);
    rows.push(["tokens", ...KINDS.map((k) => mtok(p.tokens[k])), mtok(sum(p.tokens))]);
    rows.push(["share of tokens", ...KINDS.map((k) => pct(p.tokens[k], sum(p.tokens))), ""]);
    rows.push(["share of cost", ...KINDS.map((k) => pct(p.cost[k], sum(p.cost))), ""]);
    lines.push(table(rows));
  }
  const perDay = (/** @type {number} */ v, /** @type {number} */ d) => (d > 0 ? v / d : 0);
  const rows = [["change", ...KINDS.map((k) => KIND_NAMES[k]), "total"]];
  const b = t.before.cost;
  const a = t.after.cost;
  rows.push(["before", ...KINDS.map((k) => usd(b[k])), usd(sum(b))]);
  rows.push(["after", ...KINDS.map((k) => usd(a[k])), usd(sum(a))]);
  rows.push(["change", ...KINDS.map((k) => change(b[k], a[k])), change(sum(b), sum(a))]);
  const bd = (/** @type {number} */ v) => perDay(v, days.before);
  const ad = (/** @type {number} */ v) => perDay(v, days.after);
  rows.push(["before per day", ...KINDS.map((k) => usd(bd(b[k]))), usd(bd(sum(b)))]);
  rows.push(["after per day", ...KINDS.map((k) => usd(ad(a[k]))), usd(ad(sum(a)))]);
  rows.push([
    "change per day",
    ...KINDS.map((k) => change(bd(b[k]), ad(a[k]))),
    change(bd(sum(b)), ad(sum(a))),
  ]);
  lines.push("", table(rows));
  return lines.join("\n");
}

/** ARGS parsed: { since, cutoff, dir } (ms, ms, a folder), or throws with the usage. */
export function parseArgs(/** @type {string[]} */ args, env = process.env) {
  const usage = "usage: node loops/token-price.mjs --since <date> --cutoff <date> [--dir <projects folder>]";
  /** @type {Record<string, string>} */
  const got = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i].replace(/^--/, "");
    if (!["since", "cutoff", "dir"].includes(flag) || args[i + 1] === undefined)
      throw new Error(`token-price: unknown argument ${args[i]}\n${usage}`);
    got[flag] = args[++i];
  }
  const since = Date.parse(got.since);
  const cutoff = Date.parse(got.cutoff);
  if (!Number.isFinite(since) || !Number.isFinite(cutoff))
    throw new Error(`token-price: needs two dates\n${usage}`);
  if (cutoff <= since) throw new Error("token-price: the cutoff must be after --since");
  return { since, cutoff, dir: got.dir || claudeProjects(env) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { since, cutoff, dir } = parseArgs(process.argv.slice(2));
    const now = Date.now();
    console.log(format(tally(readUses(dir, { since }), { cutoff }), { since, cutoff, now }));
  } catch (e) {
    console.error(/** @type {Error} */ (e).message);
    process.exit(1);
  }
}
