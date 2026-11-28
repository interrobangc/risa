# Plan: after-split-2

> Source PRD: [`plans/after-split-2-prd.md`](after-split-2-prd.md). User-story numbers (US) refer to it. Item RISA-972. Topic `after-split-2`, after `after-split` (done).

## Status

| Slice | Wave | State  | Merge into `prd/after-split-2`  |
| ----- | ---- | ------ | ------------------------------- |
| 1     | 1    | landed | 11b94c5 (+ fix 6100b8e)         |
| 2     | 1    | landed | 57736ed                         |
| 3     | 2    | merged | e32da3c (not landed, not gated) |

**Landing mode:** run everything through (started run-through): start every ready slice, land each green wave, ask only real questions (through the ask skeptic). Models: opus for all three slices.

**Wave 1 landed** 2026-11-27 in main through PR #8 (https://github.com/interrobangc/risa/pull/8, main 4c8b956; tier none, tooling only; on an unsynced tip, main's 3 commits shared no file). Codex: one P2 (stack_hook under pipefail with a config in no checkout), fixed in 6100b8e, thread replied and resolved; then clean. Report filed; to-test `2026-11-27-1916-after-split-2.md`. Worktrees `-1` and `-2` removed. No docs to fold for wave 1 (no doc names where hooks run; the README sentence comes with slice 3).

**Next session: gate and land wave 2 (slice 3).** Slice 3 (configFor in machine.mjs, find_repo's RISA_CONFIG_FOUND mark, bin/risa backlog always the main checkout's config, test-env, README sentence) merged at e32da3c from 4b9fed8; its worktree was removed so `risa rotate` would run (a fix gets a fresh worktree from prd/after-split-2). Its slice check failed only on 6 load timeouts (land-unsynced, recover, stack; 111/111 alone). Steps: `risa sync`; full `risa check` (tier none) on the tip; `risa pr after-split-2` and `risa review after-split-2 --wait`; land; fold the PRD's decisions into the README sentence as the plan's _Docs at landing_ says; `risa rm after-split-2` last. RISA-972 is `ready` at e32da3c.

**Lessons:** this machine runs at load 20–35: the tooling suite times out in a handful of files that pass alone (RISA-1000, fixes-tooling, triaged); judge a red check by rerunning its failing files alone. Every commit on prd/ after `risa pr` makes Codex's verdict stale (a status-only commit too, and Codex doesn't pick it up by itself: `review --again`), so commit _Status_ before the push, not between review and land. `risa check` takes no reason for a full check.

## Architectural decisions

- **Tooling only:** `loops/`, `bin/risa`, the README and their tests. No new dependency, no runtime one, no `risa.json` key.
- **One mark:** `RISA_CONFIG_FOUND` holds the config path risa found itself; a `RISA_CONFIG` equal to it is risa's own choice, any other is a pin. Only `find_repo` (`loops/lib.sh`) sets it; `bin/risa`'s backlog branch reads it and always takes the main checkout's config over it; `rm.sh` re-points it; `loops/test-env.mjs` clears it.
- **Main-checkout state stays main's:** the backlog, registry, asks, sessions and leases never follow the config into a worktree.
- **No test reads this checkout's config or the machine's live state:** temp repos with a worktree, the fixture config, a temp machine config.

## How to run this plan

- **Waves:** wave 1 runs slices 1 and 2 at once (no shared file). Wave 2 is slice 3: it makes the worktree's config live, so stack hooks (1) and `rm` (2) must already not depend on which checkout the config is in.
- **Gate:** `risa check --quick "slice hand-off"` before each hand-off; `pnpm check` once on the merged tip at landing. No stack, no browser harness.
- **Models:** opus for all three (each changes how a command finds its repo).
- **Other topics:** fixes-tooling is running (hot: `loops/config`, `backlog/backlog`, `AGENTS.md`, `ci/…`, `loops/tooling-lint`); no slice here touches them. Held topics name `loops/lib.sh` (staging-ship) and `loops/rm.sh` (self-recovery-2); check `risa backlog prd list` at the wave boundary.
- **Docs at landing:** the README's sentence (slice 3); the PRD's decisions move into it.

## Slice 1: Stack hooks run from the main checkout wherever the config is

Stack: no · Reads: loops/docs/project-config.md · Tests: unit · Blocked by: none

**User stories:** US 4.

**Build:** `loops/hooks.mjs` `projectTop` and `loops/lib.sh` `stack_hook` find the top to run from as the main checkout of the repo the config file is in (the first `worktree` line of `git -C <config's folder> worktree list --porcelain`), else the config's folder when it is in no checkout, as today. `run_hook` (non-stack hooks) is unchanged: the top of the checkout the command runs in.

