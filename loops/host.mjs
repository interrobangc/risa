#!/usr/bin/env node
// The host layer: the core's one door to the machine it runs on (today a Mac
// with iTerm2, nvm, and the claude, codex and gh CLIs). No other core file
// calls osascript or launchctl, or runs claude, codex or gh (the boundary
// lint's host-call rule), so another host is this one file.
//
//   tabs           itermApp, canOpenTabs, openTab: a command in a new iTerm2 tab
//                  (osascript), the session opener's and the dispatcher's
//   notifications  notify: a macOS notification (osascript), the asks'
//   autostart      launchd: a per-user LaunchAgent loaded, unloaded or asked
//                  about (launchctl), autostart's
//   the CLIs       CLAUDE, CODEX, GH (their names), claudeBin and claudeName (the
//                  claude to run, and the name its processes show), gh: one gh
//                  command's { ok, out }
//   Node           nvmNode: the bin folder of nvm's newest Node of a version
//   Claude Code's files  where it keeps its own: the config folder (which one a
//                  claude gets: claudeChoiceFor, claudeEnv), the project
//                  transcripts and the trusted folders (hasConversation,
//                  folderTrusted), the session settings files (settingsFor), and
//                  the shape it hands a hook or status line (claudeInput)
//   HOST_TOOLS     the host's own commands a background job needs on its PATH
//
// A tab: the command goes to a tab it made (never "the current session"), in
// the current window, else (iTerm2 hidden, minimised, no key window) the first
// window, else a new window. In the background it neither activates iTerm2 nor
// leaves the new tab selected: the tab selected before stays selected.
//
// CLI (the shell callers'):
//   node host.mjs tab <line> <title> <0|1>   LINE in a new tab titled TITLE (1: in the
//       background). Exit 0 once opened; NO_TABS (3) when no tab can open here,
//       printing where iTerm2 was looked for; else osascript's failure (stderr kept).
//   node host.mjs claude|codex|gh <arg>…    runs that CLI (claude: claudeBin) with
//       this process's stdin, stdout and stderr; exits with its exit (127: not found).
//   node host.mjs node-dir <version>        prints the bin folder of nvm's newest
//       Node <version> (24, 24.22 or 24.22.3); exit 1 when nvm has none.
//   node host.mjs claude-session <kind> <main>   for session.sh: two lines, the
//       variable that gives the session's claude its config folder (`NAME=<dir>`:
//       export it; a bare `NAME`: unset it, for Claude Code's default; empty:
//       nothing names one, leave it as it is), then the settings file its kind
//       runs with (empty: none). Exit 2 on a machine config that doesn't load or
//       a bad RISA_CLAUDE_CONFIG_DIR.
//
// Env: RISA_CLAUDE_BIN (the claude to run; default claude: tests give a
// stub); NVM_DIR (default ~/.nvm); RISA_ITERM_APP (default /Applications/iTerm.app: where iTerm2 is
// looked for); RISA_CLAUDE_CONFIG_DIR (the Claude config folder every claude
// started here gets, above the machine config's and risa.json's);
// RISA_CLAUDE_PROJECTS and RISA_CLAUDE_CONFIG (tests: in place of the
// folder's projects and its .claude.json, only ever read); RISA_LAUNCH_AGENTS_DIR (~/Library/LaunchAgents) and
// RISA_LAUNCHCTL (launchctl), both required under Vitest, so no test
// reaches the real folder or launchd.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { constants as osConstants, homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The host's own commands, for a job that runs without a login shell's PATH. */
export const HOST_TOOLS = ["osascript"];
/** The CLI's exit when no tab can open here. */
export const NO_TABS = 3;

/** CMD's full path on ENV's PATH (an executable file), or null. */
export function onPath(/** @type {string} */ cmd, env = process.env) {
  for (const d of (env.PATH ?? "").split(delimiter)) {
    if (!d) continue;
    try {
      accessSync(join(d, cmd), constants.X_OK);
      return join(d, cmd);
    } catch {
      /* not here */
    }
  }
  return null;
}

