# Loop handbook

For a slice agent (a loop): one background agent working one slice of a PRD in `.loops/<topic>-<n>`, on `slice/<topic>/<n>`, run by the PRD's orchestrator. The rules across PRDs (migrations, seeds, registries, hot files; `prd doc orchestrator "Rules across PRDs"`) bind you too.

## Hand-off

Your final message:

- what was built, grouped by area, with every shared-file edit called out;
- each acceptance criterion, met or not, with evidence;
- the `pnpm prd check` output, and the ■ lines of any browser check you ran;
- anything skipped or surprising that later slices need;
- the commit SHAs.

## Loop rules

- Your prompt ends with your slice's section, wave intro and cited PRD parts; open the plan for gaps. Read docs its `Reads` names (`prd doc planner "Slice fields"`).
- **Past 175k context** a hook asks you to judge (the watch: `prd doc machinery "The context watch"`): continue or hand off, and say which in the hand-off. **Past 300k** hand off now: commit, start no check, name any unfinished fix.
- **Your hand-off releases your stack** (`pnpm prd stack down`); then wait: the orchestrator may send back a failure from the wave's CI run.
- **Bye** (a message of just 'bye'): your hand-off ready, your stack down, then `pnpm prd bye` (it only reports); send your orchestrator what it lists.
- **A fix request is only:** `pnpm prd stack up` if the slice uses one; `git merge --no-ff -m "chore(<topic>): merge prd/<topic> for a fix" prd/<topic>`; a new commit; `pnpm prd check --quick "slice fix"`; `stack down`; a new hand-off line.
