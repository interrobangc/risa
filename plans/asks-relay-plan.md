# Plan: asks-relay

> Source PRD: [`plans/asks-relay-prd.md`](asks-relay-prd.md). User-story numbers (US) refer to it. Items RISA-467, RISA-429. Topic `asks-relay`.

## Status

| Slice | Wave | State | Merge into `prd/asks-relay` |
| ----- | ---- | ----- | --------------------------- |
| 1     | 1    | —     | —                           |
| 2     | 1    | —     | —                           |
| 3     | 2    | —     | —                           |
| 4     | 3    | —     | —                           |
| 5     | 3    | —     | —                           |
| 6     | 4    | —     | —                           |
| 7     | 5    | —     | —                           |

**Backlog:** claim each slice's items as it starts. Slices 1, 2, 3, 5, 6 and 7: RISA-467 (`done` after 7). Slice 4: RISA-429 (`done` when it merges).

## Architectural decisions

- **Tooling only:** `loops/`, their tests, the golden prompt file. No new dependency, no `risa.json` key; new environment knobs only (`RISA_ASK_RELAY_MIN`, `RISA_ASK_IDLE_MIN`, both default 10).
- **Additive asks:** every new ask field is optional; an ask filed before this topic reads as `blocks: now`, never relayed, never pushed. With no live backlog session every command prints and pushes exactly as today, so a project without one sees no change.
- **Pure decisions, thin CLIs:** `rankAsks`, `relayPlan` and `fallbackPushes` in `loops/asks.mjs` take gathered facts (`{ sessions: [{ name, kind, topic, live }], rows: [{ topic, after }], promptAt, now }`); `loops/ask.mjs` and `loops/dispatch.mjs` gather them (sessions.mjs `readRecords`, `processTable`, `isLive`; `backlog/registry.mjs` `parseRegistry` on the config's backlog path, as `loops/cost.mjs` reads it; heartbeat.mjs for `promptAt`).
- **Where the facts come from in a real run:** `loops/prd.sh` passes `ask.mjs` only `RISA_ASKS_DIR` (the main checkout's `.loops/.asks`, from any worktree). New `factsPaths(asksDir, env)` in `loops/asks.mjs` (slice 1) derives the rest from it: the sessions folder `RISA_SESSIONS_DIR`, else the asks folder's sibling `.sessions`; the heartbeat folder from that (heartbeat.mjs `heartbeatDirOf`); the main checkout as the asks folder's grandparent, whose config names the backlog file for the registry. No slice needs `prd.sh` for this, and each command's tests include a run with `RISA_SESSIONS_DIR` unset.
- **Every write under the ask's lock** (`withAskLock`), as answering and settling do: marking relayed or pushed, expiring, archiving.
- **Attended sessions file asks only while a go-between is live** (the user's answer, a49): with none, they ask in their tab as today, so a project with no backlog session sees no change.
- **No role doc grows:** the go-between's rules live in the backlog prompt; each module's header comment documents its commands. The backlog role doc has no room (3052 of 3072 bytes).
- **Hermetic tests:** every test names its asks, sessions and heartbeat folders (`RISA_ASKS_DIR`, `RISA_SESSIONS_DIR`) and a stub process table; none reads the real `.loops`.

## How to run this plan

- **Waves:** wave 1 runs slices 1 and 2 (no shared file). Wave 2 is slice 3 (after 1 and 2: it builds on both and changes `loops/asks.mjs` and `loops/ask.mjs`). Wave 3 runs slices 4 and 5 (both after 3; 4 owns `loops/asks.mjs` and `loops/dispatch.mjs`, 5 owns `loops/prompts/backlog.sh` and `loops/prompts/shared.sh`). Wave 4 is slice 6 and wave 5 is slice 7 (each after the one before: 5, 6 and 7 all change `loops/prompt.test.mjs` and regenerate the golden file).
- **Gate:** `risa check --quick "slice hand-off"` before each hand-off; `pnpm check` once on the merged tip at landing.
- **Other topics:** `fixes-bug` holds `loops/ask.mjs`, `loops/prompts/backlog.sh`, `loops/prompt.test.mjs` and `loops/docs`; `risa-next-2` holds `loops/dispatch` and `loops/prd.sh`. Slices 1, 3, 5, 6 and 7 touch only `fixes-bug`'s; slice 4 only `risa-next-2`'s (`loops/dispatch.mjs`, `loops/prd.sh`); slice 2 neither. The dispatcher starts this topic only when no running topic shares a hot prefix. At each wave boundary read `risa backlog prd list`; no slice starts that would touch two running topics' hot files.
- **Prompt slices** regenerate `loops/sample-project/prompt-golden.txt` the way `loops/prompt-golden.test.mjs` says, and read the diff before committing it.

## Slice 1: The asker states how blocking; `risa asks` ranks

Stack: no · Reads: none · Tests: unit · Blocked by: none · Check: loops/asks.test.mjs

**User stories:** US 2, 3.

**Build:** PRD _Implementation decisions_, _The ask's new fields_ and _Ranking_. In `loops/asks.mjs`: `createAsk` and `validateAsk` take `blocks` (`now`, `soon`, `no`; a question only, default `now`; a report has none) and store it with `relay: null`, `relayedAt: null`, `pushedAt: null`, `pushedBy: null`; a pure `blocksOf(ask)` reads `now` for an old ask with no field. New pure `rankAsks(asks, facts)`: each listed ask with `{ urgency, reasons }` (raised to `now` when the asker's session is a live `prd` one, reason `holds a slot`; or a row's `after` names its topic, reason `<topic> waits on it`; a non-dispatcher asker whose record isn't live gets `its session has ended`), ordered as the PRD says. `formatAsks` takes the ranked list and shows each question's urgency and reasons on its first line; `formatAsksShort` is unchanged. In `loops/ask.mjs`: `--blocks <now|soon|no>` on `ask` (refused on a report or with another value); `asks` and `asks --json` gather the facts through `factsPaths` (sessions, heartbeats and registry, each optional: a missing folder or backlog file gives none) and list ranked; a question whose asker's session has an `ask --wait <its id>` process under its pid in the process table (sessions.mjs `processTable`, as `loops/dispatch-stuck.mjs` finds a session's commands: a background wait leaves no heartbeat `running` entry) is raised to `now` with reason `its session waits on it`; the header comment names `--blocks` and the ranking.

**Acceptance criteria:**

- Unit test (`loops/asks.test.mjs`): `createAsk` stores `blocks` (default `now`), refuses it on a report and refuses `later`; an ask file without the field reads `now`; `rankAsks` orders a `no`, a `soon` and a `now` question; a `soon` question from a live `prd-x` session ranks as `now` with `holds a slot`; a `no` question on topic `t` with a row `after: [t]` ranks `now` with `t2 waits on it`; a `soon` question whose asker's pid has a child `node ask.mjs ask --wait a1` in a stub process table ranks `now` with `its session waits on it`; a question whose asker's record is dead reads `its session has ended`; `factsPaths` on `<tmp>/.loops/.asks` with `RISA_SESSIONS_DIR` unset gives `<tmp>/.loops/.sessions`, `<tmp>/.loops/.heartbeat` and `<tmp>`; ties go oldest first; reports after questions, decided ones last; `formatAsks` prints urgency and reasons.
- The existing `loops/ask.test.mjs` passes unchanged (one question, or several of one urgency, still lists oldest first).

**Blocked by:** nothing. **Blocks:** 3.

## Slice 2: The heartbeat records the user's prompts

Stack: no · Reads: none · Tests: unit · Blocked by: none · Check: loops/heartbeat.test.mjs

**User stories:** US 4.

**Build:** PRD _Implementation decisions_, _The go-between_. `loops/context-settings.json` gains a new UserPromptSubmit hook running the same `context.mjs hook` line. `loops/heartbeat.mjs`: `heartbeatEvent` maps `UserPromptSubmit` to a prompt event; `applyHeartbeat` stores `promptAt` (its time) on the session's own record only (a subagent never gets one), copied forward by every later event (the record is rebuilt from a fixed field list, so `promptAt` joins it) and never taken as a stop (the event gets its own branch, not the stop `else`), changing nothing else; a PostToolUse of AskUserQuestion on the session's own record also sets it (the user answering a relayed poll is active); and only for a prompt a person typed: the slice first checks what Claude Code's `UserPromptSubmit` input carries for a task notification, a background command's wake-up and a SendMessage from another session, and ignores each (no `promptAt`), by its prompt text if nothing else tells them apart (one that opens with a `<task-notification>`, `<agent-message` or other system tag); `host.mjs` `claudeInput` passes the prompt text through if it doesn't already; new exported `lastPrompt(heartbeatDir, sessions)` returns the newest `promptAt` among the named sessions' records whose pid is live (else null). Check `loops/context.mjs` `hook` lets the event reach the heartbeat and stays silent for it (it sizes only PostToolUse); change it only if it doesn't. The header comment names the new event and field.

**Acceptance criteria:**

- Unit test (`loops/heartbeat.test.mjs`): a `UserPromptSubmit` input sets `promptAt` on the session record and leaves `running`, `lastStart` and `stoppedAt` as they were; a subagent's input sets none; a prompt that is a task notification, and one that is another session's message, set none; a PreToolUse after a prompt keeps `promptAt` and `stoppedAt` unchanged; an AskUserQuestion PostToolUse sets it; `lastPrompt` over two backlog sessions returns the newer live one's and skips a record whose pid is stale; no records gives null.
- A test reads `loops/context-settings.json` and finds the new UserPromptSubmit hook with the context hook's command.

**Blocked by:** nothing. **Blocks:** 3.

## Slice 3: The relay commands, and the asker's fallback

Stack: no · Reads: none · Tests: unit · Blocked by: 1, 2 · Check: loops/ask.test.mjs

**User stories:** US 1, 5, 6, 7, 12.

**Build:** PRD _Implementation decisions_, _The go-between_ and _Commands_. `loops/asks.mjs`: new pure `goBetweenLive(facts)` (a live `backlog` kind record), `relayDue(ask, now, relayMin)` (an awaiting question with `relay: expected`, not relayed and not pushed, `relayMin` minutes past `askedAt`), `relayPlan(asks, facts, now, { idleMin })` (rankAsks' awaiting questions not yet relayed, each with `push` as the PRD says and never for one with `pushedAt` set: an asker that pushed at filing, under a backlog session with no record such as a hand-opened one, isn't pushed twice; then the reports as a digest), and `fallbackPushes(asks, facts, now, { relayMin })` (the PRD's _The dispatcher's fallback_; slice 4 calls it); `markRelayed(dir, id, { pushed, now })` and `markPushed(dir, id, by, { now })` under the ask's lock. `loops/ask.mjs`: `ask --question` reads the sessions and records `relay: expected` with the relay line when a go-between is live, else the push line as today with `pushedAt` and `pushedBy: asker`; `--wait` exits 76 on `relayDue` (`RISA_ASK_RELAY_MIN`, default 10), printing `Now send a PushNotification: …` and `Then run --wait <id> again.`, and marks it pushed by the asker first; `asks --relay [--json]` (`RISA_ASK_IDLE_MIN`, default 10, against heartbeat.mjs `lastPrompt` of the live backlog sessions); `asks --relayed <id> [--pushed]`; `asks --go-between` (prints `live` or `none`, from `goBetweenLive`); `asks --watch` (polls every `RISA_ASK_POLL` seconds; exits 0 printing the ids of awaiting questions not relayed that it hadn't seen at start, or that turned `relayDue`). The header comment documents each.

**Acceptance criteria:**

- Script test (`loops/ask.test.mjs`): with no live backlog record, a question prints the push line as today; with a live one (a temp sessions folder whose record's pid is the test's own), it prints the relay line and no push line, and the stored ask has `relay: expected`; both with `RISA_SESSIONS_DIR` unset (the sessions folder beside the asks one); `--wait` on it with `RISA_ASK_RELAY_MIN=0` exits 76 with the push line, and a second `--wait` keeps waiting (times out 75 under `--timeout 1`); `asks --relayed a1 --pushed` sets both stamps and a second `--wait` past the relay time doesn't exit 76; `asks --relay --json` marks a `now` question `push: true` with no heartbeat prompt and `push: false` with a fresh `promptAt`, and a `soon` one never; `asks --go-between` prints `live` and `none` for the two cases; `asks --watch` exits printing `a2` once a second question is filed; `fallbackPushes` picks a dead asker's unpushed question only with no live go-between or once the relay is overdue, and never the dispatcher's own.
- The existing push-line tests pass with no backlog record.

**Blocked by:** 1, 2. **Blocks:** 4, 5.

## Slice 4: The dispatcher pushes for dead askers; old asks are archived

Stack: no · Reads: none · Tests: unit · Blocked by: 3 · Check: loops/dispatch.test.mjs

**User stories:** US 8, 10, 11.

**Build:** PRD _Implementation decisions_, _The dispatcher's fallback_ and _Hygiene_. `loops/asks.mjs`: `idNumbers` counts `archive/` too; `getAsk` falls back to `archive/<id>.json`; new `archiveAsks(dir, { now })` (expire reports over 3 days old, then move each unlisted ask whose last stamp (`answeredAt`, `doneAt`) is over a day old, under its lock, temp file then rename); `listAsks({ all })` includes the archive; `formatAsks` marks a report over a day old `(re-check against risa status)`. `loops/dispatch.mjs`: beside `settleDue` in the tick, run `archiveAsks` and, from the gathered sessions, `fallbackPushes`; push each through the existing helper (`helperLine`, one helper for all of them, its line listing each) and `markPushed(…, "dispatcher")`; its own asks skip the helper while `goBetweenLive` and get it once `relayDue`. The header comment names both steps. `loops/prd.sh`'s help (the _Asks_ lines): `--blocks`, the relay line, `--wait`'s exit 76, `asks --relay`, `--relayed` and `--watch` (the same running topic's hot prefix as `loops/dispatch.mjs`).

**Acceptance criteria:**

- Tick test (`loops/dispatch.test.mjs`): a question from a dead `plan-x` session, unpushed, with no live backlog record, makes one helper start whose line holds its text and is marked `pushedBy: dispatcher`; the next tick starts none for it; with a live backlog record and the question 5 minutes old, no helper; at 11 minutes, the helper; the dispatcher's own reopen ask starts no helper while a backlog record is live; an answered ask 25 hours old moves to `archive/`, `getAsk` still returns it, and the next `createAsk` takes a higher id; a report 4 days old is dismissed and archived; a defaulted ask still listed stays.
- The existing own-ask push tests pass with no backlog record.
- `risa help` names `--blocks`, `asks --relay`, `--relayed`, `--watch` and exit 76 (the hand-off shows the lines; the existing help test in `loops/ask.test.mjs` still passes).

**Blocked by:** 3. **Blocks:** nothing.

## Slice 5: The backlog session relays every question

Stack: no · Reads: none · Tests: unit · Blocked by: 3 · Check: loops/prompt.test.mjs

**User stories:** US 1, 3, 4, 5, 6, 9.

**Build:** PRD _Implementation decisions_, _Prompts_ (the backlog session). `loops/prompts/backlog.sh`: the main prompt (both openings) gains the go-between line after the `asks --short` one: read `risa asks --relay`; with questions open, the opening poll (or, after a brief, one AskUserQuestion) first asks whether the user is free to answer them now, and relays them at once on yes or at the next pause on no; keep one `risa asks --watch` running in the background and start it again each time it exits; relay each question verbatim (text, options in order, the recommendation marked) in AskUserQuestion, blocked-now first, the rest batched into the next poll; `risa answer <id> <option>` then `risa asks --relayed <id>`; a PushNotification only for a question `--relay` marks push, with its push line, then `--relayed <id> --pushed`; a question preferences or an earlier answer settles is a one-tap confirm naming that source; never answer for the user; reports as a digest, never pushed. The `--guide`'s catch-up reads `--relay` instead of the full `asks`. `loops/prompts/shared.sh` `default_rule`: an asker states `--blocks`, and on `--wait`'s exit 76 sends the line it prints and runs `--wait` again. Regenerate the golden file.

**Acceptance criteria:**

- Unit test (`loops/prompt.test.mjs`): both backlog openings contain `asks --relay`, the free-to-answer question, `asks --watch` in the background, `asks --relayed`, the push-only-when-marked rule and "never answer for the user"; the `--guide` names `asks --relay`; an `--auto` planner's and a run-through orchestrator's prompt name `--blocks` and the exit-76 rule.
- `loops/prompt-golden.test.mjs` passes on the regenerated golden file.

**Blocked by:** 3. **Blocks:** 6.

## Slice 6: An attended planner files its questions while a backlog session is live

Stack: no · Reads: docs/planner.md · Tests: unit · Blocked by: 5 · Check: loops/prompt.test.mjs

**User stories:** US 12.

**Build:** PRD _Implementation decisions_, _Prompts_ (every other role). `loops/prompts/plan.sh`: the attended `ask_line` first runs `risa asks --go-between` (slice 3); on `live` it files its one round as `risa ask` questions past the skeptic (`$skeptic_rule`, `$default_rule`) and waits in the background, with no AskUserQuestion; on `none` it asks its one AskUserQuestion round in its tab as today. The attended `second_send_back` does the same: on `live` it holds the row and files a `--waits` question as the `--auto` one does, else AskUserQuestion. `loops/docs/planner.md` _The skeptic pass_ ("Attended: AskUserQuestion") and `docs/planner.md` _What to ask_ ("Ask in **one** AskUserQuestion round") say the same in no more bytes than today (the docs budget). Regenerate the golden file.

**Acceptance criteria:**

- Unit test (`loops/prompt.test.mjs`): the plain planner's prompt names `asks --go-between`, files with `risa ask --topic` and `--skeptic` on live, and keeps the AskUserQuestion round on none; its second send-back names both forms; the existing plain-planner and second-send-back assertions are rewritten to match.
- `loops/prompt-golden.test.mjs` and the docs budget (`node loops/docs-budget.mjs`) pass.

**Blocked by:** 5. **Blocks:** 7.

## Slice 7: Attended orchestrators and hotfixes file theirs too

Stack: no · Reads: none · Tests: unit · Blocked by: 6 · Check: loops/prompt.test.mjs

**User stories:** US 12.

**Build:** PRD _Implementation decisions_, _Prompts_ (every other role). `loops/prompts/orchestrator.sh`: the attended landing-mode question, `stall_ask` and the attended asking lines run `risa asks --go-between` first and, on `live`, file and wait as slice 6's planner does; on `none`, AskUserQuestion as today. `loops/prompts/hotfix.sh`: a judgement call follows the same rule. `loops/docs/hotfix.md` (_Talk it through first_) says so in no more bytes. Afterwards no prompt but the backlog and inbox ones uses AskUserQuestion while a backlog session is live. Regenerate the golden file.

**Acceptance criteria:**

- Unit test (`loops/prompt.test.mjs`): the attended orchestrator (both landing-mode paths) and the hotfix prompts name `asks --go-between`, the filed form with `--skeptic`, and the AskUserQuestion fallback on none; the existing landing-mode and stall assertions are rewritten to match.
- `loops/prompt-golden.test.mjs` and the docs budget pass.

**Blocked by:** 6. **Blocks:** nothing.
