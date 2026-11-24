#!/usr/bin/env bash
# Shared by the scripts in scripts/loops/. Source it; don't run it.

# The main checkout (the first worktree; it stays on dev). Every other worktree
# lives in $main/.loops.
main=$(git -C "$(dirname "${BASH_SOURCE[0]}")" worktree list --porcelain | awk 'NR==1{print $2}')
loops=$main/.loops
leases=$loops/.slots
trunk=${TRUNK:-dev}
# The PRD cap (lanes): `pnpm prd dispatch --cap <n>` stores it in .loops/.prd-cap, which
# wins over CARETOOK_MAX_PRDS; the default is 4. max_prds_from says which one set it.
prd_cap_file=$loops/.prd-cap
max_prds=${CARETOOK_MAX_PRDS:-4} max_prds_from=${CARETOOK_MAX_PRDS:+CARETOOK_MAX_PRDS}
max_prds_from=${max_prds_from:-default}
if [[ -r $prd_cap_file ]] && _cap=$(<"$prd_cap_file") && [[ $_cap =~ ^[1-9][0-9]?$ ]]; then
  max_prds=$_cap max_prds_from="pnpm prd dispatch --cap"
fi
unset _cap

# dispatch_pid → the running dispatcher's pid (pnpm prd dispatch: its lock,
# .loops/.dispatch.lock), or nothing and false when none runs.
dispatch_pid() {
  local p
  p=$(cat "$loops/.dispatch.lock" 2>/dev/null) || return 1
  [[ $p =~ ^[0-9]+$ ]] && kill -0 "$p" 2>/dev/null && echo "$p"
}

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

# check_base DIR ASKED (full|quick|slice) → the commit a check's diff starts from.
# A slice: where it left its PRD branch. A quick check: the last full pass (or a
# quick pass's own base) when it's an ancestor of HEAD. Otherwise where the
# branch left the trunk.
check_base() {
  local dir=$1 asked=$2 cur parent prev="" pmode="" qbase="" _rest
  if [[ $asked == slice ]]; then
    cur=$(git -C "$dir" branch --show-current); parent=${cur#slice/}; parent=prd/${parent%/*}
    if git -C "$dir" rev-parse -q --verify "$parent" > /dev/null; then
      git -C "$dir" merge-base "$parent" HEAD; return
    fi
  fi
  if [[ $asked != full ]]; then
    read -r prev pmode qbase _rest 2>/dev/null < "$(checked_file "$dir")" || true
    [[ $pmode == quick ]] && prev=$qbase
    if [[ -n $prev ]] && git -C "$dir" merge-base --is-ancestor "$prev" HEAD 2>/dev/null; then
      echo "$prev"; return
    fi
  fi
  git -C "$dir" merge-base "$trunk" HEAD
}

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
  [[ -z $(git -C "$1" diff --name-only --no-renames $range | grep -Ev "$exempt_re") ]]
}

# keeps_check DIR FROM TO → succeeds when every file changed from FROM to TO is
# exempt or one of CI's two lists: such commits keep a recorded pass. The lists
# aren't exempt themselves, so a branch that changes only them still needs a check.
keeps_check() {
  [[ -z $(git -C "$1" diff --name-only --no-renames "$2" "$3" |
    grep -Ev "$exempt_re" | grep -vxF -e scripts/ci/brake-list.txt -e scripts/ci/quarantine.txt) ]]
}

# docs_only BASE TIP → succeeds when BASE...TIP changes something and every
# file it changes is Markdown (`*.md` anywhere). Tooling scripts are code: they
# keep the Codex review. An empty diff is not docs only. --no-renames lists both
# sides of a rename, so a code file renamed to .md isn't docs only.
docs_only() {
  local files
  files=$(git -C "$main" diff --name-only --no-renames "$1...$2") || return 1
  [[ -n $files ]] && ! grep -qv '\.md$' <<< "$files"
}

# propose_tier BASE TIP [DECLARED] → three lines from check-plan.mjs: the tier this
# diff (BASE...TIP, which check-plan.mjs computes) should wait for, why, and
# ok | below | refused for the declared tier.
propose_tier() {
  node "$(dirname "${BASH_SOURCE[0]}")/check-plan.mjs" --propose --repo "$main" --base "$1" --head "$2" \
    ${3:+--declared "$3"}
}

