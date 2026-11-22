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
# It sends TERM, then KILL after CARETOOK_END_WAIT seconds (default 10).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
bin=$(cd "$(dirname "$0")" && pwd)
export CARETOOK_SESSIONS_DIR=${CARETOOK_SESSIONS_DIR:-$loops/.sessions}
wait_secs=${CARETOOK_END_WAIT:-10}

(($# <= 1)) || die "usage: pnpm prd end [<name>]"
case ${1:-} in -h | --help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; -*) die "end: unknown option $1" ;; esac
name=${1:-}

if [[ -n $name ]]; then
  [[ -n $(node "$bin/sessions.mjs" get "$name" 2>/dev/null) ]] || die "end: no session record $name"
  pid=$(node "$bin/sessions.mjs" live "$name") || { echo "$name isn't running (its record says it has ended)"; exit 0; }
  how="its record"
else
  here=$(here_name 2>/dev/null || true) session=""
  if [[ -n $here ]]; then
    case $(git -C "$loops/$here" branch --show-current 2>/dev/null) in
      prd/*) session=prd-$here ;;
      plan/* | hotfix/*) session=$here ;;
    esac
  fi
  found=$(node "$bin/sessions.mjs" self ${session:+"$session"}) ||
    die "end: no session to end: no live record${session:+ for $session}, and this shell isn't under a claude process"
  pid=${found%% *}
  if [[ ${found#* } == record ]]; then name=$session how="its record"; else name="this shell's claude" how="the calling shell's ancestor"; fi
fi

# Gone, or a zombie waiting for its parent.
alive() { local s; s=$(ps -o stat= -p "$1" 2>/dev/null) || return 1; [[ -n $s && $s != Z* ]]; }

# Say it first: ending the caller's own session may take this output with it.
echo "Ending $name (pid $pid, from $how)."
kill -TERM "$pid" 2>/dev/null || true
for ((i = 0; i < wait_secs * 5; i++)); do
  alive "$pid" || exit 0
  sleep 0.2
done
kill -KILL "$pid" 2>/dev/null || true
echo "$name ignored TERM for ${wait_secs}s: killed it."
