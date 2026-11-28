# Plan: risa-next-4

> Source PRD: [`plans/risa-next-4-prd.md`](risa-next-4-prd.md). User-story numbers (US) refer to it. Items RISA-796, RISA-797 (its proof; the release half is `risa-next-5`). Topic `risa-next-4`.

## Status

| Slice | Wave | State                                         | Merge into `prd/risa-next-4` |
| ----- | ---- | --------------------------------------------- | ---------------------------- |
| 1     | 1    | landed 2026-11-28 (PR 38, main 9f54654; opus) | 952927e                      |
| 2     | 2    | merged 2026-11-28 (6a08b63; opus)             | dd41acb                      |
| 4     | 2    | merged 2026-11-28 (8bc5511; opus)             | ca49316                      |
| 3     | 3    | —                                             | —                            |
| 5     | 4    | —                                             | —                            |
| 6     | 5    | —                                             | —                            |

**From the user:** nothing yet beyond the start itself.

**Landing mode:** run everything through (started run-through, 2026-11-28): start every ready slice, land each green wave, ask only real questions through `risa ask`.

**Now (2026-11-28):** wave 1 landed in main through PR #38 (main at 9f54654, report a67). Wave 2 in flight: backlog ingested (nothing new), `risa sync` a skip, slices 2 and 4 started together (worktrees `risa-next-4-2` and `risa-next-4-4`, one opus agent each), `risa watch risa-next-4 --wait` running. After a crash: respawn each unmerged slice with `risa prompt slice risa-next-4 <n> --continue`. Next: merge 2 then 4 as they hand off, `risa tier` and `risa ci run <tier> --wait`, PR, Codex review, land, rotate. Before slices 3 and 5, check `risa backlog prd list` that no running topic holds `bin/risa`, `loops/rm.sh` or `loops/lib.sh` (`risa-next` is done; `fixes-bug` held `loops/new`, `loops/rotate`, `loops/open-session` on 2026-11-28).

**Slice 2 merged (dd41acb):** worktree kept until the wave is green. For slice 3: `machine.mjs repo` prints a `.risa/config.json` path in the folder form and exits 2 with one line when a checkout has both forms; `configFor` keeps an `exists` argument only so `machine.test.mjs` passes unchanged. Slice 4 still in flight.

**Slice 4 merged (ca49316):** wave 2 is all merged; `risa tier` says none, so the gate is the full `risa check` on the merged tip (running), then `risa pr`, Codex review, land. For slice 5: import `RULE_FILES` from `config.mjs` for the default names; a folder-form `loadConfig().config` is a copy, so migrate reads the file itself; `loops/docs/project-config.md` has 2 B of budget left (a slice adding to it trims elsewhere or raises it in `loops/docs-budget.mjs`).

**Lessons for the gate:** a full check takes no label: `env -u CLAUDE_CONFIG_DIR risa check > <log outside the worktree> 2>&1` in the background (about 8 minutes at load 20+), then `risa wait check`; with `CLAUDE_CONFIG_DIR` set, RISA-1076 fails about 20 tests. `loops/land-unsynced.test.mjs` can time out under load and passes alone. Commit _Status_ before `risa pr`: land refuses a local tip the PR's head trails.

