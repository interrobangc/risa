#!/usr/bin/env bash
# Stacks, slots and slices for .loops worktrees, shared by new.sh, stack.sh,
# rm.sh, ls.sh and gc.sh. Source it; don't run it. (It sources lib.sh.)
#
# The stack's facts (its project, ports, env files and containers) and the test
# databases are the project's: the core reads them only through the config's
# stack and testDb hooks (stack_hook in lib.sh), as key=value facts. The slot
# leases, slice state and gc ages are the core's.
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# slot_busy N → true when slot N is leased, or the stack hook says a worktree or
# a listening port has it.
slot_busy() {
  [[ -e $leases/$1 ]] && return 0
  [[ $(fact in_use "$(stack_hook stackStatus --slot "$1" --probe)") != no ]]
}

# lease_free_slot NAME [SLOT] → lease SLOT (or the lowest free one) for NAME and
# set $slot; dies when none is free.
lease_free_slot() {
  local want=${2:-} i
  slot=""
  if [[ -n $want ]]; then
    [[ $want =~ ^[0-9]+$ ]] && ((want >= 1 && want <= 19)) || die "slot must be 1-19"
    slot_busy "$want" && die "slot $want is taken (${prd_cmd} status)"
    lease_slot "$want" "$1" || die "slot $want was just taken"
    slot=$want
  else
    for i in $(seq 1 19); do
      slot_busy "$i" && continue
      lease_slot "$i" "$1" && { slot=$i; break; }
    done
    [[ -n $slot ]] || die "all 19 slots are taken"
  fi
}

# slice_merged DIR → true when the worktree is on slice/<topic>/<n> and its tip
# was merged into prd/<topic> (it's a merge's second parent there), so the
# slice is done. A new slice whose tip is still its base doesn't count.
slice_merged() {
  local branch tip parent
  branch=$(git -C "$1" branch --show-current 2>/dev/null) || return 1
  [[ $branch == "$slice_prefix"*/* ]] || return 1
  parent=$(parent_of "$branch")
  tip=$(git -C "$1" rev-parse HEAD 2>/dev/null) || return 1
  git -C "$1" rev-parse --verify --quiet "$parent" >/dev/null || return 1
  git -C "$1" merge-base --is-ancestor "$tip" "$parent" || return 1
  git -C "$1" log --merges --format='%P' -n 2000 "$parent" | awk '{for (i = 2; i <= NF; i++) print $i}' | grep -qx "$tip"
}

# slice_held DIR → for a merged slice its wave still needs, prints why and returns
# true: its tip hasn't reached the trunk, a requested run of its topic has no
# verdict, or GitHub can't say. A slice stays until its wave's verdict is green.
slice_held() {
  local branch topic out rc=0
  branch=$(git -C "$1" branch --show-current 2>/dev/null) || return 1
  topic=${branch#"$slice_prefix"}; topic=${topic%%/*}
  if ! git -C "$1" merge-base --is-ancestor HEAD "$trunk" 2>/dev/null; then
    echo "its wave hasn't landed"
    return 0
  fi
  out=$(node "$loops_lib_dir/../ci/outstanding.mjs" "$topic" "$1" 2>/dev/null) || rc=$?
  case $rc in
    0) return 1 ;;
    10) echo "its topic's run has no verdict: ${out//$'\n'/, }" ;;
    *) echo "GitHub can't be read, so its wave's run is unknown" ;;
  esac
}

# slice_state DIR GOING → a slice's place in its wave. GOING is 1 while its
# topic has a requested run out. Handed off: clean, and merged or checked at its
# tip. Fixing: not that, on a branch merged before. Otherwise working.
slice_state() {
  local dir=$1 going=${2:-0} branch parent tip checked seconds
  branch=$(git -C "$dir" branch --show-current 2>/dev/null) || return 1
  parent=$(parent_of "$branch")
  tip=$(git -C "$dir" rev-parse HEAD 2>/dev/null) || return 1
  checked=$(cut -d' ' -f1 "$(checked_file "$dir")" 2>/dev/null || true)
  if [[ -z $(git -C "$dir" status --porcelain) ]] && { [[ $checked == "$tip" ]] || slice_merged "$dir"; }; then
    if ((going)); then echo "waiting for the run"; else echo "handed off"; fi
    return
  fi
  seconds=$(git -C "$dir" log --merges --format='%P' -n 2000 "$parent" 2>/dev/null |
    awk '{for (i = 2; i <= NF; i++) print $i}')
  if [[ -n $seconds ]] && grep -Fx -f <(printf '%s\n' "$seconds") <<<"$(git -C "$dir" rev-list --first-parent -n 2000 HEAD)" >/dev/null; then
    echo "fixing"
  else
    echo "working"
  fi
}

# gc_stopped_after → how long a stack may sit stopped before status flags it
# and gc offers to take it down (seconds; RISA_GC_STOPPED_HOURS, 24).
gc_stopped_after() { echo $((${RISA_GC_STOPPED_HOURS:-24} * 3600)); }

# fmt_age SECS → 3d, 5h or 12m.
fmt_age() {
  local s=$1
  if ((s >= 86400)); then echo "$((s / 86400))d"; elif ((s >= 3600)); then echo "$((s / 3600))h"; else echo "$((s / 60))m"; fi
}
