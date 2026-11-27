# Plan: Staging ship

> Moved from Caretook with B-543 (2026-11-27): ids B-n there are RISA-n here; `pnpm prd` and `pnpm backlog` are `risa` and `risa backlog`.

> Source PRD: [`plans/staging-ship-prd.md`](staging-ship-prd.md). User-story numbers (US) refer to it. Backlog items B-404, B-430, B-436, B-584, B-241. Topic `staging-ship`. Starts after `test-gates-2` and `inbox-agent`. **Held** (`hold`) after two skeptic send-backs, until the user lifts it.

## Status

| Slice | Wave | State | Merge into `prd/staging-ship` |
| ----- | ---- | ----- | ----------------------------- |
| 1     | 1    | —     | —                             |
| 2     | 2    | —     | —                             |
| 3     | 3    | —     | —                             |
| 4     | 4    | —     | —                             |
| 5     | 5    | —     | —                             |
| 6     | 6    | —     | —                             |
| 7     | 7    | —     | —                             |

**Backlog:** the planner moves B-584 and B-241 into this topic with `pnpm backlog set`. Claim B-241 at slice 1, B-430 at slice 2, B-404 at slice 4, B-436 at slice 6, B-584 at slice 7. `done` B-241 when slice 1 merges, B-430 when slice 3 merges, B-436 when slice 6 merges, B-404 when slice 7 merges. **B-584 stays open** after slice 7, released with a note, until a real push reaches the user's phone (B-586).

## Architectural decisions

