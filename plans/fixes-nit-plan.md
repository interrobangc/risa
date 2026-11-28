# Plan: fixes-nit

> Risa's standing fix topic for small tidies users won't notice. No PRD: this plan is the whole spec. One slice per backlog item (a big one split), appended at each wave boundary; every slice reads [`plans/fixes-rules.md`](fixes-rules.md).

## Status

### From the user

(none yet)

**Landing mode:** run everything through (started run-through; land each green wave without asking, ask only real questions).

| Slice | Wave | Item           | Model  | State   | Merge into `prd/fixes-nit` |
| ----- | ---- | -------------- | ------ | ------- | -------------------------- |
| 1     | 1    | RISA-995 (1/4) | opus   | working |                            |
| 2     | 1    | RISA-995 (2/4) | sonnet | merged  | 7d4f33a                    |
| 3     | 1    | RISA-995 (3/4) | sonnet | working |                            |
| 4     | 1    | RISA-995 (4/4) | sonnet | working |                            |
| 5     | 1    | RISA-1019      | sonnet | working |                            |
| 6     | 1    | RISA-1041      | opus   | merged  | fdfb876                    |
| 7     | 1    | RISA-1051      | opus   | working |                            |

**Wave 1** (slices 1–7, all unblocked), 2026-11-28: the plan's first wave, written by this orchestrator (no plan existed). RISA-995's files under `backlog/` and `loops/dispatch*` wait for a later wave: they are hot for running risa-next-2; so does `loops/docs/inbox.md` for RISA-1051. `risa anchors` warns slices 1–4 name 13–18 files: each is a one-line wording edit per file, kept as is. Items claimed, hot files set. Slices 1–7 started (worktrees `.loops/fixes-nit-<n>`, one agent each; brief from `risa prompt slice`, plus a pointer to the command-name rule for 1–4). Slice 6 handed off (a91924f: `pack.log`, `packLine`; prompt-golden regenerated) and merged (fdfb876). Slice 2 handed off (474985a: user-facing messages already used toolCmd; comments reworded; `prd list`/`prd set` left: the backlog tool's registry subcommand) and merged (7d4f33a).

## How to run this plan

- **Gate:** `risa check --quick "slice hand-off"` before each hand-off; the wave's CI run on the merged tip at landing (plans/fixes-rules.md).
- **Hot files:** a fix touching a running topic's hot files (`risa backlog prd list`) waits for a later wave.
- **Commit the plan before `risa slice`:** a slice branch takes the committed plan.

## The command-name rule (slices 1–4)

The core's files never hold the tool's literal command names (`config.mjs`'s `toolCmd`, the boundary lint's tool-command rule). A message a user sees (a usage line, an error, a hint) names the command through `${toolCmd.prd}` / `${toolCmd.backlog}` in Node, or the shell's equivalent in `loops/lib.sh` (see its comment near line 127). A comment names the subcommand alone (`` `land` ``, "the land command"), never `prd land` nor `risa land`. Change wording only; no behaviour changes. Leave test files' expectations alone unless a changed message breaks one.

## Slice 1: Usage strings name the project's command (1/4: loops/ a–d)

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/doc.test.mjs

**Build (RISA-995, part 1):** apply the command-name rule above to every literal `prd <command>` in `loops/anchors.mjs`, `ask.mjs`, `asks.mjs`, `autostart.mjs`, `browser.sh`, `bye.mjs`, `check-budget.mjs`, `check-plan.mjs`, `check-times.mjs`, `context.mjs`, `doc.mjs` (its `usage: prd doc <role>`), `down.sh` and `drain.mjs`. Touch no other file.

**Acceptance criteria:**

- Unit test (`loops/doc.test.mjs`): `doc` with no role prints a usage line naming the configured command, not `prd`.
- No literal `prd <command>` left in those files (`grep`).

## Slice 2: Usage strings name the project's command (2/4: loops/ e–o)

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/notices.test.mjs

**Build (RISA-995, part 2):** the same rule for `loops/end-session.sh`, `inventory.mjs`, `land.sh`, `landed.mjs`, `lease.sh`, `lib.sh`, `load-gate.mjs`, `ls.sh`, `metrics.mjs`, `new.sh`, `notice.mjs`, `notices.mjs` and `open-session.mjs`. Touch no other file.

**Acceptance criteria:**

- Unit test (`loops/notices.test.mjs`): a notices message that names a command names the configured one.
- No literal `prd <command>` left in those files.

## Slice 3: Usage strings name the project's command (3/4: loops/ p–z)

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/skeptics.test.mjs

**Build (RISA-995, part 3):** the same rule for `loops/planner-model.mjs`, `pr.sh`, `project-check.mjs`, `queue.mjs`, `rotate.mjs`, `session-requests.mjs`, `sessions.mjs`, `skeptic.mjs`, `skeptics.mjs`, `slice-fields.mjs`, `status-extra.mjs`, `status-trim.mjs`, `tidy-cli.mjs`, `tidy.mjs`, `usage.mjs`, `watch.mjs`, `watchdog.mjs` and `workers.mjs`. Touch no other file.

**Acceptance criteria:**

- Unit test (`loops/skeptics.test.mjs`): a skeptics line that names a command names the configured one.
- No literal `prd <command>` left in those files.

## Slice 4: Usage strings name the project's command (4/4: ci/)

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: ci/ci-file.test.mjs

**Build (RISA-995, part 4):** the same rule for `ci/blame.mjs`, `candidate.mjs`, `ci-args.mjs`, `ci-blame.mjs`, `ci-commits.mjs`, `ci-file.mjs`, `ci-gate.mjs`, `ci-io.mjs`, `ci-runs.mjs`, `ci-status.mjs`, `ci.mjs`, `promote.mjs` and `tier-data.mjs`. Touch no other file.

**Acceptance criteria:**

- Unit test (`ci/ci-file.test.mjs`): a ci-file message that names a command names the configured one.
- No literal `prd <command>` left in those files.

## Slice 5: personaOf calls sessionPersona for the backlog rule

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/session-names.test.mjs

**Build (RISA-1019):** `personaOf` (`loops/session-names.mjs`, its backlog branch) repeats `sessionPersona`'s rule (`loops/flavor.mjs`: one word of letters, not `backlog`, the pool's rank). Keep its main-backlog, captain-session and `readDisplayName` steps, and replace the last two lines with `sessionPersona("backlog", remote, flavor)`; drop the "As flavor.mjs's sessionPersona reads it" comment. No behaviour change.

