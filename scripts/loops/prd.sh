#!/usr/bin/env bash
# pnpm prd <command>: one front door for running PRDs in parallel worktrees.
# Run it from any worktree. Each command is a thin wrapper; the scripts beside
# this one document the details.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
bin=$(dirname "$0")
# The model plan, backlog and hotfix sessions run on unless --model names another.
agent_model=opus
# Every command runs on .nvmrc's Node, whatever shell called it.
use_node || true

usage() {
  cat <<USAGE
pnpm prd <command>

  See what's going on
    status                    every worktree: branch, changes, dev server link; sessions (managed or by hand);
                              the dispatcher (running, paused and why, stopped; its last line); lease holders; the load
    status-watch [seconds]    status, redrawn every few seconds (default 5) until Ctrl-C
    ready [topic]             the ready-to-land report: link, what it addresses, blockers

  Start and stop work
    start <topic>             create (or resume) a PRD's worktree and stack; prints how to open its orchestrator
    dispatch [--every <s>]    the dispatcher, left in a tab of its own: every minute it plans, starts and
                              reopens PRDs by itself, one action a tick, in the registry's row order
    dispatch --once|--dry-run one tick; --dry-run only shows the next action and every reason
    dispatch --pause [<why>]|--resume|--stop   the brakes, from any shell (the hold flag is the row's)
    queue <topic>             put the topic first in the PRD registry and return: the dispatcher takes it next
                              (or, with none running, says to start one or pnpm prd start <topic>)
    plan <topic> [--open] [B-n …]   a docs-only worktree for writing a PRD and plan; --open starts its
                              planning session here (it decides, writes both, lands them; few questions)
    plan                      no topic: a backlog and inbox planning session in the main checkout, here
                              (on opus, a `design` row's planner on Fable; --model <m> runs that one session on model m)
                              (it reads the backlog and helps you decide what's next)
    slice <topic> <n>         a slice's worktree (orchestrators run this); a stack only for Stack: yes
    hotfix <name> [--open] [--model <m>] ["<the fix>"]   a stackless worktree on hotfix/<name> from dev, for a fix
                              outside any PRD (reused if it exists); --open starts its session here
                              (on opus; --model <m> for another model)
                              (prompt hotfix <name> ["<the fix>"] is that session's first prompt)
                              (pnpm prd check there, then pnpm prd land hotfix/<name> on your word)
    stack up|down [name]      add or remove a worktree's dev stack (slot, env files, Compose, seed)
    rm <name> [--force]       remove a worktree, its stack, its test database and, if merged, its branch
    gc [--list|--yes]         merged slice worktrees and stacks stopped over a day: list, ask, remove
    reclaim [--list|--yes]    disk: merged worktrees, dangling Docker volumes and images, check builds and
                              Vite caches, with sizes; frees them after a yes
    tidy [--yes] [--json]     leftovers sorted into safe (merged slice and landed plan worktrees, dead tickets,
                              orphan test databases, stale remote refs, dangling caretook volumes, old hang
                              logs, ended records) and ask (finished-looking live sessions, branches without a
                              worktree, items to archive, registry rows that look done); --yes removes the safe
                              ones and files the ask list as one report (prompt tidy: the haiku brief)
    test-db status|up|down|list|use   the shared test Postgres (a database per worktree, :5436)
    recover [--at HH:MM] [--wait] [--no-agent]   after a restart, crash or usage limit: Docker, stale locks,
                              the test Postgres, stacks one at a time, servers, the dispatcher in a background
                              tab when it was running (its lock cleared when its pid is gone); then the recovery agent here
                              (claude --remote-control recover) tells live orchestrators and planners to carry
                              on and reopens dead ones, leaving managed ones to a running dispatcher
                              (--no-agent: stop before it); --at waits until then,
                              --wait probes claude every 10 min; recover --dry-run [--json] only shows what it would do
    down                      before a planned restart: record what's up (the dispatcher too), stop the
                              dispatcher, servers, stacks, the test Postgres
    open <name> [--print]     reopen a recorded session in a new iTerm2 tab: claude --continue when a PRD, planner
                              or hotfix worktree has a saved conversation, else a fresh one with the resume prompt;
                              backlog and recovery sessions (main checkout) always open fresh
                              (--background: iTerm2 stays where it is and the selected tab stays selected)
    end [<name>]              end a recorded session, or with no name the calling shell's own (a finished
                              orchestrator or planner, after pnpm prd rm); its tab closes
    context [--keep "<why>" | --all [--json]]   this session's context size and the limit; --keep leaves it
                              alone for 30 minutes; --all lists every live session
    rotate [<topic>] [--mid-wave] [--reason <text>]   replace an orchestrator's session with a fresh one
    rotate --self [--brief <file>]    replace the calling backlog session (or orchestrator) with a fresh one
                              (resume prompt, same name) from a background tab; refuses an uncommitted plan or
                              slice worktrees (--mid-wave: on the user's word); prints the command without iTerm2
    session request backlog <name> [--brief <file>] [--model <m>]   ask the dispatcher for another backlog
                              session, backlog-<name> (Remote Control "backlog - <name>"); the outcome is a notice
    session requests [--json] the pending requests, and those settled in the last day

  Asks (questions and reports for the dev keeper, in the main checkout's .loops/.asks)
    ask --topic <t> --question <text> [--option <a>]… [--recommend <a|n> --defaults|--waits]   file a
                              question; prints its id and the PushNotification line to send; a macOS
                              notification, and \$CARETOOK_ASK_NOTIFY <id> <kind> <topic> <text> when set
                              (failures ignored). With a recommendation, --defaults takes it after
                              \$CARETOOK_ASK_DEFAULT_MIN (30) min unanswered; --waits (money, data, a live
                              deploy, a destructive step, a new dependency, compliance) waits however long
    ask --topic <t> --report <text>   file a report (a landed wave, what to try); never pushed (no
                              PushNotification line); the same macOS notification and hook
    ask --wait <id> [--timeout <s>]   print the answer once there is one (exit 0; 75 at the timeout);
                              applies a due default and says so
    asks [--json]             the open asks: topic, age, options numbered, the recommended one marked,
                              a defaulting one's countdown; then the ones decided for you
    asks --done <id>          dismiss one (a read report, a question no longer needed)
    answer <id> <n|text>      answer a question by its option's number or in words (wakes its --wait;
                              refused once defaulted)

  Skeptic (a fresh subagent's verdict before an ask or a risky landing, in the main checkout's .loops/.skeptic)
    prompt skeptic ask|land|plan --evidence <file>   print its brief: the rules and the evidence
    skeptic record --kind ask|land|plan --verdict <v> --why "<one line>" [--option <a>]
                              [--question <text> [--offer <a>]… --defaults|--waits]
                              [--tip <full sha> --action force|no-review|"decline <thread>"]
                              record its answer (ask: decide, ask; land: go, no; plan: go, send-back);
                              prints the id; counts for \$CARETOOK_SKEPTIC_MAX_MIN (60) min
    skeptic [list] [--topic <t>] [--json]   the verdicts, oldest first

  Notices (one-way lines for other sessions, in the main checkout's .loops/.notices; nothing waits on them)
    notice "<text>" [--for <min>] [--topic <t>]   post one line (200 characters at most); prints its id;
                              it lives 60 minutes, --for up to 1440 (24 hours)
    notices [--json]          the live ones, oldest first: session, topic, age, time left
    notices --done <id>       withdraw one
                              check, sync, slice, browser, pr, ready and land print other sessions' live
                              notices first (stderr, five lines at most); status prints them all; a code
                              landing posts "landed …: sync at your next wave boundary" for six hours

  Inside a worktree (name or topic defaults to the one you're in)
    serve [name] [--restart|--stop|--built|--dev]   its server in the background (--built: a check build)
    check [--quick "<why>"]   pnpm check (at most two at once machine-wide; CARETOOK_CHECK_SLOTS), timed in
                              .loops/.check-times.log, and record that
                              this commit passed; --quick: typecheck, lint, format, every unit test, and the
                              integration and component test files the diff adds or edits, recorded with its
                              reason. On a slice/ branch that is all (the slice check, against its prd/
                              branch). On a prd/ or hotfix/ branch it adds the integration tests related to
                              the diff since the last full pass, and a diff touching a migration, seeds, the
                              sync config, a lockfile, a package.json (beyond its scripts) or the Vitest config makes it a full
                              check; the tooling tests join when the diff touches the tooling
                              (docs and tooling-only changes need neither: docs/agents/orchestrator.md, _The check gate_)
    wait [check|browser|<kind>] [--timeout <s>]   block until this worktree's check (or that lease kind's
                              holder or queued taker here) is gone; exit 75 at the timeout (default 3600 s),
                              naming it. Wait on a background check with this, never \`pgrep -f\` (it matches itself)
    check --times [--since <date>]   the check log's summary (runs, median and total minutes, failures,
                              by mode, PRD and step, the ten most-failed test files); runs no check,
                              works from any checkout
    sync                      merge dev into this PRD branch
    browser <check>           one browser check; at most four run at once machine-wide
    browser --changed         the checks this worktree's changes need (--base REF, --list)
    browser --smoke …         any of these in smoke mode: each check's core path only (after a merge)
    browser --suite           the lean end-to-end set, with a table (--timeout S; one retry on contention)

  CI (runs only on request; nothing starts it on a push to dev, staging or main, or on a PR)
    ci run <tier> [--ref <branch>] [--files <file>…] [--wait [min]]   push the commit to ci/<tier>/<branch>, which runs that tier (--files: only those test files, a verdict that is never a gate)
                              (static, unit, integration, components, full; each includes the ones before);
                              --wait blocks for the verdict (0 green, 1 not green, 75 at the timeout)
    ci [<branch>]             the latest whole-tier verdict for the branch's tip

  Land
    land <topic> [-m subject] [--tier <t> [--why "<reason>"]] [--fixes B-n,…] [--no-review] [--local]
                              merge prd/<topic> into dev (only when the dev keeper says so) through its
                              PR: merged on GitHub once its head is the local tip and Codex's verdict is
                              clean and the CI gate passes, then dev-sync (--tier: the tier to wait for, by
                              default the diff's proposal; below it needs --why; --fixes: the dev brake
                              this landing fixes; --no-review: skip the verdict, on the user's word only;
                              --local: a local merge, the fallback, on their word)
    land hotfix/<name> --pr|--local [-m subject]   a hotfix: ask the user "PR or local?" each time
    land plan/<topic>         a plan branch: always a local merge
    review <topic|branch> [--json] [--wait [min]] [--again] [--resolve <threadId>]
                              Codex's verdict on the branch's open PR into dev (clean, findings, waiting,
                              stale) and its findings; --again asks Codex again, --resolve closes a declined
                              thread, --wait polls until Codex answers on the head (exit 0/1/2, 4 out of credits, 75 timed out);
                              a clean verdict carries over a plain dev merge
    pr <topic|hotfix/name> [-m subject] [--tier <t> [--why "<reason>"]]   push dev (fast-forward only) and the branch, then open its PR into
                              dev, or update the open one (title: the landing subject; body: backlog items,
                              the check pass); plan/ branches are refused
    dev-sync [branch]         bring the main checkout's dev up to origin/dev after a GitHub merge (land runs
                              it): fast-forward, rebase backlog-only commits, or merge

  prompt orchestrator|plan|slice <topic> [n|--auto]   the first prompt for a session (prompt backlog: no topic)
                     recover: the recovery agent (pnpm prd recover opens it)
                     tidy: the cleanup brief for a cheap session (haiku), repeated with /loop
                     skeptic ask|land|plan --evidence <file>: the brief for a fresh skeptic
                     orchestrator <topic> --resume [--auto]: take over after an interruption
                     slice <topic> <n> --continue: pick up an interrupted slice
USAGE
}

cmd=${1:-help}; (($#)) && shift
# The notice board (notice.mjs): other sessions' live notices on stderr, five
# lines at most, before the commands that touch shared work. It never fails
# the command (an unreadable board prints nothing).
notices_dir=${CARETOOK_NOTICES_DIR:-$loops/.notices}
here_session() {
  local h; h=$(here_name)
  if [[ -n ${CARETOOK_SESSION:-} ]]; then echo "$CARETOOK_SESSION"
  elif [[ $h == plan-* ]]; then echo "$h"
  elif [[ -n $h ]]; then echo "prd-$(topic_of "$h")"; fi
}
case $cmd in
  check | sync | slice | browser | pr | ready | land)
    [[ $cmd == check && " $* " == *" --times "* ]] ||
      CARETOOK_NOTICES_DIR=$notices_dir node "$bin/notice.mjs" gate --self "$(here_session 2>/dev/null)" 1>&2 2>/dev/null || true
    ;;
esac
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
  tidy) exec node "$bin/tidy-cli.mjs" "$@" ;;
  ci) exec node "$bin/../ci/ci.mjs" "$@" ;;
  wait)
    kind=check
    [[ ${1:-} == "" || ${1:-} == -* ]] || { kind=$1; shift; }
    exec "$bin/lease.sh" wait "$kind" "$@"
    ;;
  test-db | testdb) exec "$bin/test-db.sh" "$@" ;;
  prompt) exec "$bin/prompt.sh" "$@" ;;
  queue) exec node "$bin/queue.mjs" "$@" ;;
  dispatch) exec node "$bin/dispatch.mjs" "$@" ;;
  recover) exec "$bin/recover.sh" "$@" ;;
  down) exec "$bin/down.sh" "$@" ;;
  open) exec "$bin/open-session.sh" "$@" ;;
  end) exec "$bin/end-session.sh" "$@" ;;
  rotate) exec "$bin/rotate.sh" "$@" ;;
  context) exec node "$bin/context.mjs" "$@" ;;
  session)
    CARETOOK_REQUESTS_DIR=${CARETOOK_REQUESTS_DIR:-$loops/.requests} \
      CARETOOK_SESSIONS_DIR=${CARETOOK_SESSIONS_DIR:-$loops/.sessions} \
      exec node "$bin/session-requests.mjs" "$@"
    ;;
  review) exec "$bin/review.sh" "$@" ;;
  pr) exec "$bin/pr.sh" "$@" ;;
  dev-sync) (($# <= 1)) || die "dev-sync: at most one branch name"; dev_sync "${1:-}" ;;
  plan)
    # --model <m> (or --model=<m>), anywhere: this one session's model, passed to claude --model
    # (default: $agent_model, opus; a topic's planner on Fable when its row is flagged design).
    model="" rest=()
    while (($#)); do
      case $1 in
        --model) [[ -n ${2:-} && ${2:-} != -* ]] || die "plan: --model needs a model name (e.g. opus)"; model=$2; shift ;;
        --model=*) model=${1#--model=}; [[ -n $model ]] || die "plan: --model needs a model name (e.g. opus)" ;;
        *) rest+=("$1") ;;
      esac
      shift
    done
    set -- ${rest[@]+"${rest[@]}"}
    if [[ -z $model && -n ${1:-} && $1 != --open ]]; then
      model=$(node "$bin/planner-model.mjs" "$1" "$main" 2>/dev/null) || model=""
    fi
    model=${model:-$agent_model}
    model_args=(--model "$model")
    if [[ ${1:-} == "" || ${1:-} == --open ]]; then
      (($# <= 1)) || die "plan: give a topic before other arguments"
      wrapper=$(cd "$bin" && pwd)/session.sh
      cd "$main" && exec "$wrapper" backlog --kind backlog -- \
        ${model_args[@]+"${model_args[@]}"} --remote-control backlog "$("$bin/prompt.sh" backlog)"
    fi
    topic=$1; shift; open=0 items=()
    for a in "$@"; do
      case $a in --open) open=1 ;; B-[0-9]*) items+=("$a") ;; *) die "plan: unknown argument $a" ;; esac
    done
    dir=$loops/plan-$topic
    [[ -d $dir ]] || "$bin/new.sh" plan "$topic"
    cmd_line="cd $dir && scripts/loops/session.sh plan-$topic -- --model $(printf %q "$model") --remote-control plan-$topic \"\$(scripts/loops/prompt.sh plan $topic ${items[*]:-})\""
    if ((open)); then
      cd "$dir" && exec "$bin/session.sh" "plan-$topic" --kind plan --topic "$topic" -- \
        ${model_args[@]+"${model_args[@]}"} --remote-control "plan-$topic" "$("$bin/prompt.sh" plan "$topic" ${items[@]+"${items[@]}"})"
    fi
    echo
    echo "Start its planning session in a new terminal (or rerun with --open):"
    echo "  $cmd_line"
    ;;
  slice) exec "$bin/new.sh" slice "$@" ;;
  hotfix)
    name=${1:?"usage: pnpm prd hotfix <name> [--open] [--model <m>] [\"<the fix>\"]"}; shift; open=0 fix="" model=$agent_model
    while (($#)); do
      case $1 in
        --open) open=1 ;;
        --model) [[ -n ${2:-} && ${2:-} != -* ]] || die "hotfix: --model needs a model name (e.g. opus)"; model=$2; shift ;;
        --model=*) model=${1#--model=}; [[ -n $model ]] || die "hotfix: --model needs a model name (e.g. opus)" ;;
        -*) die "hotfix: unknown option $1 (--open, --model <m>)" ;;
        *) [[ -z $fix ]] || die "hotfix: give the fix as one quoted argument"; fix=$1 ;;
      esac
      shift
    done
    dir=$loops/hotfix-$name
    if [[ -d $dir ]]; then echo "Worktree hotfix-$name already exists at $dir."; else "$bin/new.sh" hotfix "$name"; fi
    if ((open)); then
      wrapper=$(cd "$bin" && pwd)/session.sh
      cd "$dir" && exec "$wrapper" "hotfix-$name" --kind hotfix --topic "$name" -- \
        --model "$model" --remote-control "hotfix-$name" "$("$bin/prompt.sh" hotfix "$name" ${fix:+"$fix"})"
    fi
    echo
    echo "Start its session in a new terminal (or rerun with --open; or carry on in the one that asked for it):"
    echo "  cd $dir && scripts/loops/session.sh hotfix-$name -- --model $(printf %q "$model") --remote-control hotfix-$name \"\$(scripts/loops/prompt.sh hotfix $name $(printf %q "${fix:-<the fix>}"))\""
    ;;
  start)
    topic=${1:?topic}
    if [[ -d $loops/$topic ]]; then
      echo "Worktree $topic already exists at $loops/$topic."
      echo
      echo "Open its orchestrator in a new terminal:"
      echo "  cd $loops/$topic && scripts/loops/session.sh prd-$topic -- --remote-control prd-$topic \"\$(scripts/loops/prompt.sh orchestrator $topic)\""
    else
      exec "$bin/new.sh" prd "$@"
    fi
    ;;
  check)
    if [[ " $* " == *" --times "* ]]; then  # the summary runs no check, from any checkout
      since=""
      while (($#)); do
        case $1 in
          --times) ;;
          --since) since=${2:-}; [[ -n $since ]] || die "check --since needs a date"; shift ;;
          *) die "check --times takes only --since <date>" ;;
        esac
        shift
      done
      exec node "$bin/check-times.mjs" --log "${CARETOOK_CHECK_LOG:-$loops/.check-times.log}" ${since:+--since "$since"}
    fi
    name=$(here_name); [[ -n $name ]] || die "run pnpm prd check inside a .loops worktree"
    dir=$loops/$name; quick=0 why=""
    while (($#)); do
      case $1 in
        --quick) quick=1; why=${2:-}; [[ -n $why && $why != -* ]] || die "check --quick needs a reason: --quick \"<why>\""; shift ;;
        *) die "check: unknown argument $1 (--quick \"<why>\"; --times [--since <date>])" ;;
      esac
      shift
    done
    # shellcheck source=unsynced.sh
    source "$bin/unsynced.sh"
    unsynced_clear "$dir"
    [[ -z $(git -C "$dir" status --porcelain) ]] || die "commit your changes first: the check is recorded against a commit"
    record=$(checked_file "$dir")
    # The plan (check-plan.mjs) names the diff's own tests, and the tooling tests
    # join when it touches the tooling. A quick check stays quick: what a diff needs
    # beyond it is the landing's tier. A slice's --quick is the slice check.
    asked=full
    if ((quick)); then
      asked=quick
      [[ $(git -C "$dir" branch --show-current) == slice/* ]] && asked=slice
    fi
    base=$(check_base "$dir" "$asked")
    { read -r pmode; read -r ptooling; read -r pown; } < <(
      git -C "$dir" diff --name-only "$base" HEAD | node "$bin/check-plan.mjs" --mode "$asked" --repo "$dir" --base "$base" --head HEAD)
    rm -f "$record"
    # A check lease (lease.sh; CARETOOK_CHECK_SLOTS, default 2) around it, so a
    # wave of loops finishing together doesn't run every pnpm check at once.
    if [[ $pmode == slice ]]; then
      echo "Slice check against ${base:0:7}: typecheck, lint, format, every unit test, and the integration and component tests this diff adds or edits ($why)"
    elif [[ $pmode == quick ]]; then
      echo "Quick check against ${base:0:7}: typecheck, lint, format, every unit test, the integration tests related to the diff, and the component tests it adds or edits ($why)"
    fi
    [[ $ptooling != 0 ]] && echo "The diff touches the tooling: the tooling tests (pnpm test:tooling) join."
    # shellcheck disable=SC2086
    (cd "$dir" && use_node && "$bin/lease.sh" run check --label "pnpm check${pmode:+ ($pmode)}" -- \
      "$bin/check-run.sh" "$pmode" "$why" -- "$bin/check-body.sh" "$pmode" "$base" "$ptooling" $pown)
    if [[ $pmode == quick || $pmode == slice ]]; then
      echo "$(git -C "$dir" rev-parse HEAD) quick $base $why" > "$record"
      echo "quick check passed on $(git -C "$dir" rev-parse --short HEAD) ($(git -C "$dir" branch --show-current)): $why"
    else
      echo "$(git -C "$dir" rev-parse HEAD) full" > "$record"
      echo "pnpm check passed on $(git -C "$dir" rev-parse --short HEAD) ($(git -C "$dir" branch --show-current))"
    fi
    ;;
  sync)
    name=$(here_name); [[ -n $name ]] || die "run pnpm prd sync inside a PRD's worktree"
    dir=$loops/$name; branch=$(git -C "$dir" branch --show-current)
    [[ $branch == prd/* || $branch == plan/* || $branch == hotfix/* ]] || die "$branch isn't a prd/, plan/ or hotfix/ branch"
    # shellcheck source=unsynced.sh
    source "$bin/unsynced.sh"
    unsynced_clear "$dir"
    if [[ -z $(trunk_drift "$branch") ]]; then
      echo "$branch is up to date with $trunk (only backlog commits are newer, if any)"
    else
      git -C "$dir" merge --no-ff -m "chore(${branch#*/}): merge $trunk into $branch" "$trunk"
      echo "Merged $trunk into $branch. If seeds or migrations changed: pnpm datastore:reset. Then: pnpm prd check"
    fi
    ;;
  ask | asks | answer)
    # The asking session and topic default to the worktree's: plan-<t> → plan-<t>, else prd-<topic>.
    export CARETOOK_ASKS_DIR=${CARETOOK_ASKS_DIR:-$loops/.asks}
    here=$(here_name) here_args=()
    if [[ $cmd == ask && -n $here ]]; then
      if [[ $here == plan-* ]]; then here_args=(--here-topic "${here#plan-}" --here-session "$here")
      else here_topic=$(topic_of "$here"); here_args=(--here-topic "$here_topic" --here-session "prd-$here_topic"); fi
    fi
    exec node "$bin/ask.mjs" "$cmd" "$@" ${here_args[@]+"${here_args[@]}"}
    ;;
  skeptic)
    # The recording session and topic default to the worktree's, as for ask.
    export CARETOOK_SKEPTIC_DIR=${CARETOOK_SKEPTIC_DIR:-$loops/.skeptic}
    here=$(here_name) here_args=()
    if [[ ${1:-} == record && -n $here ]]; then
      if [[ $here == plan-* ]]; then here_args=(--here-topic "${here#plan-}" --here-session "$here")
      else here_topic=$(topic_of "$here"); here_args=(--here-topic "$here_topic" --here-session "prd-$here_topic"); fi
    fi
    exec node "$bin/skeptic.mjs" "$@" ${here_args[@]+"${here_args[@]}"}
    ;;
  notice | notices)
    # The posting session and topic default to the worktree's, as for ask.
    here=$(here_name) here_args=()
    if [[ $cmd == notice && -n $here ]]; then
      if [[ $here == plan-* ]]; then here_args=(--here-topic "${here#plan-}" --here-session "$here")
      else here_topic=$(topic_of "$here"); here_args=(--here-topic "$here_topic" --here-session "prd-$here_topic"); fi
    fi
    CARETOOK_NOTICES_DIR=$notices_dir exec node "$bin/notice.mjs" "$cmd" "$@" ${here_args[@]+"${here_args[@]}"}
    ;;
  help | -h | --help) usage ;;
  *) usage >&2; exit 1 ;;
esac
