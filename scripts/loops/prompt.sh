#!/usr/bin/env bash
# Print the first prompt for a session, so starting one is a single command.
#
#   prompt.sh orchestrator <topic>     paste into a new session in .loops/<topic>:
#     cd .loops/<topic> && claude --remote-control prd-<topic> "$(scripts/loops/prompt.sh orchestrator <topic>)"
#     (pnpm prd start <topic> prints this)
#   prompt.sh orchestrator <topic> --auto   the same, landing every wave without asking (the dispatcher uses it)
#   prompt.sh orchestrator <topic> --resume [--auto]   take over after an interruption: reconcile
#     the plan's _Status_ with git, respawn in-flight slices with --continue
#   prompt.sh plan <topic> [B-n …]     a planning session in .loops/plan-<topic> (pnpm prd plan <topic> --open)
#   prompt.sh plan <topic> --auto [B-n …]   the same, unattended (the dispatcher's): questions and
#     the report through pnpm prd ask, never AskUserQuestion
#   prompt.sh slice <topic> <n>        the prompt an orchestrator gives a slice agent
#   prompt.sh slice <topic> <n> --continue   the same, for an agent picking up an interrupted slice
#   prompt.sh hotfix <name> ["<the fix>"]   a hotfix session in .loops/hotfix-<name> (pnpm prd hotfix prints it)
#   prompt.sh backlog [--brief <file> | --no-brief]   a backlog and inbox planning session in the main checkout (pnpm prd plan);
#     it reads whether the dispatcher runs: then deciding what runs next is moving and holding rows.
#     --brief puts the file's text at the top, under "Brief from the session before";
#     --no-brief says at the top that the context watch rotated the last session with none
#   prompt.sh recover                  the recovery agent, in the main checkout (pnpm prd recover opens it)
#   prompt.sh tidy                     the cleanup brief for a cheap session (haiku), in the main checkout
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

