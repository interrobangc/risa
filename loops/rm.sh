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
# A PRD worktree whose branch is merged into dev (or landed there, with only
# docs past its last landing: landed.mjs), whose plan's _Status_ has no slice
# left to run and whose items are all landed marks its topic done in the PRD
# registry (backlog prd set <topic> flags=…,done), except a standing
# topic; with the old prose table, or when _Status_ can't be read, it marks
# nothing and says so. Such a docs tail is landed in dev (a local merge), or
# dropped with the branch when it changes only the topic's own plan.
# A standing topic's PRD worktree (a fixes wave) clears its row's hot files
# instead (backlog prd set <topic> hot=—), merged or not; its flags stay.
# --no-registry does neither: the dispatcher's undo of a start it couldn't
# finish (a fresh prd/ branch from dev counts as merged) leaves the row alone.
# A prd/ or plan/ worktree's cost ledger (cost.mjs) is saved before anything goes.
#
#   loops/rm.sh <name> [--force] [--keep-branch] [--no-registry]
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
# itself once it's done, as prd end would. Any other caller is refused,
# with the line to run from the main checkout instead (and prd end with
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
# this script's own checkout, maybe the worktree) is still here. A branch with
# commits past its last landing in dev (B-431: the orchestrator's 'landed'
# status after the final land) counts when they are docs only: a tail that
# changes only its own plan is dropped, other Markdown is landed below.
mark_done="" flags="" hot_rows="" rows_read="" tail_kind="" tail_n=0
if [[ -n $registry && $branch == "$prd_prefix"* ]]; then
  topic=${branch#"$prd_prefix"}
  if git -C "$main" merge-base --is-ancestor "$branch" "$(parent_of "$branch")" 2>/dev/null; then
    tail_kind=merged
  else
    read -r tail_kind _ tail_n < <(node "$(dirname "$0")/landed.mjs" tail "$main" "$branch" "$(parent_of "$branch")" "$topic" 2>/dev/null) || tail_kind=""
    case $tail_kind in
      empty | plan | docs) ;;
      code) echo "Not marking $topic done: $branch has $tail_n commit(s) past its last landing in $(parent_of "$branch") that aren't Markdown only" ;;
      *) tail_kind="" ;; # never landed: nothing to say
    esac
  fi
  if [[ -z $tail_kind || $tail_kind == code ]]; then
    tail_kind=""
  elif left=$(node "$(dirname "$0")/landed.mjs" slices-left "$dir/plans/$topic-plan.md"); then
    if [[ -n $left ]]; then
      echo "Not marking $topic done: slices $left are still to run (plans/$topic-plan.md)"
    elif rows_read=1 && ! rows=$(cd "$main" && backlog_run prd list --json 2>&1); then
      rows_read=failed
      echo "Not marking $topic done: ${rows##*$'\n'}"
    elif hot_rows=$rows && ! flags=$(node "$(dirname "$0")/landed.mjs" done-flags "$topic" <<<"$rows"); then
      echo "Not marking $topic done: $flags"
    elif ! items=$(cd "$main" && backlog_run list --all --prd "$topic" --json 2>/dev/null |
      node "$(dirname "$0")/landed.mjs" items-left 2>/dev/null); then
      echo "Not marking $topic done: ${items:-its items (unreadable)} aren't landed yet"
    else
      mark_done=$topic
    fi
  else
    echo "Not marking $topic done: plans/$topic-plan.md has no _Status_ slice table to read"
  fi
  # The tail is landed or dropped only for a topic it now marks done.
  [[ -n $mark_done && $tail_kind != merged ]] || tail_kind=""
fi

# A standing topic's wave set its row's hot files; with its worktree gone they go too.
clear_hot=""
# The registry read above is reused; it is read here only when that step didn't get to it.
if [[ -z $rows_read && -n $registry && $branch == "$prd_prefix"* ]]; then
  rows_read=1
  hot_rows=$(cd "$main" && backlog_run prd list --json 2>/dev/null) || hot_rows=""
fi
if [[ -n $registry && $branch == "$prd_prefix"* && -n $hot_rows ]] &&
  node "$(dirname "$0")/rotate.mjs" clears-hot "${branch#"$prd_prefix"}" <<<"$hot_rows"; then
  clear_hot=${branch#"$prd_prefix"}
fi

# A prd/ or plan/ worktree's cost record (cost.mjs, RISA-560): its transcripts'
# rows merged into .loops/.cost/<topic>.json before anything goes, so the totals
# outlive the worktree and transcript cleanup. A failure says why; rm goes on.
case $branch in
  "$prd_prefix"*) cost_topic=${branch#"$prd_prefix"} ;;
  "$plan_prefix"*) cost_topic=${branch#"$plan_prefix"} ;;
  *) cost_topic="" ;;
esac
if [[ -n $cost_topic ]] && ! cost_out=$(node "$(dirname "$0")/cost.mjs" ledger "$cost_topic" 2>&1); then
  why=$(grep -m1 -E '^[A-Za-z]*Error' <<<"$cost_out" || true)
  [[ -n $why ]] || why=$(grep -v '^[[:space:]]*$' <<<"$cost_out" | tail -n1 || true)
  echo "cost ledger: ${why:-it failed} (rm goes on)" >&2
fi

