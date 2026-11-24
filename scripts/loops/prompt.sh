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
#   prompt.sh backlog [--brief <file> | --no-brief | --guide]   a backlog and inbox planning session in the main checkout (pnpm prd plan);
#     it reads whether the dispatcher runs: then deciding what runs next is moving and holding rows.
#     --brief puts the file's text at the top, under "Brief from the session before";
#     --no-brief says at the top that the context watch rotated the last session with none
#   prompt.sh inbox                    the inbox agent, in its own directory outside the repository
#     (pnpm prd inbox): self-contained, so it reads no doc; it adds, rewords, moves and removes unfiled inbox lines, nothing else
#   prompt.sh recover                  the recovery agent, in the main checkout (pnpm prd recover opens it)
#   prompt.sh tidy                     the cleanup brief for a cheap session (haiku), in the main checkout
#   prompt.sh skeptic ask|land|plan --evidence <file>   the brief for a fresh skeptic (skeptic.mjs)
#
# Where each part lives: this file only picks the kind's part and sources it,
# so open just the one you change.
#   prompts/shared.sh        default_rule, skeptic_rule, bye_line (every kind)
#   prompts/backlog.sh       backlog and its --guide
#   prompts/inbox.sh         inbox
#   prompts/recover.sh       recover
#   prompts/tidy.sh          tidy
#   prompts/hotfix.sh        hotfix
#   prompts/topic.sh         the topic's PRD and fixes lines (orchestrator, plan, slice)
#   prompts/orchestrator.sh  orchestrator, with --auto and --resume
#   prompts/plan.sh          plan, with --auto and B-n ids
#   prompts/slice.sh         slice, with --continue
#   skeptic.mjs              skeptic (its brief)
# The parts are sourced, not run: they share this shell's arguments and
# variables, and a part that exits ends the script.
# prompt-golden.test.mjs holds every kind's output byte for byte.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

kind=${1:?kind: orchestrator, plan, slice, hotfix, backlog, inbox, recover, tidy or skeptic}
prompts=$(dirname "$0")/prompts
# shellcheck source=prompts/shared.sh
source "$prompts/shared.sh"
case $kind in
  backlog | inbox | recover | tidy)
    # shellcheck disable=SC1090
    source "$prompts/$kind.sh"
    ;;
  skeptic) exec node "$(dirname "$0")/skeptic.mjs" brief "${@:2}" ;;
esac
topic=${2:?topic}
items=${*:3}
if [[ $kind == hotfix ]]; then
  # shellcheck source=prompts/hotfix.sh
  source "$prompts/hotfix.sh"
fi
# shellcheck source=prompts/topic.sh
source "$prompts/topic.sh"
case $kind in
  orchestrator | plan | slice)
    # shellcheck disable=SC1090
    source "$prompts/$kind.sh"
    ;;
  *) echo "kind must be orchestrator, plan, slice, hotfix, backlog or recover" >&2; exit 1 ;;
esac