**Acceptance criteria:**

- Unit test in `loops/hooks.test.mjs`: the B-846 case gains a worktree of the temp project with its own `risa.json`; with `RISA_CONFIG` naming the worktree's file, `runHook("stackStatus")` and `stack_hook stackStatus` both report the main checkout's top.
- Unit test in `loops/hooks.test.mjs`. With the same config, lib.sh's run_hook for a non-stack hook run from the worktree reports the worktree's top.
- The existing cases (a config below the top, a config in no checkout) pass unchanged.

**Blocked by:** nothing. **Blocks:** 3.

## Slice 2: `rm` from inside a worktree whose config it reads

Stack: no · Reads: loops/docs/machinery.md · Tests: unit · Blocked by: none

**User stories:** US 5.

**Build:** `loops/rm.sh`, before `git worktree remove`: when `RISA_CONFIG` names a file under the worktree being removed (`$dir`), export `RISA_CONFIG` and `RISA_CONFIG_FOUND` as the main checkout's `risa.json` (`$main/risa.json`, the name `config.mjs` `CONFIG_NAME` gives), so the registry, hot-clearing and run-log steps after the removal load a config that exists.

**Acceptance criteria:**

- Unit test in `loops/stack.test.mjs` (`describe("rm.sh")`): a plan worktree with its own copy of the sample config, removed with `RISA_CONFIG` and `RISA_CONFIG_FOUND` naming that copy; rm exits 0, the worktree is gone, and nothing after the removal says the config is missing (no `no project config` line; the steps that load it, the run log's and the backlog tool's, ran).
- The existing `rm.sh` cases pass unchanged.

**Blocked by:** nothing. **Blocks:** 3.

## Slice 3: A worktree reads its own config

Stack: no · Reads: loops/docs/project-config.md · Tests: unit · Blocked by: 1, 2

**User stories:** US 1, 2, 3, 6.

**Build:**

- `loops/machine.mjs`: a new exported pure `configFor({ top, main, exists })` (the current checkout's `risa.json` when it exists, else the main checkout's); the `repo` verb uses it with the top of `--cwd`'s checkout (`git rev-parse --show-toplevel`), still printing two lines (main, config).
- `loops/lib.sh` `find_repo`: when the machine config lists the repo, export `RISA_CONFIG` and `RISA_CONFIG_FOUND` as the found path if `RISA_CONFIG` is unset or equals `RISA_CONFIG_FOUND`; otherwise leave `RISA_CONFIG` as it is. Its comment says so.
- `bin/risa`'s backlog branch: when `RISA_CONFIG` is unset or equals `RISA_CONFIG_FOUND`, take the main checkout's `risa.json` (the main checkout the repo verb prints first, joined with the config file name), never the worktree's; a pin stays.
- `loops/test-env.mjs` `SESSION_VARS`: add `RISA_CONFIG_FOUND`.
- `README.md`: one sentence after the machine config's: in a worktree, risa reads that worktree's `risa.json` (else the main checkout's) unless `RISA_CONFIG` pins another; stack hooks and the backlog stay the main checkout's.

**Acceptance criteria:**

- Unit test in `loops/machine.test.mjs`. The new configFor gives the worktree's file when it exists, the main checkout's when it doesn't, and the main checkout's from the main checkout.
- Unit test in `loops/machine.test.mjs` ("the bash side"): a temp repo listed in a temp machine config, with a worktree holding its own `risa.json`. Sourcing `lib.sh` from the worktree: with no `RISA_CONFIG`, it becomes the worktree's (and the mark the same); with `RISA_CONFIG` and `RISA_CONFIG_FOUND` both the main checkout's (a session's inheritance), it becomes the worktree's; with `RISA_CONFIG` the main checkout's and no mark, or any other path, it stays. A worktree without a `risa.json` gets the main checkout's. The existing `machine.mjs repo` case's expected output is unchanged for the main checkout.
- Unit test in `loops/machine.test.mjs`: `bin/risa backlog list` from the worktree, whose `risa.json` has a different `backlog.idPrefix`, with the inherited pair, lists the main checkout's ids (its config); with a pinned `RISA_CONFIG` it reads the pin.
- Unit test in `loops/machine.test.mjs`: `bin/risa doc planner` from the worktree, with the inherited pair, prints the worktree's planner additions, not the main checkout's.
- Unit test in `loops/test-env.test.mjs`. The mark (RISA_CONFIG_FOUND) doesn't come through.
- `risa check --quick "slice hand-off"` passes from the slice's own session (which has the inherited pair). Hand-off note, not a test: `risa doc loop` there read the slice's config.

**Blocked by:** 1, 2. **Blocks:** nothing.
