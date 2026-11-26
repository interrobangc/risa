#!/usr/bin/env bash
# The sample project's stack hooks, for the core's tests: every stack hook
# (stackUp … stackLeftovers, serve, testDb) as one script, its first word the
# verb, with no engine, containers or databases behind it: only files.
# config-fixture.mjs's stubHookConfig points a config's hooks here.
#
#   stack up DIR [--slot N] [--base B]   DIR/.sample-stack gets its facts; it runs
#   stack down DIR [--base B]            its facts; .sample-stack goes
#   stack status DIR                     its facts (none: nothing)
#   stack status --slot N [--probe]      slot=N; --probe: in_use=yes when N is in busy-slots
#   stack ready DIR                      its facts, containers=1/1 or 0/1, ready=yes|no
#                                        (exit 1 unless yes); stopped: stopped_secs=
#                                        (DIR/.sample-stopped-secs, else 60)
#   stack stop DIR | start DIR           stops or starts it, data kept; its facts
#                                        (start: migrating=yes first; "migrate:<name>"
#                                        in $SAMPLE_STACK_FAIL fails it after that)
#   stack engine [status|start]          running=yes|no, name=Sample engine
#   stack leftovers [--all] [PROJECT…]   the lines of leftovers (volume=…) but a PROJECT's
#                                        (named PROJECT or PROJECT_…); engine down: a kept= line
#   stack leftovers remove KIND ID       drops ID's line
#   serve NAME [--stop|--restart|--built] its server: listens on its web_port
#   test-db facts|status|up|down|use NAME|drop NAME|drop-db DB|orphans [NAME…]|list|name NAME
#
# A worktree's stack is DIR/.sample-stack, its facts as key=value lines (project=,
# slot=, web_port=, url=); a test may write one itself. State, in
# $SAMPLE_STACK_STATE (required):
#   running        the projects that run, one a line
#   engine-down    the engine isn't running (engine start removes it)
#   listen         the ports a server listens on
#   testdb-up      the test database server runs
#   testdb-orphans its orphan databases, one a line
#   leftovers      the leftovers' fact lines
#   busy-slots     slots in use outside the tool, one a line
# Each call is logged to $SAMPLE_STACK_LOG (else $SAMPLE_STACK_STATE/calls) as
# "<verb> <args>", a path shown by its last part, then " (record)" when the file
# $SAMPLE_STACK_MARK exists. $SAMPLE_STACK_FAIL: words "<verb>:<name>" (stack
# verbs without "stack", "engine:start", "test-db:<sub>") whose calls fail.
set -uo pipefail
st=${SAMPLE_STACK_STATE:?stack-hook.sh: SAMPLE_STACK_STATE unset}
mkdir -p "$st"
logf=${SAMPLE_STACK_LOG:-$st/calls}
kind=${1:-}; (($#)) && shift
verb=${1:-}; [[ $kind == stack ]] && { (($#)) && shift; }

shown=()
for a in "$@"; do if [[ $a == /* ]]; then shown+=("$(basename "$a")"); else shown+=("$a"); fi; done
rec=""; [[ -n ${SAMPLE_STACK_MARK:-} && -f $SAMPLE_STACK_MARK ]] && rec=" (record)"
line="$kind"; [[ $kind == stack ]] && line="$kind $verb"
echo "$line${shown[*]:+ ${shown[*]}}$rec" >> "$logf"

fails() { [[ " ${SAMPLE_STACK_FAIL:-} " == *" $1 "* ]]; }
get() { sed -n "s/^$1=//p" "$2" 2>/dev/null | tail -1; }
running() { grep -qx "$1" "$st/running" 2>/dev/null; }
set_running() {
  touch "$st/running"
  grep -vx "$1" "$st/running" > "$st/.r" || true
  mv "$st/.r" "$st/running"
  [[ $2 == no ]] || echo "$1" >> "$st/running"
}
die() { echo "stack-hook.sh: $*" >&2; exit 1; }

if [[ $kind == stack ]]; then
  dir="" slot="" probe="" rest=()
  while (($#)); do
    case $1 in
      --slot) slot=$2; shift 2 ;;
      --base) shift 2 ;;
      --probe) probe=1; shift ;;
      --all) shift ;;
      *) if [[ -z $dir ]]; then dir=$1; else rest+=("$1"); fi; shift ;;
    esac
  done
  name=$(basename "${dir:-.}")
  fails "$verb:$name" && die "$verb failed for $name"
  file=$dir/.sample-stack
  proj=$(get project "$file")
  case $verb in
    up)
      if [[ -z $proj ]]; then
        [[ -n $slot ]] || die "up: $name has no stack, so it needs --slot"
        port=$((6000 + slot * 100 + 73))
        printf 'slot=%s\nproject=sample-loop%s\nweb_port=%s\nurl=http://localhost:%s\n' \
          "$slot" "$slot" "$port" "$port" > "$file"
        proj=sample-loop$slot
      fi
      set_running "$proj" yes
      cat "$file"; echo "summary=sample stack $proj"
      ;;
    down)
      [[ -n $proj ]] || exit 0
      set_running "$proj" no
      cat "$file"; rm -f "$file"
      ;;
    status)
      if [[ -n $slot ]]; then
        echo "slot=$slot"
        [[ -z $probe ]] || { if grep -qx "$slot" "$st/busy-slots" 2>/dev/null; then echo "in_use=yes"; else echo "in_use=no"; fi; }
        exit 0
      fi
      [[ -z $proj ]] || cat "$file"
      ;;
    ready)
      [[ -n $proj ]] || { echo "containers=0/0"; echo "ready=no"; exit 1; }
      cat "$file"
      if running "$proj"; then echo "containers=1/1"; echo "ready=yes"; exit 0; fi
      echo "stopped_secs=$(cat "$dir/.sample-stopped-secs" 2>/dev/null || echo 60)"
      echo "containers=0/1"; echo "ready=no"; exit 1
      ;;
    stop)
      [[ -n $proj ]] || exit 0
      set_running "$proj" no; cat "$file"
      ;;
    start)
      [[ -n $proj ]] || die "start: $name has no stack"
      [[ ! -f $st/engine-down ]] || die "start: the engine isn't running"
      echo "migrating=yes"
      fails "migrate:$name" && die "start: the migrate failed for $name"
      set_running "$proj" yes; cat "$file"
      ;;
    engine)
      case ${dir:-status} in
        status) if [[ -f $st/engine-down ]]; then echo "running=no"; else echo "running=yes"; fi ;;
        start) fails engine:start && die "the engine didn't start"; rm -f "$st/engine-down"; echo "running=yes" ;;
        *) die "engine: status or start" ;;
      esac
      echo "name=Sample engine"
      ;;
    leftovers)
      if [[ $dir == remove ]]; then
        id=${rest[1]:-}
        grep -v "^${rest[0]:-}=$id " "$st/leftovers" > "$st/.l" 2>/dev/null || true
        mv "$st/.l" "$st/leftovers"
        exit 0
      fi
      [[ ! -f $st/engine-down ]] || { echo "kept=the engine isn't running"; exit 0; }
      # A PROJECT's own (PROJECT or PROJECT_<anything>) is in use: not a leftover.
      while IFS= read -r l; do
        v=${l#*=}; v=${v%% *} used=""
        for p in $dir ${rest[@]+"${rest[@]}"}; do [[ $v == "$p" || $v == "$p"_* ]] && used=1; done
        [[ -n $used ]] || echo "$l"
      done < <(cat "$st/leftovers" 2>/dev/null)
      ;;
    *) die "unknown stack verb ${verb:-(none)}" ;;
  esac
  exit 0
fi

case $kind in
  serve)
    name=${1:-$(basename "$PWD")}
    fails "serve:$name" && die "serve failed for $name"
    main=$(git worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')
    port=$(get web_port "$main/.loops/$name/.sample-stack")
    [[ -n $port ]] || die "serve: $name has no stack"
    touch "$st/listen"
    grep -vx "$port" "$st/listen" > "$st/.l" || true
    mv "$st/.l" "$st/listen"
    [[ ${2:-} == --stop ]] && exit 0
    echo "$port" >> "$st/listen"
    echo "$name is running at http://localhost:$port"
    ;;
  test-db)
    sub=${1:-status}
    fails "test-db:$sub" && die "test-db $sub failed"
    case $sub in
      facts) echo "port=5999"; echo "project=sample-test"
        if [[ -f $st/testdb-up ]]; then echo "running=yes"; else echo "running=no"; fi ;;
      status) if [[ -f $st/testdb-up ]]; then echo "sample test database: running"; else echo "sample test database: stopped"; fi ;;
      up) touch "$st/testdb-up" ;;
      down) rm -f "$st/testdb-up" ;;
      name) echo "sample_${2:-}" ;;
      use) echo "database=sample_${2:-}"; echo "port=5999"; echo "summary=sample test database sample_${2:-}" ;;
      drop | drop-db | create) ;;
      orphans) sed 's/^/orphan=/' "$st/testdb-orphans" 2>/dev/null || true ;;
      list) cat "$st/testdb-orphans" 2>/dev/null || true ;;
      *) die "unknown test-db verb $sub" ;;
    esac
    ;;
  *) die "unknown hook ${kind:-(none)}" ;;
esac
