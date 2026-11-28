# Plan: fixes-bug

> Risa's standing fix topic for wrong behaviour or data. No PRD: this plan is the whole spec. One slice per backlog item, appended at each wave boundary; every slice reads [`plans/fixes-rules.md`](fixes-rules.md).

## Status

**From the user:** (none yet)

**Landing mode:** run everything through (started run-through; land each green wave without asking, ask only real questions).

| Slice | Wave | Item            | Model  | State   | Merge into `prd/fixes-bug` |
| ----- | ---- | --------------- | ------ | ------- | -------------------------- |
| 1     | 1    | RISA-241        | opus   | merged  | 5155c24                    |
| 2     | 1    | RISA-980        | opus   | merged  | 1e9259e                    |
| 3     | 1    | RISA-991        | opus   | merged  | 8316198                    |
| 4     | 1    | RISA-1001 (1/2) | opus   | merged  | c5163aa                    |
| 5     | 1    | RISA-1001 (2/2) | opus   | merged  | 3697271                    |
| 6     | 2    | RISA-1023       | opus   | merged  | e29fab7                    |
| 7     | 2    | RISA-1024       | sonnet | merged  | cf93d26                    |
| 8     | 2    | RISA-1039       | opus   | merged  | 9f14e04                    |
| 9     | 2    | RISA-1049       | opus   | merged  | c0751bb                    |
| 10    | 3    | RISA-1061       | opus   | merged  | fcb1dd3                    |
| 11    | 3    | RISA-1063       | opus   | merged  | 6e331aa                    |
| 12    | 4    | RISA-1064       | opus   | started |                            |
| 13    | 4    | RISA-1065       | opus   | merged  | 47c911a                    |

