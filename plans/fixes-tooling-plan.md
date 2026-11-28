# Plan: fixes-tooling

> Risa's standing fix topic for scripts, checks, tests and flakes. No PRD: this plan is the whole spec. One slice per backlog item, appended at each wave boundary; every slice reads [`plans/fixes-rules.md`](fixes-rules.md).

## Status

**Landing mode:** run everything through (started run-through; land each green wave without asking, ask only real questions).

| Slice | Wave | Item      | Model  | State                                                                                                 | Merge into `prd/fixes-tooling` |
| ----- | ---- | --------- | ------ | ----------------------------------------------------------------------------------------------------- | ------------------------------ |
| 19    | 4    | RISA-881  | opus   | merged (slice check: 13 load timeouts in untouched files, RISA-994)                                   | 4b888b6                        |
| 20    | 4    | RISA-1005 | opus   | merged (adds commands.testFile and commands.staticCheck, the latter since Risa's typecheck is `true`) | 3626f71                        |
| 21    | 4    | RISA-1003 | opus   | merged                                                                                                | cf9c3a4                        |
| 22    | 4    | RISA-1004 | opus   | merged                                                                                                | 0de37c9                        |
| 23    | 4    | RISA-926  | opus   | merged                                                                                                | b65e587                        |
| 24    | 4    | RISA-981  | opus   | merged (slice check green on f0dc94b)                                                                 | 2d34ce6                        |
| 25    | 4    | RISA-1009 | opus   | merged (conflict with 24 resolved on its branch, bfeb925)                                             | 8c34b95                        |
| 26    | 4    | RISA-1010 | sonnet | merged                                                                                                | 04f2e0f                        |

**Wave 4** (2026-11-27): slices 19–23 written; RISA-881 split at planning (19: planner rule + plan lint; 20, RISA-1005: the slice check runs the slice's `Check:` file). RISA-915 dropped as fixed (dispatch-pick rule 8). Left for wave 5: 994 (touches rotate.test, slice 21's), 986 and 813 (dispatch, slice 22's), 882 (pairs with 881's docs), 883, 886, 889 (rotate). Hot files set. Agents spawned for 19, 21, 22, 23 (opus); their prompts note the fields reader doesn't know `Check` yet (slice 19 teaches it). Watch running. All of 19–26 merged; wave gate: `risa ci run unit` on a07cdd0 (run 46101459462): failed only doc-sections.test (slice 20's new project-config section sits after slice 26's pinned last heading); sent back to slice 20. 22–24 merged ahead of 20 (disjoint files; 981 is urgent). Slice 19 also moved `mergedSlices` into slice-fields.mjs and runs the budget in `risa anchors`; its follow-up (plan.sh and skeptics' 'about 8 files') is RISA-1011. Slices 24–26 joined on the backlog session's word (RISA-981 high priority; v0.1.8 is cut once 981 and 1010 land).

