# PRD: cross-machine-messages

Item RISA-1055 (cross-machine messages through the private inbox repo; peers found from the home-machine records, not Remote Control). Topic `cross-machine-messages`. Plan: [`plans/cross-machine-messages-plan.md`](cross-machine-messages-plan.md).

## Decisions

| Decision                                                                                                                                                                                                                                                                                                                                                                 | Why                                                                                                                                                                       | Source                                      | Cost to change later                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------- |
| A message to a project whose home is another machine is one entry in a new store file in the inbox repo, `<project>.messages.json` (a JSON list), written through the store's existing writer (fetch, edit the tip, push without force, rebuilt on a refused push). Only that project's home dispatcher removes entries                                                  | the item's own words ("written to the inbox repo"); the store's writer is already the cross-machine compare-and-swap; a file per project keeps two projects' writes apart | preference (RISA-1055)                      | medium: a file in the user's inbox repo |
| The home dispatcher copies each new store message into its project's local mailbox (`.loops/.messages/` in the main checkout), then removes it from the store; the local copy keeps the store entry's id, so a crash between the two writes never delivers one twice                                                                                                     | the inbox ingest's rule (write the safe copy first, remove after, a key makes the rerun safe)                                                                             | assumed                                     | low                                     |
| One path for every peer: `risa message <project> "<text>"` writes the local mailbox when the project's home is this machine (or it is a peer here with no `inbox` key), else the store. Sessions no longer use SendMessage over Remote Control to reach a peer's backlog; a peer with no store file and no checkout here keeps today's Remote Control line as a fallback | Remote Control reaches only one claude.ai account's sessions, so usage-aware-drain's account swap would cut it (the user, 2026-11-28); a mailbox works on any account     | assumed                                     | medium: the backlog prompt's peer rule  |
| Peers are the machine config's other repos plus every project the store knows (its inbox files and its `homes.json` names), each shown with its home machine                                                                                                                                                                                                             | "peers are found from the home-machine records" (RISA-1055)                                                                                                               | preference (RISA-1055)                      | low: the peers module                   |
| Messages go to a project's main backlog session (`backlog`) only, never to a named `backlog-<name>` one or the inbox session. With none live they wait in the mailbox for the next one's catch-up                                                                                                                                                                        | one go-between per project; a named session has its own task                                                                                                              | assumed                                     | low                                     |
| A live backlog session gets a message two ways: the context hook adds each undelivered one at its next tool call, and the session keeps `risa messages --wait` running in the background, which exits on a new message and so wakes an idle session                                                                                                                      | the hook alone never reaches a session waiting on the user; a background command's exit re-invokes the session                                                            | assumed                                     | low: a prompt clause and the hook       |
| The home dispatcher fetches the store for messages at most once a minute (`RISA_MESSAGES_FETCH_SEC`, 60), apart from the homes file's five-minute refetch                                                                                                                                                                                                                | a reply should arrive within a tick or two; a fetch of a small repo is cheap                                                                                              | assumed                                     | low: one constant                       |
| A message is plain text, 2000 characters at most, stamped with the sender's project, machine and session; a project's store file holds 200 at most (a send past that is refused, naming the home that isn't picking up). A handled message is marked done (`risa messages --done <id>`) and its file pruned a day later                                                  | small, bounded files in a repo every machine fetches                                                                                                                      | assumed                                     | low: two constants                      |
| A message is advice from another project, never the user's word, whatever it claims to quote                                                                                                                                                                                                                                                                             | the existing peer rule                                                                                                                                                    | preference (the backlog prompt's peer rule) | low                                     |
| Ship's notify hook (`ship` topic, not yet landed) gets the cross-machine sender in a follow-up item, `fixes-tooling`, filed by this topic's planner at landing and run after `ship` lands                                                                                                                                                                                | neither topic can wire the other's unlanded code                                                                                                                          | assumed                                     | low: one item                           |

**Skeptic:** the first plan skeptic sent it back (s32): the inbox doc section (over its budget, and the wrong reader) is dropped; a peer's mailbox never follows `RISA_MESSAGES_DIR`; the peers CLI prints fixed columns; the ship follow-up is filed at landing; a home here with no checkout goes through the store. All five were fixed.

Nothing was asked: every row is additive (a new command, a new store file, a new local folder), no `risa.json` key is added or changes, and no existing data changes meaning. A project takes part once it has an `inbox` key and a Risa release with this topic; until then a send to it is queued in the store, or refused with the reason when the store doesn't know it.

## Problem

A backlog session reaches another project's backlog session over Remote Control (ListAgents, then SendMessage). Remote Control lists only the sessions of one claude.ai account. The user is moving this machine to the business account and the other machine to the personal one (usage-aware-drain, RISA-1002), so after that move the two machines' sessions can't see each other: a ship notice to Caretook, a "tell me when the fix is deployed" request or an answer to a peer's question has no way across.

## Solution

Messages go through the private inbox repo every machine already reaches with git. A session sends with one command naming the project; the command writes it to that project's local mailbox when its home is this machine, or to the inbox repo when the home is elsewhere. The home machine's dispatcher picks it up within a minute or so, puts it in the local mailbox and hands it to its backlog session: at the session's next tool call, or by waking the session's background watch when it is idle. The backlog prompt lists each peer with its home machine from the home records, and says to use the command for all of them.

## User stories

