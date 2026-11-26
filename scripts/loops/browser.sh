#!/usr/bin/env bash
# pnpm prd browser: run browser checks from the current worktree, at most four
# at once machine-wide, so loops don't pile Chrome, Vite and PowerSync on top of
# each other.
#
#   browser.sh [--timeout S] <check> [args…]   one check (sign-in, sign-in.spec.mjs, or a path)
#   browser.sh --suite [--timeout S]           the lean end-to-end set (the manifest's e2e checks),
#                                              one at a time, then a table
#   browser.sh --changed [--base REF] [--list] only the checks the changed files need
#                                              (scripts/project/check-areas.d/), then a table
#   browser.sh --dev …                         any of the above, against the dev server
#   browser.sh --smoke …                       any of the above in smoke mode (SMOKE=1): each check
#                                              runs only its core path (a spec's @smoke tests);
#                                              without it,
#                                              checks run in full (SMOKE=0)
#   browser.sh --verbose …                     any of the above, printing each check's whole output
#
# The checks are the project's: its browser hook (the config's hooks.browser, a
# plain runner) lists them and runs one at a time; everything below is this
# gate's, around it.
#
#   <hook> list                                   "<check><TAB><file>" a line
#   <hook> run --output DIR <check> -- [args…]    one check, its output on
#                                                 stdout, its traces in DIR; exit 0
#                                                 on a pass
#
# In a .loops worktree with a stack, checks run against a check build (the serve
# hook's --built --fresh: started when no server is running, swapped in for a
# running dev server, rebuilt when its source is newer than the build). --dev
# keeps (or starts) the dev server instead.
#
# --changed diffs REF (default: $BASE_BRANCH from .env.loop, else origin/<trunk>,
# else the trunk) against the working tree: committed, staged, unstaged and untracked
# files. --base HEAD^ after a merge gives what that merge brought in; --head REF
# compares with a commit instead of the working tree. --list
# prints each file's checks and runs nothing. No checks needed → exit 0.
#
# A failed check is retried once (--no-retry, or CARETOOK_BROWSER_RETRY=0, turns
# it off) when the failure looks like contention: the load was above
# CARETOOK_BROWSER_BUSY (default 40) at its start or end, or the log shows a
# timeout, a 401 or PSYNC_S2101. It first waits (up to 5 min) for the load to
# drop below that. A pass on the retry is FLAKY: it counts as passing, and is
# recorded in $main/.loops/.browser-flakes.log so flaky steps can be fixed.
# Every check's result also goes to the run log (run-log.mjs, CARETOOK_RUN_LOG)
# for pnpm prd metrics.
#
# Each run holds a browser lease (lease.sh), the directory $main/.loops/.lease/browser/<N>.
# When every lease is taken it waits, polling every 5 s, and gives up after
# CARETOOK_BROWSER_WAIT seconds (default 1200). A lease whose holder is gone is
# taken over. The lease is released on every exit: success, failure, timeout,
# Ctrl-C, kill.
#
# The runner prints PASS, FAIL and SKIP lines and an "N/M passed" tally.
# Everything below (the lease, limits, retry, trimmed output, smoke mode, the
# check build) applies to every check.
#
# The check runs with the worktree's .env.loop (the main checkout's defaults when
# there is none) and Node from .nvmrc. Its full output goes to a log in the
# worktree's git dir. The terminal gets only
# the ▶ and ■ lines, FAIL lines with their diagnostics block (a timed-out wait's
# page state), TIMEOUT and FLAKY lines, and the table (a failure that printed
# none of those gets the log's last lines). --verbose prints everything.
#
# The manifest (the config's paths.checksManifest) lists every check: its cap, whether it
# never exits, and whether it's in the lean set (e2e, the suite), in suite
# order. --changed runs what the files need, lean or not. Three limits end a
# check, each as TIMEOUT (so the one retry applies):
#   - silence: no output line for CARETOOK_BROWSER_SILENCE seconds (default 90);
#   - its cap: --timeout S, else the manifest's cap, else 600 s;
#   - the suite cap (--suite and --changed): CARETOOK_BROWSER_SUITE_CAP seconds,
#     default the sum of the selected checks' caps. Past it the running check is
#     killed, nothing is retried, and the rest are listed as NOT-RUN.
# A kill stops the check's whole process tree (node, Chrome, proxies).
# Checks that never exit on their own (never-exits yes) are stopped 2 s after
# they print their last line ($hang_done: "N/M passed", or "errors:"). Their
# verdict comes from the "N/M passed" line, or "ended" when they print none.
#
# Env: CARETOOK_BROWSER_SLOTS (leases, default 2), CARETOOK_BROWSER_WAIT (s),
# CARETOOK_BROWSER_SUITE (the suite, space or comma separated; default the
# manifest's e2e checks), CARETOOK_BROWSER_SILENCE (s, default 90),
# CARETOOK_BROWSER_SUITE_CAP (s), CARETOOK_BROWSER_PAUSE (s between suite
# checks, default 2: Better Auth allows about 3 sign-ins per 10 s per client
# IP, and the fixtures give every device its own), CARETOOK_BROWSER_RETRY (0: no
# retry), CARETOOK_BROWSER_BUSY (the load that counts as busy, default 40),
# CARETOOK_BROWSER_LEASES and CARETOOK_BROWSER_FLAKES (the lease directory and
# the flakes log; tests point them elsewhere), CARETOOK_BROWSER_RESULTS (a file
# that --suite and --changed append "<check><TAB><result><TAB><retried 0|1>" to,
# for CI's browser job).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
# shellcheck source=lease.sh
source "$(dirname "$0")/lease.sh"

