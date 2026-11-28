#!/usr/bin/env bash
# Add, remove or read a worktree's dev stack, through the project's stack hooks
# (the config's hooks.stackUp, stackDown, stackStatus, stackReady).
# (prd stack up|down|status|ready [name])
#
#   stack.sh up [name]       lease a slot and bring the stack up (the hook writes
#                            its env files, starts it, migrates and seeds); on a
#                            worktree that has a stopped stack, start it again
#   stack.sh down [name]     take the stack down (the hook removes it, its data
#                            and its env files) and release the slot lease
#   stack.sh status [name]   the stack's facts, key=value lines (none: no stack)
#   stack.sh ready [name]    the same, exit 0 only when the stack runs
#
# With no stack hooks there is no stack: down releases any slot lease and says
# so, and status and ready say so on stderr; each exits 0.
#
# The name defaults to the worktree you're in. The core keeps the slot leases
# and the disk guard; every fact about the stack is the hook's, as key=value
# lines on its stdout (its progress goes to stderr).
set -euo pipefail
# shellcheck source=stack-lib.sh
source "$(dirname "$0")/stack-lib.sh"

cmd=${1:-}; (($#)) && shift
name=${1:-$(here_name)}
[[ -n $name ]] || die "stack $cmd: give a worktree name, or run it inside a .loops worktree"
dir=$loops/$name
[[ -d $dir ]] || die "no worktree at $dir"
branch=$(git -C "$dir" branch --show-current)
prd=$(tool_command prd)

case $cmd in
  up)
    require_disk "a stack for $name"
    args=()
    proj=$(fact project "$(stack_hook stackStatus "$dir" 2>/dev/null || true)")
    if [[ -n $proj ]]; then
      echo "$name already has a stack ($proj); starting it"
    else
      lease_free_slot "$name"
      args=(--slot "$slot")
    fi
    # The hook undoes a half-made stack itself; the slot lease is ours to give back.
    if ! facts=$(stack_hook stackUp "$dir" ${args[@]+"${args[@]}"} --base "$(parent_of "$branch")"); then
      [[ -n $proj ]] || release_slot "$name"
      die "stack up failed for $name"
    fi
    echo
    echo "Stack up for $name (slot $(fact slot "$facts"), project $(fact project "$facts"))"
    echo "  dev server   $prd serve $name   → $(fact url "$facts")"
    summary=$(fact summary "$facts")
    [[ -z $summary ]] || echo "  $summary"
    echo "  done with it $prd stack down $name"
    ;;
  down)
    # No stackDown hook: there's no stack to take down; a lease is still ours (RISA-991).
    if ! has_hook stackDown; then
      release_slot "$name"
      echo "$name has no stack"
      exit 0
    fi
    facts=$(stack_hook stackDown "$dir" --base "$(parent_of "$branch")") || die "stack down failed for $name"
    release_slot "$name"
    proj=$(fact project "$facts")
    [[ -n $proj ]] || { echo "$name has no stack"; exit 0; }
    echo "Stack down for $name: $proj removed, slot released ($prd stack up $name brings it back)"
    ;;
  status | ready)
    hook=stackStatus
    [[ $cmd == status ]] || hook=stackReady
    has_hook "$hook" || { echo "$name: no stack hooks in the config" >&2; exit 0; }
    stack_hook "$hook" "$dir"
    ;;
  *) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1 ;;
esac
