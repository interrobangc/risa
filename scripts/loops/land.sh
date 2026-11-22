#!/usr/bin/env bash
# Land a PRD, hotfix or planning branch in dev. Run it only on the dev keeper's
# say-so for that landing.
#
#   land.sh <topic> [-m "feat(<topic>): what it adds (B-1, B-2)"] [--recheck "<why>"|--force] [--no-review] [--local]
#   land.sh hotfix/<name> --pr|--local [-m "fix(<area>): …"] [--recheck "<why>"|--force] [--no-review]
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
# --recheck "<why>": when that gate would refuse the tip, land runs the check
# the plan (check-plan.mjs on dev...tip) asks for, `pnpm prd check` or
# `pnpm prd check --quick`, in the branch's worktree, just before the merge
# (after every other refusal), and lands only on a pass with the tip unmoved. A
# branch with no worktree (a pushed hotfix) is refused. When the gate already
# accepts the tip it runs nothing. The reason goes into the landing report.
# --force (the user's word only) skips the check requirement, not the sync, and not the doc budget:
# it also refuses (doc-budget.mjs) when the branch grows a doc that is already
# over its budget, for every kind of branch (a plan branch lands docs).
# The PR path also refuses unless the PR is open, its head is the branch's
# local tip, and Codex's verdict on it is clean (pnpm prd review): a clean
# verdict on an older head carries over plain dev merges that leave the PR's
# diff alone (codex-review.mjs), and the merge is still pinned to the tip.
# --no-review skips only the verdict, and only on the user's word. A prd/ branch
# whose whole diff is Markdown (lib.sh, docs_only) needs no verdict: it still
# goes through its open PR, and land says it skipped the verdict.
#
# After a merge of a prd/ or hotfix/ branch whose diff isn't Markdown only, land
# writes to-test/<date>-<time>-<topic>.md in the main checkout (gitignored): what
# landed, how to try it, what wasn't checked, the follow-ups. Land writes it
# itself so it exists even if the session dies after merging; agents only add
# files there. No file for a plan/ branch, a docs-only landing or a failed merge.
#
# Test seam: CARETOOK_PR_THROWAWAY=1 (a branch with "throwaway" in its name
# only) measures the sync against origin/dev instead of dev, and stops the PR
# path after its refusals, printing the merge it would run: nothing is pushed
# or merged. CARETOOK_PNPM_BIN replaces `pnpm` for the recheck (a stub in tests).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
use_node || true