# checked_ok DIR REV → succeeds when `pnpm prd check` (full or --quick) passed
# on REV, or on an ancestor of it with only exempt files or CI's lists changed since; or when
# REV's own changes against dev (dev...REV) are all exempt, so it needs none.
checked_ok() {
  local checked tip
  checked=$(cut -d' ' -f1 "$(checked_file "$1")" 2>/dev/null || true)
  tip=$(git -C "$1" rev-parse "$2")
  if [[ -n $checked ]]; then
    [[ $checked == "$tip" ]] && return 0
    git -C "$1" merge-base --is-ancestor "$checked" "$tip" 2>/dev/null && keeps_check "$1" "$checked" "$tip" && return 0
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
    { git -C "$1" merge-base --is-ancestor "$sha" "$tip" 2>/dev/null && keeps_check "$1" "$sha" "$tip"; }; }; then
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
# merged it, other than the backlog files and CI's two lists (pnpm backlog and
# pnpm prd ci commit those onto dev, and they never affect a branch's code).
# Empty means BRANCH is up to date with dev.
trunk_drift() {
  git -C "$main" diff --name-only "$1...${2:-$trunk}" |
    grep -vxF -e plans/backlog.md -e plans/inbox.md -e plans/backlog-archive.md -e scripts/ci/brake-list.txt -e scripts/ci/quarantine.txt || true
}

# trunk_lists BRANCH [REF] → CI's two lists that dev (or REF) changed since
# BRANCH last merged it and BRANCH itself didn't: what `sync` copies when it skips
# the merge. A list both sides changed is shared, so dev-brought.mjs refuses and
# sync merges instead.
trunk_lists() {
  local base f
  base=$(git -C "$main" merge-base "$1" "${2:-$trunk}") || return 0
  for f in scripts/ci/brake-list.txt scripts/ci/quarantine.txt; do
    git -C "$main" diff --quiet "$base" "${2:-$trunk}" -- "$f" && continue
    git -C "$main" diff --quiet "$base" "$1" -- "$f" || continue
    echo "$f"
  done
}

# Machine-wide leases (browser checks, pnpm prd check) live in lease.sh.

# fmt_secs N → 1m05s.
fmt_secs() { printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); }

# load_avg → the 1, 5 and 15 minute load averages.
# One clean line: sysctl on macOS, uptime on Linux (where sysctl prints nothing).
load_avg() {
  local l
  l=$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | xargs) || l=""
  [[ -n $l ]] || l=$(uptime 2>/dev/null | sed 's/.*load average[s]*: //' | tr -d ',') || l=""
  echo "$l"
}

# file_mtime PATH → its modification time (epoch seconds); false when it can't be
# read. GNU's form first: on Linux, `stat -f %m` prints a `File:` block to stdout
# before it fails, so only an all-digit answer counts.
file_mtime() {
  local t
  t=$(stat -c %Y "$1" 2>/dev/null) && [[ $t =~ ^[0-9]+$ ]] && { echo "$t"; return 0; }
  t=$(stat -f %m "$1" 2>/dev/null) && [[ $t =~ ^[0-9]+$ ]] && { echo "$t"; return 0; }
  return 1
}

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
  # Never busy: no wait (reading the load itself can cross a second).
  [[ -n $said ]] || return 0
  load_waited=$(($(date +%s) - t0))
  echo "The load dropped to $l (threshold $thr) after ${load_waited}s: starting $what."
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
# one line, or the line and the findings); a clean one carries over dev merges.
pr_verdict() {
  local state
  state=$(pr_state "$1") || return 1
  node "$(dirname "${BASH_SOURCE[0]}")/codex-review.mjs" --repo="$main" --trunk="$trunk" ${2:+"$2"} <<< "$state"
}

# The PR path (pr.sh, land.sh): landing subjects, pushing dev, and dev-sync.

inbox_path=plans/inbox.md

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
    age=$(($(date +%s) - $(file_mtime "$lock" || date +%s)))
    if ((age > 30)); then rm -rf "$lock"; continue; fi
    ((SECONDS < deadline)) || die "the backlog is locked ($lock); try again"
    sleep 0.2
  done
  if ("$@"); then status=0; else status=$?; fi
  rm -rf "$lock"
  return "$status"
}

