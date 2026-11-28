#!/usr/bin/env bash
# Replace an orchestrator's session with a fresh one: the command `prd
# rotate` opens in a background tab (never run inside the session it ends).
#
#   rotate-into.sh prd-<topic> <old pid> [--reason <text>]
#   rotate-into.sh backlog[-<name>] <old pid> [--reason <text>] [--brief <file> | --no-brief] [--captain <C>]
#   rotate-into.sh inbox <old pid> [--reason <text>]
#
# A backlog session needs its live record at that pid (else nothing is ended).
# It reopens fresh in the main checkout with the backlog prompt, on the record's
# model and Remote Control name; --brief leads the prompt and is deleted once
# read; --no-brief (the dispatcher, when none was written) says so at its top.
# The main one (backlog) reopens under a new captain's name (captain.mjs): the
# --captain its opener titled the tab with, else one drawn here, unlike the last.
# The inbox session (its live record at that pid, too) reopens through `prd.sh
# inbox` in its recorded directory, on prd.sh's inbox model (Opus at low
# effort; never the record's, which may be an older default), with no brief. The steps are otherwise the same:
#
# 1. Marks the record (.loops/.sessions/prd-<topic>.json) rotating, making one
#    when there is none (a session started before session.sh), so an opener or
#    recovery that runs while this is cut short starts fresh, never --continue.
#    A refusal before it ("nothing was ended") is also written to
#    <sessions dir>/<name>.refused as "<old pid>\t<reason>", which `rotate
#    --self` waits on (it reads and removes it), since this tab is in the background.
# 2. Ends the old pid: TERM, then KILL after RISA_ROTATE_WAIT seconds
#    (default 20), and waits for it to go (and for its session.sh to record the
#    end, so that write can't land on the new record).
# 3. Execs session.sh with the same name and the resume prompt (prompt.sh
#    orchestrator <topic> --resume), plus --auto when the record or the plan's
#    _Status_ says run-through, and --managed when the record is the
#    dispatcher's, and the record's --model when it has one: always a fresh
#    session, never --continue. session.sh clears rotating as it starts.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
bin=$(cd "$(dirname "$0")" && pwd)
export RISA_SESSIONS_DIR=${RISA_SESSIONS_DIR:-$loops/.sessions}
wait_secs=${RISA_ROTATE_WAIT:-20}

usage="usage: rotate-into.sh prd-<topic>|backlog[-<name>]|inbox <old pid> [--reason <text>] [--brief <file> | --no-brief] [--captain <C>]"
name=${1:-} old=${2:-}
[[ ($name == prd-?* || $name == backlog || $name == backlog-?* || $name == inbox) && $old =~ ^[0-9]+$ ]] || die "$usage"
shift 2
# A refusal before step 1 is also left where `rotate --self` reads it (rotate.mjs refusalFile):
# its tab is in the background, so no one sees this shell's last line (RISA-1082).
refused=$RISA_SESSIONS_DIR/$name.refused
die() {
  [[ -z $refused ]] || { mkdir -p "$RISA_SESSIONS_DIR" && printf '%s\t%s\n' "$old" "$*" >"$refused"; } 2>/dev/null || true
  echo "$*" >&2
  exit 1
}
reason="" brief="" no_brief="" captain=""
while (($#)); do
  case $1 in
    --reason) reason=${2:?--reason <text>}; shift ;;
    --brief) brief=${2:?--brief <file>}; shift ;;
    --no-brief) no_brief=1 ;;
    --captain) captain=${2:?--captain <C>}; shift ;;
    *) die "rotate-into: unknown option $1 ($usage)" ;;
  esac
  shift
done
[[ -z $brief || -z $no_brief ]] || die "rotate-into: --brief or --no-brief, not both"
[[ -z $captain || $name == backlog ]] || die "rotate-into: --captain is for the main backlog session, not $name"
[[ -z $captain || $captain =~ ^[A-Za-z]+$ ]] || die "rotate-into: --captain takes a captain's name ($captain)"
kind=backlog topic="" dir=$main
[[ $name != inbox ]] || kind=inbox
if [[ $kind == inbox ]]; then
  [[ -z $brief && -z $no_brief ]] || die "rotate-into: the inbox session hands off with no brief"