default_cap=600
# The line each never-exiting check prints last, once its work is done.
hang_done='^([0-9]+/[0-9]+ passed|errors: )'
hang_grace=2
wait_max=${CARETOOK_BROWSER_WAIT:-1200}
pause=${CARETOOK_BROWSER_PAUSE:-2}
retry=${CARETOOK_BROWSER_RETRY:-1}
busy=${CARETOOK_BROWSER_BUSY:-40}
silence=${CARETOOK_BROWSER_SILENCE:-90}
suite_cap=${CARETOOK_BROWSER_SUITE_CAP:-}
flakes_log=${CARETOOK_BROWSER_FLAKES:-$loops/.browser-flakes.log}
# Log lines that mean contention more often than a bug (Playwright's included:
# "Timeout 15000ms exceeded", "Test timeout of 90000ms exceeded").
transient='(timed out|Timed out|timeout|Timeout [0-9]+ms|TIMEOUT| 401|401 |PSYNC_S2101|ECONNRESET|socket hang up)'
# transient_lines LOG → the log without Playwright's call-log lines ("… with
# timeout 10000ms"), which every locator failure prints, a timeout or not.
transient_lines() { grep -Ev 'with timeout [0-9]+ms' "$1" 2>/dev/null || true; }

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

mode=one timeout="" check="" args=() base_ref="" head_ref="" list_only="" use_dev="" smoke="" verbose=""
while (($#)); do
  case $1 in
    --suite) mode=suite; shift ;;
    --changed) mode=changed; shift ;;
    --base) base_ref=${2:?--base needs a ref}; shift 2 ;;
    --base=*) base_ref=${1#*=}; shift ;;
    --head) head_ref=${2:?--head needs a ref}; shift 2 ;;
    --list) list_only=1; shift ;;
    --no-retry) retry=0; shift ;;
    --dev) use_dev=1; shift ;;
    --smoke) smoke=1; shift ;;
    --verbose | -v) verbose=1; shift ;;
    --timeout) timeout=${2:?--timeout needs seconds}; shift 2 ;;
    --timeout=*) timeout=${1#*=}; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) die "unknown option $1 (pnpm prd browser --help)" ;;
    *) check=$1; shift; args=("$@"); break ;;
  esac