- **The candidate is the only road to staging.** Ship calls `candidate` and `promote`; it never opens a `dev` PR into staging, never merges another way, and never closes or edits a PR it didn't open (PR #115 stays).
- **No state file.** Where a ship stands is worked out from git and GitHub: the open candidate, the latest promotion's merge, its diff and its deploy run. A local to-test file is never what decides.
- **The open Codex thread is the blocker record.** It carries a `[ship-blocker]` reply, counted only from an author with write access. On a candidate, a P0, an unbadged finding or a marked thread blocks while open, when outdated, and when resolved without a valid clearing reply. Only `findings` resolves a candidate's threads.
- **One commit passes everything.** CI's verdict and Codex's are on the exact tip, and promotion is pinned to it. A new tip restarts the wait.
- **A ship is the user's word, once.** No dispatcher or orchestrator path starts one. Only a fresh `ship` cuts, after all its refusals and before nothing else; `--resume` never cuts.
- **What overrides a live-deploy check is a bound record.** A P0 on a candidate or a missing review passes only with `--ask <id>`: a `--waits` question filed with the exact binding (action, tip, thread), answered with its yes option, not defaulted.
- **Tooling only:** `loops/`, `scripts/ci/`, their tests, the handbooks. No app code, migration or dependency.
- **No real side effects in tests or slices:** no real candidate, CI run, PR comment, thread resolve, merge or deploy. Fake `gh`, throwaway repositories, fixtures of real PR states (#121 for out of credits).

## How to run this plan

- **Waves:** one slice each, in order (each builds on the last). Each wave lands something usable alone: 1 the verdict, 2–3 the findings tool, 4 a ship up to the merge, 5 the merge, 6 the report, 7 the session.
- **Gate:** tooling and Markdown, so `pnpm test:tooling` and `pnpm exec eslint scripts` before each landing. Slices that touch `scripts/ci/` land at the tier `check-plan` proposes. No browser checks.
- **Other topics:** `inbox-agent`, `asks-relay`, `worker-watch` and `fixes-tooling` change `prd.sh`, `prompt.sh`, the ask scripts or the review scripts. Sync at each wave boundary. Slice 3 changes the ask record, which `asks-relay` also holds.
- **After the last wave:** the first real ship is the user's word. Report that it is unproven against a real `rc/` PR.
- **Docs at landing:** a new `docs/agents/ship.md` with its _Area index_ entry; orchestrator step 4 points at `pnpm prd findings` (it has about 35 bytes spare, so shorten as you change it); the runbook's deploy step names `pnpm prd ship`.

## Slice 1: Codex's verdict on a release candidate

Stack: no · Reads: docs/agents/orchestrator.md, ops/runbook.md · Tests: unit

**User stories:** US 2, 11.

**Build:** the review command accepts an `rc/` branch and finds its PR into staging. A candidate's verdict is on the exact tip, with no carry. Threads and their comments are read across all pages for every PR; a read that can't finish is never clean. A usage-limit comment older than the tip's commit doesn't count on a candidate. A new tip with no sign of Codex after five minutes gets one `@codex review`. `review --resolve` refuses a candidate's threads.

**Acceptance criteria:**

- Unit tests in the Codex review suite: a fixture with over 100 threads, the unresolved one past the first page, reads as findings; a failed page isn't clean; an older clean review on a candidate reads as stale, not carried; PR #121's state reads as out of credits; the same limit comment before a newer tip reads as waiting.
- Command tests with fake `gh`: `review rc/<name>` finds the PR into staging; a `prd/` branch still finds its PR into `dev`; a new tip gets one nudge, and a resume on the same tip gets none; `--resolve` on a candidate thread refuses and resolves nothing.
- `pnpm test:tooling` passes.

**Blocked by:** nothing. **Blocks:** 2.

## Slice 2: Codex findings filed by one command

Stack: no · Reads: docs/agents/orchestrator.md, docs/agents/backlog.md · Tests: unit

**User stories:** US 9, 10.

**Build:** `pnpm prd findings <topic|branch>` with `list`, `file` (`--anyway` past a look-alike) and `note`, for PRD and candidate PRs alike, each item carrying its `[codex-finding <pr>/<thread>]` mark. Each replies and resolves. Orchestrator step 4 and its prompt use it.

**Acceptance criteria:**

- Unit tests: the finding mark round-trips; a retry after a crash between filing and resolving finds the item and files no second one.
- Command tests with fake `gh` and a throwaway backlog: `file` adds a triaged item, replies and resolves; a look-alike stops it with nothing written, and `--anyway` files it; `note` adds to the existing item.
- Prompt tests cover the changed orchestrator line.
- `pnpm test:tooling` passes.

**Blocked by:** 1. **Blocks:** 3.

## Slice 3: The gate verbs: decline, blocker, fixed and bound asks

Stack: no · Reads: docs/agents/orchestrator.md, docs/agents/machinery.md · Tests: unit

**User stories:** US 4, 5, 10.

**Build:** `findings decline` (a land skeptic's `go` for the thread), `blocker` (the `[ship-blocker]` reply, thread left open) and `fixed <thread> <commit>` (a commit on the tip the finding didn't already see, or a dev commit whose cherry-pick is on the tip). Asks can be filed with a binding (action, tip, thread), kept in the record. On a candidate: a P0 or unbadged finding refuses a skeptic's `go` alone; `file`, `note` and `decline` on a marked thread, a P0 or an unbadged finding need a bound `--ask`. The verdict reads marks from write-access authors only and counts a resolved P0 or marked thread with no valid clearing reply as open.

**Acceptance criteria:**

- Unit tests of the verdict: a marked thread blocks when outdated and when resolved without a clearing reply; a mark from an author without write access doesn't count; an unbadged finding on a candidate is a P0.
- Command tests: `decline` without a `go` refuses; `blocker` leaves the thread open; `fixed` refuses an old ancestor and accepts a real `candidate fix` pick and its dev commit; an `--ask` that is unanswered, defaulted, answered with another option, for another tip, another thread or another action refuses.
- Ask tests: a binding is stored and read back; an ask without one never satisfies a bound check.
- `pnpm test:tooling` passes.

**Blocked by:** 2. **Blocks:** 4.

## Slice 4: A ship that runs up to the merge

Stack: no · Reads: docs/agents/orchestrator.md, ops/runbook.md · Tests: unit

**User stories:** US 1, 2, 6.

**Build:** `pnpm prd ship` and `ship --resume`. A fresh ship runs every refusal first (an open candidate, an unconcluded deploy of the latest promotion), then pushes `dev` through the shared step `pr` and `land` use (after `inbox-agent`, it picks up `origin/dev` first), cuts, waits for CI and for Codex on the tip, and stops at "ready to merge" with a distinct exit for each stop. The next-step decision is a pure function of the observed state. This slice merges nothing.

**Acceptance criteria:**

- Unit tests of the next step, one per state: nothing to ship, no candidate, CI running, failed, passed; Codex waiting, findings, a marked blocker, clean, out of credits, timed out; staging moved; the tip changed after a check passed; merged with its deploy unconcluded.
- Command tests with fake `gh` and throwaway repositories: a refused fresh ship pushes nothing; a fresh ship refuses an open candidate, pointing at `--resume`; `--resume` continues the open candidate and never cuts, even when `dev` has moved; PR #115's shape (a `dev` head into staging) is ignored; `origin/dev` ahead by inbox commits is picked up; a real conflict stops with nothing pushed.
- `pnpm test:tooling` passes.

**Blocked by:** 3. **Blocks:** 5.

## Slice 5: The merge and the deploy watch

Stack: no · Reads: docs/agents/orchestrator.md, ops/runbook.md · Tests: unit

**User stories:** US 3, 4, 5, 7.

**Build:** `promote` takes an optional expected commit. Ship promotes the tip both checks passed, finds the `deploy.yml` run for the merge commit and waits for it. An open blocker or a missing review stops it. Shipping without a review takes `--no-review --ask <id>`, bound to `no-review` and the tip. `--resume` after a merge finds that merge's deploy run and finishes the watch.

**Acceptance criteria:**

- Promotion tests: a moved tip refuses with nothing merged; with no expected commit it behaves as before.
- Command tests with fake `gh`: a clean ship merges and reports the deploy; an open blocker never calls merge; out of credits never merges without a valid bound `--ask`; a tip moved between check and merge refuses; a failed run and a run that never appears each end as a failed ship; a merge that can't be confirmed is reported, not retried; `--resume` after a crash past the merge watches that deploy and cuts nothing.
- `pnpm test:tooling` passes.

**Blocked by:** 4. **Blocks:** 6.

## Slice 6: The to-test report of a ship

Stack: no · Reads: docs/agents/machinery.md · Tests: unit

**User stories:** US 8.

**Build:** the pure report builder, and ship writing `to-test/<date>-<HHMM>-staging-ship.md` in the main checkout: the deploy's result at the top, what reached staging (items with titles, commits), what to try on the staging URL, what wasn't checked (flakes, a skipped review, declines), follow-ups filed. Markdown only is read from the merge's diff: no file then. No password. A missing report for the latest promotion is written by `--resume` or the next fresh ship.

**Acceptance criteria:**

- Unit tests of the builder: a clean ship; a failed deploy says so first; a skipped review and a flake are listed; a Markdown-only merge returns nothing; no output holds a value from the env.
- Command tests: the file names the merge commit and is written even when the deploy failed; an existing file is never overwritten; a report deleted by hand is rewritten, and the next fresh ship isn't refused for it; a Markdown-only ship writes none and doesn't wedge the next.
- `pnpm test:tooling` passes.

**Blocked by:** 5. **Blocks:** 7.

## Slice 7: The ship session and the "deploy staging" trigger

Stack: no · Reads: docs/agents/backlog.md, docs/agents/machinery.md, docs/agents/orchestrator.md · Tests: unit

**User stories:** US 1, 3, 4, 5, 7.

**Build:** `pnpm prd ship --open` opens a session in a stackless worktree detached at `origin/dev`; it makes no candidate itself. Its prompt runs the ship, moves the worktree to the candidate's tip after the cut and after each `candidate fix` before verifying findings, applies the blocker rule, files a bound `--waits` question for a blocker or a missing review, and sends one push at the end with the result. The backlog prompt learns "deploy staging". The dispatcher has no path to a ship. Writes `docs/agents/ship.md`, and adds the push exception, scoped to this prompt, to the preferences doc.

**Acceptance criteria:**

- Prompt tests: the ship prompt names the blocker rule, the bound `--waits` stops, the move to the current tip and the one push; the backlog prompt names the trigger and opens a session for it rather than shipping inline.
- A dispatcher test: no tick starts a ship, whatever the registry says.
- Command test: `--open --print` gives the session's command, makes no candidate and pushes nothing.
- `pnpm test:tooling` passes.

**Blocked by:** 6. **Blocks:** nothing.
