#!/usr/bin/env bash
# Machine-wide leases: at most N holders of a kind at once, across every worktree.
#
#   lease.sh take <kind> [--wait S] [--label L] [--pid P]   take one for process P (default: the caller),
#                                                           print its directory, and exit
#   lease.sh release <kind> [N] [--pid P]                   release lease N, or every one P holds
#   lease.sh run <kind> [--wait S] [--label L] -- cmd…      hold one while cmd runs; exits with its code
#   lease.sh hold <kind> [--wait S] [--label L] [--watch P] hold one until stdin closes, P exits, or a
#                                                           TERM/INT; prints "lease <N> <dir>" once held
#   lease.sh holders [kind…]                                who holds what (default: browser, check, and
#                                                           any other kind in use)
#   lease.sh wait <kind> [--worktree W] [--timeout S]       block until no live holder or waiter of the
#                                                           kind is worktree W's (default: this one);
#                                                           exit 75 after S seconds (default 3600)
#
# Kinds and their limits: browser (CARETOOK_BROWSER_SLOTS, default 2), check
# (CARETOOK_CHECK_SLOTS, default 2), anything else (CARETOOK_<KIND>_SLOTS,
# default 1). The wait is --wait S, else CARETOOK_<KIND>_WAIT, else 1200 s
# (check: 1800 s); giving up exits 75. Waiters poll every CARETOOK_<KIND>_POLL
# (else CARETOOK_LEASE_POLL, else 5) seconds.
#
# A lease is the directory <dir>/<N> (mkdir is the atomic take), holding a
# `name` file of key=value lines: kind, worktree, check (what the holder is
# doing), pid, cmd (a string the holder's command line contains, so a reused pid
# isn't mistaken for it) and started (epoch seconds). A lease whose holder is
# gone is taken over by the next waiter, under a short mutex (<dir>/.takeover).
# A taker waiting for a free lease leaves the same name file in
# <dir>/.waiting/<pid>/ while it waits, so `wait` sees a check still queued.
# Holders release on every exit (the library's callers trap EXIT; run and hold
# trap EXIT, TERM and INT, and a SIGKILLed holder is taken over).
#
# Where: the main checkout's .loops/.lease/<kind>/, browser included.
# CARETOOK_LEASE_ROOT moves every kind (tests use a temp dir);
# CARETOOK_BROWSER_LEASES moves the browser kind alone. CARETOOK_LEASES=off
# takes nothing (every take succeeds at once).
#
# The move: browser leases used to live in .loops/.browser/<N>, and a worktree
# that hasn't synced since still takes them there. While any live holder is
# left in that old directory (CARETOOK_BROWSER_OLD_LEASES moves it; with
# CARETOOK_LEASE_ROOT or CARETOOK_BROWSER_LEASES set there is none unless it's
# set), each one counts against the limit here, and `holders` lists them. An
# old browser.sh can't see the new directory, so the limit holds only once
# every worktree has run `pnpm prd sync`. Drop this once nothing uses the old path.
#
# Source it for the functions (browser.sh does): lease_take, lease_write,
# lease_release, lease_holders. Node callers in the core use lease.mjs
# (takeLease). A project's code runs `lease.sh hold` through the config's lease
# command (hooks.lease: `<command> <kind> [--wait S] [--label L] [--watch P]`,
# "lease <N> <dir>" once held, 75 on giving up): keep that CLI stable.

# shellcheck source=lib.sh
declare -F env_get >/dev/null || source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# The lease this process holds (lease_take sets them; lease_release clears them).
# Callers may set lease_worktree, lease_pid and lease_cmd before taking, and
# lease_say to a function for chatter (browser.sh: vsay).
lease_path="" lease_n="" lease_kind="" lease_started=""

lease_valid_kind() { [[ $1 =~ ^[a-z][a-z0-9-]*$ ]]; }

# lease_var KIND SUFFIX → CARETOOK_<KIND>_<SUFFIX>.
lease_var() { echo "CARETOOK_$(tr '[:lower:]-' '[:upper:]_' <<< "$1")_$2"; }

# lease_env KIND SUFFIX DEFAULT → that variable's value, or DEFAULT.
lease_env() {
  local v
  v=$(lease_var "$1" "$2")
  echo "${!v:-$3}"
}

lease_root() { echo "${CARETOOK_LEASE_ROOT:-$loops/.lease}"; }

