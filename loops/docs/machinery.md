# Machinery

What runs `{{prd}}` (`loops/`).

- **`{{prd}} tidy`** lists leftovers **safe** or **ask**; `--yes` removes the safe ones. Never dirty worktrees, live caches, the main checkout, unmerged branches, sessions.
- `rm.sh <name>` removes worktree, stack (a `stackDown` failure keeps it), test database, slot, merged branch; refuses uncommitted changes or slice worktrees left, unless `--force`.
- **Context watch:** prd, backlog, inbox and plan sessions; a planner is told to land or hand over.
- **Rotate** of a standing topic with nothing runnable runs `rm.sh` instead.
