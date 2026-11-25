#!/usr/bin/env bash
# Bring the PRD machinery back after a restart, a crash or a usage limit.
# (pnpm prd recover)
#
#   recover.sh                    take the single-instance lock (.loops/.recover.lock:
#                                 a second recover exits 75 without acting), then
#                                 run the inventory's actions, in order:
#                                 1. start Docker Desktop (open -a Docker) and
#                                    wait for `docker info`
#                                 2. keep the dispatcher's intent to reopen
#                                    (.loops/.dispatch-intent.json) before its
#                                    stale lock goes; clear stale locks (never a
#                                    live one; the dispatcher's when its pid is
#                                    gone) and migrate markers with no worktree
#                                 3. the shared test Postgres (test-db.sh up)
#                                 4. stacks, one at a time: compose up, wait for
#                                    its Postgres, migrate (retried once), with a
#                                    marker in .loops/.migrate/ while it runs; a
#                                    marker left by a crash reruns the migrate
#                                 5. dev servers (serve.sh)
#                                 6. the dispatcher, in a background iTerm2 tab
#                                    (the opener), when it was running (the down
#                                    record, a stale lock or a kept intent says
#                                    so), only when every step above succeeded;
#                                    it waits for the new one to hold its lock
#                                    (CARETOOK_RECOVER_DISPATCH_SECS, 60) and only
#                                    then drops the intent
#                                 7. print the gc offers; delete the down
#                                    record once used
#                                 8. open the recovery agent in this terminal
#                                    (claude --remote-control recover, in the
#                                    main checkout; prompt.sh recover): it tells
#                                    live orchestrators and planners to carry on
#                                    and reopens dead ones (pnpm prd open),
#                                    leaving managed ones to the dispatcher
#   recover.sh --no-agent         steps 1-7 only: print the sessions instead
#   recover.sh --unattended       for a job with no terminal (the watchdog):
#                                 the recovery agent opens in a background tab,
#                                 and a failure files one report (pnpm prd ask
#                                 --report, topic recover; CARETOOK_RECOVER_REPORT=off
#                                 files none: the watchdog's later tries in one
#                                 incident). A stay-down mark (pnpm prd down
#                                 --stay) makes it do nothing
#   recover.sh --at HH:MM         sleep until then (tomorrow's when it has
#                                 passed), then recover: after a usage limit
#   recover.sh --wait             probe with `claude -p` every
#                                 CARETOOK_RECOVER_PROBE_SECS (600) until one
#                                 succeeds, then recover (after --at, if both)
#   recover.sh --dry-run          the inventory (every .loops worktree's class and
#                                 why, stale and live locks, Docker, the shared
#                                 test Postgres, disk, the down record) and the
#                                 actions recovery would take, in order; changes
#                                 nothing
#   recover.sh --dry-run --json   the same as JSON (for the recovery agent);
#                                 a dry run never launches anything
#
# inventory.mjs decides the classes and actions; inventory-facts.mjs collects
# the facts (read-only: git, docker info|ps|inspect, lsof, df). Every step is
# skipped when it's already done, so a recover after a good one only prints (and opens
# the recovery agent again). A recover by hand (not --unattended, not a dry run)
# deletes the stay-down mark (.loops/.stay-down.json): the machine comes back.
#
# Env: CARETOOK_DOCKER_WAIT_SECS (180), CARETOOK_RECOVER_PG_SECS (60),
# CARETOOK_RECOVER_DISPATCH_SECS (60: the wait for the reopened dispatcher's lock),
# CARETOOK_RECOVER_PROBE_SECS (600), CARETOOK_RECOVER_STEP_SECS (300: --at's
# longest sleep before it rechecks the clock); CARETOOK_CLOCK_FILE (tests: a
# file holding the current epoch second, in place of the clock).
set -euo pipefail
# shellcheck source=stack-lib.sh
source "$(dirname "$0")/stack-lib.sh"
bin=$(dirname "$0")

