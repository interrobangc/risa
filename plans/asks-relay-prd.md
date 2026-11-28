# PRD: asks-relay

> Items RISA-467 (the backlog session is the go-between for every agent's questions) and RISA-429 (asks queue hygiene). RISA-1036 (a queue-tender role) moves to the follow-on topic `queue-tender` (_Notes_). Topic `asks-relay`.

## Decisions

| Decision                                                                                                                                                                                                                                                          | Why                                                                                                                                     | Source                                                            | Cost to change later                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| Every role but the backlog and inbox sessions files its questions with `risa ask` and waits, attended sessions included (planner, orchestrator, hotfix), while a backlog session is live; with none live, an attended session asks in its own tab as today        | RISA-467's agreed shape, without changing projects that keep no backlog session                                                         | asked: as recommended (a49, after two skeptic send-backs)         | high: every role's prompt                                  |
| The backlog session, not the asker, decides which questions push to the phone: only a blocked-now one while the user hasn't prompted a backlog session for 10 minutes; the rest wait for its next poll                                                            | RISA-467's agreed shape; replaces "the asking session pushes" in the preferences doc, updated on this branch                            | preference (RISA-467, the user 2026-11-21)                        | high: the preferences doc and every prompt's push rule     |
| Attended questions go past the same skeptic as unattended ones (`risa ask` already refuses a question without `--skeptic`)                                                                                                                                        | one rule for every question; the tool enforces it today                                                                                 | assumed                                                           | medium: a prompt clause, or an exemption flag in `ask.mjs` |
| Fallback with no go-between: when no backlog session is live at filing, `risa ask` prints the push line as today; when one is live but hasn't relayed the question in 10 minutes, `risa ask --wait` exits 76 with the push line, the asker pushes and waits again | the fallback RISA-467 proposed ("the ask pushes itself as today, after some minutes"); a project with no backlog session sees no change | assumed (RISA-467's proposal, which its note left to the planner) | medium: one constant and the exit code                     |
| A question whose asker's session has ended, unanswered and never pushed or relayed, is pushed by the dispatcher's one-shot helper (as it pushes its own asks today) when no go-between relays it in 10 minutes                                                    | RISA-429 ("an ask whose session has died still reaches the user")                                                                       | assumed                                                           | low: one tick step                                         |
| Answered, defaulted-and-dismissed and dismissed asks move to `.asks/archive/` a day after they stop being listed; ids are never reused and `getAsk` (and so `--wait`, `answer` and the dispatcher) still finds them there                                         | RISA-429; ids stay stable because the dispatcher reads answers by id                                                                    | assumed                                                           | medium: archived files would have to move back             |
| A report over a day old is listed as "re-check against `risa status`"; one over 3 days old expires (dismissed, then archived)                                                                                                                                     | RISA-429 ("reports that go stale are re-checked or expire")                                                                             | assumed                                                           | low: two constants                                         |
| The asker states how blocking a question is: `--blocks` with `now`, `soon` or `no`, default `now` (an asker waiting on `--wait` is blocked)                                                                                                                       | RISA-467; a default keeps every existing caller working                                                                                 | assumed                                                           | low                                                        |
| The ranking raises a stated urgency to `now` when the asker is a live PRD session (it holds a slot), its session is running `--wait` on it, or a registry row is `after` its topic; a question whose asker has ended is marked so                                 | RISA-467 ("is the session waiting, does it hold a slot, is a planner or topic queued behind it")                                        | assumed                                                           | low: a pure function                                       |
| "The user is active" is the newest prompt a person typed into any live backlog session, from a new `UserPromptSubmit` heartbeat (the sessions' settings file already runs the context hook); task notifications and other sessions' messages don't count          | a fact the tool can read, not the agent's sense of time                                                                                 | assumed                                                           | low                                                        |
| A question that preferences or an earlier answer already settles is still relayed, as a one-tap confirm with that source named; the go-between never answers for the user                                                                                         | RISA-467's proposal; the user's word stays the user's                                                                                   | assumed (RISA-467's proposal)                                     | low: a prompt clause                                       |
| RISA-1036 (queue-tender role) is cut to the follow-on topic `queue-tender`, its row after this one                                                                                                                                                                | a PRD stays small (about six slices)                                                                                                    | preference (orchestration-2)                                      | low: a registry row                                        |

Skeptics: the first sent it back (s26: real-run wiring of the facts, the user-active signal, `risa help`); the second sent it back (s28: role docs, projects with no backlog session, the waiting and `promptAt` facts); the user chose the rework (a49) and the topic is held. Declined: slice 3's size (near the limit, one test file) stays.

## Problem