# push_trunk → push the main checkout's dev to origin/dev, fast-forward only
# (never forced), under the backlog lock. When origin/dev has commits dev lacks
# it runs dev-sync first; a conflict there stops the push.
push_trunk() {
  local there
  git -C "$main" fetch --quiet origin "$trunk" || die "couldn't fetch origin/$trunk"
  there=$(git -C "$main" rev-parse --verify --quiet "refs/remotes/origin/$trunk" || true)
  if [[ -n $there ]] && ! git -C "$main" merge-base --is-ancestor "$there" "refs/heads/$trunk"; then
    (dev_sync "a push of $trunk") || die "origin/$trunk has commits $trunk lacks and dev-sync stopped: nothing was pushed"
  fi
  with_backlog_lock _push_trunk
}
# land_push_trunk → push_trunk for a landing, just before its merge. The landing's
# checks saw dev as it was, so a pickup that brings anything but the backlog files
# and CI's two lists refuses: nothing has landed, and a sync and rerun judge it.
land_push_trunk() {
  local before after moved
  before=$(git -C "$main" rev-parse "refs/heads/$trunk")
  push_trunk
  after=$(git -C "$main" rev-parse "refs/heads/$trunk")
  [[ $before != "$after" ]] || return 0
  moved=$(git -C "$main" diff --name-only "$before" "$after" |
    grep -vxF -e plans/backlog.md -e plans/inbox.md -e plans/backlog-archive.md -e scripts/ci/brake-list.txt -e scripts/ci/quarantine.txt || true)
  [[ -z $moved ]] || die "origin/$trunk brought changes this landing's checks didn't see (${moved%%$'\n'*}…): nothing landed; run \`pnpm prd sync\`, then land again"
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

# held_elsewhere SHA → true when another ref (a branch, remote-tracking ref, tag
# or stash) or a detached worktree holds SHA: the amend rule's test
# (scripts/backlog/backlog.mjs). Replaying such a commit would give it a new id.
held_elsewhere() {
  local sha others
  others=$(git -C "$main" for-each-ref --contains "$1" --format='%(refname)' | grep -vxF "refs/heads/$trunk" || true)
  [[ -z $others ]] || return 0
  while read -r sha; do
    git -C "$main" merge-base --is-ancestor "$1" "$sha" 2>/dev/null && return 0
  done < <(git -C "$main" worktree list --porcelain | awk '/^HEAD /{h=$2} /^detached$/{print h}')
  return 1
}

# dev_sync BRANCH → bring the main checkout's dev up to origin/dev: fast-forward
# when dev is behind; replay dev's own commits when every one is a backlog commit
# no other ref holds (unpushed, so nothing shared is rewritten); otherwise a merge
# commit (chore(dev): merge origin/dev after BRANCH). It never stops on the inbox:
# a conflict only in plans/inbox.md is resolved by the inbox merge, and uncommitted
# inbox lines stay uncommitted on top of the update. It refuses a checkout off dev
# or mid-merge, rebase or cherry-pick, a conflict in any other file, and any
# uncommitted change to another file the update touches (git read-tree -m -u),
# before changing anything, and moves dev under the backlog lock.
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
  local here there c tree new replay=1 own=()
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
  for c in "${own[@]}"; do
    if ! backlog_commit "$c" || held_elsewhere "$c"; then replay=0; break; fi
  done
  if ((replay)); then
    new=$there
    for c in "${own[@]}"; do
      tree=$(_merge_trees "$c^" "$new" "$c") ||
        die "dev-sync: backlog commit ${c:0:7} doesn't apply onto origin/$trunk: rebase it by hand (git -C $main rebase origin/$trunk)"
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
  tree=$(_merge_trees "" "$here" "$there") ||
    die "dev-sync: $trunk's own commits conflict with origin/$trunk: merge by hand (git -C $main merge origin/$trunk)"
  new=$(git -C "$main" commit-tree "$tree" -p "$here" -p "$there" -m "chore(dev): merge origin/$trunk after $1") ||
    die "dev-sync: couldn't write the merge commit"
  _move_trunk "$here" "$new" "merge origin/$trunk after $1"
  echo "dev-sync: merged origin/$trunk into $trunk (${#own[@]} local commit(s) kept) as ${new:0:7}"
}
# _inbox_merge BASE OURS THEIRS OUT → the inbox merge of three files, into OUT.
_inbox_merge() {
  node "$(dirname "${BASH_SOURCE[0]}")/../backlog/inbox-merge.mjs" "$1" "$2" "$3" > "$4"
}
# _merge_trees BASE OURS THEIRS → the merged tree (BASE empty: git's own). A
# conflict only in the inbox is resolved by the inbox merge; any other fails.
_merge_trees() {
  local out rc=0 tree tmp blob from
  out=$(git -C "$main" merge-tree --write-tree --name-only --no-messages ${1:+"--merge-base=$1"} "$2" "$3") || rc=$?
  tree=${out%%$'\n'*}
  if ((rc == 0)); then echo "$tree"; return 0; fi
  ((rc == 1)) && [[ ${out#*$'\n'} == "$inbox_path" ]] || return 1
  from=${1:-$(git -C "$main" merge-base "$2" "$3")} || return 1
  tmp=$(mktemp -d)
  if git -C "$main" cat-file blob "$from:$inbox_path" > "$tmp/base" 2>/dev/null &&
    git -C "$main" cat-file blob "$2:$inbox_path" > "$tmp/ours" 2>/dev/null &&
    git -C "$main" cat-file blob "$3:$inbox_path" > "$tmp/theirs" 2>/dev/null &&
    _inbox_merge "$tmp/base" "$tmp/ours" "$tmp/theirs" "$tmp/merged" &&
    blob=$(git -C "$main" hash-object -w --stdin < "$tmp/merged") &&
    GIT_INDEX_FILE=$tmp/index git -C "$main" read-tree "$tree" &&
    GIT_INDEX_FILE=$tmp/index git -C "$main" update-index --add --cacheinfo "100644,$blob,$inbox_path" &&
    GIT_INDEX_FILE=$tmp/index git -C "$main" write-tree; then
    rm -rf "$tmp"; return 0
  fi
  rm -rf "$tmp"; return 1
}
# _inbox_dirty BLOB → true when the main checkout's inbox, on disk or staged,
# differs from BLOB.
_inbox_dirty() {
  [[ $(git -C "$main" hash-object --path="$inbox_path" -- "$main/$inbox_path") != "$1" ||
    $(git -C "$main" rev-parse --verify --quiet ":$inbox_path" || true) != "$1" ]]
}
# _move_trunk OLD NEW WHY → update the main checkout's files, then dev, from OLD
# to NEW; read-tree refuses when an uncommitted change would be overwritten. When
# the update changes an inbox with uncommitted edits, read-tree moves everything
# else (so a refusal leaves the user's file untouched), then the working copy
# becomes the merge of OLD's copy, itself and NEW's copy, still uncommitted.
_move_trunk() {
  local old=$1 new=$2 why=$3 a b tmp="" target=$2 work=$main/$inbox_path gd
  git -C "$main" update-index -q --refresh >/dev/null 2>&1 || true
  a=$(git -C "$main" rev-parse --verify --quiet "$old:$inbox_path" || true)
  b=$(git -C "$main" rev-parse --verify --quiet "$new:$inbox_path" || true)
  if [[ -n $a && -n $b && $a != "$b" && -f $work ]] && _inbox_dirty "$a"; then
    tmp=$(mktemp -d)
    git -C "$main" cat-file blob "$a" > "$tmp/base" &&
      cp "$work" "$tmp/ours" &&
      git -C "$main" cat-file blob "$b" > "$tmp/theirs" &&
      _inbox_merge "$tmp/base" "$tmp/ours" "$tmp/theirs" "$tmp/merged" &&
      GIT_INDEX_FILE=$tmp/index git -C "$main" read-tree "$new" &&
      GIT_INDEX_FILE=$tmp/index git -C "$main" update-index --cacheinfo "100644,$a,$inbox_path" &&
      target=$(GIT_INDEX_FILE=$tmp/index git -C "$main" write-tree) ||
      { rm -rf "$tmp"; die "dev-sync: couldn't merge the inbox; nothing changed"; }
  fi
  if ! git -C "$main" read-tree -m -u "$old" "$target"; then
    [[ -z $tmp ]] || rm -rf "$tmp"
    die "dev-sync: uncommitted changes in $main touch files the update changes: commit or stash them, then: pnpm prd dev-sync"
  fi
  if [[ -n $tmp ]]; then
    gd=$(git -C "$main" rev-parse --absolute-git-dir)
    git -C "$main" update-index --cacheinfo "100644,$b,$inbox_path"
    cp -p "$work" "$gd/caretook-inbox-merged"
    cat "$tmp/merged" > "$gd/caretook-inbox-merged"
    mv "$gd/caretook-inbox-merged" "$work"
    rm -rf "$tmp"
    echo "dev-sync: kept your uncommitted lines in $inbox_path"
  fi
  git -C "$main" update-ref -m "dev-sync: $why" "refs/heads/$trunk" "$new" "$old" ||
    die "dev-sync: $trunk moved meanwhile; rerun pnpm prd dev-sync"
}
