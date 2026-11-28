#!/usr/bin/env node
// Named backlog sessions on request. A session can't open a tab from its own
// shell, so it files a request and the dispatcher's next tick opens it.
//
//   prd session request backlog <name> [--brief <file>] [--model <m>]
//   prd session requests [--json]     pending ones, then those settled in the last day
//
// One JSON file per request in the main checkout's .loops/.requests
// (RISA_REQUESTS_DIR): { id, kind, name, session (backlog-<name>), remote
// (`backlog - <name>`), model, brief, from, requestedAt, state (pending, opened
// or refused), why, noticeFailed (why the requester's notice couldn't post),
// doneAt }. Ids are r1, r2, … and never reused: the high-water mark is
// notices.mjs's (.seq.d/ files that only move up; an old .seq still reads), so
// two requests filed together can't lower it. A brief is
// copied into the store when the request is filed, so the requester's file can
// go; it is deleted with its request, a day after that settled.
//
// requestDecision is pure: the facts in, what this tick does with the oldest
// pending request out; dispatch.mjs gathers and acts. The limit
// (RISA_MAX_BACKLOG_SESSIONS, 4) counts every live backlog-kind session:
// recorded, rotating within the grace, opened by hand (a claude process under a
// backlog Remote Control name), or just opened and not up yet. With the repo's
// work switch off (machine.mjs, the dispatcher's facts.work) a pending request
// is refused, saying so, and nothing opens.
import { toolCmd } from "./config.mjs";
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CAPTAINS, CAPTAIN_SESSION } from "./captain.mjs";
import { ROTATING_GRACE_MS } from "./dispatch-pick.mjs";
import { MACHINE_TAG, START_GRACE_MS, workOffWhy } from "./keep-alive.mjs";
import { MAX_TEXT, oneLine, raiseSeq, readSeq } from "./notices.mjs";
import { CLAUDE } from "./host.mjs";
import {
  ancestorClaude,
  claudeName,
  isLive,
  processOf,
  processTable,
  readRecords,
  runs,
} from "./sessions.mjs";

export const DEFAULT_MAX_BACKLOG_SESSIONS = 4;
/** The model a requested session runs on unless --model names another (prd.sh's agent_model). */
export const DEFAULT_REQUEST_MODEL = "opus";
/** How long a settled request stays listed. */
export const KEEP_SETTLED_MS = 24 * 3600_000;
const MAX_NAME = 40;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MODEL = /^[A-Za-z0-9._[\]-]+$/;
const ID_FILE = /^r(\d+)\.json$/;

export class RequestError extends Error {}

/**
 * @typedef {{ id: string, kind: "backlog", name: string, session: string, remote: string, model: string,
 *   brief: string | null, from: string | null, requestedAt: string, state: "pending" | "opened" | "refused",
 *   why?: string, noticeFailed?: string, doneAt?: string }} SessionRequest
 * @typedef {{ name: string, kind?: string, live: boolean, rotating?: boolean,
 *   rotatingAt?: number | string | null }} RequestSession
 */

export const validName = (/** @type {unknown} */ name) =>
  typeof name === "string" && name.length <= MAX_NAME && NAME.test(name);
export const sessionNameOf = (/** @type {string} */ name) => `backlog-${name}`;
export const remoteNameOf = (/** @type {string} */ name) => `backlog - ${name}`;

const idOf = (/** @type {{ id: string }} */ r) => Number(r.id.slice(1));
const tmpName = (/** @type {string} */ dir) =>
  join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
const gone = (/** @type {string} */ file) => {
  try {
    unlinkSync(file);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e;
  }
};
const fileNames = (/** @type {string} */ dir) => {
  try {
    return readdirSync(dir);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return [];
    throw e;
  }
};

/** Every readable request, oldest first. Writes nothing, so a dry run can use it. */
export function readRequests(/** @type {string} */ dir) {
  /** @type {SessionRequest[]} */
  const out = [];
  for (const f of fileNames(dir)) {
    if (!ID_FILE.test(f)) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf8")));
    } catch {
      /* unreadable: never taken */
    }
  }
  return out.sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt) || idOf(a) - idOf(b));
}

