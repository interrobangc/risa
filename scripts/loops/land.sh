#!/usr/bin/env bash
# Land a PRD, hotfix or planning branch in dev. Run it only on the dev keeper's
# say-so for that landing.
#
#   land.sh <topic> [-m "feat(<topic>): what it adds (B-1, B-2)"] [--tier <t> [--why "<reason>"]] [--fixes B-n,…] [--force] [--no-review] [--skeptic <id>… | --by-user] [--local]
#   land.sh hotfix/<name> --pr|--local [-m "fix(<area>): …"] [--tier <t> [--why "<reason>"]] [--fixes B-n,…] [--force] [--no-review] [--skeptic <id>… | --by-user]
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
# a CI verdict for its tier (scripts/ci/ci.mjs gate, gate.mjs).
# The unsynced landing: when dev's commits since the last sync share no file with
# the branch and bring no risky one (dev-brought.mjs), land typechecks a temporary
# merge in the branch's worktree (unsynced.sh, in a check lease; none for a
# Markdown-only diff) and lands the unsynced tip, saying so in the merge body and
# the report. Never with --fixes, with --force unless --by-user, on the branch's own brake verdict,
# on a known dev brake (a brake verdict on the tip of dev it measures against, or
# a live dev-brake notice; no verdict is not a brake), or with
# CARETOOK_UNSYNCED=off: those keep the drift refusal.
# --tier <t>: the tier to wait for; the default is what the diff proposes
# (check-plan.mjs). Below the proposal it needs --why "<reason>", and the report
# names both; `none` under a real proposal takes --force. The gate
# runs just before the merge (after every other refusal): it reads a whole-tier
# verdict for that tier or higher on the tip, or behind only docs and tooling
# commits, and requests the run when there is none. Green lands; a flake outside
# the branch's files lands and is filed after the merge; a failure lands only when
# blame gives all of it to dev, and a dev brake only with --fixes <its item>.
# Infra and unknown refuse with how to retry; a refusal exits with the verdict's code.
# --force and --no-review each need a land skeptic's go for this topic, tip and
# action (--skeptic <id>, repeated for both; land-skeptic.mjs) or the user's word
# (--by-user). A `no` refuses with its why. On a known brake or an unsynced tip,
# --force needs --by-user. Codex out of credits lets --no-review through with
# neither. The to-test file and land's output carry the verdict, and every Codex
# decline verdict recorded for the topic since its last landing.
# --force skips the check requirement, not the sync, and not the doc budget:
# it also refuses (doc-budget.mjs) when the branch grows a doc that is already
# over its budget, for every kind of branch (a plan branch lands docs).
# The PR path also refuses unless the PR is open, its head is the branch's
# local tip, and Codex's verdict on it is clean (pnpm prd review): a clean
# verdict on an older head carries over plain dev merges that leave the PR's
# diff alone (codex-review.mjs), and the merge is still pinned to the tip.
# --no-review skips only the verdict. A prd/ branch
# whose whole diff is Markdown (lib.sh, docs_only) needs no verdict: it still
# goes through its open PR, and land says it skipped the verdict.
#
# After a merge of a prd/ or hotfix/ branch whose diff isn't Markdown only, land
# writes to-test/<date>-<time>-<topic>.md in the main checkout (gitignored): what
# landed, how to try it, what wasn't checked, the follow-ups. Land writes it
# itself so it exists even if the session dies after merging; agents only add
# files there. No file for a plan/ branch, a docs-only landing or a failed merge.
# The same landings post a notice on the notice board (notice.mjs) for six
# hours: "landed <branch> in dev as <sha>: sync at your next wave boundary".
#
# Test seam: CARETOOK_PR_THROWAWAY=1 (a branch with "throwaway" in its name
# only) measures the sync against origin/dev instead of dev, and stops the PR
# path after its refusals, printing the merge it would run: nothing is pushed
# or merged.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
# shellcheck source=unsynced.sh
source "$(dirname "$0")/unsynced.sh"
use_node || true

