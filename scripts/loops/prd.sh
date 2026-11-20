#!/usr/bin/env bash
# pnpm prd <command>: one front door for running PRDs in parallel worktrees.
# Run it from any worktree. Each command is a thin wrapper; the scripts beside
# this one document the details.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
bin=$(dirname "$0")
# Every command runs on .nvmrc's Node, whatever shell called it.
use_node || true

usage() {
  cat <<USAGE
pnpm prd <command>

  See what's going on
    status                    every worktree: branch, changes, dev server link; lease holders; the load
    status-watch [seconds]    status, redrawn every few seconds (default 5) until Ctrl-C
    ready [topic]             the ready-to-land report: link, what it addresses, blockers

  Start and stop work
    start <topic>             create (or resume) a PRD's worktree and stack; prints how to open its orchestrator
    queue <topic> [--manual]  wait for a free PRD slot (in queue order), then create the worktree and open a
                              fully autonomous orchestrator in this terminal (--manual: it asks how to land)
    plan <topic> [--open] [B-n …]   a docs-only worktree for writing a PRD and plan; --open starts its
                              planning session here (it interviews you, writes both, lands them)
    plan                      no topic: a backlog and inbox planning session in the main checkout, here
                              (it reads the backlog and helps you decide what's next)
    slice <topic> <n>         a slice's worktree (orchestrators run this); a stack only for Stack: yes
    hotfix <name> [--open] ["<the fix>"]   a stackless worktree on hotfix/<name> from dev, for a fix
                              outside any PRD (reused if it exists); --open starts its session here
                              (prompt hotfix <name> ["<the fix>"] is that session's first prompt)
                              (pnpm prd check there, then pnpm prd land hotfix/<name> on your word)
    stack up|down [name]      add or remove a worktree's dev stack (slot, env files, Compose, seed)
    rm <name> [--force]       remove a worktree, its stack, its test database and, if merged, its branch
    gc [--list|--yes]         merged slice worktrees and stacks stopped over a day: list, ask, remove
    reclaim [--list|--yes]    disk: merged worktrees, dangling Docker volumes and images, check builds and
                              Vite caches, with sizes; frees them after a yes
    test-db status|up|down|list|use   the shared test Postgres (a database per worktree, :5436)
    recover [--at HH:MM] [--wait] [--no-agent]   after a restart, crash or usage limit: Docker, stale locks,
                              the test Postgres, stacks one at a time, servers; then the recovery agent here
                              (claude --remote-control recover) tells live orchestrators and planners to carry
                              on and reopens dead ones (--no-agent: stop before it); --at waits until then,
                              --wait probes claude every 10 min; recover --dry-run [--json] only shows what it would do
    down                      before a planned restart: record what's up, stop servers, stacks, the test Postgres
    open <name> [--print]     reopen a PRD's or planner's session in a new iTerm2 tab: claude --continue when the
                              worktree has a saved conversation, else a fresh one with the resume prompt

  Inside a worktree (name or topic defaults to the one you're in)
    serve [name] [--restart|--stop|--built|--dev]   its server in the background (--built: a check build)
    check [--quick "<why>"]   pnpm check (at most three at once machine-wide), and record that
                              this commit passed; --quick: typecheck, lint, format and only the tests
                              related to the diff since the last full pass, recorded with its reason
                              (docs and tooling-only changes need neither: docs/loops.md, _The check gate_)
    sync                      merge dev into this PRD branch
    browser <check>           one browser check; at most four run at once machine-wide
    browser --changed         the checks this worktree's changes need (--base REF, --list)
    browser --smoke …         any of these in smoke mode: each check's core path only (after a merge)
    browser --suite           the lean end-to-end set, with a table (--timeout S; one retry on contention)

  Land
    land <topic> [-m subject] merge prd/<topic> into dev (only when the dev keeper says so)

  prompt orchestrator|plan|slice <topic> [n|--auto]   the first prompt for a session (prompt backlog: no topic)
                     recover: the recovery agent (pnpm prd recover opens it)
                     orchestrator <topic> --resume [--auto]: take over after an interruption
                     slice <topic> <n> --continue: pick up an interrupted slice
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
  stack) exec "$bin/stack.sh" "$@" ;;
  gc) exec "$bin/gc.sh" "$@" ;;
  reclaim) exec "$bin/reclaim.sh" "$@" ;;
  test-db | testdb) exec "$bin/test-db.sh" "$@" ;;
  prompt) exec "$bin/prompt.sh" "$@" ;;
  queue) exec "$bin/queue.sh" "$@" ;;
  recover) exec "$bin/recover.sh" "$@" ;;
  down) exec "$bin/down.sh" "$@" ;;
  open) exec "$bin/open-session.sh" "$@" ;;
  plan)
    if [[ ${1:-} == "" || ${1:-} == --open ]]; then
      (($# <= 1)) || die "plan: give a topic before other arguments"
      cd "$main" && exec claude --remote-control backlog "$("$bin/prompt.sh" backlog)"
    fi
    topic=$1; shift; open=0 items=()
    for a in "$@"; do
      case $a in --open) open=1 ;; B-[0-9]*) items+=("$a") ;; *) die "plan: unknown argument $a" ;; esac
    done
    dir=$loops/plan-$topic
    [[ -d $dir ]] || "$bin/new.sh" plan "$topic"
    cmd_line="cd $dir && claude --remote-control plan-$topic \"\$(scripts/loops/prompt.sh plan $topic ${items[*]:-})\""
    if ((open)); then
      cd "$dir" && exec claude --remote-control "plan-$topic" "$("$bin/prompt.sh" plan "$topic" ${items[@]+"${items[@]}"})"
    fi
    echo
    echo "Start its planning session in a new terminal (or rerun with --open):"
    echo "  $cmd_line"
    ;;
  slice) exec "$bin/new.sh" slice "$@" ;;
  hotfix)
    name=${1:?"usage: pnpm prd hotfix <name> [--open] [\"<the fix>\"]"}; shift; open=0 fix=""
    for a in "$@"; do
      case $a in
        --open) open=1 ;;
        -*) die "hotfix: unknown option $a (--open)" ;;
        *) [[ -z $fix ]] || die "hotfix: give the fix as one quoted argument"; fix=$a ;;
      esac
    done
    dir=$loops/hotfix-$name
    if [[ -d $dir ]]; then echo "Worktree hotfix-$name already exists at $dir."; else "$bin/new.sh" hotfix "$name"; fi
    if ((open)); then
      cd "$dir" && exec claude --remote-control "hotfix-$name" "$("$bin/prompt.sh" hotfix "$name" ${fix:+"$fix"})"
    fi
    echo
    echo "Start its session in a new terminal (or rerun with --open; or carry on in the one that asked for it):"
    echo "  cd $dir && claude --remote-control hotfix-$name \"\$(scripts/loops/prompt.sh hotfix $name $(printf %q "${fix:-<the fix>}"))\""
    ;;
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
    dir=$loops/$name; quick=0 why=""
    while (($#)); do
      case $1 in
        --quick) quick=1; why=${2:-}; [[ -n $why && $why != -* ]] || die "check --quick needs a reason: --quick \"<why>\""; shift ;;
        *) die "check: unknown argument $1 (--quick \"<why>\")" ;;
      esac
      shift
    done
    [[ -z $(git -C "$dir" status --porcelain) ]] || die "commit your changes first: the check is recorded against a commit"
    record=$(checked_file "$dir")
    if ((quick)); then
      # The base is the last full pass (or a quick pass's own base) when it's
      # an ancestor of HEAD, else where the branch left dev.
      read -r prev mode qbase _ 2>/dev/null < "$record" || true
      [[ ${mode:-} == quick ]] && prev=$qbase
      if [[ -n ${prev:-} ]] && git -C "$dir" merge-base --is-ancestor "$prev" HEAD 2>/dev/null; then base=$prev
      else base=$(git -C "$dir" merge-base "$trunk" HEAD); fi
    fi
    rm -f "$record"
    # A check lease (lease.sh; CARETOOK_CHECK_SLOTS, default 3) around it, so a
    # wave of loops finishing together doesn't run every pnpm check at once.
    if ((quick)); then
      echo "Quick check against ${base:0:7}: typecheck, lint, format, and the tests related to the diff ($why)"
      (cd "$dir" && use_node && "$bin/lease.sh" run check --label "pnpm check --quick" -- \
        sh -c 'pnpm typecheck && pnpm lint && pnpm format:check && pnpm exec vitest run --changed "$1" --passWithNoTests' _ "$base")
      echo "$(git -C "$dir" rev-parse HEAD) quick $base $why" > "$record"
      echo "quick check passed on $(git -C "$dir" rev-parse --short HEAD) ($(git -C "$dir" branch --show-current)): $why"
    else
      (cd "$dir" && use_node && "$bin/lease.sh" run check --label "pnpm check" -- pnpm check)
      echo "$(git -C "$dir" rev-parse HEAD) full" > "$record"
      echo "pnpm check passed on $(git -C "$dir" rev-parse --short HEAD) ($(git -C "$dir" branch --show-current))"
    fi
    ;;
  sync)
    name=$(here_name); [[ -n $name ]] || die "run pnpm prd sync inside a PRD's worktree"
    dir=$loops/$name; branch=$(git -C "$dir" branch --show-current)
    [[ $branch == prd/* || $branch == plan/* || $branch == hotfix/* ]] || die "$branch isn't a prd/, plan/ or hotfix/ branch"
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
