# shellcheck shell=bash
# prompts/topic.sh: what the orchestrator, plan and slice prompts share about
# their topic, sourced by prompt.sh before the kind's file: here (this
# worktree's top), prd_read and no_prd (a topic may have no PRD) and fix_line
# (a fixes topic's extra rule).
#
# A topic may have no PRD (the fixes-ui, fixes-tooling, fixes-perf, fixes-bug and fixes-nit topics): then its plan is the whole spec.
here=$(git rev-parse --show-toplevel 2>/dev/null || echo "$main")
if [[ -f $here/plans/$topic-prd.md ]]; then
  prd_read="plans/$topic-prd.md and "
else
  prd_read=""
  no_prd=" (there's no plans/$topic-prd.md: the plan is the whole spec)"
fi
fix_line=""
if [[ $topic == fixes-* ]]; then
  bt='`'
  fix_line=" **This is a fixes topic:** before each wave, append one slice per waiting item (${bt}pnpm backlog list${bt}, status triaged, prd=$topic) to plans/$topic-plan.md (numbered on from ${bt}pnpm prd status-trim $topic --next${bt}, which counts its history too), each with ${bt}Reads: plans/fixes-rules.md${bt}; the plan is the whole spec. Leave for a later wave any fix that would touch a running topic's hot files (${bt}pnpm backlog prd list${bt}). Once the wave's slices are written, set your row's hot files to the path prefixes they will touch: ${bt}pnpm backlog prd set $topic hot=<path prefixes>${bt} (removing your worktree clears them)."
fi