what="" msg="" force="" path="" noreview="" tier="" why="" fixes=""
proposal="" proposal_why="" tierline="" gate_base="" gate_run="" gate_flakes="" gate_kind="" to_test_file=""
unsynced="" unsynced_tc="" unsynced_line="" unsynced_report=""
skeptics="" byuser="" skeptic_tip="" verdict_lines=""
ci_bin="$(cd "$(dirname "$0")/.." && pwd)/ci/ci.mjs"
skeptic_dir=${CARETOOK_SKEPTIC_DIR:-$loops/.skeptic}
while (($#)); do
  case $1 in
    -m) msg=${2:?-m "subject"}; shift 2 ;;
    --force) force=1; shift ;;
    --tier)
      tier=${2:-}
      [[ -n $tier && $tier != -* ]] || die "--tier needs a tier (none, static, unit, integration, components, full)"
      shift 2 ;;
    --why)
      why=${2:-}
      [[ -n $why && $why != -* ]] || die "--why needs a reason: --why \"<reason>\""
      shift 2 ;;
    --fixes)
      fixes=${2:-}
      [[ $fixes =~ ^B-[0-9]+(,B-[0-9]+)*$ ]] || die "--fixes takes backlog ids: --fixes B-1,B-2"
      shift 2 ;;
    --recheck) die "--recheck is gone: land waits for the CI tier itself (--tier <t>)" ;;
    --pr) path=pr; shift ;;
    --local) path=local; shift ;;
    --no-review) noreview=1; shift ;;
    --skeptic)
      [[ ${2:-} =~ ^s[0-9]+$ ]] || die "--skeptic takes a verdict's id: --skeptic s1"
      skeptics+=" $2"
      shift 2 ;;
    --by-user) byuser=1; shift ;;
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
[[ -z $tier$why$fixes || -z $force ]] || die "--force skips the gate: drop --tier, --why and --fixes"
[[ -z $skeptics || -z $byuser ]] || die "--skeptic or --by-user, not both"
[[ -z $skeptics$byuser || -n $force$noreview ]] || die "--skeptic and --by-user go with --force or --no-review"
[[ -z $tier$why$fixes || $branch != plan/* ]] || die "a plan/ branch has no check gate: drop --tier, --why and --fixes"
pr_seam "$branch"

git -C "$main" rev-parse --verify --quiet "$branch" >/dev/null || die "no branch $branch"
[[ $(git -C "$main" branch --show-current) == "$trunk" ]] || die "the main checkout isn't on $trunk"
[[ ! -e $(git -C "$main" rev-parse --absolute-git-dir)/MERGE_HEAD ]] || die "the main checkout is in the middle of a merge"
(($(git -C "$main" rev-list --count "$drift_ref..$branch") > 0)) || die "nothing to land: $branch has no commits that $drift_ref lacks"
# authorize ACTION TIP → the skeptic's go or the user's word for --ACTION, noted
# for the report; anything else refuses, naming both ways.
authorize() {
  local action=$1 tip=$2 id out args=()
  if [[ -n $byuser ]]; then
    verdict_lines+="- \`--$action\`: on the user's word (--by-user)"$'\n'
    echo "--$action: on the user's word (--by-user)"
    return 0
  fi
  [[ -n $skeptics ]] ||
    die "--$action needs a skeptic's go (--skeptic <id>: \`pnpm prd prompt skeptic land --evidence <file>\`, then \`pnpm prd skeptic record --kind land --action $action --tip $tip …\`) or the user's word (--by-user)"
  for id in $skeptics; do args+=(--id "$id"); done
  out=$(node "$(dirname "$0")/land-skeptic.mjs" check --dir "$skeptic_dir" --topic "$topic" --tip "$tip" --action "$action" "${args[@]}") ||
    die "--$action refused: $out"
  verdict_lines+="- \`--$action\`: skeptic $out"$'\n'
  echo "--$action: skeptic $out"
}
# force_brake → why a skeptic's go can't force this landing: a known dev brake,
# or a brake verdict on the branch's tip. Empty when neither is known.
force_brake() {
  local sha out rc=0
  unsynced_dev_brake "$(git -C "$main" rev-parse "$drift_ref")"
  if [[ -n $dev_brake ]]; then echo "$dev_brake"; return 0; fi
  sha=$(git -C "$main" rev-parse "$branch")
  out=$(cd "$main" && node "$ci_bin" "$sha" 2>/dev/null) || rc=$?
  if ((rc == 1)) && grep -q "^verdict: brake · [^ ]* · ${sha:0:8} · " <<< "$out"; then
    echo "CI reads a brake on $branch's tip ${sha:0:8}"
  fi
  return 0
}
if [[ -n $force ]]; then
  skeptic_tip=$(git -C "$main" rev-parse "$branch")
  authorize force "$skeptic_tip"
  if [[ -z $byuser ]]; then
    brake=$(force_brake)
    [[ -z $brake ]] || die "a skeptic's go doesn't cover a brake ($brake): --force --by-user, on the user's word"
  fi
fi
# drift_refusal [WHY] → today's refusal, with why it couldn't land unsynced.
drift_refusal() {
  die "$drift_ref has moved since $branch last synced${1:+ ($1)}: run \`pnpm prd sync\` and \`pnpm prd check\` in $dir first"
}
# judge_unsynced → the refusals that need no CI: sets unsynced, or refuses.
judge_unsynced() {
  local go why
  [[ ${CARETOOK_UNSYNCED:-} != off ]] || drift_refusal "CARETOOK_UNSYNCED=off"
  [[ -z $force || -n $byuser ]] || drift_refusal "a skeptic's go doesn't cover an unsynced tip: sync, or --force --by-user on the user's word"
  [[ -z $fixes ]] || drift_refusal "a landing with --fixes lands only synced"
  IFS=$'\t' read -r go why _ <<< "$(unsynced_verdict "$drift_ref" "$branch")"
  [[ $go == go ]] || drift_refusal "$why"
  if ! docs_only "$drift_ref" "$branch"; then
    unsynced_tc=1
    [[ -d $dir ]] || drift_refusal "no worktree to typecheck the merge in"
    [[ $(git -C "$dir" rev-parse HEAD) == $(git -C "$main" rev-parse "$branch") ]] ||
      drift_refusal "$dir isn't at $branch's tip"
    [[ -z $(git -C "$dir" status --porcelain) ]] || drift_refusal "uncommitted changes in $dir"
  fi
  unsynced=1
}
# A merge a killed landing left would read as uncommitted changes.
if [[ -d $dir ]]; then unsynced_clear "$dir"; fi
if [[ -n $(trunk_drift "$branch" "$drift_ref") ]]; then judge_unsynced; fi
if [[ -d $dir ]]; then
  [[ -z $(git -C "$dir" status --porcelain) ]] || die "uncommitted changes in $dir"
fi
node "$(dirname "$0")/doc-budget.mjs" land "$trunk" --head "$branch" --repo "$main" ||
  die "$branch grows a doc that is over its budget (scripts/loops/doc-budget.config.mjs): trim it, then land"
if [[ ($branch == prd/* || $branch == hotfix/*) && -z $force ]]; then
  proposed=$(propose_tier "$drift_ref" "$branch" "$tier") || die "unknown tier $tier (none, static, unit, integration, components, full)"
  { read -r proposal; read -r proposal_why; read -r tier_status; } <<< "$proposed"
  tier=${tier:-$proposal}
  [[ $tier_status != refused ]] ||
    die "--tier none skips the gate, and this diff proposes $proposal ($proposal_why): declare a tier, or --force with a skeptic's go or --by-user"
  [[ $tier_status != below || -n $why ]] ||
    die "--tier $tier is below the proposal, $proposal ($proposal_why): add --why \"<reason>\", or declare $proposal"
  tierline="tier $tier (proposed $proposal: $proposal_why)"
  [[ $tier_status != below ]] || tierline+="; below the proposal because: $why"
  echo "tier: $tierline"
  [[ $tier != none ]] || checkline="none needed (docs and tooling only)"
fi
# run_gate → the CI gate on the tip, just before the merge. A refusal exits with
# the verdict's code; nothing has landed.
run_gate() {
  [[ -n $tier && $tier != none ]] || return 0
  local out code=0 tip0 key value land_ok="" kind="" ran="" at=""
  tip0=$(git -C "$main" rev-parse "$branch")
  gate_base=$(git -C "$main" rev-parse "$drift_ref")
  out=$(mktemp)
  (cd "$main" && node "$ci_bin" gate "$branch" --tier "$tier" --base "$gate_base" --out "$out" \
    ${fixes:+--fixes "$fixes"}) || code=$?
  while IFS='=' read -r key value; do
    case $key in
      land) land_ok=$value ;; kind) kind=$value ;; ranTier) ran=$value ;;
      commit) at=$value ;; run) gate_run=$value ;; flakes) gate_flakes=$value ;;
    esac
  done < "$out"
  rm -f "$out"
  if ((code != 0)) || [[ $land_ok != 1 ]]; then
    echo "the $tier gate refused $branch: nothing landed" >&2
    exit "$((code == 0 ? 5 : code))"
  fi
  [[ $(git -C "$main" rev-parse "$branch") == "$tip0" ]] || die "$branch's tip moved during the gate: nothing landed"
  gate_kind=$kind
  checkline="CI $kind at $ran on ${at:0:7} (run $gate_run)"
  echo "check: $checkline"
}
# typecheck_merge DEV → the temporary merge's typecheck, in a check lease taken
# from the main checkout (so the worktree's own leases can be told apart). TERM
# and INT reach it: a background job ignores INT, so both go on as TERM.
typecheck_merge() {
  local here pid rc=0
  here=$(cd "$(dirname "$0")" && pwd)
  (cd "$main" && exec "$here/lease.sh" run check --label "unsynced typecheck of $branch" -- \
    "$here/unsynced.sh" typecheck "$dir" "$(git -C "$main" rev-parse "$branch")" "$1") &
  pid=$!
  trap 'kill -TERM "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; exit 143' TERM INT
  wait "$pid" || rc=$?
  trap - TERM INT
  case $rc in
    0) ;;
    3) drift_refusal "the merge with $drift_ref conflicts" ;;
    4) drift_refusal "the merged result doesn't typecheck" ;;
    5) drift_refusal "its worktree holds a check or browser lease" ;;
    6) drift_refusal "$dir isn't clean at $branch's tip" ;;
    75) drift_refusal "no check lease came free for the typecheck" ;;
    *) drift_refusal "the typecheck stopped (exit $rc)" ;;
  esac
}
# refuse_dev_brake SHA → the drift refusal when dev is known to be braked.
refuse_dev_brake() {
  [[ -z $force ]] || return 0 # --force got here on the user's word
  unsynced_dev_brake "$1"
  [[ -z $dev_brake ]] || drift_refusal "$dev_brake"
}
# land_unsynced → after the CI gate, before the merge: judge dev and its brake,
# typecheck, and read both again. If dev moved, do it once more, then refuse.
land_unsynced() {
  [[ -n $unsynced ]] || return 0
  [[ $gate_kind != brake ]] || drift_refusal "CI reads a brake, so it lands only synced"
  local tip0 pass go now base n ran
  tip0=$(git -C "$main" rev-parse "$branch")
  for pass in 1 2; do
    IFS=$'\t' read -r go now base <<< "$(unsynced_verdict "$drift_ref" "$branch")"
    [[ $go == go ]] || drift_refusal "$now"
    refuse_dev_brake "$now"
    [[ -z $unsynced_tc ]] || typecheck_merge "$now"
    if [[ $drift_ref == origin/* ]]; then
      git -C "$main" fetch --quiet origin "$trunk" || drift_refusal "couldn't read origin/$trunk again"
    fi
    [[ $(git -C "$main" rev-parse "$drift_ref") != "$now" ]] && {
      ((pass == 1)) || drift_refusal "it moved again during the typecheck"
      echo "$drift_ref moved during the typecheck: judging it once more"
      continue
    }
    [[ -z $unsynced_tc ]] || refuse_dev_brake "$now"
    break
  done
  [[ $(git -C "$main" rev-parse "$branch") == "$tip0" ]] || die "$branch's tip moved during the typecheck: nothing landed"
  n=$(unsynced_commits "$base" "$now")
  ran="only the merged result's typecheck ran"
  [[ -n $unsynced_tc ]] || ran="Markdown only, so no typecheck ran"
  ((n == 1)) && n="1 commit" || n="$n commits"
  unsynced_line="Landed on an unsynced tip: $trunk had $n since the last sync, sharing no file with it"
  unsynced_report="landed on an unsynced tip: \`$trunk\` had $n since the last sync, sharing no file with it; $ran"
  echo "$unsynced_report"
}
# flake_args → the `ci file` arguments for this landing. A local landing never
# pushes: publishing dev stays the keeper's.
flake_args() {
  printf '%s\n' file "$branch" --base "$gate_base" --run "$gate_run"
  if [[ $path == local ]]; then echo --no-push; fi
}
flake_retry() {
  [[ $gate_flakes == 1 ]] || return 0
  local args=()
  while read -r line; do args+=("$line"); done < <(flake_args)
  echo "pnpm prd ci ${args[*]}"
}
# file_flakes → file the verdict's flakes, after the merge. It can't undo the
# landing: a failure is reported, added to the to-test file, and returned as 5.
file_flakes() {
  [[ $gate_flakes == 1 ]] || return 0
  local args=() retry
  while read -r line; do args+=("$line"); done < <(flake_args)
  retry=$(flake_retry)
  (cd "$main" && node "$ci_bin" "${args[@]}") && return 0
  echo "landed, but the flakes weren't all filed. Retry: $retry" >&2
  if [[ -n $to_test_file ]]; then echo "- The flakes weren't all filed. Retry: \`$retry\`" >> "$to_test_file"; fi
  return 5
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
  [[ -z $noreview ]] || unchecked+=("merged without a clean Codex verdict (--no-review)")
  [[ $path != local ]] || unchecked+=("landed locally: no PR and no Codex review")
  [[ -z $unsynced_report ]] || unchecked+=("$unsynced_report")
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
    [[ -z $tierline ]] || echo "- The landing's $tierline."
    printf -- '- %s\n' "${unchecked[@]}"
    echo
    if [[ -n $verdict_lines ]]; then
      echo "## What the skeptic said"
      echo
      printf '%s' "$verdict_lines"
      echo
    fi
    echo "## Follow-ups and still open"
    echo
    echo "${open_items:-- (none)}"
    echo
    echo "## After landing"
    echo
    next_steps | sed 's/^  /- /'
  } > "$file" || { echo "couldn't write $file"; return 0; }
  to_test_file=$file
  echo "to-test file: $file"
}
# post_landed → after a code landing (the same test as the to-test file's: a
# prd/ or hotfix/ branch whose diff isn't Markdown only), the notice board's
# "landed, sync at your next wave boundary" line for six hours (notice.mjs),
# from the topic's session. A failure to post only warns: it never fails the landing.
post_landed() {
  [[ -n $want_to_test ]] || return 0
  local sha session
  if [[ $path == pr ]]; then
    sha=$(git -C "$main" rev-parse --short "origin/$trunk" 2>/dev/null || git -C "$main" rev-parse --short "$trunk")
  else
    sha=$(git -C "$main" rev-parse --short "$trunk")
  fi
  case $branch in prd/*) session=prd-$topic ;; *) session=${branch%%/*}-${topic//\//-} ;; esac
  CARETOOK_NOTICES_DIR=${CARETOOK_NOTICES_DIR:-$loops/.notices} node "$(dirname "$0")/notice.mjs" notice \
    --session "$session" --topic "$topic" --for 360 \
    "landed $branch in $trunk as $sha: sync at your next wave boundary (pnpm prd sync), not mid-wave" >/dev/null 2>&1 &&
    echo "notice posted: $topic landed as $sha (six hours)" ||
    echo "warning: couldn't post the landing notice (ignored)" >&2
  return 0
}
# skeptic_report → before the merge: the topic's Codex declines join the verdicts,
# printed for the run-through report (a Markdown-only landing has no to-test file).
skeptic_report() {
  local declines
  [[ -z $skeptic_tip || $(git -C "$main" rev-parse "$branch") == "$skeptic_tip" ]] ||
    die "$branch's tip moved after the skeptic's check: nothing landed"
  declines=$(node "$(dirname "$0")/land-skeptic.mjs" declines --dir "$skeptic_dir" --topic "$topic" 2>/dev/null) || declines=""
  [[ -z $declines ]] || verdict_lines+=$(sed 's/^/- /' <<< "$declines")$'\n'
  if [[ -n $verdict_lines ]]; then
    echo "The skeptic's verdicts, for the landing and run-through reports:"
    printf '%s' "$verdict_lines"
  fi
}
# mark_landed → the next landing's declines start after this one. Never fails it.
mark_landed() {
  node "$(dirname "$0")/land-skeptic.mjs" landed --dir "$skeptic_dir" --topic "$topic" 2>/dev/null ||
    echo "warning: couldn't mark the landing in the skeptic store (ignored)" >&2
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
  run_gate
  land_unsynced
  skeptic_report
  git -C "$main" merge --no-ff -m "$msg" ${unsynced_line:+-m "$unsynced_line"} "$branch"
  echo
  echo "Landed $branch in $trunk as $(git -C "$main" rev-parse --short HEAD): $msg"
  mark_landed
  [[ -z $tierline ]] || echo "Landed at $tierline"
  write_to_test || echo "couldn't write the to-test file"
  post_landed || true
  filed=0
  file_flakes || filed=$?
  next_steps
  exit "$filed"
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
if [[ $state != clean && $branch == prd/* ]] && docs_only "$drift_ref" "$branch"; then
  echo "$line: no Codex verdict needed, the diff against $drift_ref is Markdown only (PR #$number is open with the local tip as its head)"
elif [[ $state != clean ]]; then
  [[ -n $noreview ]] ||
    die "Codex's verdict on PR #$number isn't clean ($line): \`pnpm prd review $what\`; --no-review needs a skeptic's go (--skeptic <id>) or --by-user"
  if [[ $state == out-of-credits ]]; then
    verdict_lines+="- \`--no-review\`: Codex is out of credits, so no skeptic was needed"$'\n'
  else
    authorize no-review "$tip"
  fi
  echo "$line: merging without a clean review (--no-review)"
else
  echo "$line"
fi
repo=$(gh_repo) || die "gh couldn't name origin's repository"
merge=(gh pr merge "$number" -R "$repo" --merge --subject "$msg" --match-head-commit "$tip" --delete-branch)
run_gate
land_unsynced
[[ -z $unsynced_line ]] || merge+=(--body "$unsynced_line")
skeptic_report
if [[ ${CARETOOK_PR_THROWAWAY:-} == 1 ]]; then
  echo "CARETOOK_PR_THROWAWAY: every refusal passed; stopping before the merge. It would push $trunk, then run:"
  printf ' %q' "${merge[@]}"; echo
  exit 0
fi

push_trunk
"${merge[@]}" || die "gh couldn't merge PR #$number ($url): nothing landed; see the PR"
echo
echo "Landed $branch in $trunk through PR #$number ($url): $msg"
mark_landed
[[ -z $tierline ]] || echo "Landed at $tierline"
write_to_test "$url" || echo "couldn't write the to-test file"
post_landed || true
retry=$(flake_retry)
(dev_sync "$branch") ||
  die "PR #$number is merged on GitHub, but dev-sync stopped: fix what it says, then \`pnpm prd dev-sync $branch\`${retry:+, then file the flakes: \`$retry\`}"
filed=0
file_flakes || filed=$?
next_steps
exit "$filed"
