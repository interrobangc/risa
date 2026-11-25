#!/usr/bin/env bash
# Land a PRD, hotfix or planning branch in dev. Run it only on the dev keeper's
# say-so for that landing.
#
#   land.sh <topic> [-m "feat(<topic>): what it adds (B-1, B-2)"] [--tier <t> [--why "<reason>"]] [--fixes B-n,…] [--force] [--no-review] [--skeptic <id>… | --by-user] [--local]
#   land.sh hotfix/<name> --pr|--local [-m "fix(<area>): …"] [--tier <t> [--why "<reason>"]] [--fixes B-n,…] [--force] [--no-review] [--skeptic <id>… | --by-user]
#   land.sh plan/<topic> [-m "docs(<topic>): …"]
#   land.sh --resume <branch>   finish or undo a landing cut off midway (below)
#
# Two paths:
#   the PR path    prd/ branches, and hotfix/ ones with --pr: the branch's open
#                  PR into dev (pnpm prd pr) is merged on GitHub (a merge commit
#                  with the -m subject, pinned to the checked tip with
#                  --match-head-commit, the remote branch deleted), after dev is
#                  pushed to origin (fast-forward only; a pickup of anything but
#                  the backlog files there refuses: land_push_trunk); then
#                  dev-sync (lib.sh) brings the main checkout's dev up to origin/dev.
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
# it also refuses (the config's docBudget hook) when the branch grows a doc that
# is already over its budget, for every kind of branch (a plan branch lands docs).
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
# The landing journal (land-journal.mjs): from just before its first step that
# changes anything (the PR path's push, the local merge), a landing records each
# step in .loops/.landing/<branch>.json (CARETOOK_LANDING_DIR) before running it,
# and removes the record at the end; the to-test file's body is written there
# first too, so a resume can place it. While a record is there, land refuses the
# branch. --resume <branch> reads the record, asks git and GitHub how far it got,
# and then: finish (runs the steps left: the skeptic mark, the to-test file, the
# notice, dev-sync, the flakes), undo (nothing merged: the record goes, a cut-off
# local merge is aborted when MERGE_HEAD is the recorded tip, and the branch must
# go through land and every gate again), done, or ask (exit 3, the record kept:
# an unknown state, or a MERGE_HEAD that isn't the recorded tip, never aborted).
# It never reruns a merge. No record: it says so and exits 0.
#
# Test seams: CARETOOK_LAND_KILL_AT=<step> (a throwaway branch only) kills land
# with SIGKILL just before it records that step, as a crash would.
# CARETOOK_PR_THROWAWAY=1 (a branch with "throwaway" in its name
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
skeptics="" byuser="" skeptic_tip="" verdict_lines="" resume="" journal_at="" noticed=""
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
      [[ $fixes =~ ^$backlog_id_prefix[0-9]+(,$backlog_id_prefix[0-9]+)*$ ]] ||
        die "--fixes takes backlog ids: --fixes ${backlog_id_prefix}1,${backlog_id_prefix}2"
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
    --resume) resume=1; shift ;;
    --*) die "unknown option $1" ;;
    *) what=$1; shift ;;
  esac
done
[[ -n $what ]] || die "which PRD? (pnpm prd land <topic>)"
[[ -z $resume || -z $msg$force$path$noreview$tier$why$fixes$skeptics$byuser ]] ||
  die "--resume takes only the branch: the journal holds the rest"
case $what in
  "$prd_prefix"* | "$plan_prefix"* | "$hotfix_prefix"*) branch=$what ;;
  *) branch=$prd_prefix$what ;;
esac
topic=${branch#*/}
dir=$(land_dir "$branch")
name=$(basename "$dir")
case $branch in
  "$prd_prefix"*)
    if [[ $path == local ]]; then echo "landing $branch locally (--local): the fallback, on the user's word only"
    else path=pr; fi
    ;;
  "$plan_prefix"*) [[ $path != pr ]] || die "a $plan_prefix branch lands locally: drop --pr"; path=local ;;
  "$hotfix_prefix"*)
    [[ -n $path || -n $resume ]] || die "a hotfix lands through a PR or locally, and the user chooses: ask them \"PR or local?\", then pass --pr or --local"
    ;;
