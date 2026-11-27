# Plan: fixes-tooling

> Risa's standing fix topic for scripts, checks, tests and flakes. No PRD: this plan is the whole spec. One slice per backlog item, appended at each wave boundary; every slice reads [`plans/fixes-rules.md`](fixes-rules.md).

## Status

**Landing mode:** run everything through (started run-through; land each green wave without asking, ask only real questions).

| Slice | Wave | Item     | Model | State  | Merge into `prd/fixes-tooling` |
| ----- | ---- | -------- | ----- | ------ | ------------------------------ |
| 1     | 1    | RISA-935 | opus  | merged | 182c26b                        |
| 2     | 1    | RISA-933 | opus  | merged | 9ed410c                        |
| 3     | 1    | RISA-367 | opus  | merged | 634f5dd                        |
| 4     | 1    | RISA-477 | opus  | merged | 5e2515c                        |
| 5     | 1    | RISA-911 | opus  | merged | 06d42e8                        |
| 6     | 1    | RISA-880 | opus  | merged | 57c983b                        |
| 7     | 1    | RISA-721 | opus  | merged | bb7b20d                        |

**Wave 1** (2026-11-27): all seven merged (tip bb7b20d); gate green 2026-11-27 (`pnpm check`, `RISA_*`/`CLAUDE_CODE_*`/`CLAUDECODE` unset: 6 load timeouts passed on rerun; dispatch.test's RISA_MAIN case fails on main too in any linked worktree, filed RISA-990). Synced (no-op), pushed. **Next:** `risa pr` stops at "unknown tier" (check-plan, same gap), so landing waits for the RISA-988 hotfix on main (background wait on origin/main; the backlog session will message). Then `risa sync`, `risa pr fixes-tooling`, `risa review fixes-tooling --wait`, land, docs, status-trim, rotate (this session is past the soft limit). Docs at landing: RISA-911 (wait default 160 s) for the loop doc and RISA-880 (plan sessions get the context hook) for machinery: `loops/docs/` is after-split's hot file, so fold them in a later wave. Slice worktrees 1 to 7 kept until landed. Follow-ups filed: RISA-986, 987, 989 (RISA-990 moved to after-split by the backlog session). Slices 1 to 7, no shared file among them; all seven on opus, spawned 2026-11-27 with `risa watch fixes-tooling --wait` in the background.

**Open issue:** `risa check` can't run here (risa.json has no `paths.checkPlanRules`; `loops/check-plan.mjs`), so slices hand off on hand-run vitest, eslint and prettier; the inherited `RISA_CONFIG` leaks into fixtures (unset `RISA_*` for test runs); `loops/prompt.test.mjs` has 47 failures on the base. Backlog session (risa-2a), on the user's word: a hotfix fixes the check-plan rules (RISA-988, `hotfix/check-plan-rules`), and it will say when that lands; until then slices merge on hand-run tests and the wave gate is `pnpm test` with `RISA_*` and `CLAUDE_CODE_*` unset (the prompt.test failures are that same leak).

**Waiting, later waves:** RISA-681 and RISA-934 (wave 2: they share `ci/ci-file.mjs` and `backlog/registry.mjs` with slices 7 and 4). After-split's hot files (`loops/dispatch*`, `loops/machine*`, `loops/docs/`, `package.json`…): RISA-813, 915, 926, 927, 952, 882, 886. RISA-722, 780, 459: decided for you (ask a6, skeptic s5): fixed here in a later wave (722: an override for a commit holds until a run on a newer commit; 459's meaning of live is its own question when its slice is written). RISA-969 (a GitHub workflow): asked the user, ask a5, waits (money). From the user via the backlog session: RISA-720 dropped; RISA-968 moved out (no topic); RISA-881, 883, 886, 889 stay here, in a wave after after-split lands (they touch `loops/docs/` and the prompts).

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