/** Deletes requests settled over KEEP_SETTLED_MS ago, and their briefs. */
function prune(/** @type {string} */ dir, /** @type {number} */ now) {
  for (const r of readRequests(dir)) {
    if (r.state === "pending" || !(now - Date.parse(r.doneAt ?? "") > KEEP_SETTLED_MS)) continue;
    if (r.brief) gone(r.brief);
    gone(join(dir, `${r.id}.json`));
  }
}

/**
 * Files a request; returns it. The brief is copied in before the request
 * appears, so the dispatcher never sees a request whose brief isn't there yet.
 * @param {string} dir
 * @param {{ name: string, brief?: string | null, model?: string | null, from?: string | null, now?: number }} request
 */
export function createRequest(dir, { name, brief = null, model = null, from = null, now = Date.now() }) {
  if (!validName(name))
    throw new RequestError(`a session name is lowercase words and dashes, ${MAX_NAME} characters at most`);
  if (model && !MODEL.test(model)) throw new RequestError(`not a model name: ${model}`);
  mkdirSync(dir, { recursive: true });
  prune(dir, now);
  let stored = null;
  if (brief) {
    stored = join(dir, `brief-${now}-${process.pid}-${Math.random().toString(36).slice(2)}.md`);
    copyFileSync(brief, stored);
  }
  const numbers = fileNames(dir).flatMap((f) => {
    const m = ID_FILE.exec(f);
    return m ? [Number(m[1])] : [];
  });
  let n = Math.max(readSeq(dir), ...numbers) + 1;
  for (;;) {
    /** @type {SessionRequest} */
    const record = {
      id: `r${n}`,
      kind: "backlog",
      name,
      session: sessionNameOf(name),
      remote: remoteNameOf(name),
      model: model || DEFAULT_REQUEST_MODEL,
      brief: stored,
      from: from || null,
      requestedAt: new Date(now).toISOString(),
      state: "pending",
    };
    const tmp = tmpName(dir);
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    try {
      linkSync(tmp, join(dir, `${record.id}.json`));
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") throw e;
      n++;
      continue;
    } finally {
      gone(tmp);
    }
    raiseSeq(dir, n);
    return record;
  }
}

/** Settles a request as opened or refused, atomically. */
export function settleRequest(
  /** @type {string} */ dir,
  /** @type {string} */ id,
  /** @type {{ state: "opened" | "refused", why?: string, noticeFailed?: string, now?: number }} */ {
    state,
    why,
    noticeFailed,
    now = Date.now(),
  },
) {
  const file = join(dir, `${id}.json`);
  const current = JSON.parse(readFileSync(file, "utf8"));
  const next = {
    ...current,
    state,
    ...(why ? { why } : {}),
    ...(noticeFailed ? { noticeFailed } : {}),
    doneAt: new Date(now).toISOString(),
  };
  const tmp = tmpName(dir);
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, file);
  prune(dir, now);
  return next;
}

/**
 * The session name behind a claude process's backlog Remote Control name, or
 * null. A captain's name (captain.mjs) is the main session's: `backlog`.
 */
export function backlogRemoteOf(/** @type {string} */ args, /** @type {string} */ claude = CLAUDE) {
  if (!runs(args, claude)) return null;
  if (
    CAPTAINS.some((c) =>
      new RegExp(`(?:^|\\s)--remote-control[ =](?:${MACHINE_TAG})?${c}(?=\\s|$)`).test(args),
    )
  )
    return CAPTAIN_SESSION;
  const m =
    /(?:^|\s)--remote-control[ =](?:[A-Z]{2}-)?backlog(?:( - |-)([a-z0-9]+(?:-[a-z0-9]+)*))?(?=\s|$)/.exec(
      args,
    );
  if (!m) return null;
  return m[2] ? sessionNameOf(m[2]) : "backlog";
}

