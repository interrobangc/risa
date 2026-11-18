#!/usr/bin/env bash
# pnpm prd browser: run browser checks from the current worktree, at most two at
# once machine-wide, so loops don't pile Chrome, Vite and PowerSync on top of
# each other.
#
#   browser.sh [--timeout S] <check> [args…]   one check (phase2, phase2.mjs, or a path)
#   browser.sh --suite [--timeout S]           every check in $suite, one at a time, then a table
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
# never exit on their own ($hangs) get 300 s by default; when they hit it, the
# verdict comes from their "N/M passed" line, or "ended" when they print none.
#
# Env: CARETOOK_BROWSER_SLOTS (leases, default 2), CARETOOK_BROWSER_WAIT (s),
# CARETOOK_BROWSER_SUITE (the suite, space or comma separated),
# CARETOOK_BROWSER_PAUSE (s between suite checks, default 10: Better Auth allows
# about 3 sign-ins per 10 s).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

# The full suite: every check in AGENTS.md's Browser check budget table.
suite_default="phase2 roundtrip live-notes app-shell routing settings-layout layout-offline sign-in first-sync signout-wipe providers"
hangs=" signout-wipe.mjs layout-offline.mjs "
hang_timeout=300
wait_max=${CARETOOK_BROWSER_WAIT:-1200}
poll=${CARETOOK_BROWSER_POLL:-5}
pause=${CARETOOK_BROWSER_PAUSE:-10}

usage() { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; }

mode=one timeout="" check="" args=()
while (($#)); do
  case $1 in
    --suite) mode=suite; shift ;;
    --timeout) timeout=${2:?--timeout needs seconds}; shift 2 ;;
    --timeout=*) timeout=${1#*=}; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) die "unknown option $1 (pnpm prd browser --help)" ;;
    *) check=$1; shift; args=("$@"); break ;;
  esac
done
[[ -z $timeout || $timeout =~ ^[0-9]+$ ]] || die "--timeout takes whole seconds"
[[ $mode == suite || -n $check ]] || { usage >&2; exit 1; }

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

# run_check FILE [args…] → runs it; sets verdict (pass, FAIL, TIMEOUT, ended),
# rc and elapsed.
run_check() {
  local file=$1 base t start load0 log marker tally tee_pid
  shift
  base=$(basename "$file")
  t=$timeout
  [[ -z $t && $hangs == *" $base "* ]] && t=$hang_timeout
  log=$logdir/${base%.mjs}-$(date +%Y%m%d-%H%M%S).log
  marker=$log.timedout
  start=$(date +%s) load0=$(load_avg)
  echo "▶ $base in $here · lease $(basename "$lease")/$browser_slots · $(date +%H:%M:%S) · load $load0 · BASE ${BASE:-(default)}$([[ -n $t ]] && echo " · timeout ${t}s")"
  cd "$checks_dir"
  exec 3> >(tee "$log")
  tee_pid=$!
  node "$file" "$@" >&3 2>&1 &
  child=$!
  if [[ -n $t ]]; then
    (sleep "$t" && touch "$marker" && kill_tree "$child" TERM && sleep 5 && kill_tree "$child" KILL) &
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
  if [[ -f $marker ]]; then
    rm -f "$marker"
    tally=$(grep -Eo '^[0-9]+/[0-9]+ passed' "$log" | tail -1 || true)
    if [[ $hangs == *" $base "* ]]; then
      if [[ -z $tally ]]; then verdict=ended rc=0
      elif [[ ${tally%%/*} == "$(echo "$tally" | sed -E 's#^[0-9]+/([0-9]+).*#\1#')" ]]; then verdict=pass rc=0
      else verdict=FAIL rc=1
      fi
      echo "(stopped at its ${t}s timeout, as expected for $base${tally:+: $tally})"
    else
      verdict=TIMEOUT rc=124
      echo "(killed at its ${t}s timeout)"
    fi
  elif ((rc == 0)); then verdict=pass
  else verdict=FAIL
  fi
  echo "■ $base: $verdict (exit $rc) in $(fmt_secs "$elapsed") · load at start $load0, at end $(load_avg) · log $log"
}

if [[ $mode == one ]]; then
  file=$(resolve_check "$check") || die "no check $check in $checks_dir"
  acquire "$(basename "$file")"
  run_check "$file" "${args[@]}"
  exit "$rc"
fi

# --suite: one lease for the whole run, one check at a time, every check runs.
read -r -a suite <<< "${CARETOOK_BROWSER_SUITE:-$suite_default}"
suite=("${suite[@]//,/ }")
read -r -a suite <<< "${suite[*]}"
acquire "suite"
rows=() failed=0 i=0 suite_start=$(date +%s)
echo "Running ${#suite[@]} checks: ${suite[*]}"
for c in "${suite[@]}"; do
  i=$((i + 1))
  if ! file=$(resolve_check "$c"); then
    rows+=("$(printf '%-24s %-8s %s' "$c" MISSING "-")"); failed=$((failed + 1)); continue
  fi
  ((i > 1)) && sleep "$pause"
  write_lease "suite $i/${#suite[@]}: $(basename "$file")"
  run_check "$file"
  [[ $verdict == pass || $verdict == ended ]] || failed=$((failed + 1))
  rows+=("$(printf '%-24s %-8s %s' "$(basename "$file")" "$verdict" "$(fmt_secs "$elapsed")")")
done
echo
echo "Browser suite in $here: $((${#suite[@]} - failed))/${#suite[@]} passed in $(fmt_secs $(($(date +%s) - suite_start))) · load now $(load_avg)"
printf '%-24s %-8s %s\n' CHECK RESULT TIME
printf '%s\n' "${rows[@]}"
echo "(ended: stopped at its timeout without printing a tally; read its log in $logdir)"
((failed == 0))
