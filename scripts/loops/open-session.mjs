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
//       plan: cd <dir> && scripts/loops/session.sh plan-<topic> [--auto] [--managed] -- --model <opus, or fable for a `design` row> --remote-control plan-<topic> \
//               "$(scripts/loops/prompt.sh plan <topic> [--auto])"
//       hotfix: cd <dir> && scripts/loops/session.sh hotfix-<name> -- --model <recorded> --remote-control hotfix-<name> \
//               "$(scripts/loops/prompt.sh hotfix <name>)"
//   - a backlog or recovery session, always fresh in the main checkout (it holds
//     many conversations, so --continue could resume the wrong one), on its
//     recorded model.
//   - the inbox session, always fresh through `prd.sh inbox` (which checks its
//     bare directory and gives it its settings), in its recorded directory, on
//     prd.sh's inbox model (Opus at low effort) whatever the record says, so
//     a record from an older default never holds it there:
//       cd <main> && <this checkout>/scripts/loops/prd.sh inbox --dir <dir> [--managed]
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
// --carry-on (the dispatcher's resume after a usage limit, resume.mjs): a continued
// prd or plan session gets the carry-on prompt (carryOnPrompt) as its first message,
// since a bare --continue would sit idle at its prompt; a fresh one has its resume
// prompt already.
//
// CLI: node open-session.mjs <worktree dir> [--carry-on]  → JSON {session, kind, topic, mode, auto, managed, command}
//      (the main backlog session's adds title: its captain, the tab's title and Remote Control name)
//      node open-session.mjs --main <name> <main checkout>   the same, for a backlog, recovery or inbox record
// Env: CARETOOK_CLAUDE_PROJECTS (tests: in place of ~/.claude/projects);
// CARETOOK_CLAUDE_CONFIG (tests: in place of ~/.claude.json, only ever read);
// CARETOOK_INBOX_DIR (the inbox session's directory when its record has none;
// default ~/.caretook/inbox); CARETOOK_SESSIONS_DIR (default .sessions beside the worktree).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CAPTAIN_SESSION, pickCaptain } from "./captain.mjs";
import { plannerModelFor } from "./planner-model.mjs";
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
/** The recorded sessions with no worktree of their own, and the prompt.sh role each opens with. */
const MAIN_PROMPTS = /** @type {Record<string, string>} */ ({
  backlog: "backlog",
  recovery: "recover",
  inbox: "inbox",
});

/** The inbox session's directory: its record's, else CARETOOK_INBOX_DIR, else ~/.caretook/inbox (prd.sh's). */
export function inboxDirOf(/** @type {{ dir?: string } | null | undefined} */ record, env = process.env) {
  return record?.dir || env.CARETOOK_INBOX_DIR || join(homedir(), ".caretook", "inbox");
}

/**
 * Why the inbox session can't be opened unattended in DIR, or null when it can:
 * Claude Code asks once whether to trust a new folder, and its default answer
 * exits. Trusted is a saved conversation there (a session got past the
 * question), or Claude Code's config marking DIR or a folder above it accepted.
 * Both are only read.
 */
export function inboxUntrusted(
  /** @type {string} */ dir,
  {
    projects = defaultProjects(),
    config = process.env.CARETOOK_CLAUDE_CONFIG || join(homedir(), ".claude.json"),
  } = {},
) {
  const ask = "run `pnpm prd inbox` once by hand and accept the folder";
  let real;
  try {
    real = realpathSync(dir);
  } catch {
    return `its directory ${dir} doesn't exist yet: ${ask}`;
  }
  if (hasConversation(real, projects)) return null;
  /** @type {Record<string, { hasTrustDialogAccepted?: boolean }>} */
  let known = {};
  try {
    known = JSON.parse(readFileSync(config, "utf8")).projects ?? {};
  } catch {
    /* unreadable: only a saved conversation counts */
  }
  for (let d = real; ; d = dirname(d)) {
    if (known[d]?.hasTrustDialogAccepted === true) return null;
    if (dirname(d) === d) break;
  }
  return `its directory ${real} isn't trusted yet: ${ask}`;
}

/**
 * The first message of a session continued after a usage limit (--carry-on). Pure.
 * @param {"prd" | "plan" | "hotfix"} kind @param {string} topic
 */
export function carryOnPrompt(kind, topic) {
  const head = "This session stopped on a usage limit, and the limit has now reset.";
  if (kind === "plan")
    return `${head} Check what you had written against git (git status, git log), then carry on with the plan for ${topic} where you left off.`;
  return `${head} If \`pnpm prd land\` was cut off, run \`pnpm prd land --resume <branch>\` first. Reconcile your plan's _Status_ with git (slice worktrees, slice branches ahead of prd/${topic}, merges already in), respawn any slice agents that stopped (\`pnpm prd prompt slice ${topic} <n> --continue\`), and carry on in your recorded landing mode.`;
}

