#!/usr/bin/env bash
# Landing on an unsynced tip (land.sh): what dev brought, the temporary merge the
# typecheck runs on, and clearing a merge a kill left behind.
#
#   unsynced.sh typecheck DIR TIP DEV   merge DEV into DIR without committing, run
#                                       `pnpm typegen` and `pnpm typecheck`, and put
#                                       DIR back at TIP on every exit it can catch.
#                                       land.sh runs it inside a check lease.
# Exits: 0 passed, 3 the merge conflicts, 4 the typecheck failed, 5 the worktree
# holds a check or browser lease, 6 the worktree isn't clean at TIP.
#
# Source it for unsynced_verdict, unsynced_dev_brake, unsynced_commits and
# unsynced_clear. The marker
# (in the worktree's git dir, so it never shows as a change) is written before the
# merge starts: `tip dev pid`, then the process's start time, so a reused pid
# doesn't read as a live landing. `land`, `check` and `sync` call unsynced_clear.

# shellcheck source=lib.sh
declare -F env_get >/dev/null || source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

unsynced_marker() { echo "$(git -C "$1" rev-parse --absolute-git-dir)/caretook-unsynced-merge"; }

# unsynced_started PID → when that process started, or nothing.
unsynced_started() { ps -p "$1" -o lstart= 2>/dev/null | xargs; }

# unsynced_clear DIR → abort the temporary merge a killed landing left in DIR. It
# refuses while that landing is still running, and leaves alone any merge that
# isn't the marked one.
unsynced_clear() {
  local marker gd tip="" dev="" pid="" started=""
  marker=$(unsynced_marker "$1") || return 0
  [[ -f $marker ]] || return 0
  { read -r tip dev pid; read -r started; } < "$marker" || true
  if [[ -n $pid && -n $started && $(unsynced_started "$pid") == "$started" ]]; then
    die "a landing is typechecking a temporary merge in $1 (pid $pid): wait for it to finish"
  fi
  gd=$(git -C "$1" rev-parse --absolute-git-dir)
  if [[ -f $gd/MERGE_HEAD ]]; then
    if [[ $(git -C "$1" rev-parse HEAD) == "$tip" && $(cat "$gd/MERGE_HEAD") == "$dev" ]]; then
      git -C "$1" merge --abort || die "couldn't abort the leftover temporary merge in $1"
      echo "aborted a temporary merge a stopped landing left in $1"
    else
      echo "warning: $1 has a merge that isn't the landing's temporary one; left alone" >&2
    fi
  fi
  rm -f "$marker"
}

