# Plan: usage-aware-drain

> Source PRD: [`plans/usage-aware-drain-prd.md`](usage-aware-drain-prd.md). User-story numbers (US) refer to it. Items RISA-814, RISA-1002. Topic `usage-aware-drain`. **Held** (`hold`) after two skeptic send-backs, until the user lifts it (`risa backlog prd set usage-aware-drain flags-=hold`).

## Status

| Slice | Wave | State | Merge into `prd/usage-aware-drain` |
| ----- | ---- | ----- | ---------------------------------- |
| 1     | 1    | —     | —                                  |
| 2     | 1    | —     | —                                  |
| 3     | 2    | —     | —                                  |
| 4     | 2    | —     | —                                  |
| 5     | 3    | —     | —                                  |
| 6     | 4    | —     | —                                  |

**Backlog:** claim each slice's items as it starts. Slice 1: RISA-814 (`done` when it merges). Slices 2 to 6: RISA-1002 (`done` after 6).

## Architectural decisions

- **Tooling only:** `loops/`, their tests, the README. No new dependency, no `risa.json` key; the new keys are the machine config's (`accounts`) and a new state file (`~/.risa/account.json`). With no `accounts`, every command behaves as today.
- **Pure decisions, thin CLIs:** the plan lookup, the link plan, the swap step and the automatic swap are pure functions over gathered facts (the `drain.mjs` `limitActions` and `resume.mjs` pattern); the CLI or the dispatcher gathers and acts.
- **Builds on RISA-927:** a session's account is its usage reading's `account` (`drain.mjs` `sessionAccount`), each account's drain is `sessionDrains`'. Slice 1 first checks `git merge-base --is-ancestor` that `sessionDrains` is in `main`; if it isn't, it stops and reports (the topic waits for `fixes-tooling`'s landing).
- **The default folder is the default account:** an account whose folder resolves to Claude Code's default (`~/.claude`) is chosen as `dir: null` (`CLAUDE_CONFIG_DIR` unset, `.claude.json` at `~/.claude.json`, readings with no `account`). Every account comparison goes through one normalizer, `loops/host.mjs` `claudeAccount`'s rule (slice 2 exports it as `accountKey(dir)`; slice 1 inlines the same rule through `claudeAccount` on a built env).
- **Never end a backlog, inbox or hand-opened session** for usage or a swap: report it (the user, 2026-11-27).
- **Hermetic tests:** temp folders for every Claude config folder and `.claude.json`; `RISA_MACHINE_CONFIG`, `RISA_ACCOUNT_STATE`, `RISA_USAGE_DIR` and the sessions folder set by each test; stub process tables. Never the real `~/.claude` or keychain.

## How to run this plan

- **Waves:** wave 1 runs slices 1 and 2 (no shared file). Wave 2 runs 3 and 4 (both after 2; 3 owns `loops/account-links.mjs` and `loops/machine.mjs`, 4 owns `loops/account.mjs` and `loops/context.mjs`). Wave 3 is slice 5 (after 1 and 4). Wave 4 is slice 6 (after 5: both change `loops/drain.mjs`, `loops/dispatch.mjs` and their tests; 6 also changes `loops/account.mjs`).
- **Gate:** `risa check --quick "slice hand-off"` before each hand-off; `pnpm check` once on the merged tip at landing.
- **Other topics:** this row's hot files (`loops/drain`, `loops/dispatch`, `loops/resume`, `loops/host`, `loops/machine`, `loops/account`, `loops/context`, `loops/rotate`, `loops/docs`, `loops/prd.sh`, `README.md`) collide with `fixes-tooling` (`loops/drain`, `loops/dispatch`, `loops/rotate`) and `self-recovery-2` (`loops/dispatch`, `loops/resume`, `loops/docs`, `loops/prd.sh`), so the dispatcher starts it only when neither runs. At each wave boundary read `risa backlog prd list`; no slice starts that would touch two running topics' hot files.
- **Docs:** the account commands are written up in `README.md` (no budget); each module's header comment says the rest. No role doc grows, except one clause in `loops/docs/recovery.md` (slice 5).

## Slice 1: The drain line follows the account's plan

Stack: no · Reads: none · Tests: unit · Blocked by: none

