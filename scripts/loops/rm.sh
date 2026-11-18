#!/usr/bin/env bash
# Tear down a loop made by new.sh: stop and delete its Docker stacks and data,
# then remove its worktree. The loop/<name> branch is kept (delete it with
# `git branch -d` once merged). Refuses a worktree with uncommitted changes
# unless --force.
#
#   scripts/loops/rm.sh <name> [--force]
set -euo pipefail

name=${1:?name}; force=${2:-}
main=$(git -C "$(dirname "$0")" worktree list --porcelain | awk 'NR==1{print $2}')
dir=$main/.loops/$name
[[ -d $dir ]] || { echo "no loop at $dir" >&2; exit 1; }

if [[ $force != --force && -n $(git -C "$dir" status --porcelain) ]]; then
  echo "$dir has uncommitted changes (commit them, or pass --force)" >&2; exit 1
fi

(cd "$dir" && docker compose down --remove-orphans && docker compose -f docker-compose.test.yml down --remove-orphans)
# Postgres writes its data as the container user; remove it through a container.
docker run --rm -v "$dir:/w" postgres:18.7-alpine rm -rf /w/.postgres
git -C "$main" worktree remove ${force:+--force} "$dir"
echo "Removed loop $name (branch loop/$name kept)"
