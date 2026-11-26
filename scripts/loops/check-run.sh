#!/usr/bin/env bash
# check-run.sh MODE WHY -- COMMAND…: run COMMAND in the current directory and
# append one tab-separated line to the check log, pass or fail, then exit with
# COMMAND's status. prd.sh check runs it inside the check lease, so the seconds
# leave out the wait for a lease. First it waits while the machine is busy (the
# load gate: load_gate_wait in lib.sh, at most RISA_LOAD_WAIT, 600 s, then
# it goes ahead and says so); the seconds leave that out too, and the log
# records it.
#
# The budget and the silence limit (check-budget.mjs): the budget from the
# usual time of passing checks like this one, scaled for load, between 10
# minutes and the hard limit (RISA_CHECK_LIMIT, else 1200 s for a slice or
# quick check and 2400 for a full one); the silence limit, RISA_CHECK_SILENCE
# (480 s) scaled the same way, on the command's output. Past either, COMMAND and
# everything under it get TERM, then KILL after RISA_CHECK_KILL_GRACE (10 s);
# the check prints the step and its last 30 lines and exits 124. A gap of over
# RISA_CHECK_SLEEP_GAP (30 s) between two readings of the clock is the
# machine asleep: it counts against neither limit, nor in the seconds logged.
# RISA_CLOCK_FILE (tests): epoch seconds to read instead of the clock;
# RISA_CHECK_BUDGET_LOAD (tests): the load the limits scale for.
# If check-budget.mjs fails, the hard limit and the default silence apply.
#
# Fields: start (UTC), worktree, branch, mode, reason, seconds, 5-minute load
# at start, load at end, exit code, test files run, test files in all (those
# two stay empty until a quick check reports them: the command writes
# "<run> <all>" to the file named by RISA_CHECK_COUNTS, which check-run.sh
# sets; RISA_CHECK_FILES_RUN and RISA_CHECK_FILES_ALL override it), the
# seconds waited for the load, the step that failed (or was running at the
# limit), the failed test files and the flaky ones (comma-separated), and the
# limit that stopped it (budget or silence; none for a check that ended), the
# time gate's verdict and the step times (`<step>:<seconds>`, comma-separated,
# in the order they ran; a step run twice is summed). The command reports the
# step, the failed and flaky files and the step times in the directory named by
# RISA_CHECK_STATE: `step`, `failed`, `flaky`, `times` (`<seconds> <step>`
# lines), and `slowest` (`<seconds> <file>` lines, its test steps' slowest files).
#
# The time gate (time-gate.mjs, the gates' data in the tier data): a quick or
# slice check that passed (the local measure's modes) is judged on its seconds,
# its load at the start and the end and the machine's core count: ok, warn, fail or unjudged (a busy machine), with
# its lines printed after the check's output, naming the steps and the slowest
# files. A `fail` (an armed measure past its cutoff) exits 125: a time breach, not
# a test failure. A full check, a failed or stopped one, or a gate that can't
# read its data logs no verdict.
# Env: RISA_CHECK_LOG (default: .loops/.check-times.log in the main checkout).
set -uo pipefail
here=$(dirname "${BASH_SOURCE[0]}")
# shellcheck source=lib.sh
source "$here/lib.sh"

mode=${1:?mode}; why=${2:-}; shift 2
[[ ${1:-} == -- ]] && shift
log=${RISA_CHECK_LOG:-$loops/.check-times.log}
if [[ $mode == full ]]; then hard=2400; else hard=1200; fi
[[ ${RISA_CHECK_LIMIT:-} =~ ^[0-9]+$ ]] && ((RISA_CHECK_LIMIT > 0)) && hard=$RISA_CHECK_LIMIT
sleep_gap=${RISA_CHECK_SLEEP_GAP:-30}
[[ $sleep_gap =~ ^[0-9]+$ ]] || sleep_gap=30

# now → epoch seconds: the clock, or RISA_CLOCK_FILE's (tests).
now() {
  local t=""
  [[ -z ${RISA_CLOCK_FILE:-} ]] || t=$(cat "$RISA_CLOCK_FILE" 2>/dev/null)
  [[ $t =~ ^[0-9]+$ ]] || t=$(date +%s)
  echo "$t"
}

# One number whatever load_avg prints: drop the commas uptime puts after each
# value and any blank line (a failed sysctl under pipefail), keep the 5-minute field.
load5() { load_avg | tr -d ',' | awk 'NF >= 2 && $2 ~ /^[0-9.]+$/ { print $2; found = 1; exit } END { if (!found) print 0 }'; }