**User stories:** US 1, 2, 3.

**Build:** PRD _Implementation decisions_, _The plan's drain line_. In `loops/drain.mjs`: new `PLAN_LINES` and pure `drainLineFor(plan)` (Max 20x 97, Max 5x 95, Pro 90, else 95); new `planOf(account, env)` reading that account's `.claude.json` through `loops/host.mjs` `claudeState` (with `CLAUDE_CONFIG_DIR` set to the account, unset for null), returning `{ key, label }` or null on any missing file or field (an account given as the default folder `~/.claude` reads `~/.claude.json`, as null does); `drainSettings(env, plan)` takes the plan (an `RISA_USAGE_DRAIN` value wins; the drain line never above the stop line); `sessionDrains` uses each account's own plan's line (a `planOf` option, so tests pass a stub); the `why` texts and `node drain.mjs` name the plan and its line. `loops/dispatch.mjs` `drainOf` and `drainStep` pass the dispatcher's account's plan and `planOf`.

**Acceptance criteria:**

- Unit test (`loops/drain.test.mjs`): `drainLineFor` for each tier key, the organization-type fallback and an unknown plan; `planOf` on temp folders with a Max 5x, a Max 20x, a Pro and a missing `.claude.json`, and on the default account, given as null and as the `~/.claude` path (a temp `HOME`), both reading `~/.claude.json`; `drainSettings` with and without `RISA_USAGE_DRAIN`; `sessionDrains` with two accounts at 96%, one on Max 20x (normal) and one on Max 5x (draining), each `why` naming its plan.
- The existing drain tick tests in `loops/dispatch.test.mjs` pass unchanged (an unknown plan keeps 95%).

**Blocked by:** nothing. **Blocks:** 5.

## Slice 2: Accounts in the machine config, and `risa account`

Stack: no · Reads: README.md · Tests: unit · Blocked by: none

**User stories:** US 4, 5.

