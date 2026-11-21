#!/usr/bin/env bash
# check-run.sh MODE WHY -- COMMAND…: run COMMAND in the current directory and
# append one tab-separated line to the check log, pass or fail, then exit with
# COMMAND's status. prd.sh check runs it inside the check lease, so the seconds
# leave out the wait for a lease.
#
# Fields: start (UTC), worktree, branch, mode, reason, seconds, 5-minute load
# at start, load at end, exit code, test files run, test files in all (the last
# two stay empty until a quick check reports them: CARETOOK_CHECK_FILES_RUN and
# CARETOOK_CHECK_FILES_ALL, read after the command).
# Env: CARETOOK_CHECK_LOG (default: .loops/.check-times.log in the main checkout).
set -uo pipefail
here=$(dirname "${BASH_SOURCE[0]}")
# shellcheck source=lib.sh
source "$here/lib.sh"

mode=${1:?mode}; why=${2:-}; shift 2
[[ ${1:-} == -- ]] && shift
log=${CARETOOK_CHECK_LOG:-$loops/.check-times.log}

load5() { load_avg | awk '{print $2}'; }
start=$(date -u +%Y-%m-%dT%H:%M:%SZ); t0=$(date +%s); l0=$(load5)
"$@"
code=$?
secs=$(($(date +%s) - t0)); l1=$(load5)
clean() { printf '%s' "$1" | tr '\t\n' '  '; }
top=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$start" "$(basename "$top")" "$(clean "$(git branch --show-current 2>/dev/null)")" "$mode" "$(clean "$why")" \
  "$secs" "$l0" "$l1" "$code" "${CARETOOK_CHECK_FILES_RUN:-}" "${CARETOOK_CHECK_FILES_ALL:-}" >> "$log"
exit "$code"