done
[[ -z $timeout || $timeout =~ ^[0-9]+$ ]] || die "--timeout takes whole seconds"
[[ $silence =~ ^[0-9]+$ ]] || die "CARETOOK_BROWSER_SILENCE takes whole seconds"
[[ -z $suite_cap || $suite_cap =~ ^[0-9]+$ ]] || die "CARETOOK_BROWSER_SUITE_CAP takes whole seconds"
[[ $mode != one || -n $check ]] || { usage >&2; exit 1; }

top=$(git rev-parse --show-toplevel 2>/dev/null) || die "run pnpm prd browser inside the repo or a .loops worktree"
here=$(basename "$top"); [[ $top == "$main" ]] && here=main
logdir=$(git -C "$top" rev-parse --absolute-git-dir)/$project_name-browser
mkdir -p "$logdir"

# The manifest, the config's paths.checksManifest in this tree.
manifest_rel=$(config_get paths.checksManifest) || die "the config names no browser-check manifest (paths.checksManifest)"
manifest=$top/$manifest_rel
[[ -f $manifest ]] || die "no browser-check manifest ($manifest_rel): pnpm prd sync --force"

# The checks this tree has, from the browser hook: "<check><TAB><file>" a line.
config_get hooks.browser >/dev/null || die "the config names no browser runner (hooks.browser)"
checks_list=$(cd "$top" && run_hook browser list) || die "the browser hook's list failed (hooks.browser)"

# manifest_get CHECK COLUMN → a manifest field (2 cap, 3 never-exits, 4 e2e),
# or nothing when the check isn't listed.
manifest_get() {
  awk -v c="$1" -v k="$2" '!/^#/ && NF >= 4 && $1 == c { print $k; exit }' "$manifest"
}

# The suite: the manifest's e2e checks (the lean set), in its order; every
# check, in its order, for sorting what --changed picks.
suite_default=$(awk '!/^#/ && NF >= 4 && $4 == "yes" { printf "%s ", $1 }' "$manifest")
manifest_order=$(awk '!/^#/ && NF >= 4 { printf "%s ", $1 }' "$manifest")

# never_exits CHECK → whether the check never exits on its own.
never_exits() { [[ $(manifest_get "$1" 3) == yes ]]; }

# cap_of CHECK → its cap in seconds: the manifest's, else $default_cap.
cap_of() {
  local v
  v=$(manifest_get "$1" 2)
  [[ $v =~ ^[0-9]+$ ]] && echo "$v" || echo "$default_cap"
}

# vsay … → echo only with --verbose (lease bookkeeping and other chatter).
vsay() { [[ -z $verbose ]] || echo "$@"; }