/** How many sessions hold each backlog name: a name's records and its processes are the same sessions. */
function liveBacklog(
  /** @type {{ sessions: RequestSession[], processes: string[], starting: string[], now: number, claude: string }} */ {
    sessions,
    processes,
    starting,
    now,
    claude,
  },
) {
  /** @type {Map<string, number>} */
  const held = new Map();
  for (const s of sessions) {
    if (s.kind !== "backlog") continue;
    const at = typeof s.rotatingAt === "string" ? Date.parse(s.rotatingAt) : s.rotatingAt;
    const rotating =
      s.rotating && (typeof at !== "number" || Number.isNaN(at) || now - at < ROTATING_GRACE_MS);
    if (s.live || rotating) held.set(s.name, 1);
  }
  /** @type {Map<string, number>} */
  const running = new Map();
  for (const args of processes) {
    const name = backlogRemoteOf(args, claude);
    if (name) running.set(name, (running.get(name) ?? 0) + 1);
  }
  for (const [name, n] of running) held.set(name, Math.max(held.get(name) ?? 0, n));
  for (const name of starting) held.set(name, Math.max(held.get(name) ?? 0, 1));
  return held;
}

/**
 * What this tick does with the oldest pending request.
 * @param {{ requests?: SessionRequest[], sessions?: RequestSession[], processes?: string[] | null,
 *   starting?: string[], paused?: boolean, max?: number, now: number, claude?: string,
 *   work?: { on: boolean, why: string } | null }} facts
 *   starting: backlog sessions opened moments ago that aren't up yet; work: the repo's work switch
 * @returns {{ action: "none", why: string } | { action: "open", request: SessionRequest, why: string }
 *   | { action: "refuse", request: SessionRequest, why: string }}
 */
export function requestDecision({
  requests = [],
  sessions = [],
  processes = null,
  starting = [],
  paused = false,
  max = DEFAULT_MAX_BACKLOG_SESSIONS,
  now,
  claude = CLAUDE,
  work = null,
}) {
  const pending = requests.filter((r) => r.state === "pending");
  if (!pending.length) return { action: "none", why: "no pending request" };
  const workOff = workOffWhy(work);
  if (workOff) return { action: "refuse", request: pending[0], why: workOff };
  if (paused) return { action: "none", why: "the dispatcher is paused" };
  if (processes === null) return { action: "none", why: "the process list can't be read" };
  const request = pending[0];
  // A request opened moments ago holds its name until its session is up.
  const opened = requests
    .filter((r) => r.state === "opened" && now - Date.parse(r.doneAt ?? "") < START_GRACE_MS)
    .map((r) => r.session);
  const held = liveBacklog({ sessions, processes, starting: [...starting, ...opened], now, claude });
  if (held.has(request.session))
    return { action: "refuse", request, why: `\`${request.remote}\` is already live` };
  const count = [...held.values()].reduce((a, b) => a + b, 0);
  if (count >= max)
    return { action: "refuse", request, why: `${count} backlog sessions are live, the limit is ${max}` };
  return { action: "open", request, why: `${count} of ${max} backlog sessions live` };
}

/** The tab's command for an accepted request. A brief that went bad costs the brief, never the session. */
export function requestLine(
  /** @type {{ request: SessionRequest, main: string, wrapper: string, sh: (s: string) => string }} */ {
    request: r,
    main,
    wrapper,
    sh,
  },
) {
  // The prompt script beside the wrapper: the tool's own, which the project doesn't have.
  const plain = `${sh(join(dirname(wrapper), "prompt.sh"))} backlog`;
  const prompt = r.brief ? `${plain} --brief ${sh(r.brief)} || ${plain}` : plain;
  return `cd ${sh(main)} && ${sh(wrapper)} ${r.session} --kind backlog --managed -- --model ${sh(r.model)} --remote-control ${sh(r.remote)} "$(${prompt})"`;
}

/** `s` in at most `n` characters, its end cut to an ellipsis. */
const clip = (/** @type {string} */ s, /** @type {number} */ n) =>
  s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;

/**
 * The notice for the requester: one line within the board's MAX_TEXT. The id
 * and the outcome always stay; past the bound the variable parts (the
 * requester, the remote name, why) are cut, the longest first, to an ellipsis.
 */
