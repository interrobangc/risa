#!/usr/bin/env bash
# Land a PRD (or planning) branch in dev: one merge commit in the main checkout.
# Run it only on the dev keeper's say-so for that landing.
#
#   land.sh <topic> [-m "feat(<topic>): what it adds (B-1, B-2)"] [--force]
#   land.sh plan/<topic> [-m "docs(<topic>): …"]
#
# It refuses unless the branch already contains dev's work (`pnpm prd sync`;
# backlog-only commits on dev don't count) and, for a prd/ branch, `pnpm prd
# check` passed on its tip. The merged code is then exactly the code that was
# checked, so nothing needs rechecking on dev.
# --force skips the check requirement, not the sync.
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
  prd/* | plan/*) branch=$what ;;
  *) branch=prd/$what ;;
esac
topic=${branch#*/}
name=$topic; [[ $branch == plan/* ]] && name=plan-$topic
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
if [[ $branch == prd/* && -z $force ]]; then
  checked=$([[ -d $dir ]] && cat "$(checked_file "$dir")" 2>/dev/null || true)
  [[ $checked == "$(git -C "$main" rev-parse "$branch")" ]] ||
    die "\`pnpm check\` hasn't passed on $branch's tip: run \`pnpm prd check\` in $dir (or pass --force)"
fi

if [[ -z $msg ]]; then
  ids=$(node "$(dirname "$0")/../backlog/backlog.mjs" list --all --prd "$topic" --status ready --json |
    node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));
      const t=r.length&&r.every(i=>i.type==="bug")?"fix":"feat";
      console.log(t+"\t"+r.map(i=>i.id).join(", "))')
  type=${ids%%$'\t'*}; ids=${ids#*$'\t'}
  [[ $branch == plan/* ]] && type=docs
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
echo "  when the whole PRD is done: pnpm prd rm $name"
