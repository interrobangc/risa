#!/usr/bin/env bash
# Open (or update) a branch's PR into dev, so Codex reviews it before it lands.
#
#   pr.sh <topic|prd/<topic>|hotfix/<name>> [-m "<subject>"]
#
# For prd/ and hotfix/ branches; plan/ branches land locally and are refused.
# It refuses a branch that isn't synced with dev (trunk_drift, as land does;
# backlog-only commits on dev don't count), then:
#   1. pushes the main checkout's dev to origin/dev, fast-forward only, so the
#      PR's base is the dev the branch last synced with; it stops when
#      origin/dev has diverged (lib.sh, push_trunk);
#   2. pushes the branch (never forced);
#   3. opens the PR into dev, or updates the open one: the title is the landing
#      subject (-m, else the one `land` would build); the body lists the
#      topic's ready backlog items, the check pass (checked_how), and that plans
#      and the backlog are written outside review. Rerun it after every push.
# It prints the PR's URL. Codex reviews each push by itself: then
# `pnpm prd review <topic> --wait`.
#
# Test seam: CARETOOK_PR_THROWAWAY=1 (a branch with "throwaway" in its name
# only) never pushes dev and measures the sync against origin/dev instead, so a
# throwaway branch cut from origin/dev can be opened while local dev is ahead.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
use_node || true

what="" msg=""
while (($#)); do
  case $1 in
    -m) msg=${2:?-m "subject"}; shift 2 ;;
    -*) die "pr: unknown option $1 (-m \"<subject>\")" ;;
    *) [[ -z $what ]] || die "pr: one branch or topic"; what=$1; shift ;;
  esac
done
[[ -n $what ]] || what=$(topic_of "$(here_name)")
[[ -n $what ]] || die "which branch? (pnpm prd pr <topic|hotfix/<name>>)"
branch=$(pr_branch "$what")
case $branch in
  prd/* | hotfix/*) ;;
  plan/*) die "$branch lands locally (pnpm prd land $branch): plans and docs skip review" ;;
  *) die "$branch: pr takes a prd/ or hotfix/ branch" ;;
esac
topic=${branch#*/}
dir=$(land_dir "$branch")
pr_seam "$branch"

git -C "$main" rev-parse --verify --quiet "$branch" >/dev/null || die "no branch $branch"
(($(git -C "$main" rev-list --count "$drift_ref..$branch") > 0)) || die "nothing to review: $branch has no commits that $drift_ref lacks"
[[ -z $(trunk_drift "$branch" "$drift_ref") ]] ||
  die "$drift_ref has moved since $branch last synced: run \`pnpm prd sync\` (and the check) in $dir first"
[[ ! -d $dir || -z $(git -C "$dir" status --porcelain) ]] ||
  echo "note: $dir has uncommitted changes; only the commits go up"

repo=$(gh_repo) || die "gh couldn't name origin's repository (gh auth status?)"
if [[ ${CARETOOK_PR_THROWAWAY:-} != 1 ]]; then push_trunk; fi
git -C "$main" push --quiet origin "refs/heads/$branch:refs/heads/$branch" ||
  die "couldn't push $branch to origin (it is never forced: if origin's copy has moved, find out why first)"
tip=$(git -C "$main" rev-parse --short "$branch")
echo "pushed $branch ($tip)"

[[ -n $msg ]] || msg=$(land_subject "$branch")
gate=$dir; [[ -d $dir ]] || gate=$main
items=$(node "$(dirname "$0")/../backlog/backlog.mjs" list --all --prd "$topic" --status ready --json |
  node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));
    console.log(r.map(i=>`- ${i.id} (${i.type}): ${i.title}`).join("\n"))')
[[ -n $items ]] || items="- none marked ready for \`$topic\`"
body=$(
  cat <<BODY
Lands \`$branch\` in \`$trunk\` ($tip).

**Backlog items:**
$items

**Check:** $(checked_how "$gate" "$branch")

Plans, PRDs and the backlog are written outside review (committed straight onto \`$trunk\`), so review the code here, not \`plans/\` or docs prose.

Opened by \`pnpm prd pr\`; it merges with \`pnpm prd land\` on the dev keeper's word once Codex's review is clean.
BODY
)

number=$(pr_for "$branch") || die "gh couldn't list $branch's PRs"
if [[ -n $number ]]; then
  gh pr edit "$number" -R "$repo" --title "$msg" --body "$body" >/dev/null || die "couldn't update PR #$number"
  url=$(gh pr view "$number" -R "$repo" --json url -q .url 2>/dev/null)
  echo "updated PR #$number: $url"
else
  url=$(gh pr create -R "$repo" --base "$trunk" --head "$branch" --title "$msg" --body "$body") ||
    die "couldn't open a PR from $branch into $trunk"
  echo "opened $url"
fi
echo "Codex reviews each push by itself; then: pnpm prd review ${branch#prd/} --wait (in the background)"