**Wave 1** (slices 1–5, RISA-241/980/991/1001): landed 2026-11-28 in main as 3598122 (PR #13, tier none). RISA-985 closed at triage (a489eef already fixed it).

**Wave 2** (slices 6–9, RISA-1023/1024/1039/1049): landed 2026-11-28 in main as 5767dfb (PR #27, tier unit, run 46154596385); Codex's P2 (CI fetches no tags) is RISA-1054 (fixes-tooling). Caretook's backlog session told 5767dfb has RISA-1049.

**Wave 3** (slices 10–11, both opus), 2026-11-28, fresh session: ingest had nothing new. RISA-1057–1060 moved to risa-next-2 (no longer ours). RISA-1061 (loops/context.mjs) and RISA-1063 (loops/captain.mjs, flavor.mjs, cross-repo session records) are clear of running hot files; RISA-1050 still waits (`loops/dispatch`, hot for risa-next-2). Hot set: loops/context, loops/captain, loops/flavor, loops/sessions, loops/machine.mjs. Items claimed; slices 10–11 started (worktrees `.loops/fixes-bug-<n>`, one opus agent each). Slice 13 handed off (30e3f26: quiet is the start load alone; judged and unjudged local lines name both loads; also loops/check-run.sh comment and check-run.test.mjs expectations, added to hot); merged (47c911a). Slice 12 handed off (b7c1d48: session.sh calls the new `session-names.mjs start`, which returns display and persona from one draw, and passes `persona=` to the first record's `sessions.mjs set`; `keptPersona` in captain.mjs) and merged (a04752b). `risa tier`: none, gate `risa check` green on 116704e (2567 tests). Sync: no merge needed. Slice worktrees removed. PR #33: Codex clean on a8dcd17. **Landed** 2026-11-28 in main as acb0975 (tier none, unsynced tip: main's 4 commits shared no file); to-test file `to-test/2026-11-28-1123-fixes-bug.md`; report filed. Slice 10 handed off (fb28d13: hint is `cd <main> && <toolCmd.prd> rotate --self`; loops/prompts/shared.sh:45 builds its own form, left as is) and merged (fcb1dd3). Slice 11 handed off (7135a2a: `machineHeld` in captain.mjs reads every machine repo's live records; `personaFor`/`drawAdmiral` take `held`; a stepped persona is kept in the session record's `persona`; also edited loops/session-names.mjs `personaOf`, added to hot) and merged (6e331aa). `risa tier`: none (tooling only), so the gate is `risa check`: green on 0d6ee37 (2543 tests). Synced main (4142eb2; session-names.mjs import conflict with fixes-nit's RISA-1019 refactor, kept both); `pnpm test` green on the synced tip. Slice worktrees removed. PR #30: one Codex P2 (a fresh session's stepped persona isn't kept in its first record), tracked as RISA-1064 (fixes-bug, triaged), thread resolved; Codex clean on 9959f75. **Landed** 2026-11-28 in main as 6f1daaa (tier none, unsynced tip: main's 1 commit shared no file); to-test file `to-test/2026-11-28-1045-fixes-bug.md`; report filed.

**Wave 4** (slices 12–13, both opus), 2026-11-28, fresh session: ingest had nothing new. RISA-1064 (loops/captain, loops/session.sh) and RISA-1065 (loops/time-gate) clear of risa-next-2's hot files; RISA-1050 still waits (`loops/dispatch`). Hot set: loops/captain, loops/session, loops/time-gate, loops/docs. Items claimed; slices 12–13 started (worktrees `.loops/fixes-bug-<n>`, one opus agent each). Slice 13 handed off (30e3f26: quiet is the start load alone; judged and unjudged local lines name both loads; also loops/check-run.sh comment and check-run.test.mjs expectations, added to hot); merged (47c911a). Slice 12 handed off (b7c1d48: session.sh calls the new `session-names.mjs start`, which returns display and persona from one draw, and passes `persona=` to the first record's `sessions.mjs set`; `keptPersona` in captain.mjs) and merged (a04752b). `risa tier`: none, gate `risa check` green on 116704e (2567 tests). Sync: no merge needed. Slice worktrees removed. PR #33: Codex clean on a8dcd17. **Landed** 2026-11-28 in main as acb0975 (tier none, unsynced tip: main's 4 commits shared no file); to-test file `to-test/2026-11-28-1123-fixes-bug.md`; report filed.

**For the next session:** first run `risa backlog prd list`. Only RISA-1050 waits (needs `loops/dispatch`, hot for risa-next-2 through its wave 4); start it once dispatch frees. When RISA-1050 ships, tell Caretook's backlog session the commit (its note asks). When a tagged release carries RISA-1065 (acb0975), tell Caretook's backlog session and prd-test-time-gates-2 (its note asks). The slice gate is `risa check` with no argument (only `--quick "<why>"` takes one).

## How to run this plan

- **Gate:** `risa check --quick "slice hand-off"` before each hand-off; the wave's CI run on the merged tip at landing (plans/fixes-rules.md).
- **Hot files:** a fix touching a running topic's hot files (`risa backlog prd list`) waits for a later wave.
- **Commit the plan before `risa slice`:** a slice branch takes the committed plan.

## Slice 1: A review with more threads or comments than one page doesn't read as clean

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/codex-review.test.mjs

**Build (RISA-241):** `PR_QUERY` (`loops/codex-review.mjs`) reads `reviewThreads(first: 100)` and `comments(first: 50)`, so on a PR with more an unresolved thread or a later Codex comment can go unseen and the PR reads as clean. Ask for `pageInfo { hasNextPage }` on both connections, and when either has another page, either fetch the rest (the caller in `loops/review.sh` that runs the query) or refuse a clean verdict with a line saying the review is too long to read whole. Pick the simpler of the two that stays correct and say why in the hand-off. A refusal must never read as clean.

**Acceptance criteria:**

- Unit test (`loops/codex-review.test.mjs`, a fixture in `loops/codex-review.fixtures`): a PR whose threads (or a thread's comments) report `hasNextPage: true` doesn't read as clean; one with every page read does as before.

## Slice 2: Backlog ingest's inbox pickup runs under a release install

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: backlog/origin.test.mjs

**Build (RISA-980):** `pickup()` (`backlog/backlog.mjs`) skips unless this script's `loops/lib.sh` belongs to the same main checkout as the project (`mainCheckout`). Under a release install (`~/.risa/releases/<tag>/`, a worktree of Risa's own repo) it never does, so a project that installs Risa never picks up its inbox: "pickup skipped: …/lib.sh belongs to another checkout than <project>". The check is there so a run against another repository never moves this one's dev. Keep that guarantee but let the release's lib.sh run `dev_sync` on the project's checkout: what must match is the checkout `dev_sync` acts on and the project's config (`RISA_CONFIG` / `RISA_MAIN`), not where lib.sh lives. Read how `bin/risa` picks the main checkout and reuse that; say in the hand-off what the check compares now.

**Acceptance criteria:**

- Unit test (`backlog/origin.test.mjs`): with the backlog script run from a second git repo (standing in for a release worktree) against a project checkout, ingest runs the pickup on the project and not on the script's repo; a run whose config names another project still skips.

## Slice 3: risa stack down does nothing in a repo with no stack hooks

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/stack.test.mjs

**Build (RISA-991):** `risa stack down` (`loops/stack.sh`, the `down` case) calls `stack_hook stackDown` unconditionally, so a repo with no stack hooks dies "risa.json: no value for hooks.stackDown"; a slice's hand-off step runs it. As `slot_busy` does for stackStatus (RISA-985, `loops/stack-lib.sh`) and `rm.sh` does with `has_hook stackDown`: with no stackDown hook, release the slot lease if there is one and print "<name> has no stack", exit 0. Check `status` and `ready` in the same file for the same fault and give them the same treatment (a quiet "no stack hooks" line, exit 0).

**Acceptance criteria:**

- Unit test (`loops/stack.test.mjs`): in a fixture project with no stack hooks, `stack down` exits 0 with "has no stack" and frees a leased slot; with hooks it runs them as before.

## Slice 4: Internal backlog calls take the same config as bin/risa (1/2: the helper, pr and ready)

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/pr.test.mjs

**Build (RISA-1001, part 1):** the loop scripts run `node …/backlog/backlog.mjs` directly, so since RISA-972 they read the worktree's `risa.json`, bypassing the choice `bin/risa` makes (the machine's listed main checkout's config, unless `RISA_CONFIG` is a pin). A worktree whose config changes paths.backlog reads another file or fails (`risa ready`: missing backlog; Codex reproduced it with paths.backlog set to plans/new-backlog.md). Add one helper in `loops/lib.sh` (say `backlog_cmd`) that runs backlog.mjs with the config `bin/risa` would choose, keeping a `RISA_CONFIG` pin; share the selection with `bin/risa` rather than copying it, without changing what it chooses. Route lib.sh's own call and those in `loops/pr.sh` and `loops/ready.sh` through it.

**Acceptance criteria:**

- Unit test (`loops/pr.test.mjs`, or a new `loops/backlog-cmd.test.mjs`): in a temp project whose worktree config names another paths.backlog, the helper reads the main checkout's backlog; with `RISA_CONFIG` pinned it reads the pin's.

## Slice 5: Internal backlog calls take the same config as bin/risa (2/2: land and rm)

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: 4 · Check: loops/land.test.mjs

**Build (RISA-1001, part 2):** route the backlog.mjs calls in `loops/land.sh` and `loops/rm.sh` through slice 4's `lib.sh` helper (`backlog_run`, over `loops/backlog-config.sh`), dropping their own `cd "$main"` wrappers where the helper covers them, so no loop script calls backlog.mjs directly: ls.sh and rotate.sh have one call each too. rm.sh re-points `RISA_CONFIG` itself; keep what that is for.

**Acceptance criteria:**

- Unit test (`loops/land.test.mjs`): a topic's worktree whose config names another paths.backlog still marks the main checkout's registry row (land's flags, rm's done) and reads its items.

## Slice 6: status-trim runs under a release install

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/status-trim.test.mjs

**Build (RISA-1023):** `format()` (`loops/status-trim.mjs`) does `await import("prettier")`, a dev dependency; a release folder (`~/.risa/releases/<tag>/`) has no `node_modules`, so `risa status-trim` dies with ERR_MODULE_NOT_FOUND. Resolve prettier from the project's checkout (the plan file's repo, via `createRequire` on a path inside it), and when it can't be found there either, write the text unformatted and print one line saying formatting was skipped. Exit status and the trimmed content stay the same either way. No new dependency.

