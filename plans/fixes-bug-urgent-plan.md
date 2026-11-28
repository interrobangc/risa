# Plan: fixes-bug-urgent

> Risa's standing fix topic for urgent bugs (wrong behaviour or data that can't wait for `fixes-bug`). No PRD: this plan is the whole spec. One slice per backlog item, appended at each wave boundary; every slice reads [`plans/fixes-rules.md`](fixes-rules.md).

## Status

**Landing mode:** run everything through (started run-through; land each green wave without asking, ask only real questions).

| Slice | Wave | Item      | Model | State   | Merge into `prd/fixes-bug-urgent` |
| ----- | ---- | --------- | ----- | ------- | --------------------------------- |
| 1     | 1    | RISA-1030 | opus  | running | —                                 |
| 2     | 1    | RISA-1034 | opus  | running | —                                 |

Wave 1 started 2026-11-28: slices 1 and 2 (worktrees made, opus agents spawned). Hot files set to the paths they touch. RISA-1037 split from RISA-1030 (the dispatcher-side exit logging).

**For the next session:**

- **Waiting on self-recovery-2's hot files** (`loops/dispatch`): RISA-1033 (the quiet watch is `loops/dispatch-stuck.mjs`) and RISA-1037 (the dispatcher's exit logging in `loops/dispatch.mjs`, split from RISA-1030). Write their slices once self-recovery-2 lands or frees `loops/dispatch`.
- RISA-1030's keep-alive (launchd or a watchdog) stays with self-recovery-3, per its note.

## How to run this plan

- **Gate:** `risa check --quick "slice hand-off"` before each hand-off; `pnpm check` once on the merged tip at landing (plans/fixes-rules.md).
- **Hot files:** a fix touching a running topic's hot files (`risa backlog prd list`) waits for a later wave.

## Slice 1: `risa status` flags a dispatcher that died

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/status-extra.test.mjs

**Build (RISA-1030, the status part):** `dispatcherPart` in `loops/status-extra.mjs` prints `stopped: start it …` whenever the lock's pid isn't alive, so a dispatcher that died (its lock file still naming a gone pid, its state still ticking until then) reads the same as one stopped on purpose. Caretook's died after a normal tick and no one saw it for hours. When the lock file names a pid that is gone, print it as dead instead: `DISPATCHER: dead (pid <n> gone; last tick <age> ago, no clean stop): restart it with risa dispatch --restart`, keeping the log line and last tick as now. A missing lock file stays `stopped`. Read the lock's raw pid in `status-extra.mjs` (don't change `lockHolder` or anything in `loops/dispatch*`: another running topic's hot files). If the dispatcher already removes its lock on a clean stop, say so in the hand-off; if it doesn't, say that too (RISA-1037 adds a stop mark later) and flag dead only when the last tick is older than two tick intervals or the state has no stop record.

**Acceptance criteria:**

- Unit test (`loops/status-extra.test.mjs`): a lock file naming a dead pid with a recent-then-stale tick prints `dead (pid …`; no lock file prints `stopped`; a live pid prints `running` as now.

## Slice 2: An orchestrator never ends its turn on a check nothing will wake it from

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/lease.test.mjs

**Build (RISA-1034):** Caretook's prd-sync-safety-3 ended its turn waiting on a browser check whose background wait had already ended, so nothing woke it for hours. Two guards:

1. **The prompt** (`loops/prompts/orchestrator.sh`; regenerate the sample project's prompt golden file to match): beside the `wait check` line, say that before ending a turn on a check (or browser check) there must be a background wait still running for it (`risa wait check|browser` in the background, restarted each time it exits 75), and that a wait that returned means read the check's result now, not later.
2. **The wrapper:** `risa wait check|browser` (the `wait` path in `loops/lease.sh`, or its node helper) prints the check's last result when it returns because the check is gone (the outcome and log line the check wrapper records, or the browser check's), so the waking turn has something to act on; if no result was recorded since the wait began, it says so in one line (`the check ended with no result recorded: rerun it`) and exits non-zero (not 75).

Don't touch the `prd` dispatcher script, the role docs or the dispatcher's modules (a running topic's hot files): the orchestrator folds a docs note in at landing. Over 12 files, stop and say so.

**Acceptance criteria:**

- Unit test (`loops/lease.test.mjs`): a wait on a worktree whose check finished prints its result and exits 0; one whose check vanished with no result prints the one line and exits non-zero.
- The prompt golden test passes with the new prompt line.
