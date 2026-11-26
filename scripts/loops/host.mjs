#!/usr/bin/env node
// The host layer: the core's one door to the machine it runs on (today a Mac
// with iTerm2). No other core file calls osascript or launchctl (the boundary
// lint's host-call rule), so another host is this one file.
//
//   tabs           itermApp, canOpenTabs, openTab: a command in a new iTerm2 tab
//                  (osascript), the session opener's and the dispatcher's
//   notifications  notify: a macOS notification (osascript), the asks'
//   autostart      launchd: a per-user LaunchAgent loaded, unloaded or asked
//                  about (launchctl), autostart's
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
//
// Env: CARETOOK_ITERM_APP (default /Applications/iTerm.app: where iTerm2 is
// looked for); CARETOOK_LAUNCH_AGENTS_DIR (~/Library/LaunchAgents) and
// CARETOOK_LAUNCHCTL (launchctl), both required under Vitest, so no test
// reaches the real folder or launchd.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

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

// ---- tabs ------------------------------------------------------------------------

/** Where iTerm2 is looked for. */
export const itermApp = (env = process.env) => env.CARETOOK_ITERM_APP || "/Applications/iTerm.app";

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
  if (env.VITEST && (!env.CARETOOK_LAUNCH_AGENTS_DIR || !env.CARETOOK_LAUNCHCTL))
    throw new Error("host: a test must set CARETOOK_LAUNCH_AGENTS_DIR and CARETOOK_LAUNCHCTL");
  const dir = env.CARETOOK_LAUNCH_AGENTS_DIR || join(homedir(), "Library/LaunchAgents");
  const bin = env.CARETOOK_LAUNCHCTL || "launchctl";
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

// ---- the command line ------------------------------------------------------------

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, line, title, background, ...rest] = process.argv.slice(2);
  if (
    cmd !== "tab" ||
    line == null ||
    title == null ||
    !["0", "1"].includes(background ?? "") ||
    rest.length
  ) {
    console.error("usage: host.mjs tab <line> <title> <0|1>");
    process.exit(2);
  }
  if (!canOpenTabs()) {
    console.log(itermApp());
    process.exit(NO_TABS);
  }
  const r = openTab({ line, title, background: background === "1" });
  // osascript's own NO_TABS is still a failure, never "no tabs here".
  process.exit(r.ok ? 0 : r.code === NO_TABS ? 1 : r.code);
}
