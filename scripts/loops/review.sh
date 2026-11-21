#!/usr/bin/env bash
# Codex's review of a branch's open PR into dev: the verdict on its current
# head (codex-review.mjs) and the open findings.
#
#   review.sh <topic|branch> [--json] [--wait [min]] [--again] [--resolve <threadId>]…
#
#   (no option)        print the verdict and the findings (priority, file:line,
#                      title, thread link and id)
#   --json             print the verdict as JSON instead
#   --again            comment "@codex review" on the PR first (after a fix)
#   --resolve <id>     resolve a thread first (a declined finding: reply on the
#                      thread with the reason, then resolve it); repeatable
#   --wait [min]       poll every 60 s (CARETOOK_REVIEW_POLL) until Codex has
#                      answered on the head (clean or findings), for up to min
#                      minutes (default 20); a waiting or stale verdict keeps it
#                      waiting. Run it in the background.
#
# A topic means prd/<topic>; prd/, hotfix/ and other branches are taken as given.
# Exit status: 0 clean, 1 findings, 2 waiting or stale, 75 when --wait times out,
# 3 for anything else (no open PR, gh failing, a bad argument).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
use_node || true

fail() { echo "$*" >&2; exit 3; }

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
[[ -n $number ]] || fail "no open PR from $branch into $trunk (pnpm prd pr ${branch#prd/})"

for id in ${resolve[@]+"${resolve[@]}"}; do
  # shellcheck disable=SC2016
  gh api graphql -f id="$id" -f query='mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }' \
    -q '.data.resolveReviewThread.thread | "resolved \(.id)"' || fail "couldn't resolve thread $id"
done
if ((again)); then
  gh pr comment -R "$(gh_repo)" "$number" --body "@codex review" >/dev/null || fail "couldn't comment on PR #$number"
  echo "asked Codex to review PR #$number again"
fi

# verdict → sets raw (the PR's state), v (the verdict's JSON) and state.
verdict() {
  raw=$(pr_state "$number") || fail "gh couldn't read PR #$number"
  v=$(node "$(dirname "$0")/codex-review.mjs" <<< "$raw")
  state=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).state)' <<< "$v")
}

verdict
if [[ -n $wait ]]; then
  poll=${CARETOOK_REVIEW_POLL:-60}
  deadline=$(($(date +%s) + wait * 60))
  while [[ $state == waiting || $state == stale ]]; do
    if (($(date +%s) + poll > deadline)); then
      node "$(dirname "$0")/codex-review.mjs" --line <<< "$raw" >&2
      echo "no review of the head within $wait min$([[ $state == stale ]] && echo " (stale: did you ask again? --again)")" >&2
      exit 75
    fi
    sleep "$poll"
    verdict
  done
fi

if ((json)); then
  echo "$v"
else
  echo "PR #$number $(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).url ?? "")' <<< "$v")"
  node "$(dirname "$0")/codex-review.mjs" --text <<< "$raw"
fi
case $state in clean) exit 0 ;; findings) exit 1 ;; *) exit 2 ;; esac
