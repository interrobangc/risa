# Inbox session

For people and maintainers: the session itself never reads this doc. Its rules live in its prompt (`{{prd}} prompt inbox`), which stays short and self-contained.

## What it is

A session that helps the dev keeper add to and edit the inbox (`plans/inbox.md`), from a terminal or the phone. It only writes inbox lines; filing, triage, priority, holds and asks stay with the backlog session (`{{prd}} doc backlog`).

## Starting it

`{{prd}} inbox [--model <m>]` opens a session named `inbox` on Remote Control, through `session.sh --kind inbox`, on Opus at low effort, fast mode off, for fast, accurate replies (`--model` picks another for that session only).

- **Trust once.** The first time, Claude Code asks whether to trust the folder ("No, exit" is the default): choose Yes. Until then the dispatcher doesn't keep it open, and files one report naming the folder and `{{prd}} inbox`.
- **Always on:** the dispatcher (`{{prd}} doc machinery "The dispatcher"`) reopens a dead one and the context watch rotates it; its hand-off is `{{prd}} rotate --self`, keeping the folder. A reopen or rotation passes no `--model`, so it always comes up on `prd.sh`'s inbox model (Opus low), whatever an older record says; no dispatcher restart needed.
- **Bye:** a message of just 'bye' runs `{{prd}} bye`; its own check (every idea added) is in its prompt.
- **One for every project:** with an inbox store (the config's `inbox` group), it is one session per machine, opened from the machine config's first repo with `inbox` whichever project runs `{{prd}} inbox`. Its prompt lists the store's projects, puts each idea in the one the user names or its words point to, asks in one line when unclear, and writes with the store CLI (`node <tool>/backlog/inbox-store.mjs <verb> --project <name>`), a project on another machine too.
- **Ingest from a store:** `{{backlog}} ingest` files each new store line with its inbox key in the item's note (a key already filed is skipped), pushes trunk's backlog-only commits, then removes in one store write the lines whose keys are on origin's trunk; a push it can't make leaves them, and the doctor names them (fixable).
- **Its settings** come from `loops/inbox-settings.json`: the context hook settings (`context-settings.json`, kept in step by a test) plus `effortLevel: low` and `fastMode: false`.