/**
 * @param {{ dir: string, branch: string, conversation: boolean, runThrough: boolean,
 *   record?: { auto?: boolean, managed?: boolean, rotating?: boolean, model?: string } | null, wrapper?: string,
 *   plannerModel?: string, carryOn?: boolean }} w
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
  plannerModel = DEFAULT_MODEL,
  carryOn = false,
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
  // A planner runs on its row's model, continued or fresh (opus, or Fable for a `design` row).
  const modelArg =
    kind === "hotfix"
      ? `--model ${sh(record?.model ?? DEFAULT_MODEL)} `
      : kind === "plan"
        ? `--model ${sh(plannerModel)} `
        : "";
  const wrap = `cd ${sh(dir)} && ${sh(wrapper)} ${session}${auto ? " --auto" : ""}${managed ? " --managed" : ""} -- `;
  if (conversation && !record?.rotating)
    return {
      session,
      kind,
      topic,
      mode: "continue",
      auto,
      managed,
      command: `${wrap}${modelArg}--continue --remote-control ${session}${carryOn && kind !== "hotfix" ? ` ${sh(carryOnPrompt(kind, topic))}` : ""}`,
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
    command: `${wrap}${modelArg}--remote-control ${session} "$(${prompt})"`,
  };
}

/**
 * A backlog, recovery or inbox session's command: always fresh, under its own
 * name; the main checkout on its recorded model, or the inbox's own directory
 * on prd.sh's inbox model.
 * The main backlog session (backlog) comes back under a new captain's name
 * (captain.mjs: CAPTAIN, else one unlike its record's remote), which is also
 * its tab's `title`; every other one keeps its recorded Remote Control name.
 * @param {{ name: string, main: string,
 *   record: { kind?: string, managed?: boolean, model?: string, remote?: string, dir?: string },
 *   wrapper?: string, inboxDir?: string, captain?: string }} s
 */
export function chooseMainCommand({ name, main, record, wrapper = ownSessionSh, inboxDir, captain }) {
  const kind = record.kind ?? "";
  const role = MAIN_PROMPTS[kind];
  if (!role)
    throw new Error(`open: ${name} is a ${kind || "kindless"} record, not a backlog, recovery or inbox one`);
  const managed = record.managed === true;
  if (kind === "inbox")
    return {
      session: name,
      kind,
      topic: "",
      mode: /** @type {const} */ ("fresh"),
      auto: false,
      managed,
      command:
        `cd ${sh(main)} && ${sh(join(dirname(wrapper), "prd.sh"))} inbox --dir ${sh(inboxDir ?? inboxDirOf(record))}` +
        `${managed ? " --managed" : ""}`,
    };
  const model = record.model ?? (kind === "recovery" ? null : DEFAULT_MODEL);
  const captained = kind === "backlog" && name === CAPTAIN_SESSION;
  const remote = captained ? (captain ?? pickCaptain(record.remote)) : record.remote || name;
  return {
    session: name,
    ...(captained ? { title: remote } : {}),
    kind,
    topic: "",
    mode: /** @type {const} */ ("fresh"),
    auto: false,
    managed,
    command:
      `cd ${sh(main)} && ${sh(wrapper)} ${sh(name)} --kind ${kind}${managed ? " --managed" : ""} -- ` +
      `${model ? `--model ${sh(model)} ` : ""}--remote-control ${sh(remote)} "$(${captained ? `CARETOOK_CAPTAIN=${sh(remote)} ` : ""}scripts/loops/prompt.sh ${role})"`,
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
    throw new Error(
      `open: no worktree ${name}, and no recorded backlog, recovery or inbox session of that name`,
    );
  refuseLive(name, record);
  return chooseMainCommand({ name, main, record });
}

/** The main checkout of DIR's repository: its first worktree. */
const mainOf = (/** @type {string} */ dir) =>
  execFileSync("git", ["-C", dir, "worktree", "list", "--porcelain"], { encoding: "utf8" })
    .split("\n")[0]
    .replace(/^worktree /, "");

/** Reads the worktree's facts (branch, transcript, plan, session record) and chooses. */
export function chooseFor(
  /** @type {string} */ dir,
  projects = defaultProjects(),
  sessions = process.env.CARETOOK_SESSIONS_DIR || join(dirname(dir), ".sessions"),
  { carryOn = false } = {},
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
    plannerModel: kind === "plan" ? plannerModelFor(topic, mainOf(dir)) : DEFAULT_MODEL,
    carryOn,
  });
}

const defaultProjects = () => process.env.CARETOOK_CLAUDE_PROJECTS || join(homedir(), ".claude", "projects");

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = process.argv[2];
  const onMain = dir === "--main";
  const carryOn = !onMain && process.argv[3] === "--carry-on";
  if (!dir || (onMain && !(process.argv[3] && process.argv[4])) || (!onMain && process.argv[3] && !carryOn)) {
    console.error("usage: open-session.mjs <worktree dir> [--carry-on] | --main <name> <main checkout>");
    process.exit(2);
  }
  try {
    console.log(
      JSON.stringify(
        onMain
          ? chooseMainFor(process.argv[3], process.argv[4])
          : chooseFor(dir, undefined, undefined, { carryOn }),
      ),
    );
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
