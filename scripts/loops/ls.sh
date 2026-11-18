#!/usr/bin/env bash
# List every worktree in .loops: name, slot, branch, commits ahead of the branch
# it merges into, dirty state, and its stack. Then any stale slot lease.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

printf '%-26s %-4s %-32s %-26s %-6s %s\n' NAME SLOT BRANCH "AHEAD OF PARENT" STATE STACK
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
    stack="$proj ($up up) web :$(env_get "$dir/apps/web/.env" WEB_PORT)"
  else
    slot=- stack=none
  fi
  printf '%-26s %-4s %-32s %-26s %-6s %s\n' "$name" "$slot" "$branch" "+$ahead $parent" "$dirty" "$stack"
done
echo "PRD worktrees: $(prd_count) of $max_prds"

for d in "$leases"/*/; do
  [[ -f $d/name ]] || continue
  holder=$(cat "$d/name")
  [[ -d $loops/$holder ]] || echo "stale lease: slot $(basename "$d") held by $holder (no worktree; rm -r $d)"
done
