// The heartbeat: what each agent of a recorded session is doing, from the
// context hook (the session settings file runs `context.mjs hook` on PreToolUse,
// PostToolUse, PostToolUseFailure, SubagentStop and Stop). Each tool call
// records its start and end, so a started, unfinished call is a running
// command; a stop records that the agent (or, on Stop, the session itself)
// finished its turn. Like the size watch it never blocks and never fails: any
// error is swallowed by the caller.
//
// Records, in .heartbeat beside the sessions folder (the main checkout's .loops):
//   <session>/session.json     the session itself (no agent_id): worktree from its cwd
//   <session>/<agent id>.json  one subagent of that session
// each { session, pid, agent, agentType, worktree, seen, firstAt, lastStart,
// lastEnd, stoppedAt, running }:
//   pid        the session's pid; a record whose pid isn't the live session's is stale
//   worktree   the .loops/<name> worktree the agent works in, or null (unknown):
//              a subagent's hook input carries the session's cwd, not the agent's,
//              so it is the worktree its tool calls name most often (`seen` counts
//              them: file paths, and the paths in a Bash command)
//   running    { <tool_use_id>: { tool, at, command? } }, the calls started and
//              not yet ended (a stop clears them; at most MAX_RUNNING are kept)
//
// The hook input is read by the host layer (host.mjs claudeInput): the event, the
// agent and its type, the cwd, the tool, its input and its call's id.
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { updateRecord } from "./context.mjs";
import { claudeInput } from "./host.mjs";

/** The most unfinished calls a record keeps (an end the hook missed must not pile up). */
const MAX_RUNNING = 20;
const COMMAND_CHARS = 200;

export const heartbeatDirOf = (/** @type {string} */ sessionsDir) => join(dirname(sessionsDir), ".heartbeat");

const nameOk = (/** @type {string} */ n) => /^[\w][\w.-]*$/.test(n);
const escape = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The worktree names under LOOPS that TEXT mentions (`<loops>/<name>`), in order. */
export function worktreesIn(/** @type {string} */ text, /** @type {string} */ loops) {
  if (typeof text !== "string" || !loops) return [];
  const re = new RegExp(`${escape(loops.replace(/\/+$/, ""))}/([^/\\s'"\`;&|)]+)`, "g");
  return [...text.matchAll(re)].map((m) => m[1]).filter(nameOk);
}

/** The worktree a cwd is in: a name under LOOPS, "main" for the main checkout, else null. */
export function worktreeOfCwd(/** @type {string} */ cwd, /** @type {string} */ loops) {
  if (typeof cwd !== "string" || !loops) return null;
  const [name] = worktreesIn(`${cwd}/`, loops);
  if (name) return name;
  const main = dirname(loops);
  return cwd === main || cwd.startsWith(`${main}/`) ? "main" : null;
}

/** The paths a tool call names: its file and notebook paths, a search path, a Bash command. */
function pathsOf(/** @type {any} */ toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  return ["file_path", "notebook_path", "path", "command", "cwd"]
    .map((k) => toolInput[k])
    .filter((v) => typeof v === "string")
    .join("\n");
}

/**
 * The event a hook input stands for, or null for anything else. Pure.
 * @param {any} input the hook's JSON input
 * @param {string} loops the main checkout's .loops
 * @returns {{ type: "start" | "end" | "stop", agent: string | null, agentType: string | null,
 *   tool: string | null, id: string | null, command: string | null, worktrees: string[],
 *   cwdWorktree: string | null } | null}
 */
export function heartbeatEvent(input, loops) {
  if (!input || typeof input !== "object") return null;
  const c = claudeInput(input);
  if (!c) return null;
  const type = {
    PreToolUse: "start",
    PostToolUse: "end",
    PostToolUseFailure: "end",
    SubagentStop: "stop",
    Stop: "stop",
  }[String(c.event)];
  if (!type) return null;
  const rawAgent = c.agent;
  if (rawAgent && !/^[\w-]+$/.test(rawAgent)) return null;
  // A session's own Stop has no agent; a SubagentStop always names one.
  if (c.event === "SubagentStop" && !rawAgent) return null;
  const toolInput = /** @type {any} */ (c.toolInput);
  const command =
    c.tool === "Bash" && typeof toolInput?.command === "string"
      ? toolInput.command.replace(/\s+/g, " ").trim().slice(0, COMMAND_CHARS)
      : null;
  return {
    type,
    agent: rawAgent || null,
    agentType: c.agentType,
    tool: c.tool,
    id: c.toolUseId,
    command,
    worktrees: type === "stop" ? [] : worktreesIn(pathsOf(toolInput), loops),
    cwdWorktree: worktreeOfCwd(/** @type {string} */ (c.cwd), loops),
  };
}

