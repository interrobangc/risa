# Plan: fixes-tooling

> Risa's standing fix topic for scripts, checks, tests and flakes. No PRD: this plan is the whole spec. One slice per backlog item, appended at each wave boundary; every slice reads [`plans/fixes-rules.md`](fixes-rules.md).

## Status

**Landing mode:** run everything through (started run-through; land each green wave without asking, ask only real questions).

| Slice | Wave | Item           | Model  | State                                                                                          | Merge into `prd/fixes-tooling` |
| ----- | ---- | -------------- | ------ | ---------------------------------------------------------------------------------------------- | ------------------------------ |
| 27    | 5    | RISA-1011      | sonnet | merged                                                                                         | 5bff9fa                        |
| 28    | 5    | RISA-882       | opus   | merged                                                                                         | a99f7d2                        |
| 29    | 5    | RISA-886, 889  | opus   | agent spawned                                                                                  | —                              |
| 30    | 5    | RISA-986       | opus   | handed off (tip 83d93fd): own tests pass; check never got a lease, CI gates                    | —                              |
| 31    | 5    | RISA-994 (1/2) | opus   | agent spawned                                                                                  | —                              |
| 32    | 5    | RISA-994 (2/2) | opus   | waiting (blocked by 31)                                                                        | —                              |
| 33    | 5    | RISA-1006      | opus   | handed off (tip c30f407): own test 6/6; check timed out under load, CI gates                   | —                              |
| 34    | 5    | RISA-1012      | opus   | handed off (022a664, 0cdb858): refuses before stopping; slice check red on load timeouts only  | —                              |
| 35    | 5    | RISA-1013      | opus   | handed off green (1823c19, tip 41abf2d)                                                        | —                              |
| 36    | 5    | RISA-1014      | opus   | handed off (tip e99f515): own test 32/32; docs_re not exempt_re (loops/ is code here)          | —                              |
| 37    | 5    | RISA-813       | opus   | handed off (tip eb54406): own test 31/31, reruns green; check out of time under load, CI gates | —                              |
| 38    | 5    | RISA-883       | opus   | handed off (tip 33c5842): own test 4/4; check out of time under load, CI gates                 | —                              |

