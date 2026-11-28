# Plan: cross-machine-messages

> Source PRD: [`plans/cross-machine-messages-prd.md`](cross-machine-messages-prd.md). User-story numbers (US) refer to it. Item RISA-1055. Topic `cross-machine-messages`.

## Status

| Slice | Wave | State | Merge into `prd/cross-machine-messages` |
| ----- | ---- | ----- | --------------------------------------- |
| 1     | 1    | —     | —                                       |
| 2     | 2    | —     | —                                       |
| 3     | 2    | —     | —                                       |
| 4     | 2    | —     | —                                       |
| 5     | 3    | —     | —                                       |

**Backlog:** claim RISA-1055 when slice 1 starts; `done` after slice 5 merges.

## Architectural decisions

- **Tooling only:** `loops/`, their tests, one people doc (`loops/docs/inbox.md`). No new dependency, no `risa.json` key; the new state is a store file per project (`<project>.messages.json`) and a local folder (`.loops/.messages/`).
- **The store module stays the only git in the inbox repo:** every store read and write goes through `backlog/inbox-store.mjs` `storeFor` (`read`, `write`); it is not changed (`<project>.messages.json` already passes its file-name check and its `files()` lists only `.md`).
- **Pure decisions, thin CLIs:** the send route and the pickup's plan are pure functions over gathered facts; the CLI and the dispatcher gather and act (the `home.mjs` `homeTick` pattern).
- **Projects without `inbox` see no change** except the new command and the prompt's peer wording: local sends work for them; nothing in the dispatcher runs for them.
- **Hermetic tests:** a temp bare repo as the store, `RISA_INBOX_STORE`, `RISA_MACHINE_CONFIG`, `RISA_MACHINE_NAME` and `RISA_MESSAGES_DIR` set by each test.

## How to run this plan

- **Waves:** wave 1 is slice 1. Wave 2 runs slices 2, 3 and 4 at once (2 owns `loops/message.mjs`, `loops/prd.sh` and `loops/docs/inbox.md`; 3 owns `loops/message-pickup.mjs` and `loops/dispatch.mjs`; 4 owns `loops/context.mjs`). Wave 3 is slice 5 (after 2).
- **Gate:** `risa check --quick "slice hand-off"` before each hand-off; `pnpm check` once on the merged tip at landing.
- **Other topics:** this row's hot files (`loops/message`, `loops/prd.sh`, `loops/dispatch`, `loops/context`, `loops/peers`, `loops/prompts/backlog.sh`, `loops/sample-project/prompt-golden.txt`, `loops/docs/inbox.md`) miss both running topics' (`fixes-test`, `risa-next-4`); `usage-aware-drain` shares `loops/dispatch`, `loops/context` and `loops/prd.sh` and runs after this one.
- **Docs:** `loops/docs/inbox.md` (a people doc) gains one short section; each module's header comment says the rest. No role doc grows: the backlog session's rules live in its prompt.

## Slice 1: Messages and the local mailbox

Stack: no · Reads: loops/notices.mjs · Tests: unit · Blocked by: none · Check: loops/messages.test.mjs (new)

**User stories:** US 4, 6.

