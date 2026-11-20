#!/usr/bin/env bash
# Land a PRD (or planning) branch in dev: one merge commit in the main checkout.
# Run it only on the dev keeper's say-so for that landing.
#
#   land.sh <topic> [-m "feat(<topic>): what it adds (B-1, B-2)"] [--force]
#   land.sh plan/<topic> [-m "docs(<topic>): …"]
#   land.sh hotfix/<name> [-m "fix(<area>): …"]
#
# It refuses unless the branch already contains dev's work (`pnpm prd sync`;
# backlog-only commits on dev don't count) and, for a prd/ or hotfix/ branch,
# `pnpm prd check` (full or --quick) passed on its tip, or on an earlier commit
# with only docs and tooling changed since, or the branch changes only docs and
# tooling (lib.sh, checked_ok). It prints which, so the call is on record.
# --force skips the check requirement, not the sync, and not the doc budget:
# it also refuses (doc-budget.mjs) when the branch grows a doc that is already
# over its budget, for every kind of branch (a plan branch lands docs).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

what="" msg="" force=""
while (($#)); do
  case $1 in
    -m) msg=${2:?-m "subject"}; shift 2 ;;
    --force) force=1; shift ;;
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
name=$topic
case $branch in plan/*) name=plan-$topic ;; hotfix/*) name=hotfix-$topic ;; esac
dir=$loops/$name

git -C "$main" rev-parse --verify --quiet "$branch" >/dev/null || die "no branch $branch"
[[ $(git -C "$main" branch --show-current) == "$trunk" ]] || die "the main checkout isn't on $trunk"
[[ ! -e $(git -C "$main" rev-parse --absolute-git-dir)/MERGE_HEAD ]] || die "the main checkout is in the middle of a merge"
(($(git -C "$main" rev-list --count "$trunk..$branch") > 0)) || die "nothing to land: $branch has no commits that $trunk lacks"
[[ -z $(trunk_drift "$branch") ]] ||
  die "$trunk has moved since $branch last synced: run \`pnpm prd sync\` and \`pnpm prd check\` in $dir first"
if [[ -d $dir ]]; then
  [[ -z $(git -C "$dir" status --porcelain) ]] || die "uncommitted changes in $dir"
fi
node "$(dirname "$0")/doc-budget.mjs" land "$trunk" --head "$branch" --repo "$main" ||
  die "$branch grows a doc that is over its budget (scripts/loops/doc-budget.config.mjs): trim it, then land"
if [[ ($branch == prd/* || $branch == hotfix/*) && -z $force ]]; then
  [[ -d $dir ]] && checked_ok "$dir" "$branch" ||
    die "\`pnpm check\` hasn't passed on $branch's tip (or on an earlier commit with only docs and tooling changed since): run \`pnpm prd check\` (or \`--quick \"<why>\"\`) in $dir (or pass --force)"
  echo "check: $(checked_how "$dir" "$branch")"
fi

if [[ -z $msg ]]; then
  ids=$(node "$(dirname "$0")/../backlog/backlog.mjs" list --all --prd "$topic" --status ready --json |
    node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));
      const t=r.length&&r.every(i=>i.type==="bug")?"fix":"feat";
      console.log(t+"\t"+r.map(i=>i.id).join(", "))')
  type=${ids%%$'\t'*}; ids=${ids#*$'\t'}
  [[ $branch == plan/* ]] && type=docs
  [[ $branch == hotfix/* ]] && type=fix
  msg="$type($topic): land $branch${ids:+ ($ids)}"
fi

changed=$(git -C "$main" diff --name-only "$trunk...$branch")
git -C "$main" merge --no-ff -m "$msg" "$branch"
echo
echo "Landed $branch in $trunk as $(git -C "$main" rev-parse --short HEAD): $msg"
grep -qE '^packages/data/src/db/(migrations|seeds)/' <<< "$changed" &&
  echo "  migrations or seeds changed: run \`pnpm datastore:reset\` in $main"
grep -q '^powersync/' <<< "$changed" && echo "  the sync config changed: run \`docker compose restart powersync\` in $main"
grep -qE '(^|/)package\.json$|^pnpm-lock\.yaml$' <<< "$changed" && echo "  dependencies changed: run \`pnpm install\` in $main"
echo "  publish it with: git -C $main push origin $trunk"
if [[ $branch == prd/* ]]; then echo "  when the whole PRD is done: pnpm prd rm $name"; else echo "  then: pnpm prd rm $name"; fi
