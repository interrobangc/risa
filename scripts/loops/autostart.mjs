#!/usr/bin/env node
// pnpm prd autostart install|remove|status: the one per-user LaunchAgent that
// runs the watchdog (`pnpm prd watchdog`, watchdog.mjs) at login and every five
// minutes, from the main checkout. Nothing else installs it: only the user's
// own `pnpm prd autostart install`.
//
//   node autostart.mjs install --main DIR   write the plist and load it (a job
//       already loaded is unloaded first, so a second install changes nothing
//       but the PATH it found); RunAtLoad runs it once now, so a macOS
//       Automation prompt for iTerm2 shows while you're here
//   node autostart.mjs remove --main DIR    unload it and delete the plist
//   node autostart.mjs status --main DIR    installed and loaded, each tool the
//       job needs resolving on its PATH, the stay-down mark, the watchdog's
//       last decision and attempt; exit 1 when something is off
//
// The job: /bin/bash DIR/scripts/loops/prd.sh watchdog, in DIR, with a PATH of
// Node 24's folder first, then the folders of docker, gh, git, claude,
// osascript and pnpm as this shell finds them, then the system's. It keeps its
// child processes when it exits (AbandonProcessGroup: dev servers, tabs),
// loads only in a login (Aqua) session, and logs to DIR/.loops/.watchdog.log.
//
// launchd itself is the host layer's (host.mjs: the LaunchAgents folder and
// launchctl, each with its variable, both required under Vitest). Env:
// CARETOOK_NODE_BIN (the Node 24 to put first; default this one when it is 24,
// else nvm's newest v24).
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { HOST_TOOLS, launchd } from "./host.mjs";

export const LABEL = "com.caretook.prd-watchdog";
export const INTERVAL_SECS = 300;
/** The tools the job runs, besides node. */
export const TOOLS = ["docker", "gh", "git", "claude", ...HOST_TOOLS, "pnpm"];
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

