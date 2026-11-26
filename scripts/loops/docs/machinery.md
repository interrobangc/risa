# Machinery

What runs `pnpm prd` (`scripts/loops/`).

## Worktrees and leases

- **`pnpm prd tidy`** lists leftovers as **safe** or **ask**. `--yes` removes the safe ones and reports the rest; `--json` lists. Never dirty worktrees, live caches, the main checkout, unmerged branches, sessions.
- `rm.sh <name>` removes the worktree, stack, database files and slot, and the branch if merged; it refuses uncommitted changes, or a PRD with slice worktrees left, unless `--force`; `--no-registry` leaves the registry alone.