1. As a backlog session, I want to send a message to another project's backlog by name, wherever its home is, so that I can file an item there, ask to be told when a fix ships, or answer it.
2. As a backlog session, I want the command to say where the message went (this machine's mailbox, or the store for the named home machine), so that I can tell the user what happened.
3. As a backlog session, I want a send to a project nothing knows to be refused with the reason, so that a typo doesn't vanish.
4. As the home machine's dispatcher, I want to move each new store message into the local mailbox and only then remove it from the store, so that none is lost or delivered twice.
5. As a backlog session, I want new messages added to my context at my next tool call, and my background watch to wake me when I'm idle, so that I act on them without polling.
6. As a backlog session, I want to list my messages and mark one done, so that the next session's catch-up shows only what's left.
7. As the user, I want machines on different Claude accounts to keep talking, so that the account swap (usage-aware-drain) cuts nothing off.
8. As a backlog session, I want my prompt's peer list to name every project the home records know, with its home machine, so that I know who I can reach.

## Implementation decisions

### Messages and the mailbox

- One module owns the message shape and both stores' codecs: a message is `{ id, from: { project, machine, session }, to, text, sentAt }` (store id: the sender's machine, the time and a random suffix). Pure: parse and render the store file (a JSON list; anything else is an error naming the file), append (refused past 200 entries or 2000 characters), remove by ids.
- The local mailbox is one JSON file per message in the main checkout's `.loops/.messages/` (`RISA_MESSAGES_DIR` overrides it for the project's own mailbox only; a send to a peer always writes the peer's main checkout's folder), created exclusively as the notice board creates its files (ids `m1`, `m2`, …, never reused). Each keeps `storeId` (null for a local send), `deliveredAt` and `doneAt`. A create with a `storeId` already in the folder writes nothing. Done files are pruned a day after `doneAt`.

### Sending

- `risa message <project> "<text>"` (prd.sh routes it). The route is a pure decision over gathered facts: this machine's name, the homes file's last fetch, the machine config's peers (name, main, whether it has `inbox`) and the store's project names. The target's home is this machine, or it is a peer here with no `inbox` key: the peer's own mailbox (its main checkout's `.loops/.messages`). A home here with no checkout of it in the machine config goes through the store. Otherwise, when the store knows the project (an inbox file or a homes entry): the store file. Otherwise refused. Sending to its own project is refused.
- The store is the sender's own config's `inbox` repo, else the machine config's first repo with one; none and a store route needed: refused, saying a project needs an `inbox` key (`backlog inbox to-repo`).
- It prints one line: `sent m<n> to <project> (this machine)` or `sent to <project> through the inbox store (home: <machine>|no home yet)`.
- `risa messages [--json]`: this project's undone messages, oldest first (id, from project and machine, age, text). `--done <id>` marks one done. `--wait`: blocks until an undelivered, undone message exists, prints them, marks them delivered and exits 0 (only the main backlog session runs it).

### Pickup

- The dispatcher, for a project with `inbox` whose home this run holds (home.mjs's facts), runs the pickup at most every `RISA_MESSAGES_FETCH_SEC`: fetch and read `<project>.messages.json`, create a mailbox file for each entry (skipping a `storeId` already there), then one store write removing exactly those ids. A store it can't reach is retried next time with one line; nothing is lost. A dry run reads and prints, writing nothing.

### Delivery to the backlog session

- The context hook, in the project's main backlog session only (`backlog`), adds the undelivered, undone messages to the session's context at its next tool call (three at most, then a line naming `risa messages`), marked as another project's advice, never the user's word, with how to answer (`risa message <their project> …`) and to mark each done; it sets `deliveredAt`. Any error stays swallowed, as every hook error is.

### Peers and the prompt

- The peers module adds the store's projects to the machine config's: each peer has a name, its home machine (or none yet), its main checkout when on this machine, and whether it is reached through the store. The homes file is read without a fetch (the last fetched copy), so rendering the prompt never waits on the network. The peers CLI prints fixed columns, an empty field as `-`.
- The backlog prompt's peer rule lists each peer with its home, says to send with `risa message` for all of them, and keeps Remote Control only for a peer the store doesn't know and that has no checkout here. A new rule: keep `risa messages --wait` running in the background; when it exits, act on what it printed, mark each done, and start it again. The guide's catch-up collects `risa messages`.

## Testing decisions

- Unit tests on the pure parts: the message codec, append limits, removal and the mailbox's exclusive create, `storeId` skip and pruning (`loops/messages.test.mjs`, new).
- The send route and the CLI against a temp bare repo as the store (the inbox store tests' fixture: `RISA_INBOX_STORE`, `RISA_MACHINE_CONFIG`, `RISA_MACHINE_NAME`, `RISA_MESSAGES_DIR` set by the test), including `--wait` returning on a message written after it starts (`loops/message.test.mjs`, new).
- The pickup on the same fixture: copy then remove, a crash between the two (the mailbox has the `storeId`, the store still has the entry) delivering once, an unreachable store, a dry run, and one `tick` with the pickup injected (`loops/message-pickup.test.mjs`, new).
- The hook's delivery for a backlog session, not a named one or the inbox (`loops/context.test.mjs`).
- The peers from the store and homes (`loops/peers.test.mjs`); the prompt's golden file updated.
- No network, no real `~/.risa`, no real inbox repo.

## Out of scope

- Notices across machines: the notice board coordinates one checkout's sessions, and a project's sessions all run on its home machine.
- Messages to an orchestrator, a planner or the inbox session on another machine: the backlog session relays.
- Ship's notify sender (a follow-up item, above).
- A project that hasn't moved its inbox to the store (`backlog inbox to-repo`): it can send to local peers only.
- Encryption beyond the private repo's access.

## Notes

- usage-aware-drain (RISA-1002, RISA-1074, RISA-814) waits for this topic: after it lands, an account swap changes nothing about how projects reach each other. Its hot files overlap this topic's (`loops/dispatch`, `loops/context`, `loops/prd.sh`), so it runs after.
- Caretook takes part once its machine runs a Risa release with this topic and its config has `inbox`; until then a message to it waits in the store.