/** The name SEEN counts most (the first to reach it on a tie), or null. */
const mostSeen = (/** @type {Record<string, number>} */ seen) =>
  Object.entries(seen).reduce(
    (/** @type {[string, number] | null} */ best, e) => (!best || e[1] > best[1] ? e : best),
    null,
  )?.[0] ?? null;

/**
 * The record after EVENT. Pure.
 * @param {any} current the record, or null
 * @param {NonNullable<ReturnType<typeof heartbeatEvent>>} event
 * @param {{ session: string, pid: number, now: number }} facts
 */
export function applyHeartbeat(current, event, { session, pid, now }) {
  const at = new Date(now).toISOString();
  const base = current?.pid === pid ? current : null;
  /** @type {any} */
  const r = {
    session,
    pid,
    agent: event.agent,
    agentType: event.agentType ?? base?.agentType ?? null,
    worktree: base?.worktree ?? null,
    seen: { ...(base?.seen ?? {}) },
    firstAt: base?.firstAt ?? at,
    lastStart: base?.lastStart ?? null,
    lastEnd: base?.lastEnd ?? null,
    stoppedAt: base?.stoppedAt ?? null,
    running: { ...(base?.running ?? {}) },
  };
  if (event.agent) {
    for (const w of event.worktrees) r.seen[w] = (r.seen[w] ?? 0) + 1;
    r.worktree = mostSeen(r.seen);
  } else {
    r.worktree = event.cwdWorktree ?? r.worktree;
  }
  if (event.type === "start") {
    r.lastStart = at;
    r.stoppedAt = null;
    const key = event.id ?? `${event.tool ?? "?"}@${at}`;
    r.running[key] = { tool: event.tool, at, ...(event.command ? { command: event.command } : {}) };
    const keys = Object.keys(r.running).sort((a, b) =>
      String(r.running[a].at).localeCompare(String(r.running[b].at)),
    );
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_RUNNING))) delete r.running[k];
  } else if (event.type === "end") {
    r.lastEnd = at;
    if (event.id && r.running[event.id]) delete r.running[event.id];
    else {
      // No id to match: the oldest unfinished call of the same tool ends.
      const k = Object.keys(r.running)
        .filter((k) => r.running[k].tool === event.tool)
        .sort((a, b) => String(r.running[a].at).localeCompare(String(r.running[b].at)))[0];
      if (k) delete r.running[k];
    }
  } else {
    r.stoppedAt = at;
    r.running = {};
  }
  return r;
}

/**
 * The hook's heartbeat write for one input. Returns whether it wrote. Throws on
 * anything unreadable (the caller swallows it).
 * @param {any} input @param {NodeJS.ProcessEnv} env @param {number} now
 * @param {{ pid: number } | null} session the live session's record
 */
export function recordHeartbeat(input, env, now, session) {
  const name = env.RISA_SESSION_NAME;
  const pid = Number(env.RISA_SESSION_PID);
  const sessions = env.RISA_SESSIONS_DIR;
  if (!name || !pid || !sessions || !nameOk(name) || session?.pid !== pid) return false;
  const event = heartbeatEvent(input, dirname(sessions));
  if (!event) return false;
  const dir = join(heartbeatDirOf(sessions), name);
  const file = join(dir, `${event.agent ?? "session"}.json`);
  mkdirSync(dir, { recursive: true });
  updateRecord(file, (current) => {
    // A new session under this name: its old agents' records go.
    if (!event.agent && current && current.pid !== pid) {
      for (const f of readdirSync(dir))
        if (f.endsWith(".json") && f !== "session.json") rmSync(join(dir, f), { force: true });
    }
    return applyHeartbeat(current, event, { session: name, pid, now });
  });
  return true;
}

/**
 * Every heartbeat record of every session (each with `session` and `agent`), the
 * stale ones too; `live(session, pid)` filters.
 * @param {string} heartbeatDir
 * @param {(session: string, pid: number) => boolean} [live]
 */
export function readHeartbeats(heartbeatDir, live = () => true) {
  /** @type {any[]} */
  const out = [];
  /** @type {import("node:fs").Dirent[]} */
  let sessions;
  try {
    sessions = readdirSync(heartbeatDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const s of sessions) {
    /** @type {string[]} */
    let files;
    try {
      files = readdirSync(join(heartbeatDir, s.name)).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const r = JSON.parse(readFileSync(join(heartbeatDir, s.name, f), "utf8"));
        if (r && typeof r === "object" && live(s.name, r.pid)) out.push({ ...r, session: s.name });
      } catch {
        /* a record being written, or not one: skipped */
      }
    }
  }
  return out;
}
