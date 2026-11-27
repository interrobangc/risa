// The worker reader: each worker's facts, for `prd status` and the watch.
// A worker is a worktree under the main checkout's .loops with what works in it:
//
//   agents     its heartbeat records (heartbeat.mjs) of live sessions: each agent's
//              first and last call, its stop, its started and unfinished calls
//   running    the commands under way: each unfinished call, and each live process
//              whose working directory is in the worktree (a background command;
//              never this reader's own ancestors, a claude process or a login shell)
//   leases     the machine leases it holds or queues for (lease.sh's name files)
//   progress   its last commit and its tracked or unignored changed files (git
//              status, untracked included, ignored ones never): a change to an
//              ignored file (a cache, a log) is not progress
//
// A slice worktree no agent's heartbeat names has `unknown: true`: the watch then
// goes by commits and files alone and never restarts it.
//
// Pure: factsOf (the facts from what was gathered). The gatherers: readLeases,
// gitProgress, processCwds, and workerFacts, which runs them all.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { heartbeatDirOf, readHeartbeats } from "./heartbeat.mjs";
import { parseEtime } from "./sessions.mjs";
import { branchKinds } from "./config.mjs";

const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
const latest = (/** @type {(string | null | undefined)[]} */ times) => {
  const ms = times.map((t) => Date.parse(t ?? "")).filter((n) => !Number.isNaN(n));
  return ms.length ? iso(Math.max(...ms)) : null;
};

/** A lease's name file (key=value lines), or null. */
function leaseFields(/** @type {string} */ file) {
  try {
    /** @type {Record<string, string>} */
    const f = {};
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) f[line.slice(0, i)] = line.slice(i + 1);
    }
    return f;
  } catch {
    return null;
  }
}

const pidAlive = (/** @type {number} */ pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
};

/**
 * Every lease held or queued for, of every kind under ROOT (each kind's own folder,
 * `browserRoot` for the browser kind when it's moved): { kind, n (null while
 * waiting), waiting, worktree, what, pid, started (ISO), live }.
 * @param {string} root @param {{ browserRoot?: string, alive?: (pid: number) => boolean }} [opts]
 */
export function readLeases(root, { browserRoot, alive = pidAlive } = {}) {
  /** @type {[string, string][]} */
  const kinds = [];
  try {
    for (const d of readdirSync(root, { withFileTypes: true }))
      if (d.isDirectory() && !d.name.startsWith(".") && !(browserRoot && d.name === "browser"))
        kinds.push([d.name, join(root, d.name)]);
  } catch {
    /* no leases yet */
  }
  if (browserRoot) kinds.push(["browser", browserRoot]);
  const out = [];
  for (const [kind, dir] of kinds) {
    /** @type {[string, string, boolean][]} */
    const slots = [];
    try {
      for (const n of readdirSync(dir)) if (/^\d+$/.test(n)) slots.push([n, join(dir, n, "name"), false]);
    } catch {
      continue;
    }
    try {
      for (const p of readdirSync(join(dir, ".waiting")))
        slots.push([p, join(dir, ".waiting", p, "name"), true]);
    } catch {
      /* nobody waiting */
    }
    for (const [n, file, waiting] of slots) {
      const f = leaseFields(file);
      if (!f) continue;
      const pid = Number(f.pid) || 0;
      const started = Number(f.started);
      out.push({
        kind: f.kind || kind,
        n: waiting ? null : Number(n),
        waiting,
        worktree: f.worktree || "?",
        what: (f.check || "").replace(/ \(waiting for a lease\)$/, ""),
        pid,
        started: Number.isFinite(started) && started > 0 ? iso(started * 1000) : null,
        live: alive(pid),
      });
    }
  }
  return out;
}

const git = (/** @type {string} */ dir, /** @type {string[]} */ args) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/**
 * A worktree's progress: its branch, last commit and its tracked or unignored changed
 * files, with the latest change's time (a deleted file's: its folder's). Ignored
 * files never show.
 * @param {string} dir
 * @returns {{ branch: string, lastCommitAt: string | null, changes: string[], lastChangeAt: string | null }}
 */