**Acceptance criteria:**

- Unit test (`loops/status-trim.test.mjs`): with prettier unresolvable (inject the resolver, or run the module from a temp copy outside any `node_modules`), status-trim still trims, exits 0 and says it skipped formatting; with prettier found in the project it formats as before.

## Slice 7: A brief with the old Directives heading names it as the user's word

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/prompt.test.mjs

**Build (RISA-1024):** `loops/prompts/backlog.sh` sets `directives=1` for a `## From the user` or a legacy `## Directives` heading, but the standing line always says "except its _From the user_ lines", so a legacy brief's directives read as context. Name the heading the brief actually has (`_Directives_` for the legacy one; both when both are present). Keep the rest of the header as is.

**Acceptance criteria:**

- Unit test (`loops/prompt.test.mjs`): a brief with `## Directives` gets a header naming _Directives_ as the user's word; one with `## From the user` keeps today's line; one with neither says it is context.

## Slice 8: Session names lead with the persona, its rank abbreviated

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/session-names.test.mjs

**Build (RISA-1039):** `displayName` (`loops/session-names.mjs`) builds `<name> (<project>) · <Rank> <Name>`; the user wants `<Abbr> <Name> · <name> (<project>)`, e.g. `Adm Morrow · backlog (caretook)`. Each rank's short form lives beside its rank in the flavor pack (`loops/flavor.mjs`; Starfleet: Admiral → ADM, Captain → CAPT, Commander → CMDR, Lieutenant Commander → LCDR, Lieutenant → LT, Ensign → ENS, Yeoman and Doctor their usual short forms), so another pack brings its own; written in the name as the user's example shows (`Adm`). Only the session name is shortened: the persona line and replies keep the full rank. The already-qualified check and every reader that parses a name (`loops/ask.mjs` labels, rotate, sessions, tab titles: grep for the `·` and ` (<project>)` matches) take the new order and still read names set the old way. A name with no persona (flavor none) stays `<name> (<project>)`.