Agents ask the user in several ways at once. Unattended planners and orchestrators file to the asks queue and each pushes the phone itself; attended ones ask in their own tab, which the user only sees by visiting it. Every push looks alike, so the phone rings for a question nobody is blocked on as loudly as for one holding a lane, and a question whose asking session died is never seen. The queue only grows: answered and dismissed asks stay in the folder forever, and an old report (a topic "on hold" that has since run) still reads as true.

## Solution

The backlog session becomes the one go-between. Every other agent files its question with `risa ask`, saying how blocking it is, and waits in the background; none asks in its own tab. The backlog session watches the queue, ranks the open questions by how soon an answer unblocks real work, relays each to the user verbatim with AskUserQuestion, records the answer, and pushes the phone only for a blocked-now question while the user hasn't been talking to it. When no backlog session is live, or it doesn't relay a question in time, the asker pushes for itself as today, and the dispatcher pushes for an asker that has died. Old asks move to an archive the tools still read, and stale reports are flagged, then expire.

## User stories

1. As the user, I want every agent's questions to reach me through my backlog session, so that I answer in one place instead of visiting tabs.
2. As an asking agent, I want to state how blocking my question is (blocked now, blocked soon, not blocking), so that the go-between knows how soon I need an answer.
3. As the user, I want open questions ranked by how soon an answer unblocks real work (a held slot, a topic queued behind it), so that I answer the costly ones first.
4. As the user, I want my phone to ring only for a blocked-now question I haven't seen, so that a push means something.
5. As the backlog session, I want a command that lists what to relay and whether to push each, and a background watch that wakes me on a new question, so that I relay without polling by hand.
6. As the backlog session, I want to mark a question relayed (and pushed), so that the asker and the dispatcher know it reached the user.
7. As an asking agent, I want to be told to push for myself when no go-between relays my question in time, so that a question never waits unseen.
8. As the user, I want a question whose asking session has died still to reach my phone, so that it isn't lost.
9. As the user, I want a question that preferences or an earlier answer already settles shown as a one-tap confirm naming that source, so that I confirm quickly and the answer stays mine.
10. As the user, I want answered and dismissed asks archived after a day, still found by id, so that the queue stays short and nothing that reads an answer breaks.
11. As the user, I want reports over a day old marked for a re-check and reports over three days old expired, so that an old report doesn't read as the current state.
12. As an attended planner, orchestrator or hotfix session, I want to file my question and wait like an unattended one, so that the user answers it in the backlog session (the same skeptic first).

## Implementation decisions

### The ask's new fields

An ask gains `blocks` (`now`, `soon` or `no`; a question only, default `now`), `relay` (`expected` when a go-between was live at filing, else null), `relayedAt`, `pushedAt` and `pushedBy` (`asker`, `go-between` or `dispatcher`). Every field is optional: an ask filed before this topic reads as `blocks: now`, never relayed, never pushed, and every existing command behaves as today on it.

### Ranking

A pure `rankAsks(asks, facts)` in the asks store, over gathered facts: the session records (name, kind, topic, live) and the registry rows (topic, after). Each question gets an urgency (its `blocks`, raised to `now` when its asker is a live PRD session, its asker's heartbeat runs `ask --wait` on it, or a row is `after` its topic) and its reasons (`holds a slot`, `its session waits on it`, `<topic> waits on it`, `its session has ended`). The facts come from the asks folder alone (`prd.sh` passes only it): the sessions and heartbeat folders beside it, the registry in the main checkout above it. Order: questions by urgency, then by how many reasons raised them, then oldest first; then reports; then the ones decided for you. `risa asks` lists in this order, each question with its urgency and reasons; `--json` carries them; `--short` stays oldest first.

### The go-between

A go-between is live while a backlog session's record is live (sessions.mjs `isLive`). The user is active when a live backlog session's heartbeat records a user prompt within `RISA_ASK_IDLE_MIN` minutes (default 10): the sessions' settings file gains a `UserPromptSubmit` hook, and the heartbeat stores `promptAt` on the session's own record, for a prompt a person typed only (a task notification, a background wake-up or another session's message sets none, or the session's own watch would keep the user looking active). A pure `relayPlan(asks, facts, now)` returns the questions to relay, ranked, each with `push: true` only when its urgency is `now`, it hasn't been pushed (by anyone: a hand-opened backlog session with no record isn't a go-between, so its asker pushed at filing), and the user isn't active.

### Commands

