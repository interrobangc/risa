#!/usr/bin/env bash
# List every worktree in .loops: name, slot, branch, commits ahead of the branch
# it merges into, dirty state, its containers and its dev server link. Then the
# machine's load averages, any stale slot lease, and who holds the browser check
# leases, the shared test Postgres, and leftovers for `pnpm prd gc`: merged slice
# worktrees and stacks stopped for over a day. (pnpm prd status, status-watch)
set -euo pipefail
# shellcheck source=stack-lib.sh
source "$(dirname "$0")/stack-lib.sh"

fmt='%-22s %-4s %-28s %-22s %-6s %-10s %s\n'
# shellcheck disable=SC2059
printf "$fmt" NAME SLOT BRANCH "AHEAD OF" STATE CONTAINERS "DEV SERVER"
found="" leftovers=""
limit=$(gc_stopped_after)
for dir in "$loops"/*/; do
  [[ -d $dir ]] || continue
  dir=${dir%/}; name=$(basename "$dir")
  branch=$(git -C "$dir" branch --show-current)
  parent=$(parent_of "$branch")
  ahead=$(git -C "$dir" rev-list --count "$parent..HEAD" 2>/dev/null || echo '?')
  dirty=$([[ -n $(git -C "$dir" status --porcelain) ]] && echo dirty || echo clean)
  proj=$(env_get "$dir/.env" CARETOOK_STACK)
  if [[ -n $proj ]]; then
    slot=${proj#caretook-loop}
    up=$(docker compose -p "$proj" ps -q 2>/dev/null | wc -l | tr -d ' ')
    port=$(web_port "$dir")
    stack="$up up"
    if ((up == 0)); then
      secs=$(stack_stopped_secs "$dir")
      [[ -n $secs ]] && ((secs >= limit)) &&
        leftovers+="stopped stack: $name ($proj stopped $(fmt_age "$secs") ago): pnpm prd gc"$'\n'
    fi
    web="http://localhost:$port $([[ -n $(server_pids "$port") ]] && echo "(running)" || echo "(stopped: pnpm prd serve $name)")"
  else
    slot=- stack=none web=-
  fi
  found=1
  slice_merged "$dir" && leftovers+="merged: $name ($branch is merged into $parent): pnpm prd gc"$'\n'
  # shellcheck disable=SC2059
  printf "$fmt" "$name" "$slot" "$branch" "+$ahead $parent" "$dirty" "$stack" "$web"
done
[[ -n $found ]] || echo "(no worktrees: pnpm prd start <topic>)"
echo "PRD worktrees: $(prd_count) of $max_prds"

# Sections are separated by a blank line; stale leases only show when there are any.
stale=""
for d in "$leases"/*/; do
  [[ -f $d/name ]] || continue
  holder=$(cat "$d/name")
  [[ -d $loops/$holder ]] || stale+="stale lease: slot $(basename "$d") held by $holder (no worktree; rm -r $d)"$'\n'
done
[[ -z $stale ]] || printf '\n%s' "$stale"
[[ -z $leftovers ]] || printf '\n%s' "$leftovers"

echo
"$(dirname "$0")/test-db.sh" status 2>/dev/null || echo "shared test Postgres: unknown (is Docker running?)"

echo
for n in $(seq 1 "$browser_slots"); do
  d=$browser_leases/$n
  if [[ ! -d $d ]]; then
    echo "browser lease $n of $browser_slots: free"
  elif browser_lease_alive "$d"; then
    echo "browser lease $n of $browser_slots: $(browser_lease_line "$d")"
  else
    echo "browser lease $n of $browser_slots: stale, $(browser_lease_line "$d") isn't running (the next pnpm prd browser takes it over)"
  fi
done

echo
# The load, against the cores and the 1-minute load browser checks treat as busy.
load=$(load_avg) cores=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo '?')
busy=${CARETOOK_BROWSER_BUSY:-40} l1=${load%% *}
echo "load: $load (1, 5, 15 min) on $cores cores$( ((${l1%%.*} > busy)) && echo " · BUSY: over $busy, browser checks will wait before retrying")"
