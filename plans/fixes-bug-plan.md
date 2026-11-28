# Plan: fixes-bug

> Risa's standing fix topic for wrong behaviour or data. No PRD: this plan is the whole spec. One slice per backlog item, appended at each wave boundary; every slice reads [`plans/fixes-rules.md`](fixes-rules.md).

## Status

**Landing mode:** run everything through (started run-through; land each green wave without asking, ask only real questions).

| Slice | Wave | Item            | Model  | State  | Merge into `prd/fixes-bug` |
| ----- | ---- | --------------- | ------ | ------ | -------------------------- |
| 1     | 1    | RISA-241        | opus   | merged | 5155c24                    |
| 2     | 1    | RISA-980        | opus   | merged | 1e9259e                    |
| 3     | 1    | RISA-991        | opus   | merged | 8316198                    |
| 4     | 1    | RISA-1001 (1/2) | opus   | merged | c5163aa                    |
| 5     | 1    | RISA-1001 (2/2) | opus   | merged | 3697271                    |
| 6     | 2    | RISA-1023       | opus   | merged | e29fab7                    |
| 7     | 2    | RISA-1024       | sonnet | merged | cf93d26                    |
| 8     | 2    | RISA-1039       | opus   | merged | 9f14e04                    |
| 9     | 2    | RISA-1049       | opus   | merged | c0751bb                    |

**Wave 1** (slices 1–5, all opus; 5 after 4): the plan's first wave, started 2026-11-28. RISA-985 was closed at triage without a slice: a489eef (PR #3) already fixed it. Slices 1–4 started (worktrees `.loops/fixes-bug-<n>`, one opus agent each); 5 waits for 4's merge. Slice 1 handed off (a new `too-long` verdict state, never clean; review.sh exits 3 on it) and merged. Slice 2 merged (pickup checks the loaded config's and RISA_MAIN's checkout, not lib.sh's; dev_sync runs on the project). Slice 4 merged (helper `backlog_run` in lib.sh over a shared `loops/backlog-config.sh`, which bin/risa now sources); slice 5 started. Slice 3 merged (stack down/status/ready exit 0 with no hooks). Slice 5 merged (kept the `cd "$main"` wrappers: backlog.mjs still takes its checkout and By: from the cwd). All five merged; sync skipped (no shared files); `risa tier`: none (tooling only), so the gate was `risa check`: green on 6d5cfc0 (2377 tests). Slice worktrees removed. PR #13: Codex clean on 83c70a7. **Landed** 2026-11-28 in main as 3598122 (tier none, unsynced tip: main's one commit shared no file); to-test file `to-test/2026-11-28-0223-fixes-bug.md`. The `Model:` rule went into plans/fixes-rules.md.

**Wave 2** (slices 6–9), 2026-11-28: synced main first (19c92dd; fixes-rules.md conflict resolved to main's topic list). RISA-1050 waits for a later wave: it touches the dispatcher (`loops/dispatch`, hot for running risa-next-2). Slice 7 is sonnet (a wording change the plan spells out); the rest opus. Slices 6–9 started (worktrees `.loops/fixes-bug-<n>`, one agent each). Slice 7 handed off (8eb3c96: the header names _Directives_, _From the user_ or both). Slice 6 handed off (e1cc3ac: prettier from the project, then Risa's own, else formatting skipped with a line). Both merged (e29fab7, cf93d26). Slice 8 handed off (5b60cd4: `Adm Morrow · backlog (caretook)`; old-order names still read; also keep-alive.mjs and session-requests.mjs matchers, backlog.md's name sentence) and merged (9f14e04). plans/risa-next-prd.md's note that matchers need no change is now stale. Slice 9 handed off (d362c67: `mergeAdditions` in doc.mjs; `pnpm docs:headings` (loops/docs-headings.mjs) in `pnpm check`; new CHANGELOG.md; the fixture planner's skeptic-pass addition now merges into its section) and merged (c0751bb). CI's shallow checkout fetches no tags, so docs:headings passes vacuously there: filed as RISA-1054 (fixes-tooling). Wave gate: `risa ci run unit` (tier from `risa tier`: ci.yml changed) on 23a6955: **green** (run 46154596385). Slice worktrees removed; sync skipped (up to date). PR #27: one Codex P2 (CI fetches no tags), tracked as RISA-1054, thread resolved; Codex clean on 2760dbc. **Landed** 2026-11-28 in main as 5767dfb (tier unit, unsynced tip: main's 2 commits shared no file); to-test file `to-test/2026-11-28-0952-fixes-bug.md`; report a52. Caretook's backlog session told 5767dfb has RISA-1049 (its note asked). The role-doc heading rule went into plans/fixes-rules.md.

**For the next session:** RISA-1050 waits (dispatcher hot for risa-next-2); when it ships, tell Caretook's backlog session the commit (its note asks). Check `risa backlog list` at the wave boundary. The slice gate is `risa check` with no argument (only `--quick "<why>"` takes one).

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
