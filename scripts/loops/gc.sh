#!/usr/bin/env bash
# Clean up leftover worktrees and stacks, after a yes. (pnpm prd gc)
#
#   gc.sh            list them, ask, then clean up
#   gc.sh --list     list them only
#   gc.sh --yes      clean up without asking
#
# Two kinds (pnpm prd status flags the same ones):
#   - a slice worktree whose branch is merged into its PRD branch: removed with
#     rm.sh (worktree, stack, test database, branch). One with uncommitted
#     changes is refused and kept, and so is one its wave still needs (not
#     landed, or a requested run of its topic with no verdict).
#   - a stack stopped for over CARETOOK_GC_STOPPED_HOURS (24): taken down with
#     `stack.sh down` (containers, data, slot); the worktree stays.
set -euo pipefail
# shellcheck source=stack-lib.sh
source "$(dirname "$0")/stack-lib.sh"
bin=$(dirname "$0")

mode=ask
for a in "$@"; do
  case $a in
    --list | -n | --dry-run) mode=list ;;
    --yes | -y) mode=yes ;;
    *) die "gc: unknown option $a (--list, --yes)" ;;
  esac
done

remove=() down=()
limit=$(gc_stopped_after)
for dir in "$loops"/*/; do
  [[ -d $dir ]] || continue
  dir=${dir%/}; name=$(basename "$dir")
  if slice_merged "$dir"; then
    if held=$(slice_held "$dir"); then
      echo "keep        $name (merged, but $held)"
      continue
    fi
    remove+=("$name")
    echo "remove      $name ($(git -C "$dir" branch --show-current) is merged into $(parent_of "$(git -C "$dir" branch --show-current)"))"
    continue
  fi
  secs=$(stack_stopped_secs "$dir")
  if [[ -n $secs ]] && ((secs >= limit)); then
    down+=("$name")
    echo "stack down  $name ($(stack_project "$dir") stopped $(fmt_age "$secs") ago; the worktree stays)"
  fi
done

total=$((${#remove[@]} + ${#down[@]}))
if ((total == 0)); then echo "Nothing to clean up."; exit 0; fi
[[ $mode == list ]] && exit 0
if [[ $mode == ask ]]; then
  read -r -p "Clean up these $total? [y/N] " answer || answer=""
  [[ $answer =~ ^[Yy] ]] || { echo "Nothing changed."; exit 0; }
fi

failed=0
for name in ${remove[@]+"${remove[@]}"}; do
  "$bin/rm.sh" "$name" || { echo "kept $name (see above)" >&2; failed=$((failed + 1)); }
done
for name in ${down[@]+"${down[@]}"}; do
  "$bin/stack.sh" down "$name" || { echo "couldn't take down $name's stack (see above)" >&2; failed=$((failed + 1)); }
done
((failed == 0)) || { echo "$failed of $total not cleaned up" >&2; exit 1; }
echo "Cleaned up $total."
