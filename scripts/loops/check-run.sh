#!/usr/bin/env bash
# check-run.sh MODE WHY -- COMMAND…: run COMMAND in the current directory and
# append one tab-separated line to the check log, pass or fail, then exit with
# COMMAND's status. prd.sh check runs it inside the check lease, so the seconds
# leave out the wait for a lease. First it waits while the machine is busy (the
# load gate: load_gate_wait in lib.sh, at most CARETOOK_LOAD_WAIT, 600 s, then
# it goes ahead and says so); the seconds leave that out too, and the log
# records it.
#
# The time limit: CARETOOK_CHECK_LIMIT seconds, else 1200 for a slice or quick
# check and 2400 for a full one. Past it, COMMAND and everything under it get
# TERM, then KILL after CARETOOK_CHECK_KILL_GRACE (10 s), and the check exits 124.
#
# Fields: start (UTC), worktree, branch, mode, reason, seconds, 5-minute load
# at start, load at end, exit code, test files run, test files in all (those
# two stay empty until a quick check reports them: the command writes
# "<run> <all>" to the file named by CARETOOK_CHECK_COUNTS, which check-run.sh
# sets; CARETOOK_CHECK_FILES_RUN and CARETOOK_CHECK_FILES_ALL override it), the
# seconds waited for the load, the step that failed (or was running at the
# limit), the failed test files and the flaky ones (comma-separated). The command
# reports those three in the directory named by CARETOOK_CHECK_STATE: `step`,
# `failed`, `flaky`.
# Env: CARETOOK_CHECK_LOG (default: .loops/.check-times.log in the main checkout).
set -uo pipefail
here=$(dirname "${BASH_SOURCE[0]}")
# shellcheck source=lib.sh
source "$here/lib.sh"

mode=${1:?mode}; why=${2:-}; shift 2
[[ ${1:-} == -- ]] && shift
log=${CARETOOK_CHECK_LOG:-$loops/.check-times.log}
if [[ $mode == full ]]; then limit=${CARETOOK_CHECK_LIMIT:-2400}; else limit=${CARETOOK_CHECK_LIMIT:-1200}; fi

# One number whatever load_avg prints: drop the commas uptime puts after each
# value and any blank line (a failed sysctl under pipefail), keep the 5-minute field.
load5() { load_avg | tr -d ',' | awk 'NF >= 2 && $2 ~ /^[0-9.]+$/ { print $2; found = 1; exit } END { if (!found) print 0 }'; }

# tree PID → PID and everything under it. Taken before the TERM: a child whose
# parent has died can't be found from the parent any more.
tree() { local c; echo "$1"; for c in $(pgrep -P "$1" 2>/dev/null); do tree "$c"; done; }
stop_tree() {
  local pids p left i grace=${CARETOOK_CHECK_KILL_GRACE:-10}
  pids=$(tree "$1")
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null
  for ((i = 0; i < grace * 5; i++)); do
    left=""
    for p in $pids; do kill -0 "$p" 2>/dev/null && left+=" $p"; done
    [[ -n $left ]] || return 0
    sleep 0.2
  done
  # shellcheck disable=SC2086
  kill -KILL $pids 2>/dev/null
  return 0
}

load_gate_wait "the check"
start=$(date -u +%Y-%m-%dT%H:%M:%SZ); t0=$(date +%s); l0=$(load5)
counts=$(mktemp); export CARETOOK_CHECK_COUNTS=$counts
state=$(mktemp -d); export CARETOOK_CHECK_STATE=$state
"$@" &
child=$!
trap 'stop_tree "$child"; rm -rf "$state" "$counts"; exit 143' TERM
trap 'stop_tree "$child"; rm -rf "$state" "$counts"; exit 130' INT
timed_out=0
while kill -0 "$child" 2>/dev/null; do
  if (($(date +%s) - t0 >= limit)); then
    timed_out=1
    stop_tree "$child"
    break
  fi
  sleep 0.2
done
wait "$child" 2>/dev/null
code=$?
trap - TERM INT
step=$(cat "$state/step" 2>/dev/null || true)
if ((timed_out)); then
  code=124
  echo "The check passed its limit of ${limit}s in the ${step:-first} step and was stopped." >&2
fi
list() { [[ -f $1 ]] && sort -u "$1" | paste -sd, - ; }
failed="" flaky=""
if ((code)); then failed=$(list "$state/failed"); else step=""; fi
flaky=$(list "$state/flaky")
read -r crun call < "$counts" 2>/dev/null || true; rm -f "$counts"; rm -rf "$state"
files_run=${CARETOOK_CHECK_FILES_RUN:-${crun:-}}; files_all=${CARETOOK_CHECK_FILES_ALL:-${call:-}}
secs=$(($(date +%s) - t0)); l1=$(load5)
clean() { printf '%s' "$1" | tr '\t\n' '  '; }
top=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$start" "$(basename "$top")" "$(clean "$(git branch --show-current 2>/dev/null)")" "$mode" "$(clean "$why")" \
  "$secs" "$l0" "$l1" "$code" "$files_run" "$files_all" "$load_waited" \
  "$(clean "$step")" "$(clean "$failed")" "$(clean "$flaky")" >> "$log"
exit "$code"
