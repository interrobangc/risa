#!/usr/bin/env bash
# Tear down a worktree made by new.sh: stop and delete its Docker stacks and
# data, remove the worktree and release its slot. Then delete its branch if it's
# fully merged into its parent (slice/<topic>/<n> → prd/<topic>; prd/* and
# plan/* → dev); an unmerged branch is kept. Refuses uncommitted changes, and a
# PRD worktree whose slices still have worktrees, unless --force.
#
#   scripts/loops/rm.sh <name> [--force] [--keep-branch]
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

name=${1:?name}; shift
force="" keep=""
for a in "$@"; do
  case $a in
    --force) force=1 ;;
    --keep-branch) keep=1 ;;
    *) echo "unknown option $a" >&2; exit 1 ;;
  esac
done
dir=$loops/$name
[[ -d $dir ]] || { echo "no worktree at $dir" >&2; exit 1; }
branch=$(git -C "$dir" branch --show-current)

if [[ -z $force && -n $(git -C "$dir" status --porcelain) ]]; then
  echo "$dir has uncommitted changes (commit them, or pass --force)" >&2; exit 1
fi
if [[ -z $force && $branch == prd/* ]]; then
  for d in "$loops"/*/; do
    [[ $(git -C "$d" branch --show-current 2>/dev/null) == "slice/${branch#prd/}/"* ]] && {
      echo "slice worktree $(basename "$d") still exists (remove it first, or pass --force)" >&2; exit 1; }
  done
fi

if [[ -n $(env_get "$dir/.env" CARETOOK_STACK) ]]; then
  (cd "$dir" && docker compose down --remove-orphans && docker compose -f docker-compose.test.yml down --remove-orphans)
  # Postgres writes its data as the container user; remove it through a container.
  docker run --rm -v "$dir:/w" postgres:18.7-alpine rm -rf /w/.postgres
fi
git -C "$main" worktree remove ${force:+--force} "$dir"
release_slot "$name"

parent=$(parent_of "$branch")
if [[ -n $keep || -z $branch ]]; then
  echo "Removed $name (branch ${branch:-?} kept)"
elif git -C "$main" merge-base --is-ancestor "$branch" "$parent" 2>/dev/null; then
  git -C "$main" branch -D "$branch" >/dev/null
  echo "Removed $name and its branch $branch (merged into $parent)"
else
  echo "Removed $name; kept $branch: it isn't merged into $parent yet"
fi