**Wave 3 landed** 2026-11-27 in main as a00a846 (PR #10): slices 14–18 (RISA-952, 997, 999, 1000, 927), all opus. CI unit green on a9b6f2a (run 46095529013, the first run with a real verdict: RISA-997 works). Codex went 4 rounds (3 P1s and 1 P2 fixed); landed on the user's word with `--no-review --by-user` (ask a17), its last two P2s tracked as RISA-1003 and RISA-1004. Report filed; slice worktrees removed; backlog session (risa-ee) told 952 landed (its release plan keys off it).

**For the next session (wave 4):**

- **The user's decision (wave 3):** the drain never ends backlog or inbox sessions on usage, on any account; it reports them at most. Keep it so.
- **RISA-881 first** (elephant-carpaccio slicing rules): the user wants it before risa-next is unheld; a release follows it (the backlog session handles the tag).
- **Ready:** RISA-1003 (rotate's simulated pick omits facts.landed), RISA-1004 (watch-off override doesn't release stall-marked sessions), RISA-994 (in-test and script timers don't scale with load: ask, bye, rotate, sessions, land-unsynced; notes list them), 813, 915 (dispatch-pick rule 8 may already cover it: check first), 926 (loops/machine is after-split-2's hot file; check `risa backlog prd list`), 986, 882, 883, 886, 889.
- **Gate:** slice checks run red on load timeouts at load 15–30 (RISA-994); the wave's CI run is the gate. bye.test's "lists each open thing…" failed under several full checks but passes alone and in CI.
- `risa pr` pushes local main to origin as it syncs; expected.
- Docs folded this wave: machinery (context watch, rotate's close), orchestrator rotate line.

## How to run this plan

- **Gate:** `risa check --quick "slice hand-off"` before each hand-off; `pnpm check` once on the merged tip at landing (plans/fixes-rules.md).
- **Hot files:** a fix touching a running topic's hot files (`risa backlog prd list`) waits for a later wave.

## Slice 1: tidy's preview and remover agree on lease `.waiting` files

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none

**Build (RISA-935):** `risa tidy` lists `.loops/.lease/<kind>/.waiting` files (pid gone) as safe, then `--yes` refuses them: "isn't a lease (<root>/<kind>/<N>)", exit 1 (`loops/tidy-cli.mjs`, `loops/tidy.mjs`). Make the two agree: either the remover takes a stale `.waiting` file (if nothing else waits on it), or the preview leaves it out. Choose by what `.waiting` is for in the lease code, and say why in the hand-off.

**Acceptance criteria:**

- Unit test (`loops/tidy.test.mjs` or `loops/tidy-cli.test.mjs`): a temp lease root with a stale `.waiting` file; the preview and `--yes` agree, and `--yes` exits 0.

## Slice 2: A tier data error prints one line, not a stack trace

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none

**Build (RISA-933):** `test:tooling` runs `loops/tooling-lint.mjs` before the project-data check, so broken tier data throws an uncaught `TierDataError`. Have the lint catch `TierDataError` and print its one line (exit non-zero), leaving `package.json` alone (another topic's hot file).

**Acceptance criteria:**

- Unit test (a new `loops/tooling-lint.test.mjs`): broken tier data in a fixture gives one line on stderr, no stack trace, a non-zero exit.

## Slice 3: The backlog lock re-checks a stale lock; tests for pr.sh and ready.sh

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none

**Build (RISA-367):** `with_backlog_lock` in `loops/lib.sh` removes a stale lock without re-checking it, so two waiters can both take it: take a stale lock over atomically (for example, rename it aside and re-check the holder, or `mkdir` after removal and treat a lost race as waiting again). Then give `loops/pr.sh` and `loops/ready.sh`, which have no tests, a test each on a throwaway git repo (no GitHub: stub `gh` on `PATH`). `land.sh` and `review.sh` already have tests; leave them. Over 12 files, stop and say so in the hand-off.

**Acceptance criteria:**

- Unit test: two waiters on a stale backlog lock; exactly one takes it.
- Unit tests (a new `loops/pr.test.mjs` and a new `loops/ready.test.mjs`): their main paths and a refusal each.

## Slice 4: A PRD hold carries its reason

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none

**Build (RISA-477):** `risa backlog prd set <topic> flags=hold` takes a reason (`why="<text>"`) and records it with the date; `prd list` and `prd status` print it beside the hold; clearing the hold clears it (`backlog/registry.mjs` and its CLI; `loops/prd.sh` help text only). The registry is a Markdown table: keep existing rows readable (a row with no reason still parses). Don't touch `loops/dispatch*` (another topic's hot files); its `--dry-run` printing the reason is a later fix.

**Acceptance criteria:**

- Unit test (`backlog/registry.test.mjs` or `registry.cli.test.mjs`): set a hold with a reason, list shows it with the date, clearing the hold clears it, an old row without one parses.

## Slice 5: `wait check` defaults under the harness's foreground limit

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none

**Build (RISA-911):** `risa wait check|browser`'s default `--timeout` outlasts the harness's ~170 s foreground limit, so a foreground wait gets moved to the background. Default it to 160 s (exit 75 at it, as now) and say so in the command's help line. Not `loops/docs/` (another topic's hot files): the orchestrator folds the note into the docs at landing.

**Acceptance criteria:**

- Unit test: with no `--timeout`, the wait gives up at the new default (shorten the clock through the test's own knob, not a real 160 s), exit 75.

## Slice 6: Plan sessions get the context watch

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none

**Build (RISA-880):** the context hook covers prd, backlog and inbox sessions only; add plan sessions (`risa plan <topic> --open` and the backlog planner), so a planner gets the soft and hard limit reminders (`loops/hooks.mjs`, `loops/context.mjs`, the plan prompt under `loops/prompts/`). Its reminder tells a planner what to do there (finish and land the plan, or hand over), not an orchestrator's rotate. Not `loops/docs/`: the orchestrator folds the doc line in at landing.

**Acceptance criteria:**

- Unit test (`loops/hooks.test.mjs` or `loops/context.test.mjs`): a plan session's settings carry the hook, and its reminder past each limit reads as a planner's.

## Slice 7: Zone filing matches a landed or dropped item

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none

**Build (RISA-721):** `ci file`'s zone filing (`ci/ci-file.mjs`, `ci/filing.mjs`) matches open items only, so when a zone's item was landed or dropped but the branch the run tested still lacks the fix, the next run opens a duplicate. Match landed or dropped items too: note the existing one (with the run) instead of filing new, unless its fix is already in the tested commit (then it is a new failure: file it, naming the old one).

**Acceptance criteria:**

- Unit test (beside `ci/ci-file.mjs`): a landed item whose fix is missing from the tested commit gets a note, not a new item; one whose fix is in it gets a new item.

## Slice 8: A GitHub Actions CI workflow runs the checks

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none

**Build (RISA-969):** add `.github/workflows/ci.yml`, the workflow `risa ci run` already expects (`ci/ci-io.mjs`: its name, the inputs `ci run` dispatches with, the ref it pushes): `pnpm check` on push to `main`, on PRs to `main` and on `ci run`'s dispatch. Pin Node and pnpm exactly (read `package.json`'s `packageManager`/engines; don't edit `package.json`, another topic's hot file) and pin each action to a full commit SHA with its version in a comment. The runner has no Claude session, so no `RISA_*` setup; if a test needs git identity, set it in the workflow. Update AGENTS.md's "There is no CI yet; the tests run locally." to say what runs where. No paid service beyond GitHub's own runners; a new dependency stops the slice (ask in the hand-off).

**Acceptance criteria:**

- Unit test (a new `ci/workflow.test.mjs`): the workflow's name and dispatch inputs match what `ci/ci-io.mjs` uses, its triggers cover push and PRs to `main`, and every `uses:` is pinned to a 40-character SHA.

## Slice 9: Promotion files a passing flake's tests

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none

**Build (RISA-681):** `risa ci promote` merges on a passing flake and only prints the flaky tests. File them in the backlog the way `ci file` files a zone's failures (`ci/filing.mjs`: one item per flaky test, a note on an open one that already covers it, the run linked), and print the ids it filed or noted (`ci/promote.mjs`).

**Acceptance criteria:**

- Unit test (`ci/promote.test.mjs`): a promotion with a flaky test files one item; a second promotion with the same flake notes that item instead of filing another.

## Slice 10: Archive done rows out of the PRD registry

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none

**Build (RISA-934):** `risa backlog prd archive` moves `done` rows out of the registry table into an archive file beside it, as `risa backlog archive` does for items (`backlog/registry.mjs` and its CLI). Lookups that read a topic's row (`prd show`, a name already taken) still find an archived one; `prd list` leaves them out. Don't touch `loops/dispatch*` or `loops/ls.sh` (another topic's hot files): if they read done rows, say so in the hand-off.

**Acceptance criteria:**

- Unit test (`backlog/registry.test.mjs` or `registry.cli.test.mjs`): archive moves only done rows, `prd list` no longer shows them, a lookup still finds one, and a second archive is a no-op.

## Slice 11: tooling-lint reads the repo's trunk

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none

**Build (RISA-987):** `loops/tooling-lint.mjs` defaults `TRUNK` to `dev`; a repo's trunk comes from its config (Risa's is `main`). Default it from the repo config the way the other commands read the trunk (find the helper; don't copy it), with `TRUNK` still overriding.

**Acceptance criteria:**

- Unit test (`loops/tooling-lint.test.mjs`): a fixture repo whose config names `main` lints against `main` with no `TRUNK` set; `TRUNK` still wins.

## Slice 12: backlog.mjs takes a stale lock over safely

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none

**Build (RISA-989):** `backlog/backlog.mjs`'s lock (near line 230) removes a stale lock with `rmSync` and no guard, so two waiters can both take it: the race RISA-367 fixed in `loops/lib.sh`'s `with_backlog_lock`. Take it over the same way (read that fix first), so the two locks agree on what stale means and who wins.

**Acceptance criteria:**

- Unit test (beside `backlog/backlog.mjs`): two waiters on a stale lock; exactly one takes it, the other waits and then takes it after release.

## Slice 13: config.test's "starts Node once" passes

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none

**Build (RISA-993):** `loops/config.test.mjs`'s "starts Node once" fails on main too, ENOENT on its temp `starts` file (seen under load 8–46). Find the cause (a missing directory, a race with the started process, a timing assumption) and fix the test or the code it found wrong; don't just raise a timeout. Leave `loops/test-setup.mjs` and `loops/test-env*` alone (another topic's hot files): if the cause is there, say so in the hand-off.

**Acceptance criteria:**

- Unit test: `loops/config.test.mjs` passes ten runs in a row (`--repeat` or a loop), with and without `RISA_*` variables set.

## Slice 14: An idle standing topic closes itself after a landing

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none

**Build (RISA-952, folding in RISA-982):** after a landing, a standing (fixes) topic whose waiting items are all blocked (its items held, or waiting on another topic; none the next wave could start) keeps its session and lane, so at cap 1 the dispatcher starts nothing else. Make the hand-over close it instead: `risa rotate` (`loops/rotate.sh`, `loops/rotate.mjs`) on a standing topic with no slice in flight and nothing runnable waiting runs the topic's `rm` (which already leaves a standing row not done) rather than opening a fresh session, and says why in one line. Decide "runnable" from the backlog and registry the way the dispatcher counts a fixes topic's waiting items (`loops/dispatch-pick.mjs`; reuse, don't copy). Don't edit `loops/rm.sh`, `loops/lib.sh` or `loops/docs/` (another topic's hot files); call rm as it is. The orchestrator folds the handbook line in at landing.

**Acceptance criteria:**

- Unit test (`loops/rotate.test.mjs` or beside `rotate.mjs`): a standing topic with only blocked waiting items closes (rm called, no new session); one with a runnable item rotates as now; a non-standing topic rotates as now.

## Slice 15: The CI workflow writes a verdict

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none

**Build (RISA-997):** `.github/workflows/ci.yml` runs `pnpm check` but uploads no verdict, so `risa ci run --wait` reads "unknown: the run left no verdict" and `risa land`'s CI gate needs `--force`. Have the workflow write and upload the verdict artifact `ci run --wait` reads (its name, file and shape from `ci/ci-io.mjs` and `ci/verdict.fixtures`), green or failing with the failing tests, also when `pnpm check` fails (`if: always()`). Pin any new action to a full SHA with its version in a comment. No paid service; a new dependency stops the slice.

**Acceptance criteria:**

- Unit test (`ci/workflow.test.mjs`): the workflow uploads an artifact under the name `ci-io.mjs` reads, on success and failure, and a verdict it would write parses with the reader `ci run --wait` uses.

## Slice 16: An After on an archived topic counts as done

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none

**Build (RISA-999):** `prd add/set after=<topic>` on a topic already archived (RISA-934) passes doctor, but the dispatcher reads only `prd list`, so the dependent topic waits forever. Make an archived After count as done: either the write drops it (saying so) or the registry's reader that dispatch uses treats an archived topic as done (`backlog/registry.mjs`; `loops/dispatch*` only if the reader can't carry it). Pick one, say why in the hand-off.

**Acceptance criteria:**

- Unit test (`backlog/registry.test.mjs` or `registry.cli.test.mjs`): a topic with `after=<archived>` reads as not waiting on it; doctor and the dispatcher's view agree.

## Slice 17: Test timeouts scale with load

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none

**Build (RISA-1000):** under a 5-minute load of 20–35 the tooling unit suite times out in 5–19 files (20 s test, 10 s hook limits) that pass alone. Scale vitest's `testTimeout` and `hookTimeout` with load the way `check-budget` scales its budget (find it; reuse its load read, don't copy it), or lower parallelism under load, in `vitest.config.mjs`. Don't edit `loops/test-env*` or `loops/test-setup.mjs`. Don't just raise the fixed limits.

**Acceptance criteria:**

- Unit test: the limits the config computes rise with a given load (through a knob, not the machine's real load) and stay at today's values at low load.

## Slice 18: The drain reads each session's own account

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none

**Build (RISA-927):** the drain (`loops/drain.mjs`) reads usage only from its own environment's Claude account, so a session on another `CLAUDE_CONFIG_DIR` is drained on the wrong account's numbers. Read usage per session's config folder, as usage and context already follow each session's folder (`loops/usage.mjs`, `loops/host.mjs`), and drain each session on its own account's numbers. Don't touch `loops/machine*` or `loops/lib.sh` (another topic's hot files).

**Acceptance criteria:**

- Unit test (`loops/drain.test.mjs`): two sessions on two config folders, one over the drain line and one under; only the one over drains.

## Slice 19: Plans slice small: a budget the plan check enforces

Stack: no · Reads: plans/fixes-rules.md, loops/docs/planner.md · Tests: unit · Blocked by: none · Check: loops/check-plan.test.mjs

**Build (RISA-881, first half; the slice check's half is RISA-1005):** give the planner an elephant-carpaccio slicing rule and have the plan check hold plans to it. In `loops/docs/planner.md`, beside the tracer-bullet rule: a slice's budget is about 4 files changed, one test file, and expected context under ~100k (a starting point, judged later with RISA-883); its fields line names that test file in a new `Check: <test file>` field (the narrow check the slice runs, RISA-1005); no two slices in one wave name the same test file; the slice's fixed cost (worktree, session, prompt, check, review, merge) must stay a small share of it, so don't split below a real change. Keep the doc within its budget (`pnpm docs:budget`): trim as much as you add. In `loops/check-plan.mjs`, warn (not fail) on a slice naming more than about 4 files in backticks under Build, a slice with no `Check:` field or with more than one test file in it, and two slices in the same wave sharing a `Check:` file (a slice's wave is the slices sharing an unmerged `Blocked by` chain or, failing that, the plan's _Status_ wave column; if that's unreadable, treat the slices after the last landed one as one wave, and say which you chose). Old plans without `Check:` keep passing, with the warning only. Update the plan template the planner prompt shows (`loops/prompts/plan.sh`) if it spells out the fields line. Teach the fields reader (`loops/slice-fields.mjs`) the `Check` field, so a plan naming it isn't read as incomplete (today `risa prompt slice` says "unknown field Check" and falls back to defaults). Don't touch `loops/docs/orchestrator.md` or the slice prompt (RISA-1005's).

**Acceptance criteria:**

- Unit test (`loops/check-plan.test.mjs`): a fixture plan with a 6-file slice, a slice with no `Check:`, and two slices in one wave sharing a `Check:` file gets one warning each and still exits 0; a plan within budget gets none.
- Unit test (`loops/slice-fields.test.mjs`): a fields line with `Check: <file>` parses complete, the file returned.

## Slice 20: The slice check runs only the slice's own check

Stack: no · Reads: plans/fixes-rules.md, loops/docs/project-config.md, loops/docs/orchestrator.md · Tests: unit · Blocked by: 19 · Check: loops/check-run.test.mjs

**Build (RISA-1005):** a project config key for a command that runs one test file (`commands.testFile`, the file appended; Risa's `pnpm exec vitest run`; the runner differs per project, so it's config, never hard-coded vitest), documented in `loops/docs/project-config.md` and set in `risa.json`. On a slice branch, `risa check --quick` reads the slice's `Check:` field from the plan (slice 19's) and runs typecheck, lint, format and that file through `commands.testFile` instead of every unit test (`loops/check-run.sh` or `loops/check-hook.sh`, wherever the slice mode picks its tests; reuse the plan reader `check-plan.mjs` or `prompt.sh` already has). No `Check:` field or no `commands.testFile`: the slice check runs as now. The full check stays at the wave's gate. Say so in the slice prompt's check line (`loops/prompts/slice.sh`), and in `loops/docs/orchestrator.md` that the orchestrator splits only a slice that comes back over budget (the planner owns the breakdown; trim as much as you add). Over 12 files, stop and say so.

**Acceptance criteria:**

- Unit test (`loops/check-run.test.mjs`): on a slice branch of a fixture repo whose plan names `Check: a.test.mjs`, the quick check runs only that file through the configured command; with no `Check:` or no key, it runs the unit tests as now.

## Slice 21: rotate's standing close sees landed topics

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/rotate.test.mjs

**Build (RISA-1003):** `standingClose`'s simulated pick in `loops/rotate.mjs` leaves out `facts.landed`, so a landed-but-planned row can count as runnable work (or not) differently from the dispatcher's own pick: the topic closes, then the dispatcher restarts it. Gather the landed-topic facts the way `loops/dispatch.mjs` does for `pick` (landed.mjs's `landedTopics`; reuse, don't copy) and pass them in, so `landedWhy` (rule 8 in `loops/dispatch-pick.mjs`) applies the same in both.

**Acceptance criteria:**

- Unit test (`loops/rotate.test.mjs`): a standing topic whose only waiting work is a landed-but-planned row decides as the dispatcher's pick would on the same facts.

## Slice 22: The watch-off override releases stall-marked sessions

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/dispatch.test.mjs

**Build (RISA-1004):** with `RISA_USAGE_WATCH=off`, a dead session with an outstanding stall mark is still held out of `pick()`'s reopen (the stalled-session lookup in `loops/dispatch.mjs`, `stalledSessions`), and its resume waits for its recorded reset. Apply `drainSettings`' watch-off override to that lookup too, so the watch off releases it.

**Acceptance criteria:**

- Unit test (`loops/dispatch.test.mjs`): a dead stall-marked session is held with the watch on and reopened with `RISA_USAGE_WATCH=off`.

## Slice 23: Keep-alive and session requests obey the work switch

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/keep-alive.test.mjs

**Build (RISA-926):** the machine config's work switch (`loops/machine.mjs`, `facts.work` in the dispatcher, rule 9 in `loops/dispatch-pick.mjs`) gates start, plan and queue only; `loops/keep-alive.mjs` and `loops/session-requests.mjs` don't read it, so a repo with work off still gets its backlog and inbox sessions opened. Have both read the same switch (reuse machine.mjs's reader) and open nothing for a repo whose work is off, saying why in the line they log. Leave `loops/machine*` itself alone unless the reader isn't exported.

**Acceptance criteria:**

- Unit test (`loops/keep-alive.test.mjs`, plus `loops/session-requests.test.mjs` for its half): with work off, neither opens a session and each says why; with work on, both act as now.

## Slice 24: A dispatcher re-execs onto the release risa points to

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/dispatch-release.test.mjs

**Build (RISA-981, high priority on the user's word):** a dispatcher started from a release install (`~/.risa/releases/<tag>/`) hashes its own frozen release folder at start and each tick (`codeHash`, `CODE_AT_START` in `loops/dispatch.mjs`), so it never sees a new install, while `risa status` (`loops/status-extra.mjs`) compares the current tool's checkout and says "it re-execs before its next tick", an hour on. Between ticks, resolve the code `risa` now points to (the same resolution `bin/risa` uses for the installed release link; reuse it, don't copy) and compare that folder's hash; changed, re-exec into that folder's `dispatch.mjs` (`process.execve`, as now), not its own path. A dispatcher run from a checkout keeps today's behaviour. Have `status-extra.mjs` compare the same target, and print `lastTickAt` beside `last:` (that line is the last logged change, not the last tick). Keep `loops/dispatch.mjs`'s change to the code-staleness path (slice 22 edits its stall lookup; slice 25 its CLI).

**Acceptance criteria:**

- Unit test (a new `loops/dispatch-release.test.mjs`): two fake release folders and a link moved from one to the other; the staleness check reads stale and names the new folder's `dispatch.mjs` as the re-exec target; a checkout-run dispatcher reads as now.
- Unit test (`loops/status-extra.test.mjs`): status names the same target and shows the last tick's time.

## Slice 25: risa dispatch --restart

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/dispatch-restart.test.mjs

**Build (RISA-1009):** a command a backlog agent can run to restart the dispatcher on the current release, so a new pin or install doesn't need the user at the terminal: `risa dispatch --restart` stops the running one (as `--stop` does: TERM, wait for its lock to free) and starts a new one through `risa` (so on the release it points to now), detached from the caller's shell (or in its own tab the way the dispatcher is started today; find how `risa recover` or `risa start` opens it and reuse that), keeping its `--every` and the keep-alive state a stop would otherwise clear (it isn't the user's stop). No dispatcher running: it starts one. Print one line: old pid, new pid, the code it runs. Add the flag to the usage line and the header comment (`loops/dispatch.mjs`'s CLI; leave its staleness code to slice 24 and its stall lookup to slice 22).

**Acceptance criteria:**

- Unit test (a new `loops/dispatch-restart.test.mjs`): with a fake running dispatcher (a stub process holding the lock), `--restart` ends it and starts one new one detached, keep-alive kept; with none running it starts one.

## Slice 26: machinery.md ends with its worktrees section again

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/doc-sections.test.mjs

**Build (RISA-1010, for the v0.1.8 release with RISA-981):** `loops/docs/machinery.md` ends with a stub `## The context watch` (2b02eab, wave 3's fold-in) after `## Worktrees and leases`, and a project's additions continue the generic doc's last section (`loops/doc.mjs`), so Caretook's worktree lines land under the stub. Move the stub's lines up to sit before `## Worktrees and leases` (or fold them into the section they belong to), leaving `Worktrees and leases` last; nothing else in the doc changes. Then pin each generic role doc's last heading so a fold-in can't move it again: a new `loops/doc-sections.test.mjs` listing, for each `loops/docs/*.md`, the heading it must end with (read today's after the fix), failing with a line that says a project's additions continue that section.

**Acceptance criteria:**

- Unit test (a new `loops/doc-sections.test.mjs`): each generic doc ends with its pinned heading; machinery.md's is `## Worktrees and leases`.