export function gitProgress(dir) {
  let branch = "";
  let lastCommitAt = null;
  try {
    branch = git(dir, ["branch", "--show-current"]).trim();
  } catch {
    /* not a worktree */
  }
  try {
    const ct = Number(git(dir, ["log", "-1", "--format=%ct"]).trim());
    if (ct > 0) lastCommitAt = iso(ct * 1000);
  } catch {
    /* no commit */
  }
  /** @type {string[]} */
  const changes = [];
  let lastChangeMs = 0;
  try {
    const out = git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const parts = out.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      if (entry.length < 4) continue;
      const path = entry.slice(3);
      // A rename's source follows it.
      if (entry[0] === "R" || entry[0] === "C") i++;
      changes.push(path);
      for (const p of [join(dir, path), dirname(join(dir, path))]) {
        try {
          lastChangeMs = Math.max(lastChangeMs, statSync(p).mtimeMs);
          break;
        } catch {
          /* deleted: its folder's time */
        }
      }
    }
  } catch {
    /* unreadable: no changes known */
  }
  return { branch, lastCommitAt, changes, lastChangeAt: lastChangeMs ? iso(lastChangeMs) : null };
}

/**
 * Every process, with its parent, age, command and working directory (Linux's /proc,
 * else lsof; null when unreadable). Empty when ps fails.
 * @returns {{ pid: number, ppid: number, cwd: string | null, ageSeconds: number | null, command: string }[]}
 */
export function processCwds() {
  /** @type {Map<number, { ppid: number, ageSeconds: number | null, command: string }>} */
  const table = new Map();
  try {
    const out = execFileSync("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "etime=", "-o", "args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (m) table.set(Number(m[1]), { ppid: Number(m[2]), ageSeconds: parseEtime(m[3]), command: m[4] });
    }
  } catch {
    return [];
  }
  /** @type {Map<number, string>} */
  const cwds = new Map();
  if (existsSync("/proc/self/cwd")) {
    for (const pid of table.keys()) {
      try {
        cwds.set(pid, execFileSync("readlink", [`/proc/${pid}/cwd`], { encoding: "utf8" }).trim());
      } catch {
        /* gone, or not ours */
      }
    }
  } else {
    try {
      const out = execFileSync("lsof", ["-a", "-d", "cwd", "-Fpn"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 16 * 1024 * 1024,
      });
      let pid = 0;
      for (const line of out.split("\n")) {
        if (line[0] === "p") pid = Number(line.slice(1));
        else if (line[0] === "n" && pid) cwds.set(pid, line.slice(1));
      }
    } catch (e) {
      // lsof exits 1 when it can't read some processes; what it printed still counts.
      const out = /** @type {any} */ (e).stdout;
      if (typeof out === "string") {
        let pid = 0;
        for (const line of out.split("\n")) {
          if (line[0] === "p") pid = Number(line.slice(1));
          else if (line[0] === "n" && pid) cwds.set(pid, line.slice(1));
        }
      }
    }
  }
  return [...table].map(([pid, p]) => ({ pid, ...p, cwd: cwds.get(pid) ?? null }));
}

/** Whether a process is one a worktree's live command can't be: claude itself or a login shell. */
const notACommand = (/** @type {string} */ command) => {
  const first = command.split(/\s+/)[0] ?? "";
  return first.startsWith("-") || /(^|\/)claude$/.test(first) || /(^|\/)(zsh|bash|sh|fish)$/.test(command);
};

/**
 * The facts, from what was gathered. Pure.
 * @param {{
 *   worktrees: { name: string, dir: string, branch: string, lastCommitAt: string | null,
 *     changes: string[], lastChangeAt: string | null }[],
 *   heartbeats: any[],
 *   leases: ReturnType<typeof readLeases>,
 *   processes: ReturnType<typeof processCwds>,
 *   self?: number[],
 *   now: number,
 * }} gathered `self`: this reader's pid and its ancestors, never counted
 */
