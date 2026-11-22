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

# The record is one line: `<sha> full`, or `<sha> quick <base> <why>` for a
# `pnpm prd check --quick` (typecheck, lint, format and the tests related to
# the diff since <base>). A bare `<sha>` (older records) reads as full.

# exempt_re → the paths that need no check: docs and the internal tooling
# (AGENTS.md: docs-only and tooling-only changes skip `pnpm check`).
exempt_re='(\.md$|^scripts/loops/|^scripts/backlog/|^\.githooks/)'

# exempt_only DIR FROM TO → succeeds when every file changed between FROM and
# TO (git diff FROM TO, or FROM...TO when TO is empty) is exempt.
exempt_only() {
  local range=$2
  [[ -n ${3:-} ]] && range="$2 $3"
  # shellcheck disable=SC2086
  [[ -z $(git -C "$1" diff --name-only $range | grep -Ev "$exempt_re") ]]
}

# docs_only BASE TIP → succeeds when BASE...TIP changes something and every
# file it changes is Markdown (`*.md` anywhere). Tooling scripts are code: they
# keep the Codex review. An empty diff is not docs only.
docs_only() {
  local files
  files=$(git -C "$main" diff --name-only "$1...$2") || return 1
  [[ -n $files ]] && ! grep -qv '\.md$' <<< "$files"
}

# checked_ok DIR REV → succeeds when `pnpm prd check` (full or --quick) passed
# on REV, or on an ancestor of it with only exempt files changed since; or when
# REV's own changes against dev (dev...REV) are all exempt, so it needs none.
checked_ok() {
  local checked tip
  checked=$(cut -d' ' -f1 "$(checked_file "$1")" 2>/dev/null || true)
  tip=$(git -C "$1" rev-parse "$2")
  if [[ -n $checked ]]; then
    [[ $checked == "$tip" ]] && return 0
    git -C "$1" merge-base --is-ancestor "$checked" "$tip" 2>/dev/null && exempt_only "$1" "$checked" "$tip" && return 0
  fi
  exempt_only "$1" "$trunk...$tip"
}

# checked_how DIR REV → how REV passed the gate, for reports: "full on <sha>",
# "quick on <sha> (<why>)", or "none needed (docs and tooling only)".
checked_how() {
  local line sha mode why tip
  line=$(cat "$(checked_file "$1")" 2>/dev/null || true)
  read -r sha mode _ why <<< "$line"
  tip=$(git -C "$1" rev-parse "$2")
  if [[ -n $sha ]] && { [[ $sha == "$tip" ]] ||
    { git -C "$1" merge-base --is-ancestor "$sha" "$tip" 2>/dev/null && exempt_only "$1" "$sha" "$tip"; }; }; then
    if [[ $mode == quick ]]; then echo "quick on ${sha:0:7} ($why)"; else echo "full on ${sha:0:7}"; fi
  elif exempt_only "$1" "$trunk...$tip"; then
    echo "none needed (docs and tooling only)"
  else
    echo "not checked"
  fi
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

# trunk_drift BRANCH [REF] → the files dev (or REF) changed since BRANCH last
# merged it, other than the backlog files (pnpm backlog commits those onto dev
# all day, and they never affect a branch's code). Empty means BRANCH is up to
# date with dev.
trunk_drift() {
  git -C "$main" diff --name-only "$1...${2:-$trunk}" | grep -vxF -e plans/backlog.md -e plans/inbox.md || true
}

# Machine-wide leases (browser checks, pnpm prd check) live in lease.sh.

# fmt_secs N → 1m05s.
fmt_secs() { printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); }

# load_avg → the 1, 5 and 15 minute load averages.
load_avg() { sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | xargs || uptime | sed 's/.*load average[s]*: //'; }

# The load gate (load-gate.mjs decides; busy is the 5-minute load over
# CARETOOK_LOAD_BUSY, default twice the cores). load_gate → "<busy|ok|off|unread>
# <load> <threshold> <cores>"; a missing or failing script reads as unread (not busy).
load_gate() {
  local s out
  s="$(dirname "${BASH_SOURCE[0]}")/load-gate.mjs"
  out=$([[ -f $s ]] && node "$s" 2>/dev/null || true)
  echo "${out:-unread - - -}"
}

