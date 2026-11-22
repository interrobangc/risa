#!/usr/bin/env bash
# Run a recorded claude session: an orchestrator, planner, backlog, hotfix or
# recovery session.
#
#   session.sh <name> [--kind prd|plan|backlog|hotfix|recovery] [--topic <t>] [--auto] [--managed] -- <claude args…>
#
# Runs ${CARETOOK_CLAUDE_BIN:-claude} with the args as this script's child, in
# the foreground (the terminal stays the session's), and keeps
# .loops/.sessions/<name>.json (sessions.mjs): at start pid, kind, topic,
# started, the command, the model (claude's --model, if given), auto and
# managed (--managed: the dispatcher started it), clearing rotating, ended and exit; when it exits, ended and exit, but
# only while the record's pid is still this session's (sessions.mjs set
# --if-pid): a second session opened under the same name keeps its record
# live, and this one says so on stderr. It exits with the session's code. The
# record stays until rm.sh removes the worktree.
#
# The kind and topic default from the name (prd-<topic>, plan-<topic>,
# hotfix-<name>, backlog, backlog-<name>, recover: kind recovery). The
# pid is the claude process itself: a shell that records its own pid, then
# execs claude.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
bin=$(cd "$(dirname "$0")" && pwd)
export CARETOOK_SESSIONS_DIR=${CARETOOK_SESSIONS_DIR:-$loops/.sessions}

name=${1:-}; (($#)) && shift
[[ -n $name && $name != -* ]] || die "usage: session.sh <name> [--kind prd|plan|backlog|hotfix|recovery] [--topic <t>] [--auto] [--managed] -- <claude args…>"
kind="" topic="" auto=false managed=false
case $name in
  prd-*) kind=prd topic=${name#prd-} ;;
  plan-*) kind=plan topic=${name#plan-} ;;
  hotfix-*) kind=hotfix topic=${name#hotfix-} ;;
  backlog | backlog-*) kind=backlog ;;
  recover) kind=recovery ;;
esac
while (($#)); do
  case $1 in
    --kind) kind=${2:?--kind prd|plan|backlog|hotfix|recovery}; shift ;;
    --topic) topic=${2:?--topic <t>}; shift ;;
    --auto) auto=true ;;
    --managed) managed=true ;;
    --) shift; break ;;
    *) die "session.sh: unknown option $1 (--kind, --topic, --auto, --managed, then -- and claude's args)" ;;
  esac
  shift
done
case $kind in
  prd | plan | backlog | hotfix | recovery) ;;
  *) die "session.sh: --kind prd|plan|backlog|hotfix|recovery (${kind:-none from the name $name})" ;;
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

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# The child records its own pid, then becomes claude, so the recorded pid is
# the session's. In the foreground, so claude keeps the terminal and its input.
# It also leaves the pid in PIDFILE, so the end is recorded only against it.
pidfile=$(mktemp "${TMPDIR:-/tmp}/caretook-session.XXXXXX")
trap 'rm -f "$pidfile"' EXIT
code=0
bash -c 'node "$1" set "$2" pid=$$ kind="$3" topic="$4" started="$5" command="$6" auto="$7" managed="$8" model="$9" rotating= ended= exit= &&
  echo $$ > "${10}" && shift 10 && exec "$@"' _ \
  "$bin/sessions.mjs" "$name" "$kind" "$topic" "$(now)" "$command" "$auto" "$managed" "$model" "$pidfile" "$claude_bin" "$@" || code=$?

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