**For slices 2 and 4 (from slice 1's hand-off):** both forms present throws from `configPath`, so callers outside `loadConfig` and `loadConfigOrExit` see a bare `ConfigError`; bash uses `node loops/config.mjs where <dir>` (exit 1 none, 2 both); `config get`'s error lines still say `risa.json:` on purpose. Wave 1 folded nothing into the docs: slice 4 writes the folder form into `loops/docs/project-config.md` (have it include the `where` verb).

**Slice models:** all six are coding with real logic: opus.

**Open issues:** none.

**Backlog:** claim each slice's item as it starts. Slices 1 to 4: RISA-796. Slice 5: RISA-796 (`done` after it) and RISA-797. Slice 6: RISA-797 (`done` after it).

## Architectural decisions

- **One module knows where the config is** (`loops/config.mjs`); every other file asks it (`configIn`, the `where` verb, `dump`'s `_path` and `_root`). No file outside it spells the folder's config path or builds `<dir>/risa.json`.
- **Additive:** `risa.json` loads as today; no key renamed or removed; no command's output changes; `init` and `config` are new commands. This repo's own `risa.json` and data files stay where they are (moving them needs a release first: PRD _Decisions_).
- **`root` is the repo's root in both forms,** so readers that join `paths.*` to it don't change.
- **Hermetic tests:** temp repos built by `loops/sample-project/repo.mjs` `makeRepo` or `loops/land-fixture.mjs`, `RISA_MACHINE_CONFIG` at a temp file, stub `gh` and claude; never this checkout's config.

## How to run this plan

- **Waves:** wave 1 is slice 1. Wave 2 runs slices 2 and 4 (both after 1; 2 owns the Node callers and `loops/sample-project/repo.mjs`, 4 owns `loops/config.mjs` and `loops/docs/project-config.md`). Wave 3 is slice 3 (the bash callers, after 2: `makeRepo`'s folder option). Wave 4 is slice 5 (after 3: `bin/risa`; after 4: the default names). Wave 5 is slice 6 (after 2 to 5: it runs them all).
- **Gate:** `risa check --quick "slice hand-off"` before each hand-off; `pnpm check` once on the merged tip at landing.
- **Other topics:** the row's hot files are `loops/config`, `loops/machine.mjs`, `loops/skeptics.mjs`, `loops/project-check`, `loops/sample-project/repo.mjs`, `bin/risa`, `loops/rm.sh`, `loops/lib.sh`, `loops/setup`, `loops/second-repo`, `loops/docs/project-config.md` and `README.md`. Two running topics hold some of them: `risa-next` (`loops/machine.mjs`, slice 2) and `fixes-bug`'s current wave (`bin/risa`, `loops/rm.sh`, `loops/lib.sh`: slices 3 and 5). The dispatcher starts this topic once both release them. Slice 2 meets only `risa-next`'s file and slice 3 only `fixes-bug`'s, so no slice spans two running topics. If `fixes-bug` takes those files again after this topic starts, the orchestrator holds slices 3 and 5 until its wave lands. Planned or held rows that meet these files: `usage-aware-drain` (`loops/machine`, `README.md`), `self-recovery-2` (`loops/rm.sh`) and `staging-ship` (`loops/lib.sh`).
- **Docs:** slice 4 writes the folder into `loops/docs/project-config.md`; slice 5 adds _Start a project_ to `README.md`; each new module's header comment says the rest.

## Slice 1: The loader finds the folder

Stack: no · Reads: loops/docs/project-config.md · Tests: unit · Blocked by: none · Check: loops/config.test.mjs

**User stories:** US 1, 2, 7.

**Build:** PRD _Implementation decisions_, _The config's place_ (the loader's part). In `loops/config.mjs`: two constants beside `CONFIG_NAME`, CONFIG_DIR and CONFIG_FILE (both new), holding the folder (.risa) and its file (config.json); `configIn(dir)` (new): `<dir>/.risa/config.json` when it exists, else `<dir>/risa.json` when it exists, else null; both present throws a `ConfigError` naming both. `configPath` uses it for the tool's own checkout and the installed-package case (falling back to `<toolRoot>/risa.json`, as now, when neither exists). `RISA_CONFIG` naming a folder resolves to that folder's config file. `loadConfig` returns `root` as the folder's parent when the file is `<x>/.risa/config.json`, else the file's folder (as now); its "no project config" line names both forms. The CLI gains `where [dir]` (prints `configIn`'s path, exit 1 when none) and `dump` prints `_root=` beside `_path=`. Update the header comment.

**Acceptance criteria:**

- Unit test (`loops/config.test.mjs`): `configIn` on temp dirs with the folder only, `risa.json` only, neither (null) and both (a `ConfigError` naming both paths); `configPath` with `RISA_CONFIG` a file, a `.risa` folder, and unset in a folder-form tool root; `loadConfig`'s `root` is the repo root in both forms; `where` prints each form's path and exits 1 with none; `dump` prints `_root`. Every existing case passes unchanged.

**Blocked by:** nothing. **Blocks:** 2, 4.

## Slice 2: The Node callers find the folder

Stack: no · Reads: loops/docs/project-config.md · Tests: unit · Blocked by: 1 · Check: loops/config-folder.test.mjs

**User stories:** US 1, 7.

**Build:** PRD _Implementation decisions_, _The config's place_ (the callers, Node's). Replace each `<dir>/risa.json` build with slice 1's `configIn`: `loops/machine.mjs` `configFor` (the checkout's own config in either form, else the main checkout's); `loops/skeptics.mjs` `readRules`'s default config; `loops/project-check.mjs` `projectProblems`'s default `path`. `loops/sample-project/repo.mjs` `makeRepo` gains `{ folder: true }`: it writes the config into the folder form. Touch nothing else in `loops/machine.mjs` (`risa-next` holds it).

**Acceptance criteria:**

- Unit test (`loops/config-folder.test.mjs` (new)), a folder-form sample repo and a temp machine config listing it: `machine.mjs repo --cwd` from the main checkout and from a worktree prints the right checkout and the folder's config (the worktree's own when it has one); `project-check.mjs` passes on the repo with `sampleData()`; `readRules(root)` reads it. A `risa.json`-form repo still passes each.
- `loops/machine.test.mjs` and `loops/project-check.test.mjs` pass unchanged.

**Blocked by:** 1. **Blocks:** 3, 6.

## Slice 3: The bash callers find the folder

Stack: no · Reads: loops/docs/project-config.md · Tests: unit · Blocked by: 2 · Check: loops/config-folder-sh.test.mjs

**User stories:** US 1, 7.

**Build:** PRD _Implementation decisions_, _The config's place_ (the callers, bash's). Replace each `<dir>/risa.json` build with `node config.mjs where <dir>` (slice 1): `bin/risa`'s backlog route (the listed repo's config); `loops/rm.sh`'s re-point of a config inside the removed worktree to the main checkout's; `loops/lib.sh` `stack_hook` (its fallback root from `_root`, not the config file's folder). These three are `fixes-bug`'s hot files: start only once its wave releases them.

**Acceptance criteria:**

- Unit test (`loops/config-folder-sh.test.mjs` (new)), a folder-form sample repo (`makeRepo` `{ folder: true }`, slice 2) and a temp machine config listing it: `bin/risa backlog list` from the main checkout and a worktree reads the sample backlog; `rm.sh` removing a worktree whose `RISA_CONFIG` points inside it re-points to the main checkout's folder config; `stack_hook` with a config in no checkout runs the hook from the repo root. A `risa.json`-form repo still passes each.

**Blocked by:** 2. **Blocks:** 5, 6.

## Slice 4: The test rules and gates by default name

Stack: no · Reads: loops/docs/project-config.md · Tests: unit · Blocked by: 1 · Check: loops/config-rules.test.mjs

**User stories:** US 3.

**Build:** PRD _Implementation decisions_, _The test rules and gates_. In `loops/config.mjs` `loadConfig`, after `configProblems` passes and only for the folder form: each of `paths.tierData`, `paths.checkPlanRules`, `paths.brakeList`, `paths.quarantine` left unset is set to its default name (PRD _Decisions_: tiers.json, check-plan.json, brake-list.txt and quarantine.txt in the folder) when that file exists under the root (one `RULE_FILES` (new) table). The raw parse is never written back. Write the folder form and the four names into `loops/docs/project-config.md` (within its docs budget).

**Acceptance criteria:**

- Unit test (`loops/config-rules.test.mjs` (new)), temp repos: a folder-form config with the four files gets the four paths in `loadConfig().config.paths` and in `dump`; a missing file leaves its key unset; a set key keeps its own path; a `risa.json`-form repo with the same files gets none. `ci/tier-data.mjs` `tierData` and `loops/check-plan.mjs` `checkPlanFor` read the defaulted files, and `source loops/lib.sh` in that repo gives `ci_lists` the brake list and quarantine.
- `pnpm docs:budget` passes.

**Blocked by:** 1. **Blocks:** 5, 6.

## Slice 5: `risa config migrate` and `risa init`

Stack: no · Reads: loops/docs/project-config.md · Tests: unit · Blocked by: 3, 4 · Check: loops/setup.test.mjs

**User stories:** US 4, 5.

**Build:** PRD _Implementation decisions_, _Migrate_ and _Init_. `loops/setup.mjs` (new), two verbs:

- `migratePlan({ root, raw })` (pure: the moves, the new JSON) and `migrate [--dry-run]`: checks the refusals (no repo, no `risa.json`, the folder present, a moved file dirty), runs `git mv` for each move, writes and stages the folder's config (two-space indent, final newline), prints one line per move and the commit to make; nothing is committed.
- `initFiles({ name, trunk, check })` (pure: path → text for the folder's config, the backlog with the PRDs heading and empty table in the form `backlog/backlog.mjs` parses, the inbox, the archive, `plans/`) and `init`: refuses when `configIn` finds either form or any file it would write exists, writes them, prints the machine config line (`{ "path": "<main checkout>", "work": true }`) and the commit to make.

Route `risa config migrate` and `risa init` in `bin/risa` to it, before `prd.sh` (they run on a repo `prd.sh` can't load a config for). Add a short _Start a project_ section to `README.md`.

**Acceptance criteria:**

- Unit test (`loops/setup.test.mjs` (new)), temp repos from `makeRepo`: a `risa.json` repo naming its tier data and quarantine by key becomes the folder form, those two moved to their default names, the two keys gone, `paths.tooling`'s `risa.json` now `.risa`, all staged, no commit; the result loads (slice 4's defaults give the same paths) and `config.mjs check` passes; a key naming a missing file is kept, unmoved; `--dry-run` changes nothing; each refusal exits 2 with one line and changes nothing.
- The same file: `init --name acme --trunk trunk --check "make check"` in a temp git repo writes the files; the config passes `config.mjs check`; `backlog/backlog.mjs list` and `doctor` pass on the new backlog; the id prefix is `ACME`; a second run, a repo with `risa.json`, and a repo with an existing `plans/backlog.md` each exit 2 changing nothing; a bad `--name` exits 2 with the loader's line.

**Blocked by:** 3, 4. **Blocks:** 6.

## Slice 6: The second repo, end to end

Stack: no · Reads: loops/docs/project-config.md · Tests: unit · Blocked by: 5 · Check: loops/second-repo.test.mjs

**User stories:** US 6.

**Build:** PRD _Implementation decisions_, _The proof_. One test file on `loops/land-fixture.mjs`'s prior art (a bare origin, stubbed `gh`, the `RISA_PR_THROWAWAY` seam, stub claude through `RISA_CLAUDE_BIN`): a fresh fictional repo (`make`-based, trunk `trunk`, no Node project) gets `risa init`, the folder's four rule files, a `Makefile` whose `check` passes, and a temp machine config listing it; then `config.mjs check`, `project-check.mjs`, `risa backlog add`, `risa backlog prd add`, a PRD worktree and a slice worktree (`risa start`'s worktree step or `new.sh prd` then `new.sh slice`, with no session opened), a change and `risa check` in it, the slice merged into its PRD branch as an orchestrator does, then `risa land <topic>` run to the `RISA_PR_THROWAWAY` seam's "every refusal passed" line (the topic's name must contain `throwaway`, `lib.sh`'s seam rule; the seam stops before the merge). `land-fixture.mjs`'s `gh` stub hard-codes `prd/` and `dev`: add a trunk- and prefix-aware stub beside the test (`loops/second-repo-gh.sh` (new)) rather than change the fixture. A second case migrates a `risa.json` copy of the same repo (slice 5) and runs the same `risa check`. A fixture gap that needs a code change outside the test is the hand-off's, not this slice's: stop and report it.

**Acceptance criteria:**

- Unit test (`loops/second-repo.test.mjs` (new)): every step exits 0 and `risa land` reaches the seam's "every refusal passed" line; the backlog shows the item with the topic; the migrated copy's check passes. Offline, no `~/.risa`.

**Blocked by:** 2, 3, 4, 5. **Blocks:** nothing.
