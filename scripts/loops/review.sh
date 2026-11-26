#!/usr/bin/env bash
# Codex's review of a branch's open PR into dev: the verdict on its current
# head (codex-review.mjs) and the open findings. A clean verdict carries over
# a dev merge that leaves the PR's diff alone (the three rules there), even
# while Codex reviews the merged head by itself, so a sync needs no new wait;
# --again asks for a review of the head and waits for that one.
#
#   review.sh <topic|branch> [--json] [--wait [min]] [--again] [--resolve <threadId>]…
#
#   (no option)        print the verdict and the findings (priority, file:line,
#                      title, thread link and id)
#   --json             print the verdict as JSON instead
#   --again            comment "@codex review" on the PR first (Codex reviews a
#                      push by itself; this asks again on the same head); with
#                      --wait, it first waits (up to 5 min, REVIEW_TAKE_UP
#                      seconds) for Codex to take it up, and exits 75 if it never does
#   --resolve <id>     resolve a thread first: a fixed finding (Codex leaves its
#                      threads open, outdated) or a declined one (reply on the
#                      thread with the reason first); repeatable
#   --wait [min]       poll every 60 s (CARETOOK_REVIEW_POLL) until Codex has
#                      answered on the head (clean, carried or not, or findings), for up to min
#                      minutes (default 20); a waiting or stale verdict keeps it
#                      waiting, and out of credits ends it at once (no review is
#                      coming). Run it in the background.
#
# With --json, stdout carries only the verdict; progress lines go to stderr.
# A topic means prd/<topic>; prd/, hotfix/ and other branches are taken as given.
# Each answer on a head goes to the run log once (run-log.mjs), for pnpm prd metrics.
# Exit status: 0 clean, 1 findings, 2 waiting or stale, 4 out of credits (Codex
# answered with its usage-limit comment), 75 when --wait times out, 3 for
# anything else (no open PR, gh failing, a bad argument).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
use_node || true

fail() { echo "$*" >&2; exit 3; }
# say LINE… → a progress line: stdout, or stderr with --json (stdout is the verdict).
say() { if ((json)); then echo "$*" >&2; else echo "$*"; fi; }

what="" json=0 wait="" again=0 resolve=()
while (($#)); do
  case $1 in
    --json) json=1 ;;
    --again) again=1 ;;
    --resolve) [[ -n ${2:-} && $2 != -* ]] || fail "--resolve needs a thread id"; resolve+=("$2"); shift ;;
    --wait)
      wait=20
      if [[ ${2:-} =~ ^[0-9]+$ ]]; then wait=$2; shift; fi
      ((wait > 0)) || fail "--wait takes whole minutes over 0"
      ;;
    -*) fail "review: unknown option $1 (--json, --wait [min], --again, --resolve <threadId>)" ;;
    *) [[ -z $what ]] || fail "review: one branch or topic"; what=$1 ;;
  esac
  shift
done
[[ -n $what ]] || what=$(topic_of "$(here_name)")
[[ -n $what ]] || fail "which branch? (pnpm prd review <topic|branch>)"
branch=$(pr_branch "$what")

number=$(pr_for "$branch") || fail "gh couldn't list $branch's PRs (gh auth status?)"
[[ -n $number ]] || fail "no open PR from $branch into $trunk (pnpm prd pr ${branch#"$prd_prefix"})"

for id in ${resolve[@]+"${resolve[@]}"}; do
  # shellcheck disable=SC2016
  out=$(gh api graphql -f id="$id" -f query='mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }' \
    -q '.data.resolveReviewThread.thread | "resolved \(.id)"') || fail "couldn't resolve thread $id"
  say "$out"
done
# field NAME → a field of the verdict's JSON ($v), or nothing.
field() { node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0, "utf8"))[process.argv[1]] ?? ""))' "$1" <<< "$v"; }

# codex [--line|--text] → the verdict on the PR's state (stdin). A clean one
# carries over dev merges, unless --again asked for a review of this head.
codex() {
  if ((again)); then node "$(dirname "$0")/codex-review.mjs" "$@"; return; fi
  node "$(dirname "$0")/codex-review.mjs" --repo="$main" --trunk="$trunk" "$@"
}

# verdict → sets raw (the PR's state), v (the verdict's JSON) and state.
verdict() {
  raw=$(pr_state "$number") || fail "gh couldn't read PR #$number"
  v=$(codex <<< "$raw")
  state=$(field state)
}

if ((again)); then
  [[ -n $wait ]] && { verdict; before=$(field summaryAt); }
  gh pr comment -R "$(gh_repo)" "$number" --body "@codex review" >/dev/null || fail "couldn't comment on PR #$number"
  say "asked Codex to review PR #$number again"
  if [[ -n $wait ]]; then
    # Until Codex takes it up, the last verdict still stands: wait for its
    # summary to change (it turns "running" within seconds). If it never does,
    # the old verdict isn't an answer: time out.
    take_up=${REVIEW_TAKE_UP:-300}
    taken=$(($(date +%s) + take_up))
    while verdict && [[ $(field summaryAt) == "$before" ]]; do
      if (($(date +%s) >= taken)); then
        echo "Codex didn't take up the re-review of PR #$number within ${take_up}s (its summary never changed)" >&2
        exit 75
      fi
      sleep 10
    done
  fi
fi

verdict
if [[ -n $wait ]]; then
  poll=${CARETOOK_REVIEW_POLL:-60}
  deadline=$(($(date +%s) + wait * 60))
  while [[ $state == waiting || $state == stale ]]; do
    if (($(date +%s) + poll > deadline)); then
      codex --line <<< "$raw" >&2
      echo "no review of the head within $wait min$([[ $state == stale ]] && echo " (stale: did you ask again? --again)")" >&2
      exit 75
    fi
    sleep "$poll"
    verdict
  done
fi

# The run log (run-log.mjs): Codex's answer on this head, once per PR and head
# however often it's polled (an out-of-credits answer apart). Never fails.
case $state in
  clean | findings | out-of-credits)
    answer=review
    [[ $state != out-of-credits ]] || answer=out-of-credits
    nfind=$(node -e 'const v = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(String((v.findings ?? []).length))' <<< "$v" 2>/dev/null || echo 0)
    run_log --once pr,head,answer codex "pr:=$number" "head=$(field headSha)" "branch=$branch" "answer=$answer" \
      "state=$state" "findings:=${nfind:-0}" "carried=$(field carriedFrom)"
    ;;
esac

if ((json)); then
  echo "$v"
else
  echo "PR #$number $(field url)"
  codex --text <<< "$raw"
fi
case $state in clean) exit 0 ;; findings) exit 1 ;; out-of-credits) exit 4 ;; *) exit 2 ;; esac
