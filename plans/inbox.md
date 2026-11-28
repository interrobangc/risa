# Inbox

Add anything here: one line per item, under the heading that fits. Indent extra lines under it for details. Save; that's all.

Agents file each new line into the tracker ([backlog.md](backlog.md)) and add its id, like `(RISA-12)`. To change something already filed, add a new line saying so.

## Bugs/Nits

- The time gate judges the local measure on its start load only (the quiet rule) (RISA-1065)
  From Caretook (prd-test-time-gates-2, with Caretook's backlog agreeing; the Caretook user's answer a255): a local check's end load counts the check's own work, so it shouldn't make a run unjudged. loops/time-gate.mjs:77 sets quiet = calm(start) && calm(end), so every Caretook quick check comes out unjudged and its quick gate can't be armed. Wanted: the local measure is judged when the start load is quiet; the end load stays in the input and the lines but no longer decides unjudged; CI measures unchanged. time-gate.test.mjs: quiet start + busy end is judged (ok/warn/fail); busy start is unjudged; lines still name both loads. Notify backlog (caretook) when it ships in a tagged release.
- risa plan --help takes --help as a topic: it made worktree .loops/plan---help and branch plan/--help (RISA-1070)
  From Caretook's backlog at the Caretook user's request. risa plan --help created worktree .loops/plan---help on a new branch plan/--help, ran pnpm install and printed a start command (cleaned up with risa rm plan---help). Work out how to prevent it. Suggestions: --help/-h on every subcommand prints usage and exits 0; topic names must match the slug pattern (lowercase words and dashes, no leading dash) before any worktree or branch is made; unknown flags refuse. Caretook pins v0.2.0: notify backlog (caretook) when it ships in a tagged release.

## Change requests

- Split Risa's slow tooling tests (recover, then rotate, dispatch) along their describe groups with a fixture module (RISA-1066)
  As land.test.mjs/land-fixture.mjs were. Suggested by Caretook (prd-test-time-gates-2) as a sibling of the time-gate quiet-rule item; no longer Caretook's concern.

## Features

- A "replan" state on a PRD registry row: the dispatcher sends that topic back to its planner (before it runs or between waves) to replan the whole PRD (RISA-998)
