// The session opener's choice (open-session.sh launches it): given a prd, plan
// or hotfix worktree, or a recorded backlog or recovery session, the command that brings its session back, started through
// session.sh so it is recorded (.loops/.sessions/<session>.json).
//
//   - a saved Claude conversation for that path (a *.jsonl transcript in
//     ~/.claude/projects/<path with every non-alphanumeric as ->):
//       cd <dir> && <this checkout>/scripts/loops/session.sh <session> [--auto] [--managed] -- --continue --remote-control <session>
//   - otherwise a fresh session with the resume prompt:
//       prd:  cd <dir> && scripts/loops/session.sh prd-<topic> [--auto] [--managed] -- --remote-control prd-<topic> \
//               "$(scripts/loops/prompt.sh orchestrator <topic> --resume [--auto])"
//       plan: cd <dir> && scripts/loops/session.sh plan-<topic> [--auto] [--managed] -- --model opus --remote-control plan-<topic> \
//               "$(scripts/loops/prompt.sh plan <topic> [--auto])"
//       hotfix: cd <dir> && scripts/loops/session.sh hotfix-<name> -- --model <recorded> --remote-control hotfix-<name> \
//               "$(scripts/loops/prompt.sh hotfix <name>)"
//   - a backlog or recovery session, always fresh in the main checkout (it holds
//     many conversations, so --continue could resume the wrong one), on its
//     recorded model.
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
//      node open-session.mjs --main <name> <main checkout>   the same, for a backlog or recovery record
// Env: CARETOOK_CLAUDE_PROJECTS (tests: in place of ~/.claude/projects);
// CARETOOK_SESSIONS_DIR (default .sessions beside the worktree).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isLive, processOf, readRecord } from "./sessions.mjs";

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

/** The model backlog and hotfix sessions start on when none is recorded (prd.sh's agent_model). */
const DEFAULT_MODEL = "opus";
/** The sessions that live in the main checkout, and the prompt.sh role each opens with. */
const MAIN_PROMPTS = /** @type {Record<string, string>} */ ({ backlog: "backlog", recovery: "recover" });

/**
 * @param {{ dir: string, branch: string, conversation: boolean, runThrough: boolean,
 *   record?: { auto?: boolean, managed?: boolean, rotating?: boolean, model?: string } | null, wrapper?: string }} w
 * @returns {{ session: string, kind: "prd" | "plan" | "hotfix", topic: string, mode: "continue" | "fresh", auto: boolean,
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
  const m = /^(prd|plan|hotfix)\/(.+)$/.exec(branch);
  if (!m)
    throw new Error(
      `${dir} is on ${branch || "no branch"}: only prd/, plan/ and hotfix/ worktrees have sessions`,
    );
  const kind = /** @type {"prd" | "plan" | "hotfix"} */ (m[1]);
  const topic = m[2];
  const session = `${kind}-${topic}`;
  const auto = statusAuto || record?.auto === true;
  const managed = record?.managed === true;
  // A hotfix keeps the model it was started on (prd.sh's default when none is recorded).
  const hotfixModel = kind === "hotfix" ? `--model ${sh(record?.model ?? DEFAULT_MODEL)} ` : "";
  const wrap = `cd ${sh(dir)} && ${sh(wrapper)} ${session}${auto ? " --auto" : ""}${managed ? " --managed" : ""} -- `;
  if (conversation && !record?.rotating)
    return {
      session,
      kind,
      topic,
      mode: "continue",
      auto,
      managed,
      command: `${wrap}${hotfixModel}--continue --remote-control ${session}`,
    };
  const prompt =
    kind === "prd"
      ? `scripts/loops/prompt.sh orchestrator ${sh(topic)} --resume${auto ? " --auto" : ""}`
      : kind === "hotfix"
        ? `scripts/loops/prompt.sh hotfix ${sh(topic)}`
        : `scripts/loops/prompt.sh plan ${sh(topic)}${auto ? " --auto" : ""}`;
  return {
    session,
    kind,
    topic,
    mode: "fresh",
    auto,
    managed,
    // A fresh planner runs on opus, as `pnpm prd plan` starts it (prd.sh's agent_model).
    command: `${wrap}${kind === "plan" ? "--model opus " : hotfixModel}--remote-control ${session} "$(${prompt})"`,
  };
}