**Build:** PRD _Implementation decisions_, _Accounts in the machine config_. `loops/machine.mjs` `machineProblems` validates `accounts` (a list of at least two `{ name, dir }`, unique names, absolute or `~/` folders); new `accountsOf(machine)`. New `loops/account.mjs`: `accountStatePath(env)` (`RISA_ACCOUNT_STATE`, else `~/.risa/account.json`), `readAccountState`, `writeAccountState` (temp file, rename), pure `currentAccount(accounts, state)` (the state's account when listed, else the first), and the CLI `node account.mjs [status] [--json]`: each account with the current one marked, its plan and drain line (`drain.mjs` `planOf`, `drainLineFor` once slice 1 is in: until then the plan only), its merged reading (`usage.mjs` `readUsage` with that account), and each repo pinned by its own `claudeConfigDir`. `loops/host.mjs` `claudeChoiceFor` gains the current account's folder after the repo pin and before `risa.json`'s `claude.configDir` (source named "the current account (<name>)"); an account whose folder is the default one gives `dir: null`. New exported `accountKey(dir)` (null for the default folder, else the resolved folder), which `claudeAccount` uses. `loops/prd.sh` routes `account` to it, with a usage line. `README.md`: a short _Accounts_ section (the `accounts` key, status).

**Acceptance criteria:**

- Unit test (`loops/machine.test.mjs`): `accounts` with one entry, a duplicate name, a relative folder and an unknown key are each a problem; two good entries pass.
- Unit test (`loops/host.test.mjs`): `claudeChoiceFor` with `accounts` and a state naming the second picks its folder; a repo pin beats it; `RISA_CLAUDE_CONFIG_DIR` beats both; no `accounts` keeps today's choice; a current account at `~/.claude` (a temp `HOME`) gives `dir: null`, so `claudeEnv` unsets `CLAUDE_CONFIG_DIR`; `accountKey` of `~/.claude` and of `~/.claude/` is null.
- Unit test (`loops/account.test.mjs`, new): `currentAccount` with no state, a listed one and a removed one; the state file's round trip; `status --json` on a temp machine config and readings folder lists both accounts, the current one, the pinned repo.

**Blocked by:** nothing (shares no file with slice 1; it reads `planOf` only if slice 1 merged first). **Blocks:** 3, 4.

## Slice 3: `risa account setup` links the backup, and `machine check` checks it

Stack: no · Reads: README.md · Tests: unit · Blocked by: slice 2

**User stories:** US 6, 7.

**Build:** PRD _Implementation decisions_, _Linking the backup_. New `loops/account-links.mjs`: `SHARED` and `OWN` lists, pure `linkPlan({ main, backup })` over two folders' entry listings (each `{ name, kind: "file" | "dir" | "link", target? }`, and each main `projects/<slug>` with a `memory` folder) returning rows `link | linked | skip | own | unknown`; `readEntries(dir)`; `applyLinks(plan)` (makes `projects/<slug>` folders and the symlinks, nothing else); `linkProblems(machine)` for every account but the first. `loops/account.mjs` routes `setup <name>` to it and prints every row that isn't `linked`; refuses the first (main) account and an unknown name. `loops/machine.mjs` check prints `linkProblems`' missing links and skips as problems and unknown entries as notes. The module's header says what is shared and why (slice 4 writes the README lines, so the two slices share no file).

**Acceptance criteria:**

- Unit test (`loops/account-links.test.mjs`, new): on temp folders, a missing `settings.json` → link; an existing link to the main one → linked; a real `skills` folder in the backup → skip, untouched after `applyLinks`; `.claude.json` → own; a stray `foo.txt` → unknown; a main `projects/-x/memory` → the backup gets a real `projects/-x` and a `memory` link; a second `applyLinks` changes nothing.
- Script test (same file): `node account.mjs setup work` on a temp machine config links what's missing and prints the skip and unknown rows; then `node machine.mjs check` exits 0 with the unknown as a note; with a link removed, check reports it.

**Blocked by:** slice 2. **Blocks:** nothing.

## Slice 4: `risa account swap` and the hand-off line

Stack: no · Reads: loops/docs/orchestrator.md, loops/docs/backlog.md · Tests: unit · Blocked by: slice 2

**User stories:** US 8, 9.

**Build:** PRD _Implementation decisions_, _The swap_ (the command and the hand-off line). `loops/account.mjs`: `swap [<name>] [--why <text>]` writes the state (`from`, `account`, `at`, `why`, `auto: false`) through a pure `swapTarget(accounts, current, readings, { name, now })` (a named one must be listed and not current; no name: the other account with the lowest reading, unknown counting as usable); prints the target and what follows. New pure `handOffLine(kind, topic, from, to)`: the line per kind (orchestrator, planner, backlog, inbox) the PRD names. `loops/context.mjs` `runHook` (and `hookDecision`'s message): when `accounts` is set and the session's own account (`host.mjs` `claudeAccount`) isn't the current account's (both through `accountKey`), the hook's message carries `handOffLine` once per swap (the size record keeps the swap's `at` it told). `loops/rotate.sh` is unchanged: it already accepts any `--reason`, and only `context` waits for slices, so the orchestrator's line uses that path; a test pins it. `README.md`: setup and swap in the _Accounts_ section, and that the backlog session runs it on the user's word (the phone too).

**Acceptance criteria:**

- Unit test (`loops/account.test.mjs`): `swapTarget` by name, refusing the current one and an unknown one, and by lowest reading with one unknown; `swap work` writes the state with `from` and `why`.
- Unit test (`loops/context.test.mjs`): a session on the old account gets the hand-off line for its kind once, not on the next call, and again after a second swap; a session on the current account, and any session with no `accounts`, gets none.
- Unit test (`loops/rotate.test.mjs`): `--mid-wave --reason swap` isn't refused while a slice isn't handed off.

**Blocked by:** slice 2. **Blocks:** 5.

## Slice 5: The dispatcher finishes a swap

Stack: no · Reads: loops/docs/recovery.md · Tests: unit · Blocked by: slices 1, 4

**User stories:** US 10, 11, 12.

**Build:** PRD _Implementation decisions_, _The swap_ (the dispatcher's step). `loops/drain.mjs`: new `SWAP_ERROR` (`swap`) and pure `swapActions({ sessions, landing, stalls, readings, current, swap, reported, now, graceMs })`: the managed prd/plan sessions on the old account (a reading whose `pid` is the live session's pid and whose `account` isn't the current account's `accountKey`; a reading from an older pid, or none, counts as on the current account, since the folder is chosen at open, so a reopened session is never ended again) hold the tick (`holding: true`, a why naming them); past `RISA_SWAP_GRACE_MIN` (15) after the swap's `at`, each is `end` (then `kill` after `END_WAIT_MS`, as `limitActions`), a landing first `wait`s; backlog, inbox and hand-opened ones on the old account are one `report` per swap, never ended. `loops/dispatch.mjs` `drainStep` runs it when the state file names a swap; with `accounts` set, the dispatcher's own drain and `sessionDrains`' fallback take the current account (`account.mjs` `currentAccount`, through `accountKey`), never the dispatcher's environment, so new starts are judged by the account they will open on; marks each ended session stalled with `SWAP_ERROR` and the session's old account, and the pick treats `holding` as draining (no start, plan or reopen). `loops/resume.mjs` `resumeDecision`: a `swap` mark counts as reset at once (it never waits for the old account's reset), so the dead session is resumed with `--carry-on` on the current account, where `open-session` finds no transcript and opens it fresh. One clause in `loops/docs/recovery.md`'s _Resume after a limit_: a swap's mark resumes at once on the new account.

