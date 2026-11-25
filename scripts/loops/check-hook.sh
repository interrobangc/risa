#!/usr/bin/env bash
# check-hook.sh MODE BASE TOOLING [OWN_TEST_FILE…]: what one check runs, in the
# current directory (the repo's root): the project's check, then the tool's own
# tooling tests. prd.sh check runs it inside the check lease and check-run.sh
# (the load gate, the log, the timings and limits); the check plan
# (check-plan.mjs) has decided MODE, TOOLING and the diff's own test files.
#
# The project's check is the config's `check` hook (hooks.check: a command, run
# by bash from the repo's root). Its contract:
#   in:   MODE (slice, quick or full), BASE (the commit the diff is from) and the
#         OWN test files (the diff's own; some may be deleted), as arguments;
#         CARETOOK_CHECK_STATE, a directory, and CARETOOK_CHECK_COUNTS, a file,
#         in the environment (check-run.sh makes both)
#   out:  the exit code (0 passed; anything else fails the check with that code);
#         in the state directory, `step` (the step running, one line, rewritten
#         as it goes) and `failed` and `flaky` (test files, one per line, added
#         to); in the counts file, "<test files run> <test files in all>"
#         (optional: none leaves the log's two fields empty)
#   It runs no tooling test of the tool's and needs no file of the tool's.
# With no hook set the check fails (exit 2): a project with no check can't pass one.
#
# The tooling tests, when TOOLING isn't 0 and the hook passed: tooling-tests.mjs
# --check, the config's testProjects.tooling (and its browserHarness when
# TOOLING is 2), with the same rerun rules and state files (step `tooling`).
set -uo pipefail
here=$(dirname "${BASH_SOURCE[0]}")
# shellcheck source=lib.sh
source "$here/lib.sh"

mode=${1:?mode} base=${2:?base} tooling=${3:?tooling}; shift 3
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 2
hook=$(config_get hooks.check 2>/dev/null) || {
  echo "The project config sets no check hook (hooks.check), so there is no check to run." >&2
  exit 2
}
# shellcheck disable=SC2016 # the hook's own "$@", expanded by the bash it runs in
bash -c "$hook"' "$@"' check-hook "$mode" "$base" "$@" || exit
[[ $tooling != 0 ]] || exit 0
harness=()
[[ $tooling != 2 ]] || harness=(--harness)
exec node "$here/tooling-tests.mjs" --check ${harness[@]+"${harness[@]}"} \
  --state "${CARETOOK_CHECK_STATE:-}" --rerun-max "${CARETOOK_CHECK_RERUN_MAX:-20}"
