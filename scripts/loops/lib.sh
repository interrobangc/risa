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
#   slice/<topic>/<n> → prd/<topic>;  prd/*, plan/* and hotfix/* → trunk.
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

# checked_ok DIR REV → succeeds when `pnpm prd check` passed on REV, or on an
# ancestor of it with only Markdown changed since (AGENTS.md: docs-only changes
# skip `pnpm check`).
checked_ok() {
  local checked tip
  checked=$(cat "$(checked_file "$1")" 2>/dev/null || true)
  tip=$(git -C "$1" rev-parse "$2")
  [[ -n $checked ]] || return 1
  [[ $checked == "$tip" ]] && return 0
  git -C "$1" merge-base --is-ancestor "$checked" "$tip" 2>/dev/null || return 1
  [[ -z $(git -C "$1" diff --name-only "$checked" "$tip" | grep -v '\.md$') ]]
}

# use_node → put the Node that .nvmrc names (here, else the main checkout's)
# first on PATH, with the pnpm beside it. Scripts call this themselves, so no
# shell needs `nvm use` first. It doesn't rely on `nvm use` taking: in agent
# shells another node (PNPM_HOME's) sits ahead of nvm's on PATH. Returns 1 when
# that Node isn't installed.
use_node() {
  local want dir
  want=$(cat .nvmrc 2>/dev/null || cat "$main/.nvmrc" 2>/dev/null || echo 24)
  want=${want#v}
  node_is "$want" && return 0
  export NVM_DIR=${NVM_DIR:-$HOME/.nvm}
  dir=$(ls -d "$NVM_DIR/versions/node/v$want"/bin "$NVM_DIR/versions/node/v$want".*/bin 2>/dev/null | sort -V | tail -1 || true)
  if [[ -n $dir ]]; then
    export PATH=$dir:$PATH
  elif [[ -s $NVM_DIR/nvm.sh ]]; then
    # shellcheck disable=SC1091
    source "$NVM_DIR/nvm.sh" >/dev/null && nvm use >/dev/null
  fi
  node_is "$want" || { echo "need Node $want (from .nvmrc); got $(node -v 2>/dev/null || echo none)" >&2; return 1; }
}

# node_is VERSION → true when `node` on PATH is VERSION (24, 24.22 or 24.22.3).
node_is() {
  local have
  have=$(node -v 2>/dev/null) || return 1
  [[ $have == "v$1" || $have == "v$1".* ]]
}

# trunk_drift BRANCH → the files dev changed since BRANCH last merged it, other
# than the backlog files (pnpm backlog commits those onto dev all day, and they
# never affect a branch's code). Empty means BRANCH is up to date with dev.
trunk_drift() {
  git -C "$main" diff --name-only "$1...$trunk" | grep -vxF -e plans/backlog.md -e plans/inbox.md || true
}

# Machine-wide leases (browser checks, pnpm prd check) live in lease.sh.

# fmt_secs N → 1m05s.
fmt_secs() { printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); }

# load_avg → the 1, 5 and 15 minute load averages.
load_avg() { sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | xargs || uptime | sed 's/.*load average[s]*: //'; }

# The disk guard: free space on the volume holding the main checkout, against
# CARETOOK_MIN_FREE_GB (default 10). new.sh (a stacked worktree), stack.sh up
# and browser.sh's check build call require_disk; ls.sh prints disk_line.
# CARETOOK_FREE_GB stands in for the reading (tests).

# min_free_gb → the line, in whole GB.
min_free_gb() {
  local m=${CARETOOK_MIN_FREE_GB:-10}
  [[ $m =~ ^[0-9]+$ ]] || die "CARETOOK_MIN_FREE_GB takes whole GB (got $m)"
  echo "$m"
}

# free_gb → whole GB free on the main checkout's volume, or nothing when df
# can't tell.
free_gb() {
  if [[ -n ${CARETOOK_FREE_GB:-} ]]; then echo "${CARETOOK_FREE_GB%%.*}"; return 0; fi
  df -Pk "$main" 2>/dev/null | awk 'NR == 2 && $4 ~ /^[0-9]+$/ { printf "%d\n", $4 / 1048576 }'
}

# require_disk WHAT → die, saying how much is free, when it's under the line.
# An unreadable disk doesn't block.
require_disk() {
  local free min
  free=$(free_gb) min=$(min_free_gb)
  [[ $free =~ ^[0-9]+$ ]] || return 0
  ((free >= min)) && return 0
  die "Refusing $1: only $free GB free on the disk holding $main, under the $min GB line (CARETOOK_MIN_FREE_GB).
See what can go, and free it: pnpm prd reclaim"
}

# disk_line → "disk: N GB free (line M GB)", flagged LOW under the line.
disk_line() {
  local free min
  free=$(free_gb) min=$(min_free_gb)
  if [[ ! $free =~ ^[0-9]+$ ]]; then echo "disk: free space unknown (df failed)"; return 0; fi
  echo "disk: $free GB free (line $min GB)$( ((free < min)) && echo " · LOW: new stacks and check builds are refused: pnpm prd reclaim")"
}
