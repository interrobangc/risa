#!/usr/bin/env bash
# Tear down a worktree made by new.sh: take down its stack and data (the stack
# hook's stackDown), drop its test databases (the testDb hook's drop: its own
# and its integration workers' copies), remove the worktree, its session record
# (.loops/.sessions/) and release its slot. Then delete its branch if it's
# fully merged into its parent (slice/<topic>/<n> → prd/<topic>; prd/* and
# plan/* and hotfix/* → dev); an unmerged branch is kept. A merged branch's
# leftover branch on origin (a PR's head) is deleted too, when origin's tip is
# in the parent as well; an unmerged one stays. Refuses uncommitted changes, and a
# PRD worktree whose slices still have worktrees, unless --force.
#
# A PRD worktree whose branch is merged into dev and whose plan's _Status_ has
# no slice left to run marks its topic done in the PRD registry (pnpm backlog
# prd set <topic> flags=…,done), except a standing topic; with the old prose
# table, or when _Status_ can't be read, it marks nothing and says so.
# A standing topic's PRD worktree (a fixes wave) clears its row's hot files
# instead (pnpm backlog prd set <topic> hot=—), merged or not; its flags stay.
# --no-registry does neither: the dispatcher's undo of a start it couldn't
# finish (a fresh prd/ branch from dev counts as merged) leaves the row alone.
#
#   scripts/loops/rm.sh <name> [--force] [--keep-branch] [--no-registry]
set -euo pipefail
# shellcheck source=stack-lib.sh
source "$(dirname "$0")/stack-lib.sh"

name=${1:?name}; shift
force="" keep="" registry=1
for a in "$@"; do
  case $a in
    --force) force=1 ;;
    --keep-branch) keep=1 ;;
    --no-registry) registry="" ;;
    *) echo "unknown option $a" >&2; exit 1 ;;
  esac
done
dir=$loops/$name
[[ -d $dir ]] || { echo "no worktree at $dir" >&2; exit 1; }
branch=$(git -C "$dir" branch --show-current)

if [[ -z $force && -n $(git -C "$dir" status --porcelain) ]]; then
  echo "$dir has uncommitted changes (commit them, or pass --force)" >&2; exit 1