# Its stack, its data and its env files (the stack hook; nothing without a stack).
# A repo with no stack hooks has neither to do (RISA-973).
if has_hook stackDown; then
  stack_hook stackDown "$dir" >/dev/null || die "couldn't take down $name's stack; the worktree stays ($(tool_command prd) stack down $name)"
fi
# Its test databases, worker copies too (the testDb hook; nothing when that server isn't running).
if has_hook testDb; then
  stack_hook testDb drop "$name" || echo "couldn't drop $name's test database ($(tool_command prd) test-db list)" >&2
fi
# Whether a slice was merged into its parent, for the run log's slice-end (below).
slice_merged=false
if [[ $branch == "$slice_prefix"* ]] && git -C "$main" merge-base --is-ancestor "$branch" "$(parent_of "$branch")" 2>/dev/null; then
  slice_merged=true
fi
# A config read from inside this worktree (its own, either form, found or pinned)
# goes with it: the steps after the removal (run log, backlog tool) load the
# main checkout's instead (config.mjs where: its .risa/config.json or risa.json).
if [[ -n ${RISA_CONFIG:-} ]]; then
  config_dir=$(cd "$(dirname "$RISA_CONFIG")" 2>/dev/null && pwd -P) || config_dir=""
  if [[ -n $config_dir && ($config_dir == "$real_dir" || $config_dir == "$real_dir"/*) ]]; then
    if main_config=$(node "$(dirname "$0")/config.mjs" where "$main"); then
      export RISA_CONFIG=$main_config RISA_CONFIG_FOUND=$main_config
    else
      unset RISA_CONFIG RISA_CONFIG_FOUND
    fi
  fi
fi
git -C "$main" worktree remove ${force:+--force} "$dir"
# The caller was inside it (its own session, above): keep a cwd that exists.
[[ -z $end_self ]] || cd "$main"
release_slot "$name"
# The run log (run-log.mjs): a slice's end, for prd metrics. Never fails.
[[ $branch != "$slice_prefix"* ]] || run_log slice-end "name=$name" "branch=$branch" "merged:=$slice_merged"
# Its session record (session.sh), if it had one: the session itself isn't
# touched (a planner removes its worktree, then ends with prd end).
case $branch in
  "$prd_prefix"*) rm -f "$loops/.sessions/prd-${branch#"$prd_prefix"}.json" ;;
  "$plan_prefix"*) rm -f "$loops/.sessions/plan-${branch#"$plan_prefix"}.json" ;;
  "$hotfix_prefix"*) rm -f "$loops/.sessions/hotfix-${branch#"$hotfix_prefix"}.json" ;;
esac

# A finished topic's docs past its last landing: landed in dev with a local
# merge, as a plan/ branch lands (only in a main checkout on dev; a merge that
# stops is aborted and the branch kept); a tail that changes only its own plan
# (the status after the landing) or nothing at all is dropped with the branch.
drop_tail=""
case $tail_kind in
  empty | plan)
    drop_tail=1
    ;;
  docs)
    if [[ $(git -C "$main" symbolic-ref --quiet --short HEAD 2>/dev/null) != "$(parent_of "$branch")" ]]; then
      echo "Kept $branch's $tail_n docs commit(s) past its last landing: the main checkout isn't on $(parent_of "$branch") to land them"
    elif git -C "$main" merge --quiet --no-ff -m "docs($mark_done): the docs after its last landing" "$branch" >/dev/null 2>&1; then
      echo "Landed $branch's $tail_n docs commit(s) past its last landing in $(parent_of "$branch") as $(git -C "$main" rev-parse --short HEAD) (publish: git -C $main push origin $(parent_of "$branch"))"
    else
      git -C "$main" merge --abort 2>/dev/null || true
      echo "Kept $branch: its $tail_n docs commit(s) past its last landing didn't merge cleanly into $(parent_of "$branch")" >&2
    fi
    ;;
esac

# Mark it done through the main checkout's backlog tool (one commit on dev); a
# failure here doesn't undo the removal.
if [[ -n $mark_done ]]; then
  if (cd "$main" && backlog_run prd set "$mark_done" "flags=$flags" >/dev/null); then
    echo "Marked $mark_done done in the PRD registry (flags $flags)"
  else
    echo "couldn't mark $mark_done done (${backlog_cmd} prd set $mark_done flags=$flags)" >&2
  fi
fi

if [[ -n $clear_hot ]]; then
  if (cd "$main" && backlog_run prd set "$clear_hot" "hot=—" >/dev/null); then
    echo "Cleared $clear_hot's hot files in the PRD registry (its wave is over)"
  else
    echo "couldn't clear $clear_hot's hot files (${backlog_cmd} prd set $clear_hot hot=—)" >&2
  fi
fi

parent=$(parent_of "$branch")
if [[ -n $keep || -z $branch ]]; then
  echo "Removed $name (branch ${branch:-?} kept)"
elif [[ -n $drop_tail ]]; then
  git -C "$main" branch -D "$branch" >/dev/null
  echo "Removed $name and its branch $branch, dropping its $tail_n commit(s) past its last landing in $parent ($([[ $tail_kind == plan ]] && echo "they change only plans/$mark_done-plan.md" || echo "they change nothing"))"
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
# this was its last step, so end it, as prd end would.
if [[ -n $end_self ]]; then
  echo "Ending $record (pid $end_self): its worktree is gone, so this was its last step."
  end_pid "$end_self" "$record"
fi
