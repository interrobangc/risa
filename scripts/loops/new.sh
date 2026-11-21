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
# one later with `pnpm prd stack up`. Every worktree's integration tests use its
# own database on the shared test Postgres (test-db.sh), stack or not.
#
# A stacked worktree leases the lowest free slot (1-19), which fixes its ports
# (slot_ports in lib.sh) and Compose project (caretook-loopN). Secrets
# are copied from the main checkout's env files. If the branch already exists,
# it's checked out instead (to resume after rm.sh). At most CARETOOK_MAX_PRDS
# (default 3) PRD worktrees exist at once. Tear down with rm.sh <name>.
# (pnpm prd start|slice|plan|hotfix wrap this.)
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
  prd) name=$topic branch=prd/$topic base=${base:-$trunk} stack=${stack:-1}
    if [[ ! -e $loops/$name ]] && (($(prd_count) >= max_prds)); then
      echo "already $(prd_count) PRD worktrees (cap $max_prds; raise CARETOOK_MAX_PRDS to override)" >&2; exit 1
    fi ;;
  slice) n=${3:?slice number}; [[ $n =~ ^[0-9]+$ ]] || { echo "slice number: digits" >&2; exit 1; }
    # The plan's Stack field (docs/agents/planner.md, _Slice fields_) decides: a stack only
    # for Stack: yes, or --stack. Missing, or no plan: no stack.
    plan_text=$(git -C "$main" show "${base:-prd/$topic}:plans/$topic-plan.md" 2>/dev/null || true)
    planned=no
    if [[ -n $plan_text ]]; then
      planned=$(node "$(dirname "$0")/slice-fields.mjs" "$n" --get stack <<<"$plan_text" 2>/dev/null || echo no)
    fi
    echo "plan: slice $n says Stack: $planned${stack:+ (overridden by --stack/--no-stack)}"
    [[ $planned == yes ]] && planned=1 || planned=0
    name=$topic-$n branch=slice/$topic/$n base=${base:-prd/$topic} stack=${stack:-$planned} ;;
  plan) name=plan-$topic branch=plan/$topic base=${base:-$trunk} stack=${stack:-0} ;;
  hotfix) name=hotfix-$topic branch=hotfix/$topic base=${base:-$trunk} stack=${stack:-0} ;;
  *) echo "kind must be prd, slice, plan or hotfix" >&2; exit 1 ;;
esac
dir=$loops/$name
[[ -e $dir ]] && { echo "$dir already exists" >&2; exit 1; }
git -C "$main" rev-parse --verify --quiet "$base" >/dev/null || { echo "no branch $base" >&2; exit 1; }

if ((stack)); then
  require_main_env
  require_disk "a new stack for $name"
  lease_free_slot "$name" "$slot"
  # Give the slot back if anything fails before the worktree exists.
  trap '[[ -d $dir ]] || release_slot "$name"' ERR
  slot_ports "$slot"
fi

if git -C "$main" show-ref --verify --quiet "refs/heads/$branch"; then
  echo "branch $branch exists: checking it out (base $base ignored)"
  git -C "$main" worktree add "$dir" "$branch"
else
  git -C "$main" worktree add -b "$branch" "$dir" "$base"
fi
cd "$dir"
# The protection hooks (.githooks/); core.hooksPath is shared by every worktree.
git config core.hooksPath .githooks

if ((stack)); then
  write_stack_env "$dir" "$slot" "$base"
else
  write_stackless_env "$dir" "$base"
fi
# Integration tests use this worktree's own database on the shared test
# Postgres (test-db.sh), stack or not; it's created on the first run.
write_test_env "$dir" "$name"

use_node
pnpm install --frozen-lockfile

if ((stack)); then
  pnpm datastore:start
  echo
  echo "Worktree $name ready (slot $slot) at $dir on $branch (from $base)"
  echo "  dev server   pnpm prd serve      → http://localhost:$web"
  echo "  Postgres     :$pg   PowerSync :$ps (project caretook-loop$slot)"
  echo "  tests        pnpm test:integration → $(test_db_name "$name") on the shared test Postgres (:$shared_test_port)"
  echo "  browser      pnpm prd browser --changed   (or one check: pnpm prd browser <check>)"
else
  echo
  echo "Worktree $name ready (no stack) at $dir on $branch (from $base)"
  echo "  checks       pnpm check (integration tests use $(test_db_name "$name") on the shared test Postgres, :$shared_test_port)"
  echo "  a stack      pnpm prd stack up   (dev server, browser checks), pnpm prd stack down when done"
fi
if [[ $kind == prd ]]; then
  echo
  echo "Start its orchestrator in a new terminal:"
  echo "  cd $dir && scripts/loops/session.sh prd-$topic -- --remote-control prd-$topic \"\$(scripts/loops/prompt.sh orchestrator $topic)\""
fi