# lease_dir KIND → the directory its leases live in.
lease_dir() {
  if [[ $1 == browser && -n ${CARETOOK_BROWSER_LEASES:-} ]]; then
    echo "$CARETOOK_BROWSER_LEASES"
  else
    echo "$(lease_root)/$1"
  fi
}

# lease_old_dir KIND → the browser kind's old directory (.loops/.browser), whose
# live holders still count (see the top); nothing for other kinds, or when the
# leases were moved (tests) and CARETOOK_BROWSER_OLD_LEASES isn't set.
lease_old_dir() {
  [[ $1 == browser ]] || return 0
  if [[ -n ${CARETOOK_BROWSER_OLD_LEASES:-} ]]; then
    echo "$CARETOOK_BROWSER_OLD_LEASES"
  elif [[ -z ${CARETOOK_LEASE_ROOT:-}${CARETOOK_BROWSER_LEASES:-} ]]; then
    echo "$loops/.browser"
  fi
}

# lease_old_live KIND → how many live holders the old directory has.
lease_old_live() {
  local dir d count=0
  dir=$(lease_old_dir "$1")
  [[ -n $dir && -d $dir ]] || { echo 0; return 0; }
  for d in "$dir"/*/; do
    [[ -d $d && $(basename "$d") =~ ^[0-9]+$ ]] || continue
    lease_alive "${d%/}" "$1" && count=$((count + 1))
  done
  echo "$count"
}

# lease_held KIND → how many lease directories the kind has (live or not).
lease_held() {
  local d count=0
  for d in "$(lease_dir "$1")"/*/; do
    [[ -d $d && $(basename "$d") =~ ^[0-9]+$ ]] && count=$((count + 1))
  done
  echo "$count"
}

lease_slots() {
  local d=1
  case $1 in browser) d=2 ;; check) d=2 ;; esac
  lease_env "$1" SLOTS "$d"
}
lease_wait_max() {
  local d=1200
  [[ $1 == check ]] && d=1800
  lease_env "$1" WAIT "$d"
}
lease_poll() { lease_env "$1" POLL "${CARETOOK_LEASE_POLL:-5}"; }

# lease_here → the worktree's name (main for the main checkout).
lease_here() {
  local top
  top=$(git rev-parse --show-toplevel 2>/dev/null) || { basename "$PWD"; return 0; }
  if [[ $top == "$main" ]]; then echo main; else basename "$top"; fi
}

lease_field() { env_get "$1/name" "$2"; }

# lease_mtime PATH → its modification time (epoch seconds), or 0.
lease_mtime() { file_mtime "$1" || echo 0; }