**Wave 4 landed** 2026-11-27 in main as 730639e (PR #11), released as v0.1.8: slices 19–26 (RISA-881, 1005, 1003, 1004, 926, 981, 1009, 1010); 26 on sonnet, the rest opus. CI unit green on 9f74528 (run 46102353384). Codex: 2 P2s filed (RISA-1012, 1013), clean on 9f74528; landed on the user's word with `--no-review --by-user` without its re-review of the docs-only tip. The new risa.json keys (commands.testFile, staticCheck) broke v0.1.7 until v0.1.8 was installed: **a change to Risa's own risa.json needs the release that reads it installed first.** Report filed; slice worktrees removed.

**The user's decisions:** the drain never ends backlog or inbox sessions on usage (wave 3). Keep it so.

**Wave 5** started 2026-11-27 (session after the wave-4 hand-over): main synced (up to date), slices 27–38 written, hot files set, items claimed; 10 agents spawned, 28 and 32 wait on 27 and 31. Watch running. **Slip:** worktrees were cut before the plan commit (964bfdf), so slice checks ran the full suite (load 107); each agent told to merge prd/fixes-tooling first (filed as a bug).

**Carried over:** a change to Risa's own risa.json needs the release that reads it installed first. Slice checks run red on load timeouts (RISA-994, slices 31–32); the wave's CI run is the gate. machinery.md is at its budget. check-plan's "shares its Check file with slice 25" on 34 is a false wave (25 landed).

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

## Slice 27: The planner prompt and plan skeptic use the new slice budget

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/skeptics.test.mjs

**Build (RISA-1011):** `loops/skeptics.mjs`'s `SLICE_SIZE_RULE` and the planner prompt `loops/prompts/plan.sh` still say "about 8 files". Bring both to `loops/docs/planner.md`'s budget (slice 19: about 4 files changed, one test file named in the fields line's `Check:` field, no two slices in a wave sharing it), reading the doc's wording rather than inventing new. Update `loops/prompt.test.mjs`, `loops/skeptics.test.mjs` and `sample-project/prompt-golden.txt` to match. Nothing else changes.

**Acceptance criteria:**

- Unit test (`loops/skeptics.test.mjs`): the plan skeptic's brief states the 4-file, one-`Check:`-file budget and no longer says 8 files; the golden prompt matches.

## Slice 28: A slice's model is in its fields line

Stack: no · Reads: plans/fixes-rules.md, loops/docs/planner.md · Tests: unit · Blocked by: 27 · Check: loops/slice-fields.test.mjs

**Build (RISA-882):** every slice runs on Opus because nothing says which may not. Add an optional `Model: opus|sonnet` field to the fields line (default opus; sonnet only for a slice whose Build spells out each edit, the handbook's _Models_ rule): `loops/slice-fields.mjs` parses it (an unknown model is an error naming the two), `risa prompt slice` / `risa slice` print the model the orchestrator should spawn on in their output (one line; find where `risa slice` prints its worktree), and one sentence in `loops/docs/planner.md` and the template in `loops/prompts/plan.sh` (trim as much as you add). Haiku stays a helper's model, never a slice's. Plan skeptics stay on Opus.

**Acceptance criteria:**

- Unit test (`loops/slice-fields.test.mjs`): `Model: sonnet` parses, no field reads opus, `Model: haiku` is refused with the line naming opus and sonnet.

## Slice 29: The backlog session hands off without asking, and its brief is followed

Stack: no · Reads: plans/fixes-rules.md, loops/docs/backlog.md · Tests: unit · Blocked by: none · Check: loops/prompt.test.mjs

**Build (RISA-886, RISA-889):** on "hand off" the backlog prompt (`loops/prompts/backlog.sh`, the hand-off bullet) asks which mode; drop the question: the session writes a short brief when it has work in hand or the user gave instructions with the hand-off, and none otherwise, its call. When the user's hand-off message carries instructions, the brief records them as directives under their own heading. A fresh session started with `--brief` that has directives follows them as its first task instead of the opening poll (the `asks --short` line still comes first); a brief without directives keeps today's start. Say so in `loops/docs/backlog.md`'s hand-off sentence (trim as much as you add). Don't touch `loops/rotate.sh`.

**Acceptance criteria:**

- Unit test (`loops/prompt.test.mjs`): the guide's hand-off bullet asks nothing; a backlog prompt with a brief holding directives tells the session to carry them out before any poll; one with a plain brief keeps the poll.

## Slice 30: prd status and dispatch --dry-run print a hold's reason

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/ls.test.mjs

**Build (RISA-986):** slice 4 (RISA-477) records a hold's reason and date in the registry and prints them in `prd list`. Print them beside the hold in `prd status` (`loops/ls.sh`) and in `risa dispatch --dry-run`'s line for a held row (`loops/dispatch.mjs`, the dry-run printing only), reading them through `backlog/registry.mjs`'s reader (reuse, don't parse the table again). A hold with no reason prints as now.

**Acceptance criteria:**

- Unit test (a new `loops/ls.test.mjs`, on a fixture registry): a held row with a reason shows it and its date; one without shows the hold alone. Plus one case in `loops/dispatch.test.mjs` for the dry-run line.

## Slice 31: Inner test waits scale with load (land-unsynced, rotate)

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/land-unsynced.test.mjs

**Build (RISA-994, first half):** slice 17 scaled vitest's limits with load (`vitest.config.mjs`, `testLimits`), but waits inside tests and the scripts they drive have fixed clocks, so `loops/land-unsynced.test.mjs` (a 38.6 s run past its limit at load ~30) and `loops/rotate.test.mjs` ("timed out waiting") still fail under load. Give the tests one helper that scales a wait by the same load factor (export it beside `testLimits` or in `loops/test-env.mjs`; reuse the load read, don't copy it) and use it for those two files' waits, or pass a scaled timeout to the script they drive through its existing knob. Find each wait's cause first: a wait that is slow because it does needless work gets faster, not longer.

**Acceptance criteria:**

- Unit test: the helper's wait rises with a given load (through a knob) and is unchanged at low load; `land-unsynced` and `rotate` use it.

## Slice 32: Inner test waits scale with load (ask, sessions, bye)

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: 31 · Check: loops/ask.test.mjs

**Build (RISA-994, second half):** with slice 31's helper, scale the in-test and script waits that still fail under load: `loops/ask.test.mjs` (`RISA_ASK_NOTIFY_TIMEOUT` and its hang cases), `loops/sessions.test.mjs` ("prd-t isn't running") and `loops/bye.test.mjs` ('lists each open thing…', the hand-off line). Same rule: find each wait's cause first. If one isn't a wait at all (a race, leaked session state), fix that and say so in the hand-off.

**Acceptance criteria:**

- Unit test: the three files pass with the helper's knob set to a high load (no real load needed), and at low load their waits are as now.

## Slice 33: package.json's version keeps up with the release tags

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/tooling-lint.test.mjs

**Build (RISA-1006):** `package.json` says 0.1.2 though v0.1.8 is tagged. Releases are cut by hand (`git tag`), so add a check: `loops/tooling-lint.mjs` fails, in one line, when the newest `v*` tag reachable from HEAD is above `package.json`'s version (no tags, as in a shallow CI checkout: skip, saying so). Bump `package.json`'s version to the newest tag (0.1.8). Say in the release note of `loops/docs/machinery.md`, or wherever the release steps are written (find it; trim as much as you add), that a release bumps the version first, then tags.

**Acceptance criteria:**

- Unit test (`loops/tooling-lint.test.mjs`, a fixture repo): a tag above the version fails with the line, an equal or lower one passes, no tags skips.

## Slice 34: dispatch --restart stops nothing when it can't start one

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/dispatch-restart.test.mjs

**Build (RISA-1012):** `risa dispatch --restart` (`loops/dispatch.mjs`, the restart path) stops the dispatcher, then opens a tab through `loops/open-session.sh`, which with no iTerm2 (headless) prints the command and exits 0, so the restart waits out its timeout with dispatching stopped. Before stopping, check a tab can open (the same check `dispatch` itself makes, "dispatch needs iTerm2"); if it can't, start the new one as a detached process instead (keep-alive kept, as now), or refuse before stopping anything, saying why. Pick one and say why in the hand-off. Touch only the restart path.

**Acceptance criteria:**

- Unit test (`loops/dispatch-restart.test.mjs`): with no tab available, the running dispatcher is either still running (refused) or replaced by a detached one; never stopped with none started.

## Slice 35: risa status's last tick is a real heartbeat

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/status-extra.test.mjs

**Build (RISA-1013):** `risa status` shows the last tick from `stuck.lastTickAt` (`loops/status-extra.mjs`), which the stuck watch writes only when it runs (`loops/dispatch.mjs` near line 1002), so a usage-limited, paused or `RISA_STUCK_WATCH=off` dispatcher looks stalled. Record a top-level `lastTickAt` in the dispatcher's state on every tick, whatever it decides (the tick's entry, not the stuck watch), and have status read it (falling back to `stuck.lastTickAt` for state written by an older release). Leave the stuck watch's own field to it.