# load_gate_wait WHAT: while the machine is busy, poll (CARETOOK_LOAD_POLL, 15 s)
# for at most CARETOOK_LOAD_WAIT (600 s), then go ahead and say so. Sets
# load_waited to the seconds waited. CARETOOK_LOAD_GATE=off or
# CARETOOK_LEASES=off waits for nothing. Always returns 0.
load_waited=0
load_gate_wait() {
  local what=$1 max=${CARETOOK_LOAD_WAIT:-600} poll=${CARETOOK_LOAD_POLL:-15} t0 state l thr _c said=""
  load_waited=0
  [[ ${CARETOOK_LOAD_GATE:-} == off || ${CARETOOK_LEASES:-} == off ]] && return 0
  [[ $max =~ ^[0-9]+$ ]] || max=600
  t0=$(date +%s)
  while read -r state l thr _c <<< "$(load_gate)"; [[ $state == busy ]]; do
    load_waited=$(($(date +%s) - t0))
    if [[ -z $said ]]; then
      echo "The machine is busy (5-minute load $l, over $thr): waiting up to ${max}s before $what (CARETOOK_LOAD_WAIT)…"
      said=1
    fi
    if ((load_waited >= max)); then
      echo "Gave up waiting for the load after ${load_waited}s (still $l, over $thr): starting $what anyway."
      return 0
    fi
    sleep "$poll"
  done
  load_waited=$(($(date +%s) - t0))
  [[ -z $said ]] || echo "The load dropped to $l (threshold $thr) after ${load_waited}s: starting $what."
  return 0
}

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

# GitHub pull requests (review.sh; land and ready reuse these). Every call goes
# through `gh`, against origin's repository.

# pr_branch WHAT → the branch a command means: prd/, plan/ and hotfix/ branches
# (or any other with a slash) as given, else a topic's prd/<topic>.
pr_branch() { case $1 in */*) echo "$1" ;; *) echo "prd/$1" ;; esac; }

# gh_repo → origin's owner/name (cached per shell).
gh_repo() {
  [[ -n ${_gh_repo:-} ]] || _gh_repo=$(cd "$main" && gh repo view --json nameWithOwner -q .nameWithOwner) || return 1
  echo "$_gh_repo"
}

# pr_for BRANCH → the number of BRANCH's open PR into dev, or nothing.
pr_for() {
  local repo
  repo=$(gh_repo) || return 1
  gh pr list -R "$repo" --head "$1" --base "$trunk" --state open --json number -q '.[0].number // empty'
}

# pr_state NUMBER → the PR's state as GraphQL JSON (codex-review.mjs's PR_QUERY):
# head, reviews, review threads, comments and reactions.
pr_state() {
  local repo query
  repo=$(gh_repo) || return 1
  query=$(node --input-type=module -e "import { PR_QUERY } from '$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/codex-review.mjs'; process.stdout.write(PR_QUERY)")
  gh api graphql -F owner="${repo%%/*}" -F name="${repo#*/}" -F number="$1" -f query="$query"
}

# pr_verdict NUMBER [--line|--text] → Codex's verdict on the PR's head (JSON,
# one line, or the line and the findings).
pr_verdict() {
  local state
  state=$(pr_state "$1") || return 1
  node "$(dirname "${BASH_SOURCE[0]}")/codex-review.mjs" ${2:+"$2"} <<< "$state"
}

# The PR path (pr.sh, land.sh): landing subjects, pushing dev, and dev-sync.

# land_dir BRANCH → the worktree a prd/, plan/ or hotfix/ branch lives in.
land_dir() {
  case $1 in
    plan/*) echo "$loops/plan-${1#*/}" ;;
    hotfix/*) echo "$loops/hotfix-${1#*/}" ;;
    *) echo "$loops/${1#*/}" ;;
  esac
}

