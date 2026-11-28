# Plan: self-recovery-3

> Source PRD: [`plans/self-recovery-3-prd.md`](self-recovery-3-prd.md). User-story numbers (US) refer to it. Items RISA-998, RISA-1040, and a spike of Claude Code's background sessions. RISA-438, RISA-912 and RISA-913 went to the follow-on topic `self-recovery-4`, after this one. Topic `self-recovery-3`.

## Status

| Slice | Wave | State   | Merge into `prd/self-recovery-3` |
| ----- | ---- | ------- | -------------------------------- |
| 1     | 1    | planned | —                                |
| 2     | 1    | planned | —                                |
| 3     | 1    | planned | —                                |
| 4     | 1    | planned | —                                |
| 5     | 2    | planned | —                                |
| 6     | 2    | planned | —                                |

## Architectural decisions

- **Tooling only:** `loops/`, `backlog/` and their tests. No new dependency, no `risa.json` key, no machine config key: a project takes the release with no change. A new registry flag (`replan`) and state appear only on a row someone flags.
- **Pure decisions, thin CLIs:** each new rule is a pure function over gathered facts (the `dispatch-stuck.mjs`, `finish.mjs` and `rotate.mjs` pattern); the dispatcher or the script gathers and acts.
- **One close path:** the replan close and the backstop both go through `loops/rotate.sh`'s close after a landing (RISA-952's), so `rm`, its refusals and the session end stay in one place. Nothing is `rm --force`d; an unmerged `prd/<topic>` branch is kept, as `rm` keeps any.
- **Never a slice cut off:** a replan acts only at rotate's hand-over after a landing; the backstop acts only on a managed live session that is idle and landed with no rotation since.
- **No role doc changes:** the rules go in the header comments of the files they change (PRD _Decisions_).
- **Hermetic tests:** temp repos and folders, a stub `claude` (`RISA_CLAUDE_BIN`), stub process tables, `RISA_RUN_LOG` and `RISA_SESSIONS_DIR` set by the test. No case added to `loops/dispatch.test.mjs` or `loops/stack.test.mjs`; no test starts a real Claude Code session.

## How to run this plan

- **Waves:** wave 1 runs slices 1, 2, 3 and 4 (no shared file or `Check:`; slice 3's tests write the `replan` flag into a hand-made registry, so it needs no code of slice 1's). Wave 2 runs 5 (after 1) and 6 (after 3); 5 changes `loops/dispatch-pick.mjs`, 6 `loops/dispatch.mjs`, and they share no file or `Check:`.
- **Gate:** `risa check --quick "slice hand-off"` before each hand-off; `pnpm check` once on the merged tip at landing. Slice 4 is Markdown only (no `Check:`: the gate passes it on `prettier --check`).
- **Other topics:** `risa-next-2` is running and holds `backlog/` and `loops/dispatch` (slices 1, 5 and 6 each touch one of these, and only these). `fixes-bug` (standing) holds `loops/docs`, `loops/prompt.test.mjs` and `loops/session.sh` this wave: no slice touches them. At each wave boundary read `risa backlog prd list`: a slice whose files a running topic holds waits for a later wave, and no slice starts that would touch two running topics' hot files. A prompt change in another topic also changes `loops/sample-project/prompt-golden.txt` (slice 2's): on a conflict, regenerate it (`pnpm exec vitest run --project tooling:unit loops/prompt-golden.test.mjs -u`) and review the diff.
- **After:** `self-recovery-4` (RISA-438, RISA-912, RISA-913) is the next topic; its planner reads slice 4's `plans/self-recovery-4-spike.md` first.

## Slice 1: A `replan` flag and state in the registry

Stack: no · Reads: plans/self-recovery-3-prd.md · Tests: unit · Blocked by: none · Check: backlog/registry.test.mjs

**User stories:** US 1, 2.

