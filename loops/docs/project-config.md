# The project config and the core's line

How a project tells the core its facts (the config and its hooks), and where the line between the two runs.

## The slice's own check

`commands.testFile` runs the test files appended to it (Risa's `pnpm exec vitest run`; each project names its own runner). With it set, a slice whose plan names test files (`Check:`) gets a slice check of `commands.staticCheck` (typecheck, lint, format; else `commands.typecheck`) and those files, not the check hook. No `Check:` or no `testFile`: the hook. The full check stays at the wave's gate.
