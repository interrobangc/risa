# Machinery

What runs `{{prd}}` (`loops/`).

## The context watch

- prd, backlog, inbox and plan sessions; a planner lands or hands over.

## The dispatcher

- **`{{prd}} dispatch`**, in a tab of its own, ticks every 60 s: one action from the pick (start, plan or reopen a topic, in row order, under the cap, no hot-file collision), the keep-alive (backlog, inbox), session requests, the context and stuck follow-ups, the pickup, `tidy` every six hours. `--pause`/`--resume`, `--cap`, `--dry-run`.
- **The stuck watch** asks once per stall of a managed run-through orchestrator ("rotate it now" or "leave it"; never defaults): **quiet** (no heartbeat for 30 min, nothing running), a watch action unhandled, or **notified** (a notification came after its turn ended, no turn for 10 min: Risa can't wake it; a SendMessage may).
- **The stop mark:** `--stop` and `--restart` record the end (`stopped` in `.loops/.dispatch.json`: pid, time, why); every end logs a line in `.dispatch.log`. A gone pid with no mark crashed or was killed.

## The load gate

Busy: the 5-minute load over `RISA_LOAD_BUSY` (twice the cores; 30 for quick and slice checks and slice starts). Those wait while busy, up to `RISA_LOAD_WAIT` (600 s); `{{prd}} start` only warns, the dispatcher starts nothing, `{{prd}} status` shows it. An unread load isn't busy; `RISA_LOAD_GATE=off`.

## Recorded sessions

A session started through `session.sh` (prd, plan, backlog, inbox, hotfix, recovery) has `.loops/.sessions/<name>.json`: pid, kind, topic, dir, managed, ended. It outlives the session, goes with its worktree; live is its pid, started when recorded. `{{prd}} bye` finds the caller's role there (a `slice/` branch is a loop) and lists what's open (work not committed or pushed, worktrees, a stack, a held lease, jobs, questions; exit 3), or releases its leases and ends it; a loop only reports.

## Worktrees and leases

- **`{{prd}} tidy`** lists leftovers **safe** or **ask**; `--yes` removes the safe ones. Never dirty worktrees, the main checkout, unmerged branches, sessions.
- `rm.sh <name>` removes worktree, stack, test database, slot, merged branch; refuses uncommitted work or slice worktrees left, unless `--force`. Rotate runs it for a landed standing topic with nothing runnable.
- **`{{prd}} cost [<topic>]`**: tokens by model per slice, from transcripts and the ledger `rm` saves first (`.loops/.cost/`).
