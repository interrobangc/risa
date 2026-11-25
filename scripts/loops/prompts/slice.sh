# shellcheck shell=bash
# prompts/slice.sh: prompt.sh slice <topic> <n> [--continue], the prompt an
# orchestrator gives a slice agent; its fields come from slice-fields.mjs.
# Sourced by prompt.sh after shared.sh and topic.sh, with $topic set. The
# slice's section, its wave's intro and what it cites from the PRD are embedded
# at the end (slice-brief.mjs), so the agent never reads the whole plan or PRD.
n=${3:?slice number}
continuing=""
for flag in "${@:4}"; do
  case $flag in
    --continue) continuing=1 ;;
    *) echo "slice takes --continue, not $flag" >&2; exit 1 ;;
  esac
done
# The slice's fields (Stack, Reads, Tests) from its plan: this worktree's
# copy, else prd/<topic>'s. Missing fields get the defaults and a warning.
plan_text=$(cat "$here/$plans_dir/$topic-plan.md" 2>/dev/null || git -C "$main" show "$prd_prefix$topic:$plans_dir/$topic-plan.md" 2>/dev/null || true)
fields_cli=$(dirname "$0")/slice-fields.mjs
fields=$(node "$fields_cli" "$n" <<<"$plan_text" 2>/dev/null | sed 's/^/  - /')
warnings=$(node "$fields_cli" "$n" <<<"$plan_text" 2>&1 >/dev/null | sed 's/^warning: slice [0-9]*: //' | paste -sd ';' - | sed 's/;/; /g')
stack=$(node "$fields_cli" "$n" --get stack <<<"$plan_text" 2>/dev/null || echo no)
# The slice's section and what it needs from the plan and PRD; empty when the
# plan has no such slice, and then the agent reads the files.
prd_file=""
[[ -n $prd_read ]] && prd_file=$here/$plans_dir/$topic-prd.md
brief=$(node "$(dirname "$0")/slice-brief.mjs" "$n" "$topic" ${prd_file:+--prd "$prd_file"} <<<"$plan_text" 2>/dev/null || true)
if [[ -n $brief ]]; then
  if [[ -n $prd_read ]]; then
    from="$plans_dir/$topic-plan.md and $plans_dir/$topic-prd.md" whole="the whole plan or PRD"
  else
    from="$plans_dir/$topic-plan.md" whole="the whole plan"
  fi
  read_line="Your slice's section and what it needs from $from${no_prd:-} are at the end of this prompt: work from them, and open $whole only for a question they leave. Then read the docs its Reads field names."
else
  read_line="Then read ${prd_read}slice $n in $plans_dir/$topic-plan.md${no_prd:-}, then the docs its Reads field names."
fi
# Once the worktree exists, what it really has wins (new.sh decides).
if [[ -f $loops/$topic-$n/.env.loop ]]; then
  if grep -q '^SLOT=[0-9]' "$loops/$topic-$n/.env.loop"; then stack=yes; else stack=no; fi
fi
if [[ $stack == yes ]]; then
  # Where the stack puts the dev server's port, when the config says.
  port_env=$(config_get stack.portEnv 2>/dev/null || true)
  stack_line="- Your stack's slot and ports are in \`.env.loop\`${port_env:+ and \`$port_env\` (\`WEB_PORT\`)}. \`$prd_cmd serve\` runs your dev server in the background."
else
  stack_line="- Your worktree has no Docker stack. \`$prd_cmd check\` (through the check lease; never a bare \`$check_cmd\`) still runs everything it needs: integration tests use your own database on the shared test Postgres (created on first use). The dev server and browser checks need a stack: \`$prd_cmd stack up\` adds one and \`$prd_cmd stack down\` removes it when you're done (tell your orchestrator)."
fi
cat <<EOF
You are the agent for slice $n of the "$topic" PRD.

- Your worktree is $loops/$topic-$n, on branch $slice_prefix$topic/$n (from $prd_prefix$topic). \`cd\` there in every shell and work only there; Read, Edit and Write use absolute paths inside it.
- $agents_doc (the core) is already in your context (CLAUDE.md loads it); Read it only if it isn't. $read_line $agents_doc's _Area index_ finds any other rule you need.
- This slice's fields, from the plan:
$fields
EOF
if [[ -n $warnings ]]; then
  cat <<EOF
- The plan's fields for slice $n are incomplete ($warnings), so the defaults apply: no stack and nothing extra to read. If that looks wrong, ask your orchestrator.
EOF
fi
cat <<EOF
- Build only slice $n. Leave other slices' regions and files alone.
- Read your handbook, $(role_doc loop), and follow it exactly: its _Loop rules_, the rules across PRDs it points to, and the _Hand-off_ format for your final message.
$stack_line Delete any scratch scripts before you commit.
- Check with \`$prd_cmd check --quick "slice hand-off"\` (it takes a check lease and needs a clean tree, so commit first), never a bare \`$check_cmd\`. On your slice branch it is the slice check: typecheck, lint, format, every unit test, and only the integration and component test files you added or edited (never a full check; it adds the tooling tests when you change the tooling). Run no other component test or browser check: the orchestrator runs the rest and sends you what breaks. To wait on a check running in the background, run \`$prd_cmd wait check\` (it returns once this worktree's check is gone, and exits 75 at its \`--timeout\`); never \`pgrep -f\` (it matches its own shell and never exits).
- Commit subjects are Conventional Commits with the topic as scope: \`feat($topic): …\`, \`fix($topic): …\`, \`test($topic): …\`. The commit-msg hook refuses anything else.
- You may update your backlog items' notes (\`$backlog_cmd note ${backlog_id_prefix}<n> "..."\`). Don't claim, land or reassign items; your orchestrator does that.
- **Your hand-off releases your stack:** run \`$prd_cmd stack down\` before your final message (with no stack it does nothing), then wait: the orchestrator may send back a failure from the wave's CI run.
- **A message of just 'bye'**: first the checks $(role_doc loop) names under _Bye_, then run \`$prd_cmd bye\` (a slice only reports; it ends no session). Clean: send your hand-off. Otherwise send your orchestrator the open things it lists and wait for its word on each.
- **A fix request is these steps and nothing else:** \`$prd_cmd stack up\` if your slice uses a stack; \`git merge --no-ff -m "chore($topic): merge $prd_prefix$topic for a fix" $prd_prefix$topic\` (the one merge you make); a new commit with the fix; \`$prd_cmd check --quick "slice fix"\` on your own tests; \`$prd_cmd stack down\`; a new hand-off line. Your orchestrator merges it again.
EOF
if [[ -n $continuing ]]; then
  cat <<EOF

**You're continuing slice $n, not starting it.** An earlier agent worked in this worktree and was interrupted (a restart, a crash or a usage limit), and its hand-off was lost. Before writing any code:
- Read what it did: \`$log_cmd --oneline $prd_prefix$topic..HEAD\`, \`git status\`, \`git diff $prd_prefix$topic...HEAD\` (what's committed) and \`git diff\` (what isn't). Uncommitted changes are its work too: keep them unless they're broken.
- Check that against the slice's acceptance criteria and finish what's missing from there. Don't start over, and don't redo committed work.
- If everything is committed and \`$prd_cmd check\` (or \`--quick\`) passes, don't rebuild: run whatever the slice's checks still need, and write the hand-off from the branch (its commits are the record).
EOF
fi
if [[ -n $brief ]]; then
  printf '\nSlice %s, from %s:\n\n%s\n' "$n" "$from" "$brief"
fi