**Build:** PRD _Implementation decisions_, _The replan flag_. In `backlog/registry.mjs`, `FLAGS` gains `replan` (its doc comment says what it means: the dispatcher sends the topic back to its planner, before it runs or at its next hand-over after a landing) and `STATES` gains `replan`; `stateOf` returns `replan` for a flagged row after the `done`, `running` and `hold` checks, before the standing and plan checks, and its doc comment says so. `prd list` (text and `--json`) and `prd set … flags+=replan` / `flags-=replan` work through the existing code; `findings` accepts the flag.

**Acceptance criteria:**

- Unit test (`backlog/registry.test.mjs`, extended): `stateOf` on a `replan` row with no worktree → `replan`, whether or not its plan is on the trunk; with a worktree → `running`; with `done` too → `done`; with `hold` too → `hold`; a standing row flagged `replan` → `replan`. `setRow` with `flags+=replan` keeps the other flags and `flags-=replan` removes only it; the row's table line round-trips through `parseRegistry`; `findings` reports nothing for the flag.

**Blocks:** 5.

## Slice 2: The planning prompt replans a topic already planned

Stack: no · Reads: plans/self-recovery-3-prd.md, loops/docs/planner.md · Tests: unit · Blocked by: none · Check: loops/prompt-golden.test.mjs

**User stories:** US 5.

**Build:** PRD _Implementation decisions_, _The replanner's prompt_. `loops/prompts/plan.sh` gains one bullet after the _Taking over from an earlier planner_ one, in both the `--auto` and the attended prompt: **A replan** (the row flagged `replan` in `$backlog_cmd prd list`, with `$plans_dir/$topic-prd.md` and `-plan.md` already on the trunk): read both, the items, and `git show $prd_prefix$topic:$plans_dir/$topic-plan.md` when that branch exists (its _Status_ is newer than the trunk's); keep each slice _Status_ shows landed, and its row, as they are; rewrite, add or drop only the slices not landed, renumbering none that landed; say what changed under the _Decisions_ table; the skeptic pass as usual; then `$backlog_cmd prd set $topic flags-=replan` before landing. Regenerate `loops/sample-project/prompt-golden.txt` and review its diff: only the new bullet, in both plan prompts.

**Acceptance criteria:**

- Unit test (`loops/prompt-golden.test.mjs`, unchanged; its golden file regenerated): the golden diff is the one bullet in each plan prompt, in the sample project's names (its backlog command, plans folder and topic `T`), and no other prompt changes.

**Blocks:** nothing.

## Slice 3: Rotate logs its runs, closes a topic flagged replan, and no slice starts on one

Stack: no · Reads: plans/self-recovery-3-prd.md, loops/docs/recovery.md, loops/docs/orchestrator.md · Tests: unit · Blocked by: none · Check: loops/rotate.test.mjs

**User stories:** US 3, 4, 6.