**Acceptance criteria:**

- Unit test (`loops/status-extra.test.mjs`, plus one in `loops/dispatch.test.mjs`): a paused tick still writes the heartbeat; status shows it, and reads an old state's `stuck.lastTickAt`.

## Slice 36: land takes Codex's approval behind docs-only commits

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/codex-review.test.mjs

**Build (RISA-1014):** `risa land` needs Codex's clean verdict on the PR's head, so a _Status_ commit after Codex approved forces `--no-review`. The CI gate already accepts a verdict on an earlier commit when everything after it is docs and tooling (`loops/land.sh`'s tier gate, `exempt_re`). Apply the same rule to the review gate (`loops/codex-review.mjs`, its verdict on the head, and `loops/land.sh` near line 767): clean on an earlier commit of the PR, with only Markdown or plan files changed after it, reads as clean, and land's report says which commit Codex approved. Reuse the gate's file rule; don't write a second one. Anything else after the approval still needs a review.

**Acceptance criteria:**

- Unit test (`loops/codex-review.test.mjs`): clean on an earlier commit with only a plan file after it reads clean naming that commit; with a code file after it, not clean.

## Slice 37: dispatch --allow <topic>: one topic past the drain line

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/drain.test.mjs

**Build (RISA-813):** between the drain line (95%) and the stop (98%) nothing starts or plans, and the only way past is `RISA_USAGE_WATCH=off`, which turns the whole watch off. Add `risa dispatch --allow <topic>` (and `--allow none` to clear): it writes a file the dispatcher reads each tick, the way `--cap` writes `.loops/.prd-cap` (reuse that pattern, no restart), and lets that topic start, plan or resume between the line and the stop. Everything still ends at the stop. Show the allowance in `--dry-run` and in the drain's log line. Keep `loops/dispatch.mjs`'s change to its CLI and the drain check (`loops/drain.mjs`).

**Acceptance criteria:**

- Unit test (`loops/drain.test.mjs`): at 96% the allowed topic starts and another doesn't; at 98% neither does; `--allow none` clears it.

## Slice 38: Token use priced by model and cache kind

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/token-price.test.mjs

**Build (RISA-883):** token counts hide cost (cache writes are ~3% of tokens but ~30% of cost). Add `loops/token-price.mjs`: given a session transcript folder (Claude Code's JSONL transcripts under a config folder's `projects/`, as `loops/usage.mjs` and `loops/host.mjs` find them; reuse) and a cutoff date, it prints price-weighted use before and after the cutoff, by model and by kind (input, output, cache write, cache read), with totals and the change. Prices in one table at the top of the file, per model, with the date they were read (from the claude-api skill's pricing reference). Run as `node loops/token-price.mjs --since <date> --cutoff <date> [--dir <projects folder>]`; no new `risa` command, no dependency. Don't touch `loops/cost*` (RISA-560's).

**Acceptance criteria:**

- Unit test (a new `loops/token-price.test.mjs`, fixture transcripts): the totals match the table's prices by kind, a cache write costs more than the same tokens read, and the before/after split falls at the cutoff.
