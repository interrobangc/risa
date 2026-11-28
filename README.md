# Risa

Risa runs Claude sessions in the repos a machine config names: an orchestrator per
PRD, a loop per slice, planners, a backlog captain and an inbox. It keeps worktrees,
leases and test stacks apart, and lands their work through a project's own checks.

Each repo has a `risa.json` (its trunk, branches, checks, hooks and test projects) and
its own backlog and plans. The machine config, `~/.risa/machine.json`, lists the repos
and says which ones may start work. In a worktree, risa reads that worktree's
`risa.json` (else the main checkout's) unless `RISA_CONFIG` pins another; stack hooks
and the backlog stay the main checkout's.

## Layout

- `loops/`: the orchestration: `prd.sh` (every command but the backlog), the
  sessions, worktrees, leases, landing and the dispatcher; `loops/docs/` holds the
  generic role docs, which a project's own additions extend
- `backlog/`: the backlog and the PRD registry (`backlog.mjs`)
- `ci/`: the CI parts a project's workflow calls (gates, verdicts, promotion)
- `loops/sample-project/`, `loops/fixture-project/`: the configs the tests run on
- `bin/risa`: the one command. `risa backlog …` is the backlog; any other
  `risa …` goes to `loops/prd.sh`

## Install a release

Risa needs git 2.28 or newer; the third step refuses an older one.

```sh
git -C ~/git/risa worktree add ~/.risa/releases/v0.1.0 v0.1.0   # or a clone at the tag
ln -sf ~/.risa/releases/v0.1.0/bin/risa ~/.local/bin/risa
node ~/.risa/releases/v0.1.0/loops/machine.mjs check
```

## Develop

Node 24 and pnpm 12.21.0. `pnpm install`, then `pnpm check` (prettier, eslint, the
docs budget and the tests). `pnpm test:browser-harness` runs the browser gate's test.
There are no runtime dependencies.
