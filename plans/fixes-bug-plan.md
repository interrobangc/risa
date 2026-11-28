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
| 12    | 4    | RISA-1064       | opus   | merged  | a04752b                    |
| 13    | 4    | RISA-1065       | opus   | merged  | 47c911a                    |
| 14    | 5    | RISA-1070       | opus   | merged  | 9b490d4                    |
| 15    | 5    | RISA-1082       | opus   | merged  | c8dac71                    |
| 16    | 6    | RISA-1078       | opus   | merged  | af6ee57                    |
| 17    | 6    | RISA-1080       | opus   | merged  | 57bd232                    |
| 18    | 6    | RISA-1083       | opus   | merged  | 29020ba                    |
| 19    | 6    | RISA-1079       | opus   | planned |                            |
| 20    | 6    | RISA-1084       | opus   | planned |                            |
| 21    | 6    | RISA-1050       | opus   | planned |                            |
| 22    | 6    | RISA-1077       | opus   | merged  | 5a22554                    |
| 23    | 6    | RISA-1081       | opus   | merged  | 69cd110                    |
| 24    | 6    | RISA-1086       | opus   | merged  | c3324f5                    |
| 25    | 6    | RISA-1087       | opus   | merged  | 4fbc7cf                    |

**Wave 1** (slices 1–5, RISA-241/980/991/1001): landed 2026-11-28 in main as 3598122 (PR #13, tier none). RISA-985 closed at triage (a489eef already fixed it).

**Wave 2** (slices 6–9, RISA-1023/1024/1039/1049): landed 2026-11-28 in main as 5767dfb (PR #27, tier unit, run 46154596385); Codex's P2 (CI fetches no tags) is RISA-1054 (fixes-tooling). Caretook's backlog session told 5767dfb has RISA-1049.

**Wave 3** (slices 10–11, RISA-1061/1063): landed 2026-11-28 in main as 6f1daaa (PR #30, tier none); Codex's P2 became RISA-1064.

**Wave 4** (slices 12–13, RISA-1064/1065): landed 2026-11-28 in main as acb0975 (PR #33, tier none, Codex clean); to-test file `to-test/2026-11-28-1123-fixes-bug.md`.

**Wave 5** (slices 14–15, RISA-1070/1082): landed 2026-11-28 in main as 3aa2773 (PR #40, tier unit, run 46179562703, Codex clean); to-test file `to-test/2026-11-28-1415-fixes-bug.md`.

**Wave 6** (slices 16–25, all opus), 2026-11-28, fresh session: ingest had nothing new; `risa sync` needed no merge. All ten waiting items are in: only risa-next-4 runs and none of its hot files (loops/config, loops/machine.mjs, loops/skeptics.mjs, loops/project-check, loops/sample-project/repo.mjs, bin/risa, loops/rm.sh, loops/lib.sh, loops/setup, loops/second-repo, loops/docs/project-config.md, README.md) is needed; each slice is told to keep off them. Chains, so no two slices edit one function: 16 → 17 → 19 (loops/home.mjs `homeTick`); 18 and 19 → 20, 18 → 21 (loops/dispatch.mjs). Ready at once: 16, 18, 22, 23, 24, 25. Hot set: loops/home, loops/dispatch, loops/ls, loops/prompts/inbox.sh, loops/inbox-prompt, backlog/inbox-move, loops/prd.sh, loops/usage.

**Notes:** run local checks with `env -u CLAUDE_CONFIG_DIR` until RISA-1076 lands; past a load of about 15 the local full check times out (RISA-1088), so gate on `risa ci run <tier> --wait`. When RISA-1050 ships, tell Caretook's backlog session the commit (its note asks). When a tagged release carries RISA-1065 (acb0975) or RISA-1070 (3aa2773), tell Caretook's backlog session (and prd-test-time-gates-2 for RISA-1065; their notes ask). The slice gate is `risa check` with no argument (only `--quick "<why>"` takes one).

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

## Slice 14: A topic name can't start with a dash, so `plan --help` makes no worktree

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/new.test.mjs

**Build (RISA-1070):** `risa plan --help` took `--help` as a topic and made worktree `.loops/plan---help` on branch `plan/--help`: `loops/new.sh` accepts any `^[a-z0-9-]+$` as a topic. Refuse there, before any worktree, branch or install, a topic (or hotfix name) that doesn't start with a lowercase letter or digit, with a line naming the bad value and the rule; this covers `start`, `slice`, `plan` and `hotfix`, which all wrap new.sh. Don't edit `loops/prd.sh` (hot for risa-next-2): its `plan` case stays as is, so `plan --help` ends in new.sh's refusal (non-zero, nothing made). If `bin/risa` already has one place that could answer `<command> --help` or `-h` with the usage text before the command runs, without touching prd.sh, use it and say so in the hand-off; otherwise say in the hand-off that per-command `--help` and refusing unknown flags are left for a later fix in prd.sh.

**Acceptance criteria:**

- Unit test (`loops/new.test.mjs`): `new.sh plan --help`, `new.sh plan -x` and `new.sh prd -a` exit non-zero naming the topic rule, and leave no worktree and no branch; a valid topic works as before.

## Slice 15: rotate --self says whether the hand-off took

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/rotate.test.mjs

**Build (RISA-1082):** in Caretook's inbox session `risa rotate --self` printed "Opened inbox in a new background iTerm2 tab", but the hand-off never took effect: `loops/rotate.sh`'s `--self` branches `exec` `open-session.sh … --background`, whose success line only means a tab was opened. The tab runs `loops/rotate-into.sh`, which can still refuse ("nothing was ended": no record of that kind, the pid isn't the name's live session; a likely cause here is the record sitting under another project's sessions dir, RISA-1072, which risa-next-2 fixes) and nobody sees that line. Make `rotate --self` (backlog, inbox, and the orchestrator path if it has the same gap) report the truth: after the tab is opened, wait a bounded time (an env override for tests, as `RISA_ROTATE_WAIT` is) for evidence that rotate-into started on this session, which is its first step marking the record rotating (or the record already replaced); when none shows, print a failure line saying the hand-off did not start and this session carries on, with rotate-into's reason when it left one (have rotate-into write its refusal where rotate.sh can read it, e.g. a file under the sessions dir, removed once read), and exit non-zero. When it does show, the session is about to be ended, so print what is happening and return. Keep the pure logic in `loops/rotate.mjs` where it can be tested. Don't edit `loops/prd.sh`, `loops/dispatch*` or `loops/prompts/inbox.sh` (hot for risa-next-2). Say in the hand-off what counts as "started" and how long the wait is.

**Acceptance criteria:**

- Unit tests (`loops/rotate.test.mjs`): with the opener stubbed so rotate-into never runs, or refuses, `rotate --self` exits non-zero and says the hand-off did not start (with the refusal's reason when there is one), never the bare success; with the record marked rotating within the wait it reports the hand-off under way and exits 0.

## Slice 16: A dispatcher whose project has work off never claims the project's home

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/home.test.mjs

**Build (RISA-1078):** `homeTick` (`loops/home.mjs`) claims an unclaimed home on a dispatcher's first tick with no look at the project's work switch, so a machine whose config has `work: false` for the project takes its home and a `work: true` machine is locked out until `risa home take`. Before an automatic claim, check the work switch the way `inboxKeeper` in the same file reads it (`RISA_WORK_SELF` aside, so every shell agrees): a machine with work off claims neither the project's home nor, through this project, the inbox home; it reads the home as unknown or away like any machine that doesn't hold it, with a line saying why it didn't claim. `risa home take` by hand is unchanged. Don't edit `loops/dispatch*` (other slices of this wave), nor `loops/machine.mjs`, `loops/config*`, `loops/lib.sh` or `bin/risa` (hot for risa-next-4): read through what they export. Say in the hand-off where the switch is read.

**Acceptance criteria:**

- Unit test (`loops/home.test.mjs`): with work off, a first tick on an unclaimed home writes no claim and says so; with work on it claims as before; a later `take` by the work-on machine succeeds without a prior claim in the way.

## Slice 17: An unreadable homes file means ownership unknown, not open

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: 16 · Check: loops/home.test.mjs

**Build (RISA-1080):** `homeTick` (`loops/home.mjs`) catches a read or parse error of `homes.json` and carries on with no homes; names already in `claimed` are then neither away nor unknown, so `blocked` is null and an away dispatcher starts work beside the real home. Treat a claims file that can't be read or parsed as ownership unknown for every name this machine would gate on: `blocked` (and `inboxWhy`) say the homes file is unreadable, with the error, nothing is claimed on that tick, and the gate closes until a readable file says this machine holds the home. A file that is simply absent in a store that was reached keeps today's first-claim behaviour. Check `homesOf` and `homeOf` for the same fail-open and say in the hand-off what each returns now. Don't edit `loops/dispatch*`, `loops/machine.mjs`, `loops/config*`, `loops/lib.sh` or `bin/risa`.

**Acceptance criteria:**

- Unit test (`loops/home.test.mjs`): with an unparseable homes file and this machine's name already in its claimed state, the tick is blocked, names the file as unreadable and writes no claim; once the file parses and names this machine, the gate opens; an absent file still claims as before.

## Slice 18: A running dispatcher notices a project that becomes home-gated

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/dispatch.test.mjs

**Build (RISA-1083):** `loadHome` (`loops/dispatch.mjs`) runs once before the loop, and the code hash that triggers a re-exec covers only `.mjs` files, so a project moved with `backlog inbox to-repo` while its dispatcher runs is never home-gated until a restart. Recheck between ticks whether the home gate applies (whatever `loadHome` reads to decide: the machine config's inbox group or store for this project), cheaply (a stat or a small read, never a network fetch of its own each tick), and load the home module when it first applies; when it stops applying, drop the gate the same way. Pick the simpler of rechecking in place and restarting the dispatcher through its existing re-exec path, and say which in the hand-off and why. Keep to `loadHome`, its callers and the loop: the tick's use of `homeBlocked`, `contextStep` and `stuckStep` belong to slices 19 and 20. Don't edit `loops/home.mjs` (slices 16, 17, 19), `loops/machine.mjs`, `loops/config*`, `loops/lib.sh` or `bin/risa` (hot for risa-next-4).

**Acceptance criteria:**

- Unit test (`loops/dispatch.test.mjs`, or the dispatch test file that covers the loop): a dispatcher started with no inbox group for its project gates on the home from the first tick after the group appears, with no restart by hand; one whose group was there at start behaves as before; a tick with nothing changed does no extra fetch.

## Slice 19: The inbox session is kept by the inbox home alone

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: 17 · Check: loops/home.test.mjs

**Build (RISA-1079):** the shared inbox session is gated on its keeper project's home as well as the inbox home: `homeTick` (`loops/home.mjs`) sets `inboxWhy = blocked` when the project's home is away, and the tick in `loops/dispatch.mjs` sets `unready.inbox = homeBlocked` beside `unready.backlog`. With the project's home on machine A and the inbox home taken to machine B, neither keeps the inbox session. Base the inbox kind's readiness on the keeper choice and the inbox home's claim only: `inboxWhy` no longer takes `blocked`, and the dispatcher's tick reads `inboxWhy` for the inbox kind (keep-alive, reopen and the session request for an inbox session) and `homeBlocked` for the backlog kind and everything else. An unreadable homes file (slice 17) still closes both. In `loops/dispatch.mjs` edit only the lines where the tick turns the home result into `unready` and the session-request wait; `loadHome` is slice 18's, `contextStep` and `stuckStep` slice 20's. Don't edit `loops/machine.mjs`, `loops/config*`, `loops/lib.sh` or `bin/risa`.

**Acceptance criteria:**

- Unit tests (`loops/home.test.mjs`, and the dispatch test that covers `unready`): project home away and inbox home here: the inbox session is kept here and the backlog session isn't; project home here and inbox home away: the reverse; both away: neither; an unreadable homes file: neither.

## Slice 20: A machine that lost the home stops rotating its sessions into fresh ones

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: 18, 19 · Check: loops/dispatch-context.test.mjs

**Build (RISA-1084):** the away gate stops the pick, the keep-alive, the session request and the resume, but not `contextStep` and `stuckStep` (`loops/dispatch.mjs`): a session on a machine that lost the project's home is still rotated into a fresh one by the context watch or the stuck watch and keeps working beside the new home. Apply the gates to the automatic rotations: while the project's home is blocked, neither step opens or rotates into a fresh session for a PRD, backlog or other project session; while the inbox gate is closed (slice 19's `inboxWhy`), neither does so for the inbox session. A gated step still reports (one line naming the session and the gate's reason, not repeated every tick if the steps already de-duplicate lines) and never ends the running session on its own. Reminders that open nothing may still go out. Don't edit `loops/home.mjs`, `loops/machine.mjs`, `loops/config*`, `loops/lib.sh` or `bin/risa`.

**Acceptance criteria:**

- Unit tests (`loops/dispatch-context.test.mjs`, `loops/dispatch-stuck.test.mjs`): with the project's home away, a session past the hard context limit and a stuck session are not rotated and a line says why; with the home here both rotate as before; with only the inbox gate closed, the inbox session isn't rotated and a PRD session is.

## Slice 21: Status and the dispatcher warn when the project's pinned risa differs from the running release

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: 18 · Check: loops/ls.test.mjs

**Build (RISA-1050):** a machine ran release v0.2.0 while the project's config still pinned v0.1.8, and nothing said so. The config's `risaVersion` (`loops/config.mjs`, read it through the loader; find any other place a project states its pin and say so in the hand-off) is the pin; the running version is the release this code runs from (its `package.json` version, or the release folder's tag: reuse whatever already reads it). When both are known and differ, `risa status` (`loops/ls.sh` and its helpers) prints one warning line naming both versions, and the dispatcher (`loops/dispatch.mjs`) logs the same line once at start and once after each re-exec, never per tick. A warning only: nothing is refused (refusal is RISA-1017's). No pin, or a run from the main checkout rather than a release, prints nothing. Put the comparison in one pure function both callers use. In `loops/dispatch.mjs` touch only the start-up path; don't edit `loops/config*`, `loops/machine.mjs`, `loops/lib.sh`, `bin/risa`, `loops/docs/project-config.md` or `README.md` (hot for risa-next-4), nor `loops/home.mjs`.

**Acceptance criteria:**

- Unit tests (beside the new function, and `loops/ls.test.mjs` or `loops/status-extra.test.mjs`): pin v0.1.8 under a running v0.2.0 gives the one line naming both in status and in the dispatcher's start log; equal versions, no pin and a non-release run give none; a `v` prefix on either side doesn't make equal versions differ.

## Slice 22: The inbox session hands off when its backlog session or the dispatcher asks

Stack: no · Reads: plans/fixes-rules.md, loops/docs/inbox.md · Tests: unit · Blocked by: none · Check: loops/inbox-prompt.test.mjs

**Build (RISA-1077):** during an account rollover the backlog session told the inbox session to run `risa rotate --self`; it declined, because its prompt (`loops/prompts/inbox.sh`, the two **Hand off** lines) allows a hand-off only on the user's word or a context-watch reminder, and the user had to exit it by hand. Add to both lines: a rollover or rotate request from the project's backlog session (a peer message from a session named `backlog (<project>)`, old or new name order) or from the dispatcher also hands off, without asking the user. Keep it narrow: only the hand-off, only from those two; any other peer's request stays advice. If the backlog session's own prompt (`loops/prompts/backlog.sh`) or `loops/docs/inbox.md` states the old rule, bring it in line in the same words, within the docs budget and with no `##` heading changed. Update the prompt goldens the change moves (`loops/sample-project/prompt-golden.txt` through its own update step, not by hand).

**Acceptance criteria:**

- Unit test (`loops/inbox-prompt.test.mjs`): both forms of the inbox prompt name the backlog session's and the dispatcher's request as grounds to hand off, beside the user's word and the context watch, and still tell it to do nothing after `rotate --self`.

## Slice 23: A retried inbox move doesn't leave a filed line untagged in the store

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: backlog/inbox-move.test.mjs

**Build (RISA-1081):** `backlog inbox to-repo` (`backlog/inbox-move.mjs`, around line 172): when a trunk ingest lands between the move's store write and its refused trunk push, the line the move already copied to the store is by then filed on the trunk, with no inbox-key note; the retry's store edit only appends, so that line stays untagged in the store and the next store ingest files it a second time. Before finishing (and on each retry), reconcile the lines copied by earlier tries against the latest trunk: a copied line whose text the trunk has since filed is marked in the store the way an ingested line is (or removed, whichever the store's ingest already treats as done), so no later ingest files it again; lines the trunk hasn't filed stay as copied. Keep the move idempotent: running it again after a success changes nothing. Say in the hand-off how a copied line is matched to a trunk item.

**Acceptance criteria:**

- Unit test (`backlog/inbox-move.test.mjs`): a move whose first trunk push is refused because an ingest filed one of the moved lines meanwhile ends with that line not ingestible from the store, and a following store ingest files nothing twice; a move with no race behaves as before; a second run after success is a no-op.

## Slice 24: `risa <command> --help` prints usage, and an unknown flag is refused

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/new.test.mjs

**Build (RISA-1086):** a follow-up of slice 14. Only `risa help`, `-h` and `--help` at the top level print usage (`loops/prd.sh`); `risa plan --help` falls through to `new.sh`'s topic refusal, and other commands take `--help` as a topic or name. In `loops/prd.sh`, before the command's case runs: `risa <command> --help` or `-h` as the first argument after a known command prints that command's lines from `usage()` (the whole usage text when the command has no lines of its own) and exits 0, with nothing made or changed; a command whose script already answers `--help` itself keeps doing so. For the commands that take a topic or name as their first word and wrap `new.sh` (`plan`, `start`, `slice`, `hotfix`), an argument starting with `-` that isn't one of the command's own flags is refused with "unknown flag <flag>" and the command's usage line, non-zero, before any worktree, branch or session. Don't widen it to every command's every flag: the scripts behind them keep their own parsing. Don't edit `bin/risa`, `loops/lib.sh` or `loops/rm.sh` (hot for risa-next-4), nor `loops/new.sh`'s topic rule. Find the test file that drives `prd.sh` commands and add to it (or a new `loops/prd-help.test.mjs`).

**Acceptance criteria:**

- Unit test: `plan --help`, `slice -h` and `land --help` exit 0 printing that command's usage and make no worktree or branch; `plan --bogus topic` and `start -x` exit non-zero naming the unknown flag; `risa help` and a valid `plan <topic>` invocation path behave as before.

## Slice 25: A usage reading from another account is dropped, not merged

Stack: no · Reads: plans/fixes-rules.md · Tests: unit · Blocked by: none · Check: loops/usage.test.mjs

**Build (RISA-1087):** after a rollover to another Claude account, `.loops/.usage/<session>.json` kept the old account's `fiveHour` window (94 %) beside the new `account` and fresh `sevenDay` readings, so `risa usage` and the usage watch reported 94 % for the new account until the window reset. `nextReading` (`loops/usage.mjs`) merges the new parse into the session's current reading window by window, whatever account the current one was read under. When the current reading's account differs from the new one's (a missing account on the old reading counts as different once the new one has an account), start from an empty reading: no window, stall or other per-account field carries over. Check the stall writer (around line 426, which sets `account` only when the reading has none) and `readUsage`'s filter for the same leak and fix what merges across accounts. Run the tests with `env -u CLAUDE_CONFIG_DIR` (RISA-1076: this session's own setting makes some usage tests fail unrelated to this fix).

**Acceptance criteria:**

- Unit test (`loops/usage.test.mjs`): a reading with a `fiveHour` window under account A, then a parse under account B carrying only `sevenDay`, leaves no `fiveHour` and account B; the same account merges windows as before; a stall noted after an account switch doesn't keep the old account's windows.