export function factsOf({ worktrees, heartbeats, leases, processes, self = [], now }) {
  const skip = new Set(self);
  return worktrees.map((w) => {
    const agents = heartbeats
      .filter((h) => h.worktree === w.name)
      .map((h) => ({
        session: h.session,
        agent: h.agent ?? null,
        agentType: h.agentType ?? null,
        firstAt: h.firstAt ?? null,
        lastActivityAt: latest([h.lastStart, h.lastEnd, h.stoppedAt]),
        stoppedAt: h.stoppedAt ?? null,
        running: Object.entries(h.running ?? {}).map(([id, c]) => ({ id, .../** @type {any} */ (c) })),
      }));
    const calls = agents.flatMap((a) =>
      a.running.map((c) => ({
        source: "call",
        session: a.session,
        agent: a.agent,
        tool: c.tool ?? null,
        command: c.command ?? null,
        since: c.at ?? null,
      })),
    );
    const live = processes
      .filter(
        (p) =>
          !skip.has(p.pid) &&
          p.cwd &&
          (p.cwd === w.dir || p.cwd.startsWith(`${w.dir}/`)) &&
          !notACommand(p.command),
      )
      .map((p) => ({
        source: "process",
        pid: p.pid,
        command: p.command.slice(0, 200),
        since: p.ageSeconds === null ? null : iso(now - p.ageSeconds * 1000),
      }));
    const held = leases.filter((l) => l.live && l.worktree === w.name);
    const lastProgressAt = latest([w.lastCommitAt, w.lastChangeAt]);
    const isSlice = branchKinds().is(w.branch, "slice");
    return {
      name: w.name,
      dir: w.dir,
      branch: w.branch,
      agents,
      unknown: isSlice && !agents.some((a) => a.agent),
      lastActivityAt: latest(agents.map((a) => a.lastActivityAt)),
      stopped: agents.length > 0 && agents.every((a) => a.stoppedAt && a.running.length === 0),
      running: [...calls, ...live],
      leases: held,
      lastCommitAt: w.lastCommitAt,
      changes: w.changes,
      lastChangeAt: w.lastChangeAt,
      lastProgressAt,
    };
  });
}

/** PID and its ancestors, from a process list. */
export function ancestorsOf(/** @type {number} */ pid, /** @type {{ pid: number, ppid: number }[]} */ table) {
  const parent = new Map(table.map((p) => [p.pid, p.ppid]));
  const out = [];
  for (let p = pid, n = 0; p > 1 && n < 64; p = parent.get(p) ?? 0, n++) out.push(p);
  return out;
}

/** PID, its ancestors and its parent's other children (the rest of its pipeline). */
export function selfOf(/** @type {number} */ pid, /** @type {{ pid: number, ppid: number }[]} */ table) {
  const up = ancestorsOf(pid, table);
  const parent = up[1];
  return [...up, ...(parent ? table.filter((p) => p.ppid === parent).map((p) => p.pid) : [])];
}

/**
 * Every worker's facts, gathered.
 * @param {{ loops: string, sessionsDir: string, leaseRoot?: string, browserRoot?: string,
 *   live?: (session: string, pid: number) => boolean, processes?: ReturnType<typeof processCwds>,
 *   now?: number }} where `live`: whether a heartbeat's session is the live one (default: all)
 */
export function workerFacts({
  loops,
  sessionsDir,
  leaseRoot = join(loops, ".lease"),
  browserRoot,
  live,
  processes,
  now = Date.now(),
}) {
  /** @type {Parameters<typeof factsOf>[0]["worktrees"]} */
  const worktrees = [];
  try {
    for (const d of readdirSync(loops, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith(".")) continue;
      const dir = join(loops, d.name);
      if (!existsSync(join(dir, ".git"))) continue;
      worktrees.push({ name: d.name, dir, ...gitProgress(dir) });
    }
  } catch {
    /* no .loops */
  }
  const procs = processes ?? (worktrees.length ? processCwds() : []);
  return factsOf({
    worktrees,
    heartbeats: readHeartbeats(heartbeatDirOf(sessionsDir), live),
    leases: readLeases(leaseRoot, { browserRoot }),
    processes: procs,
    self: selfOf(process.pid, procs),
    now,
  });
}
