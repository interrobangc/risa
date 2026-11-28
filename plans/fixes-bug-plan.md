# Plan: fixes-bug

> Risa's standing fix topic for wrong behaviour or data. No PRD: this plan is the whole spec. One slice per backlog item, appended at each wave boundary; every slice reads [`plans/fixes-rules.md`](fixes-rules.md).

## Status

**Landing mode:** run everything through (started run-through; land each green wave without asking, ask only real questions).

| Slice | Wave | Item            | Model | State   | Merge into `prd/fixes-bug` |
| ----- | ---- | --------------- | ----- | ------- | -------------------------- |
| 1     | 1    | RISA-241        | opus  | merged  | 5155c24                    |
| 2     | 1    | RISA-980        | opus  | merged  | 1e9259e                    |
| 3     | 1    | RISA-991        | opus  | working | —                          |
| 4     | 1    | RISA-1001 (1/2) | opus  | working | —                          |
| 5     | 1    | RISA-1001 (2/2) | opus  | planned | —                          |

**Wave 1** (slices 1–5, all opus; 5 after 4): the plan's first wave, started 2026-11-28. RISA-985 was closed at triage without a slice: a489eef (PR #3) already fixed it. Slices 1–4 started (worktrees `.loops/fixes-bug-<n>`, one opus agent each); 5 waits for 4's merge. Slice 1 handed off (a new `too-long` verdict state, never clean; review.sh exits 3 on it) and merged. Slice 2 merged (pickup checks the loaded config's and RISA_MAIN's checkout, not lib.sh's; dev_sync runs on the project). Items claimed; hot files set.

**Open issue:** the installed release refuses a slice's `Model:` field ("unknown field", so the prompt drops Reads and Check): leave it out of the fields line until the release that reads it is installed; models live in the table.

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

**Build (RISA-1001, part 2):** route the backlog.mjs calls in `loops/land.sh` and `loops/rm.sh` through slice 4's `lib.sh` helper, dropping their own `cd "$main"` wrappers where the helper covers them, so no loop script calls backlog.mjs directly.

**Acceptance criteria:**

- Unit test (`loops/land.test.mjs`): a topic's worktree whose config names another paths.backlog still marks the main checkout's registry row (land's flags, rm's done) and reads its items.
