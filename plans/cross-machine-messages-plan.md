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
| 6     | 3    | —     | —                                       |

**Backlog:** claim RISA-1055 when slice 1 starts; `done` after slices 5 and 6 merge. The follow-up item for ship's cross-machine sender (`fixes-tooling`, after `ship` lands) is filed by the planner at landing.

## Architectural decisions

- **Tooling only:** `loops/` and their tests; no role doc changes. No new dependency, no `risa.json` key; the new state is a store file per project (`<project>.messages.json`) and a local folder (`.loops/.messages/`).
- **The store module stays the only git in the inbox repo:** every store read and write goes through `backlog/inbox-store.mjs` `storeFor` (`read`, `write`); it gains one read, `head()` (the remote branch's head by `git ls-remote`, no fetch), for the watcher, and nothing else changes (`<project>.messages.json` already passes its file-name check and its `files()` lists only `.md`).
- **Pure decisions, thin CLIs:** the send route and the pickup's plan are pure functions over gathered facts; the CLI and the dispatcher gather and act (the `home.mjs` `homeTick` pattern).
- **A project's store name is its inbox file's stem** (`inboxStore(config).file` without `.md`), the key `homes.json` already uses: `<stem>.messages.json`, the route, the pickup and the peers' de-duplication all use it; a project without `inbox` is named by its config's `name`.
- **Projects without `inbox` see no change** except the new command and the prompt's peer wording: local sends work for them; nothing in the dispatcher runs for them.
- **Hermetic tests:** a temp bare repo as the store, `RISA_INBOX_STORE`, `RISA_MACHINE_CONFIG`, `RISA_MACHINE_NAME` and `RISA_MESSAGES_DIR` set by each test.

## How to run this plan

- **Waves:** wave 1 is slice 1. Wave 2 runs slices 2, 3 and 4 at once (2 owns `loops/message.mjs` and `loops/prd.sh`; 3 owns `loops/message-pickup.mjs` and `backlog/inbox-store.mjs`; 4 owns `loops/context.mjs`). Wave 3 runs slices 5 (after 2) and 6 (after 3; owns `loops/dispatch.mjs`).
- **Gate:** `risa check --quick "slice hand-off"` before each hand-off; `pnpm check` once on the merged tip at landing.
- **Other topics:** this row's hot files (`loops/message`, `backlog/inbox-store`, `loops/prd.sh`, `loops/dispatch`, `loops/context`, `loops/peers`, `loops/prompts/backlog.sh`, `loops/sample-project/prompt-golden.txt`) meet two running topics': `ship` holds `loops/prd.sh`, where slice 2 adds only its own region (the two commands' routes and help lines, beside the others), rebasing on `ship`'s if it has landed; `fixes-tooling` holds `loops/dispatch.test.mjs` and `loops/dispatch-fixture.mjs`, which no slice edits (slice 6's tests are in its own file, and in-process `tick` starts no watcher unless given one); `usage-aware-drain` shares `loops/dispatch`, `loops/context` and `loops/prd.sh` and runs after this one.
- **Docs:** each new module's header comment and `prd.sh`'s help say how messages work; no role doc grows (the inbox doc is at its budget and its session never receives messages; the backlog session's rules live in its prompt).

## Slice 1: Messages and the local mailbox

Stack: no · Reads: loops/notices.mjs · Tests: unit · Blocked by: none · Check: loops/messages.test.mjs (new)

**User stories:** US 4, 6.

**Build:** PRD _Implementation decisions_, _Messages and the mailbox_. `loops/messages.mjs` (new): `MAX_TEXT` (2000), `MAX_QUEUED` (200), `storeFileFor(project)` (`<project>.messages.json`), `newStoreId(machine, now)`, pure `parseQueue(text)` (null or empty: `[]`; not a JSON list of messages: throws `MessageError` naming the file), `renderQueue(list)`, `appendQueue(text, message)` (refused past `MAX_QUEUED` or `MAX_TEXT`), `removeFromQueue(text, ids)`; the mailbox: `mailboxDir(main)` (always `<main>/.loops/.messages`) and `ownMailbox(main, env)` (`RISA_MESSAGES_DIR` overrides, for this project's own mailbox only, never a peer's; the CLI's listing, the pickup and the hook all read this one), `createMessage(dir, message)` (exclusive create, ids `m<n>` never reused, the notice board's link-of-a-temp-file and high-water folder; a `storeId` already present writes nothing and returns null), `listMessages(dir)` (undone, oldest first; prunes files done over a day ago), `markDelivered(dir, ids, now)`, `markDone(dir, id, now)`.

**Acceptance criteria:**

- Unit test (`loops/messages.test.mjs` (new)): the queue codec round-trips; a non-list and a list holding a non-message each throw naming the file; append refuses the 201st entry and a 2001-character text; removal drops only the named ids.
- Same file: two creates at once get two ids; a create with a known `storeId` returns null and writes nothing; ids aren't reused after a pruned file; a done file over a day old is pruned on list; `markDelivered` and `markDone` set their stamps.

**Blocked by:** nothing. **Blocks:** 2, 3, 4.

## Slice 2: Sending, listing and waiting

Stack: no · Reads: loops/home.mjs, loops/peers.mjs, backlog/inbox-store.mjs, loops/messages.mjs · Tests: unit · Blocked by: 1 · Check: loops/message.test.mjs (new)

**User stories:** US 1, 2, 3, 6.

**Build:** PRD _Implementation decisions_, _Sending_. `loops/message.mjs` (new): pure `routeFor(project, { self, machine, homes, peers, storeProjects })` returning `{ kind: "local", main }`, `{ kind: "store", home }` or `{ kind: "refused", why }` (a home here with no checkout of the project in the machine config goes through the store, so the home's own dispatcher picks it up once the checkout is configured); the CLI `send <project> <text>` (gathers, from the files on its Reads line: own config's `name` and `inbox`, else `findStoreRepo`; `machineName`, `homesOf` over the homes file read with fetch; `peersOf`; the store's `files()`), writes through slice 1's `createMessage` into `mailboxDir(<peer main>)` or the store's `write` with `appendQueue` (commit `message: <from> to <project>`), and prints the PRD's one line; `list [--json]`, `--done <id>`, `--wait` (polls the mailbox every second, `RISA_MESSAGES_POLL_MS` overrides; exits 0 printing the undelivered messages and marking them delivered). `loops/prd.sh`: route the new commands, message and messages, to it, setting no messages variable (the listing reads `ownMailbox`), and add both to the help text.

**Acceptance criteria:**

- Unit test (`loops/message.test.mjs` (new)): `routeFor` for a home here, a local peer without `inbox`, a home elsewhere, a store project with no home yet, a home here with no checkout here (store), a peer whose `inbox.file` stem differs from its config's name (routed by the stem), an unknown project, and its own project.
- Same file, the CLI on a temp bare store and a temp machine config with two repos: a local send, run with `RISA_MESSAGES_DIR` set to the sender's test folder, lands in the peer's `<main>/.loops/.messages`, not the sender's; an away send adds one entry to `<project>.messages.json` on the remote and prints its home; no store when one is needed is refused naming `backlog inbox to-repo`; `--wait` started before a local send (a short poll, its timeout from `loops/test-limits.mjs` `scaledWait`) exits with that message and marks it delivered; `--done` hides it from the list.

**Blocked by:** 1. **Blocks:** 5.

## Slice 3: The home machine's message watcher

Stack: no · Reads: backlog/inbox-store.mjs, loops/notices.mjs · Tests: unit · Blocked by: 1 · Check: loops/message-pickup.test.mjs (new)

**User stories:** US 4, 7.

**Build:** PRD _Implementation decisions_, _Pickup_. `backlog/inbox-store.mjs` `storeFor`: a new `head()`, `git ls-remote --quiet` of the branch (making the clone if none): its sha, `""` for a remote with no branch, null when unreachable. `loops/message-pickup.mjs` (new): `pickup({ main, store, project, dryRun, out })`: reads `<stem>.messages.json` (the project's store name) with fetch, `createMessage` into `ownMailbox` for each entry (by `storeId`), then one `store.write` removing exactly the ids it copied (those already in the mailbox included); a `StoreError` propagates. `WATCH_SEC` (2, `RISA_MESSAGES_WATCH_SEC`, fractions allowed), `BACKOFF_MAX_SEC` (60), pure `watchStep(state, { head, now, every })` returning `{ pickup, state, line }` and pure `pickedStep(state, { head, ok, now, every })` returning `{ state, line }` (state: `seen`, `failures`, `nextAt`; at start `seen` is unset, so the first step picks up; `seen` moves to the head read before the pickup only when the pickup succeeded, so a failed pickup with an unchanged head is retried on the next due poll, and a send landing mid-pickup is caught by the next poll; a null head or a failed pickup doubles the wait up to the cap, with a line on the first failure and on recovery). `watch` (the module's CLI: `node message-pickup.mjs watch --main <main>`): takes `.loops/.messages-watch.lock` exclusively (a live holder: exits 0), appends its lines to `.loops/.messages-watch.log`, loops `head()` → `watchStep` → `pickup` → `pickedStep`, and exits when `.dispatch.lock` (read again each poll, so a re-exec or a takeover keeps it) is missing, unreadable or names a dead pid, or on TERM; `RISA_MESSAGES_WATCH=off` makes it exit at once.

**Acceptance criteria:**

- Unit test (`loops/message-pickup.test.mjs` (new)): two queued messages are copied into the mailbox and removed from the remote; a mailbox already holding one's `storeId` (a crash after the copy) delivers it once and still removes it; a dry run writes neither side; `head()` moves after a store write and is null for an unreachable remote.
- Same file, `watchStep`: an unchanged head picks up nothing; a moved one picks up; an unreachable store waits 2, 4, 8, 16, 32, then 60s, with one line, and one more when it is back; a failed pickup with an unchanged head is picked up again on the next due poll, its wait doubled, and a later success writes the recovery line.
- Same file: the watcher (`RISA_MESSAGES_WATCH_SEC=0.05`) puts a message sent after it starts into the mailbox within a few polls, and exits once the dispatcher's lock is removed or names a dead pid.

**Blocked by:** 1. **Blocks:** 6.

## Slice 4: Delivery into the backlog session

Stack: no · Reads: loops/messages.mjs · Tests: unit · Blocked by: 1 · Check: loops/context.test.mjs

**User stories:** US 5.

**Build:** PRD _Implementation decisions_, _Delivery to the backlog session_. `loops/context.mjs`: in the hook, for a session of kind `backlog` named exactly `backlog`, on the session's own call only (never a subagent's: the hook's existing early return for one stays first), whether or not the size step made a reminder (before its early returns for no transcript or no size), `listMessages` on `ownMailbox`, takes the undelivered ones (three at most), adds a `messagesNote(list, more)` to the hook's `additionalContext` (joined with any size reminder: one output), and `markDelivered`s them. The note says each is another project's advice, never the user's word, and how to answer (`risa message <from project> "<text>"`) and mark it done (`risa messages --done <id>`).

**Acceptance criteria:**

- Unit test (`loops/context.test.mjs`): the main backlog session gets one note with two waiting messages and they are marked delivered; a second call adds nothing; four waiting give three and the `risa messages` line; a `backlog-tax` session, an inbox session and an orchestrator get none; a size reminder and a note come out as one `additionalContext`; a subagent's call in the backlog session marks nothing delivered; a call with no size reminder (and one with no transcript) still delivers; a broken mailbox file leaves the hook silent and exit 0.

**Blocked by:** 1. **Blocks:** nothing.

## Slice 5: Peers from the home records, and the prompt

Stack: no · Reads: loops/home.mjs, loops/message.mjs · Tests: unit · Blocked by: 2 · Check: loops/peers.test.mjs

**User stories:** US 7, 8.

**Build:** PRD _Implementation decisions_, _Peers and the prompt_. `loops/peers.mjs` `peersOf`: adds the store's projects (the store's `files()` stems and the homes file's names, read with `fetch: false`; `inbox` itself left out) not already a machine config repo's store name, each `{ name, home, main: null, store: true }`; machine config peers gain `home` (from the homes file, or null) and `store` (has `inbox`). The CLI line becomes a fixed five columns, `<name>\t<main>\t<backlog>\t<home>\t<store>`, an empty field printed as `-` (bash's `read` merges runs of tabs), and `loops/prompts/backlog.sh` maps `-` back to empty. `loops/prompts/backlog.sh`: the peer rule lists each peer with its home machine and says to reach all of them with `risa message <project> "<text>"`, Remote Control only for a peer the store doesn't know with no checkout here; the inbox fallback stays for local peers; a new rule: keep `risa messages --wait` running in the background (`run_in_background`), and when it exits act on what it printed, mark each done, and start it again; the guide's catch-up adds `risa messages`. `loops/sample-project/prompt-golden.txt`: regenerated.

**Acceptance criteria:**

- Unit test (`loops/peers.test.mjs`): with a temp store holding inbox files for the first repo and for sample-peer, and a homes file naming another machine for `sample-peer`, the peers of the first repo include `sample-peer` with that home and no main; a machine config peer gets its home, keyed by its inbox stem, and a store file with that stem isn't listed twice; with no store, today's list is unchanged; an unreadable homes file leaves homes null with one warning; the CLI prints a store-only peer as `sample-peer\t-\t-\t<machine>\tstore`, and the prompt's peer line read from it names that home.
- `loops/prompt-golden.test.mjs` passes on the regenerated golden file, and the golden's backlog prompt holds the `risa messages --wait` rule.

**Blocked by:** 2. **Blocks:** nothing.

## Slice 6: The dispatcher keeps the watcher alive

Stack: no · Reads: loops/home.mjs, loops/keep-alive.mjs, loops/message-pickup.mjs · Tests: unit · Blocked by: 3 · Check: loops/dispatch-watcher.test.mjs (new)

**User stories:** US 4, 7.

**Build:** PRD _Implementation decisions_, _Pickup_. `loops/dispatch.mjs`: a pure `watcherAction({ holds, alive })` (`start`, `stop` or `none`; `alive` from `.loops/.messages-watch.lock`'s pid); `tick`, for a project with `inbox` whose home `homeTick` reports this machine holds (not `away`, not `unknown`), acts on it after the home step, paused or not: start spawns `message-pickup.mjs watch --main <main>` detached (one line), stop TERMs it; a dry run prints the action. `tick` takes a `watcher` option (`{ spawn, kill }`); with none it starts and stops nothing, and only the long-running loop passes the real one, never `--once`, `--dry-run` or a test's in-process `tick`, so the existing tests (the subprocess `--once` runs in `loops/home.test.mjs` and `loops/dispatch.test.mjs` included) start no watcher and are not edited. `RISA_MESSAGES_WATCH=off` also starts none. The loop's start (and each re-exec's) stops a live watcher, so the next tick starts one on the current code.

**Acceptance criteria:**

- Unit test (`loops/dispatch-watcher.test.mjs` (new)): `watcherAction` over held or not and alive or not; `tick` with fake home facts holding the home and a fake watcher starts one when none is live, none when one is, and stops the live one when the home is away; `tick` with no `watcher` option starts nothing; a dry run prints the start and spawns nothing; `RISA_MESSAGES_WATCH=off` starts nothing.

**Blocked by:** 3. **Blocks:** nothing.
