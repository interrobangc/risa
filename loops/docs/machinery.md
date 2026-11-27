# Machinery

What runs `{{prd}}` (`loops/`).

## Worktrees and leases

- **`{{prd}} tidy`** lists leftovers as **safe** or **ask**. `--yes` removes the safe ones and reports the rest; `--json` lists. Never dirty worktrees, live caches, the main checkout, unmerged branches, sessions.
- `rm.sh <name>` removes the worktree, stack (`stackDown`: a failure stops it, the worktree kept), test database and slot, and the branch if merged; it refuses uncommitted changes, or a PRD with slice worktrees left, unless `--force`; `--no-registry` leaves the registry alone.
