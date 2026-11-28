# Plan: self-recovery-2

> Source PRD: [`plans/self-recovery-2-prd.md`](self-recovery-2-prd.md). User-story numbers (US) refer to it. Items RISA-811, RISA-789, RISA-560. RISA-438, RISA-912 and RISA-913 went to the follow-on topic `self-recovery-3`, after this one. Topic `self-recovery-2`.

## Status

| Slice | Wave | State         | Merge into `prd/self-recovery-2` |
| ----- | ---- | ------------- | -------------------------------- |
| 1     | 1    | landed (opus) | bf18c79                          |
| 2     | 1    | landed (opus) | c2f1e25                          |
| 3     | 2    | merged (opus) | aa0916e                          |
| 4     | 2    | merged (opus) | 8477e15                          |
| 5     | 2    | merged (opus) | 3c6214c                          |
| 6     | 3    | —             | —                                |

**Landing mode:** run everything through (started run-through; land each green wave unasked, ask only real questions).

**Hand-over (2026-11-28):** wave 1 (slices 1, 2) landed in main as 3c11cf9 through PR #20 (tier none, Codex clean; report filed). Wave 2 (slices 3, 4, 5) is merged at 3c6214c and **not yet gated**: run the full `risa check` on the tip (tier none, tooling only), `risa sync`, then PR + review + land. Slices 4 and 5's own slice checks timed out under load (load 16-33; their own test files passed), so the full check is their gate: send failures in their files to a fresh fix agent in `.loops/self-recovery-2-4` / `-5` (the original agents are gone with this session). Check runs at load above ~15 fail on timeouts; rerun when quieter. Then slice 6 (blocked by 3, now merged; RISA-789, claim it; opus) as wave 3. Slice worktrees 3, 4, 5 stay until wave 2's verdict is green (`risa rm self-recovery-2-<n>`).

**Open:** **message `fixes-tooling-3e` when the landing carrying slice 3 reaches main** (it holds RISA-1025 on our dispatch/finish files). Codex findings from PR #20, triaged into this PRD: RISA-1027 (the finish CLI re-files reports; no persisted keys) and RISA-1028 (cost counts a `plan-<x>` topic's transcripts as `<x>`'s planning); the user decides whether they join a wave. RISA-1025 and RISA-1026 (lease.test flake) filed under fixes-tooling. The handbook names no _Docs at landing_ section; each slice wrote its own doc bullet.

**Backlog:** RISA-811 and RISA-560 marked done at 3c6214c (they land with wave 2). Slice 6: RISA-789.

## Architectural decisions

