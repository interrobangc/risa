#!/usr/bin/env bash
# List loops: worktree, branch, commits ahead of data-layer, dirty state, stack status.
set -euo pipefail
main=$(git -C "$(dirname "$0")" worktree list --porcelain | awk 'NR==1{print $2}')
base=${1:-data-layer}
for dir in "$main"/.loops/*/; do
  [[ -d $dir ]] || continue
  dir=${dir%/}; name=$(basename "$dir")
  branch=$(git -C "$dir" branch --show-current)
  ahead=$(git -C "$dir" rev-list --count "$base..HEAD")
  dirty=$([[ -n $(git -C "$dir" status --porcelain) ]] && echo dirty || echo clean)
  stack=$(grep '^CARETOOK_STACK=' "$dir/.env" | cut -d= -f2)
  up=$(docker compose -p "$stack" ps -q 2>/dev/null | wc -l | tr -d ' ')
  web=$(grep '^WEB_PORT=' "$dir/apps/web/.env" | cut -d= -f2)
  printf '%-12s %-18s +%-3s %-6s %s (%s containers) web :%s\n' "$name" "$branch" "$ahead" "$dirty" "$stack" "$up" "$web"
done
