#!/usr/bin/env bash
# Land a PRD, hotfix or planning branch in dev. Run it only on the dev keeper's
# say-so for that landing.
#
#   land.sh <topic> [-m "feat(<topic>): what it adds (B-1, B-2)"] [--force] [--no-review] [--local]
#   land.sh hotfix/<name> --pr|--local [-m "fix(<area>): …"] [--force] [--no-review]
#   land.sh plan/<topic> [-m "docs(<topic>): …"]
#
# Two paths:
#   the PR path    prd/ branches, and hotfix/ ones with --pr: the branch's open
#                  PR into dev (pnpm prd pr) is merged on GitHub (a merge commit
#                  with the -m subject, pinned to the checked tip with
#                  --match-head-commit, the remote branch deleted), after dev is
#                  pushed to origin (fast-forward only); then dev-sync (lib.sh)
#                  brings the main checkout's dev up to origin/dev.
#   the local path plan/ branches, and hotfix/ ones with --local: one
#                  `git merge --no-ff` in the main checkout, as before; pushing
#                  dev stays the dev keeper's.
# A hotfix must say which (ask the user "PR or local?"); a prd/ branch takes
# --local only as the fallback when the PR path fails, on the user's word.
#
# It refuses unless the branch already contains dev's work (`pnpm prd sync`;
# backlog-only commits on dev don't count) and, for a prd/ or hotfix/ branch,
# `pnpm prd check` (full or --quick) passed on its tip, or on an earlier commit
# with only docs and tooling changed since, or the branch changes only docs and
# tooling (lib.sh, checked_ok). It prints which, so the call is on record.
# --force skips the check requirement, not the sync, and not the doc budget:
# it also refuses (doc-budget.mjs) when the branch grows a doc that is already
# over its budget, for every kind of branch (a plan branch lands docs).
# The PR path also refuses unless the PR is open, its head is the branch's
# local tip, and Codex's verdict on it is clean (pnpm prd review).
# --no-review skips only the verdict, and only on the user's word. A prd/ branch
# whose whole diff is Markdown (lib.sh, docs_only) needs no verdict: it still
# goes through its open PR, and land says it skipped the verdict.
#
# Test seam: CARETOOK_PR_THROWAWAY=1 (a branch with "throwaway" in its name
# only) measures the sync against origin/dev instead of dev, and stops the PR
# path after its refusals, printing the merge it would run: nothing is pushed
# or merged.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
use_node || true

what="" msg="" force="" path="" noreview=""
while (($#)); do
  case $1 in
    -m) msg=${2:?-m "subject"}; shift 2 ;;
    --force) force=1; shift ;;
    --pr) path=pr; shift ;;
    --local) path=local; shift ;;
    --no-review) noreview=1; shift ;;
    --*) die "unknown option $1" ;;
    *) what=$1; shift ;;
  esac
