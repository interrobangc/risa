# Plan: fixes-tooling

> Risa's standing fix topic for scripts, checks, tests and flakes. No PRD: this plan is the whole spec. One slice per backlog item, appended at each wave boundary; every slice reads [`plans/fixes-rules.md`](fixes-rules.md).

## Status

**Landing mode:** run everything through (started run-through; land each green wave without asking, ask only real questions).

| Slice | Wave | Item      | Model | State  | Merge into `prd/fixes-tooling` |
| ----- | ---- | --------- | ----- | ------ | ------------------------------ |
| 14    | 3    | RISA-952  | opus  | merged | 2439fe9                        |
| 15    | 3    | RISA-997  | opus  | merged | ac81b56                        |
| 16    | 3    | RISA-999  | opus  | merged | 79d6fef                        |
| 17    | 3    | RISA-1000 | opus  | merged | 6f9f1b0                        |
| 18    | 3    | RISA-927  | opus  | merged | 10ef985                        |

**Wave 3** (2026-11-27): slices 14–18. Left for wave 4: RISA-994 (recheck after 1000), 813, 915 (dispatch-pick rule 8 may already cover it), 926 (loops/machine is after-split-2's), 986 (ls.sh), 881–889 (process/docs). Merged all five (17's vitest.config conflict with 15 resolved: both kept). Slice checks were red only on load timeouts (RISA-994 notes). CI unit green on b7bb152 (run 46090524277, the first with a real verdict); sync not needed; docs folded; PR #10 open. Codex (on 2b02eab): P1 dispatch.mjs:1308 (a default-account session's null replaced by the dispatcher's account) sent to slice 18's agent; P2 rotate.sh:160 (close path fires before the wave lands) sent to slice 14's agent. Both fixed and re-merged (18: 1134fe0, 14: bbae04a); pushed da64927, threads answered and resolved. Codex round 2: P1 dispatch.mjs:1250 (a session limited on its own account is reopened by pick() before its reset) fixed by slice 18 (5d8aac8) and re-merged. Unit CI green on da64927 (run 46093565648); Unit CI green on 54e571d. Codex round 3: P1 dispatch.mjs:1251 (keep-alive reopens a session stalled on its own account) sent to slice 18; P2 rotate.mjs:139 (simulated pick omits facts.landed) tracked as RISA-1003, thread answered. After round 4, if more findings: ask the user (three rounds done). Next: triage, land, then rotate (session past the soft limit). RISA-881 goes in wave 4 (the user wants it before risa-next). RISA-996 closed: Codex found no major issues on PR #5 (c4ae22d1c7).

**Wave 2 landed** 2026-11-27 in main as 66e194d (PR #7): slices 8–13 (RISA-969, 681, 934, 987, 989, 993), all opus. Codex clean on bf7eebf after one P2 (RISA-999). CI (the new workflow) succeeded on the synced tip but writes no verdict (RISA-997), so it landed with `--force` on land skeptic s10's go. Report filed; slice worktrees removed.

**For the next session (wave 3):**

- **First, on the user's word (via the backlog session):** RISA-952 (a standing PRD with nothing runnable closes itself, `prd rm`), its notes folding in RISA-982; a wave of just it is fine. RISA-811 stays out (self-recovery-2, on hold).
- **Ready (after-split has landed):** RISA-997 (the workflow writes a verdict artifact, so `risa land`'s unit gate reads its runs: do it early, it removes the `--force`), RISA-999 (an After on an archived PRD topic), RISA-994 (land-unsynced times out on main too; recover), RISA-813, 915, 926, 927, 882, 886, 881, 883, 889, 986. Check hot files first (`risa backlog prd list`).
- **RISA-996:** Codex asked on merged PR #5 by comment (wave 1's unreviewed diff); triage its findings to the backlog.
- **Docs still to fold:** machinery doc: plan sessions get the context hook (RISA-880, wave 1).
- **Gate:** the test env is hermetic now (after-split's RISA-975), so `risa check` works in a session; under load (>25) many tests time out: rerun failing files once at low load. Land skeptics run on Opus (b5c4391).
- Slice 12's note for later: `backlog/lock.mjs` is new; tests that copy backlog/ files by name must list it.

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
