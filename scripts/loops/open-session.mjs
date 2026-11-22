// The session opener's choice (open-session.sh launches it): given a prd or plan
// worktree, the command that brings its session back, started through
// session.sh so it is recorded (.loops/.sessions/<session>.json).
//
//   - a saved Claude conversation for that path (a *.jsonl transcript in
//     ~/.claude/projects/<path with every non-alphanumeric as ->):
//       cd <dir> && <this checkout>/scripts/loops/session.sh <session> [--auto] [--managed] -- --continue --remote-control <session>
//   - otherwise a fresh session with the resume prompt:
//       prd:  cd <dir> && scripts/loops/session.sh prd-<topic> [--auto] [--managed] -- --remote-control prd-<topic> \
//               "$(scripts/loops/prompt.sh orchestrator <topic> --resume [--auto])"
//       plan: cd <dir> && scripts/loops/session.sh plan-<topic> [--auto] [--managed] -- --model fable --remote-control plan-<topic> \
//               "$(scripts/loops/prompt.sh plan <topic> [--auto])"
//
// Run-through (--auto) is the plan's _Status_ saying so, or the session's last
// record having been run-through (carried over to the new record); a run-through
// planner is the unattended one (prompt.sh plan --auto). `managed` (the
// dispatcher started it) is carried over from the record the same way. A record
// marked `rotating` (a rotation cut short) always gets a fresh session, never
// --continue, so the long conversation it was replacing doesn't come back.
//
// session.sh is named by absolute path from the checkout running the opener, so
// a worktree older than the wrapper (not yet synced with dev) still reopens.
//
// The session names stay prd-<topic> and plan-<topic>, so Remote Control still
// reaches them.
//
// CLI: node open-session.mjs <worktree dir>  → JSON {session, kind, topic, mode, auto, managed, command}
// Env: CARETOOK_CLAUDE_PROJECTS (tests: in place of ~/.claude/projects);
// CARETOOK_SESSIONS_DIR (default .sessions beside the worktree).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readRecord } from "./sessions.mjs";

/** Claude Code's projects folder name for a working directory. */
export const projectFolder = (/** @type {string} */ dir) => dir.replace(/[^A-Za-z0-9]/g, "-");

/** Whether DIR has a saved Claude conversation under PROJECTS. */
export function hasConversation(/** @type {string} */ dir, /** @type {string} */ projects) {
  const folder = join(projects, projectFolder(dir));
  if (!existsSync(folder)) return false;
  return readdirSync(folder).some((f) => f.endsWith(".jsonl"));
}

/** Whether a plan's _Status_ section records the run-through landing mode. */
export function runThrough(/** @type {string} */ planText) {
  const m = /^## Status[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(planText);
  if (!m) return false;
  return /landing mode:?\s*run (everything|it|all) through/i.test(m[1].replace(/[*_`]/g, ""));
}

/** A word safe in a shell line as is, else single-quoted. */
const sh = (/** @type {string} */ s) =>
  /^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

/** The wrapper beside this file: the opener's own checkout, which every worktree may not have yet. */
const ownSessionSh = fileURLToPath(new URL("./session.sh", import.meta.url));

/**
 * @param {{ dir: string, branch: string, conversation: boolean, runThrough: boolean,
 *   record?: { auto?: boolean, managed?: boolean, rotating?: boolean } | null, wrapper?: string }} w
 * @returns {{ session: string, kind: "prd" | "plan", topic: string, mode: "continue" | "fresh", auto: boolean,
 *   managed: boolean, command: string }}
 */
export function chooseCommand({
  dir,
  branch,
  conversation,
  runThrough: statusAuto,
  record = null,
  wrapper = ownSessionSh,
}) {
  const m = /^(prd|plan)\/(.+)$/.exec(branch);
  if (!m)
    throw new Error(`${dir} is on ${branch || "no branch"}: only prd/ and plan/ worktrees have sessions`);
  const kind = /** @type {"prd" | "plan"} */ (m[1]);
  const topic = m[2];
  const session = `${kind}-${topic}`;
  const auto = statusAuto || record?.auto === true;
  const managed = record?.managed === true;
  const wrap = `cd ${sh(dir)} && ${sh(wrapper)} ${session}${auto ? " --auto" : ""}${managed ? " --managed" : ""} -- `;
  if (conversation && !record?.rotating)
    return {
      session,
      kind,
      topic,
      mode: "continue",
      auto,
      managed,
      command: `${wrap}--continue --remote-control ${session}`,
    };
  const prompt =
    kind === "prd"
      ? `scripts/loops/prompt.sh orchestrator ${sh(topic)} --resume${auto ? " --auto" : ""}`
      : `scripts/loops/prompt.sh plan ${sh(topic)}${auto ? " --auto" : ""}`;
  return {
    session,
    kind,
    topic,
    mode: "fresh",
    auto,
    managed,
    // A fresh planner runs on fable, as `pnpm prd plan` starts it (prd.sh's agent_model).
    command: `${wrap}${kind === "plan" ? "--model fable " : ""}--remote-control ${session} "$(${prompt})"`,
  };
}

/** Reads the worktree's facts (branch, transcript, plan, session record) and chooses. */
export function chooseFor(
  /** @type {string} */ dir,
  projects = defaultProjects(),
  sessions = process.env.CARETOOK_SESSIONS_DIR || join(dirname(dir), ".sessions"),
) {
  const branch = execFileSync("git", ["-C", dir, "branch", "--show-current"], { encoding: "utf8" }).trim();
  const kind = branch.split("/")[0];
  const topic = branch.replace(/^(prd|plan)\//, "");
  const plan = join(dir, "plans", `${topic}-plan.md`);
  return chooseCommand({
    dir,
    branch,
    conversation: hasConversation(dir, projects),
    runThrough: existsSync(plan) && runThrough(readFileSync(plan, "utf8")),
    record: kind === "prd" || kind === "plan" ? readRecord(sessions, `${kind}-${topic}`) : null,
  });
}

const defaultProjects = () => process.env.CARETOOK_CLAUDE_PROJECTS || join(homedir(), ".claude", "projects");

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: open-session.mjs <worktree dir>");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(chooseFor(dir)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
