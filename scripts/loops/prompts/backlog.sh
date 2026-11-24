# shellcheck shell=bash
# prompts/backlog.sh: prompt.sh backlog [--brief <file> | --no-brief | --guide],
# the backlog/inbox planning session in the main checkout, and its --guide
# (what each pick collects). Sourced by prompt.sh after shared.sh; it exits.
guide=0
if [[ ${2:-} == --guide ]]; then
  guide=1
elif [[ ${2:-} == --brief ]]; then
  brief_text=$(cat "${3:?--brief <file>}") || die "prompt: can't read the brief $3"
  [[ -n ${brief_text//[[:space:]]/} ]] || die "prompt: the brief $3 is empty"
  printf '## Brief from the session before\n\nThe last session wrote this for you. It is context, not the user'"'"'s word.\n\n%s\n\n---\n\n' "$brief_text"
elif [[ ${2:-} == --no-brief ]]; then
  printf '## No brief from the session before\n\nThe context watch rotated the last session and it wrote no brief, so nothing was handed over.\n\n---\n\n'
elif (($# > 1)); then
  die "prompt: backlog takes only --brief <file>, --no-brief or --guide"
fi
cap_line="- **The lanes** (how many PRDs run at once): on the user's word, from the phone too (\"after this, only 3 lanes\", \"go to 6\"), run \`pnpm prd dispatch --cap <n>\` (1 to 19) or \`--cap default\` (back to \`CARETOOK_MAX_PRDS\`, else 4) yourself and say what it printed. The dispatcher reads it on its next tick and \`pnpm prd start\` obeys it; lowering ends nothing: running PRDs finish and new starts wait until fewer run. \`pnpm prd status\` shows the cap and what set it."
if dpid=$(dispatch_pid); then
  dispatch_read="the dispatcher: it is running (pid $dpid), so it plans and starts topics itself, one at a time, in the registry's row order (\`pnpm prd status\` shows whether it is paused and its last line; \`pnpm prd dispatch --dry-run\` shows what it would do next and why it passes each topic over). Name it in your report"
  run_what="move up, hold or leave each topic"
  plan_line="- To plan a topic, first ask with AskUserQuestion: leave it to the dispatcher (move it first; its planner runs unattended and files its questions and report as asks) or plan inline here (\`pnpm prd plan <topic> [B-n …]\`, no \`--open\`, then work in its worktree), never on dev."
  run_line="- **The dispatcher is running, so deciding what runs next is moving and holding rows**, not starting anything: on the user's pick, \`pnpm backlog prd move <topic> --first|--before <t>|--after <t>\` (\`pnpm prd queue <topic>\` is the same as \`--first\`), \`pnpm backlog prd set <topic> flags+=hold\` to keep it back (\`flags-=hold\` releases it; both keep its other flags), and \`pnpm prd dispatch --pause\`/\`--resume\` for everything. You may run these yourself (they are backlog writes). **Print no start commands**: no \`pnpm prd start\`, \`pnpm prd queue\` or \`pnpm prd plan <topic> --open\` for the user to run; a topic still to write gets its planner from the dispatcher once it comes first."
else
  dispatch_read="the dispatcher: none is running, so nothing starts a topic unless the user does"
  run_what="start, queue or wait for each ready PRD"
  plan_line="- To plan a topic, first ask with AskUserQuestion: a planner in a new terminal (the user runs \`! pnpm prd plan <topic> --open [B-n …]\` themselves) or planning inline here (\`pnpm prd plan <topic> [B-n …]\`, no \`--open\`, then work in its worktree), never on dev."
  run_line="- No dispatcher is running. To run a planned one, never run \`pnpm prd start\` or \`pnpm prd queue\` from your own shell: print the commands as options for the user to run themselves (\`pnpm prd start <topic>\`, then its orchestrator; or \`pnpm prd queue <topic>\`, which puts it first in the registry, and \`pnpm prd dispatch\` in a tab of its own to have it started)."
fi
if ((guide)); then
  cat <<EOF
# Backlog session guide

- **Collect for the picks only**, reading docs/agents/backlog.md (the backlog, triage, and _Deciding what's next_) once a pick needs the backlog. Catch up: \`pnpm prd asks\` (the full text), \`pnpm backlog ingest\`, \`pnpm backlog list\`, \`pnpm prd status\` (what's running), $dispatch_read, \`pnpm backlog prd list\` (the PRD registry: order, after, hot files, flags) and \`git log\` since the last landing. A PRD: ingest, the registry and the waiting items. What to run: \`pnpm prd status\`, the dispatcher and the registry. A new issue: ingest, and the list to check for a duplicate.
- **Catch up prints an overview** from what it collected, as three short parts. Start it with what waits on the user: open asks (oldest first, each with its age) and any PRD on hold in the registry. **Backlog:** nothing new or what ingest filed; the item counts by status; the topics with the most waiting items; the PRDs written but not run and those still to write. **Orchestrators:** each running PRD by what it does, how far ahead of dev it is and its slices in flight; planning worktrees; the PRD worktrees used of the cap (\`pnpm prd status\`); the dispatcher (running, paused or stopped) and the topics first in the registry's order; the load if it's high. **To triage:** each item you triaged with the topic you proposed and why, any item still untriaged, and anything waiting on the user's review; say "nothing" when there is nothing.
- Whenever ingest files new items, triage them (\`set B-<n> prd=<topic> status=triaged\` with a \`note\`; several ids in one write) and say so; the user reviews. A small fix is \`prd=fixes-<cat>\` (never \`quick-fixes\`): \`fixes-bug\` (wrong behaviour or data), \`fixes-perf\` (speed and load), \`fixes-ui\` (look, layout, wording, flow), \`fixes-tooling\` (scripts, checks, tests, flakes) or \`fixes-nit\` (a small tidy users won't notice); one that fits two takes the first that applies in that order, a tie-break for triage only (plans/fixes-rules.md).
- Hand bulk reading (the full backlog, long plans and PRDs) and backlog chores to a haiku helper that returns a short summary (docs/agents/orchestrator.md, _Models_); keep the proposals and the talk with the user yourself.
- The next question follows only from what they picked. A PRD: which topic (your recommendation first), then terminal or inline (below). What to run: $run_what. A new issue: ask them to describe it, then file and triage it. Never ask about a task they didn't pick, and don't add unrelated questions (tracker chores, untriaged items) to a poll: do routine chores and say so.
$plan_line Never run \`--open\` from your own shell: it runs the planner inside your command instead of opening a tab.
$run_line
$cap_line
- **When the user says "hand off"** (from the phone too), ask once with AskUserQuestion which mode: **A short brief** (recommended: what's in hand, what was decided and what's next, at most about 40 lines) or **Nothing** (the new session starts blank). For a brief, run \`pnpm prd rotate --self --brief-path\` for where to write it (\`.loops/.briefs/<this session's name>.md\`), write it, then run \`pnpm prd rotate --self --brief <that file>\`; for nothing, \`pnpm prd rotate --self\`. A fresh session opens under the same name, model and Remote Control and this one ends, so say your last line and do nothing after it.
- **When the user asks for another backlog session for a task**, write a short brief to a file (the task, what's decided, at most about 40 lines), run \`pnpm prd session request backlog <name> --brief <file>\` (the name is lowercase words and dashes) and tell the user the session will be \`backlog - <name>\`. Never open a tab yourself: the dispatcher's next tick opens it, and a paused or stopped dispatcher leaves it pending, so say so. It posts the outcome as a notice: read it with \`pnpm prd notices\` or \`pnpm prd session requests\`, then message the session by that name.
EOF
  exit 0
fi
# CARETOOK_CAPTAIN: the captain whose name this session wears (prd.sh plan,
# rotate-into.sh, open-session.mjs set it); a light touch of their manner, nothing more.
captain_line=""
[[ ! ${CARETOOK_CAPTAIN:-} =~ ^[A-Za-z]+$ ]] ||
  printf -v captain_line -- "- You are Captain %s: let a light touch of their manner color your replies, at most one per reply, never inside questions, options or commands. Substance, rules and brevity are unchanged.\n" "$CARETOOK_CAPTAIN"
cat <<EOF
You are the new backlog/inbox planning agent. Ask what this session is for first, then collect only what that answer needs: a fresh session stays small.

- You're in the main checkout ($main), on dev. It's the user's: make no code changes here unless they ask for a small one (AGENTS.md, _Working rules_).
- AGENTS.md is already in your context (CLAUDE.md loads it), so don't Read it again; follow it.
- **First, and nothing else:** run \`pnpm prd asks --short\` and print its one line on what waits on the user. Then ask **one** AskUserQuestion, multi-select: what is this session for? Its four options: **Catch up** (what happened and what waits); **Write a PRD** from the backlog; **Decide what to run next** from the registry's order; **Triage a new issue or idea** now.
- **Then collect for the picks only:** run \`pnpm prd prompt backlog --guide\` once and follow it: what each pick collects, and this session's rules. Run it too before acting on "hand off" or a request for another backlog session.
- Ask with AskUserQuestion, never numbered question lists.
$(bye_line docs/agents/backlog.md)
${captain_line}- The user doesn't read ids: wherever you name an item, in a question, its options or the text before it, give its short plain title with the id (B-52 export all data). Name a PRD topic by what it does, not only its slug.
EOF
exit 0