dry=0 format=--text at="" wait=0 agent=1 unattended=0
while (($#)); do
  case $1 in
    --dry-run | -n) dry=1 ;;
    --json) format=--json ;;
    --facts) format=--facts ;;
    --at) (($# > 1)) || die "recover: --at takes a time (HH:MM)"; at=$2; shift ;;
    --at=*) at=${1#--at=} ;;
    --wait) wait=1 ;;
    --no-agent) agent=0 ;;
    --unattended) unattended=1 ;;
    -h | --help) sed -n '2,67p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "recover: unknown option $1 (--dry-run, --json, --at HH:MM, --wait, --no-agent, --unattended)" ;;
  esac
  shift
done
[[ -z $at || $at =~ ^([01]?[0-9]|2[0-3]):[0-5][0-9]$ ]] || die "recover: --at takes a 24-hour time, HH:MM (got $at)"
((dry == 0)) || [[ -z $at && $wait == 0 ]] || die "recover: --dry-run doesn't wait; drop --at and --wait"

inventory() { node "$bin/inventory-facts.mjs" --main "$main" "$@"; }

lock=$loops/.recover.lock intent=$loops/.dispatch-intent.json
locked=0 busy=0 reason="" failed=()

# die: as lib.sh's, remembering why for the unattended report.
die() { echo "$*" >&2; reason=$*; exit 1; }

# take_lock → hold .loops/.recover.lock (a dead holder's is taken over); another
# live recover holding it: say so and exit 75, having done nothing.
take_lock() {
  local holder code=0
  mkdir -p "$loops"
  holder=$(node "$bin/recover-lib.mjs" lock "$lock" "$$") || code=$?
  if ((code == 75)); then
    echo "recover: another recover is running (pid ${holder:-?}): nothing done" >&2
    busy=1
    exit 75
  fi
  ((code == 0)) || die "recover: couldn't take its lock ($lock)"
  locked=1
}
release_lock() {
  ((locked)) || return 0
  [[ $(cat "$lock" 2>/dev/null) != "$$" ]] || rm -f "$lock"
  locked=0
}

# report TEXT → one report in the asks queue (unattended: nobody watches this
# terminal). Filing it failing is only a warning.
report() {
  [[ ${CARETOOK_RECOVER_REPORT:-on} != off ]] || { echo "recover: (not reported again this incident) $1" >&2; return 0; }
  CARETOOK_ASKS_DIR=${CARETOOK_ASKS_DIR:-$loops/.asks} node "$bin/ask.mjs" ask --topic recover --session recover \
    --report "$1" </dev/null >/dev/null 2>&1 || echo "recover: couldn't file the report: $1" >&2
}

on_exit() {
  local code=$?
  release_lock
  ((unattended && code != 0 && !busy)) || return 0
  local what=$reason
  if [[ -z $what ]]; then
    what=$(printf '%s, ' ${failed[@]+"${failed[@]}"}); what=${what%, }
    what="didn't recover: ${what:-exit $code}"
  fi
  report "pnpm prd recover --unattended stopped: ${what%.}. See pnpm prd recover --dry-run, fix it, then pnpm prd recover."
}

now_secs() {
  if [[ -n ${CARETOOK_CLOCK_FILE:-} ]]; then cat "$CARETOOK_CLOCK_FILE"; else date +%s; fi
}

# wait_until EPOCH → sleep in steps of at most CARETOOK_RECOVER_STEP_SECS until
# then (a laptop asleep doesn't count sleep(1) time, so it rechecks the clock).
# fmt_wait SECS → 3h05m, or 4m10s under an hour.
fmt_wait() { if (($1 >= 3600)); then printf '%dh%02dm' $(($1 / 3600)) $(($1 % 3600 / 60)); else fmt_secs "$1"; fi; }

wait_until() {
  local left step=${CARETOOK_RECOVER_STEP_SECS:-300}
  [[ $step =~ ^[0-9]+$ ]] && ((step > 0)) || die "recover: CARETOOK_RECOVER_STEP_SECS must be a whole number of seconds"
  while :; do
    left=$(($1 - $(now_secs)))
    ((left > 0)) || return 0
    sleep $((left < step ? left : step))
  done
}