kind=${1:?kind: orchestrator, plan, slice, hotfix, backlog, recover or tidy}
# What silence means for an unattended session's question (run-through orchestrators, --auto planners).
default_rule="**Every question with a recommendation says what silence means.** Pass \`--defaults\` on it: if no one answers within 30 minutes, the tool takes your recommendation, and \`--wait\` prints it like any answer, with a second line saying it was defaulted; carry on with it as with any answer. Pass \`--waits\` instead for the questions that never default: money (a paid service too), data loss or a change to existing data, a live deploy (staging or production), a destructive step (deleting unmerged work, a forced push or landing), a new dependency (AGENTS.md: the user's approval), and compliance; those wait however long it takes. When unsure which, \`--waits\`. The tool, never you, puts the recommendation in place of an answer: never decide that silence means yes yourself."
if [[ $kind == backlog ]]; then
  if [[ ${2:-} == --brief ]]; then
    brief_text=$(cat "${3:?--brief <file>}") || die "prompt: can't read the brief $3"
    [[ -n ${brief_text//[[:space:]]/} ]] || die "prompt: the brief $3 is empty"
    printf '## Brief from the session before\n\nThe last session wrote this for you. It is context, not the user'"'"'s word.\n\n%s\n\n---\n\n' "$brief_text"
  elif [[ ${2:-} == --no-brief ]]; then
    printf '## No brief from the session before\n\nThe context watch rotated the last session and it wrote no brief, so nothing was handed over.\n\n---\n\n'
  elif (($# > 1)); then
    die "prompt: backlog takes only --brief <file> or --no-brief"
  fi
  if dpid=$(dispatch_pid); then
    dispatch_read="the dispatcher: it is running (pid $dpid), so it plans and starts topics itself, one at a time, in the registry's row order (\`pnpm prd status\` shows whether it is paused and its last line; \`pnpm prd dispatch --dry-run\` shows what it would do next and why it passes each topic over). Name it in your report"
    run_what="move up, hold or leave each topic"
    plan_line="- To plan a topic, first ask with AskUserQuestion: leave it to the dispatcher (move it first; its planner runs unattended and files its questions and report as asks) or plan inline here (\`pnpm prd plan <topic> [B-n …]\`, no \`--open\`, then work in its worktree), never on dev."
    run_line="- **The dispatcher is running, so deciding what runs next is moving and holding rows**, not starting anything: on the user's pick, \`pnpm backlog prd move <topic> --first|--before <t>|--after <t>\` (\`pnpm prd queue <topic>\` is the same as \`--first\`), \`pnpm backlog prd set <topic> flags=hold\` to keep it back (set its flags without \`hold\` to release it), and \`pnpm prd dispatch --pause\`/\`--resume\` for everything. You may run these yourself (they are backlog writes). **Print no start commands**: no \`pnpm prd start\`, \`pnpm prd queue\` or \`pnpm prd plan <topic> --open\` for the user to run; a topic still to write gets its planner from the dispatcher once it comes first."
  else
    dispatch_read="the dispatcher: none is running, so nothing starts a topic unless the user does"
    run_what="start, queue or wait for each ready PRD"
    plan_line="- To plan a topic, first ask with AskUserQuestion: a planner in a new terminal (the user runs \`! pnpm prd plan <topic> --open [B-n …]\` themselves) or planning inline here (\`pnpm prd plan <topic> [B-n …]\`, no \`--open\`, then work in its worktree), never on dev."
    run_line="- No dispatcher is running. To run a planned one, never run \`pnpm prd start\` or \`pnpm prd queue\` from your own shell: print the commands as options for the user to run themselves (\`pnpm prd start <topic>\`, then its orchestrator; or \`pnpm prd queue <topic>\`, which puts it first in the registry, and \`pnpm prd dispatch\` in a tab of its own to have it started)."
  fi
  cat <<EOF
You are the new backlog/inbox planning agent. Ask what this session is for first, then collect only what that answer needs: a fresh session stays small.

- You're in the main checkout ($main), on dev. It's the user's: make no code changes here unless they ask for a small one (AGENTS.md, _Working rules_).
- AGENTS.md is already in your context (CLAUDE.md loads it), so don't Read it again; follow it.
- **First, and nothing else:** run \`pnpm prd asks\` and print one line on what waits on the user (open questions, oldest first with their ages, and how many reports). Then ask **one** AskUserQuestion, multi-select: what is this session for? Its four options: **Catch up** (what happened and what waits); **Write a PRD** from the backlog; **Decide what to run next** from the registry's order; **Triage a new issue or idea** now.
- **Then collect for the picks only**, reading docs/agents/backlog.md (the backlog, triage, and _Deciding what's next_) once a pick needs the backlog. Catch up: \`pnpm backlog ingest\`, \`pnpm backlog list\`, \`pnpm prd status\` (what's running), $dispatch_read, \`pnpm backlog prd list\` (the PRD registry: order, after, hot files, flags) and \`git log\` since the last landing. A PRD: ingest, the registry and the waiting items. What to run: \`pnpm prd status\`, the dispatcher and the registry. A new issue: ingest, and the list to check for a duplicate.
- **Catch up prints an overview** from what it collected, as three short parts. Start it with what waits on the user: open asks (oldest first, each with its age) and any PRD on hold in the registry. **Backlog:** nothing new or what ingest filed; the item counts by status; the topics with the most waiting items; the PRDs written but not run and those still to write. **Orchestrators:** each running PRD by what it does, how far ahead of dev it is and its slices in flight; planning worktrees; the slots used of three; the dispatcher (running, paused or stopped) and the topics first in the registry's order; the load if it's high. **To triage:** each item you triaged with the topic you proposed and why, any item still untriaged, and anything waiting on the user's review; say "nothing" when there is nothing.
- Whenever ingest files new items, triage them (\`set B-<n> prd=<topic> status=triaged\` with a \`note\`; several ids in one write) and say so; the user reviews. A small fix is \`prd=fixes-<cat>\` (never \`quick-fixes\`): \`fixes-bug\` (wrong behaviour or data), \`fixes-perf\` (speed and load), \`fixes-ui\` (look, layout, wording, flow), \`fixes-tooling\` (scripts, checks, tests, flakes) or \`fixes-nit\` (a small tidy users won't notice); one that fits two takes the first that applies in that order, a tie-break for triage only (plans/fixes-rules.md).
- Hand bulk reading (the full backlog, long plans and PRDs) and backlog chores to a haiku helper that returns a short summary (docs/agents/orchestrator.md, _Models_); keep the proposals and the talk with the user yourself.
- The next question follows only from what they picked. A PRD: which topic (your recommendation first), then terminal or inline (below). What to run: $run_what. A new issue: ask them to describe it, then file and triage it. Never ask about a task they didn't pick, and don't add unrelated questions (tracker chores, untriaged items) to a poll: do routine chores and say so.
- Ask with AskUserQuestion, never numbered question lists.
- The user doesn't read ids: wherever you name an item, in a question, its options or the text before it, give its short plain title with the id (B-52 export all data). Name a PRD topic by what it does, not only its slug.
$plan_line Never run \`--open\` from your own shell: it runs the planner inside your command instead of opening a tab.
$run_line
- **When the user says "hand off"** (from the phone too), ask once with AskUserQuestion which mode: **A short brief** (recommended: what's in hand, what was decided and what's next, at most about 40 lines) or **Nothing** (the new session starts blank). For a brief, run \`pnpm prd rotate --self --brief-path\` for where to write it (\`.loops/.briefs/<this session's name>.md\`), write it, then run \`pnpm prd rotate --self --brief <that file>\`; for nothing, \`pnpm prd rotate --self\`. A fresh session opens under the same name, model and Remote Control and this one ends, so say your last line and do nothing after it.
- **When the user asks for another backlog session for a task**, write a short brief to a file (the task, what's decided, at most about 40 lines), run \`pnpm prd session request backlog <name> --brief <file>\` (the name is lowercase words and dashes) and tell the user the session will be \`backlog - <name>\`. Never open a tab yourself: the dispatcher's next tick opens it, and a paused or stopped dispatcher leaves it pending, so say so. It posts the outcome as a notice: read it with \`pnpm prd notices\` or \`pnpm prd session requests\`, then message the session by that name.
EOF
  exit 0
fi
if [[ $kind == recover ]]; then
  cat <<EOF
You are the recovery agent. The machine has just come back (a restart, a crash or a usage limit), and \`pnpm prd recover\` has already brought back Docker, the stacks, the dev servers and the shared test Postgres. Your job is the sessions: every PRD orchestrator and planner should be running again.

- You're in the main checkout ($main), on dev. It's the user's. **Make no code changes and no commits**, edit no files, and don't touch other worktrees, stacks or servers (no \`pnpm prd recover\` without \`--dry-run\`, no \`stack\`, \`serve\`, \`rm\` or \`gc\`). Don't spawn agents for slices: each orchestrator respawns its own.
- docs/agents/recovery.md describes the machinery. Read the inventory: \`pnpm prd recover --dry-run --json\`. Each \`open-session\` action names a PRD or plan worktree (\`target\`, in $loops) and its Remote Control session (\`session\`: \`prd-<topic>\` or \`plan-<topic>\`).
- Find the live sessions with ListAgents. For each \`open-session\` whose \`session\` is live, send it this carry-on message with SendMessage:
  > The machine recovered (a restart, a crash or a usage limit); its stacks and servers are back. Reconcile your plan's _Status_ with git (slice worktrees, slice branches ahead of your branch, merges already in), correct it where git disagrees, respawn any slice agents that stopped (\`pnpm prd prompt slice <topic> <n> --continue\`), and carry on in your recorded landing mode.
- **Managed sessions belong to the dispatcher while it runs.** When the inventory's \`dispatcher.running\` is true (recover reopened it, or it never stopped), leave every \`open-session\` marked \`managed\` to it: never open one, since the dispatcher reopens a dead managed session itself (a live one still gets the carry-on message). With no dispatcher running, treat managed sessions like the rest.
- For each other \`open-session\` with no live session, open it with the opener: \`pnpm prd open <target>\`. It opens a new iTerm2 tab that continues the worktree's saved conversation (\`claude --continue --remote-control <session>\`) or starts a fresh one with the resume prompt, keeping the session's name. Without iTerm2 it prints the command instead: pass that on to the user. Open each one once; never open a session that ListAgents shows as live.
- Then report, as a short table: each session, and whether you messaged it, opened it in a tab, printed its command or left it to the dispatcher (and anything that failed). Then end: you have nothing else to do.

Start by reading the inventory and ListAgents.
EOF
  exit 0
fi
if [[ $kind == tidy ]]; then
  cat <<EOF
You are the cleanup agent: a short, cheap session (run it on haiku) that clears leftovers from finished work and reports the rest.

- You're in the main checkout ($main), on dev. It's the user's. **Make no code changes and no commits**, edit no files, and don't touch any worktree, stack or server yourself: \`pnpm prd tidy\` does the removing.
- Run \`pnpm prd tidy --yes\`. It removes only what is plainly safe (merged slice and landed plan worktrees with nothing running in them, dead lease and slot tickets, test databases with no worktree, stale remote-tracking refs, dangling caretook Docker volumes, old browser-hang logs, ended session records) and files everything else as one report in the asks queue (\`pnpm prd ask --report\`). A report is never pushed: send no PushNotification for it.
- For each \`session\` line in its ask list (a live session whose worktree is gone or whose branch is in dev: it looks finished), find it with ListAgents and ask it over SendMessage whether it is done and can be closed. Collect the answers, then file them as one more report: \`pnpm prd ask --topic tidy --report "<each session: its answer>"\` (no PushNotification).
- **Never close or end a session**, delete a branch (merged or not), archive backlog items or change the PRD registry yourself: those are on the ask list for the user. **Never delete unmerged work**, and never run \`pnpm prd rm\`, \`gc\`, \`reclaim\`, \`end\` or \`git branch -d\`.
- Then report in three lines (what was removed, what was asked, the sessions' answers) and end.
- The dispatcher runs \`pnpm prd tidy --yes\` every six hours by itself; this brief is for when it isn't running (start this session with \`/loop 3h\` and this brief to repeat it).

Start with \`pnpm prd tidy --yes\`.
EOF
  exit 0
fi
topic=${2:?topic}
items=${*:3}
if [[ $kind == hotfix ]]; then
  fix=${3:-}
  cat <<EOF
You are the hotfix agent for "$topic": one contained fix, outside the PRD flow, that lands straight in dev.

- Your worktree is $loops/hotfix-$topic, on branch hotfix/$topic (from dev), with no Docker stack. \`cd\` there in every shell and work only there; Read, Edit and Write use absolute paths inside it. Never change the main checkout ($main), other worktrees or other stacks.
- AGENTS.md is already in your context (CLAUDE.md loads it), so don't Read it again; follow it. Read your handbook, docs/agents/hotfix.md, then the area docs the fix touches (AGENTS.md's _Area index_).
- **Ask the user before every step that takes time or changes shared state**, unless they say not to: a long test (\`pnpm check\`, \`pnpm prd check\`, component tests, any browser check, \`pnpm prd stack up\`), committing, \`pnpm prd sync\`, landing and \`pnpm prd rm\`. Say what you'll run and why, and wait. Reads, edits, a typecheck and one unit-test file need no ask.
- When the fix is a judgement call (what to show, what to cut), talk it through first: poll the user with AskUserQuestion, never numbered question lists. Keep it to one contained change; if it grows into PRD work (a migration, a running PRD's hot file, parallel work), say so and stop.
- Background agents are allowed (a test run, a search, a review), working in this worktree only, on the cheapest model that can do the job (docs/agents/orchestrator.md, _Models_).
- Update the docs the fix makes stale on this branch (a hotfix may edit docs/ and AGENTS.md), and write any new hotfix rule you and the user settle on into docs/agents/hotfix.md.
- Commit on hotfix/$topic only when the user asks (Conventional Commits; \`fix(<area>): …\` by default). Land on their word: the check docs/agents/orchestrator.md, _The check gate_ asks for on the tip (\`pnpm prd check --quick "<why>"\` by default for a hotfix; nothing for docs and tooling only), then ask the user **"PR or local?"** (a PR is reviewed by Codex on GitHub: \`pnpm prd pr hotfix/$topic\`, review, then \`land --pr\`; local merges straight into dev) and run \`pnpm prd land hotfix/$topic --pr\` or \`--local\` with \`-m "fix(<area>): …"\`, and \`pnpm prd rm hotfix-$topic\`. A backlog item, if there is one, goes through \`pnpm backlog\` (claim, note); never edit the backlog files on the branch.
${fix:+
The fix: $fix
}
Start by reading the code the fix touches and summarising what's there for the user.
EOF
  exit 0
fi

# A topic may have no PRD (the fixes-ui, fixes-tooling, fixes-perf, fixes-bug and fixes-nit topics): then its plan is the whole spec.
here=$(git rev-parse --show-toplevel 2>/dev/null || echo "$main")
if [[ -f $here/plans/$topic-prd.md ]]; then
  prd_read="plans/$topic-prd.md and "
else
  prd_read=""
  no_prd=" (there's no plans/$topic-prd.md: the plan is the whole spec)"
fi
fix_line=""
if [[ $topic == fixes-* ]]; then
  bt='`'
  fix_line=" **This is a fixes topic:** before each wave, append one slice per waiting item (${bt}pnpm backlog list${bt}, status triaged, prd=$topic) to plans/$topic-plan.md, each with ${bt}Reads: plans/fixes-rules.md${bt}; the plan is the whole spec. Leave for a later wave any fix that would touch a running topic's hot files (${bt}pnpm backlog prd list${bt}). Once the wave's slices are written, set your row's hot files to the path prefixes they will touch: ${bt}pnpm backlog prd set $topic hot=<path prefixes>${bt} (removing your worktree clears them)."
fi
case $kind in
  orchestrator)
    auto="" resume=""
    for flag in "${@:3}"; do
      case $flag in
        --auto) auto=1 ;;
        --resume) resume=1 ;;
        *) echo "orchestrator takes --auto and --resume, not $flag" >&2; exit 1 ;;
      esac
    done
    cat <<EOF
You are the PRD orchestrator for "$topic".

- Your integration worktree is $loops/$topic, on branch prd/$topic. Work only there; never in the main checkout ($main, which stays on dev and belongs to the user, the dev keeper).
- AGENTS.md is already in your context (CLAUDE.md loads it), so don't Read it again; follow it. Read your handbook, docs/agents/orchestrator.md (it links the loop and backlog docs). Then read ${prd_read}plans/$topic-plan.md${no_prd:-} (its _Status_ section is where the last orchestrator left off, including the landing mode the user chose).
- At every wave boundary, starting now: \`pnpm backlog ingest\`, then \`pnpm backlog list\`. Propose new items that belong to "$topic" (\`pnpm backlog set B-<n> … prd=$topic status=triaged\` plus a \`note\`); the user reviews. A small fix is \`prd=fixes-<cat>\` (never \`quick-fixes\`): \`fixes-bug\` (wrong behaviour or data), \`fixes-perf\` (speed and load), \`fixes-ui\` (look, layout, wording, flow), \`fixes-tooling\` (scripts, checks, tests, flakes) or \`fixes-nit\` (a small tidy users won't notice); one that fits two takes the first that applies in that order, a tie-break for triage only (plans/fixes-rules.md).${fix_line} Claim items before you work them (\`pnpm backlog claim B-<n> …\`).
- Run a wave: \`pnpm prd slice $topic <n>\` for each slice in it, and spawn one background agent per slice with the prompt from \`pnpm prd prompt slice $topic <n>\`, on the model the handbook's _Models_ gives (note it in _Status_): opus or stronger for any coding with real logic, sonnet only for a slice with no logic to work out. Hand light reading and chores, never coding, to a haiku helper with a tight brief.
- Merge finished slices into prd/$topic in plan order (\`git merge --no-ff -m "feat($topic): <what it adds> (slice <n>, B-<n>)" slice/$topic/<n>\`), with no checks between merges (they run once, before landing), mark their items \`pnpm backlog done\`, and tear down.
- When the wave is green: \`pnpm prd sync\`, then the check: a wave gate is \`pnpm prd check --quick "<why>"\` (typecheck, lint, format, every unit test, the integration tests related to the diff and only the component tests the diff adds or edits; the tooling makes it a full check itself when the diff touches a migration, seeds, the sync config, a lockfile, a package.json beyond its scripts or the Vitest config); slices check only their own test files, so the other component tests first run in the full check: send a failure there back to the slice's agent (SendMessage) while it is still yours, before you rotate; the full \`pnpm prd check\` runs once, on the wave's tip before its PR, and where the handbook's _The check gate_ calls for it (a conflict resolved in code, both sides changing a hot file, or when unsure); docs and tooling-only changes need neither. To wait on a check running in the background, run \`pnpm prd wait check\` (it returns once the worktree's check is gone, and exits 75 at its \`--timeout\`); never \`pgrep -f\` (it matches its own shell and never exits). Then \`pnpm prd serve --restart\`, then show the user the output of \`pnpm prd ready\` (the link to try it, and what it addresses) with the browser checks you ran and anything worth trying by hand. Land with \`pnpm prd land $topic -m "<subject>"\` as the landing mode allows; when it refuses only because the last check is stale, \`pnpm prd land $topic --recheck "<why>" -m "<subject>"\` runs that check on the tip and lands on a pass.
- **Code lands through a GitHub PR into dev, reviewed by Codex.** As soon as a wave is green, open it with \`pnpm prd pr $topic\` (rerun after every push) and run \`pnpm prd review $topic --wait\` in the background. Triage each finding: verify it, then push a real one off to the backlog (\`pnpm backlog add bug … --prd <topic> --status triaged --note …\`, or a \`note\` on the item that already covers it); only a critical, breaking one goes to a fix agent on prd/$topic now. Reply on every thread before resolving it: the backlog id with its title ("Tracked as B-<n>: …"), the fixing commit, or why you decline. Then resolve each answered thread (\`review --resolve <threadId>\`; Codex doesn't resolve its own), push, then \`review --again\` until clean. After about three rounds, ask the user. Land on the user's word through the PR; \`--no-review\` only when they say so (and after a timeout, exit 75, ask them: merge without review or keep waiting), or when Codex is out of credits: \`review\` exits 4 with "codex: out of credits", and then land with \`--no-review\` as your landing mode allows, without asking, and say in the landing report that Codex didn't review it. When the wave's diff is docs only (Markdown files, nothing else), don't run or wait for \`pnpm prd review\`: open the PR with \`pnpm prd pr $topic\` and land.
- When a slice is blocked by another PRD's work (another orchestrator's slice, or a backlog item landing in dev), don't stall: find that orchestrator with ListAgents and ask it with SendMessage to message you when the work lands in dev, and set a background check (a Bash loop with run_in_background that exits once \`pnpm log dev\` or \`pnpm backlog list\` shows it), so you're woken whichever comes first. Then \`pnpm prd sync\` and carry on.
- At each landing, fold that wave's decisions into the docs as the handbook's _Docs at landing_ says (area doc, role doc, or the core; trim at least what you fold in). When the last wave has landed, run \`pnpm prd rm $topic\`, then \`cd $main && pnpm prd end\` (your last step: it ends this session and closes its tab; \`cd\` first, since \`rm\` deleted your worktree).
- **One session per wave: drain, then rotate.** After a landing and its docs (not the last one), start no new slice; once the slices in flight are merged, commit _Status_ and run \`pnpm prd rotate\`; with none in flight, rotate at once. It opens a fresh session with the resume prompt (the same name, your landing mode) in a background tab and ends this one, so write _Status_ as the hand-over first and say nothing after it. \`pnpm prd rotate --mid-wave\` (it ends the slice agents too; the fresh session respawns them) only on the user's word, or **past the context limit** (160k tokens; a hook reminds you): at the next safe point finish the step in hand, commit _Status_ and run \`pnpm prd rotate --mid-wave --reason "context"\` (plain \`pnpm prd rotate\` with no slice in flight), without asking. Only a step that can't resume from _Status_ (a landing under way) may finish first: run \`pnpm prd context --keep "<why>"\` and write the reason in _Status_.
- Every commit subject is a Conventional Commit (\`feat($topic): …\`, \`fix($topic): …\`, \`docs\`, \`test\`, \`chore\`…); the commit-msg hook refuses anything else.
- Keep the plan's _Status_ section current **at every step**, not only at wave boundaries: a slice started (worktree made, agent spawned), handed off, merged (with the merge SHA), a wave landed; plus what's ready, open issues and the landing mode. Write it as you go, so a fresh orchestrator can take over after a crash at any moment (the file survives in your worktree; commit it with your merges, and before \`pnpm prd check\`).
EOF
    if [[ -n $resume ]]; then
      cat <<EOF

**You're taking over after an interruption** (a restart, a crash or a usage limit). An earlier orchestrator for "$topic" stopped mid-work, and its slice agents may have stopped with it. Before anything else:
1. Read the plan's _Status_, then reconcile it with git. **Git wins over a stale line**, so correct _Status_ first:
   - slice worktrees: \`pnpm prd status\` lists every \`$topic-<n>\` worktree, dirty or clean (\`git -C $loops/$topic-<n> status --short\` shows what's uncommitted);
   - \`slice/$topic/<n>\` branches ahead of prd/$topic: \`pnpm log --oneline prd/$topic..slice/$topic/<n>\`;
   - merges already in prd/$topic: \`pnpm log --merges --oneline dev..prd/$topic\`.
2. **Respawn each in-flight slice** (a worktree whose branch isn't merged, with no live agent in ListAgents): one background agent per slice, with the prompt from \`pnpm prd prompt slice $topic <n> --continue\`. It picks up from the worktree's commits and uncommitted changes instead of starting over.
3. **A slice handed off but not merged** (_Status_ says handed off, or its branch is ahead with a clean worktree): its hand-off message is lost, so review it from its branch (\`pnpm log\`, \`git diff --stat prd/$topic...slice/$topic/<n>\`, the acceptance criteria). When you need a hand-off to judge it (its check output, criteria you can't see in the diff), spawn a \`--continue\` agent for it, which writes the hand-off again without rebuilding. Then merge in plan order as usual.
4. **Follow the landing mode _Status_ records**; ask for one only if it records none.
EOF
    fi
    if [[ -n $resume ]]; then
      start_line="Start by reconciling _Status_ with git (above), then summarise it and the backlog items for \"$topic\", and carry on: respawn the in-flight slices, merge what's handed off, then start the next ready wave."
    else
      start_line="Start by summarising the plan's status and the backlog items for \"$topic\", record the landing mode in the plan's _Status_, then start the first ready wave."
    fi
    if [[ -n $auto ]]; then
      cat <<EOF

**Landing mode: run everything through.** You were started run-through (by the dispatcher, in the registry's order, or by hand), and the user asked for the whole plan to run without prompting. Start every ready slice (every slice it's blocked by is merged into prd/$topic), as many at once as the plan allows; land each green wave yourself; clean up. Ask the user only real questions: a product decision the PRD doesn't settle, a failure you can't fix, or anything that would touch another PRD's branch.

**Asking and reporting, run-through.** The user isn't watching this terminal, so never ask in it. A real question goes through \`pnpm prd ask --topic $topic --question "<text>" --option "<a>" --option "<b>" --recommend <a> --defaults\` (or \`--waits\`, below), which prints its id. $default_rule Right after it, call the PushNotification tool yourself (a tool you call, not a command) with the line \`pnpm prd ask\` printed, so the question reaches the user's phone. Then run \`pnpm prd ask --wait <id>\` in the background and carry on with whatever doesn't depend on the answer; you're woken when it prints. When the user answers in this session instead, record it with \`pnpm prd answer <id> "<reply>"\`. Each landing files a report with \`pnpm prd ask --topic $topic --report "<text>"\` (the \`pnpm prd ready\` summary, the link to try it, and what to try by hand) and is never pushed: no PushNotification for a report. A code landing also leaves \`to-test/<date>-<time>-<topic>.md\` in the main checkout (land writes it; never edit or delete files there). The report text names the topic, what landed and that to-test file, and stands alone: the user reads it later from the asks list, when this session may have ended or rotated, so nothing they need may live only in this conversation. **The only PushNotification you ever send is the line \`pnpm prd ask\` prints for a question**: none for a report, progress, a landing or a failure (what needs the user is a question; ask it).

$start_line
EOF
    elif [[ -n $resume ]]; then
      cat <<EOF

$start_line If _Status_ records no landing mode, ask the user with AskUserQuestion, as a fresh orchestrator would: **ask before each landing**, **run everything through**, or **land some automatically**. Record it in _Status_. A wave you were told to land automatically is the user's go-ahead for that landing; any other landing waits for their word.
EOF
    else
      cat <<EOF

**Landing mode: ask first.** Unless the plan's _Status_ already records one, start by summarising the plan's status and the backlog items for "$topic", then ask the user with AskUserQuestion:
1. How to run it: **ask before each landing** (you stop at every green wave and wait for their word), **run everything through** (you start every ready slice, land each green wave yourself and clean up, asking only real questions), or **land some automatically** (they pick the waves or slices that land without asking; you stop before the others).
2. Which slices to run now, or "every ready slice".
Record the answers in the plan's _Status_ and follow them. A wave you were told to land automatically is the user's go-ahead for that landing; any other landing waits for their word.
EOF
    fi
    ;;
  plan)
    auto="" items=""
    for a in "${@:3}"; do
      case $a in
        --auto) auto=1 ;;
        B-[0-9]*) items+="${items:+ }$a" ;;
        *) echo "plan takes --auto and B-<n> ids, not $a" >&2; exit 1 ;;
      esac
    done
    if [[ -n $auto ]]; then
      ask_line="- **Decide, then report: no interview, and nobody is watching this terminal** (the dispatcher opened you). Read docs/agents/preferences.md and explore the code. Ask only what the handbook's _What to ask_ names (scope, who can see or change what, existing data, compliance, a new dependency, product direction you can't pick with confidence: what the product does, never how it looks), and never in this terminal: each question is its own \`pnpm prd ask --topic $topic --question \"<text>\" --option \"<a>\" --option \"<b>\" --recommend <a> --defaults\` (or \`--waits\`, below), which prints its id; right after it, call the PushNotification tool yourself (a tool you call, not a command) with the line it printed, so the question reaches the user's phone. Then run \`pnpm prd ask --wait <id>\` in the background, with no \`--timeout\`, and keep exploring and writing what doesn't depend on the answer; you're woken when it prints. $default_rule **Never put your own recommendation in place of an answer:** wait until \`--wait\` prints one (the user's, or the default the tool took), and land nothing before it does. With nothing to ask, say so and carry on. Decide everything else yourself: the module sketch, the test choices and the slice breakdown need no approval. **Never ask about a UX or UI detail** (layout, where a control sits, icons or text, wording, colours, defaults, empty states): pick the smallest version that fits the item's words and the existing screens, and record it as assumed in the _Decisions_ table, where the user vetoes."
      report_line="then file the report with \`pnpm prd ask --topic $topic --report \"<text>\"\` (a report is never pushed: send no PushNotification for it; the only one you ever send is the line a question's \`pnpm prd ask\` prints): the text names the topic and what it plans, lists the _Decisions_ table's assumed rows (the costliest to change first) and what the skeptic changed, says how to veto (tell any planning or backlog session, or hold the topic before its first slice starts: \`pnpm backlog prd set $topic flags=hold\`), and stands alone. Then \`pnpm prd rm plan-$topic\`"
    else
      ask_line="- **Decide, then report: no interview.** Read docs/agents/preferences.md and explore the code. Ask the user only what the handbook's _What to ask_ names (scope, who can see or change what, existing data, compliance, a new dependency, product direction you can't pick with confidence: what the product does, never how it looks), in one AskUserQuestion round of at most four questions, your recommendation first, and send no PushNotification for it or for the report; with nothing to ask, say so and carry on. Decide everything else yourself: the module sketch, the test choices and the slice breakdown need no approval. **Never ask about a UX or UI detail** (layout, where a control sits, icons or text, wording, colours, defaults, empty states): pick the smallest version that fits the item's words and the existing screens, and record it as assumed in the _Decisions_ table, where the user vetoes."
      report_line="\`pnpm prd rm plan-$topic\`, report the decisions you assumed (the costliest to change first) and how to start it"
    fi
    cat <<EOF
You are the planning agent for "$topic".

- Your worktree is $loops/plan-$topic, on branch plan/$topic (from dev), with no Docker stack. Work only there; never in the main checkout ($main).
- AGENTS.md is already in your context (CLAUDE.md loads it), so don't Read it again; follow it. Read your handbook, docs/agents/planner.md, and docs/agents/backlog.md, then the area docs the topic touches (_Area index_). Then \`pnpm backlog list\` and \`pnpm backlog show B-<n>\` for the items behind "$topic"${items:+ ($items)}.
$ask_line
- Write the PRD as plans/$topic-prd.md, opening with the handbook's _Decisions_ table and following _The PRD's shape_. Then cut it into tracer-bullet slices, saved as plans/$topic-plan.md, in the handbook's _The plan's shape_ (about six slices at most: cut a bigger one into follow-on topics), with each slice's fields line (_Slice fields_) and acceptance criteria that name the tests (_The test budget_).
- **Don't load the \`write-a-prd\`, \`prd-to-plan\` or \`grill-me\` skills:** they make you interview the user and wait for approval. The handbook has their templates.
- Run the handbook's _The skeptic pass_ with one fresh agent before landing, and act on what it finds.
- Don't file GitHub issues.
- Commit both files on plan/$topic (\`docs($topic): …\`), triage the items, and give the topic its row in the PRD table: when \`pnpm backlog prd list\` already has a row for $topic, set it with \`pnpm backlog prd set $topic after=<topic> hot=<path prefixes>\`; when it has none, add it first with \`pnpm backlog prd add $topic\` (never a hand edit of the table and no \`pnpm backlog commit\`: those commands commit). Then land it yourself as the handbook's _Landing a plan branch_ says: \`pnpm prd land plan/$topic -m "docs($topic): PRD and plan for … (B-<n>, …)"\` (plain: a plan branch never needs a forced landing), $report_line, and as your last step run \`cd $main && pnpm prd end\` (it ends this session and closes its tab; \`cd\` first, since \`rm\` deleted your worktree).

Start by summarising what the backlog says about "$topic", then explore.
EOF
    ;;
  slice)
    n=${3:?slice number}
    continuing=""
    for flag in "${@:4}"; do
      case $flag in
        --continue) continuing=1 ;;
        *) echo "slice takes --continue, not $flag" >&2; exit 1 ;;
      esac
    done
    # The slice's fields (Stack, Reads, Tests) from its plan: this worktree's
    # copy, else prd/<topic>'s. Missing fields get the defaults and a warning.
    plan_text=$(cat "$here/plans/$topic-plan.md" 2>/dev/null || git -C "$main" show "prd/$topic:plans/$topic-plan.md" 2>/dev/null || true)
    fields_cli=$(dirname "$0")/slice-fields.mjs
    fields=$(node "$fields_cli" "$n" <<<"$plan_text" 2>/dev/null | sed 's/^/  - /')
    warnings=$(node "$fields_cli" "$n" <<<"$plan_text" 2>&1 >/dev/null | sed 's/^warning: slice [0-9]*: //' | paste -sd ';' - | sed 's/;/; /g')
    stack=$(node "$fields_cli" "$n" --get stack <<<"$plan_text" 2>/dev/null || echo no)
    # Once the worktree exists, what it really has wins (new.sh decides).
    if [[ -f $loops/$topic-$n/.env.loop ]]; then
      if grep -q '^SLOT=[0-9]' "$loops/$topic-$n/.env.loop"; then stack=yes; else stack=no; fi
    fi
    if [[ $stack == yes ]]; then
      stack_line="- Your stack's slot and ports are in \`.env.loop\` and \`apps/web/.env\` (\`WEB_PORT\`). \`pnpm prd serve\` runs your dev server in the background."
    else
      stack_line="- Your worktree has no Docker stack. \`pnpm prd check\` (through the check lease; never a bare \`pnpm check\`) still runs everything it needs: integration tests use your own database on the shared test Postgres (created on first use). The dev server and browser checks need a stack: \`pnpm prd stack up\` adds one and \`pnpm prd stack down\` removes it when you're done (tell your orchestrator)."
    fi
    cat <<EOF
You are the agent for slice $n of the "$topic" PRD.

- Your worktree is $loops/$topic-$n, on branch slice/$topic/$n (from prd/$topic). \`cd\` there in every shell and work only there; Read, Edit and Write use absolute paths inside it.
- AGENTS.md (the core) is already in your context (CLAUDE.md loads it); Read it only if it isn't. Then read ${prd_read}slice $n in plans/$topic-plan.md${no_prd:-}, then the docs its Reads field names. AGENTS.md's _Area index_ finds any other rule you need.
- This slice's fields, from the plan:
$fields
EOF
    if [[ -n $warnings ]]; then
      cat <<EOF
- The plan's fields for slice $n are incomplete ($warnings), so the defaults apply: no stack and nothing extra to read. If that looks wrong, ask your orchestrator.
EOF
    fi
    cat <<EOF
- Build only slice $n. Leave other slices' regions and files alone.
- Read your handbook, docs/agents/loop.md, and follow it exactly: its _Loop rules_, the rules across PRDs it points to, and the _Hand-off_ format for your final message.
$stack_line Delete any scratch scripts before you commit.
- Check with \`pnpm prd check --quick "slice hand-off"\` (it takes a check lease and needs a clean tree, so commit first), never a bare \`pnpm check\`. On your slice branch it is the slice check: typecheck, lint, format, every unit test, and only the integration and component test files you added or edited (never a full check; it adds the tooling tests when you change the tooling). Run no other component test or browser check: the orchestrator runs the rest and sends you what breaks. To wait on a check running in the background, run \`pnpm prd wait check\` (it returns once this worktree's check is gone, and exits 75 at its \`--timeout\`); never \`pgrep -f\` (it matches its own shell and never exits).
- Commit subjects are Conventional Commits with the topic as scope: \`feat($topic): …\`, \`fix($topic): …\`, \`test($topic): …\`. The commit-msg hook refuses anything else.
- You may update your backlog items' notes (\`pnpm backlog note B-<n> "..."\`). Don't claim, land or reassign items; your orchestrator does that.
EOF
    if [[ -n $continuing ]]; then
      cat <<EOF

**You're continuing slice $n, not starting it.** An earlier agent worked in this worktree and was interrupted (a restart, a crash or a usage limit), and its hand-off was lost. Before writing any code:
- Read what it did: \`pnpm log --oneline prd/$topic..HEAD\`, \`git status\`, \`git diff prd/$topic...HEAD\` (what's committed) and \`git diff\` (what isn't). Uncommitted changes are its work too: keep them unless they're broken.
- Check that against the slice's acceptance criteria and finish what's missing from there. Don't start over, and don't redo committed work.
- If everything is committed and \`pnpm prd check\` (or \`--quick\`) passes, don't rebuild: run whatever the slice's checks still need, and write the hand-off from the branch (its commits are the record).
EOF
    fi
    ;;
  *) echo "kind must be orchestrator, plan, slice, hotfix, backlog or recover" >&2; exit 1 ;;
esac