const xml = (/** @type {string} */ s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/**
 * The plist's text. Pure.
 * @param {{ main: string, path: string, label?: string }} o
 */
export function plist({ main, path, label = LABEL }) {
  const s = (/** @type {string} */ v) => `<string>${xml(v)}</string>`;
  const log = join(main, ".loops", ".watchdog.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${s(label)}
  <key>ProgramArguments</key>
  <array>
    ${s("/bin/bash")}
    ${s(join(main, "scripts/loops/prd.sh"))}
    ${s("watchdog")}
  </array>
  <key>WorkingDirectory</key>
  ${s(main)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    ${s(path)}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${INTERVAL_SECS}</integer>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  ${s("Aqua")}
  <key>ProcessType</key>
  ${s("Background")}
  <key>StandardOutPath</key>
  ${s(log)}
  <key>StandardErrorPath</key>
  ${s(log)}
</dict>
</plist>
`;
}

/** The job's PATH: node's folder first, then each tool's, then the system's, no repeats. Pure. */
export function jobPath(/** @type {string} */ nodeDir, /** @type {(string | null)[]} */ toolDirs) {
  return [...new Set([nodeDir, ...toolDirs.filter((d) => d !== null), ...SYSTEM_PATH])].join(":");
}

/** The PATH value in a plist's text, or null. Pure. */
export function pathOf(/** @type {string} */ text) {
  const m = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
  return m
    ? m[1].replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&")
    : null;
}

/** NAME's full path on PATH (an executable file), or null. */
export function which(/** @type {string} */ name, /** @type {string} */ path) {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

/** The Node 24 binary to put first, or null. */
export function nodeBin(env = process.env) {
  if (env.CARETOOK_NODE_BIN) return env.CARETOOK_NODE_BIN;
  if (process.versions.node.split(".")[0] === "24") return process.execPath;
  const versions = join(env.NVM_DIR || join(homedir(), ".nvm"), "versions/node");
  const r = spawnSync(
    "bash",
    ["-c", 'ls -d "$1"/v24.*/bin/node 2>/dev/null | sort -V | tail -1', "_", versions],
    {
      encoding: "utf8",
    },
  );
  return r.stdout.trim() || null;
}

/** Where things go (the host layer's LaunchAgents): under Vitest the folder and launchctl must be given. */
export function where(env = process.env) {
  const agents = launchd(env);
  return { ...agents, file: agents.fileOf(LABEL) };
}

function install(/** @type {string} */ main, env = process.env) {
  const w = where(env);
  const node = nodeBin(env);
  if (!node) throw new Error("autostart: no Node 24 found (nvm install 24, or CARETOOK_NODE_BIN)");
  const found = TOOLS.map((t) => [t, which(t, env.PATH ?? "")]);
  const path = jobPath(
    dirname(node),
    found.map(([, p]) => (p ? dirname(p) : null)),
  );
  const text = plist({ main, path });
  mkdirSync(w.dir, { recursive: true });
  const same = existsSync(w.file) && readFileSync(w.file, "utf8") === text;
  if (!same) {
    writeFileSync(`${w.file}.tmp`, text);
    renameSync(`${w.file}.tmp`, w.file);
  }
  if (w.loaded(LABEL)) w.unload(LABEL);
  const r = w.load(w.file);
  if (!r.ok) throw new Error(`autostart: ${r.out}`);
  console.log(
    `${same ? "Reloaded" : "Installed"} ${w.file}: the watchdog runs at login and every ${INTERVAL_SECS / 60} minutes, from ${main}.`,
  );
  console.log("It runs once now: allow the macOS Automation prompt for iTerm2 if one shows.");
  const missing = found.filter(([, p]) => !p).map(([t]) => t);
  if (missing.length)
    console.log(
      `Not found on this PATH, so not on the job's: ${missing.join(", ")} (pnpm prd autostart status)`,
    );
  console.log("pnpm prd down --stay keeps everything down; pnpm prd autostart remove uninstalls it.");
}

function remove(env = process.env) {
  const w = where(env);
  const was = w.loaded(LABEL);
  if (was) w.unload(LABEL);
  const had = existsSync(w.file);
  rmSync(w.file, { force: true });
  rmSync(`${w.file}.tmp`, { force: true });
  console.log(
    had || was ? `Removed the watchdog's LaunchAgent (${w.file}).` : "No watchdog LaunchAgent was installed.",
  );
}

const readObject = (/** @type {string} */ p) => {
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

async function status(/** @type {string} */ main, env = process.env) {
  const w = where(env);
  let ok = true;
  if (!existsSync(w.file)) {
    console.log(`autostart: not installed (${w.file}); pnpm prd autostart install`);
    return false;
  }
  const isLoaded = w.loaded(LABEL);
  ok &&= isLoaded;
  console.log(
    `autostart: installed (${w.file}), ${isLoaded ? "loaded" : "NOT loaded: pnpm prd autostart install"}`,
  );
  const text = readFileSync(w.file, "utf8");
  const path = pathOf(text) ?? "";
  if (!text.includes(`<string>${xml(join(main, "scripts/loops/prd.sh"))}</string>`)) {
    ok = false;
    console.log(`  it runs another checkout's watchdog, not ${main}'s: pnpm prd autostart install`);
  }
  const node = which("node", path);
  const version = node ? spawnSync(node, ["-v"], { encoding: "utf8" }).stdout.trim() : "";
  if (!node || !/^v24\./.test(version)) {
    ok = false;
    console.log(
      `  node: ${node ? `${node} is ${version || "unknown"}, not Node 24` : "doesn't resolve on the job's PATH"}`,
    );
  } else console.log(`  node: ${node} (${version})`);
  for (const t of TOOLS) {
    const p = which(t, path);
    if (!p) ok = false;
    console.log(
      `  ${t}: ${p ?? "doesn't resolve on the job's PATH (install it, then pnpm prd autostart install)"}`,
    );
  }
  const loops = join(main, ".loops");
  const stay = readObject(join(loops, ".stay-down.json"));
  if (stay)
    console.log(
      `  stay-down since ${stay.at ?? "?"}${stay.why ? ` (${stay.why})` : ""}: nothing comes back until pnpm prd recover`,
    );
  const st = readObject(join(loops, ".watchdog.json"));
  if (st?.lastLine) console.log(`  last decision: ${st.lastLine}`);
  if (st?.lastAttempt)
    console.log(
      `  last recover: ${new Date(st.lastAttempt).toISOString()}${st.failures ? `, ${st.failures} failed in a row (backing off)` : ", succeeded"}`,
    );
  try {
    const { readUsage } = await import("./usage.mjs");
    if (readUsage(env.CARETOOK_USAGE_DIR || join(loops, ".usage"), { env }).spendLimit)
      console.log(
        "  a spend limit is configured: the watchdog won't recover while limited, but only turning extra usage off in the account fully guarantees no extra spend",
      );
  } catch {
    /* no reading */
  }
  return ok;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  let mainDir = "";
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--main") mainDir = argv[++i] ?? "";
    else throw new Error(`autostart: unknown argument ${argv[i]}`);
  }
  if (!mainDir) throw new Error("autostart: --main DIR (pnpm prd autostart passes it)");
  if (cmd === "install") install(mainDir);
  else if (cmd === "remove") remove();
  else if (cmd === "status") process.exit((await status(mainDir)) ? 0 : 1);
  else {
    console.error("usage: pnpm prd autostart install|remove|status");
    process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
