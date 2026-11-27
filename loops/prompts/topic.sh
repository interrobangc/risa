# shellcheck shell=bash
# prompts/topic.sh: what the orchestrator, plan and slice prompts share about
# their topic, sourced by prompt.sh before the kind's file: here (this
# worktree's top), prd_read and no_prd (a topic may have no PRD) and fix_line
# (a fixes topic's extra rule).
#
# A topic may have no PRD (the fixes-ui, fixes-tooling, fixes-perf, fixes-bug and fixes-nit topics): then its plan is the whole spec.
here=$(git rev-parse --show-toplevel 2>/dev/null || echo "$main")
if [[ -f $here/$plans_dir/$topic-prd.md ]]; then
  prd_read="$plans_dir/$topic-prd.md and "
else
  prd_read=""
  no_prd=" (there's no $plans_dir/$topic-prd.md: the plan is the whole spec)"
fi
fix_line=""
if [[ $topic == fixes-* ]]; then
  bt='`'
  fix_line=" **This is a fixes topic:** before each wave, append one slice per waiting item (${bt}$backlog_cmd list${bt}, status triaged, prd=$topic) to $plans_dir/$topic-plan.md (numbered on from ${bt}$prd_cmd status-trim $topic --next${bt}, which counts its history too), each with ${bt}Reads: $plans_dir/fixes-rules.md${bt}; the plan is the whole spec. Its _Status_ slice table keeps its header and separator with no slice in flight (an idle hand-over says so beside it, never in its place). Leave for a later wave any fix that would touch a running topic's hot files (${bt}$backlog_cmd prd list${bt}). Once the wave's slices are written, set your row's hot files to the path prefixes they will touch: ${bt}$backlog_cmd prd set $topic hot=<path prefixes>${bt} (removing your worktree clears them)."
fi
