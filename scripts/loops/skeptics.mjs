// The skeptic's records and brief. A skeptic is a fresh subagent a session
// spawns before it asks the user or takes a risky landing; nothing here calls a
// model. The session records what it answered, and the commands that act on it
// (`ask`, `land`) check that record with checkRecord. `skeptic.mjs` is the
// command line.
//
// A record: { id, kind: "ask" | "land" | "plan", verdict, why, option, session,
// topic, tip, action, questionHash, askerClass, at }, one JSON file per verdict
// (`.loops/.skeptic/<id>.json` in the main checkout; machine local, untracked).
// Ids are s1, s2, …, taken exclusively by link(2) of a fully written temp file.
// A record never changes: single use is a marker beside it (`<id>.used`, created
// exclusively, so two commands can't both spend one record).
//
// A verdict is bound to what it approved: a land record to its action and tip,
// an ask record to the hash of its question and options and to the asker's class
// (`defaults` or `waits`). A `decide` on a `waits` question is refused when it
// is recorded and again when it is used: the never list is the user's.
import { createHash } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const ID = /^s(\d+)$/;
const ID_FILE = /^s(\d+)\.json$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

/** How long a verdict counts, in minutes (CARETOOK_SKEPTIC_MAX_MIN). */
export const DEFAULT_MAX_MIN = 60;
/** The verdicts each kind of skeptic can give. */
export const VERDICTS = { ask: ["decide", "ask"], land: ["go", "no"], plan: ["go", "send-back"] };

export class SkepticError extends Error {}

/** @param {string | undefined} value CARETOOK_SKEPTIC_MAX_MIN @returns {number} minutes */
export function maxAgeMin(value) {
  const n = Number(value);
  return value != null && value !== "" && Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_MIN;
}

/** The hash an ask record is bound to. @param {string} text @param {string[]} [options] */
export const questionHash = (text, options = []) =>
  createHash("sha256")
    .update(JSON.stringify([text.trim(), options]))
    .digest("hex");

const isAction = (a) => a === "force" || a === "no-review" || /^decline \S+$/.test(a ?? "");

/** Throws a SkepticError unless the verdict is well formed for its kind. */
function validate({ kind, verdict, why, option, tip, action, question, offers, askerClass, topic }) {
  if (!VERDICTS[kind]) throw new SkepticError(`unknown kind ${kind} (ask, land or plan)`);
  if (!VERDICTS[kind].includes(verdict))
    throw new SkepticError(`a ${kind} skeptic answers ${VERDICTS[kind].join(" or ")}, not ${verdict}`);
  if (!topic) throw new SkepticError("a verdict needs a topic");
  if (!why?.trim()) throw new SkepticError("a verdict needs one line of why");
  if (/[\r\n]/.test(why)) throw new SkepticError("the why is one line");
  if (kind === "land") {
    if (!isAction(action))
      throw new SkepticError('a land verdict names its action: force, no-review or "decline <thread>"');
    if (!FULL_SHA.test(tip ?? ""))
      throw new SkepticError("a land verdict needs the full tip it judged (--tip $(git rev-parse HEAD))");
  } else if (tip != null || action != null)
    throw new SkepticError("only a land verdict has a tip and an action");
  if (kind === "ask") {
    if (!question?.trim()) throw new SkepticError("an ask verdict needs the question it judged");
    if (askerClass !== "defaults" && askerClass !== "waits")
      throw new SkepticError("an ask verdict needs the asker's class: --defaults or --waits");
    if (new Set(offers).size !== offers.length) throw new SkepticError("options must differ");
  } else if (question != null || askerClass != null || offers.length)
    throw new SkepticError("only an ask verdict has a question, its options and a class");
  if (verdict === "decide") {
    if (askerClass === "waits")
      throw new SkepticError("a --waits question is the user's: a skeptic can't decide it (answer ask)");
    if (!offers.includes(option)) throw new SkepticError("decide names one of the question's options");
  } else if (option != null) throw new SkepticError("only a decide verdict chooses an option");
}

