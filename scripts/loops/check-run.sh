#!/usr/bin/env bash
# check-run.sh MODE WHY -- COMMAND…: run COMMAND in the current directory and
# append one tab-separated line to the check log, pass or fail, then exit with
# COMMAND's status. prd.sh check runs it inside the check lease, so the seconds
# leave out the wait for a lease. First it waits while the machine is busy (the
# load gate: load_gate_wait in lib.sh, at most CARETOOK_LOAD_WAIT, 600 s, then
# it goes ahead and says so); the seconds leave that out too, and the log
# records it.
#
# Fields: start (UTC), worktree, branch, mode, reason, seconds, 5-minute load
# at start, load at end, exit code, test files run, test files in all (those
# two stay empty until a quick check reports them: the command writes
# "<run> <all>" to the file named by CARETOOK_CHECK_COUNTS, which check-run.sh
# sets; CARETOOK_CHECK_FILES_RUN and CARETOOK_CHECK_FILES_ALL override it), and
# the seconds waited for the load.
# Env: CARETOOK_CHECK_LOG (default: .loops/.check-times.log in the main checkout).
set -uo pipefail
here=$(dirname "${BASH_SOURCE[0]}")
# shellcheck source=lib.sh
source "$here/lib.sh"

mode=${1:?mode}; why=${2:-}; shift 2
[[ ${1:-} == -- ]] && shift
log=${CARETOOK_CHECK_LOG:-$loops/.check-times.log}

# One number whatever load_avg prints: drop the commas uptime puts after each
# value and any blank line (a failed sysctl under pipefail), keep the 5-minute field.
load5() { load_avg | tr -d ',' | awk 'NF >= 2 && $2 ~ /^[0-9.]+$/ { print $2; found = 1; exit } END { if (!found) print 0 }'; }
load_gate_wait "the check"
start=$(date -u +%Y-%m-%dT%H:%M:%SZ); t0=$(date +%s); l0=$(load5)
counts=$(mktemp); export CARETOOK_CHECK_COUNTS=$counts
"$@"
code=$?
read -r crun call < "$counts" 2>/dev/null || true; rm -f "$counts"
files_run=${CARETOOK_CHECK_FILES_RUN:-${crun:-}}; files_all=${CARETOOK_CHECK_FILES_ALL:-${call:-}}
secs=$(($(date +%s) - t0)); l1=$(load5)
clean() { printf '%s' "$1" | tr '\t\n' '  '; }
top=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$start" "$(basename "$top")" "$(clean "$(git branch --show-current 2>/dev/null)")" "$mode" "$(clean "$why")" \
  "$secs" "$l0" "$l1" "$code" "$files_run" "$files_all" "$load_waited" >> "$log"
exit "$code"
