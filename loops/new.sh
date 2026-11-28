#!/usr/bin/env bash
# Create an isolated worktree in .loops/:
#
#   new.sh prd <topic>          .loops/<topic>        prd/<topic>        from dev            stack
#   new.sh slice <topic> <n>    .loops/<topic>-<n>    slice/<topic>/<n>  from prd/<topic>    plan's Stack field
#   new.sh plan <topic>         .loops/plan-<topic>   plan/<topic>       from dev            no stack
#   new.sh hotfix <name>        .loops/hotfix-<name>  hotfix/<name>      from dev            no stack
#
# Options (before the kind): --slot N (pin a slot), --stack / --no-stack
# (override the default), --base B (branch from B instead).
#
# A slice gets a stack only when its plan says `Stack: yes` (or --stack); add
# one later with `prd stack up`. Every worktree's integration tests use its
# own test database (the config's testDb hook: `use`), stack or not.
#
# A stacked worktree leases the lowest free slot (1-19); the stack hook
# (stackUp) makes the stack for it: its env files, ports and data. A stackless
# one gets the stack hook's stackless env (stackDown). If the branch already exists,
# it's checked out instead (to resume after rm.sh). At most max_prds (lib.sh: the
# stored `prd dispatch --cap`, else RISA_MAX_PRDS, else 4) PRD worktrees exist at once. Tear down with rm.sh <name>.
# (prd start|slice|plan|hotfix wrap this.)
set -euo pipefail
# shellcheck source=stack-lib.sh
source "$(dirname "$0")/stack-lib.sh"

slot="" stack="" base=""
while [[ ${1:-} == --* ]]; do
  case $1 in
    --slot) slot=${2:?--slot N}; shift 2 ;;
    --stack) stack=1; shift ;;
    --no-stack) stack=0; shift ;;
    --base) base=${2:?--base B}; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done
kind=${1:?kind: prd, slice, plan or hotfix}; topic=${2:?topic}
[[ $topic =~ ^[a-z0-9-]+$ ]] || { echo "topic: lowercase, digits, dashes" >&2; exit 1; }
case $kind in
  prd) name=$topic branch=$prd_prefix$topic base=${base:-$trunk} stack=${stack:-1}
    if [[ ! -e $loops/$name ]] && (($(prd_count) >= max_prds)); then
      echo "already $(prd_count) PRD worktrees (cap $max_prds; from $max_prds_from: ${prd_cmd} dispatch --cap <n> changes it)" >&2; exit 1
    fi ;;
  slice) n=${3:?slice number}; [[ $n =~ ^[0-9]+$ ]] || { echo "slice number: digits" >&2; exit 1; }
    # The plan's Stack field (`prd doc planner "Slice fields"`) decides: a stack only
    # for Stack: yes, or --stack. Missing, or no plan: no stack.
    plan_ref=${base:-$prd_prefix$topic}:$(config_get paths.plans)/$topic-plan.md
    plan_text=$(git -C "$main" show "$plan_ref" 2>/dev/null || true)
    planned=no model=opus
    if [[ -n $plan_text ]]; then
      # A new slice branch needs its section in the committed plan: cut without
      # it, the branch has no Check field and its slice check runs everything
      # (RISA-1015). Resuming an existing branch is never refused.
      if ! git -C "$main" show-ref --verify --quiet "refs/heads/$slice_prefix$topic/$n" &&
        ! grep -Eqi "^#{2,4}[[:space:]]+slice[[:space:]]+0*$((10#$n))([^[:alnum:]_]|$)" <<<"$plan_text"; then
        echo "refused: slice $topic-$n: no \"Slice $n\" section in the committed plan ($plan_ref); commit the plan first" >&2
        exit 1
      fi
      planned=$(node "$(dirname "$0")/slice-fields.mjs" "$n" --get stack <<<"$plan_text" 2>/dev/null || echo no)
      # The Model field: the model its agent is spawned on; an unknown one refuses.
      if ! model=$(node "$(dirname "$0")/slice-fields.mjs" "$n" --get model <<<"$plan_text" 2>/dev/null); then
        node "$(dirname "$0")/slice-fields.mjs" "$n" <<<"$plan_text" 2>&1 >/dev/null | grep '^error' >&2 || true
        exit 1
      fi
    fi
    echo "plan: slice $n says Stack: $planned${stack:+ (overridden by --stack/--no-stack)}"
    [[ $planned == yes ]] && planned=1 || planned=0
    name=$topic-$n branch=$slice_prefix$topic/$n base=${base:-$prd_prefix$topic} stack=${stack:-$planned} ;;
  plan) name=plan-$topic branch=$plan_prefix$topic base=${base:-$trunk} stack=${stack:-0} ;;
  hotfix) name=hotfix-$topic branch=$hotfix_prefix$topic base=${base:-$trunk} stack=${stack:-0} ;;
  *) echo "kind must be prd, slice, plan or hotfix" >&2; exit 1 ;;