const idNumbers = (dir) => {
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  return names.flatMap((n) => {
    const m = ID_FILE.exec(n);
    return m ? [Number(m[1])] : [];
  });
};

/**
 * Record a verdict; returns the stored record.
 * @param {string} dir
 * @param {{ kind: string, verdict: string, why: string, topic: string, session?: string | null,
 *   option?: string | null, tip?: string | null, action?: string | null, question?: string | null,
 *   offers?: string[], askerClass?: "defaults" | "waits" | null, now?: number }} input
 */
export function recordVerdict(dir, input) {
  const {
    kind,
    verdict,
    why,
    topic,
    session = null,
    option = null,
    tip = null,
    action = null,
    question = null,
    offers = [],
    askerClass = null,
    now,
  } = input;
  validate({ kind, verdict, why, option, tip, action, question, offers, askerClass, topic });
  mkdirSync(dir, { recursive: true });
  const base = {
    kind,
    verdict,
    why: why.trim(),
    option,
    session,
    topic,
    tip,
    action,
    questionHash: kind === "ask" ? questionHash(question, offers) : null,
    askerClass,
    at: new Date(now ?? Date.now()).toISOString(),
  };
  let n = Math.max(0, ...idNumbers(dir)) + 1;
  for (;;) {
    const id = `s${n}`;
    const record = { id, ...base };
    const tmp = join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
    try {
      linkSync(tmp, join(dir, `${id}.json`));
      return { ...record, usedAt: null };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      n++;
    } finally {
      unlinkSync(tmp);
    }
  }
}

