# Plan: fixes-bug-urgent

> Risa's standing fix topic for urgent bugs (wrong behaviour or data that can't wait for `fixes-bug`). No PRD: this plan is the whole spec. One slice per backlog item, appended at each wave boundary; every slice reads [`plans/fixes-rules.md`](fixes-rules.md).

## Status

**Landing mode:** run everything through (started run-through; land each green wave without asking, ask only real questions).

| Slice | Wave | Item      | Model | State                                      | Merge into `prd/fixes-bug-urgent` |
| ----- | ---- | --------- | ----- | ------------------------------------------ | --------------------------------- |
| 1     | 1    | RISA-1030 | opus  | merged                                     | ff256da                           |
| 2     | 1    | RISA-1034 | opus  | merged                                     | 61be90b                           |
| 3     | 1    | RISA-1033 | opus  | merged                                     | 1f81567                           |
| 4     | 2    | RISA-1037 | opus  | waits for self-recovery-2's PR #23 in main | —                                 |

Wave 1 gate: synced with main (58fcc52); tier none (tooling only), so the gate is a full `risa check "wave 1 gate"` on the synced tip, running. Wave 1 merged 2026-11-28 (slice 1's check ran out of budget under load ~16 in the tooling step, its own tests green: the CI run is the gate). Wave 1 started 2026-11-28: slices 1 and 2 (worktrees made, opus agents spawned). Hot files set to the paths they touch. RISA-1037 split from RISA-1030 (the dispatcher-side exit logging). Slice 3 started too, once self-recovery-2 freed `dispatch-stuck.mjs`. fixes-bug landed in main (3598122): `risa sync` at the wave boundary. Slice 2 handed off (check passed; merges after slice 1, in plan order); at landing fold into `prd.sh`'s `wait` help and the docs that `wait` now prints the result and exits 1 with none recorded. Slice 3 handed off (check passed): it built the question-at-once branch (Risa has no way to wake an idle session) and added a `transcript` field to the heartbeat (`loops/heartbeat.mjs`, now in hot files).

**For the next session:**

- **RISA-1038** (the inbox session finds the wrong project; filed by risa-ca for the next wave): it touches `loops/prd.sh` (self-recovery-2's hot file), `loops/session.sh` and `loops/lib.sh`, so it goes in wave 2 beside slice 4.
- **Docs fold deferred:** the `wait` help in `loops/prd.sh` and `loops/docs/` are self-recovery-2's hot files, so the note on `wait`'s new output and exit 1 (slice 2) and the `notified` stall (slice 3) waits for wave 2, after self-recovery-2 lands.
- **Context:** this session passed the soft limit (120k) during wave 1; rotate after wave 1 lands.
- **self-recovery-2** (2026-11-28) said it won't edit `loops/dispatch.mjs` again (barring a Codex fix) and never touches `loops/dispatch-stuck.mjs`, so slice 3 (RISA-1033) started at once. Its last slice changes `dispatch.mjs` and is in review as PR #23. Slice 4 (RISA-1037) starts once PR #23 is in main and `risa sync` has brought it in; self-recovery-2 will message when it lands, and a background check watches its registry row.
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

## Slice 3: The stuck watch counts a session sitting on an unanswered notification

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/dispatch-stuck.test.mjs

**Build (RISA-1033):** Caretook's prd-fixes-bug got its CI task notification at 09:18Z and never took another turn. It sat 3h40m with its processes alive, and it took a turn at once when a SendMessage nudged it. The stuck watch (`stallOf` in `loops/dispatch-stuck.mjs`) didn't count it as stalled. First find out why, from the heartbeat and session facts the tick gathers: perhaps a background task that had already finished still read as running, or the watch couldn't see that notification at all. Then make the watch flag a session whose newest event is a delivered notification (a task notification, or a cross-session message) with no turn after it for 10 minutes (`RISA_STUCK_NOTIFIED_MIN`). That is a new stall kind, `notified`. Where the tick gathers facts (`loops/dispatch.mjs`), add only what the new kind needs: the time of the newest such notification, read from the session's transcript or heartbeat. Keep that edit small and local: self-recovery-2's PR #23 changes the same file elsewhere. A `notified` stall should nudge before it asks anything. If Risa already has a way to send a session a nudge (a session request, a cross-session message), the tick sends one, once per stall, and records it. Only if the session is still quiet after the usual limit does the existing question follow. If there is no such way, it raises the existing question at once, worded for this case. Say in the hand-off which of the two you built. Several sessions stalled together still make one report and no question.

**Acceptance criteria:**

- Unit test (a new `loops/dispatch-stuck.test.mjs`): a session whose newest event is a notification 11 minutes old with no turn since is `notified`; one that took a turn after the notification isn't; the nudge (or the question) happens once per stall; two sessions notified together give one report.

## Slice 4: The dispatcher logs why it exits

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: self-recovery-2's PR #23 in main (then `risa sync`) · Check: loops/dispatch-restart.test.mjs

**Build (RISA-1037):** Caretook's dispatcher was gone hours after a normal tick, with no error in its log and its state still naming the dead pid. Every way `loops/dispatch.mjs` can exit (a signal it can catch, an uncaught exception or rejection, a lost lock, a clean stop, `--restart`'s re-exec) writes one line to the dispatch log saying why, with the error's first line, and marks the state stopped (`stoppedAt`, `why`). A clean stop removes the lock as now. Afterwards a gone pid with no stop mark means a crash or a SIGKILL. Then teach the status flag from slice 1 (`loops/status-extra.mjs`) to read the stop mark: a mark means `stopped (<why>, <age> ago)`, no mark means `dead`.

**Acceptance criteria:**

- Unit test (`loops/dispatch-restart.test.mjs`): a dispatcher child sent SIGTERM, and one that throws, each leave a log line and a stop mark; status reads `stopped (…)` with a mark and `dead` without one.
