#!/usr/bin/env bash
# Reopen a recorded session in a new iTerm2 tab. (pnpm prd open)
#
#   open-session.sh <name> [--print] [--background] [--carry-on]
#                                      <name> is a .loops worktree
#                                      on a prd/, plan/ or hotfix/ branch (a topic,
#                                      plan-<topic>, hotfix-<name>), else a recorded
#                                      backlog or recovery session (main checkout)
#                                      or the inbox session (its own directory)
#   open-session.sh --command <line> --title <title> [--print] [--background]
#                                      any command line in a new tab (rotation's)
#
# open-session.mjs chooses the command, started through session.sh so it is
# recorded: `claude --continue --remote-control <session>` when the worktree has
# a saved Claude conversation (and its record isn't marked rotating), else a
# fresh session with the resume prompt (prompt.sh orchestrator <topic> --resume,
# plus --auto when the plan's _Status_ or the last record says run-through;
# prompt.sh plan for a planner, with --auto for a run-through one). The record's
# managed (the dispatcher's) is carried over. Sessions keep their names (the
# main backlog session's tab and Remote Control take a new captain's). A
# hotfix continues in its worktree; backlog and recovery sessions always start
# fresh in the main checkout, whose saved conversations may be anyone's, and
# the inbox session fresh in its recorded directory (prd.sh inbox --dir). These
# kinds are refused while their record is live.
#
# --carry-on (the dispatcher's resume after a usage limit) gives a continued prd or
# plan session the carry-on prompt as its first message (open-session.mjs).
#
# It opens the command in a new iTerm2 tab (osascript) and writes it to that
# tab as `exec`, so the tab closes when the session ends: in the current
# window, else (iTerm2 hidden, minimised, no key window) the first window, else
# a new window. --background leaves
# iTerm2 where it is (no activate) and selects the tab that was selected
# before. Without iTerm2, or with --print, it prints the command instead, to
# paste into a terminal.
#
# Env: CARETOOK_ITERM_APP (default /Applications/iTerm.app: where iTerm2 is
# looked for); CARETOOK_CLAUDE_PROJECTS (default ~/.claude/projects).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
bin=$(dirname "$0")
export CARETOOK_SESSIONS_DIR=${CARETOOK_SESSIONS_DIR:-$loops/.sessions}

name="" print=0 background=0 command="" title="" carry=()
while (($#)); do
  case $1 in
    --print) print=1 ;;
    --background) background=1 ;;
    --carry-on) carry=(--carry-on) ;;
    --command) command=${2:?--command <line>}; shift ;;
    --title) title=${2:?--title <title>}; shift ;;
    -h | --help) sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "open: unknown option $1 (--print, --background, --carry-on)" ;;
    *) [[ -z $name ]] || die "open: one worktree at a time"; name=$1 ;;
  esac
  shift
done
if [[ -n $command ]]; then
  [[ -z $name ]] || die "open: a worktree or --command, not both"
  session=${title:-session} how="its command" title=""
else
  [[ -n $name ]] || die "usage: pnpm prd open <name> [--print] [--background]"
  dir=$loops/$name
  if [[ -d $dir ]]; then
    choice=$(node "$bin/open-session.mjs" "$dir" ${carry[@]+"${carry[@]}"}) || exit 1
  else
    choice=$(node "$bin/open-session.mjs" --main "$name" "$main") || exit 1
  fi
  field() { node -e 'process.stdout.write(String(JSON.parse(process.argv[1])[process.argv[2]] ?? ""))' "$choice" "$1"; }
  session=$(field session) mode=$(field mode) command=$(field command)
  # The tab's title: the choice's (the main backlog session's captain), else the session's name.
  title=$(field title)
  [[ $title != "$session" ]] || title=""
  if [[ $mode == continue ]]; then how="continuing its saved conversation"; else how="a fresh session with the resume prompt"; fi
fi

# tab_line COMMAND → what the tab runs: the command exec'd (after its cd), so
# the tab's shell is the session and the tab closes when it ends.
tab_line() {
  if [[ $1 =~ ^(cd [^\&]+ \&\& )(.*)$ ]]; then echo "${BASH_REMATCH[1]}exec ${BASH_REMATCH[2]}"; else echo "exec $1"; fi
}

iterm=${CARETOOK_ITERM_APP:-/Applications/iTerm.app}
if ((print == 0)) && [[ -d $iterm ]] && command -v osascript >/dev/null 2>&1; then
  # Writes to the tab it made (never "the current session"), and with
  # --background neither activates iTerm2 nor leaves the new tab selected.
  osascript - "$(tab_line "$command")" "${title:-$session}" "$background" >/dev/null <<'APPLESCRIPT'
on run argv
  set cmd to item 1 of argv
  set tabTitle to item 2 of argv
  set quiet to (item 3 of argv is "1")
  tell application "iTerm2"
    if not quiet then activate
    -- current window is missing value when iTerm2 is hidden, minimised or has
    -- no key window (B-468): then the first window, else a new window.
    set theWindow to missing value
    try
      set theWindow to current window
    end try
    if theWindow is missing value then
      try
        set theWindow to first window
      end try
    end if
    set newSession to missing value
    if theWindow is not missing value then
      set previousTab to missing value
      try
        set previousTab to current tab of theWindow
      end try
      try
        tell theWindow
          set newTab to (create tab with default profile)
        end tell
        set newSession to current session of newTab
      end try
      if quiet and previousTab is not missing value then
        try
          tell previousTab to select
        end try
      end if
    end if
    if newSession is missing value then
      set newWindow to (create window with default profile)
      set newSession to current session of newWindow
    end if
    tell newSession
      set name to tabTitle
      write text cmd
    end tell
  end tell
end run
APPLESCRIPT
  if ((background)); then where="a new background iTerm2 tab"; else where="a new iTerm2 tab"; fi
  echo "Opened $session${title:+ as $title} in $where ($how)."
  exit 0
fi

if ((print == 0)); then echo "iTerm2 isn't here ($iterm): run this in a new terminal to open $session${title:+ as $title} ($how):"; else echo "$session${title:+ as $title} ($how):"; fi
echo "  $command"
