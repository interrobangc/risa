#!/usr/bin/env bash
# Print the first prompt for a session, so starting one is a single command.
#
#   prompt.sh orchestrator <topic>     paste into a new session in .loops/<topic>:
#     cd .loops/<topic> && claude --remote-control prd-<topic> "$(scripts/loops/prompt.sh orchestrator <topic>)"
#     (pnpm prd start <topic> prints this)
#   prompt.sh orchestrator <topic> --auto   the same, landing every wave without asking (pnpm prd queue uses it)
#   prompt.sh plan <topic> [B-n …]     a planning session in .loops/plan-<topic> (pnpm prd plan <topic> --open)
#   prompt.sh slice <topic> <n>        the prompt an orchestrator gives a slice agent
#   prompt.sh backlog                  a backlog and inbox planning session in the main checkout (pnpm prd plan)
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

kind=${1:?kind: orchestrator, plan, slice or backlog}
if [[ $kind == backlog ]]; then
  cat <<EOF
You are the new backlog/inbox planning agent. Help me decide what is next.

- You're in the main checkout ($main), on dev. It's the user's: make no code changes here unless they ask for a small one (AGENTS.md, _Working rules_).
- Read AGENTS.md first, especially _PRDs and parallel loops_ and _The live backlog_. Then \`pnpm backlog ingest\` (files new inbox bullets), \`pnpm backlog list\` and \`pnpm prd status\` (what's running).
- Triage new items through \`pnpm backlog set B-<n> prd=<topic> status=triaged\` with a \`note\` saying why; the user reviews.
- Propose what to do next: which PRDs to write or start, given the PRD table's dependencies and hot files and the cap of three running at once. Ask with AskUserQuestion, never numbered question lists.
- To plan a topic, open its planning session (\`pnpm prd plan <topic> --open [B-n …]\` in a new terminal) or work in its worktree from \`pnpm prd plan <topic>\`, never on dev. To run a planned one: \`pnpm prd start <topic>\` or \`pnpm prd queue <topic>\`.
EOF
  exit 0
fi
topic=${2:?topic}
items=${*:3}

# A topic may have no PRD (quick-fixes): then its plan is the whole spec.
here=$(git rev-parse --show-toplevel 2>/dev/null || echo "$main")
if [[ -f $here/plans/$topic-prd.md ]]; then
  prd_read="plans/$topic-prd.md and "
else
  prd_read=""
  no_prd=" (there's no plans/$topic-prd.md: the plan is the whole spec)"
fi
case $kind in
  orchestrator)
    mode=${3:-}
    cat <<EOF
You are the PRD orchestrator for "$topic".

- Your integration worktree is $loops/$topic, on branch prd/$topic. Work only there; never in the main checkout ($main, which stays on dev and belongs to the user, the dev keeper).
- Read AGENTS.md first, especially _PRDs and parallel loops_, then the loop handbook docs/loops.md. Then read ${prd_read}plans/$topic-plan.md${no_prd:-} (its _Status_ section is where the last orchestrator left off, including the landing mode the user chose).
- At every wave boundary, starting now: \`pnpm backlog ingest\` (files the user's new inbox bullets), then \`pnpm backlog list\`. For new items (status inbox) that belong to "$topic", propose it: \`pnpm backlog set B-<n> prd=$topic status=triaged\` plus a \`note\` saying why; the user reviews. Claim each item before you work it (\`pnpm backlog claim B-<n>\`).
- Run a wave: \`pnpm prd slice $topic <n>\` for each slice in it, and spawn one background agent per slice with the prompt from \`pnpm prd prompt slice $topic <n>\`.
- Merge finished slices into prd/$topic in plan order (\`git merge --no-ff -m "feat($topic): <what it adds> (slice <n>, B-<n>)" slice/$topic/<n>\`), with no checks between merges (they run once, before landing; docs/loops.md, _Browser check budget_), mark their items \`pnpm backlog done\`, and tear down.
- When the wave is green: \`pnpm prd sync\`, \`pnpm prd check\`, \`pnpm prd serve --restart\`, then show the user the output of \`pnpm prd ready\` (the link to try it, and what it addresses) with the browser checks you ran and anything worth trying by hand. Land with \`pnpm prd land $topic -m "<subject>"\` (never \`--force\`) as the landing mode allows.
- When a slice is blocked by another PRD's work (another orchestrator's slice, or a backlog item landing in dev), don't stall: find that orchestrator with ListAgents and ask it with SendMessage to message you when the work lands in dev, and set a background check (a Bash loop with run_in_background that exits once \`git log dev\` or \`pnpm backlog list\` shows it), so you're woken whichever comes first. Then \`pnpm prd sync\` and carry on.
- At each landing, fold that wave's lasting decisions into the matching area doc (docs/domain/…, listed in AGENTS.md's _Area index_; add a doc and an index row for a new area), keeping AGENTS.md itself to rules and pointers. When the last wave has landed, run \`pnpm prd rm $topic\`.
- Every commit subject is a Conventional Commit (\`feat($topic): …\`, \`fix($topic): …\`, \`docs\`, \`test\`, \`chore\`…); the commit-msg hook refuses anything else.
- Keep the plan's _Status_ section current at every wave boundary (merged SHAs, what's ready, open issues, the landing mode), so a fresh orchestrator can take over.
EOF
    if [[ $mode == --auto ]]; then
      cat <<EOF

**Landing mode: run everything through.** The user queued you with \`pnpm prd queue $topic\` and asked for the whole plan to run without prompting. Start every ready slice (every slice it's blocked by is merged into prd/$topic), as many at once as the plan allows; land each green wave yourself; clean up. Ask the user only real questions: a product decision the PRD doesn't settle, a failure you can't fix, or anything that would touch another PRD's branch.

Start by summarising the plan's status and the backlog items for "$topic", record the landing mode in the plan's _Status_, then start the first ready wave.
EOF
    else
      cat <<EOF

**Landing mode: ask first.** Unless the plan's _Status_ already records one, start by summarising the plan's status and the backlog items for "$topic", then ask the user with AskUserQuestion:
1. How to run it: **ask before each landing** (you stop at every green wave and wait for their word), **run everything through** (you start every ready slice, land each green wave yourself and clean up, asking only real questions), or **land some automatically** (they pick the waves or slices that land without asking; you stop before the others).
2. Which slices to run now, or "every ready slice".
Record the answers in the plan's _Status_ and follow them. A wave you were told to land automatically is the user's go-ahead for that landing; any other landing waits for their word.
EOF
    fi
    ;;
  plan)
    cat <<EOF
You are the planning agent for "$topic".

- Your worktree is $loops/plan-$topic, on branch plan/$topic (from dev), with no Docker stack. Work only there; never in the main checkout ($main).
- Read AGENTS.md first, especially _PRDs and parallel loops_, _The live backlog_, _Slice fields_ and the _Area index_ (then the area docs the topic touches). Then \`pnpm backlog list\` and \`pnpm backlog show B-<n>\` for the items behind "$topic"${items:+ ($items)}.
- Write the PRD with the \`write-a-prd\` skill, saved as plans/$topic-prd.md: explore the code, then interview the user with AskUserQuestion (a few questions at a time, never numbered lists), and check the module sketch and test choices with them. Then cut it into slices with \`prd-to-plan\`, saved as plans/$topic-plan.md, in the shape of the existing plans: a _Status_ table, the durable decisions, _How to run this plan_, and each slice's user stories, **Blocked by** and **Blocks**, and acceptance criteria. Under each slice heading put its fields line (AGENTS.md, _Slice fields_): \`Stack: yes|no · Reads: <the docs/ files it needs, from the _Area index_> · Tests: <unit | integration | component | e2e:<check>>\`; say \`Stack: yes\` only when it needs a database, dev server or browser checks. Ask the user to approve the slice breakdown before writing it.
- Don't file GitHub issues.
- Commit both files on plan/$topic (Conventional Commits: \`docs($topic): …\`). Through \`pnpm backlog\`, set the items' \`prd=$topic status=triaged\` with a note, and add or update the topic's row in the PRD table (\`pnpm backlog commit\` after editing it in the main checkout).
- Land it yourself when it's done (a planning branch touches no code; AGENTS.md): check \`git diff --stat dev...plan/$topic\` lists only plans/ and docs/ files, \`pnpm prd sync\` if dev has moved, then \`pnpm prd land plan/$topic --force -m "docs($topic): PRD and plan for … (B-<n>, …)"\` and \`pnpm prd rm plan-$topic\`. Then tell the user how to start it (\`pnpm prd start $topic\` or \`pnpm prd queue $topic\`).

Start by summarising what the backlog says about "$topic", then begin the interview.
EOF
    ;;
  slice)
    n=${3:?slice number}
    # The slice's fields (Stack, Reads, Tests) from its plan: this worktree's
    # copy, else prd/<topic>'s. Missing fields get the defaults and a warning.
    plan_text=$(cat "$here/plans/$topic-plan.md" 2>/dev/null || git -C "$main" show "prd/$topic:plans/$topic-plan.md" 2>/dev/null || true)
    fields_cli=$(dirname "$0")/slice-fields.mjs
    fields=$(node "$fields_cli" "$n" <<<"$plan_text" 2>/dev/null | sed 's/^/  - /')
    warnings=$(node "$fields_cli" "$n" <<<"$plan_text" 2>&1 >/dev/null | sed 's/^warning: slice [0-9]*: //' | paste -sd ';' - | sed 's/;/; /g')
    stack=$(node "$fields_cli" "$n" --get stack <<<"$plan_text" 2>/dev/null || echo no)
    # Once the worktree exists, what it really has wins (new.sh decides).
    if [[ -f $loops/$topic-$n/.env.loop ]]; then
      if grep -q '^SLOT=[0-9]' "$loops/$topic-$n/.env.loop"; then stack=yes; else stack=no; fi
    fi
    if [[ $stack == yes ]]; then
      stack_line="- Your stack's slot and ports are in \`.env.loop\` and \`apps/web/.env\` (\`WEB_PORT\`). \`pnpm prd serve\` runs your dev server in the background."
    else
      stack_line="- Your worktree has no Docker stack. Instead of \`pnpm check\`, run \`pnpm typecheck && pnpm lint && pnpm format:check && pnpm exec vitest run --project data:unit --project scripts:unit --project web:unit\` (\`pnpm test:unit\` alone is only data:unit; integration tests, the dev server and browser checks need a stack: ask your orchestrator if you find you need one)."
    fi
    cat <<EOF
You are the agent for slice $n of the "$topic" PRD.

- Your worktree is $loops/$topic-$n, on branch slice/$topic/$n (from prd/$topic). \`cd\` there in every shell and work only there; Read, Edit and Write use absolute paths inside it.
- Read AGENTS.md first (the core), then ${prd_read}slice $n in plans/$topic-plan.md${no_prd:-}, then the docs its Reads field names. AGENTS.md's _Area index_ finds any other rule you need.
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
- Follow AGENTS.md's _Loop rules_ and _Rules across PRDs_ exactly, including the hand-off format for your final message.
$stack_line Delete any scratch scripts before you commit.
- Commit subjects are Conventional Commits with the topic as scope: \`feat($topic): …\`, \`fix($topic): …\`, \`test($topic): …\`. The commit-msg hook refuses anything else.
- You may update your backlog items' notes (\`pnpm backlog note B-<n> "..."\`). Don't claim, land or reassign items; your orchestrator does that.
EOF
    ;;
  *) echo "kind must be orchestrator, plan, slice or backlog" >&2; exit 1 ;;
esac
