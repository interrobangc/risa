# Machinery

What runs `{{prd}}` (`loops/`).

## The context watch

- prd, backlog, inbox and plan sessions; a planner lands or hands over.

## Worktrees and leases

- **`{{prd}} tidy`** lists leftovers **safe** or **ask**; `--yes` removes the safe ones. Never dirty worktrees, the main checkout, unmerged branches, sessions.
- `rm.sh <name>` removes worktree, stack, test database, slot, merged branch; refuses uncommitted work or slice worktrees left, unless `--force`. Rotate runs it for a landed standing topic with nothing runnable.
