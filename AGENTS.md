# Risa: Project Context

Risa runs Claude sessions in the repos a machine config names (README.md). This repo is
Risa's own code, and a configured repo of its own (`risa.json`): its sessions read the
generic role docs in `loops/docs/` (`risa doc <role>`), with two additions: the planner's _What to ask_ (`docs/planner.md`), which the skeptic brief reads, and the backlog's _Fix topics_ (`docs/backlog.md`).

## Working rules

- **Build only what the user asks for.** Planned work is in `plans/backlog.md`; start an
  item only when the user says so. Work here is off by default on every machine
  (`tool.self`): `"work": true` for this repo in `~/.risa/machine.json`, or
  `RISA_WORK_SELF=1` for one shell, turns it on.
- **No new dependencies without the user's approval**, and no runtime dependencies at
  all: projects install Risa from a git tag. Pin dev dependencies exactly.
- **Commit only when the user explicitly asks.** Exceptions: loops on their `slice/`
  branch; `risa backlog`; an orchestrator's `risa land` on the user's word.
- **`main` is the trunk and the only long-lived branch.** `prd/`, `slice/`, `plan/` and
  `hotfix/` branches land into `main` by PR. There is no `dev` and no `staging`.
- **Checks:** `pnpm check` (prettier, eslint, the docs budget and headings, the tests) before handing
  off. GitHub Actions (`.github/workflows/ci.yml`) runs the same `pnpm check` on pushes
  and PRs to `main` and on `risa ci run`'s `ci/` refs.
- **Commit subjects are Conventional Commits:** `<type>(<scope>)!: <description>`, backlog
  ids in parentheses at the end (`RISA-n`).
- **Releases are tags** (`v0.1.0`), cut after bumping `package.json`'s version to
  match. A project pins one exactly; a change breaking its config or commands says so
  (`!`, `BREAKING CHANGE:`).
- **All test data is fictional.** The sample and fixture projects stand in for a real one.

## Ids

Items moved in from Caretook kept their numbers: `B-772` there is `RISA-772` here, and a
lookup reads either (`backlog.formerIdPrefix`). New ids start above Caretook's highest.

## Layout

`loops/` (orchestration, `prd.sh`, role docs in `loops/docs/`), `backlog/` (the backlog and
PRD registry), `ci/` (CI parts a project's workflow calls), `bin/risa` (the command).