/**
 * A backlog or recovery session's command: always fresh in the main checkout,
 * under its own name, on its recorded model.
 * @param {{ name: string, main: string, record: { kind?: string, managed?: boolean, model?: string },
 *   wrapper?: string }} s
 */
export function chooseMainCommand({ name, main, record, wrapper = ownSessionSh }) {
  const kind = record.kind ?? "";
  const role = MAIN_PROMPTS[kind];
  if (!role)
    throw new Error(`open: ${name} is a ${kind || "kindless"} record, not a backlog or recovery one`);
  const managed = record.managed === true;
  const model = record.model ?? (kind === "backlog" ? DEFAULT_MODEL : null);
  return {
    session: name,
    kind,
    topic: "",
    mode: /** @type {const} */ ("fresh"),
    auto: false,
    managed,
    command:
      `cd ${sh(main)} && ${sh(wrapper)} ${sh(name)} --kind ${kind}${managed ? " --managed" : ""} -- ` +
      `${model ? `--model ${sh(model)} ` : ""}--remote-control ${sh(record.remote || name)} "$(scripts/loops/prompt.sh ${role})"`,
  };
}

/** Refuses a session that is still running: a second one would fight it for its name and checkout. */
function refuseLive(
  /** @type {string} */ name,
  /** @type {import("./sessions.mjs").SessionRecord | null} */ r,
) {
  if (r && isLive(r, processOf(r.pid ?? 0))) throw new Error(`open: ${name} is already live (pid ${r.pid})`);
}

/** Reads a main-checkout session's record and chooses. */
export function chooseMainFor(
  /** @type {string} */ name,
  /** @type {string} */ main,
  sessions = process.env.CARETOOK_SESSIONS_DIR || join(main, ".loops", ".sessions"),
) {
  const record = readRecord(sessions, name);
  if (!record || !MAIN_PROMPTS[record.kind ?? ""])
    throw new Error(`open: no worktree ${name}, and no recorded backlog or recovery session of that name`);
  refuseLive(name, record);
  return chooseMainCommand({ name, main, record });
}

/** Reads the worktree's facts (branch, transcript, plan, session record) and chooses. */
export function chooseFor(
  /** @type {string} */ dir,
  projects = defaultProjects(),
  sessions = process.env.CARETOOK_SESSIONS_DIR || join(dirname(dir), ".sessions"),
) {
  const branch = execFileSync("git", ["-C", dir, "branch", "--show-current"], { encoding: "utf8" }).trim();
  const kind = branch.split("/")[0];
  const topic = branch.replace(/^(prd|plan|hotfix)\//, "");
  const plan = join(dir, "plans", `${topic}-plan.md`);
  const record = ["prd", "plan", "hotfix"].includes(kind) ? readRecord(sessions, `${kind}-${topic}`) : null;
  if (kind === "hotfix") refuseLive(`hotfix-${topic}`, record);
  return chooseCommand({
    dir,
    branch,
    conversation: hasConversation(dir, projects),
    runThrough: existsSync(plan) && runThrough(readFileSync(plan, "utf8")),
    record,
  });
}

const defaultProjects = () => process.env.CARETOOK_CLAUDE_PROJECTS || join(homedir(), ".claude", "projects");

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = process.argv[2];
  const onMain = dir === "--main";
  if (!dir || (onMain && !(process.argv[3] && process.argv[4]))) {
    console.error("usage: open-session.mjs <worktree dir> | --main <name> <main checkout>");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(onMain ? chooseMainFor(process.argv[3], process.argv[4]) : chooseFor(dir)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
