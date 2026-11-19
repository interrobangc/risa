#!/usr/bin/env bash
# pnpm prd browser: run browser checks from the current worktree, at most four
# at once machine-wide, so loops don't pile Chrome, Vite and PowerSync on top of
# each other.
#
#   browser.sh [--timeout S] <check> [args…]   one check (phase2, phase2.mjs, or a path)
#   browser.sh --suite [--timeout S]           every check in $suite, one at a time, then a table
#   browser.sh --changed [--base REF] [--list] only the checks the changed files need
#                                              (scripts/loops/check-areas), then a table
#   browser.sh --dev …                         any of the above, against the dev server
#   browser.sh --smoke …                       any of the above in smoke mode (SMOKE=1): each check
#                                              runs only its core path (cdp.mjs step()); without
#                                              it, checks run in full (SMOKE=0)
#
# In a .loops worktree with a stack, checks run against a check build (pnpm prd
# serve --built): one is started when no server is running, swapped in for a
# running dev server, and rebuilt and restarted when the source is newer than
# the build. --dev keeps (or starts) the dev server instead.
#
# --changed diffs REF (default: $BASE_BRANCH from .env.loop, else origin/dev,
# else dev) against the working tree: committed, staged, unstaged and untracked
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
#
# Each run holds a lease, the directory $main/.loops/.browser/<N> (see lib.sh).
# When every lease is taken it waits, polling every 5 s, and gives up after
# CARETOOK_BROWSER_WAIT seconds (default 1200). A lease whose holder is gone is
# taken over. The lease is released on every exit: success, failure, timeout,
# Ctrl-C, kill.
#
# The check runs from scripts/browser-checks/ with the worktree's .env.loop
# (the main checkout's defaults when there is none) and Node from .nvmrc. Its
# output goes to the terminal and to a log in the worktree's git dir.
#
# --timeout S kills the check (and its Chrome) after S seconds. The checks that
# never exit on their own ($hangs) are stopped 2 s after they print their last
# line ($hang_done: layout-offline's "N/M passed", signout-wipe's "errors:"),
# so they don't hold a lease for nothing; 300 s is their default timeout, as a
# backstop (TIMEOUT: the last line never came). Their verdict comes from the
# "N/M passed" line, or "ended" when they print none (signout-wipe has no
# assertions: read its output).
#
# Env: CARETOOK_BROWSER_SLOTS (leases, default 4), CARETOOK_BROWSER_WAIT (s),
# CARETOOK_BROWSER_SUITE (the suite, space or comma separated),
# CARETOOK_BROWSER_PAUSE (s between suite checks, default 2: Better Auth allows
# about 3 sign-ins per 10 s per client IP, and cdp.mjs gives every page its own),
# CARETOOK_BROWSER_RETRY (0: no retry), CARETOOK_BROWSER_BUSY
# (the load that counts as busy, default 40).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

# The full suite: every check in AGENTS.md's Browser check budget table.
suite_default="phase2 roundtrip live-notes app-shell routing settings-layout layout-offline sign-in first-sync signout-wipe session-end providers invites ui groups medications upcoming search profiles profiles-contacts care-periods devices"
hangs=" signout-wipe.mjs layout-offline.mjs "
hang_timeout=300
# The line each never-exiting check prints last, once its work is done.
hang_done='^([0-9]+/[0-9]+ passed|errors: )'
hang_grace=2
wait_max=${CARETOOK_BROWSER_WAIT:-1200}
poll=${CARETOOK_BROWSER_POLL:-5}
pause=${CARETOOK_BROWSER_PAUSE:-2}
retry=${CARETOOK_BROWSER_RETRY:-1}
busy=${CARETOOK_BROWSER_BUSY:-40}
# Log lines that mean contention more often than a bug.
transient='(timed out|Timed out|timeout|TIMEOUT| 401|401 |PSYNC_S2101|ECONNRESET|socket hang up)'
# Checks run for a changed file no rule covers (check-areas).
unmapped_default="sign-in phase2 roundtrip"

