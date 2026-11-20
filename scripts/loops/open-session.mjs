// The session opener's choice (open-session.sh launches it): given a prd or plan
// worktree, the command that brings its session back.
//
//   - a saved Claude conversation for that path (a *.jsonl transcript in
//     ~/.claude/projects/<path with every non-alphanumeric as ->):
//       cd <dir> && claude --continue --remote-control <session>
//   - otherwise a fresh session with the resume prompt:
//       prd:  claude --remote-control prd-<topic> "$(scripts/loops/prompt.sh orchestrator <topic> --resume [--auto])"
//             (--auto when the plan's _Status_ records run-through)
//       plan: claude --remote-control plan-<topic> "$(scripts/loops/prompt.sh plan <topic>)"
//
// The session names stay prd-<topic> and plan-<topic>, so Remote Control still
// reaches them.
//
// CLI: node open-session.mjs <worktree dir>  → JSON {session, kind, topic, mode, command}
// Env: CARETOOK_CLAUDE_PROJECTS (tests: in place of ~/.claude/projects).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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

/**
 * @param {{ dir: string, branch: string, conversation: boolean, runThrough: boolean }} w
 * @returns {{ session: string, kind: "prd" | "plan", topic: string, mode: "continue" | "fresh", command: string }}
 */
export function chooseCommand({ dir, branch, conversation, runThrough: auto }) {
  const m = /^(prd|plan)\/(.+)$/.exec(branch);
  if (!m)
    throw new Error(`${dir} is on ${branch || "no branch"}: only prd/ and plan/ worktrees have sessions`);
  const kind = /** @type {"prd" | "plan"} */ (m[1]);
  const topic = m[2];
  const session = `${kind}-${topic}`;
  const cd = `cd ${sh(dir)} && `;
  if (conversation)
    return {
      session,
      kind,
      topic,
      mode: "continue",
      command: `${cd}claude --continue --remote-control ${session}`,
    };
  const prompt =
    kind === "prd"
      ? `scripts/loops/prompt.sh orchestrator ${sh(topic)} --resume${auto ? " --auto" : ""}`
      : `scripts/loops/prompt.sh plan ${sh(topic)}`;
  return {
    session,
    kind,
    topic,
    mode: "fresh",
    command: `${cd}claude --remote-control ${session} "$(${prompt})"`,
  };
}

/** Reads the worktree's facts (branch, transcript, plan) and chooses. */
export function chooseFor(/** @type {string} */ dir, projects = defaultProjects()) {
  const branch = execFileSync("git", ["-C", dir, "branch", "--show-current"], { encoding: "utf8" }).trim();
  const topic = branch.replace(/^(prd|plan)\//, "");
  const plan = join(dir, "plans", `${topic}-plan.md`);
  return chooseCommand({
    dir,
    branch,
    conversation: hasConversation(dir, projects),
    runThrough: existsSync(plan) && runThrough(readFileSync(plan, "utf8")),
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