wait_for_time() {
  local target left
  target=$(node "$bin/recover-lib.mjs" until "$1" "$(now_secs)")
  left=$((target - $(now_secs)))
  echo "Waiting until $1 (in $(fmt_wait "$left")), then recovering. Ctrl-C to stop."
  wait_until "$target"
}

# wait_for_claude → probe with a one-word headless prompt until one exits 0.
wait_for_claude() {
  local every=${CARETOOK_RECOVER_PROBE_SECS:-600} n=1
  [[ $every =~ ^[0-9]+$ ]] && ((every > 0)) || die "recover: CARETOOK_RECOVER_PROBE_SECS must be a whole number of seconds"
  echo "Waiting for Claude to answer (a claude -p probe every $(fmt_wait "$every")), then recovering. Ctrl-C to stop."
  until claude -p ok </dev/null >/dev/null 2>&1; do
    echo "  probe $n: no answer yet (usage limit?); next at $(date -r $(($(now_secs) + every)) +%H:%M 2>/dev/null || echo "+$(fmt_secs "$every")")"
    n=$((n + 1))
    sleep "$every"
  done
  echo "  probe $n: Claude answered."
}

# start_docker → open Docker Desktop and wait for `docker info`.
start_docker() {
  local limit=${CARETOOK_DOCKER_WAIT_SECS:-180} deadline
  echo "• Docker isn't running: starting Docker Desktop"
  open -a Docker </dev/null || die "recover: couldn't start Docker Desktop (open -a Docker); start Docker, then rerun"
  deadline=$(($(now_secs) + limit))
  until docker info >/dev/null 2>&1; do
    (($(now_secs) < deadline)) || die "recover: Docker didn't answer within ${limit}s; start it by hand, then rerun"
    sleep 2
  done
  echo "  Docker is up"
}

