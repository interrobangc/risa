# PRD: usage-aware-drain

Items RISA-814 (the drain line follows the account's Claude plan) and RISA-1002 (a backup Claude account the machine swaps to). Topic `usage-aware-drain`. Plan: [`plans/usage-aware-drain-plan.md`](usage-aware-drain-plan.md).

## Decisions

| Decision                                                                                                                                                                                                                                                            | Why                                                                                                                                        | Source                                  | Cost to change later                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | ---------------------------------------------- |
| With a backup account ready, the current account's stop line (98%) holds new work but doesn't end sessions; the swap line (99%) moves them, and overage (100%) still ends them                                                                                      | the user's 99% only means something if the 98% stop hasn't already ended everything                                                        | assumed                                 | medium: the drain's limited rule and its tests |
| A swap never ends a backlog or inbox session, nor one opened by hand: each is told to hand off, and one report names any still on the old account                                                                                                                   | the user doesn't want backlog or inbox sessions killed over usage (2026-11-27)                                                             | preference (user, fixes-tooling wave 3) | medium: the swap step                          |
| A managed orchestrator or planner still on the old account 15 minutes after a swap is ended the way the limited stop ends it (a landing finishes first) and reopened fresh on the new account                                                                       | a swap is a hand-off (the user, 2026-11-27); the reopen finds no transcript there, so it starts from the resume prompt                     | assumed                                 | low: one constant                              |
| An account whose folder is Claude Code's default (`~/.claude`) is the default account: `CLAUDE_CONFIG_DIR` unset, its `.claude.json` at `~/.claude.json`, its readings' account null; every account comparison goes through one normalizer (`claudeAccount`'s rule) | setting the variable to `~/.claude` makes Claude Code read another `.claude.json` and keychain entry: a signed-out third account (skeptic) | assumed                                 | low                                            |
| The current account lives in a state file (`~/.risa/account.json`), never written into `machine.json`                                                                                                                                                               | the tool never rewrites the user's own file                                                                                                | assumed                                 | low                                            |
| The machine config names accounts as a list (`accounts: [{ name, dir }]`); the first is the main one the others link to and the default current one                                                                                                                 | an order is needed for "the main one" and "the other one"                                                                                  | assumed                                 | medium: a machine config key                   |
| A repo's own `claudeConfigDir` still wins over the current account (a pin a swap doesn't move; status and check say so)                                                                                                                                             | existing machine configs keep their meaning                                                                                                | assumed                                 | low                                            |
| Drain lines by plan: Max 20x 97%, Max 5x 95%, Pro 90%, any other or unknown plan 95% (today's); `RISA_USAGE_DRAIN` still sets one line for every plan                                                                                                               | a bigger plan's last few percent hold more work; 95% stays where the user set it                                                           | assumed                                 | low: one table                                 |
| The plan is read from the account's own `.claude.json` (`oauthAccount`: rate-limit tier, else organization type), never from the keychain or the network                                                                                                            | it is already on disk per config folder, and per account                                                                                   | assumed                                 | low                                            |
| The swap's target is the other account with the lowest reading (an unknown reading counts as usable); an automatic swap never goes back to an account it left until that account's reset passes                                                                     | no ping-pong between two tired accounts                                                                                                    | assumed                                 | low                                            |
| Transcripts stay per account; a swapped session reopens fresh from its hand-off                                                                                                                                                                                     | the user, 2026-11-27 (revisit once jobs survive hand-offs, RISA-913)                                                                       | preference (RISA-1002 notes)            | high: a later topic                            |
| `risa account setup` links only the entries it knows to share and never replaces a real file or folder: it skips and reports it                                                                                                                                     | no data loss in the backup folder                                                                                                          | assumed                                 | low                                            |

**The skeptics** sent it back twice. The first added the default-folder row above, the `loops/rotate` and `loops/docs` hot files, and dropped a no-op `rotate.sh` edit. The second found that a reopened session keeps its old reading, so the swap could end it again and again: only the live pid's reading counts, and the dispatcher judges by the current account. The topic is held (`hold`) until the user lifts it.

Nothing was asked: no item is dropped, no project's `risa.json` key changes, no existing data changes meaning, no dependency is added.

## Problem

The drain stops new work at one fixed 95% whatever Claude plan the account has, so a small plan drains too late and a large one too early. And when an account runs out, every session on the machine waits for its reset, though the user has a second account (work or personal) that could carry on; moving to it today is a hand-run local script, steps from memory, on one machine only.

## Solution

The drain line follows each account's plan, read from that account's own Claude Code files. The machine config names the accounts; `risa account` shows them, sets up the backup's shared files (memory, settings, skills and the rest, by link) and swaps: on the user's word, or by itself when the current account reaches 99%. A swap holds new work, tells each session to hand off, reopens the orchestrators and planners that didn't on the other account, and resumes there.

## User stories

1. As the user, I want the drain line picked from the account's plan, so that a small plan stops early enough and a large one doesn't stop too soon.
2. As the user, I want `risa drain` and the drain's reasons to name the plan and its line, so that I can see why work held.
3. As the user, I want to override the line for every plan with `RISA_USAGE_DRAIN`, as today, so that a run I care about isn't held.
4. As the user, I want the machine config to name my Claude accounts, so that Risa knows the backup.
5. As the user, I want `risa account` to show each account, which is current, its plan, its usage and which repos are pinned, so that I know where sessions will open.
6. As the user, I want `risa account setup <name>` to link the backup folder's shared entries to the main one and `machine check` to check them, so that memory and settings are the same on both accounts.
7. As the user, I want setup to name entries it doesn't know and to skip real files instead of replacing them, so that nothing in the backup folder is lost.
8. As the user, I want `risa account swap [<name>]` (from the phone through the backlog session too), so that I can move the machine to the other account.
9. As an orchestrator, planner, backlog or inbox session, I want to be told the account changed and how to hand off, so that I move with my work written down.
10. As the user, I want new starts and plans held while managed sessions are still on the old account, so that nothing new opens on it.
11. As the user, I want an orchestrator or planner that didn't hand off to be ended at a safe point and reopened fresh on the new account, so that the swap finishes unattended.
12. As the user, I want backlog, inbox and hand-opened sessions never ended by a swap, only named in one report, so that I keep my go-between.
13. As the user, I want the machine to swap by itself when the current account reaches 99% on its 5-hour or weekly window and a backup is usable, so that unattended work carries on without extra usage.
14. As the user, I want an automatic swap filed as one report, and never a swap back to an account still before its reset, so that I see what happened and it doesn't ping-pong.

## Implementation decisions

### The plan's drain line

- A pure lookup from a plan to its drain line (the table above), and a reader that takes an account (a config folder, null for Claude Code's default) and returns its plan, from that account's `.claude.json` (`oauthAccount.organizationRateLimitTier`, else `organizationType`), null when the file or field is missing. The reader goes through the host layer's existing state-file path for a config folder.
- The drain's settings take the plan: the line is `RISA_USAGE_DRAIN` when set, else the plan's line; the stop line stays 98% (`RISA_USAGE_STOP`). The per-session drains (RISA-927's `sessionDrains`, per account) use each account's own plan's line.
- The drain's `why` text and its CLI name the plan and the line ("Max 5x: drain line 95%").

### Accounts in the machine config

- `machine.json` gains `accounts`: a list of `{ name, dir }`, at least two, names unique (`[A-Za-z0-9_-]+`), `dir` absolute or `~/…`; the first is the main account. Unknown keys stay errors.
- An account's folder is normalized once (`claudeAccount`'s rule): Claude Code's default folder is the default account, whose choice is `dir: null` (the variable unset), whose `.claude.json` is `~/.claude.json` and whose readings carry no `account`. The plan reader, the folder choice and the old-account test all use it.
- The current account: `~/.risa/account.json` (`RISA_ACCOUNT_STATE` overrides; empty means none) holds `{ account, from, at, why, auto }`. Missing, or naming an account no longer listed: the first account.
- The config folder choice becomes, first found wins: `RISA_CLAUDE_CONFIG_DIR`, the repo's own `claudeConfigDir` (a pin), the current account's folder, `risa.json`'s `claude.configDir`, Claude Code's default. With no `accounts`, nothing changes.
- `risa account` (`status`, the default): each account, the current one marked, its plan and drain line, its merged usage reading, and each repo pinned to a folder.

### Linking the backup

- A pure link plan: given the main folder's and the backup folder's entries, each entry is `link` (shared and missing in the backup), `linked` (already a link to the main one), `skip` (a real file or folder in the backup: reported, never replaced), `own` (known to stay per account) or `unknown` (named, left alone).
- Shared: `CLAUDE.md`, `settings.json`, `keybindings.json`, `skills`, `agents`, `commands`, `plugins`, `hooks`, and each `projects/<slug>/memory` the main folder has (the backup's `projects/<slug>` made as a real folder). Per account: `.claude.json`, `.credentials.json`, the rest of `projects/`, `history.jsonl`, `file-history`, `session-env`, `sessions`, `shell-snapshots`, `backups`, `cache`, `statsig`, `todos`, `ide`, `plans`, `downloads`. The sign-in (keychain) is never touched.
- `risa account setup <name>` applies the plan's `link` rows and prints every row that isn't `linked`; `machine check` reports each backup's missing links and skips (problems), and unknown entries (notes).

### The swap

- `risa account swap [<name>] [--why <text>]` writes the state file (`from`, the new `account`, `at`, `why`; `auto: false`) and prints what will happen; no name takes the target rule above; the current account is refused.
- A session is on the old account when its usage reading, written by its live pid, names another account than the current one (RISA-927's `account`, through the one normalizer); a reading from an older pid, or none, counts as the current account, since the folder is chosen at open. With `accounts` set, the dispatcher judges new starts by the current account, never its own environment's. The context hook a session already runs adds, once per swap, a line to that session: the account moved, and its hand-off (orchestrator: commit _Status_, then `risa rotate --mid-wave --reason swap`; planner: commit and push its branch, then end; backlog: `risa rotate --self --brief <file>`; inbox: `risa rotate --self`). A rotation reopens on the current account, since the folder is chosen at open.
- The dispatcher's swap step (pure decision, dispatcher acts): while any managed prd or plan session is on the old account, no start, plan or reopen (as draining); after `RISA_SWAP_GRACE_MIN` (15) from the swap, each such session is ended as the limited stop ends it (a landing first finishes), marked with the stall error `swap`; the resume treats a `swap` mark as already reset and reopens it with the carry-on path, which on the new account finds no transcript and opens fresh with the resume prompt. Backlog, inbox and hand-opened sessions on the old account are named in one report per swap, never ended.

### The automatic swap

- A pure decision: with `accounts` set, the current account's reading at or over `RISA_USAGE_SWAP` (99) on its 5-hour or weekly window, and a usable target (another account whose reading is under its own drain line or unknown, and not left by an automatic swap before its reset): swap, with `auto: true` and the window and percent as `why`, and one report.
- With a usable target, the current account's stop line counts as draining, not limited (no session ended on percent alone); a stall or overage still limits. With none, today's rules hold.

## Testing decisions

- Unit tests on the pure parts, each module's own test file: the plan lookup and the plan reader (a temp `.claude.json` per folder), the drain settings and `sessionDrains` with two accounts on two plans (`loops/drain.test.mjs`); the machine config's `accounts` validation (`loops/machine.test.mjs`); the folder choice's new order (`loops/host.test.mjs`); the state file and status (`loops/account.test.mjs`, new); the link plan on temp folders (`loops/account-links.test.mjs`, new); the hand-off line (`loops/context.test.mjs`); the swap step and the automatic swap decision (`loops/drain.test.mjs`); a `swap` mark's resume (`loops/resume.test.mjs`).
- One script-level test per command on temp folders (`RISA_MACHINE_CONFIG`, `RISA_ACCOUNT_STATE`, `RISA_USAGE_DIR` set by the test), in the module's own test file. No real `~/.claude`, no keychain, no network.
- The dispatcher's wiring gets one tick test each for the swap step and the automatic swap, in `loops/dispatch.test.mjs`, beside the existing drain tick tests.

## Out of scope

- Sharing transcripts across accounts, or resuming a conversation on the other account (the user: revisit after RISA-913).
- Signing in to an account (`/login` stays by hand), and anything in the keychain.
- Per-task usage overrides (RISA-813, `fixes-tooling`).
- More than one current account at once (each repo on a different account), beyond the existing per-repo pin.
- The phone app's account.

## Notes

- This topic builds on RISA-927 (`sessionDrains`, each reading's `account`, `stalledSessions`), merged on `prd/fixes-tooling`; slice 1 checks it is in `main` first.
- Caretook's local `switch-account.sh` (RISA-1002's notes) is the prior art for the link list and the steps; Caretook's machine keeps its repo pin until its user moves to `accounts`.
