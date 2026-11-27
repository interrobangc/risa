# Plan: fixes-tooling

> Risa's standing fix topic for scripts, checks, tests and flakes. No PRD: this plan is the whole spec. One slice per backlog item, appended at each wave boundary; every slice reads [`plans/fixes-rules.md`](fixes-rules.md).

## Status

**Landing mode:** run everything through (started run-through; land each green wave without asking, ask only real questions).

**Wave 2** (started 2026-11-27): slices 8–13, all opus. Wave 1 landed in main as c4ae22d (PR #5); its table is in the history once trimmed.

| Slice | Wave | Item     | Model | State  | Merge into `prd/fixes-tooling` |
| ----- | ---- | -------- | ----- | ------ | ------------------------------ |
| 8     | 2    | RISA-969 | opus  | merged | 6202184                        |
| 9     | 2    | RISA-681 | opus  | merged | 7796fbc                        |
| 10    | 2    | RISA-934 | opus  | merged | 4c91c61                        |
| 11    | 2    | RISA-987 | opus  | merged | 00269bb                        |
| 12    | 2    | RISA-989 | opus  | merged | ee78763                        |
| 13    | 2    | RISA-993 | opus  | merged | 7451bdd                        |

**Notes:**

- **Gate:** `risa check` inside a session fails ~259 tests on the `RISA_CONFIG` leak until after-split's slice 1 lands; gate with every `RISA_*`, `CLAUDE_CODE_*`, `CLAUDECODE` unset, rerun failing files once (load timeouts). No CI until slice 8's workflow is on main: landing wave 2 needs `--force` (ask the user, `--waits`) unless the workflow runs on the PR.
- **Wave 3 first (the user, via the backlog session):** RISA-952 (a standing PRD with nothing runnable closes itself, `prd rm`), its notes folding in RISA-982, as wave 3's first slice right after wave 2 lands; a wave of just it is fine. RISA-811 stays out (self-recovery-2, on hold). Main's b5c4391: land skeptics run on Opus (`model: "opus"`), not Fable: pick it up at the next sync.
- **Waiting:** RISA-994 (may share after-split slice 1's cause: check after it lands); RISA-996 (Codex review of wave 1's landed diff: do it at wave 2's PR); after after-split lands: RISA-813, 915, 926, 927, 952, 882, 886, 881, 883, 889, 986, plus wave 1's docs (loop doc: `wait check` 160 s, RISA-911; machinery: plan sessions get the context hook, RISA-880; backlog doc: `prd set … why=`, RISA-477).
- Usage: all six slices hit the 5h limit mid-check (17:40 reset); each had one commit on its branch, clean tree. Resumed by message after the reset to finish the slice check and hand off.
- RISA-997 filed (slice 8): the workflow writes no verdict artifact, so `risa ci run --wait` reads its runs as unknown.
- Context past the soft limit (120k): rotate at this wave's boundary.
- **Synced with main** (after-split's a6c95e4) as 74f9487 (one conflict, `ci/promote.test.mjs`, resolved). Wave gate: full `risa check` on the synced tip (tier `unit`; the CI workflow isn't on main yet and writes no verdict, RISA-997). Gate run 1 (load 75): 18 failures, mostly timeouts. Rerun of 4 files on main vs the branch: `loops/land-unsynced.test.mjs` times out on both (pre-existing, noted on RISA-994); `loops/tidy-cli.test.mjs` fails only on the branch (its fixture doesn't copy slice 12's new `backlog/lock.mjs`): **sent back to slice 12**. Then a second merge of 12 and the gate again. after-split landed: RISA-994 and the after-split-blocked items can go in wave 3.

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