done
[[ -n $what ]] || die "which PRD? (pnpm prd land <topic>)"
case $what in
  prd/* | plan/* | hotfix/*) branch=$what ;;
  *) branch=prd/$what ;;
esac
topic=${branch#*/}
dir=$(land_dir "$branch")
name=$(basename "$dir")
case $branch in
  prd/*)
    if [[ $path == local ]]; then echo "landing $branch locally (--local): the fallback, on the user's word only"
    else path=pr; fi
    ;;
  plan/*) [[ $path != pr ]] || die "a plan/ branch lands locally: drop --pr"; path=local ;;
  hotfix/*)
    [[ -n $path ]] || die "a hotfix lands through a PR or locally, and the user chooses: ask them \"PR or local?\", then pass --pr or --local"
    ;;
esac
[[ -z $noreview || $path == pr ]] || die "--no-review is for the PR path only"
pr_seam "$branch"

git -C "$main" rev-parse --verify --quiet "$branch" >/dev/null || die "no branch $branch"
[[ $(git -C "$main" branch --show-current) == "$trunk" ]] || die "the main checkout isn't on $trunk"
[[ ! -e $(git -C "$main" rev-parse --absolute-git-dir)/MERGE_HEAD ]] || die "the main checkout is in the middle of a merge"
(($(git -C "$main" rev-list --count "$drift_ref..$branch") > 0)) || die "nothing to land: $branch has no commits that $drift_ref lacks"
[[ -z $(trunk_drift "$branch" "$drift_ref") ]] ||
  die "$drift_ref has moved since $branch last synced: run \`pnpm prd sync\` and \`pnpm prd check\` in $dir first"
if [[ -d $dir ]]; then
  [[ -z $(git -C "$dir" status --porcelain) ]] || die "uncommitted changes in $dir"
fi
node "$(dirname "$0")/doc-budget.mjs" land "$trunk" --head "$branch" --repo "$main" ||
  die "$branch grows a doc that is over its budget (scripts/loops/doc-budget.config.mjs): trim it, then land"
if [[ ($branch == prd/* || $branch == hotfix/*) && -z $force ]]; then
  # A branch with no worktree left (a pushed hotfix) can still pass as docs and
  # tooling only: the main checkout holds no check record.
  gate=$dir; [[ -d $dir ]] || gate=$main
  checked_ok "$gate" "$branch" ||
    die "\`pnpm check\` hasn't passed on $branch's tip (or on an earlier commit with only docs and tooling changed since): run \`pnpm prd check\` (or \`--quick \"<why>\"\`) in $dir (or pass --force)"
  echo "check: $(checked_how "$gate" "$branch")"
fi

[[ -n $msg ]] || msg=$(land_subject "$branch")
changed=$(git -C "$main" diff --name-only "$drift_ref...$branch")
# next_steps → what the main checkout needs after the landing.
next_steps() {
  grep -qE '^packages/data/src/db/(migrations|seeds)/' <<< "$changed" &&
    echo "  migrations or seeds changed: run \`pnpm datastore:reset\` in $main"
  grep -q '^powersync/' <<< "$changed" && echo "  the sync config changed: run \`docker compose restart powersync\` in $main"
  grep -qE '(^|/)package\.json$|^pnpm-lock\.yaml$' <<< "$changed" && echo "  dependencies changed: run \`pnpm install\` in $main"
  [[ $path == local ]] && echo "  publish it with: git -C $main push origin $trunk"
  if [[ $branch == prd/* ]]; then echo "  when the whole PRD is done: pnpm prd rm $name"; else echo "  then: pnpm prd rm $name"; fi
}

if [[ $path == local ]]; then
  git -C "$main" merge --no-ff -m "$msg" "$branch"
  echo
  echo "Landed $branch in $trunk as $(git -C "$main" rev-parse --short HEAD): $msg"
  next_steps
  exit 0
fi

# The PR path.
number=$(pr_for "$branch") || die "gh couldn't list $branch's PRs (gh auth status?)"
[[ -n $number ]] || die "no open PR from $branch into $trunk: open it with \`pnpm prd pr $what\`"
tip=$(git -C "$main" rev-parse "$branch")
raw=$(pr_state "$number") || die "gh couldn't read PR #$number"
v=$(node "$(dirname "$0")/codex-review.mjs" <<< "$raw")
field() { node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0, "utf8"))[process.argv[1]] ?? ""))' "$1" <<< "$v"; }
head=$(field headSha) state=$(field state) url=$(field url)
[[ $head == "$tip" ]] ||
  die "PR #$number's head is ${head:0:7}, not $branch's local tip ${tip:0:7}: push it (\`pnpm prd pr $what\`), let Codex review it (\`pnpm prd review $what --wait\`), then land"
line=$(node "$(dirname "$0")/codex-review.mjs" --line <<< "$raw")
if [[ $state != clean && $branch == prd/* && -z $noreview ]] && docs_only "$drift_ref" "$branch"; then
  echo "$line: no Codex verdict needed, the diff against $drift_ref is Markdown only (PR #$number is open with the local tip as its head)"
elif [[ $state != clean ]]; then
  [[ -n $noreview ]] ||
    die "Codex's verdict on PR #$number isn't clean ($line): \`pnpm prd review $what\`; --no-review only on the user's word"
  echo "$line: merging without a clean review (--no-review, on the user's word)"
else
  echo "$line"
fi
repo=$(gh_repo) || die "gh couldn't name origin's repository"
merge=(gh pr merge "$number" -R "$repo" --merge --subject "$msg" --match-head-commit "$tip" --delete-branch)
if [[ ${CARETOOK_PR_THROWAWAY:-} == 1 ]]; then
  echo "CARETOOK_PR_THROWAWAY: every refusal passed; stopping before the merge. It would push $trunk, then run:"
  printf ' %q' "${merge[@]}"; echo
  exit 0
fi

push_trunk
"${merge[@]}" || die "gh couldn't merge PR #$number ($url): nothing landed; see the PR"
echo
echo "Landed $branch in $trunk through PR #$number ($url): $msg"
(dev_sync "$branch") ||
  die "PR #$number is merged on GitHub, but dev-sync stopped: fix what it says, then \`pnpm prd dev-sync $branch\`"
next_steps
