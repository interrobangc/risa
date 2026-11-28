# Plan: fixes-test

> Risa's standing fix topic for the tests and checks themselves: false greens, flakes, tests that leave things behind. No PRD: this plan is the whole spec. One slice per backlog item (a big one split), appended at each wave boundary; every slice reads [`plans/fixes-rules.md`](fixes-rules.md).

## Status

### From the user

(none yet)

**Landing mode:** run everything through (started run-through; land each green wave without asking, ask only real questions).

| Slice | Wave | Item      | Model | State   | Merge into `prd/fixes-test` |
| ----- | ---- | --------- | ----- | ------- | --------------------------- |
| 1     | 1    | RISA-1048 | opus  | merged  | ba9d9de                     |
| 2     | 1    | RISA-1075 | opus  | started |                             |
| 3     | 1    | RISA-1088 | opus  | merged  | da04cce                     |

**Wave 1** (slices 1–3, all unblocked), 2026-11-28: the plan's first wave, written by this orchestrator (no plan existed). None of the three touches a running topic's hot files (risa-next-4). Slices 1 and 3 both edit `loops/check-tooling.mjs` (1 only its last-lines main guard): merge 1 first. `risa anchors` warns slice 1 names 11 files: a one-line guard edit in nine of them, kept as is. Items claimed, hot files set. Slices 1–3 started (worktrees `.loops/fixes-test-<n>`, one opus agent each; brief from `risa prompt slice`). Slice 1 handed off (3c9162b: `loops/is-main.mjs`'s `isMain`, used by the nine entry points; the `pathToFileURL` guards fail through a symlink too, filed for a later wave) and merged (ba9d9de). Slice 3 handed off (b7e54eb: the limits scaled on the lagging 5-minute load; `testLoad` now takes the higher of the 1- and 5-minute loads, and the tooling rerun never gets lower limits than its run; `loops/check-tooling.test.mjs` is new and first runs in the wave's gate; the load gate still lets two full checks overlap, noted on the item) and merged (da04cce; the import conflict with slice 1 in `loops/check-tooling.mjs` resolved by keeping both lines). When RISA-1048 ships, tell Caretook's backlog session which version or commit has it (the item's note).

## How to run this plan

- **Gate:** `risa check --quick "slice hand-off"` before each hand-off; the wave's CI run on the merged tip at landing (plans/fixes-rules.md).
- **Hot files:** a fix touching a running topic's hot files (`risa backlog prd list`) waits for a later wave.
- **Commit the plan before `risa slice`:** a slice branch takes the committed plan.

## Slice 1: An entry point run through a symlink still runs

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/is-main.test.mjs

**Build (RISA-1048):** `pnpm test:tooling` from a project's `node_modules` runs no tests and exits 0: the main guard of `loops/tooling-tests.mjs` compares `import.meta.url` with "file://" plus `process.argv[1]`, and under pnpm that argument is the symlink while `import.meta.url` is the real `.pnpm` path. Add a shared helper in a new `loops/is-main.mjs` (say `isMain(import.meta.url)`: true when the realpaths of the script argument and of the module's file are equal; false when the argument is missing or doesn't exist, as the `isMain` inside `loops/session-names.mjs` does) and use it in the nine entry points with that "file://" guard: `loops/tooling-tests.mjs`, `loops/check-budget.mjs`, `loops/check-plan.mjs`, `loops/check-tooling.mjs` (touch only its guard: slice 3 edits the rest), `loops/check-times.mjs`, `loops/dev-brought.mjs`, `loops/metrics.mjs`, `loops/run-log.mjs` and `loops/token-price.mjs`. Leave the modules that already compare realpaths (several are hot for risa-next-4) and those guarded with `pathToFileURL`; say in the hand-off whether the `pathToFileURL` ones also fail through a symlink, so it can be filed.

**Acceptance criteria:**

- Unit tests (`loops/is-main.test.mjs` (new)): `isMain` is true for the real path and for a symlink to the module, false for another script and for no `argv[1]`; one of the nine entry points, run with `node` through a symlink in a temp dir, does its work (prints its usage or output) and no longer exits 0 silently.
- No guard built from "file://" and the script argument left in `loops/` (`grep`).

## Slice 2: The dispatch-restart test stops every dispatcher it starts

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/dispatch-restart.test.mjs

**Build (RISA-1075):** two `dispatch.mjs --every 1` processes from a `dispatch-restart-*` temp repo were found orphaned (ppid 1) hours after the test, their repo gone. `loops/dispatch-restart.test.mjs`'s `afterEach` sends SIGTERM to the pids in `started` and the lock holder, waits 10 s and gives up silently; a dispatcher started detached by `--restart` (or by a test that failed or timed out before recording its pid) that doesn't hold the lock at that moment is never signalled, and one that ignores SIGTERM survives. Find how a dispatcher escapes (start with the detached `--restart` path and a start that throws "the dispatcher never started" before the pid is tracked), then make the cleanup certain: track every pid as soon as it exists, end survivors with SIGKILL after the wait, and in `afterAll`, before the temp root is removed, end any process still running from that root (by the recorded pids and the state and lock files, never a `pkill` by name: other dispatchers run on the machine). Change `loops/dispatch.mjs` only if the escape is a real fault there (a dispatcher whose repo is gone should exit); say so in the hand-off.

**Acceptance criteria:**

- Unit test (`loops/dispatch-restart.test.mjs`): after the file's tests, no process started from its temp root is alive, including after a test that fails mid-way (a dispatcher started and not stopped by the test body is ended by the cleanup).
- The file passes three runs in a row, and `ps` shows no `dispatch-restart-` process after each.

## Slice 3: A full check's tooling rerun holds up under high load

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/test-limits.test.mjs

**Build (RISA-1088):** with two full `risa check`s overlapping (1-minute load near 50 on 16 cores, both check leases held), the tooling step's tests failed 25 then 31 across 15 and 21 files, a different set each run, nearly all 20 s test or hook timeouts in `land*`, `recover*`, `rotate*`, stack and load-gate tests, while the same files passed whole in `pnpm check`'s own pass. `vitest.config.mjs` takes its timeouts from `loops/test-limits.mjs` (`testLimits({ load: testLoad() })`), read once when the config loads; the tooling step is `loops/check-tooling.mjs` (`toolingStep`: one run, then failed files rerun alone). Find why the tooling run still times out at 20 s under that load (the load read too early or capped too low, files that set their own fixed timeouts, the rerun started at the same load with the same limits), and fix the cause. Directions the item names: scale the limits further with load, have the step wait out the load gate (`loops/load-gate.mjs`) before its run and its rerun, or stop running the same files twice in one check. Prefer the smallest change that makes a loaded run pass without making an idle run slower. Leave `loops/check-tooling.mjs`'s last-lines main guard alone (slice 1 changes it).

**Acceptance criteria:**

- Unit tests (`loops/test-limits.test.mjs`, and `loops/check-tooling.test.mjs` (new) if the step changes): at the reported load (50 on 16 cores) the limits the tooling run and its rerun get are well above 20 s, and at an idle load they are unchanged; any wait added is bounded and tested with an injected load reading, never the machine's real load.
- The hand-off says what the cause was and what still could time out.
