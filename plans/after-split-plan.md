# Plan: after-split

> Source PRD: [`plans/after-split-prd.md`](after-split-prd.md). User-story numbers (US) refer to it. Items RISA-970, RISA-971, RISA-974, RISA-975, RISA-976, RISA-977, RISA-978, RISA-979, with RISA-932 and RISA-953 moved in from fixes-tooling. RISA-973 landed before the plan (5721c4e). RISA-972 (US 6) went to the follow-on topic `after-split-2`, after this one. Topic `after-split`. The user lifted the hold (registry: running).

## Status

| Slice | Wave | State  | Merge into `prd/after-split` |
| ----- | ---- | ------ | ---------------------------- |
| 1     | 1    | merged | caad988 (hand-off 5341bd5)   |
| 2     | 2    | merged | cba1282 (hand-off d830903)   |
| 3     | 2    | merged | 9b8e3bf (hand-off fc30975)   |
| 4     | 2    | merged | 1bd140e (hand-off 8e136b5)   |
| 5     | 2    | merged | b5cef69 (hand-off 836d563)   |
| 6     | 3    | merged | d660e0b (hand-off aca1edc)   |

**Landing mode:** run everything through (start every ready slice, land each green wave, ask only real questions). Started 2026-11-27; anchors fixed in the plan at start.

**Models:** slices 1–6 opus (each has real logic).

**Now:** all six slices merged (tip d660e0b); every item done (RISA-975/979/932/953/970/971/976/977/978/990, RISA-974). One landing for the whole plan. RISA-988 hotfix landed on main (1caec2c); synced with `--force` (56a22bb). Wave gate: `risa ci run unit` started no run (this repo has no CI yet); the gate is the plan's full `risa check` on the merged tip. Every slice's full `pnpm test` ran under load 24–43 with 12–86 timeouts outside its files; the gate settles them. Filed RISA-991 (stack down errors stackless), RISA-992 (prompt-golden timeout).

**Backlog:** claim each slice's items as it starts; `done` them when it merges. Slice 1: RISA-975, RISA-979, RISA-932, RISA-953. Slice 2: RISA-970, RISA-971. Slice 3: RISA-976 (the fixtures' half). Slice 4: RISA-976 (the git floor; `done` it when both 3 and 4 have merged). Slice 5: RISA-978, RISA-977. Slice 6: RISA-974.

## Architectural decisions

- **Tooling only:** `loops/`, `ci/`, `package.json`, `vitest.config.mjs`, the README, their tests and the generic docs. No new dependency, no runtime one.
- **No test reads this checkout's config, or the machine's live state.** Every test runs on the fixture or sample project, throwaway repos in the OS temp dir, and the environment the test setup builds.
- **Additive for projects:** no `risa.json` key changes; the exports only add; a project needs no change to take the release.
- **One git floor:** 2.28, one constant in `loops/machine.mjs`, read by `machine.mjs check` and the Vitest global setup.

## How to run this plan

- **Waves:** wave 1 is slice 1 alone: until it merges, `risa check` inside any session fails RISA-975's 217 (`lib.sh` `find_repo` exports `RISA_CONFIG` again for every `risa` command, so `env -u` doesn't help). Wave 2 runs slices 2 to 5 at once (no shared file among them). Wave 3 is slice 6 (after 2 and 5: it changes `loops/docs-budget.mjs`, and the generic docs 5 may name).
- **Gate:** `risa check --quick "slice hand-off"` before each hand-off; `pnpm check` once on the merged tip at landing. No browser harness.
- **Slice 1 is the suite's proof:** its check runs inside its orchestrator's session, through `risa check`, which exports `RISA_CONFIG` itself: the environment that broke the tests.
- **Other topics:** none running. Held topics name `loops/dispatch` as hot; slice 5 changes `loops/dispatch.mjs`, so check `risa backlog prd list` at the wave boundary.
- **Docs at landing:** the README's install says git 2.28 or newer (slice 4).
- **After:** `after-split-2` (RISA-972) is the next topic; its row is in the PRD table, after this one.

## Slice 1: A hermetic test run

Stack: no · Reads: loops/docs/loop.md · Tests: unit · Blocked by: none

**User stories:** US 1, 2.

