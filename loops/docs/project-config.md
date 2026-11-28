# The project config and the core's line

How a project tells the core its facts (the config and its hooks), and where the line between the two runs.

**The slice's own check:** `commands.testFile` runs the test files appended to it (the project's own runner, e.g. its test runner's `run`; Risa's is in its `risa.json`). With it set, a slice whose plan names test files (`Check:`) gets a slice check of `commands.staticCheck` (typecheck, lint, format; else `commands.typecheck`) and those files, not the check hook. No `Check:` or no `testFile`: the hook. The full check stays at the wave's gate.

**The inbox store:** the optional `inbox` group moves a project's inbox off the trunk, into a private repo: `inbox.repo` is its git URL, `inbox.file` the project's file there (default `<name>.md`, the trunk inbox's format). `backlog/inbox-store.mjs` is the only code that knows its clone (under `~/.risa/inbox-store/`; `RISA_INBOX_STORE` names another folder). Without the group the inbox is `paths.inbox`, as before.

**A role's additions** (`roles.<role>.additions`) follow its generic doc, except a `## <Heading>` naming one of the doc's `##` headings: its body ends that section. A release that changes a doc's headings says so in `CHANGELOG.md`.
