#!/usr/bin/env bash
# check-hook.sh [--steps] MODE BASE TOOLING [OWN_TEST_FILE…]: what one check
# runs, in the current directory (the repo's root): the project's check, then
# the tool's own tooling tests. prd.sh check runs it inside the check lease and
# check-run.sh (the load gate, the log, the timings and limits); the check plan
# (check-plan.mjs) has decided MODE, TOOLING and the diff's own test files.
#
# The project's check is the config's `check` hook (hooks.check: a command, run
# through lib.sh's run_hook from the checkout's top). Its contract:
#   in:   MODE (slice, quick or full), BASE (the commit the diff is from) and the
#         OWN test files (the diff's own; some may be deleted), as arguments;
#         RISA_CHECK_STATE, a directory, and RISA_CHECK_COUNTS, a file,
#         in the environment (check-run.sh makes both)
#   out:  the exit code (0 passed; anything else fails the check with that code);
#         in the state directory, `step` (the step running, one line, rewritten
#         as it goes) and `failed` and `flaky` (test files, one per line, added
#         to); in the counts file, "<test files run> <test files in all>"
#         (optional: none leaves the log's two fields empty); optional too, in
#         the state directory, `times` (`<seconds> <step>` lines, each step's
#         seconds) and `slowest` (`<seconds> <file>` lines, its test steps'
#         slowest files): the time gate names them
#   It runs no tooling test of the tool's and needs no file of the tool's.
# With no hook set the check fails (exit 2): a project with no check can't pass one.
#
# The slice's own check (RISA-1005): on a slice branch, a slice check whose plan
# slice names test files (its `Check:` field, slice-fields.mjs) in a config that
# sets commands.testFile runs, in place of the hook, commands.staticCheck (the
# project's check without its tests: typecheck, lint, format; unset, commands.typecheck)
# and then commands.testFile with those files appended (steps `static` and
# `unit`). No such field or no testFile: the hook, as above. The full check
# stays at the wave's gate.
#
# The tooling tests, when TOOLING isn't 0 and the hook passed: check-tooling.mjs, the config's testProjects.tooling (and its browserHarness when
# TOOLING is 2), with the same rerun rules and state files (step `tooling`, its
# seconds and slowest files in `times` and `slowest`). After the slice's own check
# above (RISA-1015), only its Check files, those among the tooling tests (the
# others run nothing more), never the whole suite; and of those, none the `unit`
# step already ran and passed (RISA-1021: --ran, check-tooling.mjs), so a Check
# file that is also a tooling test (Risa's own repo) runs once.
#
# Its own steps' times (RISA-1073): `check` (the hook, whatever times it writes
# of its own), `static` and `unit` go into the state's `times` as the tooling
# step's do, so the check log tells which steps a run ran and the budget
# (check-budget.mjs) learns from runs of the same steps. --steps runs nothing:
# it prints the steps the check would run, comma-separated (`check` or
# `static,unit`, then `,tooling` when TOOLING isn't 0), for prd.sh to hand
# check-run.sh (RISA_CHECK_STEPS).
set -uo pipefail
here=$(dirname "${BASH_SOURCE[0]}")
# shellcheck source=lib.sh
source "$here/lib.sh"

plan_steps=0
[[ ${1:-} != --steps ]] || { plan_steps=1; shift; }
mode=${1:?mode} base=${2:?base} tooling=${3:?tooling}; shift 3
config_get hooks.check > /dev/null 2>&1 || {
  echo "The project config sets no check hook (hooks.check), so there is no check to run." >&2
  exit 2
}
# slice_check → the slice's Check files, comma-separated, when this is a slice
# check on a slice branch with commands.testFile set; false otherwise.
slice_check() {
  local branch rest plans files
  [[ $mode == slice ]] && config_get commands.testFile > /dev/null 2>&1 || return 1
  branch=$(git branch --show-current 2>/dev/null)
  [[ $branch == "$slice_prefix"*/* ]] || return 1
  rest=${branch#"$slice_prefix"}
  plans=$(config_get paths.plans) || return 1
  files=$(node "$here/slice-fields.mjs" "${rest##*/}" "$top/$plans/${rest%/*}-plan.md" --get check 2>/dev/null) || return 1
  [[ -n $files ]] && echo "$files"
}
top=$(git rev-parse --show-toplevel) || exit
if ((plan_steps)); then
  if slice_check > /dev/null; then steps=static,unit; else steps=check; fi
  [[ $tooling == 0 ]] || steps+=,tooling
  echo "$steps"
  exit 0
fi
# timed NAME CMD…: run CMD, then add its seconds to the state's times as step NAME.
timed() {
  local name=$1 t0=$SECONDS code; shift
  "$@"; code=$?
  [[ -z ${RISA_CHECK_STATE:-} ]] || echo "$((SECONDS - t0)) $name" >> "$RISA_CHECK_STATE/times"
  return "$code"
}
in_top() ( cd "$top" && "$@" )
static_check() {
  if config_get commands.staticCheck > /dev/null 2>&1; then in_top run_project staticCheck; else in_top run_project typecheck; fi
}
if own=$(slice_check); then
  IFS=', ' read -r -a own_files <<< "$own"
  echo "The slice's Check field names ${own_files[*]}: the slice check runs the project's check without its tests, then only those (commands.testFile)."
  state=${RISA_CHECK_STATE:-}
  # step NAME: the step running, for check-run.sh's log.
  step() { [[ -z $state ]] || echo "$1" > "$state/step"; }
  step static
  timed static static_check || exit
  step unit
  timed unit in_top run_project testFile "${own_files[@]}" || {
    code=$?
    [[ -z $state ]] || printf '%s\n' "${own_files[@]}" >> "$state/failed"
    exit "$code"
  }
else
  # lib.sh's run_hook: from the checkout's top, the arguments after the command.
  timed check run_hook check "$mode" "$base" "$@" || exit
fi
[[ $tooling != 0 ]] || exit 0
harness=()
[[ $tooling != 2 ]] || harness=(--harness)
only=()
if [[ -n ${own_files+x} ]]; then
  echo "The tooling step runs only the slice's Check file(s) among the tooling tests, but none the unit step ran: ${own_files[*]}."
  for f in "${own_files[@]}"; do only+=(--file "$f"); done
  only+=(--ran)
fi
exec node "$here/check-tooling.mjs" ${harness[@]+"${harness[@]}"} ${only[@]+"${only[@]}"} \
  --state "${RISA_CHECK_STATE:-}" --rerun-max "${RISA_CHECK_RERUN_MAX:-20}"
