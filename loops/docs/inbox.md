# Inbox session

For people and maintainers: the session itself never reads this doc. Its rules live in its prompt (`{{prd}} prompt inbox`), which stays short and self-contained.

## What it is

A session that helps the dev keeper add to and edit the inbox (`plans/inbox.md`), from a terminal or the phone. It only writes inbox lines; filing, triage, priority, holds and asks stay with the backlog session (`{{prd}} doc backlog`).

## Starting it

`{{prd}} inbox [--model <m>]` opens a session named `inbox` on Remote Control, through `session.sh --kind inbox`, on Opus at low effort, fast mode off (`--model` picks another for that session only).

- **Trust once.** The first time, Claude Code asks whether to trust the folder ("No, exit" is the default): choose Yes. Until then the dispatcher doesn't keep it open, and files one report naming the folder and `{{prd}} inbox`.
- **Always on:** the dispatcher (`{{prd}} doc machinery "The dispatcher"`) reopens a dead one and the context watch rotates it; its hand-off is `{{prd}} rotate --self`, keeping the folder. A reopen or rotation passes no `--model`, so it always comes up on `prd.sh`'s inbox model (Opus low), whatever an older record says.
- **Bye:** a message of just 'bye' runs `{{prd}} bye`; its own check (every idea added) is in its prompt.
- **One for every project:** with an inbox store (the config's `inbox` group), one session per machine, opened from the machine config's first repo with `inbox`. It routes each idea to the project named or implied (one line to ask when unclear) and writes with `node <tool>/backlog/inbox-store.mjs <verb> --project <name>`.
- **Ingest from a store:** `{{backlog}} ingest` files new lines (the item's note holds the line's key, so none twice) and drops a line from the store only once its item is on origin's trunk; the doctor names any left.
- **Its settings** come from `loops/inbox-settings.json`: the context hook settings (`context-settings.json`, kept in step by a test) plus `effortLevel: low` and `fastMode: false`.