export function requestNotice(
  /** @type {SessionRequest} */ r,
  /** @type {{ opened: boolean, why?: string }} */ { opened, why },
) {
  /** @type {string[]} */
  const parts = (opened ? [r.from, r.remote] : [r.from, r.remote, why]).map((p) => oneLine(p));
  const text = (/** @type {string[]} */ [from, remote, reason]) => {
    const to = from ? ` (for ${from})` : "";
    return opened
      ? `request ${r.id}${to}: opened \`${remote}\``
      : `request ${r.id}${to}: \`${remote}\` not opened: ${reason}`;
  };
  const full = text(parts);
  if (full.length <= MAX_TEXT) return full;
  // The widest cap on each part that fits: the room left over the fixed text.
  const room = MAX_TEXT - (full.length - parts.reduce((n, p) => n + p.length, 0));
  let cap = Math.max(...parts.map((p) => p.length));
  while (cap > 1 && parts.reduce((n, p) => n + Math.min(p.length, cap), 0) > room) cap--;
  return text(parts.map((p) => clip(p, cap)));
}

/** `prd status`'s part: the pending requests under a heading, or "". */
export function pendingPart(/** @type {string} */ dir) {
  const pending = readRequests(dir).filter((r) => r.state === "pending");
  if (!pending.length) return "";
  return [
    `SESSION REQUESTS: ${pending.length} pending (${toolCmd.prd} session requests)`,
    ...pending.map((r) => `${r.id}  ${r.remote}  from ${r.from ?? "-"}, ${r.requestedAt}`),
    "",
  ].join("\n");
}

const listLine = (/** @type {SessionRequest} */ r) =>
  `${r.id}  ${r.state}  ${r.remote}  from ${r.from ?? "-"}, ${r.requestedAt}${r.why ? `: ${r.why}` : ""}` +
  (r.noticeFailed ? ` (its notice failed: ${r.noticeFailed})` : "");

/** The live session record of the calling shell's ancestor claude, by name, or null. */
function callerName(/** @type {string | undefined} */ sessionsDir) {
  if (!sessionsDir) return null;
  try {
    const pid = ancestorClaude(process.pid, processTable(), claudeName());
    if (!pid) return null;
    const proc = processOf(pid);
    return (
      readRecords(sessionsDir).find((x) => x.record?.pid === pid && isLive(x.record, proc))?.name ?? null
    );
  } catch {
    return null;
  }
}

const USAGE = `usage: ${toolCmd.prd} session request backlog <name> [--brief <file>] [--model <m>] | ${toolCmd.prd} session requests [--json]`;

async function cli(/** @type {string[]} */ argv) {
  const dir = process.env.RISA_REQUESTS_DIR;
  if (!dir) throw new RequestError(`RISA_REQUESTS_DIR isn't set (run this through ${toolCmd.prd})`);
  const [cmd, ...rest] = argv;
  if (cmd === "requests") {
    if (rest.length > 1 || (rest[0] && rest[0] !== "--json")) throw new RequestError(USAGE);
    const all = readRequests(dir);
    const now = Date.now();
    const shown = all.filter(
      (r) => r.state === "pending" || now - Date.parse(r.doneAt ?? "") <= KEEP_SETTLED_MS,
    );
    if (rest[0]) console.log(JSON.stringify(shown));
    else console.log(shown.length ? shown.map(listLine).join("\n") : "No session requests.");
    return;
  }
  if (cmd !== "request") throw new RequestError(USAGE);
  const [kind, name, ...opts] = rest;
  if (kind !== "backlog") throw new RequestError(`only backlog sessions can be requested. ${USAGE}`);
  if (!name || name.startsWith("-")) throw new RequestError(USAGE);
  let brief = null;
  let model = null;
  for (let i = 0; i < opts.length; i++) {
    const value = opts[i + 1];
    if ((opts[i] !== "--brief" && opts[i] !== "--model") || !value) throw new RequestError(USAGE);
    if (opts[i] === "--brief") brief = value;
    else model = value;
    i++;
  }
  if (!validName(name))
    throw new RequestError(`a session name is lowercase words and dashes, ${MAX_NAME} characters at most`);
  if (brief) {
    const { briefProblem } = await import("./rotate.mjs");
    const why = briefProblem(brief);
    if (why) throw new RequestError(why);
  }
  const r = createRequest(dir, { name, brief, model, from: callerName(process.env.RISA_SESSIONS_DIR) });
  console.log(r.id);
  console.error(
    `Requested \`${r.remote}\`: the dispatcher's next tick opens it and posts the outcome (${toolCmd.prd} notices).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  cli(process.argv.slice(2)).catch((e) => {
    console.error(`${toolCmd.prd}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(e instanceof RequestError ? 2 : 1);
  });
}