**Build:** PRD _Implementation decisions_, _Rotate_. In `loops/rotate.sh`: once the topic (or, with `--self`, the session) is known, each run appends one rotate (new) event through `run_log` (topic, name, outcome, midWave, and the reason when given), its outcome one of: opened, just before each hand to the opener; closed, after the standing close ends the session; replan, after the replan close does; refused, with the line, on each refusal after that point (one local function wrapping `die` for them). After the landing test (`landed`), before the standing close, the replan-close (new) CLI case on the same `prd list --json` rows: when the row is flagged `replan`, print `Closing <name> for a replan: the dispatcher plans <topic> again from the trunk.`, run rm from the main checkout and end the session as the standing close does, log the event, exit 0; a failed rm dies as the standing close does, the session left running. In `loops/rotate.mjs`: a pure replanClose (new) `(rows, topic)` (true for a flagged row that isn't `done` or `hold`) and the replan-close case in its CLI (rows on stdin; exit 0 to close, 1 not), and `standingClose`'s own pick maps a `replan` row as it maps a `to-write` one. In `loops/new.sh`, for `slice` only: when the registry reads (`backlog_run prd list --json`, as rm reads it) and rotate.mjs's replan-close says the row is flagged, refuse: `<topic> is flagged replan: land what is merged, then rotate (no new slice until it is replanned)`; an unreadable registry never refuses. `loops/run-log.mjs`'s kinds comment lists the rotate kind and its fields; the rotate script's header says what the replan close does and that every run is logged.

**Acceptance criteria:**

- Unit test (`loops/rotate.test.mjs`, extended; its standing-topic fixtures, `RISA_RUN_LOG` set): `replanClose` on a flagged, an unflagged, a flagged `done` and a flagged `hold` row. A plain rotation appends one `rotate` event, outcome `opened`; the standing close appends `closed`; an uncommitted plan's refusal appends `refused` with its line. A non-standing topic flagged `replan`, after a landing: `rm` ran (the worktree is gone, the branch kept), its stub session ended, no session opened, one `replan` event, the row's flags untouched. Flagged, but mid-wave or with code past the last landing: rotates as now (`opened`). `new.sh slice <topic> <n>` for a flagged topic refuses with the line and makes no worktree; unflagged, or with no registry, it makes one as now.

**Blocks:** 6.

## Slice 4: Spike Claude Code's background sessions for self-recovery-4

Stack: no · Reads: plans/self-recovery-3-prd.md, loops/docs/machinery.md, loops/docs/recovery.md · Tests: none · Blocked by: none

**User stories:** US 9.

**Build:** PRD _Implementation decisions_, _The spike_, and _Notes_. No code: one new file, `plans/self-recovery-4-spike.md` (new). In a throwaway fictional git repo outside every project (a temp folder, trusted for the test), on haiku (`--model haiku`), with the installed Claude Code (record `claude --version`), try and write down what each does: `claude --bg` (what it prints, its id), `claude agents --json` (the fields: id, pid, cwd, state, kind, started), `claude attach <id>`, `claude logs <id>`, `claude stop <id>`, `claude --bg --resume <id>` (and `--continue`). Then Risa's needs, one row each: `--remote-control <name>` in a background session (does the name show and take messages); `--name`; the status line (does Risa's status line command run, with the payload's rate limits, so the usage reading gets one); the hooks Risa installs (SessionStart, PreToolUse, PostToolUse, Stop: does the heartbeat write); the process (its pid and parent in `ps`, its cwd, so the session records' liveness test finds it); the per-account Claude config folder (`CLAUDE_CONFIG_DIR`, as the host layer sets it); an untrusted folder; what a sleep or a closed terminal does to it; PushNotification and AskUserQuestion from one. End every session it starts (`claude stop`, then check `agents --json`). The doc: a table (need, command tried, result, evidence), then for each of RISA-438, RISA-912 and RISA-913 what the spike makes possible, what blocks it, and a recommended first slice. No backlog edits.

**Acceptance criteria:**

- The spike doc exists with the version, a row for every need above (result `works`, `doesn't`, or `not shown` with why), and the three recommendations; `pnpm exec prettier --check` passes on it; no session the spike started is left in `claude agents --json`.

