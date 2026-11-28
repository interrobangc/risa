# Plan: risa-next-2

> Source PRD: [`plans/risa-next-2-prd.md`](risa-next-2-prd.md). User-story numbers (US) refer to it. Items RISA-841, RISA-1007 (its build: the home-machine check). Topic `risa-next-2`.

## Status

**From the user:** (none yet)

**Landing mode:** run everything through (started run-through; land each green wave, ask only real questions).

**Now:** wave 3 landed in main through PR #34 (8f52589, tier none, Codex clean after RISA-1071/1072 were filed into wave 4); to-test `to-test/2026-11-28-1149-risa-next-2.md`. **Next session: wave 4** = slices 4 and 6, both on opus; slice 4 takes RISA-1071, slice 6 RISA-1072 (both claimed). Sync first (main moved 7 commits, no shared files).

| Slice | Wave | State          | Merge into `prd/risa-next-2` |
| ----- | ---- | -------------- | ---------------------------- |
| 1     | 1    | landed (opus)  | 72d3a64                      |
| 2     | 2    | landed (opus)  | 5ff0aae (main)               |
| 3     | 3    | running (opus) | —                            |
| 5     | 3    | merged (opus)  | 1aa160b                      |
| 4     | 4    | —              | —                            |
| 6     | 4    | —              | —                            |