- **Tooling only:** `loops/`, their tests and the generic docs. No new dependency, no runtime one, no `risa.json` key: a project takes the release with no change.
- **Pure decisions, thin CLIs:** each new rule is a pure function over gathered facts (the `resume.mjs` and `tidy.mjs` pattern); the CLI or the dispatcher gathers and acts.
- **`landed.mjs` says a topic landed** (`landedTopics`, `lastLanding`, `tailOf`, `slicesLeft`), unchanged; `finish.mjs` adds only `landedWithCode` on top of `lastLanding` and `tailOf`. `rm.sh` alone lands or drops a docs tail and marks done.
- **Never `--force`, never a session cut off, never one it can't show is idle:** the cleanup ends only recorded sessions whose heartbeat is idle, only after every reason `rm` would refuse is ruled out, and never with a landing journal for the branch.
- **Hermetic tests:** temp repos and folders, stub `claude`, stub process tables; every path the code reads (`RISA_SESSIONS_DIR`, `RISA_ASKS_DIR`, `RISA_LANDING_DIR`, `RISA_CLAUDE_PROJECTS`, the heartbeat folder) set by the test. New test files only, never `loops/dispatch.test.mjs` or `loops/stack.test.mjs` (`after-split`'s); `loops/tidy.test.mjs` and `loops/resume.test.mjs` are extended.

## How to run this plan

- **Waves:** wave 1 runs slices 1 and 2 (no shared file). Wave 2 runs 3 and 4 (after 1) and 5 (after 2); none shares a file. Wave 3 is slice 6 (after 3: both change `loops/dispatch.mjs` and `loops/docs/recovery.md`).
- **Gate:** `risa check --quick "slice hand-off"` before each hand-off; `pnpm check` once on the merged tip at landing.
- **Other topics:** this row runs after `after-split` (it owns `loops/dispatch`, `loops/docs` and `loops/docs-budget.mjs` while it runs). `fixes-tooling` is standing and sets its hot files per wave; today they include `loops/prd.sh` (slices 1 and 5) and `loops/tidy` (slice 4). At each wave boundary read `risa backlog prd list`: a slice whose files a running topic holds waits for a later wave, and no slice starts that would touch two running topics' hot files.
- **Docs budget:** slices 1, 3 and 6 add to `loops/docs/recovery.md` (5 KB budget, about 2.8 KB used); slice 5 adds to `loops/docs/machinery.md` and raises its budget in `loops/docs-budget.mjs` by what it adds, at most 300 B.
- **After:** `self-recovery-3` (RISA-438, RISA-912, RISA-913) is the next topic; its row is in the PRD table, after this one.

## Slice 1: `risa finish` cleans up one landed topic by hand

Stack: no · Reads: loops/docs/recovery.md, loops/docs/machinery.md · Tests: unit · Blocked by: none · Check: loops/finish.test.mjs

**User stories:** US 1, 2, 3, 4.

**Build:** a new `loops/finish.mjs` (PRD _Implementation decisions_, _The finish decision_ and _Landed with code_). Pure `finishDecision(facts)`: `running`, `clean`, `wait` (a busy recorded session or a landing journal, with why), `report` (a code tail, a dirty worktree, slice worktrees left, a live claude in the worktree that no record names, a live recorded session with no heartbeat record, or no worktree left with a slot or a row not done (the report names the `rm` or `risa backlog prd set` line); keyed by topic, reason and tip, nothing returned when the key is in `facts.reported`), or `act` (`{ end: [recorded sessions], rm: true }`), the report reasons checked before `act`; a `standing` topic is always `running`. Idle: no running call in any of the session's heartbeat records (`heartbeat.mjs`) and no event in the last `RISA_FINISH_IDLE_MIN` (10) minutes. `landedWithCode(repo, topics, trunk)`: the topics whose `lastLanding` is in the trunk and whose `tailOf` is `code` (the caller leaves standing topics out, as for `landedTopics`). `loops/sessions.mjs` gains `liveIn(dir, { table, cwdOf, claude })`: the live claude pids whose working directory is DIR or under it. The CLI `node loops/finish.mjs <topic> [--dry-run] [--json]` gathers the facts (`landedTopics`, `landedWithCode`, the worktree list and `git status --porcelain`, the slice worktrees, the registry row, the session records, `liveIn`, the heartbeat folder, the landing journals) through an exported `gatherFinish`, and acts: `end-session.sh` for each recorded session, then `rm.sh <topic>` from the main checkout (no `--force`), then one report (session `finish`) with what it ended and `rm`'s lines, or what it kept and why. `loops/prd.sh` routes `finish` to it, with a usage line. One bullet in `loops/docs/recovery.md`.

**Acceptance criteria:**

- Unit test (new `loops/finish.test.mjs`) of `finishDecision`: not landed → running; landed with no worktree, slot or open row → clean; a recorded session with a running call, or an event 5 minutes ago → wait; a landing journal → wait; idle recorded sessions and a docs tail → act, ending both; a code tail → report, then nothing on the same tip once reported, and a report on a new tip; a dirty worktree, a slice worktree left, an unrecorded claude in the worktree, and a recorded live session with no heartbeat record → each a report with no session ended; landed with no worktree but the row not done → a report naming the `prd set` line, never `act`; a `standing` row → running.
- Unit test (same file) of `liveIn` on a stub process table and `cwdOf`: a claude in the worktree, one in a subfolder, one elsewhere, and a non-claude process in the worktree → only the first two. Of `landedWithCode` on a temp repo: a topic landed with a code (.mjs) commit past it is in it; one with only Markdown past it, and one never landed, are not.
- Script test (new `loops/finish-cli.test.mjs`, after `tidy-cli.test.mjs`): a temp repo whose `prd/<t>` landed in the trunk with a Markdown commit past it, a worktree and an idle stub session record → `finish <t>` ends the stub (its `end` recorded), removes the worktree, marks the row done and files one report; with a code (.mjs) commit past the landing, or an uncommitted file, it ends nothing, keeps the worktree and branch and files one report naming why; `--dry-run` prints the decision and changes nothing.

**Blocked by:** nothing. **Blocks:** 3, 4.

## Slice 2: The cost parser and its CLI

Stack: no · Reads: none · Tests: unit · Blocked by: none · Check: loops/cost.test.mjs

**User stories:** US 7, 8.

**Build:** a new `loops/cost.mjs` (PRD _Implementation decisions_, _The cost record_): pure `parseTranscript(text, { file, worktree, meta })` (assistant messages by `message.id`: model and `usage` input, output, cache read, cache write; malformed lines counted), `attribute(rows, topic)` (a `plan-<topic>` worktree → planning; a subagent whose meta.json description matches `slice\s*(\d+)` → that slice; else whose first user prompt names `.loops/<topic>-<n>` → that slice; else orchestration), `mergeRows(...lists)` (one row per message id, the last wins) and `summarise(rows)` (per line and total, tokens by model). The CLI: `node loops/cost.mjs report [<topic>] [--json]` reads the projects folders of the topic's worktrees (Claude Code's encoding of `<main>/.loops/<name>`: every `/` and `.` as `-`) under `RISA_CLAUDE_PROJECTS`, else `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`, each session's `subagents/agent-*.jsonl` with its meta.json, and the ledger `.loops/.cost/<topic>.json`, and prints the table (no topic: one total line per topic it finds); `node loops/cost.mjs ledger <topic>` merges what's on disk into the ledger (a temp file, then rename).

