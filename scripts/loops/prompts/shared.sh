# shellcheck shell=bash
# prompts/shared.sh: the rules and helpers several prompts share, sourced by
# prompt.sh for every kind. default_rule and skeptic_rule go into the
# unattended prompts (run-through orchestrators, --auto planners); bye_line
# <role doc> is every session's 'bye' line.
#
# The names every prompt prints come from the project config (risa.json), so no
# prompt names a project's files or commands itself: what the tool's own commands
# are called (prd_cmd, backlog_cmd), the project's commands, its agents doc, plans,
# docs and backlog files, and each role's doc (role_doc). lib.sh gives the rest:
# the trunk, the branch prefixes, backlog_id_prefix and project_name.
prd_cmd=$(tool_command prd)
backlog_cmd=$(tool_command backlog)
check_cmd=$(project_command check)
# The project's commands a prompt only mentions: the tooling tests (else its check),
# its log (else git's), the docs' size budget (else none, and the hint goes) and the
# formatter a slice runs on its changed files (else none, and that line goes).
tooling_tests_cmd=$(project_command toolingTests 2>/dev/null || echo "$check_cmd")
log_cmd=$(project_command log 2>/dev/null || echo "git log")
doc_budget_cmd=$(project_command docBudget 2>/dev/null || true)
format_cmd=$(project_command format 2>/dev/null || true)
agents_doc=$(config_get paths.agentsDoc)
plans_dir=$(config_get paths.plans)
docs_dir=$(config_get paths.docs)
inbox_file=$(config_get paths.inbox)
prefs_doc=$(config_get paths.preferences 2>/dev/null || true)
# role_doc ROLE [SECTION] → the doc command that prints a role's doc (doc.mjs: the
# generic doc and the project's additions, or its replacement), or one section of it.
# A prompt names a role's doc only this way, never by its path.
role_doc() {
  if (($# > 1)); then echo "\`$prd_cmd doc $1 \"$2\"\`"; else echo "\`$prd_cmd doc $1\`"; fi
}
# role_file ROLE → the project's file for a role's doc, the one a session edits: its
# replacement, else its additions.
role_file() {
  config_get "roles.$1.replacement" 2>/dev/null || config_get "roles.$1.additions" 2>/dev/null ||
    echo "the $1 role's additions file"
}
# in_main NAME → the tool's command NAME, run on the main checkout from anywhere
# (the inbox agent works outside the repository): a pnpm script through -C, any
# other command after a cd.
in_main() {
  local c
  c=$(tool_command "$1")
  if [[ $c == "pnpm "* ]]; then echo "pnpm -s -C $main ${c#pnpm }"; else echo "cd $main && $c"; fi
}

# What silence means for an unattended session's question (run-through orchestrators, --auto planners).
default_rule="**Every question with a recommendation says what silence means.** Pass \`--defaults\` on it: if no one answers within 30 minutes, the tool takes your recommendation, and \`--wait\` prints it like any answer, with a second line saying it was defaulted; carry on with it as with any answer. Pass \`--waits\` instead for the questions that never default: money (a paid service too), data loss or a change to existing data, a live deploy (staging or production), a destructive step (deleting unmerged work, a forced push), a new dependency ($agents_doc: the user's approval), and compliance; those wait however long it takes. When unsure which, \`--waits\`. The tool, never you, puts the recommendation in place of an answer: never decide that silence means yes yourself."
# The skeptic every unattended question goes past first.
skeptic_rule="**A fresh skeptic reads every question first.** Write the question, its options, your recommendation and the evidence to a file outside the worktree, print the brief with \`$prd_cmd prompt skeptic ask --evidence <file>\`, and give it to one fresh agent on Opus (\`model: \"opus\"\`). Record its answer: \`$prd_cmd skeptic record --kind ask --verdict <decide|ask> --why \"<its line>\" --question \"<text>\" --offer \"<a>\" --offer \"<b>\" --defaults\` (or \`--waits\`; add \`--option \"<a>\"\` for a decide), which prints its id. On **ask**, file the question with \`--skeptic <id>\`: the same text, the same options in the same order, the same \`--defaults\` or \`--waits\` (if it tightened the wording, record and file the tightened one). On **decide**, ask nothing: \`$prd_cmd ask --decided --skeptic <id> --topic ${2:-<topic>} --question \"<text>\" --option \"<a>\" --option \"<b>\" --chose \"<a>\"\` files it for the user to veto under \"decided for you\", with no PushNotification and no wait, and you carry on with that option. A \`--waits\` question is never decided. Each verdict is used once; a land \`no\` or a plan \`send-back\` already counts as this skeptic, so pass its id."
# A message of just "bye" (pnpm prd bye, bye.mjs): the hand-over check, after the role doc's own checks.
bye_line() {
  echo "- **A message of just 'bye'** (from the phone too): first the checks $1 names under _Bye_, then run \`$prd_cmd bye\`. Clean, it ends this session: say nothing after it. Otherwise ask the user about each open thing it lists, one at a time (finish it, hand it off or drop it), then run it again."
}