fi
if [[ -z $force && $branch == "$prd_prefix"* ]]; then
  for d in "$loops"/*/; do
    [[ $(git -C "$d" branch --show-current 2>/dev/null) == "$slice_prefix${branch#"$prd_prefix"}/"* ]] && {
      echo "slice worktree $(basename "$d") still exists (remove it first, or pass --force)" >&2; exit 1; }
  done
fi

# Run from inside the worktree it removes, the caller's shell would be left in
# a deleted directory, where the harness runs no more commands (B-812). Its own
# orchestrator or planner (the live session record this worktree's name gives,
# held by the calling shell's claude) is on its last step: rm ends that session
# itself once it's done, as pnpm prd end would. Any other caller is refused,
# with the line to run from the main checkout instead (and pnpm prd end with
# it for a prd/ or plan/ worktree's caller under a claude with no record).
case $branch in
  "$prd_prefix"*) record=prd-${branch#"$prd_prefix"} ;;
  "$plan_prefix"*) record=plan-${branch#"$plan_prefix"} ;;
  "$hotfix_prefix"*) record=hotfix-${branch#"$hotfix_prefix"} ;;
  *) record="" ;;
esac
end_self=""
here=$(pwd -P 2>/dev/null || true) real_dir=$(cd "$dir" && pwd -P)
if [[ $here == "$real_dir" || $here == "$real_dir"/* ]]; then
  export CARETOOK_SESSIONS_DIR=${CARETOOK_SESSIONS_DIR:-$loops/.sessions}
  caller=$(node "$(dirname "$0")/sessions.mjs" caller 2>/dev/null) || caller=""
  IFS=$'\t' read -r caller_name _ caller_pid _ <<<"$caller" || true
  if [[ -n $record && $record != hotfix-* && ${caller_name:-} == "$record" ]]; then
    end_self=$caller_pid
  else
    line="cd $main && $(tool_command prd) rm $name${force:+ --force}${keep:+ --keep-branch}"
    [[ -n $registry ]] || line+=" --no-registry"
    if [[ -z $caller && ($record == prd-* || $record == plan-*) ]] && node "$(dirname "$0")/sessions.mjs" ancestor >/dev/null 2>&1; then
      line+=" && $(tool_command prd) end"
    fi
    die "rm: this shell is inside $name, which rm would delete under it; run instead: $line"
  fi
fi

# Whether a finished PRD marks its topic done: decided now, while its plan (and
# this script's own checkout, maybe the worktree) is still here.
mark_done="" flags=""
if [[ -n $registry && $branch == "$prd_prefix"* ]]; then
  topic=${branch#"$prd_prefix"}
  if ! git -C "$main" merge-base --is-ancestor "$branch" "$(parent_of "$branch")" 2>/dev/null; then
    mark_done="" # not merged: nothing to say
  elif left=$(node "$(dirname "$0")/rotate.mjs" slices-left "$dir/plans/$topic-plan.md"); then
    if [[ -n $left ]]; then
      echo "Not marking $topic done: slices $left are still to run (plans/$topic-plan.md)"
    elif ! rows=$(cd "$main" && node "$main/scripts/backlog/backlog.mjs" prd list --json 2>&1); then
      echo "Not marking $topic done: ${rows##*$'\n'}"
    elif flags=$(node "$(dirname "$0")/rotate.mjs" done-flags "$topic" <<<"$rows"); then
      mark_done=$topic
    else
      echo "Not marking $topic done: $flags"
    fi
  else
    echo "Not marking $topic done: plans/$topic-plan.md has no _Status_ slice table to read"
  fi
fi

# A standing topic's wave set its row's hot files; with its worktree gone they go too.
clear_hot=""
if [[ -n $registry && $branch == "$prd_prefix"* ]] && hot_rows=$(cd "$main" && node "$main/scripts/backlog/backlog.mjs" prd list --json 2>/dev/null) &&
  node "$(dirname "$0")/rotate.mjs" clears-hot "${branch#"$prd_prefix"}" <<<"$hot_rows"; then
  clear_hot=${branch#"$prd_prefix"}
fi

# Its stack, its data and its env files (the stack hook; nothing without a stack).
stack_hook stackDown "$dir" >/dev/null || die "couldn't take down $name's stack; the worktree stays ($(tool_command prd) stack down $name)"
# Its test databases, worker copies too (the testDb hook; nothing when that server isn't running).
stack_hook testDb drop "$name" || echo "couldn't drop $name's test database ($(tool_command prd) test-db list)" >&2
# Whether a slice was merged into its parent, for the run log's slice-end (below).
slice_merged=false
if [[ $branch == "$slice_prefix"* ]] && git -C "$main" merge-base --is-ancestor "$branch" "$(parent_of "$branch")" 2>/dev/null; then
  slice_merged=true
fi
git -C "$main" worktree remove ${force:+--force} "$dir"
# The caller was inside it (its own session, above): keep a cwd that exists.
[[ -z $end_self ]] || cd "$main"
release_slot "$name"
# The run log (run-log.mjs): a slice's end, for pnpm prd metrics. Never fails.
[[ $branch != "$slice_prefix"* ]] || run_log slice-end "name=$name" "branch=$branch" "merged:=$slice_merged"
# Its session record (session.sh), if it had one: the session itself isn't
# touched (a planner removes its worktree, then ends with pnpm prd end).
case $branch in
  "$prd_prefix"*) rm -f "$loops/.sessions/prd-${branch#"$prd_prefix"}.json" ;;
  "$plan_prefix"*) rm -f "$loops/.sessions/plan-${branch#"$plan_prefix"}.json" ;;
  "$hotfix_prefix"*) rm -f "$loops/.sessions/hotfix-${branch#"$hotfix_prefix"}.json" ;;
esac

# Mark it done through the main checkout's backlog tool (one commit on dev); a
# failure here doesn't undo the removal.
if [[ -n $mark_done ]]; then
  if (cd "$main" && node "$main/scripts/backlog/backlog.mjs" prd set "$mark_done" "flags=$flags" >/dev/null); then
    echo "Marked $mark_done done in the PRD registry (flags $flags)"
  else
    echo "couldn't mark $mark_done done (pnpm backlog prd set $mark_done flags=$flags)" >&2
  fi
fi

if [[ -n $clear_hot ]]; then
  if (cd "$main" && node "$main/scripts/backlog/backlog.mjs" prd set "$clear_hot" "hot=—" >/dev/null); then
    echo "Cleared $clear_hot's hot files in the PRD registry (its wave is over)"
  else
    echo "couldn't clear $clear_hot's hot files (pnpm backlog prd set $clear_hot hot=—)" >&2
  fi
fi

parent=$(parent_of "$branch")
if [[ -n $keep || -z $branch ]]; then
  echo "Removed $name (branch ${branch:-?} kept)"
elif git -C "$main" merge-base --is-ancestor "$branch" "$parent" 2>/dev/null; then
  git -C "$main" branch -D "$branch" >/dev/null
  echo "Removed $name and its branch $branch (merged into $parent)"
  # A leftover remote branch: gone only when origin's tip is merged into the
  # parent too (a later push to it would be lost). Offline or no origin: skip.
  if remote_tip=$(git -C "$main" ls-remote --heads origin "refs/heads/$branch" 2>/dev/null | cut -f1) && [[ -n $remote_tip ]]; then
    if git -C "$main" merge-base --is-ancestor "$remote_tip" "$parent" 2>/dev/null; then
      git -C "$main" push --quiet origin --delete "$branch" 2>/dev/null &&
        echo "Deleted origin/$branch (merged into $parent)" ||
        echo "couldn't delete origin/$branch (git push origin --delete $branch)" >&2
    else
      echo "Kept origin/$branch: its tip isn't merged into $parent (or isn't fetched yet)"
    fi
  fi
else
  echo "Removed $name; kept $branch: it isn't merged into $parent yet"
fi

# Its own orchestrator or planner called this from inside the worktree (above):
# this was its last step, so end it, as pnpm prd end would.
if [[ -n $end_self ]]; then
  echo "Ending $record (pid $end_self): its worktree is gone, so this was its last step."
  end_pid "$end_self" "$record"
fi
