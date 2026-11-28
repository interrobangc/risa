# Orchestrator handbook

For a PRD orchestrator: a top-level session, one per PRD, in the integration worktree `.loops/<topic>` on `prd/<topic>`, steered by the user. It reads the trunk, never works in the main checkout, and runs loops (`{{prd}} doc loop`). **At most four PRDs run at once** (`{{prd}} dispatch --cap`).

## Commands

`{{prd}} help` lists them. **At start,** fix what `{{prd}} anchors` flags (exit 1: a bad `Model:`).

## Models

**Coding goes to opus (Opus 5.5) or stronger:** any slice or fix with real logic (a table or permission, sync, state, new UX, a refactor, an unexplained bug, a Codex fix). If unsure a slice is mechanical, it isn't: opus. Brief helpers tightly; note slice models in _Status_. **haiku:** long check output (failures), searches and summaries (sonnet for judgement), backlog chores and triage proposals. **sonnet:** only a slice with no logic to work out (a rename, moving files or checks, an edit the plan spells out line by line). **You:** reviewing hand-offs, conflicts, choosing the check, landing, the user. Redo a thin or wrong result on a stronger model.

## Recovery

`{{prd}} down` before a planned restart, `{{prd}} recover` after a restart, crash or usage limit: `{{prd}} doc recovery`.

- **Resuming as orchestrator:** its `--resume` prompt first runs `{{prd}} land --resume prd/<topic>`; **git wins** over _Status_.

## Rules across PRDs

PRDs run side by side and land alone, so each slice keeps out of the others' way:

- **Migrations take the next number** at landing, not when written: renumber on a clash with the trunk; never edit a landed one.
- **Seeds:** add rows; change one another topic's tests read only in a slice the plan names.
- **Registries** (a list every topic adds to: a manifest, an index, `CHANGELOG.md`): add your own entry in order; never rewrite the list.
- **Hot files get regions first:** a running topic's hot files (`{{backlog}} prd list`) are edited only in a region of your own; more waits for a later wave.

## The check gate

`{{prd}} tier` proposes a landing's CI tier and why; `{{prd}} ci run <tier> --wait` runs it, and `land` and `pr` wait for it. Tier none (docs and tooling only) needs just the tooling tests.

## Starting and steering

- **Starting (the user):** `{{prd}} start <topic>`, then the command it prints.
- **The landing mode:** unless _Status_ records one, ask first: before each landing, run everything through (start every ready slice, land each green wave, ask only real questions), or land chosen waves or slices automatically. Record it in _Status_.
- **The dispatcher** (`{{prd}} doc machinery "The dispatcher"`), plans and starts topics in the registry's row order as managed run-through sessions; `{{prd}} queue <topic>` moves a row first. Run-through start is the go-ahead for every landing of that PRD.
- **Keep your context small:** work from _Status_, the backlog, hand-offs, `git diff --stat` and check output; send a problem back to its agent, never debug inside a loop. Split only a slice that comes back over budget: the planner owns the breakdown.
- **One session per wave: drain, then rotate.** After a landing (not the last) and its docs, start no new slice; once the slices in flight are merged, commit _Status_ and `{{prd}} rotate` (at once with none in flight): a fresh session opens from _Status_ (a standing topic with nothing runnable closes); the old one ends. `--mid-wave` only on the user's word, or **past 225k** (the hard limit; the watch: `{{prd}} doc machinery "The context watch"`): rotate at the next safe point, unasked. Before that limit `rotate --mid-wave --reason context` is refused while a slice isn't handed off; a step that can't resume from _Status_ first runs `{{prd}} context --keep "<why>"` and says why there. **Past 120k** (the soft limit) rotate unasked between waves only: at the next wave boundary, _Status_ written as the brief, never `--mid-wave` for it. After the last landing: `{{prd}} rm <topic>` in the worktree as the last step (it sets the registry's `done`, unless `standing`, and ends this session); if it refuses, run the line it prints.
- **Bye** (just 'bye'): first _Status_ committed and current, no slice agent working, no CI run or review out; then `{{prd}} bye` (`{{prd}} doc machinery "Recorded sessions"`).
- **Update _Status_ at every step:** a slice started, handed off, merged (SHA), a wave landed; what's ready, issues, the landing mode. Commit it with merges and checks, and the plan before `{{prd}} slice` (it refuses an uncommitted slice). After a landing, `{{prd}} status-trim` moves old hand-offs to `plans/<topic>-history.md` (_Status_ under 6 KB).
- **Capacity:** every check is `{{prd}} check`, in one of two leases (confirm it). Checks and slice starts wait out the load gate (`{{prd}} doc machinery "The load gate"`).
