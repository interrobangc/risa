#!/usr/bin/env bash
# Replace an orchestrator's session with a fresh one. (pnpm prd rotate)
#
#   rotate.sh [<topic>] [--mid-wave] [--reason <text>]
#
# The topic defaults to the PRD worktree the shell is in. The session to end is
# prd-<topic>'s live record, else (called from that worktree) the calling
# shell's ancestor claude process: a session started before session.sh.
#
# Refuses when plans/<topic>-plan.md has uncommitted changes (commit _Status_
# first), when it finds no session, or when slice worktrees of the topic exist
# (their agents would die with the session) unless --mid-wave, which ends them
# too: the fresh session respawns them with --continue.
#
# Then it opens rotate-into.sh in a background iTerm2 tab (the opener's
# --background) and returns at once, so the calling session can say its last
# line; the tab ends the old session and starts the fresh one under the same
# name. Without iTerm2 it prints that command to run and ends nothing.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
bin=$(cd "$(dirname "$0")" && pwd)
export CARETOOK_SESSIONS_DIR=${CARETOOK_SESSIONS_DIR:-$loops/.sessions}

topic="" mid_wave="" reason=""
while (($#)); do
  case $1 in
    --mid-wave) mid_wave=1 ;;
    --reason) reason=${2:?--reason <text>}; shift ;;
    -h | --help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "rotate: unknown option $1 (--mid-wave, --reason <text>)" ;;
    *) [[ -z $topic ]] || die "rotate: one topic at a time"; topic=$1 ;;
  esac
  shift
done

here=$(here_name)
here_topic=""
[[ -n $here && $(git -C "$loops/$here" branch --show-current 2>/dev/null) == prd/* ]] && here_topic=$(topic_of "$here")
topic=${topic:-$here_topic}
[[ -n $topic ]] || die "rotate: name a topic, or run it inside a PRD's worktree"
dir=$loops/$topic
[[ $(git -C "$dir" branch --show-current 2>/dev/null) == "prd/$topic" ]] || die "rotate: no PRD worktree for $topic ($dir on prd/$topic)"
name=prd-$topic

plan=plans/$topic-plan.md
[[ -z $(git -C "$dir" status --porcelain -- "$plan" 2>/dev/null) ]] ||
  die "rotate: $plan has uncommitted changes: commit _Status_ first, so the fresh session reads where you are"

slices=""
for d in "$loops"/*/; do
  [[ $(git -C "$d" branch --show-current 2>/dev/null) == "slice/$topic/"* ]] && slices+="${slices:+ }$(basename "$d")"
done
if [[ -n $slices && -z $mid_wave ]]; then
  die "rotate: slice worktrees of $topic still exist ($slices): merge them first, or pass --mid-wave on the user's word (their agents end too)"
fi

# The record's live pid; the ancestor only from the topic's own worktree.
if pid=$(node "$bin/sessions.mjs" live "$name" 2>/dev/null); then
  how="its record"
elif [[ $here_topic == "$topic" ]] && found=$(node "$bin/sessions.mjs" self 2>/dev/null); then
  pid=${found%% *} how="the calling shell's ancestor claude"
elif [[ $here_topic == "$topic" ]]; then
  die "rotate: no session to end: no live record $name, and this shell isn't under a claude process"
else
  die "rotate: no session to end: no live record $name (without one, run it from $topic's own session)"
fi

line="cd $(printf %q "$dir") && $(printf %q "$bin/rotate-into.sh") $name $pid"
[[ -z $reason ]] || line+=" --reason $(printf %q "$reason")"
echo "Rotating $name: pid $pid (from $how)${slices:+, mid-wave (the agents of $slices end too)}."
exec "$bin/open-session.sh" --command "$line" --title "$name" --background
