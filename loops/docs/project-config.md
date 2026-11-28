# The project config and the core's line

How a project tells the core its facts (the config and its hooks), and where the line between the two runs.

**Where:** `.risa/config.json`, else `risa.json` (not both); `config.mjs where [dir]` prints it. In `.risa/`, an unset `paths.tierData`, `checkPlanRules`, `brakeList` or `quarantine` is `tiers.json`, `check-plan.json`, `brake-list.txt` or `quarantine.txt` when present.

**The slice's own check:** `commands.testFile` runs appended test files: a plan's `Check:` files, after `commands.staticCheck` (else `typecheck`), not the check hook.

**The inbox store:** an `inbox` group (`inbox.repo`: a private repo; `inbox.file`, default `<name>.md`) replaces `paths.inbox`; only `backlog/inbox-store.mjs` touches its clone (`~/.risa/inbox-store/` or `RISA_INBOX_STORE`).

**A role's additions** (`roles.<role>.additions`) follow its generic doc, except a `## <Heading>` naming one of the doc's: its body ends that one. A release changing its headings says so in `CHANGELOG.md`.
