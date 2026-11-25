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
#
#   rotate.sh --self [--brief <file>] [--reason <text>]
#   rotate.sh --self --brief-path
#
# --self rotates the calling session, found by its ancestor claude pid among the
# live records. A backlog session reopens fresh in the main checkout under the
# same name, model and Remote Control (the main one, backlog, under a new
# captain's name: captain.mjs); --brief puts the file at the top of the
# new prompt (a file it can't use is refused before anything ends, and the file
# is deleted once read). --brief-path prints where to write one. The inbox
# session reopens fresh the same way in its own directory, on Opus at low
# effort (prd.sh inbox), with no brief: what it handles is on origin/dev. An
# orchestrator behaves as plain rotate (its hand-over is _Status_, so no brief);
# any other kind, an unrecorded caller and a slice agent's shell are refused.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
bin=$(cd "$(dirname "$0")" && pwd)
export CARETOOK_SESSIONS_DIR=${CARETOOK_SESSIONS_DIR:-$loops/.sessions}

topic="" mid_wave="" reason="" self="" brief="" brief_path=""
while (($#)); do
  case $1 in
    --mid-wave) mid_wave=1 ;;
    --reason) reason=${2:?--reason <text>}; shift ;;
    --self) self=1 ;;
    --brief) brief=${2:?--brief <file>}; shift ;;
    --brief-path) brief_path=1 ;;
    -h | --help) sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "rotate: unknown option $1 (--mid-wave, --reason <text>, --self, --brief <file>, --brief-path)" ;;
    *) [[ -z $topic ]] || die "rotate: one topic at a time"; topic=$1 ;;
  esac
  shift
done

[[ -n $self || (-z $brief && -z $brief_path) ]] || die "rotate: --brief and --brief-path go with --self"
[[ -z $brief || -z $brief_path ]] || die "rotate: --brief or --brief-path, not both"
if [[ -n $self ]]; then
  [[ -z $topic ]] || die "rotate --self: takes no topic (it rotates the calling session)"
  [[ $(git branch --show-current 2>/dev/null) != "$slice_prefix"* ]] ||
    die "rotate --self: refused on a slice branch: this shell carries its orchestrator's session (hand off to your orchestrator)"
  caller=$(node "$bin/sessions.mjs" caller 2>&1) || die "rotate --self: $caller (only a recorded session rotates itself)"
  IFS=$'\t' read -r self_name self_kind self_pid self_topic <<<"$caller"
  case $self_kind in
    backlog)
      [[ -z $mid_wave ]] || die "rotate --self: --mid-wave is for an orchestrator; $self_name is a backlog session"
      if [[ -n $brief_path ]]; then
        mkdir -p "$loops/.briefs"
        echo "$loops/.briefs/$self_name.md"
        exit 0
      fi
      line="cd $(printf %q "$main") && $(printf %q "$bin/rotate-into.sh") $self_name $self_pid"
      if [[ -n $brief ]]; then
        why=$(node "$bin/rotate.mjs" brief-check "$brief") || die "rotate --self: $why; nothing was ended"
        brief=$(cd "$(dirname "$brief")" && pwd)/$(basename "$brief")
        line+=" --brief $(printf %q "$brief")"
      fi
      [[ -z $reason ]] || line+=" --reason $(printf %q "$reason")"
      title=""
      if [[ $self_name == backlog ]]; then
        # The main backlog session's next one is a new captain (captain.mjs): its Remote Control name and tab title.
        title=$(node "$bin/captain.mjs" next) || die "rotate --self: couldn't pick the next captain; nothing was ended"
        line+=" --captain $title"
      fi
      echo "Rotating $self_name: pid $self_pid (the calling session)${brief:+, with a brief}${title:+, as $title}."
      exec "$bin/open-session.sh" --command "$line" --title "${title:-$self_name}" --background
      ;;
    inbox)
      [[ -z $mid_wave ]] || die "rotate --self: --mid-wave is for an orchestrator; $self_name is the inbox session"
      [[ -z $brief && -z $brief_path ]] || die "rotate --self: the inbox session hands off with no brief (its lines are on origin/dev)"
      line="cd $(printf %q "$main") && $(printf %q "$bin/rotate-into.sh") $self_name $self_pid"
      [[ -z $reason ]] || line+=" --reason $(printf %q "$reason")"
      echo "Rotating $self_name: pid $self_pid (the calling session)."
      exec "$bin/open-session.sh" --command "$line" --title "$self_name" --background
      ;;
    prd)
      [[ -z $brief && -z $brief_path ]] || die "rotate --self: an orchestrator hands over through _Status_, not a brief"
      topic=$self_topic
      ;;
    *)
      die "rotate --self: $self_name is a $self_kind session: only backlog and inbox sessions and orchestrators rotate themselves (a hotfix has no _Status_ to resume from, and recovery is one-shot)"
      ;;
  esac
fi

here=$(here_name)
here_topic=""
[[ -n $here && $(git -C "$loops/$here" branch --show-current 2>/dev/null) == "$prd_prefix"* ]] && here_topic=$(topic_of "$here")
topic=${topic:-$here_topic}
[[ -n $topic ]] || die "rotate: name a topic, or run it inside a PRD's worktree"
dir=$loops/$topic
[[ $(git -C "$dir" branch --show-current 2>/dev/null) == "$prd_prefix$topic" ]] || die "rotate: no PRD worktree for $topic ($dir on $prd_prefix$topic)"
name=prd-$topic

plan=plans/$topic-plan.md
[[ -z $(git -C "$dir" status --porcelain -- "$plan" 2>/dev/null) ]] ||
  die "rotate: $plan has uncommitted changes: commit _Status_ first, so the fresh session reads where you are"

# A wave's run decides whether its slices have more to do: no new session until it's back.
if [[ -z $mid_wave ]]; then
  rc=0
  out=$(node "$bin/../ci/outstanding.mjs" "$topic" "$dir" 2>/dev/null) || rc=$?
  case $rc in
    0) ;;
    10) die "rotate: $topic has a requested run with no verdict: ${out//$'\n'/, }. Wait for it, or pass --mid-wave on the user's word" ;;
    *) die "rotate: can't tell whether $topic has a requested run out (GitHub can't be read). Try again, or pass --mid-wave on the user's word" ;;
  esac
fi

slices=""
for d in "$loops"/*/; do
  [[ $(git -C "$d" branch --show-current 2>/dev/null) == "$slice_prefix$topic/"* ]] && slices+="${slices:+ }$(basename "$d")"
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
