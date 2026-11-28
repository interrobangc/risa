# The project config and the core's line

How a project tells the core its facts (the config and its hooks), and where the line between the two runs.

**The slice's own check:** `commands.testFile` runs the test files appended to it (the project's own runner). With it set, a slice whose plan names test files (`Check:`) gets a slice check of `commands.staticCheck` (else `commands.typecheck`) and those files, not the check hook. Else the hook; the full check stays at the wave's gate.

**The inbox store:** the optional `inbox` group keeps a project's inbox in a private repo: `inbox.repo` its git URL, `inbox.file` its file there (default `<name>.md`). Only `backlog/inbox-store.mjs` touches its clone (`~/.risa/inbox-store/`, or `RISA_INBOX_STORE`). Without it: `paths.inbox`.

**A role's additions** (`roles.<role>.additions`) follow its generic doc, except a `## <Heading>` naming one of the doc's `##` headings: its body ends that section. A release that changes a doc's headings says so in `CHANGELOG.md`.