# clear_lock PATH → remove a stale lock the inventory named (only lock paths).
# The dispatcher's stays while its intent couldn't be kept: it's the only record.
clear_lock() {
  case $1 in
    "$loops"/.slots/* | "$loops"/.dispatch.lock | */caretook-backlog.lock | "$loops"/.migrate/*) ;;
    *) echo "  not a lock path, left alone: $1" >&2; return 1 ;;
  esac
  if [[ $1 == "$loops/.dispatch.lock" && ! -f $intent ]]; then
    echo "  kept the dispatcher's stale lock: its intent to reopen isn't kept" >&2
    return 1
  fi
  rm -rf "$1"
  echo "• cleared stale lock ${1#"$main"/}"
}

# keep_intent → write the dispatcher's intent to reopen, atomically.
keep_intent() {
  local at
  at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '{ "at": "%s", "why": "recover reopens the dispatcher" }\n' "$at" >"$intent.tmp" && mv "$intent.tmp" "$intent" ||
    { echo "  couldn't keep the dispatcher's intent ($intent)" >&2; return 1; }
}

# reopen_dispatcher → open it in a background tab, then wait until it holds its
# lock; only then drop the intent. Any failure keeps the intent for the next run.
reopen_dispatcher() {
  local limit=${CARETOOK_RECOVER_DISPATCH_SECS:-60} deadline pid
  echo "• the dispatcher (it was running)"
  "$bin/open-session.sh" --command "cd $(printf %q "$main") && scripts/loops/prd.sh dispatch" --title dispatch --background \
    </dev/null 2>&1 | sed 's/^/  /' || { echo "  couldn't open its tab; its intent is kept" >&2; return 1; }
  deadline=$(($(now_secs) + limit))
  until pid=$(dispatch_pid); do
    (($(now_secs) < deadline)) || { echo "  it didn't take its lock within ${limit}s; its intent is kept" >&2; return 1; }
    sleep 1
  done
  rm -f "$intent"
  echo "  running (pid $pid)"
}

# wait_for_pg DIR PROJECT → until the stack's Postgres accepts connections.
wait_for_pg() {
  local c deadline limit=${CARETOOK_RECOVER_PG_SECS:-60}
  c=$(env_get "$1/.env.loop" PG_CONTAINER); c=${c:-$2-postgres-1}
  deadline=$(($(now_secs) + limit))
  until docker exec "$c" pg_isready -q -h 127.0.0.1 -U caretook -d caretook >/dev/null 2>&1; do
    (($(now_secs) < deadline)) || { echo "  $c didn't accept connections within ${limit}s" >&2; return 1; }
    sleep 1
  done
}

migrate() { (cd "$1" && use_node && pnpm -s datastore:migrate) </dev/null >"$1/.recover-migrate.log" 2>&1; }

# stack_up NAME → start its stack and wait for it, then migrate (retried once:
# a Postgres that just restarted can drop the first connection). The migrate
# marker (.loops/.migrate/NAME, when it started) stands while it runs, so a
# crash leaves it for the next recover to report and rerun.
stack_up() {
  local dir=$loops/$1 proj marker=$loops/.migrate/$1
  proj=$(stack_project "$dir")
  [[ $proj == caretook-loop* ]] || { echo "  $1 has no stack project" >&2; return 1; }
  echo "• stack $1 ($proj)"
  [[ ! -f $marker ]] || echo "  a migrate here was cut off (started $(cat "$marker" 2>/dev/null)): rerunning it"
  (cd "$dir" && docker compose up -d --wait) </dev/null >/dev/null 2>&1 || { echo "  compose up failed" >&2; return 1; }
  wait_for_pg "$dir" "$proj" || return 1
  mkdir -p "$loops/.migrate" && date -u +%Y-%m-%dT%H:%M:%SZ >"$marker" || echo "  couldn't write the migrate marker" >&2
  if ! migrate "$dir"; then
    echo "  migrate failed; retrying once"
    sleep 3
    migrate "$dir" || { echo "  migrate failed again (see $dir/.recover-migrate.log)" >&2; return 1; }
  fi
  rm -f "$dir/.recover-migrate.log" "$marker"
  echo "  up and migrated"
}

# after_infrastructure SESSION… → the last step, once the machine is back: the
# recovery agent (prompt.sh recover) in this terminal, in the main checkout. It
# messages the live sessions and reopens the dead ones; with --no-agent, or when
# something didn't recover, it only lists them.
after_infrastructure() {
  (($#)) || { echo; echo "No PRD or plan sessions to carry on or reopen."; return 0; }
  echo
  echo "Sessions to carry on or reopen (each PRD and plan worktree):"
  local n w
  for n in "$@"; do
    w=$loops/$n
    echo "  $(session_name "$w")  in $w"
  done
  echo
  if ((${#failed[@]})); then
    echo "Not opening the recovery agent until everything above recovers. Then: pnpm prd recover"
  elif ((agent == 0)); then
    echo "--no-agent: to message and reopen them, run pnpm prd recover again without it, or pnpm prd open <name> for each."
  else
    local wrapper prompt
    wrapper=$(cd "$bin" && pwd)/session.sh
    prompt=$("$bin/prompt.sh" recover)
    if ((unattended)); then
      echo "Opening the recovery agent (claude --remote-control recover) in a background tab, in the main checkout."
      "$bin/open-session.sh" --command "cd $(printf %q "$main") && $(printf %q "$wrapper") recover --kind recovery -- --remote-control recover $(printf %q "$prompt")" \
        --title recover --background </dev/null 2>&1 | sed 's/^/  /' ||
        { echo "  couldn't open the recovery agent's tab" >&2; failed+=("the recovery agent"); }
    else
      echo "Opening the recovery agent (claude --remote-control recover) in the main checkout."
      release_lock
      cd "$main" && exec "$wrapper" recover --kind recovery -- --remote-control recover "$prompt"
    fi
  fi
}

# session_name DIR → prd-<topic> or plan-<topic> (as inventory.mjs's sessionName).
session_name() {
  local b
  b=$(git -C "$1" branch --show-current 2>/dev/null)
  case $b in "$prd_prefix"*) echo "prd-${b#"$prd_prefix"}" ;; "$plan_prefix"*) echo "plan-${b#"$plan_prefix"}" ;; *) basename "$1" ;; esac
}

run_actions() {
  local list step target gc=() sessions=() landings=() record=""
  list=$(inventory --json | node "$bin/recover-lib.mjs" actions)
  if grep -q $'^docker start\t' <<<"$list"; then
    start_docker
    list=$(inventory --json | node "$bin/recover-lib.mjs" actions)
  fi
  while IFS=$'\t' read -r -u 3 step target; do
    case $step in
      "") ;;
      "docker start") die "recover: Docker still doesn't answer" ;;
      keep-dispatch-intent) keep_intent || failed+=("the dispatcher's intent") ;;
      clear-lock) clear_lock "$target" || failed+=("lock $target") ;;
      "test-db up")
        echo "• the shared test Postgres"
        "$bin/test-db.sh" up </dev/null >/dev/null 2>&1 && echo "  up" || { echo "  didn't start" >&2; failed+=("test Postgres"); }
        ;;
      "stack up") stack_up "$target" || failed+=("stack $target") ;;
      serve)
        echo "• dev server $target"
        "$bin/serve.sh" "$target" </dev/null 2>&1 | sed 's/^/  /' || failed+=("server $target")
        ;;
      dispatch)
        # Gated on every step above: no dispatcher (and so no managed session) on a broken machine.
        if ((${#failed[@]})); then
          echo "• the dispatcher: not reopened while something above didn't recover (its intent is kept)"
        else
          reopen_dispatcher || failed+=("dispatcher")
        fi
        ;;
      drop-dispatch-intent) rm -f "$intent" && echo "• the dispatcher runs: dropped its kept intent" ;;
      resume-landing) landings+=("$target") ;;
      offer-gc) gc+=("$target") ;;
      open-session) sessions+=("$target") ;;
      delete-down-record) record=$target ;;
      *) echo "  unknown action $step $target: skipped" >&2 ;;
    esac
  done 3<<<"$list"

  if ((${#landings[@]})); then
    echo
    echo "Landings cut off midway (the recovery agent resumes them first: pnpm prd land --resume <branch>):"
    printf '  %s\n' "${landings[@]}"
  fi
  if ((${#gc[@]})); then
    echo
    echo "Merged slices to clean up (pnpm prd gc; a dirty one is kept until its changes are committed or discarded):"
    printf '  %s\n' "${gc[@]}"
  fi
  if [[ -n $record ]]; then
    if ((${#failed[@]})); then
      echo "Kept the down record ($record): rerun pnpm prd recover once the failures below are fixed."
    else
      rm -f "$record"
      echo "• used the down record, deleted it"
    fi
  fi
  if ((${#failed[@]})); then
    echo >&2
    echo "Didn't recover:" >&2
    printf '  %s\n' "${failed[@]}" >&2
  fi
  if ((${#failed[@]} == 0)); then
    echo
    echo "Recovered."
  fi
  after_infrastructure ${sessions[@]+"${sessions[@]}"}
  ((${#failed[@]} == 0)) || exit 1
}

if ((dry)); then
  inventory "$format"
  [[ $format == --text ]] && printf '\nDry run: nothing was changed.\n'
  exit 0
fi
stay=$loops/.stay-down.json
if [[ -f $stay ]]; then
  if ((unattended)); then
    echo "recover: stay-down ($stay, pnpm prd down --stay): nothing done; pnpm prd recover by hand brings it back"
    exit 0
  fi
  rm -f "$stay" && echo "• deleted the stay-down mark (pnpm prd down --stay): the watchdog may recover again"
fi
trap on_exit EXIT
take_lock
[[ -z $at ]] || wait_for_time "$at"
((wait == 0)) || wait_for_claude
run_actions
