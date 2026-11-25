#!/usr/bin/env bash
# The "ready to land" report for a PRD branch: a link to try it, what it
# addresses (from the backlog), what it changes, and whether it can land.
# The orchestrator shows it to the user when a wave is green; anyone can run it
# at any time.
#
#   ready.sh [topic]      topic defaults to the worktree you're in
#
# The "Pull request" section names the open PR from prd/<topic> into dev and
# Codex's verdict on it (codex-review.mjs). READY_PR_BRANCH=<branch> looks for
# the PR from that branch instead (a test hook: a throwaway PR's head).
#
# Exits 0 when the branch can land, 1 when something still blocks it.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
# shellcheck source=unsynced.sh
source "$(dirname "$0")/unsynced.sh"

topic=${1:-$(n=$(here_name); [[ -n $n ]] && topic_of "$n")}
[[ -n $topic ]] || die "which PRD? (pnpm prd ready <topic>)"
branch=$prd_prefix$topic dir=$loops/$topic
git -C "$main" rev-parse --verify --quiet "$branch" >/dev/null || die "no branch $branch"
tip=$(git -C "$main" rev-parse --short "$branch")
ahead=$(git -C "$main" rev-list --count "$trunk..$branch")
drift=$(trunk_drift "$branch")

blockers=()
((ahead > 0)) || blockers+=("nothing to land: $branch has no commits that $trunk lacks")
synced="up to date with it"
if [[ -n $drift ]] && unsynced_safe "$branch" "$trunk"; then
  synced="behind it only by changes that need no merge"
  drift=""
fi
[[ -z $drift ]] || blockers+=("$trunk has newer work ($(wc -l <<< "$drift" | tr -d ' ') file(s) changed): run \`pnpm prd sync\` in $dir, then check again")
if [[ -d $dir ]]; then
  [[ -z $(git -C "$dir" status --porcelain) ]] || blockers+=("uncommitted changes in $dir")
else
  blockers+=("no worktree at $dir, so the checks can't be confirmed (pnpm prd start $topic)")
fi

if ((${#blockers[@]})); then
  echo "# $branch isn't ready to land yet"
  echo
  for b in "${blockers[@]}"; do echo "- ✗ $b"; done
else
  echo "# $branch is ready to land"
  echo
  echo "\`$branch\` at \`$tip\`: $ahead commit(s) ahead of \`$trunk\`, $synced. Check: $(checked_how "$dir" "$branch")."
  if proposed=$(propose_tier "$trunk" "$branch" 2>/dev/null); then
    { read -r ptier; read -r pwhy; } <<< "$proposed"
    echo
    echo "Proposed tier: **$ptier** ($pwhy)."
    if [[ $ptier != none ]]; then
      peek=$(cd "$main" && node "$(cd "$(dirname "$0")/.." && pwd)/ci/ci.mjs" gate "$branch" --tier "$ptier" \
        --base "$(git -C "$main" rev-parse "$trunk")" --peek 2>&1 | grep -m1 -E '^(verdict|no )' || true)
      echo "CI: ${peek:-no verdict read}"
    fi
  fi
fi

echo
echo "## Try it"
echo
port=$([[ -d $dir ]] && web_port "$dir" || true)
if [[ -z $port ]]; then
  echo "- No dev server (this worktree has no stack)."
elif [[ -n $(server_pids "$port") ]]; then
  echo "- **http://localhost:$port** (running)"
else
  echo "- http://localhost:$port (not running: \`pnpm prd serve $topic\`)"
fi
landing_hook try | sed 's/^/- /'

echo
echo "## Pull request"
echo
pr_head=${READY_PR_BRANCH:-$branch}
if ! command -v gh >/dev/null 2>&1; then
  echo "- No PR check: \`gh\` isn't installed."
elif ! pr=$(pr_for "$pr_head" 2>/dev/null); then
  echo "- Couldn't ask GitHub for the PR (\`gh auth status\`)."
elif [[ -z $pr ]]; then
  echo "- no PR yet: \`pnpm prd pr $topic\`"
else
  echo "- https://github.com/$(gh_repo)/pull/$pr"
  echo "- $(pr_verdict "$pr" --line 2>/dev/null || echo "codex: couldn't read the review state")"
fi

echo
echo "## What it addresses"
echo
node "$(dirname "$0")/../backlog/backlog.mjs" list --all --prd "$topic" --json | node -e '
  const items = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const groups = [["Bugs fixed", "bug"], ["Features", "feature"], ["Changes", "change"], ["Chores", "chore"], ["Plans", "plan"], ["Questions", "question"]];
  const ready = items.filter((i) => i.status === "ready");
  const open = items.filter((i) => ["in-progress", "triaged", "inbox"].includes(i.status));
  if (!ready.length) console.log("No backlog item is marked done in this branch (`pnpm backlog done B-<n>`).");
  for (const [label, type] of groups) {
    const rows = ready.filter((i) => i.type === type);
    if (!rows.length) continue;
    console.log(`**${label}**\n`);
    for (const r of rows) console.log(`- ${r.id} ${r.title}`);
    console.log();
  }
  const other = ready.filter((i) => !groups.some(([, t]) => t === i.type));
  for (const r of other) console.log(`- ${r.id} (${r.type}) ${r.title}`);
  if (open.length) {
    console.log(`**Still open in this PRD** (not finished by this landing)\n`);
    for (const r of open) console.log(`- ${r.id} ${r.title} (${r.status})`);
  }
'

echo
echo "## What changed"
echo
git -C "$main" log --first-parent --format='- %s (`%h`)' "$trunk..$branch" | grep -v "merge $trunk into" | head -30 || true
echo
git -C "$main" diff --shortstat "$trunk...$branch"
changed=$(git -C "$main" diff --name-only "$trunk...$branch")
notes=()
while IFS= read -r n; do [[ -z $n ]] || notes+=("$n"); done < <(landing_hook notes <<< "$changed")
grep -qE '(^|/)package\.json$|^pnpm-lock\.yaml$' <<< "$changed" && notes+=("changes **dependencies or scripts**: run \`pnpm install\` in the main checkout after landing")
if ((${#notes[@]})); then
  echo
  for n in "${notes[@]}"; do echo "- ⚠ $n"; done
fi

echo
if ((${#blockers[@]})); then
  exit 1
fi
echo "## To land it"
echo
echo "Say **\"land $topic\"** to the orchestrator, or run \`pnpm prd land $topic\`."