what="" msg="" force="" path="" noreview="" recheck="" need_recheck=""
while (($#)); do
  case $1 in
    -m) msg=${2:?-m "subject"}; shift 2 ;;
    --force) force=1; shift ;;
    --recheck)
      recheck=${2:-}
      [[ -n $recheck && $recheck != -* ]] || die "--recheck needs a reason: --recheck \"<why>\""
      shift 2 ;;
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
[[ -z $recheck || -z $force ]] || die "--recheck and --force: pass one (--force only on the user's word)"
[[ -z $recheck || $branch != plan/* ]] || die "a plan/ branch has no check gate: drop --recheck"
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
  if checked_ok "$gate" "$branch"; then
    checkline=$(checked_how "$gate" "$branch")
    echo "check: $checkline"
    [[ -z $recheck ]] || echo "--recheck: the gate already accepts the tip, so nothing is rechecked"
  elif [[ -n $recheck ]]; then
    [[ -d $dir ]] ||
      die "--recheck runs \`pnpm prd check\` in $branch's worktree, and it has none ($dir): it can't be rechecked here"
    [[ $(git -C "$dir" rev-parse HEAD) == $(git -C "$main" rev-parse "$branch") ]] ||
      die "$dir isn't at $branch's tip: check out $branch there, then land"
    need_recheck=1
    echo "check: stale on $branch's tip; --recheck runs it before the merge: $recheck"
  else
    die "\`pnpm check\` hasn't passed on $branch's tip (or on an earlier commit with only docs and tooling changed since): run \`pnpm prd check\` (or \`--quick \"<why>\"\`) in $dir, or land with --recheck \"<why>\" (it runs that check on the tip and lands on a pass)"
  fi
fi
# recheck → run the check the plan asks for on the tip, in the branch's
# worktree (so in a check lease, timed like any check); refuse unless it passed
# and the tip didn't move. Sets checkline to how the tip passed.
recheck() {
  local tip0 plan mode reason pnpm=${CARETOOK_PNPM_BIN:-pnpm}
  tip0=$(git -C "$main" rev-parse "$branch")
  plan=$(git -C "$main" diff --name-only "$trunk...$branch" | node "$(dirname "$0")/check-plan.mjs" --mode quick)
  mode=$(sed -n 1p <<< "$plan") reason=$(sed -n 2p <<< "$plan")
  if [[ $mode == full ]]; then
    echo "recheck: $reason, so \`pnpm prd check\` in $dir ($recheck)"
    (cd "$dir" && "$pnpm" prd check) || die "the recheck failed on $branch's tip: nothing landed"
  else
    echo "recheck: \`pnpm prd check --quick\` in $dir ($recheck)"
    (cd "$dir" && "$pnpm" prd check --quick "recheck at landing: $recheck") ||
      die "the recheck failed on $branch's tip: nothing landed"
  fi
  [[ $(git -C "$main" rev-parse "$branch") == "$tip0" ]] || die "$branch's tip moved during the recheck: nothing landed"
  checked_ok "$dir" "$branch" || die "the recheck passed, but $branch's tip still isn't recorded as checked: nothing landed"
  checkline="$(checked_how "$dir" "$branch"), rechecked at landing: $recheck"
  echo "check: $checkline"
}

[[ -n $msg ]] || msg=$(land_subject "$branch")
# Decided before the merge, while the diff against dev still exists.
want_to_test=""
if [[ $branch != plan/* ]] && ! docs_only "$drift_ref" "$branch"; then want_to_test=1; fi
changed=$(git -C "$main" diff --name-only "$drift_ref...$branch")
commits=$(git -C "$main" log --first-parent --format='- %s (`%h`)' "$drift_ref..$branch" | grep -vE "\): merge (origin/)?$trunk( |\$)" | head -30 || true)
checkline=${checkline:-}
# write_to_test PR_URL → to-test/<date>-<time>-<topic>.md in the main checkout.
write_to_test() {
  [[ -n $want_to_test ]] || return 0
  local dir_t="$main/to-test" slug file n=1 items open_items commit title unchecked=()
  slug=${topic//\//-}
  mkdir -p "$dir_t"
  file="$dir_t/$(date +%Y-%m-%d-%H%M)-$slug.md"
  while [[ -e $file ]]; do n=$((n + 1)); file="$dir_t/$(date +%Y-%m-%d-%H%M)-$slug-$n.md"; done
  if [[ $path == pr ]]; then
    git -C "$main" fetch -q origin "$trunk" 2>/dev/null || true
    commit=$(git -C "$main" rev-parse --short "origin/$trunk" 2>/dev/null || git -C "$main" rev-parse --short "$trunk")
  else
    commit=$(git -C "$main" rev-parse --short "$trunk")
  fi
  [[ -z $force ]] || unchecked+=("the check was skipped (--force)")
  [[ -z $need_recheck ]] || unchecked+=("the last check was stale; the tip was rechecked at landing ($recheck)")
  [[ $checkline != quick* ]] || unchecked+=("only a quick check ran: $checkline")
  [[ -z $noreview ]] || unchecked+=("merged without a clean Codex verdict (--no-review)")
  [[ $path != local ]] || unchecked+=("landed locally: no PR and no Codex review")
  [[ $checkline != "none needed"* ]] || unchecked+=("no check ran: $checkline")
  unchecked+=("browser checks: land can't see which ran; the landing report says")
  # The topic's plain title: its PRD's (or plan's) first heading, on the branch.
  title=$(git -C "$main" show "$branch:plans/$topic-prd.md" 2>/dev/null ||
    git -C "$main" show "$branch:plans/$topic-plan.md" 2>/dev/null || true)
  title=$(head -1 <<< "$title")
  title=${title#\# }; title=${title#PRD: }; title=${title#Plan: }
  items=$(node "$(dirname "$0")/../backlog/backlog.mjs" list --all --prd "$topic" --json 2>/dev/null | node -e '
    let items = []; try { items = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch {}
    const rows = (st) => items.filter((i) => st.includes(i.status)).map((i) => `- ${i.id} ${i.title}`);
    console.log("ITEMS"); console.log(rows(["ready"]).join("\n") || "- (none marked done)");
    console.log("OPEN"); console.log(rows(["in-progress", "triaged", "inbox"]).join("\n") || "- (none)");
  ' 2>/dev/null || true)
  open_items=$(sed -n '/^OPEN$/,$p' <<< "$items" | sed 1d)
  items=$(sed -n '/^ITEMS$/,/^OPEN$/p' <<< "$items" | sed '1d;$d')
  {
    echo "# Landed: ${title:-$topic}"
    echo
    echo "$msg (topic \`$topic\`)"
    echo
    echo "- Branch: \`$branch\`, landed in \`$trunk\` as \`$commit\` on $(date '+%Y-%m-%d %H:%M')"
    [[ -z ${1:-} ]] || echo "- Pull request: $1"
    echo
    echo "## What landed"
    echo
    echo "${items:-- (none marked done)}"
    echo
    echo "## What changed"
    echo
    echo "${commits:-- (none)}"
    echo
    echo "## What to try, and where"
    echo
    echo "- Run \`pnpm dev\` in $main (after \`pnpm install\`, or \`pnpm datastore:reset\` if the notes below say so) and open http://localhost:5173."
    echo "- Sign in as \`member@example.com\`, \`caretaker@example.com\` or \`viewer@example.com\` (the password is \`SEED_USER_PASSWORD\` in \`packages/data/.env\`)."
    echo "- Changed files, to find the screen or tool:"
    sed 's/^/  - /' <<< "$(head -20 <<< "$changed")"
    echo
    echo "## What wasn't checked"
    echo
    [[ -z $checkline ]] || echo "- The check that ran: $checkline."
    printf -- '- %s\n' "${unchecked[@]}"
    echo
    echo "## Follow-ups and still open"
    echo
    echo "${open_items:-- (none)}"
    echo
    echo "## After landing"
    echo
    next_steps | sed 's/^  /- /'
  } > "$file" || { echo "couldn't write $file"; return 0; }
  echo "to-test file: $file"
}
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
  [[ -z $need_recheck ]] || recheck
  git -C "$main" merge --no-ff -m "$msg" "$branch"
  echo
  echo "Landed $branch in $trunk as $(git -C "$main" rev-parse --short HEAD): $msg"
  write_to_test || echo "couldn't write the to-test file"
  next_steps
  exit 0
fi

# The PR path.
number=$(pr_for "$branch") || die "gh couldn't list $branch's PRs (gh auth status?)"
[[ -n $number ]] || die "no open PR from $branch into $trunk: open it with \`pnpm prd pr $what\`"
tip=$(git -C "$main" rev-parse "$branch")
raw=$(pr_state "$number") || die "gh couldn't read PR #$number"
v=$(node "$(dirname "$0")/codex-review.mjs" --repo="$main" --trunk="$drift_ref" <<< "$raw")
field() { node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0, "utf8"))[process.argv[1]] ?? ""))' "$1" <<< "$v"; }
head=$(field headSha) state=$(field state) url=$(field url)
[[ $head == "$tip" ]] ||
  die "PR #$number's head is ${head:0:7}, not $branch's local tip ${tip:0:7}: push it (\`pnpm prd pr $what\`), let Codex review it (\`pnpm prd review $what --wait\`), then land"
line=$(node "$(dirname "$0")/codex-review.mjs" --repo="$main" --trunk="$drift_ref" --line <<< "$raw")
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
[[ -z $need_recheck ]] || recheck
if [[ ${CARETOOK_PR_THROWAWAY:-} == 1 ]]; then
  echo "CARETOOK_PR_THROWAWAY: every refusal passed; stopping before the merge. It would push $trunk, then run:"
  printf ' %q' "${merge[@]}"; echo
  exit 0
fi

push_trunk
"${merge[@]}" || die "gh couldn't merge PR #$number ($url): nothing landed; see the PR"
echo
echo "Landed $branch in $trunk through PR #$number ($url): $msg"
write_to_test "$url" || echo "couldn't write the to-test file"
(dev_sync "$branch") ||
  die "PR #$number is merged on GitHub, but dev-sync stopped: fix what it says, then \`pnpm prd dev-sync $branch\`"
next_steps
