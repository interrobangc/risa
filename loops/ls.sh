#!/usr/bin/env bash
# A warning when the project's pinned risa differs from the release running
# (pin.mjs), then every worktree in .loops: name, slot, branch, commits ahead of the branch
# it merges into, dirty state, its containers and its dev server link, and the
# held PRDs (a hold's date and reason beside it). Then the
# machine's load averages, any stale slot lease, the shared test Postgres,
# leftovers for `gc` (merged slice worktrees and stacks stopped for over
# a day), and who holds the machine-wide leases (browser checks and prd
# check: lease.sh holders), and after the worktree table the dispatcher (running,
# paused and why, or stopped; its last log entry), the recorded sessions (managed
# or by hand), the open asks, the workers (status-extra.mjs: every lease, prd
# command and slice agent with its age, usual time and state), the usage limits (usage.mjs) and the live notices. (status, and status-watch)
set -euo pipefail
# shellcheck source=stack-lib.sh
source "$(dirname "$0")/stack-lib.sh"

# The project's pinned risa against the release running (pin.mjs): one warning line
# when they differ, nothing otherwise (no pin, or a run from a checkout).
pin=$(node "$(dirname "$0")/pin.mjs" --root "$loops_lib_dir/.." 2>/dev/null || true)
[[ -z $pin ]] || printf '%s\n\n' "$pin"

fmt='%-22s %-4s %-28s %-22s %-6s %-10s %s\n'
# shellcheck disable=SC2059
printf "$fmt" NAME SLOT BRANCH "AHEAD OF" STATE CONTAINERS "DEV SERVER"
found="" leftovers="" branches=() slice_dirs=()
limit=$(gc_stopped_after)
for dir in "$loops"/*/; do
  [[ -d $dir ]] || continue
  dir=${dir%/}; name=$(basename "$dir")
  branch=$(git -C "$dir" branch --show-current)
  parent=$(parent_of "$branch")
  ahead=$(git -C "$dir" rev-list --count "$parent..HEAD" 2>/dev/null || echo '?')
  dirty=$([[ -n $(git -C "$dir" status --porcelain) ]] && echo dirty || echo clean)
  # One stack hook call per worktree: its project, slot, containers, port and stopped-since.
  rc=0; facts=$(stack_hook stackReady "$dir" 2>/dev/null) || rc=$?
  proj=$(fact project "$facts")
  # ready= comes with every answer; without one (but no such hook, 127) the hook failed.
  if ((rc != 127)) && [[ -z $(fact ready "$facts") ]]; then
    slot=? stack=unknown web="? (the stackReady hook failed)"
  elif [[ -n $proj ]]; then
    slot=$(fact slot "$facts"); slot=${slot:-?}
    containers=$(fact containers "$facts"); up=${containers%%/*}; up=${up:-0}
    port=$(fact web_port "$facts")
    stack="$up up"
    if ((up == 0)); then
      secs=$(fact stopped_secs "$facts")
      [[ -n $secs ]] && ((secs >= limit)) &&
        leftovers+="stopped stack: $name ($proj stopped $(fmt_age "$secs") ago): ${prd_cmd} gc"$'\n'
    fi
    web="http://localhost:$port $([[ -n $(server_pids "$port") ]] && echo "(running)" || echo "(stopped: ${prd_cmd} serve $name)")"
  else
    slot=- stack=none web=-
  fi
  found=1
  [[ -z $branch ]] || branches+=("$branch")
  if [[ $branch == "$slice_prefix"*/* ]]; then
    slice_dirs+=("$dir")
    # Only what gc would take: a slice stays until its wave has landed.
    if slice_merged "$dir" && git -C "$dir" merge-base --is-ancestor HEAD "$trunk" 2>/dev/null; then
      leftovers+="merged: $name ($branch is merged into $parent): ${prd_cmd} gc"$'\n'
    fi
  fi
  # shellcheck disable=SC2059
  printf "$fmt" "$name" "$slot" "$branch" "+$ahead $parent" "$dirty" "$stack" "$web"
done
[[ -n $found ]] || echo "(no worktrees: ${prd_cmd} start <topic>)"
echo "PRD worktrees: $(prd_count) of $max_prds${max_prds_from:+ ($max_prds_from)}"

