# Plan: ship

> Source PRD: [`plans/ship-prd.md`](ship-prd.md). User-story numbers (US) refer to it. Item RISA-1053. Topic `ship`.

## Status

**From the user:** nothing yet beyond the start (run-through, 2026-11-28).

**Landing mode:** run everything through (started run-through, 2026-11-28): start every ready slice, land each green wave, ask only real questions.

**Now (2026-11-28):** wave 1: slice 1 (opus) handed off at `937185a` (slice check green, 15 tests) and merged as `bde2083`. `risa tier`: none (tooling only), so the gate is the full check on the synced tip. `risa sync` needed no merge. The local full check can't go green here: run 1 failed 11 tests in dispatch, drain and usage (RISA-1076: this session sets `CLAUDE_CONFIG_DIR`); run 2 with it unset passed those and failed 15 others on timeouts at load 37 to 40 (land-unsynced, recover-down, stack, rotate and others); no file fails in both and `loops/ship.test.mjs` passed in both. So the gate is `ci.yml` on PR 47 (https://github.com/interrobangc/risa/pull/47), told to the backlog session. The backlog session agreed (its advice: a PR run failing only on RISA-1085 counts as green; the load timeouts are RISA-1096). Codex round 1 on `221bff2`: two findings, both verified real and sent to slice 1's agent as one fix (a fix in flight: no rotation): P1 thread `PRRT_kwDOV9ctaM69IG2S` (`.lock` is created empty then written, so a second ship can take over a live lock) and P2 thread `PRRT_kwDOV9ctaM69IG2a` (`--from` saves the rewound record only after its first hook). The fix: `d5583b5` on the slice (slice check green, 18 tests), merged as `aa46ca1` and pushed; both threads answered with the fixing commit. Out now: Codex round 2 (`risa review ship --again --wait`) and PR 47's CI run on `aa46ca1`. Next: resolve threads that are current, land on a green PR run and a clean review (`risa land ship`), docs, `status-trim`, rotate (past the soft context limit: rotate at this wave boundary).

| Slice | Wave | State  | Merge into `prd/ship` |
| ----- | ---- | ------ | --------------------- |
| 1     | 1    | merged | `bde2083`             |
| 2     | 2    | —      | —                     |
| 4     | 2    | —      | —                     |
| 3     | 3    | —      | —                     |

**Backlog:** claim RISA-1053 as slice 1 starts; it is `done` after slice 3 lands (slice 4 may land after it).

## Architectural decisions