usage() { sed -n '2,56p' "$0" | sed 's/^# \{0,1\}//'; }

mode=one timeout="" check="" args=() base_ref="" head_ref="" list_only="" use_dev="" smoke=""
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
    --timeout) timeout=${2:?--timeout needs seconds}; shift 2 ;;
    --timeout=*) timeout=${1#*=}; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) die "unknown option $1 (pnpm prd browser --help)" ;;
    *) check=$1; shift; args=("$@"); break ;;
  esac
done
[[ -z $timeout || $timeout =~ ^[0-9]+$ ]] || die "--timeout takes whole seconds"
[[ $mode != one || -n $check ]] || { usage >&2; exit 1; }

top=$(git rev-parse --show-toplevel 2>/dev/null) || die "run pnpm prd browser inside the repo or a .loops worktree"
here=$(basename "$top"); [[ $top == "$main" ]] && here=main
checks_dir=$top/scripts/browser-checks
logdir=$(git -C "$top" rev-parse --absolute-git-dir)/caretook-browser
mkdir -p "$logdir"

# resolve_check X → the check's absolute path (phase2, phase2.mjs, or a path).
resolve_check() {
  local x=$1
  if [[ $x == */* ]]; then
    [[ -f $x ]] || return 1
    (cd "$(dirname "$x")" && echo "$PWD/$(basename "$x")")
  else
    x=${x%.mjs}.mjs
    [[ -f $checks_dir/$x ]] || return 1
    echo "$checks_dir/$x"
  fi
}

# kill_tree PID SIGNAL → signal PID and every process below it (node, Chrome, proxies).
kill_tree() {
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c" "$2"; done
  kill "-$2" "$1" 2>/dev/null || true
}

lease="" child="" watchdog=""
cleanup() {
  [[ -n $watchdog ]] && kill_tree "$watchdog" TERM
  [[ -n $child ]] && kill -0 "$child" 2>/dev/null && kill_tree "$child" TERM
  if [[ -n $lease && $(browser_lease_field "$lease" pid) == "$$" ]]; then
    rm -rf "$lease"
    echo "Released browser lease $(basename "$lease")."
  fi
}
trap cleanup EXIT
trap 'echo; echo "Interrupted."; exit 130' INT
trap 'exit 143' TERM

# write_lease LABEL → (re)write our lease's name file atomically.
write_lease() {
  printf 'worktree=%s\ncheck=%s\npid=%s\nstarted=%s\n' "$here" "$1" "$$" "${lease_started:-$(date +%s)}" \
    > "$lease/name.tmp"
  mv "$lease/name.tmp" "$lease/name"
}

# take_over N → remove lease N if its holder is gone (under a short mutex, so two
# waiters can't both remove it and one of them delete a fresh lease).
take_over() {
  local d=$browser_leases/$1 mutex=$browser_leases/.takeover
  if ! mkdir "$mutex" 2>/dev/null; then
    (($(date +%s) - $(stat -f %m "$mutex" 2>/dev/null || date +%s) > 30)) && rmdir "$mutex" 2>/dev/null
    return 0
  fi
  if [[ -d $d ]] && ! browser_lease_alive "$d"; then
    echo "Taking over stale browser lease $1: $(browser_lease_line "$d") isn't running."
    rm -rf "$d"
  fi
  rmdir "$mutex"
}

# acquire LABEL → hold a lease, waiting while all are taken.
acquire() {
  local n free waited=0 announced=""
  mkdir -p "$browser_leases"
  while :; do
    for n in $(seq 1 "$browser_slots"); do
      if mkdir "$browser_leases/$n" 2>/dev/null; then
        lease=$browser_leases/$n lease_started=$(date +%s)
        write_lease "$1"
        echo "Took browser lease $n of $browser_slots$([[ -n $announced ]] && echo " after waiting $(fmt_secs "$waited")")."
        return 0
      fi
    done
    for n in $(seq 1 "$browser_slots"); do
      browser_lease_alive "$browser_leases/$n" || take_over "$n"
    done
    free=""
    for n in $(seq 1 "$browser_slots"); do [[ -d $browser_leases/$n ]] || free=1; done
    [[ -n $free ]] && continue # one was just freed: take it at once
    if [[ -z $announced ]]; then
      echo "All $browser_slots browser leases are taken; waiting (up to $(fmt_secs "$wait_max")):"
      for n in $(seq 1 "$browser_slots"); do echo "  lease $n: $(browser_lease_line "$browser_leases/$n")"; done
      announced=1
    fi
    if ((waited >= wait_max)); then
      echo "Gave up after $(fmt_secs "$waited") waiting for a browser lease (CARETOOK_BROWSER_WAIT=$wait_max). Holders:" >&2
      for n in $(seq 1 "$browser_slots"); do echo "  lease $n: $(browser_lease_line "$browser_leases/$n")" >&2; done
      exit 75
    fi
    sleep "$poll"; waited=$((waited + poll))
  done
}

# Node 24 from .nvmrc, and the worktree's ports.
cd "$top"
use_node || true
want=$(cat .nvmrc 2>/dev/null || echo 24)
if [[ $(node -v 2>/dev/null) != v${want%%.*}* ]]; then
  PATH=${NVM_DIR:-$HOME/.nvm}/versions/node/v${want#v}/bin:$PATH
fi
[[ $(node -v 2>/dev/null) == v${want%%.*}* ]] || die "need Node ${want%%.*} (from .nvmrc); got $(node -v 2>/dev/null || echo none)"
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
  local serve newer
  serve=$(dirname "$0")/serve.sh
  if [[ -n $use_dev ]]; then
    "$serve" "$here" --dev
    return
  fi
  if [[ $(cat "$top/.serve-mode" 2>/dev/null) == built && -n $(server_pids "$(web_port "$top")") ]]; then
    newer=$(cd "$top" && find apps/web/app apps/web/public apps/web/vite.config.ts apps/web/react-router.config.ts \
      apps/web/build-target.ts apps/web/package.json apps/web/.env packages/*/src packages/*/package.json \
      pnpm-lock.yaml -type f ! -name '*.test.ts' -newer .serve-built 2>/dev/null | head -1)
    if [[ -z $newer && -f $top/.serve-built ]]; then
      "$serve" "$here" --built
      return
    fi
    echo "The check build is older than the source (${newer:-no build yet}): rebuilding."
    "$serve" "$here" --restart --built
    return
  fi
  echo "Checks run against a check build (pnpm prd browser --dev for the dev server)."
  "$serve" "$here" --built
}

# run_once FILE [args…] → runs it; sets verdict (pass, FAIL, TIMEOUT, ended),
# rc, elapsed and log.
run_once() {
  local file=$1 base t start load0 marker finished hang="" tally tee_pid
  shift
  base=$(basename "$file")
  t=$timeout
  [[ -z $t && $hangs == *" $base "* ]] && t=$hang_timeout
  log=$logdir/${base%.mjs}-$(date +%Y%m%d-%H%M%S).log
  [[ -e $log ]] && log=${log%.log}-retry.log
  marker=$log.timedout finished=$log.finished
  [[ $hangs == *" $base "* ]] && hang=1
  start=$(date +%s) load0=$(load_avg)
  echo "▶ $base in $here · lease $(basename "$lease")/$browser_slots · $(date +%H:%M:%S) · load $load0 · BASE ${BASE:-(default)}$([[ -n $t ]] && echo " · timeout ${t}s")$([[ -n $smoke ]] && echo " · smoke")"
  cd "$checks_dir"
  exec 3> >(tee "$log")
  tee_pid=$!
  node "$file" "$@" >&3 2>&1 &
  child=$!
  if [[ -n $t || -n $hang ]]; then
    # One watcher: stop a never-exiting check once its last line is out, and any
    # check at its timeout.
    (
      while kill -0 "$child" 2>/dev/null; do
        if [[ -n $hang ]] && grep -Eq "$hang_done" "$log" 2>/dev/null; then
          sleep "$hang_grace"; touch "$finished"; break
        fi
        if [[ -n $t ]] && (($(date +%s) - start >= t)); then touch "$marker"; break; fi
        sleep 1
      done
      kill -0 "$child" 2>/dev/null || exit 0
      kill_tree "$child" TERM; sleep 5; kill_tree "$child" KILL
    ) &
    watchdog=$!
  fi
  rc=0
  wait "$child" || rc=$?
  child=""
  [[ -n $watchdog ]] && { kill_tree "$watchdog" TERM; wait "$watchdog" 2>/dev/null || true; watchdog=""; }
  exec 3>&-
  wait "$tee_pid" 2>/dev/null || true
  cd "$top"
  elapsed=$(($(date +%s) - start))
  if [[ -f $finished ]]; then
    rm -f "$finished" "$marker"
    tally=$(grep -Eo '^[0-9]+/[0-9]+ passed' "$log" | tail -1 || true)
    if [[ -z $tally ]]; then verdict=ended rc=0
    elif [[ ${tally%%/*} == "$(echo "$tally" | sed -E 's#^[0-9]+/([0-9]+).*#\1#')" ]]; then verdict=pass rc=0
    else verdict=FAIL rc=1
    fi
    echo "(stopped ${hang_grace}s after its last line, as expected for $base${tally:+: $tally})"
  elif [[ -f $marker ]]; then
    # A never-exiting check that gets here never printed its last line either.
    rm -f "$marker"
    verdict=TIMEOUT rc=124
    echo "(killed at its ${t}s timeout$([[ -n $hang ]] && echo " before its last line"))"
  elif ((rc == 0)); then verdict=pass
  else verdict=FAIL
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
  grep -Eq "$transient" "$log" 2>/dev/null
}

# run_check FILE [args…] → run_once, and once more if it failed on contention.
run_check() {
  local file=$1 first_log first_elapsed waited=0 why
  run_once "$@"
  [[ $verdict == pass || $verdict == ended ]] && return 0
  ((retry)) || return 0
  looks_transient || { echo "(not retried: the failure doesn't look like contention)"; return 0; }
  first_log=$log first_elapsed=$elapsed
  why="load $(load1 "$load_start")→$(load1 "$load_end")"
  grep -Eq "$transient" "$first_log" 2>/dev/null && why+=", $(grep -Eo "$transient" "$first_log" | head -1 | xargs)"
  while (($(load1 "$(load_avg)") > busy && waited < 300)); do
    ((waited == 0)) && echo "Waiting for the load ($(load_avg)) to drop below $busy before retrying…"
    sleep 15; waited=$((waited + 15))
  done
  sleep "$pause"
  echo "↻ retrying $(basename "$file") once ($why)"
  run_once "$@"
  elapsed=$((elapsed + first_elapsed))
  if [[ $verdict == pass || $verdict == ended ]]; then
    verdict=FLAKY rc=0
    printf '%s\t%s\t%s\t%s\t%s\n' "$(date '+%Y-%m-%d %H:%M')" "$here" "$(basename "$file")" "$why" "$first_log" \
      >> "$loops/.browser-flakes.log"
    echo "■ $(basename "$file"): FLAKY (failed, then passed on the retry; recorded in .loops/.browser-flakes.log)"
  fi
}

if [[ $mode == one ]]; then
  file=$(resolve_check "$check") || die "no check $check in $checks_dir"
  ensure_server
  acquire "$(basename "$file")"
  run_check "$file" "${args[@]}"
  exit "$rc"
fi

# --changed: the checks the changed files need, from scripts/loops/check-areas.
areas=$top/scripts/loops/check-areas

# checks_for FILE → its checks (space separated), "-" for none, or "@suite".
checks_for() {
  local f=$1 glob rest stem
  while read -r glob rest; do
    [[ -z $glob || $glob == \#* ]] && continue
    # shellcheck disable=SC2053 # the glob is meant to match as a pattern
    if [[ $f == $glob ]]; then
      if [[ $rest == @self ]]; then
        stem=$(basename "$f"); stem=${stem%.mjs}
        [[ $f == *.mjs ]] && echo "$stem" || echo "-"
      else echo "$rest"
      fi
      return
    fi
  done < "$areas"
  if [[ $f == apps/web/app/lib/* && $f != apps/web/app/lib/sync/* && $f =~ \.tsx?$ ]]; then
    stem=${f%.*}
    [[ -f $top/$stem.test.ts ]] && { echo "- (unit-tested)"; return; }
  fi
  echo "UNMAPPED $unmapped_default"
}

if [[ $mode == changed ]]; then
  [[ -f $areas ]] || die "no $areas"
  if [[ -z $base_ref ]]; then
    for r in "${BASE_BRANCH:-}" origin/dev dev; do
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
  selected=() full="" unmapped=()
  echo "Changed since $base_ref ($(git rev-parse --short "$mb")): $(grep -c . <<< "$files" || true) file(s)"
  while read -r f; do
    [[ -z $f ]] && continue
    c=$(checks_for "$f")
    [[ -n $list_only ]] && printf '  %-60s %s\n' "$f" "$c"
    case $c in
      @suite) full=1 ;;
      -*) ;;
      UNMAPPED*) unmapped+=("$f"); read -r -a more <<< "${c#UNMAPPED }"; selected+=("${more[@]}") ;;
      *) read -r -a more <<< "$c"; selected+=("${more[@]}") ;;
    esac
  done <<< "$files"
  ((${#unmapped[@]})) && {
    echo "No rule in scripts/loops/check-areas for: ${unmapped[*]}"
    echo "  (running $unmapped_default for them; add a rule)"
  }
  if [[ -n $full ]]; then
    read -r -a suite <<< "${CARETOOK_BROWSER_SUITE:-$suite_default}"
    echo "A change needs every check (build, config, dependencies, sync rules or migrations)."
  else
    # Keep the suite's order, then anything else (ui, marketing, a new check).
    suite=()
    for c in $suite_default; do [[ " ${selected[*]:-} " == *" $c "* ]] && suite+=("$c"); done
    for c in "${selected[@]:-}"; do [[ -n $c && " ${suite[*]:-} " != *" $c "* ]] && suite+=("$c"); done
  fi
  # A check that doesn't exist in this tree (marketing.mjs before it lands) is skipped.
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

# Both: one lease for the whole run, one check at a time, every check runs.
suite=("${suite[@]//,/ }")
read -r -a suite <<< "${suite[*]}"
ensure_server
acquire "$mode"
rows=() failed=0 i=0 suite_start=$(date +%s)
echo "Running ${#suite[@]} checks: ${suite[*]}"
for c in "${suite[@]}"; do
  i=$((i + 1))
  if ! file=$(resolve_check "$c"); then
    rows+=("$(printf '%-24s %-8s %s' "$c" MISSING "-")"); failed=$((failed + 1)); continue
  fi
  ((i > 1)) && sleep "$pause"
  write_lease "$mode $i/${#suite[@]}: $(basename "$file")"
  run_check "$file"
  [[ $verdict == pass || $verdict == ended || $verdict == FLAKY ]] || failed=$((failed + 1))
  rows+=("$(printf '%-24s %-8s %s' "$(basename "$file")" "$verdict" "$(fmt_secs "$elapsed")")")
done
echo
echo "Browser $([[ $mode == changed ]] && echo "checks for the changes" || echo suite)$([[ -n $smoke ]] && echo " (smoke)") in $here: $((${#suite[@]} - failed))/${#suite[@]} passed in $(fmt_secs $(($(date +%s) - suite_start))) · load now $(load_avg)"
printf '%-24s %-8s %s\n' CHECK RESULT TIME
printf '%s\n' "${rows[@]}"
[[ "${rows[*]}" == *" ended "* ]] && echo "(ended: a never-exiting check stopped without a tally; read its log in $logdir)"
((failed == 0))
