#!/usr/bin/env bash
# Print the first prompt for a session, so starting one is a single command.
#
#   prompt.sh orchestrator <topic>     paste into a new session in .loops/<topic>:
#     cd .loops/<topic> && claude --remote-control prd-<topic> "$(scripts/loops/prompt.sh orchestrator <topic>)"
#     (pnpm prd start <topic> prints this)
#   prompt.sh orchestrator <topic> --auto   the same, landing every wave without asking (pnpm prd queue uses it)
#   prompt.sh orchestrator <topic> --resume [--auto]   take over after an interruption: reconcile
#     the plan's _Status_ with git, respawn in-flight slices with --continue
#   prompt.sh plan <topic> [B-n …]     a planning session in .loops/plan-<topic> (pnpm prd plan <topic> --open)
#   prompt.sh slice <topic> <n>        the prompt an orchestrator gives a slice agent
#   prompt.sh slice <topic> <n> --continue   the same, for an agent picking up an interrupted slice
#   prompt.sh hotfix <name> ["<the fix>"]   a hotfix session in .loops/hotfix-<name> (pnpm prd hotfix prints it)
#   prompt.sh backlog                  a backlog and inbox planning session in the main checkout (pnpm prd plan)
#   prompt.sh recover                  the recovery agent, in the main checkout (pnpm prd recover opens it)
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

kind=${1:?kind: orchestrator, plan, slice, hotfix, backlog or recover}
if [[ $kind == backlog ]]; then
  cat <<EOF
You are the new backlog/inbox planning agent. Do the standing work below, then ask what this session is for.