**Acceptance criteria:**

- Unit test (new `loops/cost.test.mjs`): one message streamed over three lines counts once; the same message id in a session and its `--continue` copy counts once; a subagent attributed by description, by prompt, and by neither (orchestration); a `plan-` transcript is planning; malformed lines are counted and skipped; `mergeRows` of a ledger and newer transcripts keeps one row per id; `summarise` totals by model.
- Script test (same file, temp projects folder through `RISA_CLAUDE_PROJECTS`): `report <t> --json` gives the fixture's per-slice and total counts; after `ledger <t>` and deleting the transcripts, `report <t>` gives the same numbers.

**Blocked by:** nothing. **Blocks:** 5.

## Slice 3: The dispatcher finishes landed topics

Stack: no · Reads: loops/docs/recovery.md · Tests: unit · Blocked by: 1 · Check: loops/finish-tick.test.mjs

**User stories:** US 1, 2.

**Build:** slice 1's new `loops/finish.mjs` gains the pure `finishPick(candidates)`: each candidate a non-standing topic in `landedTopics` or `landedWithCode` with a worktree, a slot or a row not done, with its `finishDecision`; the first in row order whose decision is `act` or a `report` not yet filed, passing over the ones that `wait` or whose report is filed; none while paused or draining. `loops/dispatch.mjs` gets a new step, finishStep, after the pick: it computes both sets for the candidates it already gathers, leaves standing rows out, gathers each candidate's facts with `gatherFinish` (the dispatcher's `finish.reported` state as `reported`), decides each, picks, acts as the CLI does (or, with `--dry-run`, prints `finish: would …`), and writes each report key it filed to `finish.reported`. The `loops/docs/recovery.md` bullet from slice 1 says the dispatcher runs it.

**Acceptance criteria:**

- Unit test (new `loops/finish-tick.test.mjs`) of `finishPick`: two landed topics with leftovers → the first in row order; a clean one is skipped; a code-tail topic is picked once, then passed over once its report is filed; a first topic that waits and a second that acts → the second; a standing topic is never a candidate; paused or draining → none.
- Unit test (same file) of `finishStep` through `dispatch.mjs` on a temp main checkout (the env the dispatcher reads, set by the test): `--dry-run` with a landed topic and an idle stub session prints one `finish: would end …, rm …` line; a topic landed with a code (.mjs) commit past it files one report on the first tick and none on the second (`finish.reported` holds its key), and its worktree stays.

**Blocked by:** 1. **Blocks:** 6.

## Slice 4: Tidy names landed leftovers and duplicate sessions

Stack: no · Reads: loops/docs/machinery.md · Tests: unit · Blocked by: 1 · Check: loops/tidy.test.mjs

**User stories:** US 5.

**Build:** `loops/tidy.mjs` `tidy` gains two ask findings: a non-standing topic in `landedTopics` or `landedWithCode` with a worktree or a row not done while no dispatcher runs (`finish <topic>` named as the fix), and a topic with more than one live claude across its worktrees (the pids and their worktrees). `loops/tidy-cli.mjs` gathers both (from landed.mjs, finish.mjs and sessions.mjs: landedTopics, landedWithCode, liveIn; and the dispatcher's lock).

**Acceptance criteria:**

- Unit test (`loops/tidy.test.mjs`): a landed topic with a worktree and no dispatcher → one ask naming `finish <topic>`; the same with the dispatcher running → none; a code-tail topic → one ask; a standing topic whose wave landed with nothing past it → none; two live claudes in one topic's worktrees → one ask naming both pids; one live claude → none.

**Blocked by:** 1. **Blocks:** nothing.

## Slice 5: `risa cost`, and `rm` keeps the ledger

Stack: no · Reads: loops/docs/machinery.md · Tests: unit · Blocked by: 2 · Check: loops/rm-ledger.test.mjs

**User stories:** US 7, 8.

**Build:** `loops/prd.sh` routes a new command, cost, to `node cost.mjs report`, with a usage line. `loops/rm.sh` runs `node cost.mjs ledger <topic>` for a `prd/` or `plan/` worktree before it removes anything; a failure prints `cost ledger: <why> (rm goes on)` and `rm` carries on. One bullet in `loops/docs/machinery.md` for the cost command, its budget in `loops/docs-budget.mjs` raised by what it adds.

**Acceptance criteria:**

- Script test (new `loops/rm-ledger.test.mjs`, after `stack.test.mjs`'s rm fixtures): `rm` of a temp `prd/<t>` worktree with a fixture transcript under `RISA_CLAUDE_PROJECTS` leaves `.loops/.cost/<t>.json` with its rows; with the ledger folder unwritable it prints the one line and still removes the worktree (exit 0).
- Script test (same file): `risa cost <t> --json` in that fixture prints the ledger's totals after the transcripts are gone.
- `pnpm docs:budget` passes.

**Blocked by:** 2. **Blocks:** nothing.

## Slice 6: A dead landing journal's held resume files one report

Stack: no · Reads: loops/docs/recovery.md · Tests: unit · Blocked by: 3 · Check: loops/resume.test.mjs

**User stories:** US 6.

**Build:** `loops/resume.mjs` `resumeDecision` takes `journals` (`{ session, branch, started, live }`) beside `landing`: a claim held by a journal whose pid is dead gets one report (`reports`: `{ session, text }`, naming the session, the branch and `risa land --resume <branch>`) and the claim records `journalReported` (branch and start), so the same journal is never reported again; a live journal stays a waits line; a new journal for the branch reports again. `loops/dispatch.mjs` `resumePrep` builds `journals` from `listLandings` and the pid check it already does, files each report through the asks queue (or prints `resume: would report …` on `--dry-run`) and writes the claim's field. The resume bullet in `loops/docs/recovery.md` says so.

**Acceptance criteria:**

- Unit test (`loops/resume.test.mjs`): a claim held by a dead journal → one report naming `land --resume prd/<t>` and `journalReported` set; the next tick with that claim → a waits line and no report; a live journal → a waits line only; a new journal (another start) → a report again.
- `risa check --quick "slice hand-off"` passes with `loops/dispatch.test.mjs` unchanged.

**Blocked by:** 3. **Blocks:** nothing.