# The held PRDs (list's rows), each with its hold's date and reason when it has
# one (registry.mjs's heldText); nothing, heading included, when none is held.
holds=$(cd "$main" && backlog_run prd list --json 2>/dev/null |
  RISA_REGISTRY="$loops_lib_dir/../backlog/registry.mjs" node --input-type=module -e '
    const { heldText } = await import(process.env.RISA_REGISTRY);
    let text = ""; for await (const c of process.stdin) text += c;
    for (const r of JSON.parse(text)) if (r.flags.includes("hold") && r.state !== "done")
      console.log(`  ${r.topic}: on hold${r.held ? ` since ${heldText(r)}` : ""}`);
  ' 2>/dev/null) || holds=""
[[ -z $holds ]] || printf '\nHolds\n%s\n' "$holds"

# The dispatcher, recorded sessions and open asks (status-extra.mjs): sessions and asks print nothing,
# heading included, when there are none.
extra=$(RISA_SESSIONS_DIR=${RISA_SESSIONS_DIR:-$loops/.sessions} RISA_ASKS_DIR=${RISA_ASKS_DIR:-$loops/.asks} node "$(dirname "$0")/status-extra.mjs" 2>/dev/null || true)
[[ -z $extra ]] || printf '\n%s\n' "${extra%$'\n'}"
# The usage limits (usage.mjs status): one line, unknown when no session has read them lately.
usage=$(RISA_USAGE_DIR=${RISA_USAGE_DIR:-$loops/.usage} node "$(dirname "$0")/usage.mjs" status 2>/dev/null || true)
[[ -z $usage ]] || printf '\n%s\n' "$usage"
# The live notices' count (notice.mjs status): nothing when there are none.
notices=$(RISA_NOTICES_DIR=${RISA_NOTICES_DIR:-$loops/.notices} node "$(dirname "$0")/notice.mjs" status 2>/dev/null || true)
[[ -z $notices ]] || printf '\n%s\n' "${notices%$'\n'}"

# Each live branch's latest whole-tier CI verdict (ci.mjs status; cached, and short when GitHub is away).
# Never under Vitest: a test's fixture must not reach the real gh.
ci=""
if ((${#branches[@]})) && [[ -z ${VITEST:-} ]]; then
  ci=$(node "$(dirname "$0")/../ci/ci.mjs" status "${branches[@]}" 2>/dev/null || true)
  [[ -z $ci ]] || printf '\n%s\n' "${ci%$'\n'}"
fi

# Each slice's place in its wave; "waiting" reads the CI lines above, so it costs no extra call.
if ((${#slice_dirs[@]})); then
  echo
  echo "Slices"
  for dir in "${slice_dirs[@]}"; do
    b=$(git -C "$dir" branch --show-current); t=${b#"$slice_prefix"}; t=${t%%/*}
    going=0
    grep -qE "^  $(re_escape "$prd_prefix$t"): (running|.*\(a run is going\))" <<<"$ci" && going=1
    echo "  $(basename "$dir"): $(slice_state "$dir" "$going")"
  done
fi

# Sections are separated by a blank line; stale leases only show when there are any.
stale=""
for d in "$leases"/*/; do
  [[ -f $d/name ]] || continue
  holder=$(cat "$d/name")
  [[ -d $loops/$holder ]] || stale+="stale lease: slot $(basename "$d") held by $holder (no worktree; rm -r $d)"$'\n'
done
[[ -z $stale ]] || printf '\n%s' "$stale"
[[ -z $leftovers ]] || printf '\n%s' "$leftovers"

echo
if has_hook testDb; then
  stack_hook testDb status 2>/dev/null || echo "test database: unknown (the testDb hook failed)"
else
  echo "test database: none (no testDb hook)"
fi

echo
"$(dirname "$0")/lease.sh" holders

echo
# The load, against the cores and the 1-minute load browser checks treat as busy.
load=$(load_avg) cores=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo '?')
busy=${RISA_BROWSER_BUSY:-40} l1=${load%% *}
echo "load: $load (1, 5, 15 min) on $cores cores$( ((${l1%%.*} > busy)) && echo " · BUSY: over $busy, browser checks will wait before retrying")"
# The load gate checks and slice starts wait on (load-gate.mjs).
node "$(dirname "$0")/load-gate.mjs" --say 2>/dev/null || true
disk_line
