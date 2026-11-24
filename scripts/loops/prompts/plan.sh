# shellcheck shell=bash
# prompts/plan.sh: prompt.sh plan <topic> [--auto] [B-n …], the planning
# session in .loops/plan-<topic>. Sourced by prompt.sh after shared.sh and
# topic.sh, with $topic set.
auto="" items=""
for a in "${@:3}"; do
  case $a in
    --auto) auto=1 ;;
    B-[0-9]*) items+="${items:+ }$a" ;;
    *) echo "plan takes --auto and B-<n> ids, not $a" >&2; exit 1 ;;
  esac
done
if [[ -n $auto ]]; then
  ask_line="- **Decide, then report: no interview, and nobody is watching this terminal** (the dispatcher opened you). Read docs/agents/preferences.md and explore the code. Ask only what the handbook's _What to ask_ names (scope, who can see or change what, existing data, compliance, a new dependency, product direction you can't pick with confidence: what the product does, never how it looks), and never in this terminal. $skeptic_rule Each question the skeptic leaves to the user is its own \`pnpm prd ask --topic $topic --question \"<text>\" --option \"<a>\" --option \"<b>\" --skeptic <id> --recommend <a> --defaults\` (or \`--waits\`, below), which prints its id; right after it, call the PushNotification tool yourself (a tool you call, not a command) with the line it printed, so the question reaches the user's phone. Then run \`pnpm prd ask --wait <id>\` in the background, with no \`--timeout\`, and keep exploring and writing what doesn't depend on the answer; you're woken when it prints. $default_rule **Never put your own recommendation in place of an answer:** wait until \`--wait\` prints one (the user's, or the default the tool took), and land nothing before it does. With nothing to ask, say so and carry on. Decide everything else yourself: the module sketch, the test choices and the slice breakdown need no approval. **Never ask about a UX or UI detail** (layout, where a control sits, icons or text, wording, colours, defaults, empty states): pick the smallest version that fits the item's words and the existing screens, and record it as assumed in the _Decisions_ table, where the user vetoes."
  report_line="then file the report with \`pnpm prd ask --topic $topic --report \"<text>\"\` (a report is never pushed: send no PushNotification for it; the only one you ever send is the line a question's \`pnpm prd ask\` prints): the text names the topic and what it plans, lists the _Decisions_ table's assumed rows (the costliest to change first) and what the skeptic changed, says how to veto (tell any planning or backlog session, or hold the topic before its first slice starts: \`pnpm backlog prd set $topic flags=hold\`), and stands alone. Then \`pnpm prd rm plan-$topic\`"
else
  ask_line="- **Decide, then report: no interview.** Read docs/agents/preferences.md and explore the code. Ask the user only what the handbook's _What to ask_ names (scope, who can see or change what, existing data, compliance, a new dependency, product direction you can't pick with confidence: what the product does, never how it looks), in one AskUserQuestion round of at most four questions, your recommendation first, and send no PushNotification for it or for the report; with nothing to ask, say so and carry on. Decide everything else yourself: the module sketch, the test choices and the slice breakdown need no approval. **Never ask about a UX or UI detail** (layout, where a control sits, icons or text, wording, colours, defaults, empty states): pick the smallest version that fits the item's words and the existing screens, and record it as assumed in the _Decisions_ table, where the user vetoes."
  report_line="\`pnpm prd rm plan-$topic\`, report the decisions you assumed (the costliest to change first) and how to start it"
fi
if [[ -n $auto ]]; then
  second_send_back="A second **send-back** holds the plan for the user: first flag the row \`hold\`, keeping its other flags (\`pnpm backlog prd add $topic\` if it has no row, then \`pnpm backlog prd set $topic flags=<its flags>,hold\`), so the dispatcher never starts a twice-rejected plan; then file it as a \`--waits\` question with \`--skeptic <that record's id>\`, push it and wait as above. Land nothing before the answer; rework as it says, land with \`hold\` still on, and say in the report that the topic is held and how to lift it."
else
  second_send_back="A second **send-back** is the user's: put it to them with AskUserQuestion (its reasons, your recommendation first), and land nothing before they answer."
fi
cat <<EOF
You are the planning agent for "$topic".

- Your worktree is $loops/plan-$topic, on branch plan/$topic (from dev), with no Docker stack. Work only there; never in the main checkout ($main).
- AGENTS.md is already in your context (CLAUDE.md loads it), so don't Read it again; follow it. Read your handbook, docs/agents/planner.md, and docs/agents/backlog.md, then the area docs the topic touches (_Area index_). Then \`pnpm backlog list\` and \`pnpm backlog show B-<n>\` for the items behind "$topic"${items:+ ($items)}.
$ask_line
- Write the PRD as plans/$topic-prd.md, opening with the handbook's _Decisions_ table and following _The PRD's shape_. Then cut it into tracer-bullet slices, saved as plans/$topic-plan.md, in the handbook's _The plan's shape_ (about six slices at most: cut a bigger one into follow-on topics), with each slice's fields line (_Slice fields_) and acceptance criteria that name the tests (_The test budget_).
- **Don't load the \`write-a-prd\`, \`prd-to-plan\` or \`grill-me\` skills:** they make you interview the user and wait for approval. The handbook has their templates.
- Run the handbook's _The skeptic pass_ before landing: write an evidence file outside the repo naming the PRD, the plan and the items; \`pnpm prd prompt skeptic plan --evidence <file>\` prints the brief for one fresh agent on Opus (\`model: "opus"\`); record its answer with \`pnpm prd skeptic record --kind plan --verdict go|send-back --why "<its one line>" --topic $topic\`, which prints the id. On **go**, act on what it found. On **send-back**, rework the plan and run a fresh skeptic **once more** (one retry). $second_send_back
- Don't file GitHub issues.
$(bye_line docs/agents/planner.md)
- Commit both files on plan/$topic (\`docs($topic): …\`), triage the items, and give the topic its row in the PRD table: when \`pnpm backlog prd list\` already has a row for $topic, set it with \`pnpm backlog prd set $topic after=<topic> hot=<path prefixes>\`; when it has none, add it first with \`pnpm backlog prd add $topic\` (never a hand edit of the table and no \`pnpm backlog commit\`: those commands commit). Then land it yourself as the handbook's _Landing a plan branch_ says: \`pnpm prd land plan/$topic -m "docs($topic): PRD and plan for … (B-<n>, …)"\` (plain: a plan branch never needs a forced landing), $report_line, and as your last step run \`cd $main && pnpm prd end\` (it ends this session and closes its tab; \`cd\` first, since \`rm\` deleted your worktree).

Start by summarising what the backlog says about "$topic", then explore.
EOF