**Build:** the test setup (`loops/test-setup.mjs`) builds the tests' environment through one pure function, `hermeticEnv(env)` in a new `loops/test-env.mjs`: `RISA_CONFIG` is the fixture project's (`FIXTURE_CONFIG`) unless `RISA_TEST_CONFIG` names another, never an inherited one; no machine config, no machine tag; a session's state variables cleared (`RISA_SESSION`, `RISA_SESSION_PID`, `RISA_SESSION_NAME`, `RISA_SESSIONS_DIR`, `RISA_USAGE_*`, `RISA_ASKS_DIR`, `RISA_NOTICES_DIR`, `RISA_REQUESTS_DIR`, `RISA_LANDING_DIR`, `RISA_SKEPTIC_DIR`, `RISA_CONTEXT_HOOK`, `RISA_RUN_LOG`, `RISA_CHECK_LOG`, `RISA_MAIN`, `RISA_DISPATCH_MAIN`, and the Claude Code session's own `CLAUDECODE`/`CLAUDE_CODE_*`). Then whatever still fails when the suite runs inside a session is fixed at its test: the drain cases (`loops/dispatch.test.mjs`, `loops/drain.test.mjs`), the usage status line (`loops/usage.test.mjs`) and `loops/stack.test.mjs`'s two rm.sh B-812 cases, each passing its child processes the environment it means rather than the inherited one.

**Acceptance criteria:**

- Unit test in `loops/test-env.test.mjs` (new): a session's environment (`RISA_CONFIG` naming another repo's config, `RISA_SESSION_PID`, `RISA_SESSIONS_DIR`, `RISA_USAGE_DIR`, `CLAUDECODE`) comes out with the fixture config and none of them; `RISA_TEST_CONFIG` is kept as the config; unrelated variables (`PATH`, `HOME`) pass through.
- `pnpm test` run from the slice's own session (which has `RISA_CONFIG`, `RISA_SESSION_*` and `RISA_SESSIONS_DIR` set: today 217 fail) passes in full, and so does the same run with those unset (`env -u …`); the hand-off names both counts.
- `risa check --quick "slice hand-off"` passes from the slice's session: the tooling tests run after `lib.sh` has exported the main checkout's `RISA_CONFIG`, and still read the fixture's.

**Blocked by:** nothing. **Blocks:** 2, 3, 4, 5.

## Slice 2: A project imports the CI and docs-budget parts by name

Stack: no · Reads: loops/docs/project-config.md · Tests: unit · Blocked by: 1

**User stories:** US 4, 5.

**Build:** `package.json` `exports` adds `./ci/ci-runs.mjs`, `./loops/docs-budget.mjs` and `./ci/verdict.fixtures/*`. `loops/docs-budget.mjs` exports `BUDGETS` and a pure `overBudget(dir)` (the over-budget lines), and runs its check and exit only when it is the main module (the `isMain` pattern of `loops/machine.mjs`); `pnpm docs:budget` prints and exits as today.

**Acceptance criteria:**

