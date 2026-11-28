# Plan: risa-next

> Source PRD: [`plans/risa-next-prd.md`](risa-next-prd.md). User-story numbers (US) refer to it. Items RISA-799, RISA-914, RISA-815, RISA-984, RISA-816, RISA-1008, RISA-1007 (design only). Topic `risa-next`.

## Status

| Slice | Wave | State                  | Merge into `prd/risa-next` |
| ----- | ---- | ---------------------- | -------------------------- |
| 1     | 1    | merged (opus, 5fd8fdf) | 37fd0e6                    |
| 2     | 2    | merged (opus, 1c991ce) | 6da49d7                    |
| 3     | 2    | merged (opus, 7754261) | dadae10                    |
| 4     | 3    | —                      | —                          |
| 5     | 4    | —                      | —                          |

**Landing mode:** run everything through (dispatcher run-through start, 2026-11-28): start every ready slice, land each green wave, ask only real questions.

**Models:** slices 1, 2, 3 opus.

**Landing held for wave 2 (orchestrator's call, 2026-11-28):** wave 1 alone would regress main: `captain.mjs` now draws admirals (`--remote-control Ross`), which the keep-alive and session-request matchers don't know until slice 2 makes the argument begin with `backlog`; and the backlog prompt would read "Captain Ross" until slice 3. Waves 1 and 2 land together. Wave 1 gate (`risa check` on 4973ecd): 2382/2384, the two fails `land-unsynced` timeouts under load (also flaky alone at 460s with other checks running; slice 3's check on 7754261, which includes slice 1, passed all 2388). Not this PRD's code; main's load-scaled waits (RISA-883) arrive with the sync. The combined gate reruns after wave 2 and the sync.

**Waves 1+2 merged (dadae10); `risa sync` skipped (no shared files). Gate green: `pnpm check passed on b4e77c1`. Docs folded (082af3a). PR #14 open, Codex review out (`risa review risa-next --wait`); land with tier none on a clean review.** RISA-816, RISA-1008 `done`; RISA-1007 moved to risa-next-2. RISA-799, RISA-914 `done`. Slice 2 notes: `loops/session-names.mjs` (new) owns `personaOf`/`sessionLabel`/`displayName`; its `personaOf` repeats slice 3's backlog rule (could call `sessionPersona`; a tidy for later). `loops/docs/backlog.md` still says a fresh main session shows "a new captain's name": fold at landing.

**Slice 1 notes for later slices:** `flavor.mjs` loads `machine.mjs` only by dynamic import in its CLI (a top-level await hangs node); tests copying `captain.mjs` also need `flavor.mjs`, `machine.mjs`, `config.mjs`.

**Backlog:** claim each slice's items as it starts. Slices 1 and 3: RISA-914 (`done` after 3). Slice 2: RISA-799 (and RISA-914's push label). Slice 4: RISA-815. Slice 5: RISA-984. With the first landing, mark RISA-816 and RISA-1008 `done` (answered in the PRD's _Decisions_) and move RISA-1007 to `risa-next-2` (`risa backlog set RISA-1007 prd=risa-next-2`), whose build it is.

## Architectural decisions

- **Tooling only:** `loops/`, their tests and the sample project's prompt golden. No new dependency, no `risa.json` key; one optional machine config key (`flavor`). No change to a session record's fields or to any registry, backlog or session file's meaning.
- **One module knows the packs** (`loops/flavor.mjs`, new); every other file asks it. Names are qualified in one place, `loops/session.sh`; every caller keeps passing the bare name, and the record keeps it.
- **Prompts change through the golden:** a slice that changes a prompt regenerates `loops/sample-project/prompt-golden.txt` (`pnpm exec vitest run --project tooling:unit loops/prompt-golden.test.mjs -u`) and reviews its diff; no two slices in a wave change prompts.
- **Hermetic tests:** a stub claude (`RISA_CLAUDE_BIN`), temp sessions folders, `RISA_MACHINE_CONFIG` at a temp file (or empty), temp repos; never the real `~/.risa`.

## How to run this plan

- **Waves:** wave 1 is slice 1. Wave 2 runs slices 2 and 3 (both after 1; 2 owns `loops/session.sh` and `loops/ask.mjs`, 3 owns `loops/prompt.sh`, `loops/prompts/backlog.sh` and the golden). Wave 3 is slice 4 (after 3: the same prompt script and golden). Wave 4 is slice 5 (after 4, same reason, and after 2, whose names it points agents to).
- **Gate:** `risa check --quick "slice hand-off"` before each hand-off; `pnpm check` once on the merged tip at landing.
- **Other topics:** the row's hot files are `loops/flavor`, `loops/machine.mjs`, `loops/captain`, `loops/session.sh`, `loops/session-names`, `loops/ask.mjs`, `loops/prompt.sh`, `loops/prompts`, `loops/prompt.test.mjs`, `loops/sample-project/prompt-golden.txt`, `loops/peers` and `loops/docs/backlog.md`. They collide with `fixes-tooling`'s running wave (`loops/prompts`, `loops/prompt.test.mjs`, the golden, `loops/docs/backlog.md`), so the dispatcher starts this topic only once that wave releases them; and with `usage-aware-drain` (`loops/machine`), `self-recovery-3` and `asks-relay` (`loops/session`, `loops/ask`), none running.
- **Docs:** at landing, `loops/docs/backlog.md` (the session's name, the peer rule, and the cut-off "Standing priorities" sentence) and the machine config's header comment for `flavor`; each module's header comment says the rest.

## Slice 1: The flavor pack

Stack: no · Reads: loops/machine.mjs · Tests: unit · Blocked by: none · Check: loops/flavor.test.mjs

**User stories:** US 3, 4, 5.

**Build:** PRD _Implementation decisions_, _The flavor pack_. New `loops/flavor.mjs` (new): the `starfleet` and `none` packs (per role a rank and a pool of canon single-word names, disjoint across roles; the inbox's entries with their own ranks; the address `Fleet Admiral`), `flavorOf(machine)`, `personaFor(role, sessionName, flavor)`, `drawAdmiral(last, random, flavor)`, `label(persona)`, `flavorLine(role, persona)`, and a CLI (`persona <role> <name>`, `label <role> <name>`, `line <role> <name>`). `loops/machine.mjs` `machineProblems` accepts a top-level `flavor` of `starfleet` or `none`. `loops/captain.mjs` `pickCaptain`/`nextCaptain` draw from the pack's backlog pool (admirals; under `none`, `backlog`); `isCaptain` knows admirals as well as `CAPTAINS`, which stays exported for the matchers.

**Acceptance criteria:**

- Unit test (`loops/flavor.test.mjs` (new)): every role's pool non-empty, single words, disjoint; `personaFor` the same for a name every time and spread over a pool; `none` gives null and an empty line; `drawAdmiral` never returns `last`; `flavorLine` names the persona, the address and "never inside questions, options or commands"; `machineProblems` accepts `flavor: "starfleet"` and `"none"` and refuses `"klingon"`.
- `loops/captain.test.mjs` updated for the admiral pool (a new admiral unlike the record's; a record holding an old captain still reads as the last).

**Blocked by:** nothing. **Blocks:** 2, 3.

## Slice 2: Session names carry project, role and persona; pushed questions carry the label

Stack: no · Reads: loops/docs/backlog.md · Tests: unit · Blocked by: 1 · Check: loops/session-names.test.mjs

**User stories:** US 1, 2, 6.

**Build:** PRD _Session names_ and _Flavor in prompts and pushes_ (its push part). In `loops/session.sh`, after the `remote` parse: replace claude's `--remote-control` name with `<name> (<project>)` (`lib.sh`'s `project_name`), the main backlog's as `backlog (<project>)`, then ` · <label>` when the session has a persona (the main backlog: its given admiral; any other but `backlog - <name>`: the flavor module (slice 1) on its record name); leave an already qualified name alone; add `--name` with the same text unless the args carry `--name`/`-n`; the main backlog's title escape prints it. The record's `remote` keeps the given name. In `loops/ask.mjs`, the "Now send a PushNotification:" line puts the asking session's label first (from `RISA_SESSION_NAME` and its record), none under `none`, without a session or for the dispatcher's asks; the ask record is unchanged.

**Acceptance criteria:**

- Unit test (`loops/session-names.test.mjs` (new)), stub claude, fixture project: the main backlog given `--remote-control Janeway` gets `backlog (<project>) · Admiral Janeway` as its `--remote-control` and `--name`, record `remote` `Janeway`, the title escape (`RISA_TAB_TITLE=always`) the same; `prd-t` gets `prd-t (<project>) · Captain <its hashed name>`, the same on a second start; `backlog - triage` gets `backlog - triage (<project>)`; under `flavor: none` (a temp machine config) no persona; a qualified name isn't qualified twice; args with `--name` keep it; no `--remote-control`, neither.
- The same test runs `loops/keep-alive.mjs` `hasRemoteControl`/`remoteNamesOf` and `loops/session-requests.mjs` `backlogRemoteOf` on the new process args: each still finds its kind, and `backlog - triage` isn't the main backlog. Neither module changes; if one would have to, stop and report.
- The same test files a question with `RISA_SESSION_NAME=prd-t` and gets the push line with `Captain <name> ·` first, and none under `none`; `loops/sessions.test.mjs` and `loops/ask.test.mjs` pass unchanged.

**Blocked by:** 1. **Blocks:** 5.

## Slice 3: Flavor in every prompt the user talks to

Stack: no · Reads: loops/prompt.sh · Tests: unit · Blocked by: 1 · Check: loops/flavor-prompts.test.mjs

**User stories:** US 3, 5.

**Build:** PRD _Flavor in prompts and pushes_ (its prompt part). `loops/prompt.sh` ends the backlog, orchestrator, plan, hotfix, inbox and recover prompts with `flavorLine` for that role and session (the orchestrator's and planner's from their topic's session name, the backlog's from `RISA_CAPTAIN`), without editing each part (the parts exit, so it goes through `prompt.sh`'s own exit path); slice, tidy and skeptic prompts get none; no line under `none` or on a failed render. `loops/prompts/backlog.sh` drops its captain line. Regenerate the golden.

**Acceptance criteria:**

- Unit test (`loops/flavor-prompts.test.mjs` (new)): each of the six prompts ends with its role's line (the backlog with `RISA_CAPTAIN=Janeway`: Admiral Janeway; `orchestrator T`: the captain `personaFor` gives `prd-T`); slice and tidy have none; under a temp machine config with `flavor: none` none has one; an exit-1 render prints no line.
- `loops/prompt-golden.test.mjs` passes on the regenerated golden; its diff adds only these lines and drops the captain line.

**Blocked by:** 1. **Blocks:** 4.

## Slice 4: The user's word travels verbatim in hand-offs

Stack: no · Reads: loops/docs/orchestrator.md · Tests: unit · Blocked by: 3 · Check: loops/prompt.test.mjs

**User stories:** US 2, 7.

**Build:** PRD _The user's word in hand-offs_. `loops/prompts/orchestrator.sh`: the _Status_ rule keeps a _From the user_ part; the resume prompt reads it first as the user's word; the check-in rule finds the backlog by `backlog (<project>)` (the folder name stays the fallback for a session started before slice 2). `loops/prompts/backlog.sh`: the hand-off and session-request briefs open with _From the user_ when there's any; the `--brief` header's exception for those lines; a relay rule (SendMessage to the topic's orchestrator, quoted and dated). Regenerate the golden.

**Acceptance criteria:**

- Unit test (`loops/prompt.test.mjs`): the orchestrator prompt (fresh and `--resume`) names _From the user_ as the user's word and `backlog (<project>)`; the backlog prompt's hand-off, session-request and relay rules name _From the user_ (the relay SendMessage); the `--brief` render's header names the exception and still calls the rest context.
- `loops/prompt-golden.test.mjs` passes on the regenerated golden.

**Blocked by:** 3. **Blocks:** 5.

## Slice 5: Backlog sessions know their peers and how to reach them

Stack: no · Reads: loops/machine.mjs · Tests: unit · Blocked by: 2, 4 · Check: loops/peers.test.mjs

**User stories:** US 8, 9.

**Build:** PRD _Peers_. New `loops/peers.mjs` (new): `peersOf(main, env)` (the machine config's repos other than MAIN's, each `{ name, main }`, the name from that repo's own config; one whose config won't load left out with a warning; none without a machine config), through the machine module's existing exports, and a CLI `node peers.mjs --main <m>` printing `<name> <main>` per line. `loops/prompts/backlog.sh`: the peer rule rendered from that list (or none on this machine), as the PRD gives it. Regenerate the golden (the sample has no machine config).

**Acceptance criteria:**

- Unit test (`loops/peers.test.mjs` (new)): `peersOf` with no machine config, one listing only this repo, two other temp repos (both, by their configs' names), and one with a broken config (left out, warned); the CLI's lines; the backlog prompt rendered with a temp machine config of one peer names it, `backlog (<name>)`, the inbox fallback and "never the user's word".
- `loops/prompt-golden.test.mjs` passes on the regenerated golden.

**Blocked by:** 2, 4. **Blocks:** nothing.