# unsynced_verdict DEV TIP → `go<TAB>dev sha<TAB>base`, or `no<TAB>reason`. It goes
# ahead only on `answered && drift && !refusal`; empty or unreadable output from
# dev-brought.mjs is a refusal. The tool's path is resolved because its main guard
# compares it with import.meta.url, which has symlinks resolved.
unsynced_verdict() {
  local tool out
  tool="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/dev-brought.mjs"
  out=$(node "$tool" --repo "$main" --dev "$1" --tip "$2" 2>/dev/null) || out=""
  node -e '
    let v = null;
    try { v = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch {}
    if (!v || !v.answered) console.log("no\t" + (v?.refusal ?? "git could not say what dev brought"));
    else if (v.refusal) console.log("no\t" + v.refusal);
    else if (!v.drift) console.log("no\tdev brought nothing to land over");
    else console.log("go\t" + v.dev + "\t" + v.base);
  ' <<< "$out"
}

# unsynced_safe BRANCH DEV → true when dev's drift needs no merge: land could take
# BRANCH unsynced (its files miss dev's and dev brought nothing risky). `sync`, `pr`
# and `ready` share this, so a skipped sync never blocks the next step.
unsynced_safe() {
  local go
  [[ ${CARETOOK_UNSYNCED:-} != off ]] || return 1
  IFS=$'\t' read -r go _ <<< "$(unsynced_verdict "$2" "$1")"
  [[ $go == go ]]
}

# unsynced_dev_brake SHA → sets dev_brake to why dev is known to be braked, or
# empty: SHA's latest whole-tier verdict is a brake, or a dev-brake notice is live
# (a brake on an earlier commit stays in force through it). Read only: `ci <sha>`
# requests no run. No verdict, unknown or an unreachable GitHub is no known brake;
# an unreadable board is no notice, and says so once. Paths are resolved because
# ci.mjs's main guard compares its path with import.meta.url.
dev_brake="" dev_brake_warned=""
unsynced_dev_brake() {
  local sha=$1 here out rc=0
  dev_brake=""
  here=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
  out=$(cd "$main" && node "$here/../ci/ci.mjs" "$sha" 2>/dev/null) || rc=$?
  if ((rc == 1)) && grep -q "^verdict: brake · [^ ]* · ${sha:0:8} · " <<< "$out"; then
    dev_brake="CI reads a brake on $trunk's tip ${sha:0:8}"
    return 0
  fi
  rc=0
  out=$(node -e '
    const [blame, notices, dir] = process.argv.slice(1);
    Promise.all([import(blame), import(notices)])
      .then(([{ noticeKey }, { listNotices }]) => {
        const hit = listNotices(dir).find((n) => noticeKey(String(n.text)));
        if (hit) console.log(hit.text);
      })
      .catch(() => process.exit(3));
  ' "$here/../ci/blame.mjs" "$here/notices.mjs" "${CARETOOK_NOTICES_DIR:-$loops/.notices}" 2>/dev/null) || rc=$?
  if ((rc != 0)); then
    [[ -n $dev_brake_warned ]] || echo "warning: couldn't read the dev-brake notices; going on as if there are none" >&2
    dev_brake_warned=1
  elif [[ -n $out ]]; then
    dev_brake="a dev-brake notice is live: $out"
  fi
}

# unsynced_commits BASE DEV → how many of dev's first-parent commits since BASE
# changed something other than the backlog files and CI's two lists (trunk_drift).
unsynced_commits() {
  local c n=0
  for c in $(git -C "$main" rev-list --first-parent "$1..$2"); do
    if [[ -n $(git -C "$main" diff --name-only --no-renames "$c^1" "$c" |
      grep -vxF -e plans/backlog.md -e plans/inbox.md -e plans/backlog-archive.md -e scripts/ci/brake-list.txt -e scripts/ci/quarantine.txt) ]]; then
      n=$((n + 1))
    fi
  done
  echo "$n"
}

unsynced_typecheck() {
  # Not local: the EXIT trap runs after this function has returned.
  dir=$1 tip=$2 dev=$3 child=""
  local gd log wt kind
  wt=$(basename "$dir")
  gd=$(git -C "$dir" rev-parse --absolute-git-dir)
  marker=$(unsynced_marker "$dir")
  log=$gd/caretook-unsynced.log
  for kind in check browser; do
    if ! "$(dirname "${BASH_SOURCE[0]}")/lease.sh" wait "$kind" --worktree "$wt" --timeout 0 >/dev/null 2>&1; then
      echo "$wt holds a $kind lease" >&2
      return 5
    fi
  done
  [[ $(git -C "$dir" rev-parse HEAD) == "$tip" && -z $(git -C "$dir" status --porcelain) ]] || return 6

  restore() {
    trap - EXIT TERM INT
    [[ -z $child ]] || lease_kill_tree "$child"
    git -C "$dir" merge --abort 2>/dev/null || true
    # Clean at TIP before the merge, so this only drops what the steps wrote.
    [[ $(git -C "$dir" rev-parse HEAD) != "$tip" ]] || git -C "$dir" reset -q --hard "$tip"
    rm -f "$marker"
  }
  step() {
    local rc=0
    (cd "$dir" && exec "$@") >> "$log" 2>&1 &
    child=$!
    wait "$child" || rc=$?
    child=""
    return "$rc"
  }
  printf '%s %s %s\n%s\n' "$tip" "$dev" "$$" "$(unsynced_started "$$")" > "$marker"
  trap restore EXIT
  trap 'restore; exit 143' TERM
  trap 'restore; exit 130' INT
  : > "$log"
  git -C "$dir" merge --no-commit --no-ff -q "$dev" >> "$log" 2>&1 || return 3
  if ! step pnpm typegen || ! step pnpm typecheck; then
    tail -30 "$log" >&2
    return 4
  fi
  return 0
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  set -uo pipefail
  # shellcheck source=lease.sh
  source "$(dirname "$0")/lease.sh"
  [[ ${1:-} == typecheck && $# == 4 ]] || die "usage: unsynced.sh typecheck DIR TIP DEV"
  shift
  unsynced_typecheck "$@"
  exit $?
fi