**Acceptance criteria:**

- Unit tests (`loops/session-names.test.mjs`, `loops/flavor.test.mjs`): the new order with the abbreviated rank; an old-order name is recognised as qualified and read back to the same role, project and persona; flavor none unchanged; every Starfleet rank has a short form.

## Slice 9: Role additions can target a section, and a heading change needs a changelog line

Stack: no · Reads: plans/fixes-rules.md, loops/docs/project-config.md · Tests: unit · Blocked by: none · Check: loops/doc.test.mjs

**Build (RISA-1049):** additions (`roles.<role>.additions`, `loops/doc.mjs`) print after the generic doc, so they can only continue its last section, and two releases broke Caretook's by renaming or moving a section. (1) A `## <Heading>` in an additions file that matches a generic doc's `##` heading merges its body at the end of that section; additions before any heading, and sections that match none, append at the end as today. (2) A check (a script beside `loops/docs-budget.mjs`, run by `pnpm check`) compares each `loops/docs/*.md`'s `##` headings and its last section's heading against the latest `v*` tag, and fails when one is added, renamed, removed or moved and no line under the unreleased heading of a new root `CHANGELOG.md` names that doc and heading. Start `CHANGELOG.md` with an `## Unreleased` heading and a line for this change. Say the merge rule in `loops/docs/project-config.md` (the additions entry), within its budget.

**Acceptance criteria:**

- Unit test (`loops/doc.test.mjs`): an additions `## <Heading>` lands at the end of the matching section; unmatched and headless parts append at the end.
- Unit test (beside the new check): a heading rename with no CHANGELOG line fails, naming the doc and heading; with the line it passes; no tag passes.

## Slice 10: The inbox session's rotate hint runs from anywhere

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/context.test.mjs