elif [[ $name == prd-* ]]; then
  kind=prd topic=${name#prd-} dir=$loops/${name#prd-}
  [[ -z $brief && -z $no_brief ]] || die "rotate-into: an orchestrator hands over through _Status_, not a brief"
  [[ -d $dir ]] || die "rotate-into: no worktree $topic in $loops"
fi

sessions() { node "$bin/sessions.mjs" "$@"; }
field() { node -e 'const r = JSON.parse(process.argv[1] || "{}"); const v = r[process.argv[2]]; process.stdout.write(v === undefined ? "" : String(v))' "$1" "$2"; }

before=$(sessions get "$name" 2>/dev/null || true)
auto=""
[[ $(field "$before" auto) == true ]] && auto=1
[[ $kind != prd ]] || ! node "$bin/rotate.mjs" run-through "$dir/plans/$topic-plan.md" || auto=1
if [[ $kind == backlog || $kind == inbox ]]; then
  [[ $(field "$before" kind) == "$kind" ]] || die "rotate-into: $name has no $kind record; nothing was ended"
  [[ $(sessions live "$name" 2>/dev/null || true) == "$old" ]] || die "rotate-into: pid $old isn't $name's live session; nothing was ended"
  if [[ -n $brief ]]; then
    why=$(node "$bin/rotate.mjs" brief-check "$brief") || die "rotate-into: $why; nothing was ended"
  fi
fi
managed=""
[[ $(field "$before" managed) == true ]] && managed=1
# Its session.sh will write ended when the old pid exits (only when the record is its).
wrapped=""
[[ -n $before && $(field "$before" pid) == "$old" && -z $(field "$before" ended) ]] && wrapped=1

if [[ -n $before ]]; then sessions set "$name" rotating=true; else sessions set "$name" kind=prd topic="$topic" rotating=true; fi
refused=""
case $kind in
  prd) what="the resume prompt" ;;
  inbox) what="the inbox prompt" ;;
  *) what="the backlog prompt${brief:+ and the brief}" ;;
esac
echo "Rotating $name${reason:+ ($reason)}: ending pid $old, then a fresh session with $what${auto:+ (run-through)}."

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
  alive "$old" && die "rotate-into: pid $old is still running; $name is left marked rotating (${prd_cmd} open ${topic:-$name} starts it fresh)"
fi
if [[ -n $wrapped ]]; then
  for ((i = 0; i < 50; i++)); do
    [[ -n $(field "$(sessions get "$name" 2>/dev/null || true)" ended) ]] && break
    sleep 0.2
  done
fi

cd "$dir"
if [[ $kind == inbox ]]; then
  # prd.sh inbox checks the bare directory, gives its model, settings and prompt.
  args=(inbox)
  [[ -z $(field "$before" dir) ]] || args+=(--dir "$(field "$before" dir)")
  exec "$bin/prd.sh" "${args[@]}" ${managed:+--managed}
fi
if [[ $kind == backlog ]]; then
  model=$(field "$before" model) remote=$(field "$before" remote)
  if [[ $name == backlog ]]; then
    # A new session, a new captain; with none drawn, Remote Control backlog rather than no session.
    remote=${captain:-$(node "$bin/captain.mjs" next 2>/dev/null || echo backlog)}
  fi
  # The prompt names the captain (prompts/backlog.sh); none drawn, no line.
  [[ $name != backlog || $remote == backlog ]] || export RISA_CAPTAIN=$remote
  # The old session is gone, so a brief that went bad now costs the brief, never the session.
  prompt=""
  if [[ -n $brief ]]; then
    if prompt=$("$bin/prompt.sh" backlog --brief "$brief"); then
      rm -f "$brief"
    else
      echo "rotate-into: couldn't read the brief $brief: starting without it" >&2
      prompt=""
    fi
  fi
  [[ -n $prompt ]] || prompt=$("$bin/prompt.sh" backlog ${no_brief:+--no-brief})
  unset RISA_CAPTAIN
  args=()
  [[ -z $model ]] || args+=(--model "$model")
  args+=(--remote-control "${remote:-$name}" "$prompt")
  exec "$bin/session.sh" "$name" --kind backlog ${managed:+--managed} -- "${args[@]}"
fi
# The record's model carries over (a by-hand Fable orchestrator stays on Fable).
model=$(field "$before" model)
args=()
[[ -z $model ]] || args+=(--model "$model")
args+=(--remote-control "$name" "$("$bin/prompt.sh" orchestrator "$topic" --resume ${auto:+--auto})")
exec "$bin/session.sh" "$name" ${auto:+--auto} ${managed:+--managed} -- "${args[@]}"
