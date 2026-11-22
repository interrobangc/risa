#!/usr/bin/env bash
# Replace an orchestrator's session with a fresh one: the command `pnpm prd
# rotate` opens in a background tab (never run inside the session it ends).
#
#   rotate-into.sh prd-<topic> <old pid> [--reason <text>]
#
# 1. Marks the record (.loops/.sessions/prd-<topic>.json) rotating, making one
#    when there is none (a session started before session.sh), so an opener or
#    recovery that runs while this is cut short starts fresh, never --continue.
# 2. Ends the old pid: TERM, then KILL after CARETOOK_ROTATE_WAIT seconds
#    (default 20), and waits for it to go (and for its session.sh to record the
#    end, so that write can't land on the new record).
# 3. Execs session.sh with the same name and the resume prompt (prompt.sh
#    orchestrator <topic> --resume), plus --auto when the record or the plan's
#    _Status_ says run-through, and --managed when the record is the
#    dispatcher's: always a fresh session, never --continue. session.sh clears
#    rotating as it starts.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
bin=$(cd "$(dirname "$0")" && pwd)
export CARETOOK_SESSIONS_DIR=${CARETOOK_SESSIONS_DIR:-$loops/.sessions}
wait_secs=${CARETOOK_ROTATE_WAIT:-20}

usage="usage: rotate-into.sh prd-<topic> <old pid> [--reason <text>]"
name=${1:-} old=${2:-}
[[ $name == prd-?* && $old =~ ^[0-9]+$ ]] || die "$usage"
shift 2
reason=""
while (($#)); do
  case $1 in
    --reason) reason=${2:?--reason <text>}; shift ;;
    *) die "rotate-into: unknown option $1 ($usage)" ;;
  esac
  shift
done
topic=${name#prd-}
dir=$loops/$topic
[[ -d $dir ]] || die "rotate-into: no worktree $topic in $loops"

sessions() { node "$bin/sessions.mjs" "$@"; }
field() { node -e 'const r = JSON.parse(process.argv[1] || "{}"); const v = r[process.argv[2]]; process.stdout.write(v === undefined ? "" : String(v))' "$1" "$2"; }

before=$(sessions get "$name" 2>/dev/null || true)
auto=""
[[ $(field "$before" auto) == true ]] && auto=1
node "$bin/rotate.mjs" run-through "$dir/plans/$topic-plan.md" && auto=1
managed=""
[[ $(field "$before" managed) == true ]] && managed=1
# Its session.sh will write ended when the old pid exits (only when the record is its).
wrapped=""
[[ -n $before && $(field "$before" pid) == "$old" && -z $(field "$before" ended) ]] && wrapped=1

if [[ -n $before ]]; then sessions set "$name" rotating=true; else sessions set "$name" kind=prd topic="$topic" rotating=true; fi
echo "Rotating $name${reason:+ ($reason)}: ending pid $old, then a fresh session with the resume prompt${auto:+ (run-through)}."

# Gone, or a zombie waiting for its parent.
alive() { local s; s=$(ps -o stat= -p "$1" 2>/dev/null) || return 1; [[ -n $s && $s != Z* ]]; }
kill -TERM "$old" 2>/dev/null || true
for ((i = 0; i < wait_secs * 5; i++)); do
  alive "$old" || break
  sleep 0.2
done
if alive "$old"; then
  kill -KILL "$old" 2>/dev/null || true
  echo "pid $old ignored TERM for ${wait_secs}s: killed it."
  for ((i = 0; i < 50; i++)); do alive "$old" || break; sleep 0.2; done
  alive "$old" && die "rotate-into: pid $old is still running; $name is left marked rotating (pnpm prd open $topic starts it fresh)"
fi
if [[ -n $wrapped ]]; then
  for ((i = 0; i < 50; i++)); do
    [[ -n $(field "$(sessions get "$name" 2>/dev/null || true)" ended) ]] && break
    sleep 0.2
  done
fi

cd "$dir"
args=(--remote-control "$name" "$("$bin/prompt.sh" orchestrator "$topic" --resume ${auto:+--auto})")
exec "$bin/session.sh" "$name" ${auto:+--auto} ${managed:+--managed} -- "${args[@]}"