esac
# A repo with no stack hooks (Risa's own) has no stacks: no slot to lease and
# nothing to bring up, so every worktree there is stackless (RISA-985).
if ((stack)) && ! has_hook stackUp; then
  echo "no stack hooks in the config: $name gets no stack"
  stack=0
fi
dir=$loops/$name
[[ -e $dir ]] && { echo "$dir already exists" >&2; exit 1; }
git -C "$main" rev-parse --verify --quiet "$base" >/dev/null || { echo "no branch $base" >&2; exit 1; }

# The drain (drain.mjs): no new slice worktree near or past a usage limit, but while
# draining the allowance's topic (prd dispatch --allow) still makes them. A reading
# that can't be had never refuses (watching never hurts the work).
if [[ $kind == slice ]]; then
  drain_rc=0
  drain_why=$(RISA_USAGE_DIR=${RISA_USAGE_DIR:-$loops/.usage} node "$(dirname "$0")/drain.mjs" check "$topic" "$loops/.drain-allow" 2>/dev/null) || drain_rc=$?
  if ((drain_rc == 3)); then echo "refused: slice $topic-$n: $drain_why" >&2; exit 1; fi
fi

# The load gate (load-gate.mjs): a slice waits while the machine is busy (at
# most RISA_LOAD_WAIT, then it goes ahead); a PRD started by hand only warns.
if [[ $kind == slice ]]; then
  RISA_LOAD_LANE=light load_gate_wait "slice $topic-$n"
elif [[ $kind == prd ]]; then
  read -r gstate gload gthr _ <<< "$(load_gate)"
  [[ $gstate != busy ]] ||
    echo "Warning: the machine is busy (5-minute load $gload, over $gthr); starting $name anyway. Its checks and slices will wait for the load."
fi

if ((stack)); then
  require_disk "a new stack for $name"
  lease_free_slot "$name" "$slot"
  # Give the slot back if anything fails before the worktree exists.
  trap '[[ -d $dir ]] || release_slot "$name"' ERR
fi

if git -C "$main" show-ref --verify --quiet "refs/heads/$branch"; then
  echo "branch $branch exists: checking it out (base $base ignored)"
  git -C "$main" worktree add "$dir" "$branch"
else
  git -C "$main" worktree add -b "$branch" "$dir" "$base"
fi
# The run log (run-log.mjs): a slice's start, for prd metrics. Never fails.
[[ $kind != slice ]] || run_log slice-start "name=$name" "branch=$branch" "slice:=$n" "base=$base"
cd "$dir"
# The protection hooks (the config's hooksInstall: core.hooksPath, shared by every
# worktree, here).
if project_command hooksInstall >/dev/null 2>&1; then run_project hooksInstall; fi

# The stackless env (.env.loop) first, stack or not, so a failed install leaves
# a worktree without a stack, its slot given back, that a later stack up can take.
# A repo with no stack hooks has neither step (RISA-973).
if has_hook stackDown; then
  stack_hook stackDown "$dir" --base "$base" >/dev/null || die "stackless env failed for $name"
fi
# Integration tests use this worktree's own test database (the testDb hook),
# stack or not; it's created on the first run.
test_facts=""
if has_hook testDb; then
  test_facts=$(stack_hook testDb use "$name") || die "test database setup failed for $name"
fi

use_node
run_project install || {
  ((stack)) && release_slot "$name"
  die "install failed for $name (it stays a worktree without a stack)"
}

prd=$(tool_command prd)
if ((stack)); then
  # The hook writes the stack's env files, starts it, migrates and seeds; the
  # slot lease is ours to give back when it fails.
  facts=$(stack_hook stackUp "$dir" --slot "$slot" --base "$base") || {
    release_slot "$name"
    die "stack up failed for $name (it stays a worktree without a stack; $prd stack up $name tries again)"
  }
  echo
  echo "Worktree $name ready (slot $slot) at $dir on $branch (from $base)"
  echo "  dev server   $prd serve      → $(fact url "$facts")"
  echo "  $(fact summary "$facts") (project $(fact project "$facts"))"
  echo "  tests        pnpm test:integration → $(fact summary "$test_facts")"
  echo "  browser      $prd browser --changed   (or one check: $prd browser <check>)"
else
  echo
  echo "Worktree $name ready (no stack) at $dir on $branch (from $base)"
  echo "  checks       pnpm check; integration tests use $(fact summary "$test_facts")"
  echo "  a stack      $prd stack up   (dev server, browser checks), $prd stack down when done"
fi
[[ $kind != slice ]] || echo "  model        spawn its agent on $model (the plan's Model field)"
if [[ $kind == prd ]]; then
  echo
  echo "Start its orchestrator in a new terminal:"
  echo "  cd $dir && $loops_lib_dir/session.sh prd-$topic -- --remote-control prd-$topic \"\$($loops_lib_dir/prompt.sh orchestrator $topic)\""
fi
