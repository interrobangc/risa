# Hotfix handbook

- **Starting:** a session in the main checkout runs `pnpm prd hotfix <name>` and from then on works only in the worktree, with absolute paths. For a fresh session, `pnpm prd hotfix <name> --open "<the fix>"` (without `--open` it prints the command). A session started that way is recorded, and `pnpm prd open hotfix-<name>` reopens it with `--continue`; one worked in the asking session stays unrecorded.
- **Talk it through first** when the fix is a judgement call: summarise what's there, then ask with AskUserQuestion.
- Background agents are allowed, in the hotfix worktree only.
- **Named tests only**, when the user asks: run the tests the fix changed and those that directly cover it, plus typecheck, lint and format; list them; land with `--force --by-user` only on their word. First update tests asserting an exact shape you changed.
- Backlog items go through `pnpm backlog`, never edits on the branch.
- **Bye:** a message of just 'bye' runs `pnpm prd bye` after your own checks: the fix landed, or the user knows `hotfix/<name>` holds it unlanded.
