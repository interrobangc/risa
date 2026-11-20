#!/usr/bin/env bash
# Reopen a PRD's or planner's session in a new iTerm2 tab. (pnpm prd open)
#
#   open-session.sh <name> [--print]   <name> is a .loops worktree on a prd/ or
#                                      plan/ branch (a topic, or plan-<topic>)
#
# open-session.mjs chooses the command: `claude --continue --remote-control
# <session>` when the worktree has a saved Claude conversation, else a fresh
# session with the resume prompt (prompt.sh orchestrator <topic> --resume, plus
# --auto when the plan's _Status_ records run-through; prompt.sh plan for a
# planner). Sessions keep their names, prd-<topic> and plan-<topic>.
#
# It opens the command in a new iTerm2 tab (osascript). Without iTerm2, or with
# --print, it prints the command instead, to paste into a terminal.
#
# Env: CARETOOK_ITERM_APP (default /Applications/iTerm.app: where iTerm2 is
# looked for); CARETOOK_CLAUDE_PROJECTS (default ~/.claude/projects).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
bin=$(dirname "$0")

name="" print=0
while (($#)); do
  case $1 in
    --print) print=1 ;;
    -h | --help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "open: unknown option $1 (--print)" ;;
    *) [[ -z $name ]] || die "open: one worktree at a time"; name=$1 ;;
  esac
  shift
done
[[ -n $name ]] || die "usage: pnpm prd open <name> [--print]"
dir=$loops/$name
[[ -d $dir ]] || die "open: no worktree $name in $loops"

choice=$(node "$bin/open-session.mjs" "$dir") || exit 1
field() { node -e 'process.stdout.write(String(JSON.parse(process.argv[1])[process.argv[2]]))' "$choice" "$1"; }
session=$(field session) mode=$(field mode) command=$(field command)
if [[ $mode == continue ]]; then how="continuing its saved conversation"; else how="a fresh session with the resume prompt"; fi

iterm=${CARETOOK_ITERM_APP:-/Applications/iTerm.app}
if ((print == 0)) && [[ -d $iterm ]] && command -v osascript >/dev/null 2>&1; then
  osascript - "$command" "$session" >/dev/null <<'APPLESCRIPT'
on run argv
  set cmd to item 1 of argv
  tell application "iTerm2"
    activate
    if (count of windows) is 0 then
      create window with default profile
    else
      tell current window to create tab with default profile
    end if
    tell current session of current window
      set name to item 2 of argv
      write text cmd
    end tell
  end tell
end run
APPLESCRIPT
  echo "Opened $session in a new iTerm2 tab ($how)."
  exit 0
fi

if ((print == 0)); then echo "iTerm2 isn't here ($iterm): run this in a new terminal to open $session ($how):"; else echo "$session ($how):"; fi
echo "  $command"
