# Inbox session

For people and maintainers: the session itself never reads this doc. Its rules live in its prompt (`{{prd}} prompt inbox`), which stays short and self-contained.

## What it is

A session that helps the dev keeper add to and edit the inbox (`plans/inbox.md`), from a terminal or the phone. It only writes inbox lines; filing, triage, priority, holds and asks stay with the backlog session (`{{prd}} doc backlog`).

## Starting it

`{{prd}} inbox [--model <m>]` opens a session named `inbox` on Remote Control (`session.sh --kind inbox`), on Opus at low effort, fast mode off.

- **Trust once.** Claude Code first asks to trust the folder (default "No, exit"): choose Yes. Until then the dispatcher doesn't keep it open, and files one report naming the folder.
- **Always on:** the dispatcher (`{{prd}} doc machinery "The dispatcher"`) reopens a dead one and the context watch rotates it; its hand-off is `{{prd}} rotate --self`, keeping the folder. A reopen or rotation passes no `--model`: it comes up on `prd.sh`'s inbox model.
- **Bye:** just 'bye' runs `{{prd}} bye`; its check (every idea added) is in its prompt.
- **One for every project:** with an inbox store (the `inbox` group), one session per machine, kept by the machine config's first `work: true` repo with `inbox` while this machine is the `inbox` home (`{{prd}} home`). It routes each idea to the project named or implied and writes with `node <tool>/backlog/inbox-store.mjs <verb> --project <name>`.
- **Moving to a store:** `{{backlog}} inbox to-repo <git url>` (private) moves the unfiled lines to `<name>.md` there, then one trunk commit sets `inbox` and drops the trunk inbox.
- **Ingest from a store:** `{{backlog}} ingest` files new lines (its note holds the line key: none twice) and drops a line from the store only once its item is on origin's trunk; the doctor names any left.
- **Its settings** come from `loops/inbox-settings.json`: the context hook settings (`context-settings.json`, kept in step by a test) plus `effortLevel: low` and `fastMode: false`.