**Acceptance criteria:**

- Unit test (`loops/drain.test.mjs`): `swapActions` with an orchestrator and a planner on the old account within the grace → hold, no end; past it → end both, one running a landing waits; a backlog, an inbox and a hand-opened session on the old account → one report naming the three, then none on the next tick; every session on the current account → nothing and no hold; a null-account reading while the current account is the default folder (`~/.claude`) → not on the old account; a live orchestrator with a new pid whose reading still names the old account and an older pid, past the grace → no end and no hold; a session with no reading while the current account is the backup → no end.
- Unit test (`loops/resume.test.mjs`): a dead session with a `swap` mark whose old account's reset is hours ahead is resumed this tick; a `limited` mark with the same reset still waits.
- Tick test (`loops/dispatch.test.mjs`, beside "the drain"): a state file naming a swap and a stub orchestrator on the old account → the tick starts nothing; past the grace it ends the stub and marks it `swap`.

**Blocked by:** slices 1, 4. **Blocks:** 6.

## Slice 6: The automatic swap at 99%

Stack: no · Reads: none · Tests: unit · Blocked by: slice 5

**User stories:** US 13, 14.

**Build:** PRD _Implementation decisions_, _The automatic swap_. `loops/account.mjs` (not `drain.mjs`, which `account.mjs` imports: no cycle): new `SWAP_PERCENT` (99, `RISA_USAGE_SWAP`) and pure `autoSwapDecision({ accounts, current, drains, state, now, swapLine })`: the current account's 5-hour or weekly window at or over the swap line and a usable target (`account.mjs` `swapTarget`'s rule, leaving out an account an automatic swap left before its reset, from the state's `from` and `resetsAt`) → `{ swap: target, why }`; else null. The current account's reading is the current account's (`currentAccount` through `accountKey`), never the dispatcher's environment's. `loops/drain.mjs` `drainDecision` takes `backup: true` (a usable target): a window at the stop line is then `draining`, not `limited`; overage and stalls still limit. `loops/dispatch.mjs` `drainStep` runs the decision first each tick, writes the state (`auto: true`, the old account's reset as `resetsAt`) through `loops/account.mjs` `writeAccountState`, and files one report naming the window, the percent and the target; slice 5's step then moves the sessions.

**Acceptance criteria:**

- Unit test (`loops/account.test.mjs`): `autoSwapDecision` at 98% → null; at 99% on the 5-hour window with an unknown backup → swap; with the backup at its drain line → null; with the backup left by an automatic swap whose reset is ahead → null, and past that reset → swap. Unit test (`loops/drain.test.mjs`): `drainDecision` at 98% with `backup` → draining, without → limited; at 100% with `backup` → limited.
- Tick test (`loops/dispatch.test.mjs`): readings at 99% on the current account and a second account listed → the tick writes the state with `auto: true` and files one report; the next tick files none.

**Blocked by:** slice 5. **Blocks:** nothing.
