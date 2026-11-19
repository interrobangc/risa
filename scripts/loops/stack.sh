#!/usr/bin/env bash
# Add or remove a worktree's dev stack (Postgres, PowerSync and its storage,
# and the dev server's env). (pnpm prd stack up|down [name])
#
#   stack.sh up [name]     lease a slot, write the env files, start Compose,
#                          migrate and seed; on a worktree that has a stopped
#                          stack, start it again
#   stack.sh down [name]   stop the dev server, remove the Compose projects and
#                          their data, the stack's env files and the slot lease
#
# The name defaults to the worktree you're in. Integration tests don't need a
# stack (they use the shared test Postgres), so `down` leaves
# packages/data/.env.test.local alone.
set -euo pipefail
# shellcheck source=stack-lib.sh
source "$(dirname "$0")/stack-lib.sh"

cmd=${1:-}; (($#)) && shift
name=${1:-$(here_name)}
[[ -n $name ]] || die "stack $cmd: give a worktree name, or run it inside a .loops worktree"
dir=$loops/$name
[[ -d $dir ]] || die "no worktree at $dir"
branch=$(git -C "$dir" branch --show-current)
base=$(env_get "$dir/.env.loop" BASE_BRANCH); base=${base:-$(parent_of "$branch")}

case $cmd in
  up)
    if [[ -n $(stack_project "$dir") ]]; then
      echo "$name already has a stack ($(stack_project "$dir")); starting it"
    else
      require_main_env
      lease_free_slot "$name"
      # Undo a half-made stack: its containers, env files and the lease.
      trap 'echo "stack up failed: taking it down again" >&2; stack_teardown "$dir" || true
        rm -f "$dir/.env" "$dir/packages/data/.env" "$dir/apps/web/.env"
        write_stackless_env "$dir" "$base"; release_slot "$name"' ERR
      write_stack_env "$dir" "$slot" "$base"
    fi
    [[ -f $dir/packages/data/.env.test.local ]] || write_test_env "$dir" "$name"
    (cd "$dir" && use_node && pnpm datastore:start)
    trap - ERR
    slot=$(env_get "$dir/.env.loop" SLOT); slot_ports "$slot"
    echo
    echo "Stack up for $name (slot $slot, project caretook-loop$slot)"
    echo "  dev server   pnpm prd serve $name   → http://localhost:$web"
    echo "  Postgres     :$pg   PowerSync :$ps"
    echo "  done with it pnpm prd stack down $name"
    ;;
  down)
    proj=$(stack_project "$dir")
    if [[ -z $proj ]]; then
      release_slot "$name"
      echo "$name has no stack"; exit 0
    fi
    stack_teardown "$dir"
    rm -f "$dir/.env" "$dir/packages/data/.env" "$dir/apps/web/.env" "$dir/.serve-mode" "$dir/.serve-built"
    write_stackless_env "$dir" "$base"
    release_slot "$name"
    echo "Stack down for $name: $proj removed, slot released (pnpm prd stack up $name brings it back)"
    ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1 ;;
esac
