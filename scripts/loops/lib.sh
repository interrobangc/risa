#!/usr/bin/env bash
# Shared by the scripts in scripts/loops/. Source it; don't run it.

# The main checkout (the first worktree; it stays on dev). Every other worktree
# lives in $main/.loops.
main=$(git -C "$(dirname "${BASH_SOURCE[0]}")" worktree list --porcelain | awk 'NR==1{print $2}')
loops=$main/.loops
leases=$loops/.slots
trunk=${TRUNK:-dev}
max_prds=${CARETOOK_MAX_PRDS:-3}

# parent_of BRANCH → the branch it merges into:
#   slice/<topic>/<n> → prd/<topic>;  prd/* and plan/* → trunk.
parent_of() {
  case $1 in
    slice/*/*) local t=${1#slice/}; echo "prd/${t%/*}" ;;
    *) echo "$trunk" ;;
  esac
}

# slot_ports N → sets web, pg, pgt, ps and off for slot N (1-19).
#   1-9:   web 6N73, Postgres 6N34, test Postgres 6N35, PowerSync 6N80
#   10-19: the same with 7(N-10) in place of 6N: 7073 … 7980
#   CDP and proxy ports shift by N*1000 (CDP_PORT_OFFSET).
slot_ports() {
  local n=$1 p
  if ((n < 10)); then p=6$n; else p=7$((n - 10)); fi
  web=${p}73 pg=${p}34 pgt=${p}35 ps=${p}80 off=$((n * 1000))
}

# slot_busy N → true when slot N is leased, named by a worktree's .env, or one of
# its ports is listening.
slot_busy() {
  local n=$1 f p
  [[ -e $leases/$n ]] && return 0
  for f in "$loops"/*/.env; do
    [[ -f $f ]] && grep -qx "CARETOOK_STACK=caretook-loop$n" "$f" && return 0
  done
  slot_ports "$n"
  for p in $web $pg $pgt $ps; do
    lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  done
  return 1
}

# lease_slot N NAME → atomically claim slot N for NAME (mkdir is the lock).
lease_slot() {
  mkdir -p "$leases"
  mkdir "$leases/$1" 2>/dev/null || return 1
  echo "$2" > "$leases/$1/name"
}

# release_slot NAME → drop every lease NAME holds.
release_slot() {
  local d
  for d in "$leases"/*/; do
    [[ -f $d/name && $(cat "$d/name") == "$1" ]] && rm -rf "$d"
  done
  return 0
}

# env_get FILE KEY → the value of KEY in an env file, or nothing.
env_get() { [[ -f $1 ]] && grep "^$2=" "$1" | tail -1 | cut -d= -f2- | tr -d '"' || true; }

# prd_count → how many PRD integration worktrees exist.
prd_count() {
  local d n=0
  for d in "$loops"/*/; do
    [[ $(git -C "$d" branch --show-current 2>/dev/null) == prd/* ]] && n=$((n + 1))
  done
  echo "$n"
}

die() { echo "$*" >&2; exit 1; }

# here_name → the name of the .loops worktree the shell is in, or nothing.
here_name() {
  local top
  top=$(git rev-parse --show-toplevel 2>/dev/null) || return 0
  [[ $top == "$loops"/* ]] && basename "$top"
  return 0
}

# topic_of NAME → the PRD topic of a worktree name or branch (prd/x, x, x-3 → x).
topic_of() {
  local b
  b=$(git -C "$loops/$1" branch --show-current 2>/dev/null || echo "$1")
  case $b in
    slice/*/*) b=${b#slice/}; echo "${b%/*}" ;;
    prd/*) echo "${b#prd/}" ;;
    *) echo "$1" ;;
  esac
}

# web_port DIR → the dev server port of a stacked worktree, or nothing.
web_port() { env_get "$1/apps/web/.env" WEB_PORT; }

# server_pids PORT → pids listening on PORT.
server_pids() { lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; }

# stop_server DIR → stop the worktree's dev server, if one is running.
stop_server() {
  local port pids
  port=$(web_port "$1"); [[ -n $port ]] || return 0
  pids=$(server_pids "$port"); [[ -n $pids ]] || return 0
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
}

# checked_file DIR → where `pnpm prd check` records the commit it passed on
# (in the worktree's git dir, so it never shows up as a change).
checked_file() { echo "$(git -C "$1" rev-parse --absolute-git-dir)/caretook-checked"; }

# use_node → Node 24 from .nvmrc (the machine default is older).
use_node() {
  export NVM_DIR=${NVM_DIR:-$HOME/.nvm}
  # shellcheck disable=SC1091
  source "$NVM_DIR/nvm.sh" >/dev/null && nvm use >/dev/null
}

# trunk_drift BRANCH → the files dev changed since BRANCH last merged it, other
# than the backlog files (pnpm backlog commits those onto dev all day, and they
# never affect a branch's code). Empty means BRANCH is up to date with dev.
trunk_drift() {
  git -C "$main" diff --name-only "$1...$trunk" | grep -vxF -e plans/backlog.md -e plans/inbox.md || true
}

# Browser check leases (pnpm prd browser): at most $browser_slots checks run at
# once, machine-wide. A lease is the directory $browser_leases/<N> (mkdir is the
# lock), holding a `name` file of key=value lines: worktree, check, pid (the
# browser.sh that holds it), started (epoch seconds).
browser_leases=$loops/.browser
browser_slots=${CARETOOK_BROWSER_SLOTS:-2}

# browser_lease_field DIR KEY → one field of a lease's name file.
browser_lease_field() { env_get "$1/name" "$2"; }

# browser_lease_alive DIR → true while the lease's holder is running. A lease
# with no name file yet is being taken (alive) unless it's over a minute old.
browser_lease_alive() {
  local pid
  if [[ ! -f $1/name ]]; then
    [[ -d $1 ]] || return 1
    (($(date +%s) - $(stat -f %m "$1" 2>/dev/null || echo 0) < 60))
    return
  fi
  pid=$(browser_lease_field "$1" pid)
  [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= 2>/dev/null | grep -q browser.sh
}

# browser_lease_line DIR → "worktree: check (pid P, 3m12s)" for messages.
browser_lease_line() {
  local started
  [[ -f $1/name ]] || { echo "(being taken)"; return; }
  started=$(browser_lease_field "$1" started)
  printf '%s: %s (pid %s, %s)' "$(browser_lease_field "$1" worktree)" "$(browser_lease_field "$1" check)" \
    "$(browser_lease_field "$1" pid)" "$(fmt_secs $(($(date +%s) - ${started:-$(date +%s)})))"
}

# fmt_secs N → 1m05s.
fmt_secs() { printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); }

# load_avg → the 1, 5 and 15 minute load averages.
load_avg() { sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | xargs || uptime | sed 's/.*load average[s]*: //'; }