- You're in the main checkout ($main), on dev. It's the user's: make no code changes here unless they ask for a small one (AGENTS.md, _Working rules_).
- AGENTS.md is already in your context (CLAUDE.md loads it), so don't Read it again; follow it. Read docs/agents/backlog.md (the backlog, triage, and _Deciding what's next_). Then \`pnpm backlog ingest\`, \`pnpm backlog list\`, \`pnpm prd status\` (what's running) and the queue: \`ls $loops/.queue\` (one ticket per topic waiting in \`pnpm prd queue\`, named \`<time>-<pid>-<topic>\`, oldest first; empty or missing means nothing is queued). Name what's queued in your report, and never propose starting or queueing a topic that is already queued. Also read \`pnpm prd asks\` (the open questions and reports that run-through sessions filed for the user) and \`pnpm backlog prd list\` (the PRD registry: order, after, hot files, flags).
- Triage new items (\`set B-<n> prd=<topic> status=triaged\` with a \`note\`; several ids in one write); the user reviews.
- Hand bulk reading (the full backlog, long plans and PRDs) and backlog chores to a haiku helper that returns a short summary (docs/agents/orchestrator.md, _Models_); keep the proposals and the talk with the user yourself.
- Then, **always, before the first question**, print an overview from what you've already collected (no new commands for it), as three short parts. Start it with what waits on the user: open asks (oldest first, each with its age) and any PRD on hold in the registry. **Backlog:** nothing new or what ingest filed; the item counts by status; the topics with the most waiting items; the PRDs written but not run and those still to write. **Orchestrators:** each running PRD by what it does, how far ahead of dev it is and its slices in flight; planning worktrees; the slots used of three; what's queued; the load if it's high. **To triage:** each item you triaged just now with the topic you proposed and why, any item still untriaged, and anything waiting on the user's review; say "nothing" when there is nothing.
- After the overview ask **one** AskUserQuestion, multi-select, and nothing else: what is this session for? Its three options: **Write a PRD** from the backlog; **Decide what to run next** from the queue; **Triage a new issue or idea** now.
- The next question follows only from what they picked. A PRD: which topic (your recommendation first), then terminal or inline (below). What to run: start, queue or wait for each ready PRD. A new issue: ask them to describe it, then file and triage it. Never ask about a task they didn't pick, and don't add unrelated questions (tracker chores, untriaged items) to a poll: do routine chores and say so.
- Ask with AskUserQuestion, never numbered question lists.
- The user doesn't read ids: wherever you name an item, in a question, its options or the text before it, give its short plain title with the id (B-52 export all data). Name a PRD topic by what it does, not only its slug.
- To plan a topic, first ask with AskUserQuestion: a planner in a new terminal (the user runs \`! pnpm prd plan <topic> --open [B-n …]\` themselves) or planning inline here (\`pnpm prd plan <topic> [B-n …]\`, no \`--open\`, then work in its worktree), never on dev. Never run \`--open\` from your own shell: it runs the planner inside your command instead of opening a tab. To run a planned one, never run \`pnpm prd start\` or \`pnpm prd queue\` from your own shell: print the commands as options for the user to run themselves (\`pnpm prd start <topic>\`, then its orchestrator; or \`pnpm prd queue <topic>\`).
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
- For each \`open-session\` with no live session, open it with the opener: \`pnpm prd open <target>\`. It opens a new iTerm2 tab that continues the worktree's saved conversation (\`claude --continue --remote-control <session>\`) or starts a fresh one with the resume prompt, keeping the session's name. Without iTerm2 it prints the command instead: pass that on to the user. Open each one once; never open a session that ListAgents shows as live.
- Then report, as a short table: each session, and whether you messaged it, opened it in a tab, or printed its command (and anything that failed). Then end: you have nothing else to do.

Start by reading the inventory and ListAgents.
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

# A topic may have no PRD (quick-fixes): then its plan is the whole spec.
here=$(git rev-parse --show-toplevel 2>/dev/null || echo "$main")
if [[ -f $here/plans/$topic-prd.md ]]; then
  prd_read="plans/$topic-prd.md and "
else
  prd_read=""
  no_prd=" (there's no plans/$topic-prd.md: the plan is the whole spec)"
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
- At every wave boundary, starting now: \`pnpm backlog ingest\`, then \`pnpm backlog list\`. Propose new items that belong to "$topic" (\`pnpm backlog set B-<n> … prd=$topic status=triaged\` plus a \`note\`); the user reviews. Claim items before you work them (\`pnpm backlog claim B-<n> …\`).
- Run a wave: \`pnpm prd slice $topic <n>\` for each slice in it, and spawn one background agent per slice with the prompt from \`pnpm prd prompt slice $topic <n>\`, on the model the handbook's _Models_ gives (note it in _Status_). Hand light work to a haiku helper with a tight brief.
- Merge finished slices into prd/$topic in plan order (\`git merge --no-ff -m "feat($topic): <what it adds> (slice <n>, B-<n>)" slice/$topic/<n>\`), with no checks between merges (they run once, before landing), mark their items \`pnpm backlog done\`, and tear down.
- When the wave is green: \`pnpm prd sync\`, then the check: a wave gate is \`pnpm prd check --quick "<why>"\` (the tooling makes it a full check itself when the diff touches a migration, seeds, the sync config, a lockfile, a package.json or the Vitest config); the full \`pnpm prd check\` runs once, on the wave's tip before its PR, and where the handbook's _The check gate_ calls for it (a conflict resolved in code, both sides changing a hot file, or when unsure); docs and tooling-only changes need neither. Then \`pnpm prd serve --restart\`, then show the user the output of \`pnpm prd ready\` (the link to try it, and what it addresses) with the browser checks you ran and anything worth trying by hand. Land with \`pnpm prd land $topic -m "<subject>"\` (never \`--force\`) as the landing mode allows.
- **Code lands through a GitHub PR into dev, reviewed by Codex.** As soon as a wave is green, open it with \`pnpm prd pr $topic\` (rerun after every push) and run \`pnpm prd review $topic --wait\` in the background. Triage each finding: a real one goes to a fix agent on prd/$topic, one you decline gets a reply on its thread with the reason; resolve fixed and declined threads (\`review --resolve <threadId>\`; Codex doesn't resolve its own), push, then \`review --again\` until clean. After about three rounds, ask the user. Land on the user's word through the PR; \`--no-review\` only when they say so (and after a timeout, exit 75, ask them: merge without review or keep waiting).
- When a slice is blocked by another PRD's work (another orchestrator's slice, or a backlog item landing in dev), don't stall: find that orchestrator with ListAgents and ask it with SendMessage to message you when the work lands in dev, and set a background check (a Bash loop with run_in_background that exits once \`pnpm log dev\` or \`pnpm backlog list\` shows it), so you're woken whichever comes first. Then \`pnpm prd sync\` and carry on.
- At each landing, fold that wave's decisions into the docs as the handbook's _Docs at landing_ says (area doc, role doc, or the core; trim at least what you fold in). When the last wave has landed, run \`pnpm prd rm $topic\`, then \`pnpm prd end\` (your last step: it ends this session and closes its tab).
- **One session per wave: drain, then rotate.** After a landing and its docs (not the last one), start no new slice; once the slices in flight are merged, commit _Status_ and run \`pnpm prd rotate\`; with none in flight, rotate at once. It opens a fresh session with the resume prompt (the same name, your landing mode) in a background tab and ends this one, so write _Status_ as the hand-over first and say nothing after it. \`pnpm prd rotate --mid-wave\` (it ends the slice agents too; the fresh session respawns them) only on the user's word.
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

**Landing mode: run everything through.** The user queued you with \`pnpm prd queue $topic\` and asked for the whole plan to run without prompting. Start every ready slice (every slice it's blocked by is merged into prd/$topic), as many at once as the plan allows; land each green wave yourself; clean up. Ask the user only real questions: a product decision the PRD doesn't settle, a failure you can't fix, or anything that would touch another PRD's branch.

**Asking and reporting, run-through.** The user isn't watching this terminal, so never ask in it. A real question goes through \`pnpm prd ask --topic $topic --question "<text>" --option "<a>" --option "<b>" --recommend <a>\`, which prints its id. Right after it, call the PushNotification tool yourself (a tool you call, not a command) with the line \`pnpm prd ask\` printed, so the question reaches the user's phone. Then run \`pnpm prd ask --wait <id>\` in the background and carry on with whatever doesn't depend on the answer; you're woken when it prints. When the user answers in this session instead, record it with \`pnpm prd answer <id> "<reply>"\`. Each landing files a report with \`pnpm prd ask --topic $topic --report "<text>"\` (the \`pnpm prd ready\` summary, the link to try it, and what to try by hand) and pushes it with PushNotification. Push other reports only when something failed.

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
    cat <<EOF
You are the planning agent for "$topic".

- Your worktree is $loops/plan-$topic, on branch plan/$topic (from dev), with no Docker stack. Work only there; never in the main checkout ($main).
- AGENTS.md is already in your context (CLAUDE.md loads it), so don't Read it again; follow it. Read your handbook, docs/agents/planner.md, and docs/agents/backlog.md, then the area docs the topic touches (_Area index_). Then \`pnpm backlog list\` and \`pnpm backlog show B-<n>\` for the items behind "$topic"${items:+ ($items)}.
- **Decide, then report: no interview.** Read docs/agents/preferences.md and explore the code. Ask the user only what the handbook's _What to ask_ names (scope, who can see or change what, existing data, compliance, a new dependency, product direction you can't pick with confidence: what the product does, never how it looks), in one AskUserQuestion round of at most four questions, your recommendation first, with a PushNotification just before it so the question reaches the user's phone; with nothing to ask, say so and carry on. Decide everything else yourself: the module sketch, the test choices and the slice breakdown need no approval. **Never ask about a UX or UI detail** (layout, where a control sits, icons or text, wording, colours, defaults, empty states): pick the smallest version that fits the item's words and the existing screens, and record it as assumed in the _Decisions_ table, where the user vetoes.
- Write the PRD as plans/$topic-prd.md, opening with the handbook's _Decisions_ table and following _The PRD's shape_. Then cut it into tracer-bullet slices, saved as plans/$topic-plan.md, in the handbook's _The plan's shape_ (about six slices at most: cut a bigger one into follow-on topics), with each slice's fields line (_Slice fields_) and acceptance criteria that name the tests (_The test budget_).
- **Don't load the \`write-a-prd\`, \`prd-to-plan\` or \`grill-me\` skills:** they make you interview the user and wait for approval. The handbook has their templates.
- Run the handbook's _The skeptic pass_ with one fresh agent before landing, and act on what it finds.
- Don't file GitHub issues.
- Commit both files on plan/$topic (\`docs($topic): …\`), triage the items, and add the topic's row to the PRD table with \`pnpm backlog prd add $topic\`, then \`pnpm backlog prd set $topic after=<topic> hot=<path prefixes>\` (never a hand edit of the table and no \`pnpm backlog commit\`: those commands commit), then land it yourself as the handbook's _Landing a plan branch_ says: \`pnpm prd land plan/$topic --force -m "docs($topic): PRD and plan for … (B-<n>, …)"\`, \`pnpm prd rm plan-$topic\`, report the decisions you assumed (the costliest to change first) and how to start it, and as your last step run \`pnpm prd end\` (it ends this session and closes its tab).

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
- Check with \`pnpm prd check --quick "slice hand-off"\` (it takes a check lease and needs a clean tree, so commit first), never a bare \`pnpm check\`. It runs typecheck, lint, format and the tests related to your diff; it becomes a full check by itself when the diff touches a migration, seeds, the sync config, a lockfile, a package.json or the Vitest config, and adds the tooling tests when you change the tooling.
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
