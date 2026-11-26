#!/usr/bin/env bash
# Run a recorded claude session: an orchestrator, planner, backlog, hotfix,
# recovery or inbox session.
#
#   session.sh <name> [--kind prd|plan|backlog|hotfix|recovery|inbox] [--topic <t>] [--auto] [--managed] -- <claude args…>
#
# Runs ${CARETOOK_CLAUDE_BIN:-claude} with the args as this script's child, in
# the foreground (the terminal stays the session's), and keeps
# .loops/.sessions/<name>.json (sessions.mjs): at start pid, kind, topic,
# started, the command, the model (claude's --model, if given), remote (its --remote-control), dir (where it runs), auto and
# managed (--managed: the dispatcher started it), clearing rotating, ended and exit; when it exits, ended and exit, but
# only while the record's pid is still this session's (sessions.mjs set
# --if-pid): a second session opened under the same name keeps its record
# live, and this one says so on stderr. It exits with the session's code. The
# record stays until rm.sh removes the worktree.
#
# The kind and topic default from the name (prd-<topic>, plan-<topic>,
# hotfix-<name>, backlog, backlog-<name>, inbox, recover: kind recovery). The
# pid is the claude process itself: a shell that records its own pid, then
# execs claude.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
bin=$(cd "$(dirname "$0")" && pwd)
export CARETOOK_SESSIONS_DIR=${CARETOOK_SESSIONS_DIR:-$loops/.sessions}

name=${1:-}; (($#)) && shift
[[ -n $name && $name != -* ]] || die "usage: session.sh <name> [--kind prd|plan|backlog|hotfix|recovery|inbox] [--topic <t>] [--auto] [--managed] -- <claude args…>"
kind="" topic="" auto=false managed=false
case $name in
  prd-*) kind=prd topic=${name#prd-} ;;
  plan-*) kind=plan topic=${name#plan-} ;;
  hotfix-*) kind=hotfix topic=${name#hotfix-} ;;
  backlog | backlog-*) kind=backlog ;;
  inbox) kind=inbox ;;
  recover) kind=recovery ;;
esac
while (($#)); do
  case $1 in
    --kind) kind=${2:?--kind prd|plan|backlog|hotfix|recovery|inbox}; shift ;;
    --topic) topic=${2:?--topic <t>}; shift ;;
    --auto) auto=true ;;
    --managed) managed=true ;;
    --) shift; break ;;
    *) die "session.sh: unknown option $1 (--kind, --topic, --auto, --managed, then -- and claude's args)" ;;
  esac
  shift
done
case $kind in
  prd | plan | backlog | hotfix | recovery | inbox) ;;
  *) die "session.sh: --kind prd|plan|backlog|hotfix|recovery|inbox (${kind:-none from the name $name})" ;;
esac
claude_bin=${CARETOOK_CLAUDE_BIN:-claude}

# The command as a line, each long argument (the prompt) cut short.
command=$claude_bin
for a in "$@"; do
  ((${#a} > 120)) && a="${a:0:117}..."
  command+=" $(printf %q "$a")"
done

# The model claude was given, kept so a reopen or rotation uses the same one.
model="" prev=""
for a in "$@"; do
  if [[ $prev == --model ]]; then model=$a; break; fi
  case $a in --model=*) model=${a#--model=}; break ;; esac
  prev=$a
done

# The Remote Control name, kept so a rotation reopens under the same one.
remote="" prev=""
for a in "$@"; do
  if [[ $prev == --remote-control ]]; then remote=$a; break; fi
  case $a in --remote-control=*) remote=${a#--remote-control=}; break ;; esac
  prev=$a
done

# The main backlog session's display name is a captain's (captain.mjs, given as
# its --remote-control): the tab's title too, which Claude Code is told not to
# retitle. A session it starts doesn't inherit that.
if [[ -n ${CARETOOK_CAPTAIN_TITLE:-} ]]; then unset CARETOOK_CAPTAIN_TITLE CLAUDE_CODE_DISABLE_TERMINAL_TITLE; fi
if [[ $name == backlog && $kind == backlog && -n $remote && $remote != backlog ]]; then
  export CARETOOK_CAPTAIN_TITLE=1 CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1
  # The tab's title by escape (OSC 0) when this is a terminal (CARETOOK_TAB_TITLE=always: tests).
  if [[ -t 1 || ${CARETOOK_TAB_TITLE:-} == always ]]; then printf '\033]0;%s\007' "$remote"; fi
fi

# A brief left from before never leads a later prompt: whoever uses one has
# already read it into this session's args (rotate-into.sh).
[[ ! $name =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || rm -f "$loops/.briefs/$name.md"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Claude Code's side, from the host layer (host.mjs claude-session): the config
# folder this claude gets (its variable set, unset for Claude Code's default,
# or left as it is when nothing names one), and the settings file its
# kind runs with. The context watch (context.mjs) comes in through that file:
# orchestrators, backlog and inbox sessions get its hook, so the user's own
# sessions never run it. Any other kind clears what it could inherit from a
# session that started it.
claude_lines=$(node "$bin/host.mjs" claude-session "$kind" "${main:-$(pwd -P)}") || exit 2
{ read -r claude_env || true; read -r settings || true; } <<< "$claude_lines"
case $claude_env in
  "") ;;
  *=*) export "${claude_env?}" ;;
  *) unset "$claude_env" ;;
esac
unset CARETOOK_SESSION_NAME CARETOOK_SESSION_PID CARETOOK_CONTEXT_HOOK
if [[ -n $settings ]]; then
  export CARETOOK_SESSION_NAME=$name CARETOOK_CONTEXT_HOOK=$bin/context.mjs
  set -- --settings "$settings" "$@"
fi

# The child records its own pid, then becomes claude, so the recorded pid is
# the session's. In the foreground, so claude keeps the terminal and its input.
# It also leaves the pid in PIDFILE, so the end is recorded only against it.
pidfile=$(mktemp "${TMPDIR:-/tmp}/caretook-session.XXXXXX")
trap 'rm -f "$pidfile"' EXIT
code=0
bash -c 'node "$1" set "$2" pid=$$ kind="$3" topic="$4" started="$5" command="$6" auto="$7" managed="$8" model="$9" remote="${10}" dir="${11}" rotating= ended= exit= &&
  echo $$ > "${12}" && shift 12 && export CARETOOK_SESSION_PID=$$ && exec "$@"' _ \
  "$bin/sessions.mjs" "$name" "$kind" "$topic" "$(now)" "$command" "$auto" "$managed" "$model" "$remote" "$(pwd -P)" "$pidfile" "$claude_bin" "$@" || code=$?

pid=$(cat "$pidfile" 2>/dev/null || true)
if [[ -z $pid ]]; then
  echo "session.sh: $name never started; its record is left as it is" >&2
else
  rc=0
  node "$bin/sessions.mjs" set "$name" --if-pid "$pid" ended="$(now)" exit="$code" 2>/dev/null || rc=$?
  if ((rc == 3)); then
    echo "session.sh: $name's record belongs to a newer session now; its end (pid $pid) isn't recorded" >&2
  elif ((rc)); then
    echo "session.sh: couldn't record the end of $name" >&2
  fi
fi
exit "$code"