- Unit test in `loops/exports.test.mjs` (new), each import in a child `node` process run from the repo root (Node resolves the package's own name there; the planner checked `import "risa/loops/time-gate.mjs"`): `import "risa/ci/ci-runs.mjs"` gives `VERDICT_VERSION` and `isVerdict`; `import "risa/loops/docs-budget.mjs"` gives `BUDGETS`, writes nothing and exits 0; `import.meta.resolve("risa/ci/verdict.fixtures/candidate-green.json")` names a file that exists and `isVerdict` accepts.
- Unit test: `overBudget` on a temp folder with a doc over its budget and one with no budget returns both lines; on `loops/docs` it returns none.
- `pnpm docs:budget` still exits 1 with the lines on an over-budget doc and 0 with its one line otherwise.

**Blocked by:** 1. **Blocks:** 6.

## Slice 3: A fixture's failed git init stops it

Stack: no · Reads: none · Tests: unit · Blocked by: 1

**User stories:** US 3.

**Build:** the six fixtures that run `git init` through an unchecked `spawnSync` (directly: `loops/context.test.mjs`, `loops/workers.test.mjs`, `loops/watch.test.mjs`, `ci/release-gate.test.mjs`; through their `run` wrapper: `ci/candidate.test.mjs`, `ci/promote.test.mjs`) throw when it fails (its status non-zero), before any later git command; the rest already init through `execFileSync` or a wrapper over it, which throws.

**Acceptance criteria:**

- Unit test in each of the six files: with a stub `git` first on `PATH` that rejects `init -b` (exit 129, as git 2.24 does), the fixture throws naming the init, and the stub records no later git command.
- The hand-off lists every `init` call under `loops/`, `ci/` and `backlog/` (`grep -n '"init"'`) with how each fails: thrown, or checked.

**Blocked by:** 1. **Blocks:** nothing.

## Slice 4: Git older than 2.28 stops install and the test run

Stack: no · Reads: loops/docs/project-config.md · Tests: unit · Blocked by: 1

**User stories:** US 3.

**Build:** in `loops/machine.mjs`, a shared floor, the new constant `GIT_FLOOR` (2.28) and a pure `gitTooOld(versionText)`. `machine.mjs check` refuses a git under it with one line naming the version and exit 2. A Vitest global setup in `loops/test-global-setup.mjs` (new), which `vitest.config.mjs` names as its new `globalSetup`, runs `git --version` once and throws that line before any file runs. The README's install says git 2.28 or newer.

**Acceptance criteria:**

- Unit tests (`loops/machine.test.mjs`): `gitTooOld("git version 2.24.3")` is true, `2.28.0` and `2.56.1` false, an unreadable line true; `machine.mjs check` with a stub `git` on `PATH` printing 2.24 exits 2 with the one line, with 2.28 exits 0.
- Unit test (`loops/machine.test.mjs`): the global setup's function throws one line on a 2.24 stub and returns on 2.28.

**Blocked by:** 1. **Blocks:** nothing.

## Slice 5: A new machine's inbox and a stackless status say what is true

Stack: no · Reads: loops/docs/machinery.md, loops/docs/inbox.md · Tests: unit · Blocked by: 1

**User stories:** US 7, 9.

**Build:** in `loops/dispatch.mjs`'s keep-alive step, when `inboxUntrusted` gives a reason, the dispatcher files one report (topic `dispatch`, through the same `ask.mjs --report` call the drain's `report` uses) naming the folder and the command (the project's own `inbox` command, as `inboxUntrusted`'s line has it), and records `inboxReported` in its state. A tick with the folder trusted clears the record. `--dry-run` prints that it would report. `loops/ls.sh` prints `test database: none (no testDb hook)` when `has_hook testDb` is false. Where `loops/docs/inbox.md` says the dispatcher won't open an untrusted inbox, it names the report too, within the doc's budget (this slice changes no budget).

**Acceptance criteria:**

- Unit tests in `loops/dispatch.test.mjs`'s untrusted-inbox block: two ticks with the folder untrusted file one report naming `inbox` and the folder; trusted, then untrusted again, files a second; a dry run files none and says it would; with `RISA_KEEP_SESSIONS=off`, none.
- Unit test (`loops/stack.test.mjs`, beside the RISA-973 case): `ls.sh` on the no-stack-hooks config prints `test database: none (no testDb hook)` and not `unknown`; on the sample config it still prints the hook's line.

**Blocked by:** 1. **Blocks:** 6.

## Slice 6: The generic docs name the project's command

Stack: no · Reads: loops/docs/planner.md · Tests: unit · Blocked by: 2, 5

**User stories:** US 8.

**Build:** every literal `prd <command>` in `loops/docs/*.md` (`prd doc …`, `prd dispatch --cap`, `prd anchors`, and the rest) becomes `{{prd}} <command>`. The budgets in `loops/docs-budget.mjs` grow by the bytes that adds to each doc, no more. A `loops/doc.test.mjs` case fails on any generic doc with a backticked `prd ` not written as `{{prd}}`.

**Acceptance criteria:**

- Unit test (`loops/doc.test.mjs`): no generic doc has a literal backticked `prd <word>`; `roleDoc("loop")` on the fixture config shows its `tool.prd` name in the "Rules across PRDs" reference.
- The prompt golden regenerated (`project-check --write-golden`), not hand-edited, and `loops/prompt.test.mjs` updated only where the rendered docs changed.
- `pnpm docs:budget` passes.

**Blocked by:** 2, 5. **Blocks:** nothing.
