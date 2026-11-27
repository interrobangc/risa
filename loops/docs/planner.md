# Planner handbook

For a planning agent: writing a PRD and its plan on `plan/<topic>` in `.loops/plan-<topic>` (stackless, from the trunk). Read `{{prd}} doc backlog` too: you triage items into the topic.

## From idea to plan

**Decide, then report.** The user accepts nearly every recommendation, so don't interview: explore, decide, write, and ask only what _What to ask_ names.

1. **Explore:** the items, the area docs, the code and the preferences doc (what the user has already settled).
2. **Ask once, if at all** (_What to ask_), then decide everything else yourself.
3. **PRD:** `plans/<topic>-prd.md`, opening with a _Decisions_ table (below), then _The PRD's shape_. No GitHub issues: the PRD, the plan and the backlog are the record.
4. **Plan:** cut it into tracer-bullet vertical slices in `plans/<topic>-plan.md` (_The plan's shape_). The breakdown is yours; don't ask for approval.
5. **The skeptic pass** (below), then land and report.
6. **Loops** run the slices, one agent per slice, under the PRD's orchestrator (`{{prd}} doc orchestrator`). When the PRD is done, its decisions move into the area docs and it's marked done.

**Don't load the `write-a-prd`, `prd-to-plan` or `grill-me` skills.** They tell you to interview the user and wait for approval, which this handbook forbids; what they were used for is written here.

`{{prd}} plan <topic> --open [B-<n> …]` does steps 1 to 5 in one session: it makes the worktree and starts an agent there (`prompt.sh plan`), on opus, or on Fable for a row flagged `design` (`--model` overrides).

## The Decisions table

The PRD opens with it, the costliest to change first, so the user can veto by reading one table:

```
| Decision | Why | Source | Cost to change later |
| -------- | --- | ------ | -------------------- |
| Owners only can export | least exposure | assumed | low: one permission |
| Keep reminders until wave 2 | the user's call | asked: recommended drop, chose keep | high |
```

**Source** is `assumed` (you decided), `asked: as recommended`, `asked: recommended X, chose Y`, or `preference` (from the preferences doc). The `chose` rows show which kinds of question are still worth asking; when one states a rule that will outlast this topic, add it to the preferences doc on your branch.

## The PRD's shape

After the _Decisions_ table: **Problem** and **Solution** (both from the user's side); **User stories** (numbered, "As a …, I want …, so that …", covering every item); **Implementation decisions** (modules built or changed and their interfaces, schema, API contracts, interactions; prefer deep modules, a lot behind a small interface that tests alone; no file paths or code); **Testing decisions** (which modules, at which level, the prior art); **Out of scope**; **Notes**.

## The skeptic pass

Before landing, `{{prd}} prompt skeptic plan --evidence <file>` prints the brief for one fresh agent on Opus (`model: "opus"`). It reads the PRD, the plan and the items cold and returns **go** or **send-back** with a short list: an `assumed` decision that _What to ask_ says to ask; an item's need left uncovered; a slice too big for one agent or missing a `Blocked by`; a broken rule across PRDs (`{{prd}} doc orchestrator "Rules across PRDs"`) or test budget. It never moves a UX or UI detail to "ask". Record it: `{{prd}} skeptic record --kind plan --verdict go|send-back --why "…"`.

- **Go:** fix what's right, note what you declined and why under the table, and ask the user only the decisions it rightly moved to "ask".
- **Send-back:** rework, then run a fresh skeptic once more (one retry).
- **A second send-back** is the user's. Attended: AskUserQuestion. Unattended: first flag the row `hold`, keeping its other flags, so the dispatcher never starts the plan; then a `--waits` question with `--skeptic <its id>`. Land only after the answer, with `hold` still on; the report says how to lift it.

## The plan's shape

- A _Status_ table (slice, wave, state, merge SHAs), which the orchestrator keeps current; the durable architectural decisions every slice follows; _How to run this plan_ (waves, gates, what each slice owns).
- Each slice: its fields line, user stories, what to build, acceptance criteria, and what it's **Blocked by** and **Blocks**, so independent slices can run at once.
- **A slice is a tracer bullet:** a thin, complete path through every layer it needs (schema, service, API, screen, tests) that can be shown or checked alone, never one layer across the feature. Name the exact files and functions it changes in backticks (`path/file.mjs` `fnName`; new ones marked new), never line numbers (`~158`): they go stale (`{{prd}} anchors`). **A slice touching more than about 8 files, or more than one running topic's hot file, is split** (a merge past 12 files warns). Cite PRD parts by their exact heading: the slice's prompt embeds them.
- **Keep a PRD small: about six slices at most.** Cut a bigger one into follow-on topics (`<topic>-2`) that each land something usable, so the next planner or the user can reorder fixes between them. Say in the report what you cut and where it went.