# resolve_check X → the check's name, for X its name, its file's name (with or
# without .mjs) or a path to its file; fails when the hook lists no such check.
resolve_check() {
  local x=$1 name file abs=""
  [[ $x == */* && -f $x ]] && abs=$(cd "$(dirname "$x")" && echo "$PWD/$(basename "$x")")
  while IFS=$'\t' read -r name file; do
    [[ -n $name ]] || continue
    if [[ $x == "$name" || $x == "${file##*/}" || $x.mjs == "${file##*/}" || (-n $abs && $abs == "$top/$file") ]]; then
      echo "$name"
      return 0
    fi
  done <<< "$checks_list"
  return 1
}

# shown CHECK → how the lines name it: its file's name (sign-in.spec.mjs).
shown() {
  local name file
  while IFS=$'\t' read -r name file; do
    [[ $name == "$1" ]] && { echo "${file##*/}"; return 0; }
  done <<< "$checks_list"
  echo "$1"
}

# start_check CHECK [args…] → the check in the background (its pid in $child),
# through the browser hook, its traces in the log dir.
start_check() {
  local name=$1
  shift
  run_hook browser run --output "$logdir" "$name" -- "$@" >&3 2>&1 &
  child=$!
}

# kill_tree PID SIGNAL → signal PID and every process below it (node, Chrome, proxies).
kill_tree() {
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c" "$2"; done
  kill "-$2" "$1" 2>/dev/null || true
}

# tree_pids PID → PID and every process below it.
tree_pids() {
  local c
  echo "$1"
  for c in $(pgrep -P "$1" 2>/dev/null); do tree_pids "$c"; done
}

# stop_tree PID → TERM the process tree, then KILL whatever is left of it after
# 5 s (the processes, not just PID's descendants: Chrome outlives its node).
stop_tree() {
  local pids p i alive
  pids=$(tree_pids "$1")
  for p in $pids; do kill -TERM "$p" 2>/dev/null || true; done
  for i in $(seq 1 20); do
    alive=""
    for p in $pids; do kill -0 "$p" 2>/dev/null && alive=1; done
    [[ -z $alive ]] && return 0
    sleep 0.25
  done
  for p in $pids; do kill -KILL "$p" 2>/dev/null || true; done
}

child="" watchdog=""
# On every exit: stop the check's processes, then release the lease, with
# errexit off so nothing in here can skip the release. The release is
# synchronous, so the lease is gone before browser.sh exits; the normal paths
# also release it before their exit (done_with).
cleanup() {
  set +e
  local c
  [[ -n $watchdog ]] && kill_tree "$watchdog" TERM
  [[ -n $child ]] && kill -0 "$child" 2>/dev/null && kill_tree "$child" TERM
  # Then anything else still below this script: a signal that lands between
  # `node … &` and `child=$!` (or the watcher's `&` and `watchdog=$!`) runs this
  # trap with neither recorded, and the check would outlive it with its output
  # filter (B-704).
  for c in $(pgrep -P $$ 2>/dev/null); do kill_tree "$c" TERM; done
  lease_release
}
# done_with RC → release the lease, then exit with RC.
done_with() { lease_release; exit "$1"; }
trap cleanup EXIT
trap 'echo; echo "Interrupted."; exit 130' INT
trap 'exit 143' TERM

# Leases come from lease.sh (kind browser): write_lease LABEL relabels ours
# (the suite does, per check), acquire LABEL takes one, waiting while all are
# taken, and gives up with exit 75 after CARETOOK_BROWSER_WAIT seconds.
lease_say=vsay
write_lease() { lease_write "$1"; }
acquire() {
  lease_worktree=$here
  lease_take browser "$1" "$wait_max" || exit 75
}

# Node 24 from .nvmrc, and the worktree's ports.
cd "$top"
use_node || exit 1
if [[ -f .env.loop ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.loop
  set +a
fi
# Full mode unless --smoke, whatever the shell has set.
export SMOKE=$([[ -n $smoke ]] && echo 1 || echo 0)

# ensure_server → the server the checks run against, in a .loops worktree with
# a stack: a check build (pnpm prd serve --built), started if nothing runs,
# swapped in for a dev server, and rebuilt when the source (or the env baked
# into it) is newer than the build, so checks never run against stale code.
# With --dev, the dev server instead. The main checkout's server is the user's:
# left alone.
ensure_server() {
  [[ $here != main && -n $(web_port "$top") ]] || return 0
  # The project's dev server, through the config's serve hook.
  serve() { stack_hook serve "$@"; }
  if [[ -n $use_dev ]]; then
    serve "$here" --dev
    return
  fi
  require_disk "a check build"
  echo "Checks run against a check build (pnpm prd browser --dev for the dev server)."
  # --fresh: the hook rebuilds a running check build that's older than its source.
  serve "$here" --built --fresh
}

# start_server → ensure_server, its output in the log dir unless --verbose
# (shown when it fails).
start_server() {
  if [[ -n $verbose ]]; then ensure_server; return; fi
  local out=$logdir/server.log
  if ! (ensure_server) > "$out" 2>&1; then
    cat "$out" >&2
    die "the server for the checks didn't start (log $out)"
  fi
}

# show_output → the terminal's share of a check's output (see the top): all of
# it with --verbose, else FAIL, TIMEOUT and error lines with the indented block
# after them. Writes how many lines it showed to $1.
show_output() {
  if [[ -n $verbose ]]; then cat; echo 1 > "$1"; return; fi
  awk -v shown="$1" '
    function out(l) { print l; fflush(); n++ }
    /^(FAIL|FAILED|TIMEOUT)([ :(]|$)/ || /timed out waiting for/ || /^[A-Za-z]*Error:/ || /^✗/ { out($0); block = 1; next }
    block && (/^[ \t]/ || /^\[.*\] at /) { out($0); next }
    { block = 0 }
    END { print n + 0 > shown }'
}

# run_once CHECK [args…] → runs it; sets verdict (pass, FAIL, TIMEOUT, ended),
# rc, elapsed and log. A check is killed when it's silent for $silence s, at its
# cap, or at the suite's deadline ($deadline, epoch seconds, when set).
run_once() {
  local name=$1 base t why start load0 marker finished silent shown_file hang="" tally tee_pid left i shown killed
  shift
  base=$(shown "$name")
  t=${timeout:-$(cap_of "$name")} why=cap
  [[ -n $timeout ]] && why=--timeout
  if [[ -n ${deadline:-} ]]; then
    left=$((deadline - $(date +%s)))
    ((left < 1)) && left=1
    ((left < t)) && { t=$left why="suite cap"; }
  fi
  never_exits "$name" && hang=1
  log=$logdir/$name-$(date +%Y%m%d-%H%M%S).log
  [[ -e $log ]] && log=${log%.log}-retry.log
  marker=$log.timedout finished=$log.finished silent=$log.silent shown_file=$log.shown
  start=$(date +%s) load0=$(load_avg)
  echo "▶ $base in $here · lease $lease_n/$(lease_slots browser) · $(date +%H:%M:%S) · load $load0 · BASE ${BASE:-(default)} · cap ${t}s$([[ $why != cap ]] && echo " ($why)")$([[ -n $smoke ]] && echo " · smoke")"
  : > "$log"
  exec 3> >(tee -a "$log" | show_output "$shown_file")
  tee_pid=$!
  start_check "$name" "$@"
  # One watcher: stop a never-exiting check once its last line is out, and any
  # check that goes silent or reaches its cap.
  (
    while kill -0 "$child" 2>/dev/null; do
      now=$(date +%s)
      if [[ -n $hang ]] && grep -Eq "$hang_done" "$log" 2>/dev/null; then
        sleep "$hang_grace"; touch "$finished"; break
      fi
      if ((now - start >= t)); then touch "$marker"; break; fi
      last=$(file_mtime "$log" || echo "$start")
      ((last < start)) && last=$start
      if ((now - last >= silence)); then touch "$silent"; break; fi
      sleep 1
    done
    kill -0 "$child" 2>/dev/null || exit 0
    stop_tree "$child"
  ) 3>&- &
  watchdog=$!
  rc=0
  wait "$child" || rc=$?
  child=""
  # A watcher that's stopping the check finishes the job (Chrome can outlive node).
  [[ -f $marker || -f $silent || -f $finished ]] || kill_tree "$watchdog" TERM
  wait "$watchdog" 2>/dev/null || true
  watchdog=""
  exec 3>&-
  # The filter ends once every writer has closed the pipe; don't wait forever
  # on a stray process that kept it open.
  for i in $(seq 1 40); do kill -0 "$tee_pid" 2>/dev/null || break; sleep 0.1; done
  kill_tree "$tee_pid" TERM
  wait "$tee_pid" 2>/dev/null || true
  elapsed=$(($(date +%s) - start))
  if [[ -f $finished ]]; then
    rm -f "$finished" "$marker" "$silent"
    tally=$(grep -Eo '^[0-9]+/[0-9]+ passed' "$log" | tail -1 || true)
    if [[ -z $tally ]]; then verdict=ended rc=0
    elif [[ ${tally%%/*} == "$(echo "$tally" | sed -E 's#^[0-9]+/([0-9]+).*#\1#')" ]]; then verdict=pass rc=0
    else verdict=FAIL rc=1
    fi
    vsay "(stopped ${hang_grace}s after its last line, as expected for $base${tally:+: $tally})"
  elif [[ -f $marker || -f $silent ]]; then
    # A never-exiting check that gets here never printed its last line either.
    if [[ -f $silent ]]; then
      killed="TIMEOUT (silent: no output for ${silence}s)"
    else
      killed="TIMEOUT (killed at its ${t}s $why${hang:+, before its last line})"
    fi
    rm -f "$marker" "$silent"
    echo "$killed" >> "$log"
    echo "$killed"
    verdict=TIMEOUT rc=124
  elif ((rc == 0)); then verdict=pass
  else verdict=FAIL
  fi
  shown=$(cat "$shown_file" 2>/dev/null || echo 0)
  rm -f "$shown_file"
  if [[ $verdict == FAIL && ${shown:-0} == 0 ]]; then
    echo "  (the log's last lines)"
    tail -n 12 "$log" | sed 's/^/  /'
  fi
  load_start=$load0 load_end=$(load_avg)
  echo "■ $base: $verdict (exit $rc) in $(fmt_secs "$elapsed") · load at start $load_start, at end $load_end · log $log"
}

# load1 "1m 5m 15m" → the 1-minute load as a whole number.
load1() { local l=${1%% *}; echo "${l%%.*}"; }

# looks_transient → whether the last run's failure looks like contention.
looks_transient() {
  (($(load1 "$load_start") > busy || $(load1 "$load_end") > busy)) && return 0
  [[ $verdict == TIMEOUT ]] && return 0
  transient_lines "$log" | grep -Eq "$transient"
}

# run_check CHECK [args…] → run_once, and once more if it failed on contention.
run_check() {
  local name=$1 first_log first_elapsed waited=0 why
  retried=0
  run_once "$@"
  [[ $verdict == pass || $verdict == ended ]] && return 0
  ((retry)) || return 0
  if [[ -n ${deadline:-} ]] && (($(date +%s) >= deadline)); then
    echo "(not retried: the suite cap is reached)"
    return 0
  fi
  looks_transient || { echo "(not retried: the failure doesn't look like contention)"; return 0; }
  first_log=$log first_elapsed=$elapsed
  why="load $(load1 "$load_start")→$(load1 "$load_end")"
  transient_lines "$first_log" | grep -Eq "$transient" &&
    why+=", $(transient_lines "$first_log" | grep -Eo "$transient" | head -1 | xargs)"
  while (($(load1 "$(load_avg)") > busy && waited < 300)) && [[ -z ${deadline:-} || $(date +%s) -lt $deadline ]]; do
    ((waited == 0)) && echo "Waiting for the load ($(load_avg)) to drop below $busy before retrying…"
    sleep 15; waited=$((waited + 15))
  done
  sleep "$pause"
  echo "↻ retrying $(shown "$name") once ($why)"
  retried=1
  run_once "$@"
  elapsed=$((elapsed + first_elapsed))
  if [[ $verdict == pass || $verdict == ended ]]; then
    verdict=FLAKY rc=0
    printf '%s\t%s\t%s\t%s\t%s\n' "$(date '+%Y-%m-%d %H:%M')" "$here" "$(shown "$name")" "$why" "$first_log" \
      >> "$flakes_log"
    echo "■ $(shown "$name"): FLAKY (failed, then passed on the retry; recorded in $flakes_log)"
  fi
}

# log_result CHECK → the run log's line for the check just run (run-log.mjs): its
# result (pass, ended, flaky, fail, timeout), seconds and whether it was retried.
# It never fails the run.
log_result() {
  local result
  result=$(tr '[:upper:]' '[:lower:]' <<< "$verdict")
  run_log browser "check=$1" "result=$result" "seconds:=${elapsed:-0}" \
    "retried:=$([[ ${retried:-0} == 1 ]] && echo true || echo false)" "worktree=$here" \
    "branch=$(git -C "$top" branch --show-current 2>/dev/null || true)" "mode=$mode" "smoke:=$([[ -n $smoke ]] && echo true || echo false)"
}

if [[ $mode == one ]]; then
  name=$(resolve_check "$check") || die "no check $check (the browser hook lists: $(cut -f1 <<< "$checks_list" | xargs))"
  start_server
  acquire "$(shown "$name")"
  run_check "$name" "${args[@]}"
  log_result "$name"
  done_with "$rc"
fi

# --changed: the checks the changed files need, from the rules in the config's
# check areas folder (most specific wins), resolved by its checkAreas hook.
if [[ $mode == changed ]]; then
  areas_rel=$(config_get paths.checkAreas) || die "the config names no check areas folder (paths.checkAreas)"
  config_get hooks.checkAreas >/dev/null || die "the config names no check-areas resolver (hooks.checkAreas)"
  areas=$top/$areas_rel
  [[ -d $areas ]] || die "no $areas"
  if [[ -z $base_ref ]]; then
    for r in "${BASE_BRANCH:-}" "origin/$trunk" "$trunk"; do
      [[ -n $r ]] && git rev-parse -q --verify "$r^{commit}" >/dev/null && { base_ref=$r; break; }
    done
  fi
  git rev-parse -q --verify "$base_ref^{commit}" >/dev/null || die "no ref $base_ref"
  mb=$(git merge-base "$base_ref" "${head_ref:-HEAD}") || die "no merge base with $base_ref"
  if [[ -n $head_ref ]]; then
    files=$(git diff --name-only "$mb" "$head_ref")
  else
    files=$( { git diff --name-only "$mb"; git ls-files --others --exclude-standard; } | sort -u)
  fi
  selected=() full="" unmapped=() unmapped_default=""
  echo "Changed since $base_ref ($(git rev-parse --short "$mb")): $(grep -c . <<< "$files" || true) file(s)"
  # One line per file: "<file><TAB><checks>". A tie (two equally specific
  # rules) exits 2 after naming them on stderr: the first still answers.
  rc=0
  resolved=$(printf '%s\n' "$files" | run_hook checkAreas resolve --root "$top" --areas "$areas" --base "$mb" ${head_ref:+--head "$head_ref"}) || rc=$?
  ((rc == 0 || rc == 2)) || die "the checkAreas hook failed (exit $rc)"
  while IFS=$'\t' read -r f c; do
    [[ -z $f ]] && continue
    [[ -n $list_only ]] && printf '  %-60s %s\n' "$f" "$c"
    case $c in
      @suite) full=1 ;;
      -*) ;;
      UNMAPPED*) unmapped+=("$f"); unmapped_default=${c#UNMAPPED }; read -r -a more <<< "$unmapped_default"; selected+=("${more[@]}") ;;
      *) read -r -a more <<< "$c"; selected+=("${more[@]}") ;;
    esac
  done <<< "$resolved"
  ((${#unmapped[@]})) && {
    echo "No rule in $areas_rel/ for: ${unmapped[*]}"
    echo "  (running $unmapped_default for them; add a rule)"
  }
  if [[ -n $full ]]; then
    # The lean set, plus whatever else the other files named.
    read -r -a more <<< "${CARETOOK_BROWSER_SUITE:-$suite_default}"
    selected+=("${more[@]}")
    echo "A change needs the whole lean set (build, config, dependencies, sync rules or migrations)."
  fi
  # The manifest's order, then anything it doesn't list.
  suite=()
  for c in $manifest_order; do [[ " ${selected[*]:-} " == *" $c "* ]] && suite+=("$c"); done
  for c in "${selected[@]:-}"; do [[ -n $c && " ${suite[*]:-} " != *" $c "* ]] && suite+=("$c"); done
  # A check that doesn't exist in this tree (a manifest line whose spec hasn't landed) is skipped.
  kept=()
  for c in "${suite[@]:-}"; do
    [[ -z $c ]] && continue
    if resolve_check "$c" >/dev/null; then kept+=("$c"); else echo "(skipping $c: not in this tree)"; fi
  done
  suite=("${kept[@]:-}")
  if [[ -z ${suite[*]:-} ]]; then
    echo "No browser checks needed for these changes."
    exit 0
  fi
  echo "Checks needed: ${suite[*]}"
  [[ -n $list_only ]] && exit 0
else
  # --suite: every check.
  read -r -a suite <<< "${CARETOOK_BROWSER_SUITE:-$suite_default}"
fi

# record_result CHECK RESULT RETRIED → one line for a caller that asks
# (CARETOOK_BROWSER_RESULTS).
record_result() {
  if [[ -n ${CARETOOK_BROWSER_RESULTS:-} ]]; then
    printf '%s\t%s\t%s\n' "$(resolve_check "$1" || echo "$1")" "$2" "$3" >> "$CARETOOK_BROWSER_RESULTS"
  fi
}

# Both: one lease for the whole run, one check at a time, every check runs.
suite=("${suite[@]//,/ }")
read -r -a suite <<< "${suite[*]}"
start_server
# The load gate (load-gate.mjs, limit 20), before the lease so a wait blocks no one.
load_gate_wait "the browser checks"
acquire "$mode"
rows=() failed=0 notrun=0 i=0 suite_start=$(date +%s)
if [[ -z $suite_cap ]]; then
  suite_cap=0
  for c in "${suite[@]}"; do suite_cap=$((suite_cap + $(cap_of "$c"))); done
fi
deadline=$((suite_start + suite_cap))
echo "Running ${#suite[@]} checks (suite cap $(fmt_secs "$suite_cap")): ${suite[*]}"
for c in "${suite[@]}"; do
  i=$((i + 1))
  if (($(date +%s) >= deadline)); then
    rows+=("$(printf '%-24s %-8s %s' "$(shown "$(resolve_check "$c" || echo "$c")")" NOT-RUN "-")"); notrun=$((notrun + 1)); record_result "$c" NOT-RUN 0; continue
  fi
  if ! name=$(resolve_check "$c"); then
    rows+=("$(printf '%-24s %-8s %s' "$c" MISSING "-")"); failed=$((failed + 1)); record_result "$c" MISSING 0; continue
  fi
  ((i > 1)) && sleep "$pause"
  write_lease "$mode $i/${#suite[@]}: $(shown "$name")"
  run_check "$name"
  log_result "$name"
  record_result "$name" "$verdict" "$retried"
  [[ $verdict == pass || $verdict == ended || $verdict == FLAKY ]] || failed=$((failed + 1))
  rows+=("$(printf '%-24s %-8s %s' "$(shown "$name")" "$verdict" "$(fmt_secs "$elapsed")")")
done
echo
echo "Browser $([[ $mode == changed ]] && echo "checks for the changes" || echo suite)$([[ -n $smoke ]] && echo " (smoke)") in $here: $((${#suite[@]} - failed - notrun))/${#suite[@]} passed$( ((notrun)) && echo ", $notrun not run (suite cap $(fmt_secs "$suite_cap") reached)") in $(fmt_secs $(($(date +%s) - suite_start))) · load now $(load_avg)"
printf '%-24s %-8s %s\n' CHECK RESULT TIME
printf '%s\n' "${rows[@]}"
[[ "${rows[*]}" == *" ended "* ]] && echo "(ended: a never-exiting check stopped without a tally; read its log in $logdir)"
((failed == 0 && notrun == 0)) && done_with 0
done_with 1
