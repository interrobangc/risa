#!/usr/bin/env bash
# Print the first prompt for a session, so starting one is a single command.
#
#   prompt.sh orchestrator <topic>     paste into a new session in .loops/<topic>:
#     cd .loops/<topic> && claude --remote-control prd-<topic> "$(scripts/loops/prompt.sh orchestrator <topic>)"
#     (pnpm prd start <topic> prints this)
#   prompt.sh slice <topic> <n>        the prompt an orchestrator gives a slice agent
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

kind=${1:?kind: orchestrator or slice}; topic=${2:?topic}

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
    cat <<EOF
You are the PRD orchestrator for "$topic".

- Your integration worktree is $loops/$topic, on branch prd/$topic. Work only there; never in the main checkout ($main, which stays on dev and belongs to the user, the dev keeper).
- Read AGENTS.md first, especially _PRDs and parallel loops_. Then read ${prd_read}plans/$topic-plan.md${no_prd:-} (its _Status_ section is where the last orchestrator left off).
- At every wave boundary, starting now: \`pnpm backlog ingest\` (files the user's new inbox bullets), then \`pnpm backlog list\`. For new items (status inbox) that belong to "$topic", propose it: \`pnpm backlog set B-<n> prd=$topic status=triaged\` plus a \`note\` saying why; the user reviews. Claim each item before you work it (\`pnpm backlog claim B-<n>\`).
- Run a wave: start only the slices the user asks for, with \`pnpm prd slice $topic <n>\`, and spawn one background agent per slice with the prompt from \`pnpm prd prompt slice $topic <n>\`.
- Merge finished slices into prd/$topic in plan order (\`git merge --no-ff -m "feat($topic): <what it adds> (slice <n>, B-<n>)" slice/$topic/<n>\`), check (\`pnpm check\` plus the smoke checks for the areas the merge touched, \`pnpm prd browser --changed --smoke --base HEAD^\`; AGENTS.md, _Browser check budget_; the full suite runs once per landing), mark their items \`pnpm backlog done\`, and tear down.
- When the wave is green: \`pnpm prd sync\`, \`pnpm prd check\`, \`pnpm prd serve --restart\`, then show the user the output of \`pnpm prd ready\` (the link to try it, and what it addresses) with anything worth trying by hand. Land with \`pnpm prd land $topic -m "<subject>"\` only after the user says to land this wave; never before.
- Every commit subject is a Conventional Commit (\`feat($topic): …\`, \`fix($topic): …\`, \`docs\`, \`test\`, \`chore\`…); the commit-msg hook refuses anything else.

Start by summarising the plan's status and the backlog items for "$topic", and ask the user which slices to run.
EOF
    ;;
  slice)
    n=${3:?slice number}
    cat <<EOF
You are the agent for slice $n of the "$topic" PRD.

- Your worktree is $loops/$topic-$n, on branch slice/$topic/$n (from prd/$topic). \`cd\` there in every shell and work only there; Read, Edit and Write use absolute paths inside it.
- Read AGENTS.md first, then ${prd_read}slice $n in plans/$topic-plan.md${no_prd:-}.
- Build only slice $n. Leave other slices' regions and files alone.
- Follow AGENTS.md's _Loop rules_ and _Rules across PRDs_ exactly, including the hand-off format for your final message.
- Your stack's slot and ports are in \`.env.loop\` and \`apps/web/.env\` (\`WEB_PORT\`). \`pnpm prd serve\` runs your dev server in the background. Delete any scratch scripts before you commit.
- Commit subjects are Conventional Commits with the topic as scope: \`feat($topic): …\`, \`fix($topic): …\`, \`test($topic): …\`. The commit-msg hook refuses anything else.
- You may update your backlog items' notes (\`pnpm backlog note B-<n> "..."\`). Don't claim, land or reassign items; your orchestrator does that.
EOF
    ;;
  *) echo "kind must be orchestrator or slice" >&2; exit 1 ;;
esac