# tree PID → PID and everything under it. Taken before the TERM: a child whose
# parent has died can't be found from the parent any more.
tree() { local c; echo "$1"; for c in $(pgrep -P "$1" 2>/dev/null); do tree "$c"; done; }
stop_tree() {
  local pids p left i grace=${RISA_CHECK_KILL_GRACE:-10}
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

# Quick and slice checks are short: they wait only above the light limit (30).
if [[ $mode == full ]]; then load_gate_wait "the check"; else RISA_LOAD_LANE=light load_gate_wait "the check"; fi
start=$(date -u +%Y-%m-%dT%H:%M:%SZ); l0=$(load5)
branch=$(git branch --show-current 2>/dev/null)
budget=$hard silence=${RISA_CHECK_SILENCE:-480}
{ read -r b s; read -r said; } < <(node "$here/check-budget.mjs" --mode "$mode" --branch "$branch" --log "$log" --load "${RISA_CHECK_BUDGET_LOAD:-$l0}" 2>/dev/null) || true
if [[ ${b:-} =~ ^[0-9]+$ && ${s:-} =~ ^[0-9]+$ ]] && ((b > 0 && s > 0)); then
  budget=$b silence=$s
  echo "$said"
else
  [[ $silence =~ ^[0-9]+$ ]] && ((silence > 0)) || silence=480
  echo "Check budget ${budget}s (the hard limit; its usual time couldn't be read); silence limit ${silence}s."
fi
counts=$(mktemp); export RISA_CHECK_COUNTS=$counts
state=$(mktemp -d); export RISA_CHECK_STATE=$state
# The output goes on to stdout and stderr as before, and into $state/out for
# the silence limit and the last lines.
# Colours stay on for a terminal, though the command now writes to a pipe.
out=$state/out; : > "$out"
[[ -t 1 ]] && export FORCE_COLOR=${FORCE_COLOR:-1}
mkfifo "$state/o" "$state/e"
tee -a "$out" < "$state/o" & tee_o=$!
tee -a "$out" < "$state/e" >&2 & tee_e=$!
t0=$(now)
"$@" > "$state/o" 2> "$state/e" &
child=$!
# The tees end when the last writer closes; one the command left behind holding
# its output mustn't hold the check, so they get 5 s, then go.
tees_done() {
  local i
  for ((i = 0; i < 25; i++)); do
    kill -0 "$tee_o" 2>/dev/null || kill -0 "$tee_e" 2>/dev/null || break
    sleep 0.2
  done
  kill "$tee_o" "$tee_e" 2>/dev/null
  wait "$tee_o" "$tee_e" 2>/dev/null
  return 0
}
cleanup() { rm -rf "$state" "$counts"; }
trap 'stop_tree "$child"; tees_done; cleanup; exit 143' TERM
trap 'stop_tree "$child"; tees_done; cleanup; exit 130' INT
breach="" slept=0 last=$t0 heard=$t0 size=0
while kill -0 "$child" 2>/dev/null; do
  t=$(now)
  # A long gap between two readings: the machine slept (or the clock jumped).
  if ((t - last > sleep_gap)); then slept=$((slept + t - last)); heard=$t; fi
  last=$t
  sz=$(wc -c < "$out" 2>/dev/null || echo 0); sz=${sz//[^0-9]/}
  if ((${sz:-0} != size)); then size=${sz:-0}; heard=$t; fi
  if ((t - t0 - slept >= budget)); then breach=budget; break; fi
  if ((t - heard > silence)); then breach=silence; break; fi  # whole seconds: over, not at
  sleep 0.2
done
[[ -z $breach ]] || stop_tree "$child"
wait "$child" 2>/dev/null
code=$?
tees_done
trap - TERM INT
step=$(cat "$state/step" 2>/dev/null || true)
if [[ -n $breach ]]; then
  code=124
  {
    if [[ $breach == budget ]]; then
      echo "The check passed its budget of ${budget}s in the ${step:-first} step and was stopped (the hard limit, RISA_CHECK_LIMIT, is ${hard}s)."
    else
      echo "The check printed nothing for ${silence}s in the ${step:-first} step and was stopped (RISA_CHECK_SILENCE)."
    fi
    echo "A stopped check is a hang, not a test failure. Its last 30 lines:"
    tail -n 30 "$out" | sed 's/^/  | /'
  } >&2
fi
# The step times, summed by step in the order the steps first ran: `<seconds> <step>`.
steps_file=$state/steps; : > "$steps_file"
[[ ! -f $state/times ]] || awk '$1 ~ /^[0-9]+(\.[0-9]+)?$/ && NF == 2 {
    if (!($2 in s)) o[n++] = $2; s[$2] += $1 }
  END { for (i = 0; i < n; i++) print s[o[i]], o[i] }' "$state/times" > "$steps_file"
step_times=$(awk '{ printf "%s%s:%s", (NR > 1 ? "," : ""), $2, $1 }' "$steps_file")
list() { [[ -f $1 ]] && sort -u "$1" | paste -sd, - ; }
failed="" flaky=""
if [[ -n $breach ]]; then failed=""; elif ((code)); then failed=$(list "$state/failed"); else step=""; fi
flaky=$(list "$state/flaky")
read -r crun call < "$counts" 2>/dev/null || true; rm -f "$counts"
files_run=${RISA_CHECK_FILES_RUN:-${crun:-}}; files_all=${RISA_CHECK_FILES_ALL:-${call:-}}
secs=$(($(now) - t0 - slept)); ((secs >= 0)) || secs=0; l1=$(load5)
verdict=""
if [[ -z $breach ]] && ((code == 0)); then
  gate_args=(--mode "$mode" --seconds "$secs" --load-start "$l0" --load-end "$l1" --steps "$steps_file")
  [[ ! -f $state/slowest ]] || gate_args+=(--slowest "$state/slowest")
  if gate=$(node "$here/time-gate.mjs" "${gate_args[@]}" 2> "$state/gate-err"); then
    said=$(sed -n '2,$p' <<< "$gate")
    case $(head -n 1 <<< "$gate") in
      fail)
        verdict=fail code=125
        { echo "$said"; echo "A time breach, not a test failure: the check passed its tests but took too long."; } >&2
        ;;
      ok | warn | unjudged) verdict=$(head -n 1 <<< "$gate"); echo "$said" ;;
    esac
  else
    echo "The time gate couldn't judge the check: $(tr '\n' ' ' < "$state/gate-err")" >&2
  fi
fi
rm -rf "$state"
clean() { printf '%s' "$1" | tr '\t\n' '  '; }
top=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$start" "$(basename "$top")" "$(clean "$branch")" "$mode" "$(clean "$why")" \
  "$secs" "$l0" "$l1" "$code" "$files_run" "$files_all" "$load_waited" \
  "$(clean "$step")" "$(clean "$failed")" "$(clean "$flaky")" "$breach" "$verdict" "$(clean "$step_times")" >> "$log"
exit "$code"
