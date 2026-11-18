#!/usr/bin/env bash
# pnpm prd <command>: one front door for running PRDs in parallel worktrees.
# Run it from any worktree. Each command is a thin wrapper; the scripts beside
# this one document the details.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
bin=$(dirname "$0")

usage() {
  cat <<USAGE
pnpm prd <command>

  See what's going on
    status                    every worktree: branch, changes, dev server link
    status-watch [seconds]    status, redrawn every few seconds (default 5) until Ctrl-C
    ready [topic]             the ready-to-land report: link, what it addresses, blockers

  Start and stop work
    start <topic>             create (or resume) a PRD's worktree and stack; prints how to open its orchestrator
    plan <topic>              a docs-only worktree for writing a PRD or plan
    slice <topic> <n>         a slice's worktree and stack (orchestrators run this)
    rm <name> [--force]       remove a worktree, its stack and, if merged, its branch

  Inside a worktree (name or topic defaults to the one you're in)
    serve [name] [--restart|--stop|--built|--dev]   its server in the background (--built: a check build)
    check                     pnpm check, and record that this commit passed
    sync                      merge dev into this PRD branch
    browser <check>           one browser check; at most four run at once machine-wide
    browser --changed         the checks this worktree's changes need (--base REF, --list)
    browser --suite           every check, with a table (--timeout S; one retry on contention)

  Land
    land <topic> [-m subject] merge prd/<topic> into dev (only when the dev keeper says so)

  prompt orchestrator|slice <topic> [n]   the first prompt for a session
USAGE
}

cmd=${1:-help}; (($#)) && shift
case $cmd in
  status | ls) exec "$bin/ls.sh" "$@" ;;
  status-watch | watch)
    every=${1:-5}
    [[ $every =~ ^[0-9]+$ ]] && ((every > 0)) || die "status-watch takes a whole number of seconds (default 5)"
    trap 'echo; exit 0' INT TERM
    while :; do
      # Collect first, then redraw, so the screen never sits empty while ls.sh
      # runs. A failed poll shows its error and the watch carries on.
      out=$("$bin/ls.sh" 2>&1) || out+=$'\n'"(pnpm prd status failed; retrying)"
      [[ -t 1 ]] && printf '\033[H\033[2J\033[3J'
      printf '%s\n\n%s  ·  every %ss  ·  Ctrl-C to stop\n' "$out" "$(date '+%H:%M:%S')" "$every"
      sleep "$every"
    done
    ;;
  ready) exec "$bin/ready.sh" "$@" ;;
  land) exec "$bin/land.sh" "$@" ;;
  serve) exec "$bin/serve.sh" "$@" ;;
  browser) exec "$bin/browser.sh" "$@" ;;
  rm) exec "$bin/rm.sh" "$@" ;;
  prompt) exec "$bin/prompt.sh" "$@" ;;
  plan) exec "$bin/new.sh" plan "$@" ;;
  slice) exec "$bin/new.sh" slice "$@" ;;
  start)
    topic=${1:?topic}
    if [[ -d $loops/$topic ]]; then
      echo "Worktree $topic already exists at $loops/$topic."
      echo
      echo "Open its orchestrator in a new terminal:"
      echo "  cd $loops/$topic && claude --remote-control prd-$topic \"\$(scripts/loops/prompt.sh orchestrator $topic)\""
    else
      exec "$bin/new.sh" prd "$@"
    fi
    ;;
  check)
    name=$(here_name); [[ -n $name ]] || die "run pnpm prd check inside a .loops worktree"
    dir=$loops/$name
    rm -f "$(checked_file "$dir")"
    [[ -z $(git -C "$dir" status --porcelain) ]] || die "commit your changes first: the check is recorded against a commit"
    (cd "$dir" && use_node && pnpm check)
    git -C "$dir" rev-parse HEAD > "$(checked_file "$dir")"
    echo "pnpm check passed on $(git -C "$dir" rev-parse --short HEAD) ($(git -C "$dir" branch --show-current))"
    ;;
  sync)
    name=$(here_name); [[ -n $name ]] || die "run pnpm prd sync inside a PRD's worktree"
    dir=$loops/$name; branch=$(git -C "$dir" branch --show-current)
    [[ $branch == prd/* || $branch == plan/* ]] || die "$branch isn't a prd/ or plan/ branch"
    if [[ -z $(trunk_drift "$branch") ]]; then
      echo "$branch is up to date with $trunk (only backlog commits are newer, if any)"
    else
      git -C "$dir" merge --no-ff -m "chore(${branch#*/}): merge $trunk into $branch" "$trunk"
      echo "Merged $trunk into $branch. If seeds or migrations changed: pnpm datastore:reset. Then: pnpm prd check"
    fi
    ;;
  help | -h | --help) usage ;;
  *) usage >&2; exit 1 ;;
esac
