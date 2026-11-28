#!/usr/bin/env bash
# prd <command>: one front door for running PRDs in parallel worktrees.
# Run it from any worktree. Each command is a thin wrapper; the scripts beside
# this one document the details.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
bin=$(dirname "$0")
# The model plan, backlog and hotfix sessions run on unless --model names another.
agent_model=opus
# The inbox session's: Opus at low effort, for fast, accurate replies (inbox-settings.json sets low effort, fast mode off).
inbox_model=opus
# Every command runs on .nvmrc's Node, whatever shell called it.
use_node || true

usage() {
  cat <<USAGE
${prd_cmd} <command>

  See what's going on
    status                    every worktree: branch, changes, dev server link; sessions (managed or by hand);
                              the dispatcher (running, paused and why, stopped; its last line) and its code (current or
                              stale); lease holders; the load;
                              the workers (each lease, ${prd_cmd} command and slice agent: age, usual time, state)
    status-watch [seconds]    status, redrawn every few seconds (default 5) until Ctrl-C
    watch [topic] [--json] [--wait [--timeout <s>]]   each slice agent's state (ok, slow, quiet, no-progress,
                              stopped, unknown) and the next action (none, nudge, restart, skeptic); --wait
                              blocks until there is one and exits with it (75 at the timeout), run in the background
    watch [topic] --mark <slice> nudged|replied|restarted|left|asked [--until <ISO|+30m>] [--ask <id>]
                              record what was done (.loops/.watch/<topic>/; left: its recheck time)
    ready [topic]             the ready-to-land report: link, what it addresses, blockers

  Start and stop work
    start <topic>             create (or resume) a PRD's worktree and stack; prints how to open its orchestrator
    anchors [topic] [--base <ref>]   the plan's anchors on <ref> (default $trunk), run at PRD start: every
                              backticked path in an unmerged slice exists there and every symbol named
                              beside a path is in that file; warns (exit 0) on misses and line numbers,
                              exits 1 on a slice's fields error (an unknown Model)
    dispatch [--every <s>]    the dispatcher, left in a tab of its own: every minute it plans, starts and
                              reopens PRDs by itself, one action a tick, in the registry's row order; new code
                              on the main checkout re-execs it between ticks. Every exit logs why and marks
                              .dispatch.json stopped; status reads a gone pid with no mark as dead (a crash)
    dispatch --once|--dry-run one tick; --dry-run only shows the next action and every reason
    dispatch --pause [<why>]|--resume|--stop   the brakes, from any shell (the hold flag is the row's:
                              ${backlog_cmd} prd set <topic> flags+=hold why="<reason>" holds it with its reason)
    dispatch --restart        stop it (as --stop) and start one on the release the tool's command points to now,
                              in a background tab, keeping its --every and keep-alive state; none running: starts one
    queue <topic>             put the topic first in the PRD registry and return: the dispatcher takes it next
                              (or, with none running, says to start one or ${prd_cmd} start <topic>)
    plan <topic> [--open] [${backlog_id_prefix}n …]   a docs-only worktree for writing a PRD and plan; --open starts its
                              planning session here (it decides, writes both, lands them; few questions)
    plan                      no topic: a backlog and inbox planning session in the main checkout, here
                              (on opus, a \`design\` row's planner on Fable; --model <m> runs that one session on model m)
                              (it reads the backlog and helps you decide what's next; its Remote Control
                              name and tab title are a captain's, a new one each session; its record stays backlog)
    inbox [--model <m>]       the inbox agent: you tell it ideas in plain words (here or from the phone) and it
                              adds, rewords, moves or removes inbox lines on origin/dev; Opus at low effort
                              (--model <m>: another model, this session only; a reopen or rotation is Opus),
                              Remote Control "inbox", opened in its own directory outside the repository (\$RISA_INBOX_DIR, default ~/.risa/inbox; created);
                              the dispatcher keeps it open once you have opened it by hand and trusted the folder
    home [take <project|inbox>]   which machine is each project's home (and the inbox session's), from the
                              inbox store's homes.json; take moves one here: another machine's dispatcher
                              then leaves it alone within about five minutes (a project with inbox only)
    slice <topic> <n>         a slice's worktree (orchestrators run this); a stack only for Stack: yes
    hotfix <name> [--open] [--model <m>] ["<the fix>"]   a stackless worktree on ${hotfix_prefix}<name> from dev, for a fix
                              outside any PRD (reused if it exists); --open starts its session here
                              (on opus; --model <m> for another model)
                              (prompt hotfix <name> ["<the fix>"] is that session's first prompt)
                              (${prd_cmd} check there, then ${prd_cmd} land ${hotfix_prefix}<name> on your word)
    stack up|down [name]      add or remove a worktree's dev stack (slot, env files, Compose, seed)
    rm <name> [--force]       remove a worktree, its stack, its test database and, if merged, its branch
                              (from inside a ${prd_prefix} or ${plan_prefix} worktree, by its own session: then ends it)
    gc [--list|--yes]         merged slice worktrees and stacks stopped over a day: list, ask, remove
    reclaim [--list|--yes]    disk: merged worktrees, dangling Docker volumes and images, check builds and
                              Vite caches, with sizes; frees them after a yes
    tidy [--yes] [--json]     leftovers sorted into safe (merged slice and landed plan worktrees, dead tickets,
                              orphan test databases, stale remote refs, dangling stack volumes, old hang
                              logs, ended records, finished items whose topic has no ${prd_prefix} worktree) and ask
                              (finished-looking live sessions, branches without a worktree, registry rows
                              that look done); --yes removes the safe
                              ones and files the ask list as one report (prompt tidy: the haiku brief)
    finish <topic> [--dry-run] [--json]   a landed topic whose orchestrator stopped short: ends its idle
                              recorded sessions, then rm <topic> (never --force), and files one report;
                              a code tail, dirty or busy worktree is kept and reported instead
    cost [<topic>] [--json]   tokens by model for a topic's planning, orchestration and each slice, from its
                              transcripts and its ledger (.loops/.cost/<topic>.json, kept by rm); no topic: a line each
    test-db status|up|down|list|use   the shared test Postgres (a database per worktree, :5436)
    recover [--at HH:MM] [--wait] [--no-agent] [--unattended]   after a restart, crash or usage limit (one at a
                              time): Docker, stale locks, the test Postgres, stacks one at a time (a cut-off migrate
                              reruns), servers, then, only when all of those recovered, the dispatcher in a background
                              tab when it was running (its intent kept until it holds its lock); then the recovery agent here
                              (claude --remote-control recover) tells live orchestrators and planners to carry
                              on and reopens dead ones, leaving managed ones to a running dispatcher
                              (--no-agent: stop before it; --unattended: no terminal, the agent in a background tab, one
                              report on failure); --at waits until then,
                              --wait probes claude every 10 min; recover --dry-run [--json] only shows what it would do
    down                      before a planned restart: record what's up (the dispatcher too), stop the
                              dispatcher, servers, stacks, the test Postgres
    down --stay [<why>]       the same, and stay down: nothing brings it back by itself (the watchdog,
                              recover --unattended) until ${prd_cmd} recover by hand
    autostart install|remove|status   the LaunchAgent (yours to install) that runs the watchdog at login and
                              every 5 minutes from the main checkout; status: loaded, each tool on its PATH
    watchdog [--dry-run [--json]]   recover --unattended only on a reboot or crash (a down record older than
                              the boot, the dispatcher's dead lock, a hand-opened session gone); never while
                              stay-down, paused, limited or recovering; failures back off to 30 min, one report
    open <name> [--print]     reopen a recorded session in a new iTerm2 tab: claude --continue when a PRD, planner
                              or hotfix worktree has a saved conversation, else a fresh one with the resume prompt;
                              backlog and recovery sessions (main checkout) always open fresh
                              (--background: iTerm2 stays where it is and the selected tab stays selected)
    end [<name>]              end a recorded session, or with no name the calling shell's own (a finished
                              session; ${prd_cmd} rm ends a finished orchestrator or planner itself); its tab closes
    bye [--dry-run] [--json]  a session's hand-over check, when the user says just "bye": clean (no uncommitted or
                              unpushed work, worktree, branch, stack, server, running lease, background job or open
                              question of its own left), it prints the hand-off line, releases its leases and ends the
                              session (a slice only reports); else it lists each open thing and exits 3, closing nothing
    context [--keep "<why>" | --all [--json]]   this session's context size and the limit; --keep leaves it
                              alone for 30 minutes; --all lists every live session
    usage [--json]            the plan's usage limits as the sessions' status lines last read them: the 5-hour
                              and weekly (a gateway's spend limit too) use and reset times, unknown when no
                              reading is newer than \$RISA_USAGE_STALE_MIN (15) min, and the sessions
                              stopped on a rate limit (.loops/.usage/<session>.json)
    rotate [<topic>] [--mid-wave] [--reason <text>]   replace an orchestrator's session with a fresh one
    rotate --self [--brief <file>]    replace the calling backlog session (or orchestrator) with a fresh one
                              (resume prompt, same name) from a background tab; refuses an uncommitted plan or
                              slice worktrees (--mid-wave: on the user's word); prints the command without iTerm2
    session request backlog <name> [--brief <file>] [--model <m>]   ask the dispatcher for another backlog
                              session, backlog-<name> (Remote Control "backlog - <name>"); the outcome is a notice
    session requests [--json] the pending requests, and those settled in the last day

    doc <role> [section]      a role's doc as its sessions read it (the generic doc, then the project's
                              additions; or its replacement), or one section of it; no role: the roles
    project-check             the project's own data through the core's readers (the config's paths, tier
                              data, check plan rules, CI lists, role docs, never list, gates, boundary);
                              one line per problem, exit 1 on any; the tooling tests and the check run it first

  Asks (questions and reports for the dev keeper, in the main checkout's .loops/.asks)
    ask --topic <t> --question <text> --skeptic <id> [--option <a>]… [--recommend <a|n> --defaults|--waits]
                              file a question past a skeptic (the dispatcher's own need none); prints its id and the PushNotification line to send; a macOS
                              notification, and \$RISA_ASK_NOTIFY <id> <kind> <topic> <text> when set
                              (failures ignored). With a recommendation, --defaults takes it after
                              \$RISA_ASK_DEFAULT_MIN (30) min unanswered; --waits (money, data, a live
                              deploy, a destructive step, a new dependency, compliance) waits however long
    ask --decided --skeptic <id> --topic <t> --question <text> --option <a>… --chose <a|n>   file what a
                              skeptic decided: settled, never pushed, listed under decided for you
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
    prompt skeptic ask|land|plan|stall --evidence <file>   print its brief: the rules and the evidence
    skeptic record --kind ask|land|plan|stall --verdict <v> --why "<one line>" [--option <a>]
                              [--question <text> [--offer <a>]… --defaults|--waits]
                              [--tip <full sha> --action force|no-review|"decline <thread>"]
                              [--slice <n> --defaults|--waits]   (stall; --waits: a never-list step)
                              record its answer (ask: decide, ask; land: go, no; plan: go, send-back;
                              stall: restart, leave, ask);
                              prints the id; counts for \$RISA_SKEPTIC_MAX_MIN (60) min
    skeptic [list] [--topic <t>] [--json]   the verdicts, oldest first

  Notices (one-way lines for other sessions, in the main checkout's .loops/.notices; nothing waits on them)
    notice "<text>" [--for <min>] [--topic <t>]   post one line (200 characters at most); prints its id;
                              it lives 60 minutes, --for up to 1440 (24 hours)
    notices [--json]          the live ones, oldest first: session, topic, age, time left
    notices --done <id>       withdraw one
                              check, sync, slice, browser, pr, ready and land print other sessions' live
                              notices first (stderr, five lines at most); status prints the count; a code
                              landing posts "landed …: sync at your next wave boundary" for six hours

  Inside a worktree (name or topic defaults to the one you're in)
    serve [name] [--restart|--stop|--built|--dev]   its server in the background (--built: a check build)
    check [--quick "<why>"]   pnpm check (at most two at once machine-wide; RISA_CHECK_SLOTS), timed in
                              .loops/.check-times.log, and record that
                              this commit passed; --quick: typecheck, lint, format, every unit test, and the
                              integration and component test files the diff adds or edits, recorded with its
                              reason. On a ${slice_prefix} branch that is all (the slice check, against its ${prd_prefix}
                              branch). On a ${prd_prefix} or ${hotfix_prefix} branch it adds the integration tests related to
                              the diff since the last full pass. It stays quick: what the diff needs beyond it
                              is the landing's CI tier (\`tier\`); the tooling tests join when the diff touches the tooling
                              (docs and tooling-only changes need neither: prd doc orchestrator "The check gate")
    status-trim [topic] [--dry-run] [--next]   keep the plan's _Status_ short (after each landing): move the
                              hand-offs but the latest, and a fixes plan's landed waves (their paragraphs and
                              table rows), to plans/<topic>-history.md, newest first; --next: the next slice number
    wait [check|browser|<kind>] [--timeout <s>]   block until this worktree's check (or that lease kind's
                              holder or queued taker here) is gone; exit 75 at the timeout (default 160 s,
                              under the harness's ~170 s foreground limit), naming it. Wait on a background check
                              with this, never \`pgrep -f\` (it matches itself); on 75, run it again
                              Then it prints the results since the lease was taken; exit 1 on a failure,
                              or with no result recorded (rerun the check)
    check --times [--since <date>]   the check log's summary (runs, median and total minutes, failures,
                              by mode, PRD and step, the ten most-failed test files); runs no check,
                              works from any checkout
    metrics [--since <date>] [--json]   how runs are going: slice and landing durations (count, median,
                              slowest), check times by mode, the flake rate by check and overall, and
                              how many reviewed heads Codex had findings on (out of credits apart),
                              from .loops/.run-log.jsonl, the check log and the flake log; works anywhere
    sync [--force]            merge dev into this PRD branch when its changes need it (shared or risky
                              files; Markdown isn't shared); --force merges anyway, when you need code
                              another PRD landed. Dev's CI lists always come in (a commit when no merge)
    browser <check>           one browser check; at most four run at once machine-wide
    browser --changed         the checks this worktree's changes need (--base REF, --list)
    browser --smoke …         any of these in smoke mode: each check's core path only (after a merge)
    browser --suite           the lean end-to-end set, with a table (--timeout S; one retry on contention)

  CI (runs only on request; nothing starts it on a push to dev, staging or main, or on a PR)
    ci run <tier> [--ref <branch>] [--files <file>…] [--wait [min]]   push the commit to ci/<tier>/<branch>, which runs that tier (--files: only those test files, a verdict that is never a gate)
                              (static, unit, integration, components, full; each includes the ones before);
                              --wait blocks for the verdict, exiting by its kind: 0 green, 1 brake, 2 file,
                              3 flake, 4 infra, 5 unknown, 6 time; 75 at the timeout
    ci [<branch>]             the latest whole-tier verdict for the branch's tip (exits by kind, as above)
    tier [--base <ref>]       the CI tier this worktree's commits propose against <ref> (default $trunk), and why

  Land
    land <topic> [-m subject] [--tier <t> [--why "<reason>"]] [--fixes ${backlog_id_prefix}n,…] [--no-review] [--local]
                              [--force] [--skeptic <id>… | --by-user]
                              merge ${prd_prefix}<topic> into dev (only when the dev keeper says so) through its
                              PR: merged on GitHub once its head is the local tip and Codex's verdict is
                              clean and the CI gate passes, then dev-sync (--tier: the tier to wait for, by
                              default the diff's proposal; below it needs --why; --fixes: the dev brake
                              this landing fixes; --force (skip the gate) and --no-review (skip the verdict)
                              need a land skeptic's go for this tip or --by-user; out of credits needs neither;
                              --local: a local merge, the fallback, on their word)
    land ${hotfix_prefix}<name> --pr|--local [-m subject]   a hotfix: ask the user "PR or local?" each time
    land ${plan_prefix}<topic>         a plan branch: always a local merge
    land --resume <branch>    a landing cut off midway: finish it if it merged, else undo it (land again);
                              exit 3 asks (an unknown state, or a merge that isn't its own)
    review <topic|branch> [--json] [--wait [min]] [--again] [--resolve <threadId>]
                              Codex's verdict on the branch's open PR into dev (clean, findings, waiting,
                              stale) and its findings; --again asks Codex again, --resolve closes a declined
                              thread, --wait polls until Codex answers on the head (exit 0/1/2, 4 out of credits, 75 timed out);
                              a clean verdict carries over a plain dev merge
    pr <topic|${hotfix_prefix}name> [-m subject] [--tier <t> [--why "<reason>"]]   push dev (fast-forward only) and the branch, then open its PR into
                              dev, or update the open one (title: the landing subject; body: backlog items,
                              the tier and its CI verdict on the tip); ${plan_prefix} branches are refused
    dev-sync [branch]         bring the main checkout's dev up to origin/dev after a GitHub merge (land runs
                              it): fast-forward, replay unshared backlog commits, or merge; never stops on the inbox

  prompt orchestrator|plan|slice <topic> [n|--auto]   the first prompt for a session (prompt backlog: no topic)
                     recover: the recovery agent (${prd_cmd} recover opens it)
                     tidy: the cleanup brief for a cheap session (haiku), repeated with /loop
                     skeptic ask|land|plan|stall --evidence <file>: the brief for a fresh skeptic
                     orchestrator <topic> --resume [--auto]: take over after an interruption
                     slice <topic> <n> --continue: pick up an interrupted slice
USAGE
}

cmd=${1:-help}; (($#)) && shift
# The notice board (notice.mjs): other sessions' live notices on stderr, five
# lines at most, before the commands that touch shared work. It never fails
# the command (an unreadable board prints nothing).
notices_dir=${RISA_NOTICES_DIR:-$loops/.notices}
here_session() {
  local h; h=$(here_name)
  if [[ -n ${RISA_SESSION:-} ]]; then echo "$RISA_SESSION"
  elif [[ $h == plan-* ]]; then echo "$h"
  elif [[ -n $h ]]; then echo "prd-$(topic_of "$h")"; fi
}
case $cmd in
  check | sync | slice | browser | pr | ready | land)
    [[ $cmd == check && " $* " == *" --times "* ]] ||
      RISA_NOTICES_DIR=$notices_dir node "$bin/notice.mjs" gate --self "$(here_session 2>/dev/null)" 1>&2 2>/dev/null || true
    ;;
esac
case $cmd in
  status | ls) exec "$bin/ls.sh" "$@" ;;
  status-watch)
    every=${1:-5}
    [[ $every =~ ^[0-9]+$ ]] && ((every > 0)) || die "status-watch takes a whole number of seconds (default 5)"
    trap 'echo; exit 0' INT TERM
    while :; do
      # Collect first, then redraw, so the screen never sits empty while ls.sh
      # runs. A failed poll shows its error and the watch carries on.
      out=$("$bin/ls.sh" 2>&1) || out+=$'\n'"(${prd_cmd} status failed; retrying)"
      [[ -t 1 ]] && printf '\033[H\033[2J\033[3J'
      printf '%s\n\n%s  ·  every %ss  ·  Ctrl-C to stop\n' "$out" "$(date '+%H:%M:%S')" "$every"
      sleep "$every"
    done
    ;;
  ready) exec "$bin/ready.sh" "$@" ;;
  watch)
    t=""
    [[ ${1:-} == "" || ${1:-} == -* ]] || { t=$1; shift; }
    if [[ -z $t ]]; then h=$(here_name); [[ -n $h ]] || die "watch: name a topic, or run it inside its worktree"; t=$(topic_of "$h"); fi
    RISA_SESSIONS_DIR=${RISA_SESSIONS_DIR:-$loops/.sessions} RISA_ASKS_DIR=${RISA_ASKS_DIR:-$loops/.asks} \
      exec node "$bin/watch.mjs" "$t" "$@" ;;
  metrics)
    exec node "$bin/metrics.mjs" --run-log "${RISA_RUN_LOG:-$loops/.run-log.jsonl}" \
      --check-log "${RISA_CHECK_LOG:-$loops/.check-times.log}" \
      --flake-log "${RISA_BROWSER_FLAKES:-$loops/.browser-flakes.log}" "$@" ;;
  land) exec "$bin/land.sh" "$@" ;;
  # The project's dev server and test database, through the config's hooks.
  serve) stack_hook serve "$@"; exit $? ;;
  browser) exec "$bin/browser.sh" "$@" ;;
  rm) exec "$bin/rm.sh" "$@" ;;
  stack) exec "$bin/stack.sh" "$@" ;;
  gc) exec "$bin/gc.sh" "$@" ;;
  reclaim) exec "$bin/reclaim.sh" "$@" ;;
  tidy) exec node "$bin/tidy-cli.mjs" "$@" ;;
  finish) exec node "$bin/finish.mjs" "$@" ;;
  cost) exec node "$bin/cost.mjs" report "$@" ;;
  ci) exec node "$bin/../ci/ci.mjs" "$@" ;;
  wait)
    kind=check
    [[ ${1:-} == "" || ${1:-} == -* ]] || { kind=$1; shift; }
    exec "$bin/lease.sh" wait "$kind" "$@"
    ;;
  test-db | testdb) stack_hook testDb "$@"; exit $? ;;
  prompt) exec "$bin/prompt.sh" "$@" ;;
  doc) exec node "$bin/doc.mjs" "$@" ;;
  project-check) exec node "$bin/project-check.mjs" "$@" ;;
  queue) work_switch queue; exec node "$bin/queue.mjs" "$@" ;;
  status-trim)
    t=""
    [[ ${1:-} == "" || ${1:-} == -* ]] || { t=$1; shift; }
    if [[ -z $t ]]; then h=$(here_name); [[ -n $h ]] || die "status-trim: name a topic, or run it inside its worktree"; t=$(topic_of "$h"); fi
    exec node "$bin/status-trim.mjs" "$t" "$@"
    ;;
  anchors)
    t=""
    [[ ${1:-} == "" || ${1:-} == -* ]] || { t=$1; shift; }
    if [[ -z $t ]]; then h=$(here_name); [[ -n $h ]] || die "anchors: name a topic, or run it inside its worktree"; t=$(topic_of "$h"); fi
    exec node "$bin/anchors.mjs" "$t" --base "$trunk" --plans "$(config_get paths.plans)" "$@"
    ;;
  dispatch) exec node "$bin/dispatch.mjs" "$@" ;;
  recover) exec "$bin/recover.sh" "$@" ;;
  down) exec "$bin/down.sh" "$@" ;;
  autostart) exec node "$bin/autostart.mjs" "$@" --main "$main" ;;
  watchdog) RISA_USAGE_DIR=${RISA_USAGE_DIR:-$loops/.usage} exec node "$bin/watchdog.mjs" --main "$main" "$@" ;;
  open) exec "$bin/open-session.sh" "$@" ;;
  end) exec "$bin/end-session.sh" "$@" ;;
  bye) exec node "$bin/bye.mjs" "$@" ;;
  rotate) exec "$bin/rotate.sh" "$@" ;;
  context) exec node "$bin/context.mjs" "$@" ;;
  session)
    RISA_REQUESTS_DIR=${RISA_REQUESTS_DIR:-$loops/.requests} \
      RISA_SESSIONS_DIR=${RISA_SESSIONS_DIR:-$loops/.sessions} \
      exec node "$bin/session-requests.mjs" "$@"
    ;;
  review) exec "$bin/review.sh" "$@" ;;
  pr) exec "$bin/pr.sh" "$@" ;;
  tier)
    tbase=$trunk
    while (($#)); do
      case $1 in
        --base) tbase=${2:?"usage: ${prd_cmd} tier [--base <ref>]"}; shift 2 ;;
        *) die "usage: ${prd_cmd} tier [--base <ref>]" ;;
      esac
    done
    tip=$(git rev-parse HEAD) || die "not in a git worktree"
    proposed=$(propose_tier "$tbase" "$tip") || die "can't propose a tier for $tbase...HEAD"
    { read -r ptier; read -r pwhy; } <<< "$proposed"
    echo "$ptier ($pwhy)"
    [[ -z $(git status --porcelain) ]] || echo "(uncommitted changes don't count: commit them first)" >&2
    ;;
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
      # Its display name is a captain's (captain.mjs), unlike the last; the record stays backlog.
      captain=$(RISA_SESSIONS_DIR=${RISA_SESSIONS_DIR:-$loops/.sessions} node "$bin/captain.mjs" next) ||
        die "plan: couldn't pick the backlog session's captain"
      cd "$main" && exec "$wrapper" backlog --kind backlog -- \
        ${model_args[@]+"${model_args[@]}"} --remote-control "$captain" "$(RISA_CAPTAIN=$captain "$bin/prompt.sh" backlog)"
    fi
    work_switch plan
    topic=$1; shift; open=0 items=()
    for a in "$@"; do
      case $a in
        --open) open=1 ;;
        "$backlog_id_prefix"[0-9]* | "${backlog_former_prefix:-$backlog_id_prefix}"[0-9]*) items+=("$(backlog_id_normalize "$a")") ;;
        *) die "plan: unknown argument $a" ;;
      esac
    done
    dir=$loops/plan-$topic
    [[ -d $dir ]] || "$bin/new.sh" plan "$topic"
    cmd_line="cd $dir && $bin/session.sh plan-$topic -- --model $(printf %q "$model") --remote-control plan-$topic \"\$($bin/prompt.sh plan $topic ${items[*]:-})\""
    if ((open)); then
      cd "$dir" && exec "$bin/session.sh" "plan-$topic" --kind plan --topic "$topic" -- \
        ${model_args[@]+"${model_args[@]}"} --remote-control "plan-$topic" "$("$bin/prompt.sh" plan "$topic" ${items[@]+"${items[@]}"})"
    fi
    echo
    echo "Start its planning session in a new terminal (or rerun with --open):"
    echo "  $cmd_line"
    ;;
  inbox)
    # The inbox session (prompt.sh inbox): Opus at low effort, fast mode off
    # (session.sh gives the inbox kind inbox-settings.json: the context hook,
    # effortLevel and fastMode in one file), opened bare: in its own directory
    # outside the repository, so neither AGENTS.md nor the project's memory loads.
    # --dir and --managed are the reopen's and rotation's (open-session.mjs,
    # rotate-into.sh): the recorded directory, and the dispatcher's record. They
    # pass no --model, so a reopen or rotation is always on inbox_model.
    # With an inbox store (the config's inbox group) it is one session for every
    # project on this machine: opened from the main checkout of the inbox keeper
    # (home.mjs inbox-repo: the machine config's first repo with inbox whose work
    # switch is on, the one whose dispatcher keeps it alive; none on: the first
    # with inbox), so its record, name and prompt are the same whichever project
    # runs this. RISA_INBOX_FROM marks the hop, so it is made once; an inherited
    # RISA_SESSIONS_DIR (a session's, under the project it hops from) moves to the
    # keeper's, so the record lands there (RISA-1072).
    if [[ -z ${RISA_INBOX_FROM:-} ]] && config_get inbox.repo > /dev/null 2>&1; then
      home=$(node "$loops_lib_dir/home.mjs" inbox-repo) ||
        die "inbox: no repo in the machine config has an inbox group"
      if [[ -n $home && $(cd "$home" 2> /dev/null && pwd -P) != "$(cd "$main" && pwd -P)" ]]; then
        [[ -z ${RISA_SESSIONS_DIR:-} ]] || export RISA_SESSIONS_DIR=$home/.loops/.sessions
        cd "$home" && RISA_INBOX_FROM=$main exec "$loops_lib_dir/prd.sh" inbox "$@"
      fi
    fi
    unset RISA_INBOX_FROM
    model=$inbox_model dir=${RISA_INBOX_DIR:-$HOME/.risa/inbox} managed=()
    while (($#)); do
      case $1 in
        --model) [[ -n ${2:-} && ${2:-} != -* ]] || die "inbox: --model needs a model name (e.g. opus)"; model=$2; shift ;;
        --model=*) model=${1#--model=}; [[ -n $model ]] || die "inbox: --model needs a model name (e.g. opus)" ;;
        --dir) [[ -n ${2:-} ]] || die "inbox: --dir needs a directory"; dir=$2; shift ;;
        --managed) managed=(--managed) ;;
        *) die "inbox: unknown argument $1 (--model <m>, --dir <d>, --managed)" ;;
      esac
      shift
    done
    fresh=0
    [[ -d $dir ]] || { mkdir -p "$dir" || die "inbox: can't create $dir"; fresh=1; }
    dir=$(cd "$dir" && pwd -P)
    if top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null); then
      die "inbox: $dir is inside the git repository $top, where AGENTS.md would load; set RISA_INBOX_DIR to a directory outside any repository"
    fi
    d=$dir
    while :; do
      for f in CLAUDE.md CLAUDE.local.md AGENTS.md; do
        [[ ! -e $d/$f ]] || die "inbox: $d/$f would load into the inbox session; set RISA_INBOX_DIR to a directory with none above it"
      done
      [[ $d != / ]] || break
      d=$(dirname "$d")
    done
    ((fresh)) && echo "Made $dir for the inbox session. Its first open asks whether you trust this folder: choose Yes, once." >&2
    wrapper=$(cd "$bin" && pwd)/session.sh
    prompt_text=$("$bin/prompt.sh" inbox)
    cd "$dir" && RISA_MAIN=$main exec "$wrapper" inbox --kind inbox ${managed[@]+"${managed[@]}"} -- --model "$model" --remote-control inbox "$prompt_text"
    ;;
  slice) work_switch slice; exec "$bin/new.sh" slice "$@" ;;
  home) exec node "$bin/home.mjs" "$@" ;;
  hotfix)
    name=${1:?"usage: ${prd_cmd} hotfix <name> [--open] [--model <m>] [\"<the fix>\"]"}; shift; open=0 fix="" model=$agent_model
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
    echo "  cd $dir && $bin/session.sh hotfix-$name -- --model $(printf %q "$model") --remote-control hotfix-$name \"\$($bin/prompt.sh hotfix $name $(printf %q "${fix:-<the fix>}"))\""
    ;;
  start)
    topic=${1:?topic}
    work_switch start
    if [[ -d $loops/$topic ]]; then
      echo "Worktree $topic already exists at $loops/$topic."
      echo
      echo "Open its orchestrator in a new terminal:"
      echo "  cd $loops/$topic && $bin/session.sh prd-$topic -- --remote-control prd-$topic \"\$($bin/prompt.sh orchestrator $topic)\""
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
      exec node "$bin/check-times.mjs" --log "${RISA_CHECK_LOG:-$loops/.check-times.log}" ${since:+--since "$since"}
    fi
    name=$(here_name); [[ -n $name ]] || die "run ${prd_cmd} check inside a .loops worktree"
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
      [[ $(git -C "$dir" branch --show-current) == "$slice_prefix"* ]] && asked=slice
    fi
    base=$(check_base "$dir" "$asked")
    # A plan that fails (its line is above) or gives no mode runs no check.
    changed=$(git -C "$dir" diff --name-only "$base" HEAD) ||
      die "check: git couldn't list the changes since $base, so no check ran"
    plan=$(node "$bin/check-plan.mjs" --mode "$asked" --repo "$dir" --base "$base" --head HEAD <<< "$changed") ||
      die "check: the check plan (check-plan.mjs) failed, so no check ran"
    pmode="" ptooling="" pown=""
    { read -r pmode || true; read -r ptooling || true; read -r pown || true; } <<< "$plan"
    [[ -n $pmode ]] || die "check: the check plan (check-plan.mjs) gave no mode, so no check ran"
    rm -f "$record"
    # A check lease (lease.sh; RISA_CHECK_SLOTS, default 2) around it, so a
    # wave of loops finishing together doesn't run every pnpm check at once.
    # The project's check (the config's check hook) prints its own steps;
    # check-hook.sh runs it, then the tooling tests when the plan says so.
    echo "The $pmode check of the diff since ${base:0:7}${why:+ ($why)}."
    [[ $ptooling != 0 ]] && echo "The diff touches the tooling: the tooling tests join after the project's check."
    # shellcheck disable=SC2086
    (cd "$dir" && use_node && "$bin/lease.sh" run check --label "pnpm check${pmode:+ ($pmode)}" -- \
      "$bin/check-run.sh" "$pmode" "$why" -- "$bin/check-hook.sh" "$pmode" "$base" "$ptooling" $pown)
    if [[ $pmode == quick || $pmode == slice ]]; then
      echo "$(git -C "$dir" rev-parse HEAD) quick $base $why" > "$record"
      echo "quick check passed on $(git -C "$dir" rev-parse --short HEAD) ($(git -C "$dir" branch --show-current)): $why"
    else
      echo "$(git -C "$dir" rev-parse HEAD) full" > "$record"
      echo "pnpm check passed on $(git -C "$dir" rev-parse --short HEAD) ($(git -C "$dir" branch --show-current))"
    fi
    ;;
  sync)
    name=$(here_name); [[ -n $name ]] || die "run ${prd_cmd} sync inside a PRD's worktree"
    dir=$loops/$name; branch=$(git -C "$dir" branch --show-current)
    [[ $branch == "$prd_prefix"* || $branch == "$plan_prefix"* || $branch == "$hotfix_prefix"* ]] ||
      die "$branch isn't a $prd_prefix, $plan_prefix or $hotfix_prefix branch"
    # shellcheck source=unsynced.sh
    source "$bin/unsynced.sh"
    unsynced_clear "$dir"
    sync_force=""
    case ${1:-} in
      "") ;;
      --force) sync_force=1 ;;
      *) die "sync: unknown option $1 (--force merges even when dev's changes don't need it)" ;;
    esac
    # CI reads the branch's own copy of its two lists, so a sync always brings
    # dev's in. A list-only change keeps a CI verdict (check-plan.mjs, keepsVerdict).
    lists=$(trunk_lists "$branch")
    if [[ -z $(trunk_drift "$branch") && -z $lists ]]; then
      echo "$branch is up to date with $trunk (only backlog commits are newer, if any)"
    elif [[ -z $(trunk_drift "$branch") ]]; then
      git -C "$dir" merge --no-ff -m "chore(${branch#*/}): merge $trunk into $branch (CI lists)" "$trunk"
      echo "Merged $trunk's CI lists into $branch (nothing else but backlog commits). No recheck needed"
    elif [[ -z $sync_force ]] && unsynced_safe "$branch" "$trunk"; then
      if [[ -n $lists ]]; then
        # shellcheck disable=SC2086
        git -C "$dir" checkout "$trunk" -- $lists
        # shellcheck disable=SC2086
        git -C "$dir" commit -q -m "chore(${branch#*/}): take $trunk's CI lists" -- $lists
        echo "Took $trunk's CI lists ($(echo $lists | tr ' ' ',')) into $branch"
      fi
      echo "$branch needs no merge: $trunk's changes share no file with it and bring nothing risky. No recheck needed (${prd_cmd} sync --force merges anyway, when you need that code)"
    else
      git -C "$dir" merge --no-ff -m "chore(${branch#*/}): merge $trunk into $branch" "$trunk"
      echo "Merged $trunk into $branch. If seeds or migrations changed: $(project_command datastoreReset). Then: ${prd_cmd} check"
    fi
    ;;
  ask | asks | answer)
    # The asking session and topic default to the worktree's: plan-<t> → plan-<t>, else prd-<topic>.
    export RISA_ASKS_DIR=${RISA_ASKS_DIR:-$loops/.asks}
    export RISA_SKEPTIC_DIR=${RISA_SKEPTIC_DIR:-$loops/.skeptic}
    here=$(here_name) here_args=()
    if [[ $cmd == ask && -n $here ]]; then
      if [[ $here == plan-* ]]; then here_args=(--here-topic "${here#plan-}" --here-session "$here")
      else here_topic=$(topic_of "$here"); here_args=(--here-topic "$here_topic" --here-session "prd-$here_topic"); fi
    fi
    exec node "$bin/ask.mjs" "$cmd" "$@" ${here_args[@]+"${here_args[@]}"}
    ;;
  skeptic)
    # The recording session and topic default to the worktree's, as for ask.
    export RISA_SKEPTIC_DIR=${RISA_SKEPTIC_DIR:-$loops/.skeptic}
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
    RISA_NOTICES_DIR=$notices_dir exec node "$bin/notice.mjs" "$cmd" "$@" ${here_args[@]+"${here_args[@]}"}
    ;;
  usage) RISA_USAGE_DIR=${RISA_USAGE_DIR:-$loops/.usage} exec node "$bin/usage.mjs" "$@" ;;
  help | -h | --help) usage ;;
  *) usage >&2; exit 1 ;;
esac