**Blocks:** nothing (`self-recovery-4`'s planner reads it).

## Slice 5: The pick plans a replan row and passes over a spent one

Stack: no · Reads: plans/self-recovery-3-prd.md, loops/docs/orchestration.md · Tests: unit · Blocked by: 1 · Check: loops/dispatch-pick.test.mjs

**User stories:** US 1, 3, 8.

**Build:** PRD _Implementation decisions_, _The replan dispatch_, and _Decisions_ (the spent row). In `loops/dispatch-pick.mjs` `pick`: rule 6's candidates are the `to-write` rows and the `replan` rows, in row order; `planBlock` skips the waiting-items test for a `replan` row, and the plan action's `why` says `flagged replan`. In the worktree loop, a `plan` worktree's `finished` is false while its row is `replan`, and the planners count takes `replan` beside `to-write`. A spent row (state `planned`, not `standing`, no prd worktree, `waiting` 0) is never started and is left out of `waitingPlans` (the lookahead); its reason is `no waiting items left: mark it done (… prd set <t> flags+=done) or add items`. The header's rule list says both. A `replan` row's reason in the reasons loop follows the `to-write` one.

**Acceptance criteria:**

- Unit test (`loops/dispatch-pick.test.mjs`, extended): a `replan` row with no worktree and no waiting items is planned; in row order behind an earlier `to-write` row and ahead of a later one; under a running planner, a full lookahead or an unmet `after` it waits like a `to-write` row; a `hold` row is never planned. A plan worktree whose row is still `replan` is a planner at work (a second topic isn't planned beside it at `planners: 1`) and is never treated as finished. A spent row is not started, its reason names `flags+=done`, and with it a `to-write` row is still planned where the lookahead would otherwise have been full; a standing row with no waiting items is `idle` as now.

**Blocks:** nothing.

## Slice 6: The dispatcher catches an orchestrator idle after a landing

Stack: no · Reads: plans/self-recovery-3-prd.md, loops/docs/recovery.md, loops/docs/orchestrator.md · Tests: unit · Blocked by: 3 · Check: loops/land-idle.test.mjs

**User stories:** US 7, 8.

**Build:** PRD _Implementation decisions_, _The land-idle backstop_. A new `loops/land-idle.mjs` (new): pure `landIdleDecide(facts, state, now)` and a `gatherLandIdle(…)` that reads the run log (with `parseRunLog`, from `$RISA_RUN_LOG`, else the main checkout's `.loops/.run-log.jsonl`), the session records and heartbeats, the rows. For each managed live `prd-<topic>` session of a standing topic or one flagged `replan`: its last `land-end` with `landed: true` for `prd/<topic>` after the record's `started`; no `rotate` event of the topic after that landing; idle for `RISA_LAND_IDLE_MIN` (10) minutes by finish's reading; nothing runnable (`standingClose`'s reason, on the facts the tick already has; a `replan` row needs none). Then `nudge` once per landing; `rotate` once the session has been idle for twice the window; `report-refused` once when that rotate failed. Nothing for a hand-opened session, a busy or ended one, a non-standing unflagged topic, or while paused or draining. Also `report-spent`, once per topic, for a spent row (slice 5's words: planned, not standing, no worktree, no waiting items, not done). In `loops/finish.mjs`, export the idle reading `finishDecision` uses (`idleOf(heartbeats, now, idleMs)` → the running call or the minutes since the last event) and use it there. In `loops/dispatch.mjs` `tick`, after `finishStep`, a `landIdleStep`: each nudge and report is one ask report (session `land-idle`: the topic, the landing's time, what happens next); `rotate` runs the rotate script on the topic from the main checkout and puts its first line in the report; state `landIdle` in the dispatcher's state; `--dry-run` prints `land-idle: would …`; the file's header gets one paragraph for it, with `RISA_LAND_IDLE_MIN`.

**Acceptance criteria:**

- Unit test (new `loops/land-idle.test.mjs`) of `landIdleDecide` and `idleOf`: a standing topic landed after its session started, no rotate after, idle 11 minutes, nothing runnable → `nudge`, and the same landing again → nothing; idle past twice the window → `rotate`, once; a failed rotate → `report-refused`, once; a `rotate` event after the landing, a landing before the session started, a running call, an event 5 minutes ago, a runnable item, an unflagged non-standing topic, a hand-opened session, paused, draining → nothing; a non-standing topic flagged `replan` idle after a landing → `nudge`, then `rotate`; a new landing after a nudge starts a new entry. A spent row → `report-spent` once; a standing row with no waiting items → nothing. `idleOf` matches what `finishDecision` waited on before (a call running; an event inside the window).

**Blocks:** nothing.