- **The tool owns the order, a project owns the steps.** `loops/ship.mjs` knows the phases, the record, resuming and the report, and nothing about tags, `package.json` or deploys; `release/ship.mjs` knows Risa's steps and nothing about phases or records. They meet only through `risa.json`'s `hooks.ship*` and the existing hook contract (the hook runner's `runHook` and `fact`).
- **Additive:** four optional config keys and one new command; no key renamed or removed, no command's output changed.
- **Hermetic tests:** temp repos (`loops/sample-project/repo.mjs` `makeRepo`, `loops/land-fixture.mjs`) with a bare `origin`; `RISA_SHIPS_DIR`, `RISA_ASKS_DIR`, `RISA_MACHINE_CONFIG` and `HOME` at temp paths; a fake `gh` on `PATH`. No test pushes to the real `origin`, tags this repo or writes the real `~/.risa`.
- **A ship is the user's word.** No slice wires ship into the dispatcher, a prompt's trigger or a default.

## How to run this plan

- **Waves:** wave 1 is slice 1 (the scaffold). Wave 2 runs slices 2 and 4 (both after 1: slice 2 owns `release/` and `risa.json`, slice 4 owns the doc). Wave 3 is slice 3 (after 2: the same `release/ship.mjs`).
- **Gate:** `risa check --quick "slice hand-off"` before each hand-off; `pnpm check` once on the merged tip at landing.
- **Other topics:** the row's hot files are `loops/ship`, `loops/config.mjs`, `loops/prd.sh`, `release/`, `risa.json`, `vitest.config.mjs`, `loops/docs/ship.md`, `loops/docs-budget.mjs`, `loops/doc-sections.test.mjs`, `CHANGELOG.md` and `AGENTS.md`. Running topics hold some: `risa-next-2` (`loops/config`, `loops/prd.sh`: slice 1 only) and `fixes-bug` (`loops/docs`, `loops/doc`: slice 4 only), so no slice spans two running topics. If either still holds its file when that slice is due, the orchestrator holds the slice until that topic's wave lands. Planned or held rows that meet these files: `risa-next-4` (`loops/config`), `usage-aware-drain` (`loops/docs`), `staging-ship` and `asks-relay` (`loops/prd.sh`).
- **Docs:** slice 4 writes `loops/docs/ship.md`; each new module's header comment says the rest.

## Slice 1: The scaffold runs a project's phases

Stack: no · Reads: loops/docs/project-config.md · Tests: unit · Blocked by: none · Check: loops/ship.test.mjs

**User stories:** US 1, 2, 3, 4, 5, 6.

**Build:** PRD _Implementation decisions_, _The ship module_. `loops/ship.mjs` (new): `PHASES` (`check`, `ship`, `smoke`, `notify` with their hook names); `nextPhases(record, { from })` (pure: the phases still to run, or a refusal for a finished record); `shipsDir()` (`RISA_SHIPS_DIR`, else the main checkout's `.loops/.ships`); the record's read and write, and the project's one lock (exclusive create of `.lock` in the ships folder with the pid, whatever the version; a dead pid's taken over); `reportText(record, project)` (pure); `runShip(version, { dryRun, from })`, calling each hook through the hook runner's `runHook` (hooks.mjs, unchanged) with the version as its argument and `RISA_SHIP_VERSION` in its env, writing the record after each phase, and filing the report through the asks store's `createAsk` (asks.mjs, unchanged) (kind report, topic `ship`) into the asks directory `prd.sh` passes; a CLI with the exit codes the PRD names. `loops/config.mjs` `SHAPE`: `hooks.shipCheck`, `hooks.ship`, `hooks.shipSmoke`, `hooks.shipNotify`, each `command?`. `loops/prd.sh`: a `ship)` line exec'ing the module (setting `RISA_SHIPS_DIR` beside `RISA_ASKS_DIR` as it does for asks), and its line in the usage text.

**Acceptance criteria:**

- Unit test (`loops/ship.test.mjs` (new)): `nextPhases` on no record, a record failed at `smoke` (resumes at `smoke`), `--from ship` on that record (`ship`, `smoke`, `notify`), a finished record (refused), and `--from notify` on a finished record (runs `notify` again); `reportText` for a finished ship (each phase, the hooks' facts, a skipped phase named) and a failed one (the phase, its tail, the resume command).
- Command tests in the same file, on a temp repo whose config's hooks are stub scripts that print facts and record their calls: `risa ship 1.2.3` runs the four in order with `1.2.3` as the argument and `RISA_SHIP_VERSION=1.2.3`, exits 0, and files one report; a missing `hooks.shipSmoke` is printed `skipped`; a config with no `hooks.ship` and a bad version each exit 2 before any hook; a failing `shipSmoke` exits 1, files a failure report, and a re-run calls only `shipSmoke` and `shipNotify`; a finished version exits 2; `--dry-run` runs only `shipCheck`, writes no record and files no report; a live lock exits 2, also for a second version, and a dead pid's lock is taken over.
- `loops/config.test.mjs` passes unchanged, and a config with the four keys loads.

**Blocked by:** nothing. **Blocks:** 2, 4.

## Slice 2: Risa checks, bumps, tags and pushes

Stack: no · Reads: loops/docs/ship.md (if landed), plans/ship-prd.md · Tests: unit · Blocked by: 1 · Check: release/ship.test.mjs

**User stories:** US 7, 8.

**Build:** PRD _Implementation decisions_, _Risa's hooks_ (check and ship). `release/ship.mjs` (new), a CLI with verbs `check <version>` and `ship <version>` (the other two arrive in slice 3) and the shared helpers: the highest `v*` tag on `origin`, the commit CI must have passed (`origin/main`'s newest commit that changes more than the backlog's files: later commits touching only `plans/` don't count) and CI's conclusion on it (through the existing CI reader, `listRuns` with `--commit <sha>` and its `WORKFLOW_NAME` filter, from ci-runs.mjs, unchanged), the version comparison. `ship` works in a temporary worktree detached at `origin/main` and removes it on every exit; it sets the package file's `version` by replacing that one value, and in `CHANGELOG.md` turns `## Unreleased` into `## v<version>` with a new empty `## Unreleased` above it; it commits with the subject `chore(release): v<version>`; it pushes `HEAD:refs/heads/main` without force, then makes and pushes the annotated tag; a tag already on `origin` whose commit's package file has the version prints the facts and exits 0. `risa.json` gets two new hooks naming the two verbs, `hooks.shipCheck` and `hooks.ship`; also the two verbs; `release` added to `paths.tooling`. `vitest.config.mjs`: the `release/` folder's tests in `tooling:unit`.

**Acceptance criteria:**

- Command test (`release/ship.test.mjs` (new)), a throwaway repo with a bare `origin`, tags `v0.1.0` and `v0.2.0`, and a fake `gh` answering `run list` for the tip: `check 0.2.1` passes and prints `tip=`; `check 0.2.0` (tagged), `check 0.1.9` (not above) and a failed, running or missing CI run each exit non-zero with a line naming why; a green commit followed only by a commit to `plans/backlog.md` passes.
- `ship 0.2.1`: `origin/main` gains one commit with the subject `chore(release): v0.2.1` whose only changes are the package file's version and the changelog's `## Unreleased` becoming `## v0.2.1` under a new empty one; `origin` has the annotated tag `v0.2.1` at it; the main checkout's branch, index and files are unchanged; no worktree is left. A second `ship 0.2.1` exits 0 without a new commit. An `origin/main` that moves between the worktree's start and the push makes it exit non-zero with no tag pushed.
- `risa project-check` passes on this repo's `risa.json`.

**Blocked by:** 1. **Blocks:** 3.

## Slice 3: Risa installs the tag, tries it and tells pinned projects

Stack: no · Reads: plans/ship-prd.md · Tests: unit · Blocked by: 2 · Check: release/ship-smoke.test.mjs

**User stories:** US 6, 9, 10.

**Build:** PRD _Implementation decisions_, _Risa's hooks_ (smoke and notify). Slice 2's release/ship.mjs gains verbs `smoke <version>` (install at `$HOME/.risa/releases/v<version>` by `git worktree add --detach` at the tag, reusing one already at it and refusing one at another commit; then `loops/machine.mjs check`, `bin/risa --root`, `bin/risa doc planner`, and `bin/risa backlog list` from this repo's main checkout, a read; prints `install=` and `link=`) and `notify <version>` (the machine config's other repos whose `risaVersion` is below the version each get a report, topic `risa-release`, filed by running the install's `bin/risa ask --topic risa-release --report …` from that repo with `RISA_ASKS_DIR`, `RISA_SHIPS_DIR`, `RISA_SKEPTIC_DIR`, `RISA_NOTICES_DIR`, `RISA_CONFIG` and `RISA_CONFIG_FOUND` removed from its env; prints `notified=` for each and `elsewhere=`). Never touches `~/.local/bin`. `AGENTS.md`'s _Releases are tags_ line: releases are cut with `risa ship <version>`, which bumps, tags, installs, tries and tells. `risa.json` gets two new hooks naming the two verbs, `hooks.shipSmoke` and `hooks.shipNotify`.

**Acceptance criteria:**

- Command test (`release/ship-smoke.test.mjs` (new)), a throwaway repo cloned from this checkout's `HEAD` and tagged, `HOME` and `RISA_MACHINE_CONFIG` at temp paths: `smoke <version>`, its `backlog list` run from a `makeRepo` sample project (never this checkout's backlog), makes the install and prints `install=` and `link=`; run again it reuses it; an install at another commit makes it exit non-zero; an install whose `bin/risa --root` fails (a broken `bin/risa` committed at the tag) exits non-zero naming the step.
- `notify <version>`, its install made by running `smoke` first in the same test, run with `RISA_ASKS_DIR` and `RISA_CONFIG` set to the shipping repo's (as a ship's hook inherits them): a machine config listing the repo and two sample projects, one with `risaVersion` below and one at the version: only the first gets one report (read with `risa asks --json` there), the shipping repo's asks get none, and the first is printed `notified=`; with no other repo it prints only `elsewhere=`.
- Slice 2's release/ship.test.mjs passes unchanged.