- `risa ask --question … [--blocks now|soon|no]`: when a go-between is live, it records `relay: expected` and prints "The backlog session relays it to the user: send no PushNotification." with the wait line, instead of the push line. With none live, it prints the push line as today and records `pushedBy: asker`.
- `risa ask --wait <id>`: unchanged, except that a question with `relay: expected` still not relayed `RISA_ASK_RELAY_MIN` minutes (default 10) after filing makes it exit 76, printing the push line and "then run --wait again"; it records `pushedBy: asker` so the next wait doesn't exit again.
- `risa asks --relay [--json]`: the go-between's list (relayPlan): each question's full text, options, recommendation, urgency, reasons and push yes or no; reports listed after as a digest, never pushed.
- `risa asks --relayed <id> [--pushed]`: marks the question relayed (and pushed by the go-between), under the ask's lock.
- `risa asks --go-between`: prints `live` or `none`, so an attended session knows whether to file or ask in its tab.
- `risa asks --watch`: waits in the background and exits printing the ids of questions filed (or whose relay became due) since it started; exit 0 then, never on a timer.

### The dispatcher's fallback

A pure `fallbackPushes(asks, facts, now)` in the asks store: unanswered questions never pushed and not relayed whose asker's session has ended (and isn't the dispatcher), when no go-between is live or the relay has waited `RISA_ASK_RELAY_MIN`. The dispatcher's tick pushes each through its existing one-shot helper and records `pushedBy: dispatcher`. Its own asks follow the same rule: no helper while a go-between is live, the helper once the relay is overdue.

### Hygiene

A store function `archiveAsks(dir, now)`: a report over 3 days old is dismissed (expired); any ask not listed for over a day moves to `archive/<id>.json` in the asks folder. Id numbers count the archive, so an id is never reused; `getAsk` reads the archive when the live folder has no such file. The dispatcher's tick runs it with its due-default settling. `risa asks` marks a report over a day old "re-check against `risa status`".

### Prompts

- **The backlog session** (the go-between): at its start, after `risa asks --short`, it reads `risa asks --relay` and, with questions open, first asks whether the user is free to answer them now; it keeps one `risa asks --watch` running in the background and starts it again each time it exits; it relays each question verbatim (text, options in their order, the recommendation marked) in AskUserQuestion, blocked-now first and the rest batched into its next poll; it records the answer with `risa answer <id> <option>` and marks it with `asks --relayed`; it pushes only the questions `--relay` marks push, sending the ask's push line, and marks them `--pushed`; a question preferences or an earlier answer settles is a one-tap confirm naming its source; it never answers for the user. The rules live in the prompt (the backlog role doc has no room).
- **Every other role** (planner, orchestrator, hotfix; attended and unattended): no push of its own except the line `risa ask` or `--wait` prints, and, while `risa asks --go-between` prints `live`, no AskUserQuestion (with none live an attended session asks in its tab as today); it states `--blocks`; on `--wait`'s exit 76 it sends the printed push line and runs `--wait` again. The attended planner's one round, its second send-back, the attended orchestrator's landing-mode and stall questions and the hotfix's judgement calls all become filed asks, past the skeptic, while a go-between is live; the role docs that name AskUserQuestion for them (the planner's, the hotfix's, and this repo's _What to ask_) say the same without growing.

## Testing decisions

- **The asks store** (`rankAsks`, `relayPlan`, `fallbackPushes`, `archiveAsks`, the new fields' defaults): unit tests on temp folders, the prior art being `loops/asks.test.mjs`.
- **The commands** (`--blocks`, the relay line, `--wait`'s 76, `--relay`, `--relayed`, `--watch`): script tests with a temp asks folder, a temp sessions folder and stub process facts, as `loops/ask.test.mjs` does.
- **The heartbeat's prompt mark**: `loops/heartbeat.test.mjs`'s hook-input tests.
- **The dispatcher's fallback and archive step**: tick tests in `loops/dispatch.test.mjs` with a stub helper, as its own-ask push tests do.
- **`risa help`**: `loops/prd.sh`'s _Asks_ lines name the new flags and exit 76.
- **Prompts**: `loops/prompt.test.mjs` assertions and the golden file (`loops/sample-project/prompt-golden.txt`, regenerated).
- Hermetic: every test names its asks, sessions and heartbeat folders; none reads the real `.loops`.

## Out of scope

- The queue-tender role (RISA-1036): the follow-on topic `queue-tender`.
- A push service that works without a live Claude session (a push still needs one: the asker, the go-between or the dispatcher's helper).
- The inbox session: it keeps its own way with the user.
- A reopened session listing its topic's answered asks (RISA-429's sketch, not its words).

## Notes

- RISA-1036's planner weighs a separate queue-tender against folding it into the backlog role. This topic makes the backlog session busier (it relays every question), which argues for a separate tender; RISA-1033 and RISA-1034's stall guards have landed in `fixes-bug-urgent`.
- `loops/ask.mjs`, `loops/prompts/backlog.sh` and `loops/prompt.test.mjs` are `fixes-bug`'s hot files and `loops/dispatch` is `risa-next-2`'s, so the dispatcher starts this topic only when neither shares a prefix with a running topic.