/**
 * CMD ARGS in its own process group, bounded: "ok", "exit <n>", "timed out" or
 * "failed: <why>". At the limit the group is killed (a hook that hangs, and
 * anything it started).
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} seconds
 * @returns {Promise<string>}
 */
export const runBounded = (cmd, args, seconds) =>
  new Promise((resolve) => {
    /** @type {import("node:child_process").ChildProcess} */
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: ["ignore", "ignore", "inherit"] });
    } catch (e) {
      resolve(`failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-(/** @type {number} */ (child.pid)), "SIGKILL");
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

// ---- the CLIs --------------------------------------------------------------------

/** The CLIs' names, as a PATH lookup or a process list sees them. */
export const CLAUDE = "claude";
export const CODEX = "codex";
export const GH = "gh";
const CLIS = [CLAUDE, CODEX, GH];

/** The claude to run: a test's stub (Env, above), else claude. */
export const claudeBin = (env = process.env) => env.RISA_CLAUDE_BIN || CLAUDE;
/** The name claude's processes show: claudeBin's last part. */
export const claudeName = (env = process.env) => basename(claudeBin(env));

/**
 * One gh command, its stdin INPUT (else none), bounded by TIMEOUT ms: ok (exit
 * 0) and its stdout, trimmed.
 * @param {string[]} args
 * @param {{ cwd?: string, input?: string, timeout?: number }} [opts]
 * @returns {{ ok: boolean, out: string }}
 */
export function gh(args, { cwd, input, timeout = 120_000 } = {}) {
  const r = spawnSync(GH, args, {
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    input,
    timeout,
    cwd,
  });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

// ---- Node ------------------------------------------------------------------------

/** Version parts as numbers: "v24.22.3" → [24, 22, 3]. */
const versionOf = (/** @type {string} */ name) => name.slice(1).split(".").map(Number);
const byVersion = (/** @type {string} */ a, /** @type {string} */ b) => {
  const [x, y] = [versionOf(a), versionOf(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/**
 * The bin folder of nvm's newest installed Node WANT (24, 24.22 or 24.22.3), or null.
 * @param {string} want
 */
export function nvmNode(want, env = process.env) {
  const versions = join(env.NVM_DIR || join(homedir(), ".nvm"), "versions/node");
  const v = `v${String(want).replace(/^v/, "")}`;
  let names;
  try {
    names = readdirSync(versions);
  } catch {
    return null;
  }
  const newest = names
    .filter((n) => n === v || n.startsWith(`${v}.`))
    .filter((n) => existsSync(join(versions, n, "bin")))
    .sort(byVersion)
    .at(-1);
  return newest ? join(versions, newest, "bin") : null;
}

// ---- tabs ------------------------------------------------------------------------

/** Where iTerm2 is looked for. */
export const itermApp = (env = process.env) => env.RISA_ITERM_APP || "/Applications/iTerm.app";

/** Whether a tab can open here: iTerm2 is there and osascript on the PATH. */
export const canOpenTabs = (env = process.env) =>
  existsSync(itermApp(env)) && onPath("osascript", env) !== null;

// argv: the command, the tab's title, "1" for the background.
const TAB_SCRIPT = `on run argv
  set cmd to item 1 of argv
  set tabTitle to item 2 of argv
  set quiet to (item 3 of argv is "1")
  tell application "iTerm2"
    if not quiet then activate
    -- current window is missing value when iTerm2 is hidden, minimised or has
    -- no key window (B-468): then the first window, else a new window.
    set theWindow to missing value
    try
      set theWindow to current window
    end try
    if theWindow is missing value then
      try
        set theWindow to first window
      end try
    end if
    set newSession to missing value
    if theWindow is not missing value then
      set previousTab to missing value
      try
        set previousTab to current tab of theWindow
      end try
      try
        tell theWindow
          set newTab to (create tab with default profile)
        end tell
        set newSession to current session of newTab
      end try
      if quiet and previousTab is not missing value then
        try
          tell previousTab to select
        end try
      end if
    end if
    if newSession is missing value then
      set newWindow to (create window with default profile)
      set newSession to current session of newWindow
    end if
    tell newSession
      set name to tabTitle
      write text cmd
    end tell
  end tell
end run
`;

/**
 * LINE written to a new tab titled TITLE. The caller checks canOpenTabs first.
 * @param {{ line: string, title: string, background?: boolean }} tab
 * @returns {{ ok: boolean, code: number }} osascript's exit (stderr goes to ours)
 */
export function openTab({ line, title, background = false }, env = process.env) {
  const r = spawnSync("osascript", ["-", line, title, background ? "1" : "0"], {
    input: TAB_SCRIPT,
    stdio: ["pipe", "ignore", "inherit"],
    env,
  });
  const code = r.status ?? 1;
  return { ok: code === 0, code };
}

// ---- notifications ---------------------------------------------------------------

/**
 * A macOS notification, bounded by SECONDS: null when osascript isn't on the
 * PATH (nothing shown), else runBounded's result.
 * @param {string} title
 * @param {string} text
 */
export async function notify(title, text, seconds = 5, env = process.env) {
  const osascript = onPath("osascript", env);
  if (!osascript) return null;
  return runBounded(
    osascript,
    [
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e",
      "end run",
      title,
      text,
    ],
    seconds,
  );
}

// ---- autostart -------------------------------------------------------------------

/** The user's LaunchAgents: where a job's plist goes, and launchd's view of it. */
export function launchd(env = process.env) {
  if (env.VITEST && (!env.RISA_LAUNCH_AGENTS_DIR || !env.RISA_LAUNCHCTL))
    throw new Error("host: a test must set RISA_LAUNCH_AGENTS_DIR and RISA_LAUNCHCTL");
  const dir = env.RISA_LAUNCH_AGENTS_DIR || join(homedir(), "Library/LaunchAgents");
  const bin = env.RISA_LAUNCHCTL || "launchctl";
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const domain = `gui/${uid}`;
  const call = (/** @type {string[]} */ args) =>
    spawnSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    dir,
    domain,
    /** The plist's path for LABEL. */
    fileOf: (/** @type {string} */ label) => join(dir, `${label}.plist`),
    /** Whether LABEL's job is loaded. */
    loaded: (/** @type {string} */ label) => call(["print", `${domain}/${label}`]).status === 0,
    /** Load the job in FILE: { ok, out } (on a failure, what failed and launchctl's message). */
    load: (/** @type {string} */ file) => {
      const r = call(["bootstrap", domain, file]);
      const ok = r.status === 0;
      return { ok, out: ok ? "" : `launchctl bootstrap failed: ${(r.stderr || r.stdout || "").trim()}` };
    },
    /** Unload LABEL's job (nothing loaded is no error). */
    unload: (/** @type {string} */ label) => {
      call(["bootout", `${domain}/${label}`]);
    },
  };
}

// ---- Claude Code's files ---------------------------------------------------------
//
// Which config folder a claude gets, first found wins: RISA_CLAUDE_CONFIG_DIR, the
// machine config's entry for the repo (machine.mjs: one folder, or one per role with
// an optional `default`), risa.json's `claude.configDir`, else Claude Code's own
// default (~/.claude). A source that names folders only for other roles gives this
// role the default, so CLAUDE_CONFIG_DIR is unset rather than inherited; with no
// source at all the environment is left as it is. The folder holds the account, its
// transcripts and its .claude.json, so the usage and context readings follow it.

/** The variable that names the folder for every claude started here. */
export const CONFIG_DIR_VAR = "RISA_CLAUDE_CONFIG_DIR";
/** Claude Code's own variable for it. */
const CLAUDE_DIR = "CLAUDE_CONFIG_DIR";

/** The role a session kind runs as (the machine config's per-role keys). */
export const roleOfKind = (/** @type {string} */ kind) =>
  kind === "prd" ? "orchestrator" : kind === "plan" ? "planner" : kind;

/** A folder value: absolute, or `~/…` from the home; else null. */
const folderOf = (/** @type {unknown} */ v, env = process.env) => {
  if (typeof v !== "string" || !v.trim()) return null;
  const p = v.startsWith("~/") ? join(env.HOME || homedir(), v.slice(2)) : v;
  return isAbsolute(p) && !/[\n\r\t]/.test(p) ? resolve(p) : null;
};

/**
 * @typedef {{ dir: string | null, from: string }} ClaudeChoice dir null: Claude
 *   Code's default; from: which source decided, in words
 */

/**
 * The config folder from its sources, first found wins. Null when none names one.
 * Pure. Throws on a RISA_CLAUDE_CONFIG_DIR that isn't an absolute path.
 * @param {{ env?: Record<string, string | undefined>, machine?: string | null, project?: unknown }} sources
 *   machine: the machine config's folder for this repo and role (claudeConfigDirOf),
 *   null when it names folders only for other roles, undefined when it names none;
 *   project: risa.json's claude.configDir
 * @returns {ClaudeChoice | null}
 */
export function claudeConfigDir({ env = process.env, machine, project } = {}) {
  const set = env[CONFIG_DIR_VAR];
  if (set) {
    const dir = folderOf(set, env);
    if (!dir) throw new Error(`${CONFIG_DIR_VAR} must be an absolute path (it is ${set})`);
    return { dir, from: CONFIG_DIR_VAR };
  }
  if (machine !== undefined) return { dir: machine && resolve(machine), from: "the machine config" };
  const dir = folderOf(project, env);
  return dir ? { dir, from: "risa.json's claude.configDir" } : null;
}

const require = createRequire(import.meta.url);
/** A sibling module, synchronously; null when this copy of the host layer has none beside it. */
const sibling = (/** @type {string} */ name) => {
  try {
    return require(name);
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") return null;
    throw e;
  }
};

/**
 * The config folder for a claude started for MAIN's repo as ROLE, its sources read
 * now. Throws on a machine config that doesn't load.
 * @param {{ main?: string | null, role?: string, env?: Record<string, string | undefined> }} at
 * @returns {ClaudeChoice | null}
 */
export function claudeChoiceFor({ main, role, env = process.env } = {}) {
  if (env[CONFIG_DIR_VAR]) return claudeConfigDir({ env });
  const machineMod = sibling("./machine.mjs");
  const entry = main && machineMod ? machineMod.repoEntry(machineMod.loadMachineConfig({ env }), main) : null;
  let project;
  try {
    project = sibling("./config.mjs")?.loadConfig({ env }).config.claude?.configDir;
  } catch {
    /* no project config here: it names none */
  }
  return claudeConfigDir({
    env,
    machine: entry?.claudeConfigDir ? machineMod.claudeConfigDirOf(entry, role) : undefined,
    project,
  });
}

/**
 * ENV for a claude given CHOICE: CLAUDE_CONFIG_DIR set to its folder, unset for
 * Claude Code's default, and left as it is when nothing names one.
 * @param {Record<string, string | undefined>} env @param {ClaudeChoice | null} choice
 */
export function claudeEnv(env, choice) {
  const out = { ...env };
  if (!choice) return out;
  if (choice.dir) out[CLAUDE_DIR] = choice.dir;
  else delete out[CLAUDE_DIR];
  return out;
}

/** The same as the start of a shell command line (`CLAUDE_CONFIG_DIR=… `, `env -u … `, or ""). */
export const claudeEnvPrefix = (/** @type {ClaudeChoice | null} */ choice) =>
  !choice ? "" : choice.dir ? `${CLAUDE_DIR}=${shWord(choice.dir)} ` : `env -u ${CLAUDE_DIR} `;

/** A word safe in a shell line as is, else single-quoted. */
const shWord = (/** @type {string} */ s) =>
  /^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

/** The config folder a claude with ENV uses. */
export const claudeHome = (env = process.env) => env[CLAUDE_DIR] || join(homedir(), ".claude");

/**
 * The account a claude with ENV reads and spends: its config folder when it isn't
 * Claude Code's default, else null (the default account).
 */
export function claudeAccount(env = process.env) {
  const set = env[CLAUDE_DIR];
  if (!set) return null;
  const dir = resolve(set);
  return dir === join(homedir(), ".claude") ? null : dir;
}

/** Where a claude with ENV keeps its project transcripts. */
export const claudeProjects = (env = process.env) =>
  env.RISA_CLAUDE_PROJECTS || join(claudeHome(env), "projects");

/** The global state file (.claude.json: trusted folders) of a claude with ENV. */
export const claudeState = (env = process.env) =>
  env.RISA_CLAUDE_CONFIG ||
  (env[CLAUDE_DIR] ? join(env[CLAUDE_DIR], ".claude.json") : join(homedir(), ".claude.json"));

/** Claude Code's projects folder name for a working directory. */
export const projectFolder = (/** @type {string} */ dir) => dir.replace(/[^A-Za-z0-9]/g, "-");

/** Whether DIR has a saved Claude conversation under PROJECTS. */
export function hasConversation(/** @type {string} */ dir, projects = claudeProjects()) {
  const folder = join(projects, projectFolder(dir));
  if (!existsSync(folder)) return false;
  return readdirSync(folder).some((f) => f.endsWith(".jsonl"));
}

/** Whether STATE (a .claude.json) marks DIR, or a folder above it, trusted. Only read. */
export function folderTrusted(/** @type {string} */ dir, state = claudeState()) {
  /** @type {Record<string, { hasTrustDialogAccepted?: boolean }>} */
  let known;
  try {
    known = JSON.parse(readFileSync(state, "utf8")).projects ?? {};
  } catch {
    return false;
  }
  for (let d = dir; ; d = dirname(d)) {
    if (known[d]?.hasTrustDialogAccepted === true) return true;
    if (dirname(d) === d) return false;
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * The settings file a session of KIND runs with (claude --settings), or null: the
 * context hook and the usage status line for orchestrators, planners and backlog sessions,
 * and the inbox session's own (one --settings: its effort and fast mode as well).
 */
export function settingsFor(/** @type {string} */ kind) {
  if (kind === "prd" || kind === "plan" || kind === "backlog") return join(HERE, "context-settings.json");
  if (kind === "inbox") return join(HERE, "inbox-settings.json");
  return null;
}

/** The status line's windows: Claude Code's key, and ours. */
const RATE_WINDOWS = /** @type {const} */ ([
  ["five_hour", "fiveHour"],
  ["seven_day", "sevenDay"],
  ["spend_limit", "spend"],
]);

/**
 * A hook's or status line's input as Claude Code hands it, in our words; null for
 * anything that isn't a JSON object. Fields it lacks are null (windows: those it has,
 * their values as given). Pure. The shapes, confirmed against Claude Code 2.1.331:
 *   every hook   session_id, transcript_path, cwd, hook_event_name; a subagent's call
 *                agent_id, agent_type, agent_transcript_path?
 *   tool hooks   tool_name, tool_input, tool_use_id
 *   StopFailure  error (authentication_failed, billing_error, rate_limit, overloaded,
 *                server_error, unknown, …), error_details?: no reset time of its own
 *   status line  session_id, transcript_path, cwd, model, …, rate_limits?: { five_hour?:
 *                { used_percentage, resets_at }, seven_day?, spend_limit?: { …, used_usd?,
 *                limit_usd?, period? } }, resets_at in Unix seconds; only for a subscriber
 *                (or a gateway with a spend limit), after the first API response
 * @param {unknown} input the raw text or the parsed value
 */
export function claudeInput(input) {
  let v = input;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = /** @type {any} */ (v);
  const str = (/** @type {unknown} */ x) => (typeof x === "string" ? x : null);
  const rl = o.rate_limits && typeof o.rate_limits === "object" ? o.rate_limits : null;
  /** @type {Record<string, { percent: unknown, resetsAt: unknown, usedUsd: unknown, limitUsd: unknown, period: unknown }>} */
  const windows = {};
  for (const [key, name] of RATE_WINDOWS) {
    const w = rl?.[key];
    if (w && typeof w === "object")
      windows[name] = {
        percent: w.used_percentage,
        resetsAt: w.resets_at,
        usedUsd: w.used_usd,
        limitUsd: w.limit_usd,
        period: w.period,
      };
  }
  return {
    event: str(o.hook_event_name),
    sessionId: str(o.session_id),
    cwd: str(o.cwd),
    transcript: str(o.transcript_path),
    /** The subagent's id, its `agent-` cut off; "" for the session itself. */
    agent: o.agent_id == null ? "" : String(o.agent_id).replace(/^agent-/, ""),
    agentType: str(o.agent_type) || null,
    agentTranscript: str(o.agent_transcript_path),
    tool: str(o.tool_name),
    toolInput: o.tool_input,
    toolUseId: str(o.tool_use_id) || null,
    error: str(o.error),
    errorDetails: str(o.error_details),
    /** Reset times a StopFailure may carry, as given (no documented one). */
    resets: [o.resets_at, rl?.resets_at],
    windows,
  };
}

// ---- the command line ------------------------------------------------------------

/**
 * CLI ARGS run with this process's stdio: its exit, 127 when it can't start,
 * 128 + the signal's number when one ended it.
 * @param {string} cli claude, codex or gh
 * @param {string[]} args
 */
function runCli(cli, args, env = process.env) {
  let run = env;
  try {
    if (cli === CLAUDE) run = claudeEnv(env, claudeChoiceFor({ main: mainOf(process.cwd()), env }));
  } catch (e) {
    console.error(`host: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const r = spawnSync(cli === CLAUDE ? claudeBin(env) : cli, args, { stdio: "inherit", env: run });
  if (r.error) {
    console.error(`host: ${cli}: ${r.error.message}`);
    return 127;
  }
  if (r.signal) return 128 + (osConstants.signals[r.signal] ?? 0);
  return r.status ?? 1;
}

/** The main checkout of DIR's repo (its first worktree), or null outside one. */
function mainOf(/** @type {string} */ dir) {
  const r = spawnSync("git", ["-C", dir, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.status === 0 ? r.stdout.split("\n")[0]?.replace(/^worktree /, "") || null : null;
}

/** session.sh's two lines for a session of KIND in MAIN's repo (the CLI's claude-session). */
export function sessionLines(/** @type {string} */ kind, /** @type {string} */ main, env = process.env) {
  const choice = claudeChoiceFor({ main, role: roleOfKind(kind), env });
  const set = !choice ? "" : choice.dir ? `${CLAUDE_DIR}=${choice.dir}` : CLAUDE_DIR;
  return `${set}\n${settingsFor(kind) ?? ""}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, line, title, background, ...rest] = process.argv.slice(2);
  const usage = () => {
    console.error(
      "usage: host.mjs tab <line> <title> <0|1> | claude|codex|gh <arg>… | node-dir <version> | claude-session <kind> <main>",
    );
    process.exit(2);
  };
  if (cmd && CLIS.includes(cmd)) process.exit(runCli(cmd, process.argv.slice(3)));
  if (cmd === "claude-session") {
    if (!line || !title || background !== undefined) usage();
    try {
      // exitCode, not exit: the lines reach a pipe before the process ends.
      process.stdout.write(sessionLines(/** @type {string} */ (line), /** @type {string} */ (title)));
    } catch (e) {
      console.error(`host: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 2;
    }
  } else if (cmd === "node-dir") {
    if (!line || title !== undefined) usage();
    const dir = nvmNode(/** @type {string} */ (line));
    // exitCode, not exit: the line reaches a pipe before the process ends.
    if (dir) console.log(dir);
    process.exitCode = dir ? 0 : 1;
  } else {
    if (
      cmd !== "tab" ||
      line == null ||
      title == null ||
      !["0", "1"].includes(background ?? "") ||
      rest.length
    )
      usage();
    if (!canOpenTabs()) {
      console.log(itermApp());
      process.exit(NO_TABS);
    }
    const r = openTab({
      line: /** @type {string} */ (line),
      title: /** @type {string} */ (title),
      background: background === "1",
    });
    // osascript's own NO_TABS is still a failure, never "no tabs here".
    process.exit(r.ok ? 0 : r.code === NO_TABS ? 1 : r.code);
  }
}