**Build (RISA-1061):** `inboxRotate` (`loops/context.mjs`) hands the inbox session `pnpm -s -C <main> prd rotate --self`, but Risa's `package.json` has no `prd` script, so the hint fails. Build it from the configured command (`toolCmd.prd`, `loops/config.mjs`), the way the other context-watch hints in the file do, and keep it runnable from outside the repo: if the configured command needs the main checkout as its cwd, say so in the hint (`cd <main> && …`) rather than assuming a package script. Update the expectations in `loops/context.test.mjs` (around lines 315, 330, 363, 539). Don't touch `loops/dispatch*` or `loops/prd.sh` (hot for risa-next-2).

**Acceptance criteria:**

- Unit test (`loops/context.test.mjs`): the inbox reminder and nudge name the configured command's `rotate --self`, never `pnpm … prd`; with a project command configured it names that.

## Slice 11: Persona draws don't collide across projects on one machine

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/captain.test.mjs

**Build (RISA-1063):** two projects' backlog sessions both drew Admiral Cartwright, and `prd-fixes-bug` (risa) and `prd-account-security` (caretook) both got Captain Saru: `drawAdmiral` / `nextCaptain` (`loops/flavor.mjs`, `loops/captain.mjs`) skip only this project's last name, and `personaFor` is a hash of the session name alone. Skip names held by any live session on the machine: read the live session records of every repo the machine config lists (reuse the existing record readers in `loops/sessions.mjs` and `loops/machine.mjs`; don't copy them), and draw the admiral from the pool minus those; for a PRD (or other hashed role) persona, keep the hash as the starting point but step to the next pool entry free on the machine, so a name already held keeps its persona. When every name is held, fall back to today's draw. Keep `nextCaptain`'s signature (its caller in `loops/dispatch.mjs` is hot for risa-next-2: don't edit it). Say in the hand-off where the held names are read and how a persona stays stable for a session that already has one.

**Acceptance criteria:**

- Unit tests (`loops/captain.test.mjs`, `loops/flavor.test.mjs`): with another project's live backlog session holding an admiral, the draw never returns it; a PRD session whose hashed captain another project's live session holds gets a different one, and the same session name reads back the same persona; with every name held, the draw still returns one; flavor none unchanged.

## Slice 12: A fresh session's stepped persona is kept in its first record

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/captain.test.mjs

**Build (RISA-1064):** a follow-up of slice 11 (Codex P2 on PR #30). `loops/session.sh` computes the display name before the session's record exists, so `machinePersona` (`loops/captain.mjs`) has no record to write the stepped persona into, and `machineHeld` then reads that session as its hashed name: a third session can draw the stepped name too. Carry the persona chosen for the name into the session's first record (pass it to whatever writes the record, or write the record with it), so `machineHeld` reads the stepped persona from the start and the same session name reads it back. Don't touch `loops/dispatch*` or `loops/prd.sh` (hot for risa-next-2). Say in the hand-off where the first record gets its persona.

**Acceptance criteria:**

- Unit test (`loops/captain.test.mjs`, plus a session.sh test if one exists): a fresh session whose hashed captain is held elsewhere gets a stepped one, its first record carries it, and a third session then draws neither the held name nor the stepped one; a session with a record keeps its persona as before.

## Slice 13: The time gate judges the local measure on its start load

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/time-gate.test.mjs

**Build (RISA-1065):** `timeGate` (`loops/time-gate.mjs`, around line 77) sets `quiet = calm(start) && calm(end)`, but a local check's end load counts the check's own work, so every Caretook quick check comes out unjudged and its quick gate can't be armed. Judge the local measure when the start load is quiet; the end load stays in the input and in the lines (both the judged and the unjudged lines name both loads) but no longer decides unjudged. CI measures unchanged. If a doc (`loops/docs/*.md`) states the quiet rule, update it in the same words.

**Acceptance criteria:**

- Unit test (`loops/time-gate.test.mjs`): quiet start with a busy end is judged (ok, warn and fail cases); a busy start is unjudged; the lines name both loads; a CI measure is judged as before.
