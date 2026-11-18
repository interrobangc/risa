#!/usr/bin/env bash
# Print the first prompt for a session, so starting one is a single command.
#
#   prompt.sh orchestrator <topic>     paste into a new session in .loops/<topic>:
#     cd .loops/<topic> && claude "$(scripts/loops/prompt.sh orchestrator <topic>)"
#   prompt.sh slice <topic> <n>        the prompt an orchestrator gives a slice agent
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

kind=${1:?kind: orchestrator or slice}; topic=${2:?topic}
case $kind in
  orchestrator)
    cat <<EOF
You are the PRD orchestrator for "$topic".

- Your integration worktree is $loops/$topic, on branch prd/$topic. Work only there; never in the main checkout ($main, which stays on dev and belongs to the user, the dev keeper).
- Read AGENTS.md first, especially _PRDs and parallel loops_. Then read plans/$topic-prd.md and plans/$topic-plan.md (its _Status_ section is where the last orchestrator left off).
- Read the live backlog: \`pnpm backlog list --prd $topic\` (it reads dev's copy). Claim each item before you work it (\`pnpm backlog claim B-<n>\`), and recheck the backlog at every wave boundary.
- Run one wave: start only the slices the user asks for, with \`scripts/loops/new.sh slice $topic <n>\`, and spawn one background agent per slice with the prompt from \`scripts/loops/prompt.sh slice $topic <n>\`.
- Merge finished slices into prd/$topic in plan order, check, and tear down. When the wave is green, sync dev into prd/$topic and tell the user it's ready to land. Don't merge into dev yourself.

Start by summarising the plan's status and the backlog items for "$topic", and ask the user which slices to run.
EOF
    ;;
  slice)
    n=${3:?slice number}
    cat <<EOF
You are the agent for slice $n of the "$topic" PRD.

- Your worktree is $loops/$topic-$n, on branch slice/$topic/$n (from prd/$topic). \`cd\` there in every shell and work only there; Read, Edit and Write use absolute paths inside it.
- Read AGENTS.md first, then plans/$topic-prd.md and slice $n in plans/$topic-plan.md.
- Build only slice $n. Leave other slices' regions and files alone.
- Follow AGENTS.md's _Loop rules_ and _Cross-PRD rules_ exactly, including the hand-off format for your final message.
- You may update your backlog items' notes (\`pnpm backlog note B-<n> "..."\`). Don't claim, land or reassign items; your orchestrator does that.
EOF
    ;;
  *) echo "kind must be orchestrator or slice" >&2; exit 1 ;;
esac