esac
[[ -z $noreview || $path == pr ]] || die "--no-review is for the PR path only"
[[ -z $tier$why$fixes || -z $force ]] || die "--force skips the gate: drop --tier, --why and --fixes"
[[ -z $skeptics || -z $byuser ]] || die "--skeptic or --by-user, not both"
[[ -z $skeptics$byuser || -n $force$noreview ]] || die "--skeptic and --by-user go with --force or --no-review"
[[ -z $tier$why$fixes || $branch != "$plan_prefix"* ]] || die "a $plan_prefix branch has no check gate: drop --tier, --why and --fixes"
pr_seam "$branch"
# The run log (run-log.mjs): this landing's start, and on every exit its end:
# the exit code, whether it merged, and its seconds. It never fails or stops a landing.
# The unsynced typecheck's own EXIT trap (unsynced.sh's restore) runs in its own
# process (lease.sh run … unsynced.sh typecheck), so it never clears this one;
# land_log_end is re-armed after it anyway, should that ever change.
landed=false
land_log_end() {
  local rc=$?
  trap - EXIT
  # Refused at the push: nothing changed, so the journal goes.
  [[ -n $resume || $landed == true || $journal_at != push ]] || journal_drop
  run_log land-end "branch=$branch" "path=$path" "exit:=$rc" "landed:=$landed" "seconds:=$SECONDS"
  exit "$rc"
}
# The landing journal (land-journal.mjs; the header says what it holds). Its
# writes never fail a landing: a failure only warns.
journal_dir=${CARETOOK_LANDING_DIR:-$loops/.landing}
journal=$journal_dir/${branch//\//-}.json
journal_body=${journal%.json}.to-test.md
journal_bin="$(dirname "$0")/land-journal.mjs"
# journal_step STEP [key=value…] → record STEP as the one about to run.
journal_step() {
  if [[ -n ${CARETOOK_LAND_KILL_AT:-} && $CARETOOK_LAND_KILL_AT == "$1" && $branch == *throwaway* ]]; then
    kill -KILL $$
  fi
  journal_at=$1
  node "$journal_bin" step "$journal" "$@" 2>/dev/null ||
    echo "warning: couldn't write the landing journal $journal (ignored)" >&2
}
# journal_note key=value… → add fields to the step in hand (no kill seam).
journal_note() { node "$journal_bin" step "$journal" "$journal_at" "$@" 2>/dev/null || true; }
journal_drop() { rm -f "$journal" "$journal_body"; }
run_log land-start "branch=$branch" "path=$path"
trap land_log_end EXIT

# A resume skips every refusal: what it may do is the journal's (resume_landing).
if [[ -z $resume ]]; then
  [[ ! -e $journal ]] ||
    die "a landing of $branch was cut off midway (its journal: $journal): \`pnpm prd land --resume $branch\` finishes or undoes it first"
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
    die "$drift_ref has moved since $branch last synced${1:+ ($1)}: run \`pnpm prd sync --force\` and \`pnpm prd check\` in $dir first"
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
  # The project's doc budget (the config's docBudget hook; none set: no budget).
  if config_get hooks.docBudget >/dev/null 2>&1; then
    run_hook docBudget land "$trunk" --head "$branch" --repo "$main" ||
      die "$branch grows a doc that is over its budget: trim it, then land"
  fi
  if [[ ($branch == "$prd_prefix"* || $branch == "$hotfix_prefix"*) && -z $force ]]; then
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
  trap land_log_end EXIT
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

if [[ -z $resume ]]; then
  [[ -n $msg ]] || msg=$(land_subject "$branch")
  # Decided before the merge, while the diff against dev still exists.
  want_to_test=""
  if [[ $branch != "$plan_prefix"* ]] && ! docs_only "$drift_ref" "$branch"; then want_to_test=1; fi
  changed=$(git -C "$main" diff --name-only "$drift_ref...$branch")
  commits=$(git -C "$main" log --first-parent --format='- %s (`%h`)' "$drift_ref..$branch" | grep -vE "\): merge (origin/)?$trunk( |\$)" | head -30 || true)
fi
checkline=${checkline:-}
# render_to_test PR_URL → before the merge, the to-test file's body into the
# journal ($journal_body), with @@LANDED_AS@@ for the commit the merge makes,
# and its name (to-test/<date>-<time>-<topic>.md in the main checkout) in
# $to_test_file. place_to_test writes it after the merge, a resume too.
render_to_test() {
  [[ -n $want_to_test ]] || return 0
  local dir_t="$main/to-test" slug file n=1 items open_items title unchecked=()
  slug=${topic//\//-}
  file="$dir_t/$(date +%Y-%m-%d-%H%M)-$slug.md"
  while [[ -e $file ]]; do n=$((n + 1)); file="$dir_t/$(date +%Y-%m-%d-%H%M)-$slug-$n.md"; done
  mkdir -p "$journal_dir" 2>/dev/null || journal_body=$(mktemp)
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
    echo "- Branch: \`$branch\`, landed in \`$trunk\` as \`@@LANDED_AS@@\` on $(date '+%Y-%m-%d %H:%M')"
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
  } > "$journal_body" || { echo "couldn't write the to-test file's body ($journal_body)"; return 0; }
  to_test_file=$file
}
# place_to_test → after the merge, the to-test file from its body, naming the
# commit the landing made; one already there (written before a cut-off) stays.
place_to_test() {
  [[ -n $want_to_test && -n $to_test_file ]] || return 0
  local commit
  if [[ -e $to_test_file ]]; then echo "to-test file: $to_test_file (already written)"; return 0; fi
  [[ -e $journal_body ]] || { echo "couldn't write the to-test file: its body ($journal_body) is gone"; to_test_file=""; return 0; }
  if [[ $path == pr ]]; then
    git -C "$main" fetch -q origin "$trunk" 2>/dev/null || true
    commit=$(git -C "$main" rev-parse --short "origin/$trunk" 2>/dev/null || git -C "$main" rev-parse --short "$trunk")
  else
    commit=$(git -C "$main" rev-parse --short "$trunk")
  fi
  mkdir -p "$(dirname "$to_test_file")" &&
    sed "s/@@LANDED_AS@@/$commit/" "$journal_body" > "$to_test_file" ||
    { echo "couldn't write $to_test_file"; to_test_file=""; return 0; }
  echo "to-test file: $to_test_file"
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
  case $branch in
    "$prd_prefix"*) session=prd-$topic ;;
    "$plan_prefix"*) session=plan-${topic//\//-} ;;
    "$hotfix_prefix"*) session=hotfix-${topic//\//-} ;;
    *) session=${branch%%/*}-${topic//\//-} ;;
  esac
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
    echo "  migrations or seeds changed: run \`$(project_command datastoreReset)\` in $main"
  grep -q '^powersync/' <<< "$changed" && echo "  the sync config changed: run \`docker compose restart powersync\` in $main"
  grep -qE '(^|/)package\.json$|^pnpm-lock\.yaml$' <<< "$changed" && echo "  dependencies changed: run \`pnpm install\` in $main"
  [[ $path == local ]] && echo "  publish it with: git -C $main push origin $trunk"
  if [[ $branch == "$prd_prefix"* ]]; then echo "  when the whole PRD is done: pnpm prd rm $name"; else echo "  then: pnpm prd rm $name"; fi
}

# journal_start STEP → the to-test body, then the journal's first record: STEP
# and everything a resume needs to finish without this shell.
journal_start() {
  render_to_test "${url:-}"
  journal_step "$1" "branch=$branch" "path=$path" "tip=$(git -C "$main" rev-parse "$branch")" "msg=$msg" \
    "topic=$topic" "number=${number:-}" "url=${url:-}" "wantToTest=$want_to_test" "toTest=$to_test_file" \
    "toTestBody=$journal_body" "changed=$changed" "gateFlakes=$gate_flakes" "gateBase=$gate_base" \
    "gateRun=$gate_run" "pid=$$"
}
# finish_from STEP → the steps after the merge, from STEP on, each recorded
# first; then the journal goes. Exits: 0, or 5 when the flakes weren't all filed.
finish_from() {
  local steps s go="" retry
  steps="mark to-test notice flakes"
  [[ $path != pr ]] || steps="mark to-test notice dev-sync flakes"
  filed=0
  for s in $steps; do
    [[ -n $go || $s == "$1" ]] || continue
    go=1
    journal_step "$s"
    case $s in
      mark) mark_landed ;;
      to-test) place_to_test ;;
      notice)
        # Its step ran before a cut-off: a resume doesn't post it twice.
        if [[ -n $noticed ]]; then echo "notice: its step ran before the cut-off"; else post_landed && journal_note noticed=1 || true; fi
        ;;
      dev-sync)
        retry=$(flake_retry)
        (dev_sync "$branch") ||
          die "PR #$number is merged on GitHub, but dev-sync stopped: fix what it says, then \`pnpm prd land --resume $branch\` (it syncs dev${retry:+, then files the flakes: \`$retry\`})"
        ;;
      flakes) file_flakes || filed=$? ;;
    esac
  done
  [[ -n $go ]] || die "no step $1 to finish from on the $path path"
  journal_drop
  next_steps
  exit "$filed"
}
# resume_landing → --resume: the journal's record and what git and GitHub say
# now (land-journal.mjs decide), then finish, undo, done or ask (exit 3).
resume_landing() {
  local k v step="" pid="" gd mh="" devhas=0 originhas="" prs="" running=0 action from abort why gh_r
  if [[ ! -e $journal ]]; then
    echo "no cut-off landing of $branch: there's no journal ($journal), so nothing to finish or undo"
    exit 0
  fi
  while IFS= read -r -d '' k && IFS= read -r -d '' v; do
    case $k in
      step) step=$v ;; path) path=$v ;; tip) tip=$v ;; msg) msg=$v ;; number) number=$v ;; url) url=$v ;;
      wantToTest) want_to_test=$v ;; toTest) to_test_file=$v ;; toTestBody) journal_body=$v ;;
      changed) changed=$v ;; gateFlakes) gate_flakes=$v ;; gateBase) gate_base=$v ;; gateRun) gate_run=$v ;;
      pid) pid=$v ;; noticed) noticed=$v ;;
    esac
  done < <(node "$journal_bin" fields "$journal" 2>/dev/null)
  if [[ -z $step ]]; then
    echo "ask: the journal $journal can't be read; nothing changed: ask the user" >&2
    exit 3
  fi
  echo "the landing of $branch was cut off at its $step step (the ${path:-unknown} path, tip ${tip:0:7})"
  gd=$(git -C "$main" rev-parse --absolute-git-dir)
  [[ ! -e $gd/MERGE_HEAD ]] || mh=$(head -1 "$gd/MERGE_HEAD")
  [[ -z ${tip:-} ]] || ! git -C "$main" merge-base --is-ancestor "$tip" "refs/heads/$trunk" 2>/dev/null || devhas=1
  if [[ $path == pr ]]; then
    if [[ -n ${tip:-} ]] && git -C "$main" fetch --quiet origin "$trunk" 2>/dev/null; then
      originhas=0
      ! git -C "$main" merge-base --is-ancestor "$tip" "refs/remotes/origin/$trunk" 2>/dev/null || originhas=1
    fi
    prs=unknown
    if [[ -n ${number:-} ]] && gh_r=$(gh_repo 2>/dev/null); then
      prs=$(gh pr view "$number" -R "$gh_r" --json state -q .state 2>/dev/null | tr '[:upper:]' '[:lower:]') || prs=unknown
      [[ $prs == open || $prs == merged || $prs == closed ]] || prs=unknown
    fi
  fi
  [[ -z $pid || $pid == "$$" ]] || ! kill -0 "$pid" 2>/dev/null || running=1
  { read -r action; read -r from; read -r abort; read -r why; } < <(node "$journal_bin" decide "$journal" \
    --merge-head "$mh" --dev-has "$devhas" --origin-has "$originhas" --pr "$prs" --running "$running")
  echo "$action: $why"
  case $action in
    done)
      journal_drop
      echo "nothing left to do: the journal is gone"
      exit 0
      ;;
    undo)
      if [[ -n $abort ]]; then
        git -C "$main" merge --abort || { echo "couldn't abort the merge in $main; the journal stays: ask the user" >&2; exit 3; }
        echo "aborted the cut-off merge of ${tip:0:7} in $main"
      fi
      journal_drop
      echo "undone: nothing of $branch landed. Land it again with \`pnpm prd land\`: every refusal and gate runs again."
      exit 0
      ;;
    finish)
      journal_step "$step" "pid=$$"
      landed=true
      finish_from "$from"
      ;;
    *)
      echo "nothing changed and the journal stays ($journal): ask the user" >&2
      exit 3
      ;;
  esac
}
[[ -z $resume ]] || resume_landing

if [[ $path == local ]]; then
  run_gate
  land_unsynced
  skeptic_report
  journal_start merge
  git -C "$main" merge --no-ff -m "$msg" ${unsynced_line:+-m "$unsynced_line"} "$branch" ||
    die "the merge of $branch stopped: \`pnpm prd land --resume $branch\` undoes it"
  landed=true
  echo
  echo "Landed $branch in $trunk as $(git -C "$main" rev-parse --short HEAD): $msg"
  [[ -z $tierline ]] || echo "Landed at $tierline"
  finish_from mark
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
if [[ $state != clean && $branch == "$prd_prefix"* ]] && docs_only "$drift_ref" "$branch"; then
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

journal_start push
land_push_trunk
journal_step merge
"${merge[@]}" ||
  die "gh couldn't merge PR #$number ($url): see the PR, then \`pnpm prd land --resume $branch\` (it finishes the landing if the merge went in, else undoes it)"
landed=true
echo
echo "Landed $branch in $trunk through PR #$number ($url): $msg"
[[ -z $tierline ]] || echo "Landed at $tierline"
finish_from mark
