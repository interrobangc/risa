# Loop handbook

For a slice agent (a loop): one background agent working one slice of a PRD in `.loops/<topic>-<n>`, on `slice/<topic>/<n>`, run by the PRD's orchestrator. The rules across PRDs (migrations, seeds, registries, hot files; `prd doc orchestrator "Rules across PRDs"`) bind you too.

## Hand-off

Your final message:

- what was built, grouped by area, with every shared-file edit called out;
- each acceptance criterion, met or not, with evidence;
- the `pnpm prd check` output, and the ■ lines of any browser check you ran;
- anything skipped or surprising that later slices need;
- the commit SHAs.

## Reads and turns

Each turn costs its whole context:

- **Batch** independent reads, greps, commands and edits in one turn.
- **Read a file whole** when under about 400 lines; a longer one: grep, then read that range.
- **Search once** with one pattern for every name.

## Loop rules

- Your prompt ends with your slice's section, wave intro and cited PRD parts; open the plan for gaps. Read docs its `Reads` names (`prd doc planner "Slice fields"`).
- **Long exploration goes to a helper.** Past about 10 reads in unfamiliar code, give the rest to one Explore helper (`model: "haiku"` for a plain search, `"sonnet"` for judgement); take back only its conclusion. Long check output: a haiku helper, with the log's path.
- **Past 175k context** a hook asks you to judge (the watch: `prd doc machinery "The context watch"`): continue or hand off; say which in the hand-off. **Past 300k** hand off now: commit, start no check, name an unfinished fix.
- **Format** changed files before each check (your prompt's command); commit.
- **Background** `pnpm prd check` and anything past 2 min (`run_in_background`); wait with `pnpm prd wait check` (again on 75). Never end your turn before the hand-off.
- **Hand off** after `pnpm prd stack down`, then wait: the orchestrator may send back a CI failure.
- **Bye** (just 'bye'): hand-off ready, stack down, then `pnpm prd bye` (it only reports); send your orchestrator what it lists.
- **A fix request is only** your prompt's steps: one `--no-ff` merge of `prd/<topic>`, a new commit, `pnpm prd check --quick "slice fix"`, `stack down`, a new hand-off line.