# lease_alive DIR [KIND] → true while the lease's holder is running. A lease
# with no name file yet is being taken (alive) unless it's over a minute old.
lease_alive() {
  local pid cmd
  if [[ ! -f $1/name ]]; then
    [[ -d $1 ]] || return 1
    (($(date +%s) - $(lease_mtime "$1") < 60))
    return
  fi
  pid=$(lease_field "$1" pid)
  [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null || return 1
  cmd=$(lease_field "$1" cmd)
  [[ -z $cmd ]] || ps -p "$pid" -o command= 2>/dev/null | grep -qF -- "$cmd"
}

# lease_line DIR → "worktree: what (pid P, 3m12s)" for messages.
lease_line() {
  local started
  [[ -f $1/name ]] || { echo "(being taken)"; return 0; }
  started=$(lease_field "$1" started)
  printf '%s: %s (pid %s, %s)' "$(lease_field "$1" worktree)" "$(lease_field "$1" check)" \
    "$(lease_field "$1" pid)" "$(fmt_secs $(($(date +%s) - ${started:-$(date +%s)})))"
}

# lease_list KIND → one line per held lease of KIND: "  lease N: …".
lease_list() {
  local dir n d
  dir=$(lease_dir "$1")
  for n in $(seq 1 "$(lease_slots "$1")"); do
    d=$dir/$n
    [[ -d $d ]] || continue
    if lease_alive "$d" "$1"; then
      echo "  lease $n: $(lease_line "$d")"
    else
      echo "  lease $n: stale, $(lease_line "$d") isn't running (the next taker takes it over)"
    fi
  done
}

# lease_list_old KIND → the old directory's live holders (see the top), if any.
lease_list_old() {
  local dir d
  dir=$(lease_old_dir "$1")
  [[ -n $dir && -d $dir ]] || return 0
  for d in "$dir"/*/; do
    [[ -d $d && $(basename "$d") =~ ^[0-9]+$ ]] || continue
    d=${d%/}
    lease_alive "$d" "$1" &&
      echo "  old path ($dir/$(basename "$d")): $(lease_line "$d"), counted until that worktree syncs"
  done
  return 0
}

# lease_holders [KIND…] → each kind's count, then its held leases.
lease_holders() {
  local kinds=("$@") kind d k held
  if ((${#kinds[@]} == 0)); then
    kinds=(browser check)
    for d in "$(lease_root)"/*/; do
      [[ -d $d ]] || continue
      k=$(basename "$d")
      lease_valid_kind "$k" && [[ " ${kinds[*]} " != *" $k "* ]] && kinds+=("$k")
    done
  fi
  for kind in "${kinds[@]}"; do
    held=0
    for d in "$(lease_dir "$kind")"/*/; do
      [[ -d $d && $(basename "$d") =~ ^[0-9]+$ ]] && held=$((held + 1))
    done
    echo "$kind leases: $held of $(lease_slots "$kind") held"
    lease_list "$kind"
    lease_list_old "$kind"
  done
}

# lease_write LABEL → (re)write our lease's name file atomically, each writer
# through its own temp file (name.tmp.<pid>). The first write links it in as
# `name`, which fails when another taker's name is already there; a rewrite
# renames it over a name that records our pid, and only then. On CI two takers
# once shared one slot (B-867): a takeover's rm -rf hit a lease made just after
# the stale one went, a second taker made the slot again, and both wrote the
# one name.tmp. So a writer that finds the slot gone or recorded as another's
# drops it (lease_path cleared, the directory left to its holder) and returns 1,
# and the taker carries on as if the slot were taken.
lease_write() {
  [[ -n $lease_path ]] || return 0
  local p=$lease_path me=${lease_pid:-$$} tmp ok=""
  tmp=$p/name.tmp.${BASHPID:-$$}
  [[ -z ${CARETOOK_LEASE_TEST_WRITE_PAUSE:-} ]] || lease_test_write_pause "$CARETOOK_LEASE_TEST_WRITE_PAUSE"
  if printf 'kind=%s\nworktree=%s\ncheck=%s\npid=%s\ncmd=%s\nstarted=%s\n' "$lease_kind" \
    "${lease_worktree:-$(lease_here)}" "${1//$'\n'/ }" "$me" "${lease_cmd-$(basename "$0")}" \
    "${lease_started:-$(date +%s)}" 2>/dev/null > "$tmp"; then
    if [[ ! -f $p/name ]]; then
      ln "$tmp" "$p/name" 2>/dev/null && ok=1
    elif [[ $(lease_field "$p" pid) == "$me" ]]; then
      mv -f "$tmp" "$p/name" 2>/dev/null && ok=1
    fi
  fi
  rm -f "$tmp" 2>/dev/null
  [[ -n $ok && $(lease_field "$p" pid 2>/dev/null) == "$me" ]] && return 0
  ${lease_say:-:} "Lost $lease_kind lease $lease_n to another taker; trying again."
  lease_path="" lease_n=""
  return 1
}

# lease_test_write_pause MARKER → (tests only) touch MARKER, then wait before
# writing the name file until MARKER.go exists (or 30 s pass).
lease_test_write_pause() {
  local i
  : > "$1"
  for ((i = 0; i < 300; i++)); do
    [[ ! -e $1.go ]] || return 0
    sleep 0.1
  done
}

# lease_claim KIND DIR N → make lease DIR/N (mkdir is the atomic take) and
# record it as ours (lease_path and the rest), with TERM and INT held off
# between the two: a signal in that window used to leave the directory behind,
# since the caller's trap releases only $lease_path (B-742). A signal that came
# meanwhile is raised again once the caller's traps are back, so they run as
# they would have, now with the lease to release.
lease_deferred=""
lease_claim() {
  local saved rc=1
  saved=$(trap -p TERM INT)
  lease_deferred=""
  trap 'lease_deferred=TERM' TERM
  trap 'lease_deferred=INT' INT
  if mkdir "$2/$3" 2>/dev/null; then
    [[ -z ${CARETOOK_LEASE_TEST_PAUSE:-} ]] || lease_test_pause "$CARETOOK_LEASE_TEST_PAUSE"
    lease_kind=$1 lease_path=$2/$3 lease_n=$3 lease_started=$(date +%s)
    rc=0
  fi
  trap - TERM INT
  eval "$saved"
  if [[ -n $lease_deferred ]]; then kill -s "$lease_deferred" "${BASHPID:-$$}"; fi
  return "$rc"
}

# lease_test_pause MARKER → (tests only) touch MARKER, then wait in the claim's
# window until a signal comes (or 30 s pass).
lease_test_pause() {
  local i
  : > "$1"
  for ((i = 0; i < 300; i++)); do
    [[ -z $lease_deferred ]] || return 0
    sleep 0.1
  done
}

# lease_take_over KIND N → remove lease N if its holder is gone (under a short
# mutex, so two waiters can't both remove it and one of them delete a fresh lease).
lease_take_over() {
  local dir d mutex
  dir=$(lease_dir "$1") d=$dir/$2 mutex=$dir/.takeover
  if ! mkdir "$mutex" 2>/dev/null; then
    (($(date +%s) - $(lease_mtime "$mutex") > 30)) && rmdir "$mutex" 2>/dev/null
    return 0
  fi
  # The second test: a lease released while lease_alive read it is gone, not
  # stale, and the directory there now may be a new taker's (B-867).
  if [[ -d $d ]] && ! lease_alive "$d" "$1" && [[ -d $d ]]; then
    echo "Taking over stale $1 lease $2: $(lease_line "$d") isn't running." >&2
    rm -rf "$d"
  fi
  rmdir "$mutex"
}

# lease_take_counted KIND LABEL SLOTS OLD → take a free lease while fewer than
# SLOTS are held here plus OLD under the old path, under the kind's take mutex.
lease_take_counted() {
  local dir mutex n rc=1
  dir=$(lease_dir "$1") mutex=$(lease_dir "$1")/.take
  if ! mkdir "$mutex" 2>/dev/null; then
    (($(date +%s) - $(lease_mtime "$mutex") > 30)) && rmdir "$mutex" 2>/dev/null
    return 1
  fi
  if (($(lease_held "$1") + $4 < $3)); then
    for n in $(seq 1 "$3"); do
      if lease_claim "$1" "$dir" "$n" && lease_write "$2"; then
        ${lease_say:-:} "Took $1 lease $n of $3 ($4 more under the old path)."
        rc=0
        break
      fi
    done
  fi
  rmdir "$mutex" 2>/dev/null
  return "$rc"
}

# lease_waiting_mark KIND LABEL → record this taker under <dir>/.waiting/<pid>
# while it waits (lease_waiting_clear drops it; a killed waiter's is ignored
# once its pid is gone, and replaced when the pid is reused).
lease_waiting=""
lease_waiting_mark() {
  local d
  d=$(lease_dir "$1")/.waiting/${lease_pid:-$$}
  mkdir -p "$d" || return 0
  printf 'kind=%s\nworktree=%s\ncheck=%s\npid=%s\ncmd=%s\nstarted=%s\n' "$1" \
    "${lease_worktree:-$(lease_here)}" "${2//$'\n'/ } (waiting for a lease)" "${lease_pid:-$$}" \
    "${lease_cmd-$(basename "$0")}" "$(date +%s)" > "$d/name.tmp" && mv "$d/name.tmp" "$d/name"
  lease_waiting=$d
}
lease_waiting_clear() {
  [[ -n $lease_waiting ]] && rm -rf "$lease_waiting"
  lease_waiting=""
  return 0
}

# lease_mine KIND WORKTREE → the live holders and waiters of KIND that are
# WORKTREE's, one lease_line each (nothing when there are none).
lease_mine() {
  local dir d
  dir=$(lease_dir "$1")
  for d in "$dir"/*/ "$dir"/.waiting/*/; do
    d=${d%/}
    [[ -d $d && -f $d/name ]] || continue
    if ! lease_alive "$d" "$1"; then
      [[ $d == */.waiting/* ]] && rm -rf "$d" # a waiter that was killed
      continue
    fi
    [[ $(lease_field "$d" worktree) == "$2" ]] && echo "  $(lease_line "$d")"
  done
  return 0
}

# lease_wait KIND WORKTREE TIMEOUT → return once no live holder or waiter of
# KIND is WORKTREE's (0), or 75 after TIMEOUT seconds while one still is.
lease_wait() {
  local kind=$1 wt=$2 timeout=$3 poll waited=0 mine announced=""
  poll=$(lease_poll "$kind")
  while :; do
    mine=$(lease_mine "$kind" "$wt")
    if [[ -z $mine ]]; then
      if [[ -n $announced ]]; then echo "$wt's $kind is done (waited $(fmt_secs "$waited"))."
      else echo "$wt holds no $kind lease."; fi
      return 0
    fi
    if [[ -z $announced ]]; then
      echo "Waiting (up to $(fmt_secs "$timeout")) for $wt's $kind:"
      echo "$mine"
      announced=1
    fi
    if ((waited >= timeout)); then
      echo "Gave up after $(fmt_secs "$waited"): $wt's $kind is still running:" >&2
      echo "$mine" >&2
      return 75
    fi
    sleep "$poll"
    waited=$((waited + poll))
  done
}

# lease_take KIND LABEL [WAIT] → hold a lease of KIND, waiting while all are
# taken (up to WAIT seconds, else the kind's default). Returns 75 on giving up.
# The caller releases it (lease_release, from an EXIT trap).
lease_take() {
  local kind=$1 label=$2 wait_max=${3:-} dir slots poll n free old waited=0 announced=""
  lease_valid_kind "$kind" || { echo "lease: not a kind: $kind" >&2; return 64; }
  if [[ ${CARETOOK_LEASES:-} == off ]]; then
    lease_kind=$kind lease_path="" lease_n=0
    return 0
  fi
  dir=$(lease_dir "$kind") slots=$(lease_slots "$kind") poll=$(lease_poll "$kind")
  [[ -n $wait_max ]] || wait_max=$(lease_wait_max "$kind")
  mkdir -p "$dir"
  while :; do
    # Holders still under the old path (the move, see the top) count against
    # the limit; taking then goes under a short mutex, so two takers here can't
    # both fill the last free place.
    old=$(lease_old_live "$kind")
    if ((old > 0)); then
      if lease_take_counted "$kind" "$label" "$slots" "$old"; then
        lease_waiting_clear
        [[ -n $announced ]] && echo "Took $kind lease $lease_n of $slots after waiting $(fmt_secs "$waited")." >&2
        return 0
      fi
    fi
    ((old > 0)) || for n in $(seq 1 "$slots"); do # (with old holders, only the counted take)
      if lease_claim "$kind" "$dir" "$n" && lease_write "$label"; then
        lease_waiting_clear
        if [[ -n $announced ]]; then
          echo "Took $kind lease $n of $slots after waiting $(fmt_secs "$waited")." >&2
        else
          ${lease_say:-:} "Took $kind lease $n of $slots."
        fi
        return 0
      fi
    done
    for n in $(seq 1 "$slots"); do
      lease_alive "$dir/$n" "$kind" || lease_take_over "$kind" "$n"
    done
    free=""
    for n in $(seq 1 "$slots"); do [[ -d $dir/$n ]] || free=1; done
    if ((old > 0 && $(lease_held "$kind") + old >= slots)); then free=""; fi
    [[ -n $free ]] && continue # one was just freed: take it at once
    if [[ -z $announced ]]; then
      lease_waiting_mark "$kind" "$label"
      echo "All $slots $kind leases are taken; waiting (up to $(fmt_secs "$wait_max")):" >&2
      lease_list "$kind" >&2
      lease_list_old "$kind" >&2
      announced=1
    fi
    if ((waited >= wait_max)); then
      echo "Gave up after $(fmt_secs "$waited") waiting for a $kind lease (the limit: --wait, else $(lease_var "$kind" WAIT)). Holders:" >&2
      lease_list "$kind" >&2
      lease_waiting_clear
      return 75
    fi
    sleep "$poll"
    waited=$((waited + poll))
  done
}

# lease_release → drop the lease this process took, synchronously, unless it
# was taken over (its name file names another pid). A lease whose name file
# is missing is still ours: we made the directory and nobody else has written
# one since. Safe to call twice, from an EXIT trap, and under errexit.
lease_release() {
  local p=$lease_path n=$lease_n owner
  lease_waiting_clear
  [[ -n $p ]] || return 0
  lease_path="" lease_n=""
  owner=$(lease_field "$p" pid)
  if [[ -d $p && (-z $owner || $owner == "${lease_pid:-$$}") ]]; then
    rm -rf "$p" || rm -rf "$p" || true
    ${lease_say:-:} "Released $lease_kind lease $n."
  fi
  return 0
}

# lease_kill_tree PID → TERM PID and everything under it.
lease_kill_tree() {
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do lease_kill_tree "$c"; done
  kill -TERM "$1" 2>/dev/null || true
}

lease_usage() { sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

lease_main() {
  set -euo pipefail
  local cmd=${1:-help} kind="" wait="" label="" pid="" watch="" num="" child="" rc worktree="" timeout=3600
  (($#)) && shift
  case $cmd in
    take | release | run | hold | wait)
      kind=${1:-}
      lease_valid_kind "$kind" || die "lease $cmd: give a kind (browser, check, …)"
      shift
      ;;
  esac
  while (($#)); do
    case $1 in
      --wait) wait=${2:?--wait S}; shift 2 ;;
      --label) label=${2:?--label L}; shift 2 ;;
      --pid) pid=${2:?--pid P}; shift 2 ;;
      --watch) watch=${2:?--watch P}; shift 2 ;;
      --worktree) [[ $cmd == wait ]] || die "lease $cmd: unknown argument $1"; worktree=${2:?--worktree W}; shift 2 ;;
      --timeout) [[ $cmd == wait ]] || die "lease $cmd: unknown argument $1"; timeout=${2:?--timeout S}; shift 2 ;;
      --) shift; break ;;
      [0-9]*) [[ $cmd == release ]] || die "lease $cmd: unexpected $1"; num=$1; shift ;;
      *) [[ $cmd == holders ]] || die "lease $cmd: unknown argument $1"; break ;;
    esac
  done
  [[ -z $wait || $wait =~ ^[0-9]+$ ]] || die "lease: --wait takes whole seconds"
  [[ $timeout =~ ^[0-9]+$ ]] || die "lease: --timeout takes whole seconds"
  case $cmd in
    take)
      lease_pid=${pid:-$PPID}
      # A string from the holder's command (its program), so a reused pid isn't it.
      # From `command`, which lease_alive reads: Linux's `comm` is the main thread's
      # name, cut to 15 characters, and needn't appear in the command line.
      lease_cmd=$(ps -p "$lease_pid" -o command= 2>/dev/null | awk '{ print $1; exit }' || true)
      lease_cmd=${lease_cmd##*/}
      lease_take "$kind" "${label:-pid $lease_pid}" "$wait" || exit
      echo "$lease_path"
      ;;
    release)
      local dir n
      lease_pid=${pid:-$PPID} lease_kind=$kind
      dir=$(lease_dir "$kind")
      for n in ${num:-$(seq 1 "$(lease_slots "$kind")")}; do
        lease_path=$dir/$n lease_n=$n
        lease_release
      done
      ;;
    run)
      (($#)) || die "lease run: give a command after --"
      trap lease_release EXIT
      trap '[[ -n $child ]] && lease_kill_tree "$child"; exit 143' TERM
      trap '[[ -n $child ]] && lease_kill_tree "$child"; exit 130' INT
      lease_take "$kind" "${label:-$*}" "$wait" || exit
      "$@" <&0 &
      child=$!
      set +e
      wait "$child"
      rc=$?
      set -e
      child=""
      exit "$rc"
      ;;
    hold)
      trap lease_release EXIT
      trap 'exit 143' TERM
      trap 'exit 130' INT
      lease_take "$kind" "${label:-hold}" "$wait" || exit
      echo "lease $lease_n ${lease_path:-(off)}"
      while :; do
        if [[ -n $watch ]] && ! kill -0 "$watch" 2>/dev/null; then break; fi
        read -r -t 1 _ && continue
        rc=$?
        ((rc > 128)) || break # EOF: whoever started us is gone or done
      done
      ;;
    holders) lease_holders "$@" ;;
    wait)
      (($# == 0)) || die "lease wait: unexpected $1"
      lease_wait "$kind" "${worktree:-$(lease_here)}" "$timeout" || exit
      ;;
    help | -h | --help) lease_usage ;;
    *) lease_usage >&2; exit 64 ;;
  esac
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then lease_main "$@"; fi
