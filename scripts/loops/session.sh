#!/usr/bin/env bash
# Run an orchestrator's or planner's claude session and record it.
#
#   session.sh <name> [--kind prd|plan] [--topic <t>] [--auto] -- <claude args…>
#
# Runs ${CARETOOK_CLAUDE_BIN:-claude} with the args as this script's child, in
# the foreground (the terminal stays the session's), and keeps
# .loops/.sessions/<name>.json (sessions.mjs): at start pid, kind, topic,
# started, the command and auto, clearing rotating, ended and exit; when it
# exits, ended and exit. It exits with the session's code. The record stays
# until rm.sh removes the worktree.
#
# The kind and topic default from the name (prd-<topic>, plan-<topic>). The
# pid is the claude process itself: a shell that records its own pid, then
# execs claude.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
bin=$(cd "$(dirname "$0")" && pwd)
export CARETOOK_SESSIONS_DIR=${CARETOOK_SESSIONS_DIR:-$loops/.sessions}

name=${1:-}; (($#)) && shift
[[ -n $name && $name != -* ]] || die "usage: session.sh <name> [--kind prd|plan] [--topic <t>] [--auto] -- <claude args…>"
kind="" topic="" auto=false
case $name in prd-*) kind=prd topic=${name#prd-} ;; plan-*) kind=plan topic=${name#plan-} ;; esac
while (($#)); do
  case $1 in
    --kind) kind=${2:?--kind prd|plan}; shift ;;
    --topic) topic=${2:?--topic <t>}; shift ;;
    --auto) auto=true ;;
    --) shift; break ;;
    *) die "session.sh: unknown option $1 (--kind, --topic, --auto, then -- and claude's args)" ;;
  esac
  shift
done
[[ $kind == prd || $kind == plan ]] || die "session.sh: --kind prd|plan (none from the name $name)"
claude_bin=${CARETOOK_CLAUDE_BIN:-claude}

# The command as a line, each long argument (the prompt) cut short.
command=$claude_bin
for a in "$@"; do
  ((${#a} > 120)) && a="${a:0:117}..."
  command+=" $(printf %q "$a")"
done

record() { node "$bin/sessions.mjs" set "$name" "$@"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# The child records its own pid, then becomes claude, so the recorded pid is
# the session's. In the foreground, so claude keeps the terminal and its input.
code=0
bash -c 'node "$1" set "$2" pid=$$ kind="$3" topic="$4" started="$5" command="$6" auto="$7" rotating= ended= exit= &&
  shift 7 && exec "$@"' _ \
  "$bin/sessions.mjs" "$name" "$kind" "$topic" "$(now)" "$command" "$auto" "$claude_bin" "$@" || code=$?

record ended="$(now)" exit="$code" || echo "session.sh: couldn't record the end of $name" >&2
exit "$code"