**Blocked by:** 2. **Blocks:** nothing.

## Slice 4: The ship doc

Stack: no · Reads: loops/docs/project-config.md · Tests: unit · Blocked by: 1 · Check: loops/doc-sections.test.mjs

**User stories:** US 2, 3.

**Build:** PRD _Implementation decisions_, _The doc_. `loops/docs/ship.md` (new, under 1 KB): the four phases and their hook keys, the hook contract (the version as the argument, `RISA_SHIP_VERSION`, `key=value` facts), the record, resuming and `--from`, `--dry-run`, the report, and that only the user's word starts a ship (never the dispatcher, an orchestrator or a loop). The doc follows the doc test's rules: it opens with `# Title` and an intro paragraph, and names commands as `{{prd}}`, never literally; `ship` then appears in `doc`'s role list. `loops/docs-budget.mjs` `BUDGETS`: the doc at 1 KB. `loops/doc-sections.test.mjs` `LAST`: the doc and its last heading. `CHANGELOG.md`: a line under `## Unreleased` naming the new doc and its headings (the headings check, `pnpm docs:headings`, needs it).

**Acceptance criteria:**

- Unit test (`loops/doc-sections.test.mjs`): its every-generic-doc pin passes with the new doc listed, and its last heading is the one `LAST` names. `loops/doc.test.mjs` passes unchanged.
- `pnpm docs:budget` and `pnpm docs:headings` pass.

**Blocked by:** 1. **Blocks:** nothing.