# land_subject BRANCH → the subject `land` gives a branch without -m:
# feat(<topic>): land prd/<topic> (B-1, B-2), fix(…) when every ready item is a
# bug or for a hotfix, docs(…) for a plan branch.
land_subject() {
  local topic=${1#*/} ids type
  ids=$(node "$(dirname "${BASH_SOURCE[0]}")/../backlog/backlog.mjs" list --all --prd "$topic" --status ready --json |
    node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));
      const t=r.length&&r.every(i=>i.type==="bug")?"fix":"feat";
      console.log(t+"\t"+r.map(i=>i.id).join(", "))')
  type=${ids%%$'\t'*}; ids=${ids#*$'\t'}
  [[ $1 == plan/* ]] && type=docs
  [[ $1 == hotfix/* ]] && type=fix
  echo "$type($topic): land $1${ids:+ ($ids)}"
}

# pr_seam BRANCH → sets drift_ref, what a PR's branch must be synced with: dev,
# or origin/dev under the live-test seam CARETOOK_PR_THROWAWAY=1 (pr.sh and
# land.sh: they then never push dev, and land stops before the merge). The seam
# takes only a branch with "throwaway" in its name.
pr_seam() {
  drift_ref=$trunk
  [[ ${CARETOOK_PR_THROWAWAY:-} == 1 ]] || return 0
  [[ $1 == *throwaway* ]] || die "CARETOOK_PR_THROWAWAY=1 is for throwaway branches only (a name with \"throwaway\" in it)"
  git -C "$main" fetch --quiet origin "$trunk" || die "couldn't fetch origin/$trunk"
  drift_ref=origin/$trunk
  echo "CARETOOK_PR_THROWAWAY: $trunk is never pushed; $1 is measured against $drift_ref"
}

# with_backlog_lock CMD… → run CMD in a subshell under pnpm backlog's lock (the
# same directory, taken over after 30 s as backlog.mjs does), so no backlog
# write moves or amends dev meanwhile. CMD's failures (die) end the subshell
# and the lock is still dropped.
with_backlog_lock() {
  local lock deadline=$((SECONDS + 20)) age status
  lock="$(cd "$main" && cd "$(git rev-parse --git-common-dir)" && pwd)/caretook-backlog.lock"
  until mkdir "$lock" 2>/dev/null; do
    age=$(($(date +%s) - $(stat -f %m "$lock" 2>/dev/null || stat -c %Y "$lock" 2>/dev/null || date +%s)))
    if ((age > 30)); then rm -rf "$lock"; continue; fi
    ((SECONDS < deadline)) || die "the backlog is locked ($lock); try again"
    sleep 0.2
  done
  if ("$@"); then status=0; else status=$?; fi
  rm -rf "$lock"
  return "$status"
}

# push_trunk → push the main checkout's dev to origin/dev, fast-forward only
# (never forced), under the backlog lock. Stops when origin/dev has diverged.
push_trunk() {
  git -C "$main" fetch --quiet origin "$trunk" || die "couldn't fetch origin/$trunk"
  with_backlog_lock _push_trunk
}
_push_trunk() {
  local here there
  here=$(git -C "$main" rev-parse "refs/heads/$trunk")
  there=$(git -C "$main" rev-parse --verify --quiet "refs/remotes/origin/$trunk" || true)
  if [[ $here == "$there" ]]; then echo "origin/$trunk is up to date"; return 0; fi
  [[ -z $there ]] || git -C "$main" merge-base --is-ancestor "$there" "$here" ||
    die "origin/$trunk has diverged from the main checkout's $trunk (it has commits $trunk lacks): bring them in (pnpm prd dev-sync), then rerun"
  git -C "$main" push --quiet origin "refs/heads/$trunk:refs/heads/$trunk" || die "couldn't push $trunk to origin"
  echo "pushed $trunk to origin (${there:0:7}..${here:0:7})"
}

# backlog_commit SHA → true when SHA is a pnpm backlog commit: one parent, the
# Backlog-Tool: trailer, and only the backlog files changed.
backlog_commit() {
  local files
  (($(git -C "$main" rev-list --parents -n 1 "$1" | wc -w) == 2)) || return 1
  [[ -n $(git -C "$main" log -1 --format='%(trailers:key=Backlog-Tool,valueonly)' "$1" | tr -d '[:space:]') ]] || return 1
  files=$(git -C "$main" diff-tree --no-commit-id --name-only -r "$1")
  [[ -n $files ]] && ! grep -qvxF -e plans/backlog.md -e plans/inbox.md -e plans/backlog-archive.md <<< "$files"
}

# dev_sync BRANCH → after a GitHub merge, bring the main checkout's dev up to
# origin/dev: fast-forward when dev is behind; rebase dev's own commits when
# every one is a backlog commit (unpushed, so nothing shared is rewritten);
# otherwise a merge commit (chore(dev): merge origin/dev after BRANCH). It
# refuses a checkout off dev or mid-merge, rebase or cherry-pick, and any
# uncommitted change to a file the update touches (git read-tree -m -u), and
# moves dev under the backlog lock. No conflicts: it stops before touching
# anything when the commits don't apply cleanly.
dev_sync() {
  local gd f
  [[ $(git -C "$main" branch --show-current) == "$trunk" ]] || die "dev-sync: the main checkout ($main) isn't on $trunk"
  gd=$(git -C "$main" rev-parse --absolute-git-dir)
  for f in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply; do
    [[ ! -e $gd/$f ]] || die "dev-sync: the main checkout is in the middle of a merge, rebase or cherry-pick ($f)"
  done
  git -C "$main" fetch --quiet origin "$trunk" || die "dev-sync: couldn't fetch origin/$trunk"
  with_backlog_lock _dev_sync "${1:-a GitHub merge}"
}
_dev_sync() {
  local here there c tree new n=0 own=()
  here=$(git -C "$main" rev-parse "refs/heads/$trunk")
  there=$(git -C "$main" rev-parse "refs/remotes/origin/$trunk")
  if git -C "$main" merge-base --is-ancestor "$there" "$here"; then
    echo "dev-sync: $trunk already has origin/$trunk"; return 0
  fi
  if git -C "$main" merge-base --is-ancestor "$here" "$there"; then
    _move_trunk "$here" "$there" "fast-forward to origin/$trunk"
    echo "dev-sync: fast-forwarded $trunk to ${there:0:7}"; return 0
  fi
  while read -r c; do own+=("$c"); done < <(git -C "$main" rev-list --reverse "$there..$here")
  for c in "${own[@]}"; do backlog_commit "$c" || { n=-1; break; }; done
  if ((n == 0)); then
    new=$there
    for c in "${own[@]}"; do
      tree=$(git -C "$main" merge-tree --write-tree --merge-base="$c^" "$new" "$c") ||
        die "dev-sync: backlog commit ${c:0:7} doesn't apply onto origin/$trunk: rebase it by hand (git -C $main rebase origin/$trunk)"
      tree=${tree%%$'\n'*}
      new=$(git -C "$main" log -1 --format=%B "$c" |
        GIT_AUTHOR_NAME=$(git -C "$main" log -1 --format=%an "$c") \
        GIT_AUTHOR_EMAIL=$(git -C "$main" log -1 --format=%ae "$c") \
        GIT_AUTHOR_DATE=$(git -C "$main" log -1 --format=%aD "$c") \
        git -C "$main" commit-tree "$tree" -p "$new" -F -) || die "dev-sync: couldn't replay ${c:0:7}"
    done
    _move_trunk "$here" "$new" "rebase ${#own[@]} backlog commit(s) onto origin/$trunk"
    echo "dev-sync: rebased ${#own[@]} backlog commit(s) onto origin/$trunk (${there:0:7}); $trunk is ${new:0:7}"
    return 0
  fi
  tree=$(git -C "$main" merge-tree --write-tree "$here" "$there") ||
    die "dev-sync: $trunk's own commits conflict with origin/$trunk: merge by hand (git -C $main merge origin/$trunk)"
  tree=${tree%%$'\n'*}
  new=$(git -C "$main" commit-tree "$tree" -p "$here" -p "$there" -m "chore(dev): merge origin/$trunk after $1") ||
    die "dev-sync: couldn't write the merge commit"
  _move_trunk "$here" "$new" "merge origin/$trunk after $1"
  echo "dev-sync: merged origin/$trunk into $trunk (${#own[@]} local commit(s) kept) as ${new:0:7}"
}
# _move_trunk OLD NEW WHY → update the main checkout's files, then dev, from OLD
# to NEW; read-tree refuses when an uncommitted change would be overwritten.
_move_trunk() {
  git -C "$main" update-index -q --refresh >/dev/null 2>&1 || true
  git -C "$main" read-tree -m -u "$1" "$2" ||
    die "dev-sync: uncommitted changes in $main touch files the update changes: commit or stash them, then: pnpm prd dev-sync"
  git -C "$main" update-ref -m "dev-sync: $3" "refs/heads/$trunk" "$2" "$1" ||
    die "dev-sync: $trunk moved meanwhile; rerun pnpm prd dev-sync"
}
