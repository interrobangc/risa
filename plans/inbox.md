# Inbox

Add anything here: one line per item, under the heading that fits. Indent extra lines under it for details. Save; that's all.

Agents file each new line into the tracker ([backlog.md](backlog.md)) and add its id, like `(RISA-12)`. To change something already filed, add a new line saying so.

## Bugs/Nits

- risa plan --help takes --help as a topic: it made worktree .loops/plan---help and branch plan/--help (RISA-1070)
  From Caretook's backlog at the Caretook user's request. risa plan --help created worktree .loops/plan---help on a new branch plan/--help, ran pnpm install and printed a start command (cleaned up with risa rm plan---help). Work out how to prevent it. Suggestions: --help/-h on every subcommand prints usage and exits 0; topic names must match the slug pattern (lowercase words and dashes, no leading dash) before any worktree or branch is made; unknown flags refuse. Caretook pins v0.2.0: notify backlog (caretook) when it ships in a tagged release.
- inbox session refuses a rollover hand-off the backlog session asks for, so the user has to exit it by hand
  During the account rollover (2026-11-28 ~12:29) the backlog session (Admiral Marcus) told the risa inbox session to run risa rotate --self because the business account's 5h usage was at 93%. The inbox agent declined: its prompt lets it hand off only on the user's word or a context-watch reminder, never on a peer's request. The user had to exit it and let the dispatcher's keep-alive reopen it. Expected: a rollover or rotate request from the project's backlog session (or a dispatcher-driven rollover) rotates the inbox session without the user. Transcript: ~/.claude/projects/-Users-bo--risa-inbox/9d2e8124-bba2-4375-9338-3b1cf0a4ee63.jsonl

## Change requests

- Split Risa's slow tooling tests (recover, then rotate, dispatch) along their describe groups with a fixture module (RISA-1066)
  As land.test.mjs/land-fixture.mjs were. Suggested by Caretook (prd-test-time-gates-2) as a sibling of the time-gate quiet-rule item; no longer Caretook's concern.

## Features

- A "replan" state on a PRD registry row: the dispatcher sends that topic back to its planner (before it runs or between waves) to replan the whole PRD (RISA-998)
- risa account setup|use|status: set up a second Claude config folder, point a repo's sessions at it, and show which account each runs on (RISA-1074)
  From Caretook's backlog (the user chose to file it, 2026-11-28). Replaces Caretook's local .local/account-switch/switch-account.sh, which still calls Caretook's old scripts/loops/machine.mjs and host.mjs (moved to Risa in the split), so its use and status fail. setup: mkdir the folder, symlink settings.json, skills, plugins, CLAUDE.md and each projects/<slug>/memory from ~/.claude (skip real files), then tell the user to log in with CLAUDE_CONFIG_DIR=<dir> claude. use: set or drop claudeConfigDir for a repo in ~/.risa/machine.json (machine.mjs, host.mjs claudeChoiceFor), with dispatch pause, hand-offs and resume. status: the folder and login per repo. Usage readings follow the folder: keep every session on one account at a time. Sibling of RISA-1002 (backup account at 99%).
