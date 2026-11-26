# Orchestrator handbook

For a PRD orchestrator: a top-level session (spawned agents can't spawn), one per PRD, in the integration worktree `.loops/<topic>` on `prd/<topic>`, steered by the user. It reads the trunk, never works in the main checkout, and runs loops (`prd doc loop`). **At most four PRDs run at once** (`prd dispatch --cap`).

## Commands

`pnpm prd help` lists them; script headers give details. **At start,** fix what `pnpm prd anchors` flags.

## Models

**Coding goes to opus (Opus 5.5) or stronger, never below:** any slice or fix with real logic (a table or permission, sync, state, new UX, a refactor, a bug whose cause isn't known, a Codex fix). When unsure whether a slice is mechanical, it isn't: use opus. Brief helpers tightly; note slice models in _Status_. **haiku:** reading long check output (report failures, ■ lines, the table), searches and summaries (sonnet when it needs judgement), backlog chores and triage proposals. **sonnet:** only a slice with no logic to work out (a rename, moving files or checks, an edit the plan spells out line by line). **You:** reviewing hand-offs, conflicts, choosing the check, landing, talking with the user. Redo a thin or wrong result on a stronger model, unpatched.

## Recovery

`pnpm prd down` before a planned restart, `pnpm prd recover` after a restart, crash or usage limit: `prd doc recovery`.

- **Resuming as orchestrator:** its `--resume` prompt first runs `pnpm prd land --resume prd/<topic>`; **git wins** over _Status_.

## Starting and steering

- **Starting (the user):** `pnpm prd start <topic>`, then the command it prints in a new terminal.
- **The landing mode:** unless _Status_ records one, ask first: before each landing, run everything through (start every ready slice, land each green wave, ask only real questions), or land chosen waves or slices automatically. Record it in _Status_.
- **The dispatcher** (`prd doc machinery "The dispatcher"`), when the user runs it, plans and starts topics in the registry's row order as managed run-through sessions; `pnpm prd queue <topic>` moves a row first. Being started run-through is the go-ahead for every landing of that PRD.
- **Keep your context small:** work from _Status_, the backlog, hand-offs, `git diff --stat` and check output; send a problem back to its agent, never debug inside a loop.
- **One session per wave: drain, then rotate.** After a landing (not the last) and its docs, start no new slice; once the slices in flight are merged, commit _Status_ and `pnpm prd rotate` (at once with none in flight): a fresh session of that name opens from _Status_ and the old one ends. `--mid-wave` only on the user's word, or **past 225k** (the watch: `prd doc machinery "The context watch"`; at 160k, judge): rotate at the next safe point, unasked; a step that can't resume from _Status_ first runs `pnpm prd context --keep "<why>"` and says why there. After the last landing: `pnpm prd rm <topic>` in the worktree as the last step (it sets the registry's `done`, unless `standing`, and ends this session); if it refuses, run the line it prints.
- **Bye** (a message of just 'bye'): first _Status_ committed and current, no slice agent working, no CI run or review out; then `pnpm prd bye` (`prd doc machinery "Recorded sessions"`).
- **Update _Status_ at every step:** a slice started, handed off, merged (SHA), a wave landed; what's ready, issues, the landing mode. Commit it with merges and checks. After a landing, `pnpm prd status-trim` moves old hand-offs to `plans/<topic>-history.md` (_Status_ under 6 KB).
- **Capacity:** every check is `pnpm prd check`, in one of two leases (confirm it's held; no lookup chained before). Checks and slice starts wait out the load gate (`prd doc machinery "The load gate"`).