**Acceptance criteria:**

- Unit test (`loops/session-names.test.mjs`): a main backlog with a one-word remote, `backlog` as remote and a non-letter remote give the same personas as before.

## Slice 6: The persona line reports as a log, and the user's title is for speaking to them

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/flavor.test.mjs

**Build (RISA-1041):** the user (2026-11-28): "When captains are just talking about what they are doing, they should be writing to their captains log so the fleet admiral can review later. Only address fleet admiral when interacting directly with me." and "That needs to be configurable when switching color settings." The persona line is built in `loops/flavor.mjs` (`flavorLine`, ~182). Add a pack field beside `pack.address` (say `pack.log`: "captain's log" for the Starfleet pack) and have the line say: narration of the session's own work reads as an entry in that log, and the user's title is used only when speaking to the user directly (a question to them, an answer to their message). Nothing hard-coded in `flavorLine`; a pack without the field, and flavor none, keep a plain report voice and no log wording. Update `loops/sample-project/prompt-golden.txt` if the line appears there.

**Acceptance criteria:**

- Unit tests (`loops/flavor.test.mjs`): the Starfleet line names the captain's log and limits the title to speaking to the user; a pack with no `log` field has no log wording; flavor none unchanged.

## Slice 7: The machinery and orchestrator docs have the sections others point at

Stack: no · Reads: plans/fixes-rules.md, loops/docs/machinery.md, loops/docs/orchestrator.md · Tests: unit · Blocked by: none · Check: loops/doc-sections.test.mjs

**Build (RISA-1051):** `risa doc machinery "The dispatcher"` (and "Recorded sessions", "The load gate") and `risa doc orchestrator "Rules across PRDs"` print "no section", though orchestrator.md, loop.md, inbox.md, docs/planner.md and the planner prompt point at them. Add those four `##` sections, short, from what the code does (`loops/dispatch*.mjs` incl. its stop mark and the stuck watch's notified kind, `loops/load-gate.mjs`, the recorded sessions behind `bye`; for the rules across PRDs, `git log -S "Rules across PRDs"` for the text it once had: migrations, seeds, registries, hot files). Raise the two docs' budgets in `loops/docs-budget.mjs` by what the sections need, no more. The headings check (`pnpm docs:headings`) needs a `CHANGELOG.md` line under _Unreleased_ for each added heading. Don't touch `loops/docs/inbox.md` (hot for risa-next-2).

**Acceptance criteria:**

- Unit test (`loops/doc-sections.test.mjs`): every `{{prd}} doc <role> "<Section>"` reference in `loops/docs/`, `docs/` and `loops/prompts/` names a section that exists.
