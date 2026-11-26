#!/usr/bin/env bash
# End a recorded session. (pnpm prd end)
#
#   end-session.sh [<name>]
#
# With a name (prd-<topic>, plan-<topic>, hotfix-<name>, backlog, recover): the live session its record names.
# With none, the calling shell's own session: the record of the worktree it is
# in when that is live, else the shell's ancestor claude process (a session
# started before session.sh, or one whose worktree `pnpm prd rm` has removed).
# Refuses when it finds neither. A finished session runs it as its last step;
# its tab closes when the session ends (a tab the opener made execs it).
#
# A record's pid is ended only once it checks out as that session's claude
# (sessions.mjs target): under `session.sh <name>`, or running in the record's
# dir. A reopen the record doesn't name (its pid stale) ends the one live claude
# under `session.sh <name>` instead, and the record takes its pid; anything
# else (a pid that isn't the session's, two live sessions) is refused (B-810).
#
# It sends TERM, then KILL after CARETOOK_END_WAIT seconds (default 10).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
bin=$(cd "$(dirname "$0")" && pwd)
export CARETOOK_SESSIONS_DIR=${CARETOOK_SESSIONS_DIR:-$loops/.sessions}
wait_secs=${CARETOOK_END_WAIT:-10}

(($# <= 1)) || die "usage: pnpm prd end [<name>]"

# checked NAME → "<pid> <how>" for NAME's record, once its pid checks out (exit 4: it has ended).
checked() {
  local out rc=0
  out=$(node "$bin/sessions.mjs" target "$1") || rc=$?
  ((rc == 0)) || return "$rc"
  case $out in
    *" record") echo "${out%% *} its record" ;;
    *" reopened "*) echo "${out%% *} the live session.sh $1 (its record's pid ${out##* } was stale)" ;;
    *) die "end: unexpected answer from sessions.mjs target: $out" ;;
  esac
}
case ${1:-} in -h | --help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; -*) die "end: unknown option $1" ;; esac
name=${1:-}

if [[ -n $name ]]; then
  [[ -n $(node "$bin/sessions.mjs" get "$name" 2>/dev/null) ]] || die "end: no session record $name"
  rc=0
  found=$(checked "$name") || rc=$?
  ((rc != 4)) || { echo "$name isn't running (its record says it has ended)"; exit 0; }
  ((rc == 0)) || exit 1
  pid=${found%% *} how=${found#* }
else
  here=$(here_name 2>/dev/null || true) session=""
  if [[ -n $here ]]; then
    case $(git -C "$loops/$here" branch --show-current 2>/dev/null) in
      "$prd_prefix"*) session=prd-$here ;;
      "$plan_prefix"* | "$hotfix_prefix"*) session=$here ;;
    esac
  fi
  found=$(node "$bin/sessions.mjs" self ${session:+"$session"}) ||
    die "end: no session to end: no live record${session:+ for $session}, and this shell isn't under a claude process"
  pid=${found%% *}
  if [[ ${found#* } == record ]]; then
    name=$session
    found=$(checked "$name") || exit 1
    pid=${found%% *} how=${found#* }
  else
    name="this shell's claude" how="the calling shell's ancestor"
  fi
fi

# Say it first: ending the caller's own session may take this output with it.
echo "Ending $name (pid $pid, from $how)."
end_pid "$pid" "$name" "$wait_secs"
