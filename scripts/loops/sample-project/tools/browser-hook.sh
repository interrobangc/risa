#!/usr/bin/env bash
# The sample project's browser hook, for the core's tests: a plain runner's shape
# (list, run) with no browser behind it. A check is a Node script,
# tools/browser-checks/<check>.mjs from the checkout's top, that prints a runner's
# lines itself (PASS, FAIL, "N/M passed") and exits 0 on a pass.
#
#   browser-hook.sh list                                    "<check><TAB><file>" a line
#   browser-hook.sh run [--output DIR] <check> [-- ARG…]    runs it, ARGs after it
#
# Each run is logged to $SAMPLE_BROWSER_LOG when set: "run <check> [ARG…]".
set -uo pipefail
dir=tools/browser-checks
case ${1:-} in
  list)
    for f in "$dir"/*.mjs; do [[ -f $f ]] && printf '%s\t%s\n' "$(basename "$f" .mjs)" "$f"; done
    exit 0
    ;;
  run)
    shift
    [[ ${1:-} == --output ]] && shift 2
    name=${1:?browser-hook.sh: run needs a check}
    shift
    [[ ${1:-} == -- ]] && shift
    [[ -z ${SAMPLE_BROWSER_LOG:-} ]] || echo "run $name${*:+ $*}" >> "$SAMPLE_BROWSER_LOG"
    [[ -f $dir/$name.mjs ]] || { echo "FAIL no check $name"; exit 1; }
    exec node "$dir/$name.mjs" "$@"
    ;;
  *) echo "browser-hook.sh: list or run" >&2; exit 2 ;;
esac