**Build:** PRD _Implementation decisions_, _Messages and the mailbox_. `loops/messages.mjs` (new): `MAX_TEXT` (2000), `MAX_QUEUED` (200), `storeFileFor(project)` (`<project>.messages.json`), `newStoreId(machine, now)`, pure `parseQueue(text)` (null or empty: `[]`; not a JSON list of messages: throws `MessageError` naming the file), `renderQueue(list)`, `appendQueue(text, message)` (refused past `MAX_QUEUED` or `MAX_TEXT`), `removeFromQueue(text, ids)`; the mailbox: `mailboxDir(main, env)` (`RISA_MESSAGES_DIR`, else `<main>/.loops/.messages`), `createMessage(dir, message)` (exclusive create, ids `m<n>` never reused, the notice board's link-of-a-temp-file and high-water folder; a `storeId` already present writes nothing and returns null), `listMessages(dir)` (undone, oldest first; prunes files done over a day ago), `markDelivered(dir, ids, now)`, `markDone(dir, id, now)`.

**Acceptance criteria:**

- Unit test (`loops/messages.test.mjs` (new)): the queue codec round-trips; a non-list and a list holding a non-message each throw naming the file; append refuses the 201st entry and a 2001-character text; removal drops only the named ids.
- Same file: two creates at once get two ids; a create with a known `storeId` returns null and writes nothing; ids aren't reused after a pruned file; a done file over a day old is pruned on list; `markDelivered` and `markDone` set their stamps.

**Blocked by:** nothing. **Blocks:** 2, 3, 4.

## Slice 2: Sending, listing and waiting

Stack: no · Reads: loops/home.mjs, loops/peers.mjs, backlog/inbox-store.mjs, loops/messages.mjs · Tests: unit · Blocked by: 1 · Check: loops/message.test.mjs (new)

**User stories:** US 1, 2, 3, 6.

**Build:** PRD _Implementation decisions_, _Sending_. `loops/message.mjs` (new): pure `routeFor(project, { self, machine, homes, peers, storeProjects })` returning `{ kind: "local", main }`, `{ kind: "store", home }` or `{ kind: "refused", why }`; the CLI `send <project> <text>` (gathers, from the files on its Reads line: own config's `name` and `inbox`, else `findStoreRepo`; `machineName`, `homesOf` over the homes file read with fetch; `peersOf`; the store's `files()`), writes through slice 1's `createMessage` or the store's `write` with `appendQueue` (commit `message: <from> to <project>`), and prints the PRD's one line; `list [--json]`, `--done <id>`, `--wait` (polls the mailbox every second; exits 0 printing the undelivered messages and marking them delivered). `loops/prd.sh`: route the new commands, message and messages, to it with `RISA_MESSAGES_DIR` set as the notice board's is, and add both to the help text. `loops/docs/inbox.md`: a short _Messages across machines_ section (where messages go, the store file, the pickup, who receives).

**Acceptance criteria:**

- Unit test (`loops/message.test.mjs` (new)): `routeFor` for a home here, a local peer without `inbox`, a home elsewhere, a store project with no home yet, an unknown project, and its own project.
- Same file, the CLI on a temp bare store and a temp machine config with two repos: a local send lands in the peer's mailbox; an away send adds one entry to `<project>.messages.json` on the remote and prints its home; no store when one is needed is refused naming `backlog inbox to-repo`; `--wait` started before a local send exits with that message and marks it delivered; `--done` hides it from the list.

**Blocked by:** 1. **Blocks:** 5.

## Slice 3: The home dispatcher's pickup

Stack: no · Reads: loops/home.mjs, backlog/inbox-store.mjs · Tests: unit · Blocked by: 1 · Check: loops/message-pickup.test.mjs (new)

**User stories:** US 4, 7.

**Build:** PRD _Implementation decisions_, _Pickup_. `loops/message-pickup.mjs` (new): `FETCH_SEC` (60, `RISA_MESSAGES_FETCH_SEC`), `pickupTick({ main, store, project, state, now, dryRun, out })`: when due, reads `<project>.messages.json` with fetch, `createMessage` for each entry (by `storeId`), then one `store.write` removing exactly the ids it copied (those already in the mailbox included), returning the next `state` (`fetchedAt`); a `StoreError` prints one line and leaves `fetchedAt` unchanged so the next tick retries. `loops/dispatch.mjs` `tick`: for a project with `inbox` whose home `homeTick` reports this machine holds (not `away`, not `unknown`), runs it after the home step, its state kept beside `home` in the dispatcher's state; `tick` takes the module as an injectable option (as it takes `home`), loaded with the home module.

**Acceptance criteria:**

- Unit test (`loops/message-pickup.test.mjs` (new)): two queued messages are copied into the mailbox and removed from the remote; a mailbox already holding one's `storeId` (a crash after the copy) delivers it once and still removes it; an unreachable store prints one line and retries on the next call; a dry run writes neither side; no fetch before `FETCH_SEC` has passed.
- Same file: one `tick` with fake home facts holding the home runs the pickup, and with the home away runs nothing.

**Blocked by:** 1. **Blocks:** nothing.

## Slice 4: Delivery into the backlog session

Stack: no · Reads: loops/messages.mjs · Tests: unit · Blocked by: 1 · Check: loops/context.test.mjs

**User stories:** US 5.

**Build:** PRD _Implementation decisions_, _Delivery to the backlog session_. `loops/context.mjs`: in the hook, for a session of kind `backlog` named exactly `backlog`, after the size step, `listMessages` on the main checkout's mailbox (`mailboxDir`), takes the undelivered ones (three at most), adds a `messagesNote(list, more)` to the hook's `additionalContext` (joined with any size reminder: one output), and `markDelivered`s them. The note says each is another project's advice, never the user's word, and how to answer (`risa message <from project> "<text>"`) and mark it done (`risa messages --done <id>`).

**Acceptance criteria:**

- Unit test (`loops/context.test.mjs`): the main backlog session gets one note with two waiting messages and they are marked delivered; a second call adds nothing; four waiting give three and the `risa messages` line; a `backlog-tax` session, an inbox session and an orchestrator get none; a size reminder and a note come out as one `additionalContext`; a broken mailbox file leaves the hook silent and exit 0.

**Blocked by:** 1. **Blocks:** 5.

## Slice 5: Peers from the home records, and the prompt

Stack: no · Reads: loops/home.mjs, loops/message.mjs · Tests: unit · Blocked by: 2, 4 · Check: loops/peers.test.mjs

**User stories:** US 7, 8.

**Build:** PRD _Implementation decisions_, _Peers and the prompt_. `loops/peers.mjs` `peersOf`: adds the store's projects (the store's `files()` stems and the homes file's names, read with `fetch: false`; `inbox` itself left out) not already a machine config repo, each `{ name, home, main: null, store: true }`; machine config peers gain `home` (from the homes file, or null) and `store` (has `inbox`). The CLI line gains the home column. `loops/prompts/backlog.sh`: the peer rule lists each peer with its home machine and says to reach all of them with `risa message <project> "<text>"`, Remote Control only for a peer the store doesn't know with no checkout here; the inbox fallback stays for local peers; a new rule: keep `risa messages --wait` running in the background (`run_in_background`), and when it exits act on what it printed, mark each done, and start it again; the guide's catch-up adds `risa messages`. `loops/sample-project/prompt-golden.txt`: regenerated.

**Acceptance criteria:**

- Unit test (`loops/peers.test.mjs`): with a temp store holding inbox files for the first repo and for sample-peer, and a homes file naming another machine for `sample-peer`, the peers of the first repo include `sample-peer` with that home and no main; a machine config peer gets its home; with no store, today's list is unchanged; an unreadable homes file leaves homes null with one warning.
- `loops/prompt-golden.test.mjs` passes on the regenerated golden file, and the golden's backlog prompt holds the `risa messages --wait` rule.

**Blocked by:** 2, 4. **Blocks:** nothing.