const usedAt = (dir, id) => {
  try {
    return statSync(join(dir, `${id}.used`)).mtime.toISOString();
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};

/** @param {string} dir @param {string} id @returns {object | null} the record, or null when there's none */
export function getRecord(dir, id) {
  if (!ID.test(id ?? "")) return null;
  let text;
  try {
    text = readFileSync(join(dir, `${id}.json`), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  try {
    return { ...JSON.parse(text), usedAt: usedAt(dir, id) };
  } catch {
    return null;
  }
}

/** The records, oldest first. @param {string} dir @param {{ topic?: string }} [filter] */
export function listRecords(dir, { topic } = {}) {
  return idNumbers(dir)
    .sort((a, b) => a - b)
    .flatMap((n) => getRecord(dir, `s${n}`) ?? [])
    .filter((r) => !topic || r.topic === topic);
}

const no = (reason) => ({ ok: false, reason });

function checkLand(record, wanted) {
  if (record.kind !== "land") return no(`${record.id} is a ${record.kind} verdict, not a landing's`);
  if (record.action !== wanted.action)
    return no(`${record.id} judged "${record.action}", not "${wanted.action}"`);
  if (record.tip !== wanted.tip)
    return no(`${record.id} judged ${record.tip?.slice(0, 7)}, and the tip is ${wanted.tip?.slice(0, 7)}`);
  if (record.verdict !== "go") return no(`the skeptic said ${record.verdict}: ${record.why}`);
  return { ok: true };
}

function checkAsk(record, wanted) {
  if (record.kind === "land")
    return record.verdict === "no" ? { ok: true } : no(`${record.id} is a land go: nothing to ask the user`);
  if (record.kind === "plan")
    return record.verdict === "send-back"
      ? { ok: true }
      : no(`${record.id} is a plan go: nothing to ask the user`);
  if (record.verdict === "decide")
    return no(`the skeptic decided this one: file it with pnpm prd ask --decided --skeptic ${record.id}`);
  if (record.verdict !== "ask") return no(`${record.id} has no ask verdict`);
  if (record.questionHash !== wanted.questionHash)
    return no(`${record.id} judged another question or other options`);
  if (record.askerClass !== wanted.askerClass)
    return no(`${record.id} judged a --${record.askerClass} question, not --${wanted.askerClass}`);
  return { ok: true };
}

function checkDecided(record, wanted) {
  if (record.kind !== "ask" || record.verdict !== "decide")
    return no(`${record.id} isn't a decide verdict: only a skeptic's decide files a decision`);
  if (record.askerClass !== "defaults" || wanted.askerClass === "waits")
    return no("a --waits question is the user's: a skeptic can't decide it");
  if (record.questionHash !== wanted.questionHash)
    return no(`${record.id} judged another question or other options`);
  if (record.option !== wanted.chose)
    return no(`${record.id} chose "${record.option}", not "${wanted.chose}"`);
  return { ok: true };
}

/**
 * Does this record allow this action? Pure, given `now` and `maxMin` (their
 * defaults are the clock and CARETOOK_SKEPTIC_MAX_MIN).
 * @param {object | null} record
 * @param {{ use: "land", topic: string, action: string, tip: string }
 *   | { use: "ask", topic: string, questionHash: string, askerClass: "defaults" | "waits" }
 *   | { use: "decided", topic: string, questionHash: string, chose: string,
 *       askerClass?: "defaults" | "waits" }} wanted  `ask` files a question, `decided` a settled one
 * @param {{ now?: number, maxMin?: number }} [opts]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkRecord(
  record,
  wanted,
  { now = Date.now(), maxMin = maxAgeMin(process.env.CARETOOK_SKEPTIC_MAX_MIN) } = {},
) {
  if (!record) return no("no such skeptic record");
  if (record.topic !== wanted.topic) return no(`${record.id} is for ${record.topic}, not ${wanted.topic}`);
  const at = Date.parse(record.at);
  if (!Number.isFinite(at) || at > now) return no(`${record.id} has no usable time`);
  if (now - at > maxMin * 60_000)
    return no(`${record.id} is over ${maxMin} minutes old: run the skeptic again`);
  if (record.usedAt) return no(`${record.id} was already used: each question gets its own skeptic`);
  if (wanted.use === "land") return checkLand(record, wanted);
  if (wanted.use === "ask") return checkAsk(record, wanted);
  if (wanted.use === "decided") return checkDecided(record, wanted);
  return no(`unknown use ${wanted.use}`);
}

/**
 * Check a record and spend it, for the single-use actions (an ask, a decision).
 * @returns {object} the record; throws a SkepticError with the reason otherwise
 */
export function useRecord(dir, id, wanted, opts) {
  const record = getRecord(dir, id);
  const result = checkRecord(record, wanted, opts);
  if (!result.ok) throw new SkepticError(result.reason);
  try {
    closeSync(openSync(join(dir, `${id}.used`), "wx"));
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    throw new SkepticError(`${id} was already used: each question gets its own skeptic`);
  }
  return { ...record, usedAt: usedAt(dir, id) };
}

/** The records as lines for `pnpm prd skeptic`. */
export function formatRecords(records) {
  if (!records.length) return "No skeptic verdicts.";
  return records
    .map((r) => {
      const bound = r.kind === "land" ? ` ${r.action} @${r.tip.slice(0, 7)}` : "";
      const chose = r.option ? ` "${r.option}"` : "";
      const used = r.usedAt ? " (used)" : "";
      return `${r.id}  ${r.at}  ${r.topic}  ${r.kind}${bound}: ${r.verdict}${chose}${used}: ${r.why}`;
    })
    .join("\n");
}

const section = (markdown, heading, file) => {
  const lines = markdown.split("\n");
  const start = lines.indexOf(`## ${heading}`);
  if (start < 0) throw new SkepticError(`${file} has no "${heading}" section`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
};

const readDoc = (root, file) => {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") throw new SkepticError(`the brief needs ${file}, and it's missing`);
    throw e;
  }
};

/**
 * The rules a skeptic judges by, as the docs have them today. A doc that lost
 * its rule is refused: a brief without the never list must not go out.
 * @param {string} root the checkout whose docs to read
 */
export function readRules(root) {
  const preferences = readDoc(root, "docs/agents/preferences.md");
  const planner = readDoc(root, "docs/agents/planner.md");
  const fixes = readDoc(root, "plans/fixes-rules.md");
  const silence = preferences.split("\n").find((l) => l.includes("**Default on silence:**")) ?? "";
  const never = /Never \(`--waits`\):\s*(.+?)\s*\([^()]*\d{4}-\d{2}-\d{2}\)\s*$/.exec(silence)?.[1];
  if (!never) throw new SkepticError("docs/agents/preferences.md has no never list to brief from");
  return {
    neverList: never,
    whatToAsk: section(planner, "What to ask", "docs/agents/planner.md").split("**Unattended**")[0].trim(),
    skepticPass: section(planner, "The skeptic pass", "docs/agents/planner.md"),
    fixesRules: fixes.split("\n").slice(1).join("\n").trim(),
  };
}

/** The slice-size cap (B-596), which the plan brief carries beside the handbook's skeptic pass. */
export const SLICE_SIZE_RULE =
  "**A slice too big:** one that would touch more than about 8 files, or more than one running topic's hot file (`pnpm backlog prd list`), is a send-back: split it into slices that each land on their own.";

const JOB = {
  ask: (r) =>
    `A session wants to ask the user the question in the evidence. Decide whether it is really the user's.

Answer **decide <option>** (the option's exact text) only when the choice is reversible and within the rules: the session carries on with it and the user can veto it afterwards. Answer **ask** when it is the user's: a wrong guess is costly to undo, or the rules below say to ask.

**A question on the never list is always ask**, however plain the answer looks. You may tighten its wording or options; you may never decide it. Never list: ${r.neverList}.`,
  land: (r) =>
    `A session wants to take a risky step on a landing: the action named in the evidence (\`--force\` past the check gate, \`--no-review\` without Codex's verdict, or declining a Codex finding). Decide whether the evidence really supports it.

Answer **go** when it does: the failure is unrelated or already covered, or the finding is really not a bug. Answer **no** when the evidence is thin, a real bug could be behind it, or you can't tell. For a declined finding, read the code it points at yourself.

**A go never covers the never list**, and never stands in for the go-ahead to land at all. Never list: ${r.neverList}.`,
  plan: (r) =>
    `A planner wrote the PRD and plan the evidence names. Read them and their backlog items cold, before anything lands.

Answer **go** when they hold up. Answer **send-back** with what to fix when they don't. The planner reworks a send-back and runs you once more; a second send-back becomes a question for the user.

What to look for:

${r.skepticPass}

${SLICE_SIZE_RULE}

Never list (an assumed decision here must be a question): ${r.neverList}.`,
};

const ANSWER = {
  ask: "decide <option> | ask",
  land: "go | no",
  plan: "go | send-back",
};

/**
 * The brief for a fresh skeptic. Pure.
 * @param {"ask" | "land" | "plan"} kind
 * @param {{ evidence: string, rules: ReturnType<typeof readRules> }} input
 */
export function skepticBrief(kind, { evidence, rules }) {
  if (!JOB[kind]) throw new SkepticError(`the skeptic's brief is ask, land or plan, not ${kind}`);
  if (!evidence?.trim()) throw new SkepticError("the evidence file is empty");
  return `You are a skeptic: a fresh second opinion, with no stake in the work. Assume the session's reasoning is wrong until the evidence shows otherwise. The evidence is its claim, so check it against the files and commits it names. Change nothing: no edits, commits, landings or asks.

## Your job

${JOB[kind](rules)}

## The rules you judge by

### What is worth asking

${rules.whatToAsk}

### The fix topics

${rules.fixesRules}

## The evidence

${evidence.trim()}

## Your answer

The first line is the verdict and nothing else: \`${ANSWER[kind]}\`. The second line is one line of why. The session records it with \`pnpm prd skeptic record\`.
`;
}
