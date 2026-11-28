# Plan: fixes-bug-urgent

> Risa's standing fix topic for urgent bugs (wrong behaviour or data that can't wait for `fixes-bug`). No PRD: this plan is the whole spec. One slice per backlog item, appended at each wave boundary; every slice reads [`plans/fixes-rules.md`](fixes-rules.md).

## Status

**Landing mode:** run everything through (started run-through; land each green wave without asking, ask only real questions).

| Slice | Wave | Item      | Model | State                                      | Merge into `prd/fixes-bug-urgent` |
| ----- | ---- | --------- | ----- | ------------------------------------------ | --------------------------------- |
| 4     | 2    | RISA-1037 | opus  | waits for self-recovery-2's PR #23 in main | —                                 |
| 5     | 2    | RISA-1042 | opus  | starting                                   | —                                 |
| 6     | 2    | RISA-1038 | opus  | waits for self-recovery-2's PR #23 in main | —                                 |

**Wave 1 landed** 2026-11-28 in main as 232b823 through PR #25: slices 1 (RISA-1030, merge ff256da), 2 (RISA-1034, 61be90b), 3 (RISA-1033, 1f81567), all opus. Tooling only, tier none. Gate: full `risa check` on the synced tip; 25 tests in 16 files timed out at load ~27, and those 16 files reran green at load ~8 (533 tests). Codex: one P2 (browser wait misses a suite's earlier results), tracked as RISA-1042, thread resolved; clean on ca79cb4. Report filed; to-test/2026-11-28-0815-fixes-bug-urgent.md; slice worktrees removed.

**Wave 2 (session 2026-11-28):** slices 5 and 6 written. Slice 5 (`loops/lease.sh`, not hot) runs at once; slices 4 and 6 wait for **self-recovery-2's PR #23** (`loops/dispatch.mjs`, `loops/prd.sh`; self-recovery-2 will message when it lands): then `risa sync` and start them. Hot files set: `loops/lease`, `loops/session`, `loops/lib.sh`, `loops/status-extra`, `loops/dispatch-restart`.

- **Docs fold owed from wave 1** (deferred: hot files): `prd.sh`'s `wait` help and the orchestrator/loop docs should say `wait check|browser` prints the result and exits 1 with none recorded. The machinery doc should name the stuck watch's `notified` kind (`RISA_STUCK_NOTIFIED_MIN`, 10; it asks at once, since Risa can't wake an idle session).
- **`risa check` takes no label for a full run** (`--quick "<why>"` only).
- **Under load (~16–27)** slice and full checks time out in the tooling tests. Rerun just the failed files through the check lease once the load drops.
- RISA-1030's keep-alive (launchd or a watchdog) stays with self-recovery-3.
- **Commit no Status after asking Codex** before landing: it costs a re-review round.

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

## Slice 5: `risa wait browser` reads the whole suite's results

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/lease.test.mjs

**Build (RISA-1042):** `risa wait browser` (`lease_wait` and `lease_results` in `loops/lease.sh`) reads the run log only from the offset where the wait began. `loops/browser.sh` holds one lease for the whole suite and logs each check separately, so a waiter started, or restarted after exit 75, mid-suite misses the earlier checks: an early failing check followed by a passing one prints only the pass and exits 0. Take the results since the suite's lease was taken (the lease's own start, recorded where the lease is held), not since the wait began, falling back to the wait's start only when no lease start is known. Check waits (one line per run, at its end) keep working as now. Don't touch `loops/prd.sh`, `loops/docs/` or `loops/dispatch*` (a running topic's hot files).

**Acceptance criteria:**

- Unit test (`loops/lease.test.mjs`): a browser wait started after a suite's first (failing) check was logged, with a passing check logged after, prints both and exits non-zero; a check wait still prints its one result and exits 0.

## Slice 6: The inbox session finds its own project

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: self-recovery-2's PR #23 in main (then `risa sync`; `loops/prd.sh` is its hot file) · Check: loops/session.test.mjs

**Build (RISA-1038):** `prd.sh inbox` opens the inbox session in its own directory (`$RISA_INBOX_DIR`, default `~/.risa/inbox`, outside any repo). `loops/session.sh` sources `loops/lib.sh`, whose `find_repo` from that `$PWD` gets no machine entry, so the main checkout comes from `git -C $loops_lib_dir`: the release worktree, Risa's own checkout. `host.mjs claude-session` then reads Risa's machine entry, so the session misses the project's `claudeConfigDir` (it starts on Claude Code's default account) and its session record goes under Risa's `.loops/.sessions` (the project's `risa status` reads it ended while it's live, and the keep-alive may reopen a live inbox). Reproduce it first in a test (a throwaway project repo and machine config in the OS temp dir, a session run from a directory outside any repo). Fix: `prd.sh inbox` passes the project's main checkout through (`RISA_MAIN`), and `session.sh` (or `find_repo`) prefers it when `$PWD` is outside a repo. Keep the `prd.sh` edit to that one pass-through.

**Acceptance criteria:**

- Unit test (`loops/session.test.mjs`, new if none): a session started from a directory outside any repo with `RISA_MAIN` naming a project resolves that project's main, its `claudeConfigDir`, and writes its record under that project's `.loops/.sessions`; without `RISA_MAIN` inside a repo, it resolves as now.