**Slice 6 note (from 5's hand-off):** `prd.sh inbox` opens from the machine config's first repo with `inbox` without checking `work: true`; slice 6's keep-alive says first `work: true` repo with `inbox`: make them agree.

**Backlog:** RISA-1057–1060 (Codex on PR #28, `backlog/inbox-store.mjs`) taken into this PRD at fixes-bug's request: add them to slice 2's brief. Promised prd-fixes-bug (risa): a message when wave 1 lands in main, and when `backlog/` and `loops/dispatch` stop being hot. Claim each slice's item as it starts. Slices 1 to 5: RISA-841 (`done` after 5). Slice 6: RISA-1007 (`done` after it).

## Architectural decisions

- **One module knows the inbox repo's clone** (`backlog/inbox-store.mjs`, new); every other file asks it. No other file runs git in the clone.
- **Additive:** a project without an `inbox` key behaves exactly as today (the trunk inbox, its writer, its ingest, no home claims); no `risa.json` key is renamed or removed; no existing test changes.
- **No data moves:** no slice creates a repo, runs the move command on this repo or Caretook, or edits `plans/inbox.md` (PRD _Out of scope_).
- **A trunk-only project loads nothing new:** `backlog/backlog.mjs` imports the store modules (`inbox-commands.mjs`, `inbox-store.mjs`) with `await import()` only when the config has `inbox`; shared helpers (`LookAlikeStop`) live in `inbox-edit.mjs` (wave 2: test fixtures copy a fixed file set).
- **The store file's format is the trunk inbox's**, so `backlog/format.mjs`'s parsers and `backlog/inbox-edit.mjs` serve both.
- **Hermetic tests:** bare repos in the OS temp dir stand in for the private repo; the clone folder and the machine name come from env overrides; `RISA_MACHINE_CONFIG` at a temp file; a stub `gh`; never this checkout's config or `~/.risa`.

## How to run this plan

- **Waves:** wave 1 is slice 1. Wave 2 is slice 2 (after 1). Wave 3 runs slices 3 and 5 (both after 2; 3 owns `backlog/backlog.mjs` and `backlog/format.mjs`, 5 owns `loops/prompts/inbox.sh` and `loops/prd.sh`'s `inbox` case). Wave 4 runs slices 4 and 6 (4 after 3: `backlog/backlog.mjs`, and after 5: its doc; 6 after 5: `loops/prd.sh`; 6 needs only slice 1's store otherwise).
- **Gate:** `risa check --quick "slice hand-off"` before each hand-off; `pnpm check` once on the merged tip at landing.
- **Other topics:** the row's hot files are `backlog/`, `loops/config`, `loops/docs/project-config.md`, `loops/docs/inbox.md`, `loops/prompts/inbox.sh`, `loops/prd.sh`, `loops/dispatch` and `loops/home`. `self-recovery-2` (running) holds `loops/dispatch`, `loops/prd.sh` and `loops/docs`: slices 1 (`loops/docs/project-config.md`), 4, 5 and 6 meet only that topic's files. `risa-next-4` (planned) changes `loops/config.mjs` too: whichever lands second rebases onto the other.
- **Docs:** slice 1 writes the `inbox` key into `loops/docs/project-config.md`; slice 4 writes the move and the one session into `loops/docs/inbox.md`; each new module's header comment says the rest.

## Slice 1: The inbox store

Stack: no · Reads: loops/docs/project-config.md · Tests: unit · Blocked by: none · Check: backlog/inbox-store.test.mjs

**User stories:** US 1, 6.

**Build:** PRD _Implementation decisions_, _The inbox store_. `backlog/inbox-store.mjs` (new): `storeFor(repo)` (its clone under `~/.risa/inbox-store/`, `RISA_INBOX_STORE` overriding the folder, cloned on first use), `read(file, { fetch })` (fetch best effort unless `fetch: false`, the last copy offline, null for no file), `write(file, edit, message)` (fetch, edit the tip's copy, commit that file only, push without force, rebuild on a refusal, `TRIES` five; the commit or null). `loops/config.mjs`: the optional `inbox` group (`inbox.repo`, `inbox.file`, default `<name>.md`). `loops/docs/project-config.md`: the key.

**Acceptance criteria:**

- Unit test (`backlog/inbox-store.test.mjs` (new)), a temp bare repo: a write then a read round-trips; two clones writing at once keep both lines (the loser rebuilt); five refused pushes give up with nothing written; a read with the remote gone returns the last copy; an edit that changes nothing commits nothing; `read(file, { fetch: false })` makes no fetch.
- `loops/config.test.mjs`: `inbox` accepted with both keys and with `repo` only (`file` defaults), an unknown key under it refused; every existing case unchanged.

**Blocked by:** nothing. **Blocks:** 2, 6.

## Slice 2: The inbox commands write the store

Stack: no · Reads: loops/docs/inbox.md · Tests: unit · Blocked by: 1 · Check: backlog/inbox-store-cli.test.mjs

**User stories:** US 2, 4, 6.

**Build:** PRD _Implementation decisions_, _The inbox commands_. `backlog/backlog.mjs` `inboxAdd`, `inboxMove`, `inboxEdit`, `inboxRemove` and the `inbox` list: with `config.inbox` set, read and write through slice 1's store (no `pushInboxEdit`, no `pickup`), same arguments, exit codes and look-alikes, output `on <repo> <file> as <sha>`. `backlog/inbox-store.mjs` (new in slice 1) gains a CLI, `node <tool>/backlog/inbox-store.mjs <add|edit|move|remove|list> --project <name> …`, that runs from any folder with no project config (the inbox session's entry point; `risa backlog` needs a repo config), finding the store from the machine config's repos (their `inbox.repo`, all equal, else one line naming both) or an existing clone; look-alikes against the store's lines, and the backlog too when the project's main checkout is in the machine config.

**Also fix (Codex on PR #28, `backlog/inbox-store.mjs`):** RISA-1057 (a clone name that can't collide: a short hash of the URL in it); RISA-1058 (the temp index at an absolute path, so a relative `RISA_INBOX_STORE` works); RISA-1059 (a remote confirmed empty clears the tracking ref: no stale read, no write on a gone commit); RISA-1060 (a first-use clone safe across processes: clone into a temp folder and rename into place, the loser using the winner's). Each with a case in `backlog/inbox-store.test.mjs`.

**Acceptance criteria:**

- Unit test (`backlog/inbox-store-cli.test.mjs` (new)), a sample project with `inbox` at a temp bare repo: `backlog inbox add` writes the store file and leaves the trunk's history unchanged; edit, move and remove act on it; a look-alike exits 3; the CLI, run by its absolute path from a temp folder outside any repo, adds with `--project`; differing `inbox.repo`s refuse; a project with a custom `inbox.file` is reached by that file's stem.
- `backlog/backlog.test.mjs` and `backlog/origin.test.mjs` pass unchanged.

**Blocked by:** 1. **Blocks:** 3, 5.

## Slice 3: Ingest from the store

Stack: no · Reads: loops/docs/backlog.md · Tests: unit · Blocked by: 2 · Check: backlog/inbox-ingest.test.mjs

**User stories:** US 5.

**Build:** PRD _Implementation decisions_, _Ingest from the store_. `backlog/format.mjs`: `lineKey(entry)` (new, a short hash of the line and its details). `backlog/backlog.mjs` `ingest`: with `config.inbox`, read the store file, file each line whose key isn't in the backlog (its note carries the key), commit; then push trunk's backlog-only commits (the trunk writer's rule from `backlog/origin.mjs`) and remove from the store, in one write, every line whose key origin's trunk's backlog holds. `findings`: a filed line still in the store (fixable).

**Acceptance criteria:**

- Unit test (`backlog/inbox-ingest.test.mjs` (new)): ingest files two lines and the store is empty after; a crash after the backlog commit (the store write made to fail) and a rerun files nothing twice and then empties the store; a trunk with a user commit on top (push not possible) leaves the lines, and the doctor names them; a no-store project's ingest unchanged.

**Also fix:** RISA-1067 (Codex on PR #32: `findStoreRepo` dedupes clone URLs before counting, with a case in `backlog/inbox-store.test.mjs`).

**Blocked by:** 2. **Blocks:** 4.

## Slice 4: Moving a project's inbox

Stack: no · Reads: loops/docs/inbox.md · Tests: unit · Blocked by: 3, 5 · Check: backlog/inbox-move.test.mjs

**User stories:** US 1, 7.

**Build:** PRD _Implementation decisions_, _Moving a project_. `backlog/inbox-move.mjs` (new): `moveToRepo(url)`: `gh repo view --json visibility` must say private; refuses when `inbox` is set; writes the unfiled trunk lines into the store file (merged with any there); then one trunk commit sets `inbox.repo` in `risa.json` and removes the trunk inbox file. `backlog/backlog.mjs`: the `inbox to-repo <git url>` route. `loops/docs/inbox.md`: the store, the move, and (from slice 5) the one session.

**Acceptance criteria:**

- Unit test (`backlog/inbox-move.test.mjs` (new)), stub `gh`: public and missing repos refused with nothing written; a private one gets the unfiled lines (tagged ones dropped), and the trunk commit changes exactly `risa.json` and the inbox file; a second run refuses.

**Also fix:** RISA-1071 (Codex on PR #34: `inbox-commands.mjs` refuses edit, move and remove of a store line whose inbox key a backlog item holds, with a case in `backlog/inbox-store-cli.test.mjs`).

**Blocked by:** 3, 5 (its doc describes slice 5's session). **Blocks:** nothing.

## Slice 5: One inbox session for every project

Stack: no · Reads: loops/docs/inbox.md · Tests: unit · Blocked by: 2 · Check: loops/inbox-prompt.test.mjs

**User stories:** US 3, 4.

**Build:** PRD _Implementation decisions_, _One inbox session_. `loops/prompts/inbox.sh`: with a store, list the projects (the store's files and the machine config's repos with `inbox`), route each line to the named or inferred project, ask in one line when unclear, and run slice 2's CLI with `--project`, rendered as `node <the tool's absolute path>/backlog/inbox-store.mjs …` from `loops/prompt.sh`'s tool folder; without one, today's text. `loops/prd.sh`'s `inbox` case: finds the store the same way, so the session opens once per machine.

**Acceptance criteria:**

- Unit test (`loops/inbox-prompt.test.mjs` (new)): with a temp machine config naming two projects at one store, the prompt lists both, holds the routing and `--project` rules, and names the store CLI by an absolute path that exists; with none, it matches today's render; `loops/prompt-golden.test.mjs` unchanged.

**Blocked by:** 2. **Blocks:** 6.

## Slice 6: Home machines

Stack: no · Reads: loops/docs/machinery.md · Tests: unit · Blocked by: 1, 5 · Check: loops/home.test.mjs

**User stories:** US 8.

**Build:** PRD _Implementation decisions_, _Home machines_, and the keep-alive part of _One inbox session_. `loops/home.mjs` (new): `homeOf`, `claim`, `take` on the store's homes file `homes.json` (new); the machine's name from the short host name (`RISA_MACHINE_NAME` overrides); a CLI for `risa home` and `risa home take <project|inbox>`. `loops/dispatch.mjs`: for a project with `inbox`, claim on the first tick (the machine config's first `work: true` repo with `inbox` claims `inbox` too), fetch the store and reread the homes file at most every five minutes (`read` with `fetch: true` then, `fetch: false` on the ticks between; the time of the last fetch kept in the dispatcher's state), and skip start, plan, reopen and keep-alive while another machine holds it (a log line each tick, one report). The same file's keep-alive gathering (where it sets `unready.inbox` today): for a repo with an `inbox` key only, a reason for the inbox kind unless it is the machine config's first `work: true` repo with `inbox` and the `inbox` home is this machine's; a repo without the key is untouched. `loops/prd.sh`: a new home case running the home module (`risa home`).

**Acceptance criteria:**

- Unit test (`loops/home.test.mjs` (new)), temp store, two machine names by env: the first claim wins and a second machine's is refused; `take` moves it, and after machine B takes a project, machine A's next dry-run tick past the five-minute refetch skips it and files the one report; the first `work: true` repo with `inbox` claims `inbox` on its first tick and keeps the inbox session; the second such repo on one machine skips it; a repo without `inbox` claims nothing and keeps its own inbox session.
- `loops/dispatch.test.mjs` passes unchanged.

**Also fix:** RISA-1072 (Codex on PR #34: `loops/prd.sh`'s inbox hop rebases an inherited `RISA_SESSIONS_DIR` onto the first project's `.loops/.sessions`, with a case in `loops/inbox-prompt.test.mjs` or `loops/home.test.mjs`).

**Blocked by:** 1, 5. **Blocks:** nothing.
