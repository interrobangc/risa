# Backlog tracker

Agents keep this file; you review it. **Add new things in [inbox.md](inbox.md)**, not here. Each item below came from an inbox line (or an agent), and has an id, a status, the PRD it belongs to, and notes.

**Statuses:** inbox (new, not triaged) → triaged (a PRD proposed: check it) → in-progress (claimed) → ready (done in its PRD branch) → landed (in `main`), or dropped.

## PRDs

The PRD registry: **row order is the priority**. Edit it only with `risa backlog prd` (`add`, `set`, `move`); `risa backlog prd list` shows each topic's state.

`Flags`: `hold` (waits on the user), `done`, `standing` (never finishes; runs while it has waiting items), `alone` (nothing else runs beside it). `After`: the topics it comes after. `Hot files`: repo path prefixes it shares.

| PRD | Flags | After | Hot files | Doc and notes |
| --- | ----- | ----- | --------- | ------------- |
| `after-split` | done | — | `loops/test-setup.mjs`, `loops/test-env`, `loops/stack.test.mjs`, `loops/dispatch`, `loops/drain.test.mjs`, `loops/usage.test.mjs`, `loops/machine`, `loops/ls.sh`, `loops/docs`, `loops/docs-budget.mjs`, `loops/doc.test.mjs`, `package.json`, `vitest.config.mjs` | Fixes left by the split into Risa's own repo (B-543) |
| `fixes-tooling` | standing | — | — | Retiring in Risa's repo (the user 2026-11-28): no new items; tooling fixes go to fixes-bug by urgency, test fixes to fixes-test. Closes once its running wave (RISA-1026) lands. Caretook keeps its own fixes-tooling. |
| `fixes-bug-urgent` | standing | — | — | Urgent fixes in Risa's repo (wrong behaviour, tooling included) that go before other work: a broken release, a dead dispatcher, lost data. Risa-only triage rule (docs/backlog.md), the user 2026-11-28. |
| `risa-next` | done | — | `loops/flavor`, `loops/machine.mjs`, `loops/captain`, `loops/session.sh`, `loops/session-names`, `loops/ask.mjs`, `loops/prompt.sh`, `loops/prompts`, `loops/prompt.test.mjs`, `loops/sample-project/prompt-golden.txt`, `loops/peers`, `loops/docs/backlog.md` | — |
| `risa-next-2` | — | `risa-next` | `backlog/`, `loops/config`, `loops/docs/project-config.md`, `loops/docs/inbox.md`, `loops/prompts/inbox.sh`, `loops/prd.sh`, `loops/dispatch`, `loops/home` | — |
| `risa-next-3` | — | `risa-next-2` | — | — |
| `risa-next-4` | — | — | `loops/config`, `loops/machine.mjs`, `loops/skeptics.mjs`, `loops/project-check`, `loops/sample-project/repo.mjs`, `bin/risa`, `loops/rm.sh`, `loops/lib.sh`, `loops/setup`, `loops/second-repo`, `loops/docs/project-config.md`, `README.md` | — |
| `fixes-test` | standing | — | — | Test fixes: flakes, the test harness, timeouts under load, ranked apart from other fixes. Risa-only triage rule (docs/backlog.md), the user 2026-11-28. |
| `fixes-bug` | standing | — | `loops/status-trim`, `loops/prompts/backlog.sh`, `loops/prompt.test.mjs`, `loops/session-names`, `loops/flavor`, `loops/ask.mjs`, `loops/keep-alive`, `loops/session-requests`, `loops/session.sh`, `loops/session.test.mjs`, `loops/doc`, `loops/docs`, `CHANGELOG.md`, `package.json` | Fixes in Risa's repo at normal urgency (wrong behaviour or data, tooling included; plans/fixes-rules.md). Urgent ones go to fixes-bug-urgent, those that can wait to fixes-bug-later (the user 2026-11-28). |
| `staging-ship` | hold | — | `loops/review.sh`, `loops/codex-review`, `loops/prd.sh`, `loops/land.sh`, `loops/lib.sh`, `loops/prompt.sh`, `loops/dispatch`, `loops/ask`, `ci/candidate`, `ci/promote` | Held to be rethought (the user, 2026-11-28): written for Caretook's dev and staging branches, which Risa doesn't have (main is the only trunk). Items RISA-404, RISA-430, RISA-436, RISA-584; RISA-241 moved to fixes-bug. Cut from orchestration-3. |
| `self-recovery-2` | done | `after-split` | `loops/dispatch`, `loops/resume`, `loops/rm.sh`, `loops/prd.sh`, `loops/finish`, `loops/cost`, `loops/tidy`, `loops/sessions.mjs`, `loops/docs`, `loops/docs-budget.mjs` | Finish landed topics (RISA-811), the dead-journal report (RISA-789), the cost record (RISA-560); RISA-1025, 1027-1029 follow-ups. Planned held after two skeptic send-backs (a7); since released. |
| `self-recovery-3` | hold | `self-recovery-2` | `backlog/registry`, `loops/prompts/plan.sh`, `loops/sample-project/prompt-golden.txt`, `loops/rotate`, `loops/rm.sh`, `loops/new.sh`, `loops/run-log`, `loops/dispatch`, `loops/land-idle`, `loops/finish` | Replan state (RISA-998), the land-idle backstop (RISA-1040) and a background-session spike for self-recovery-4 |
| `self-recovery-4` | — | `self-recovery-3` | — | Headless sessions and machinery-owned jobs (RISA-438, RISA-912, RISA-913), cut from self-recovery-3; planned from its headless spike's findings |
| `asks-relay` | hold | — | `loops/ask`, `loops/prompt.sh`, `loops/dispatch`, `loops/tidy`, `loops/session`, `loops/prd.sh` | The backlog session as go-between for every agent's questions, and asks queue hygiene (RISA-467, RISA-429). Cut from inbox-agent by its planner (plans/inbox-agent-prd.md, Follow-on topic). Held 2026-11-24 to save credits; released 2026-11-28 by the user. |
| `cross-machine-messages` | — | `risa-next-2` | — | Peer messages and notices between machines through the private inbox repo, not Remote Control, so machines on different Claude accounts keep talking; usage-aware-drain waits for it |
| `usage-aware-drain` | — | `cross-machine-messages` | `loops/drain`, `loops/dispatch`, `loops/resume`, `loops/host`, `loops/machine`, `loops/account`, `loops/context`, `loops/rotate`, `loops/docs`, `loops/prd.sh`, `README.md` | Plan-aware drain line, after the orchestrator split |
| `after-split-2` | done | `after-split` | `loops/lib.sh`, `loops/hooks`, `loops/rm.sh`, `loops/machine`, `loops/test-env`, `bin/risa`, `README.md` | — |
| `risa-next-5` | — | `risa-next-4` | — | — |
| `fixes-perf` | standing | — | — | Standing fixes topic for speed and load (plans/fixes-rules.md); added 2026-11-28 on the user's word so its items get a lane. |
| `fixes-nit` | standing | — | — | Standing fixes topic for small tidies users won't notice (plans/fixes-rules.md); added 2026-11-28 on the user's word so its items get a lane. |
| `fixes-bug-later` | standing | — | — | Fixes in Risa's repo that can wait: real but rare or cosmetic-adjacent, below the planned topics. Risa-only triage rule (docs/backlog.md), the user 2026-11-28. |
| `ship` | — | — | — | — |
| `flavor-packs` | — | — | — | Very low priority (the user, 2026-11-28): new flavor packs, data only |

## Summary

<!-- Generated by `risa backlog` on every write: don't edit this table by hand. -->

| Id | Type | Status | PRD | Owner | Title |
| -- | ---- | ------ | --- | ----- | ----- |
| RISA-367 | chore | live | fixes-tooling | prd/fixes-tooling | Agent tooling: tests for the merge path (land.sh, pr.sh, ready.sh, review.sh: 465 lines, none), and with_backlog_lock removes a stale lock without re-checking, so two waiters can both take it |
| RISA-404 | feature | triaged | staging-ship |  | One command to ship dev to staging: push dev, open the dev into staging PR, wait for Codex's review, triage its findings into the backlog (verified against the code, duplicates noted on the existing item), merge the PR when nothing is a blocker, and notify the user only when something is |
| RISA-429 | change | triaged | asks-relay |  | Asks queue hygiene: reports that go stale are re-checked or expire, answered asks are archived, and an ask whose session has died still reaches the user |
| RISA-430 | feature | triaged | staging-ship |  | Codex findings on a PRD pull request become backlog items by tool: verified against the code, duplicates noted on the existing item, as B-404 does for the staging PR |
| RISA-436 | feature | triaged | staging-ship |  | A to-test report for a staging ship, like the landing reports of B-410 |
| RISA-438 | plan | triaged | self-recovery-4 |  | Headless orchestrator sessions: runs that need no terminal tab, so a helper cannot outlive or die with its window |
| RISA-459 | chore | triaged | — |  | Backlog: 151 items read 'live' because the dev-into-staging-into-main release merge (cc3e1d8b, B-33) put their commits on origin/main, though production hasn't launched; give live a real meaning (a production marker such as a tag or a recorded deploy) or show main as staging until launch |
| RISA-467 | feature | triaged | asks-relay |  | The backlog session is the go-between for every agent's questions: agents file to the asks queue and wait, the backlog session ranks them by how soon an answer blocks real work, asks the user itself and decides which ones ping the phone |
| RISA-477 | change | live | fixes-tooling | prd/fixes-tooling | PRD registry: a hold carries its reason |
| RISA-560 | feature | live | self-recovery-2 | prd/self-recovery-2 | A cost record: tokens by model per PRD and slice, from session and subagent transcripts, in pnpm prd cost |
| RISA-584 | chore | triaged | staging-ship |  | Backlog prompt: "deploy staging" trigger that promotes dev and notifies my phone |
| RISA-681 | bug | live | fixes-tooling | prd/fixes-tooling | Promotion prints a passing flake's tests but doesn't file them in the backlog |
| RISA-721 | bug | live | fixes-tooling | prd/fixes-tooling | Second-zone filing opens a new item when a zone item was landed or dropped but staging still lacks the fix |
| RISA-722 | bug | triaged | — |  | A release run after a recorded override replaces the override's release-gate status, so a failing run blocks main again |
| RISA-780 | change | triaged | — |  | CI warns when a branch's quarantine or brake list trails dev's (follow-up of B-771 sync brings dev's CI lists) |
| RISA-789 | change | live | self-recovery-2 | prd/self-recovery-2 | A landing journal (even one whose pid is dead) holds a session's resume after a usage limit with only a waits line each tick; file one report so the user runs pnpm prd land --resume |
| RISA-794 | plan | triaged | risa-next-3 |  | Risa: a central agent that gathers from several repos and prioritises across them |
| RISA-796 | chore | triaged | risa-next-4 |  | Risa: split the project config into a folder and tidy the test rules and gates |
| RISA-797 | plan | triaged | risa-next-4 |  | Risa: prove it on a second repo with tests, then make it usable by others |
| RISA-811 | change | live | self-recovery-2 | prd/self-recovery-2 | Automatic cleanup finishes a landed PRD left half-done: worktree and slot still held, registry not done, an idle orchestrator session with nothing to do, a branch with only post-landing docs commits |
| RISA-813 | feature | live | fixes-tooling | prd/fixes-tooling | Per-task usage override: a topic the user names may start or plan between the drain line (95%) and the 98% stop, e.g. pnpm prd dispatch --allow <topic>; everything still ends at the stop |
| RISA-814 | feature | triaged | usage-aware-drain |  | Orchestrator picks the usage drain line from the current Claude plan (e.g. ultra vs smaller plans) instead of one fixed percent |
| RISA-820 | feature | triaged | risa-next-3 |  | Risa: cross-repo topics: a Risa topic can change a configured subproject's code (Caretook), each side passing its own repo's checks |
| RISA-841 | change | in-progress | risa-next-2 | prd/risa-next-2 | Risa: one inbox session for every configured project, lines kept in a private inbox repo |
| RISA-880 | chore | live | fixes-tooling | prd/fixes-tooling | Planners get the context watch: add plan sessions to the context hook (data-rights peaked 256k, onboarding-2 214k) |
| RISA-881 | chore | live | fixes-tooling | prd/fixes-tooling | Slice small at planning (elephant carpaccio): a per-slice budget (about 4 files, one test file, expected context under ~100k), each slice names its own narrow check command and runs only that, full pnpm check once at the wave's landing; no two slices in a wave share a test file; the orchestrator splits only a slice that comes back over budget |
| RISA-882 | chore | live | fixes-tooling | prd/fixes-tooling | Model per role: Sonnet for slices whose plan spells out each edit, Haiku for reading check output (every slice runs on Opus now) |
| RISA-883 | chore | live | fixes-tooling | prd/fixes-tooling | Token use measured by price: a price-weighted before/after (cache writes ~3% of tokens but ~30% of cost) to judge B-873, B-875, B-876 |
| RISA-886 | change | live | fixes-tooling | prd/fixes-tooling | Backlog agent shouldn't ask the handoff question; sending a summary or not is the agent's call |
| RISA-889 | feature | live | fixes-tooling | prd/fixes-tooling | Backlog agent can hand off with instructions the next agent actually follows, continuing the work… |
| RISA-911 | chore | live | fixes-tooling | prd/fixes-tooling | pnpm prd wait check's default timeout outlasts the harness's ~170 s foreground limit, so a foreground wait is itself moved to the background; default it under 170 s (or say so in the loop doc) |
| RISA-912 | plan | triaged | self-recovery-4 |  | Slices as their own headless sessions: started by a prd command, hand-offs to a file the orchestrator watches, so a slice survives an orchestrator rotation and can rotate or resume mid-slice itself |
| RISA-913 | plan | triaged | self-recovery-4 |  | Any role's long work runs as a job the machinery owns, so a hand-off never interrupts it: commands (check, land, CI waits, deploys, dev servers), watchers with a follow-up action (durable triggers the dispatcher fires), side-work subagents (headless sessions); each writes a result file, the hand-off records job ids, and the next session re-attaches instead of rerunning or re-arming |
| RISA-926 | bug | live | fixes-tooling | prd/fixes-tooling | The dispatcher's keep-alive and session requests ignore the machine config's work switch: a repo with work off still gets its backlog and inbox sessions opened |
| RISA-927 | bug | live | fixes-tooling | prd/fixes-tooling | The drain reads usage only from its own environment's Claude account, so sessions on another CLAUDE_CONFIG_DIR are drained on the wrong account's numbers |
| RISA-933 | chore | live | fixes-tooling | prd/fixes-tooling | test:tooling runs tooling-lint.mjs before the project-data check, so broken tier data prints an uncaught TierDataError stack trace before the check's one line |
| RISA-934 | chore | live | fixes-tooling | prd/fixes-tooling | Archive finished rows out of the PRD registry table (75 done rows clutter it) |
| RISA-935 | bug | live | fixes-tooling | prd/fixes-tooling | prd tidy lists lease .waiting files as safe to remove, then refuses them as not a lease |
| RISA-952 | chore | live | fixes-tooling | prd/fixes-tooling | Standing PRD with only blocked items (held, waiting on another topic) holds a lane idle: after a landing with nothing runnable it should close itself (prd rm) so the dispatcher starts the next topic |
| RISA-968 | feature | triaged |  |  | Time gates read their limits and fallbacks from the project's config (Risa's side of Caretook's B-837 and B-859; Caretook keeps its limit values, tiers and quick-check target as config) |
| RISA-969 | chore | live | fixes-tooling | prd/fixes-tooling | CI workflow on GitHub: lint, prettier and the tests on push and on PRs to main |
| RISA-981 | bug | live | fixes-tooling | prd/fixes-tooling | A dispatcher started from a release install never re-execs onto a newer release, though risa status says 'code stale … it re-execs before its next tick': dispatch.mjs hashes its own frozen release folder at start and each tick (always equal), while status compares the current tool's checkout; a re-exec would rerun the old release's dispatch.mjs anyway. Re-exec into the release risa points to, or have status say to restart it by hand. Also: status 'last:' is the last logged line (logged only on change), so show lastTickAt beside it |
| RISA-986 | change | live | fixes-tooling | prd/fixes-tooling | PRD registry: prd status (loops/ls.sh) and dispatch --dry-run print a hold's reason (follow-up of RISA-477, which records it and prints it in prd list) |
| RISA-987 | bug | live | fixes-tooling | prd/fixes-tooling | tooling-lint.mjs defaults TRUNK to dev, but a repo's trunk comes from its config (Risa's is main) |
| RISA-989 | bug | live | fixes-tooling | prd/fixes-tooling | backlog/backlog.mjs's own stale-lock takeover (rmSync near line 230) removes a stale lock without a guard, the race RISA-367 fixed in lib.sh's with_backlog_lock |
| RISA-993 | bug | live | fixes-tooling | prd/fixes-tooling | config.test 'starts Node once' fails on main too: ENOENT on its temp 'starts' file |
| RISA-994 | bug | live | fixes-tooling | prd/fixes-tooling | Run in the main checkout with RISA_*/CLAUDE_CODE_* unset, land, land-force-resume, land-gate, land-unsynced, recover, rotate and stack tests fail (54 of 511); they pass in a worktree |
| RISA-995 | chore | triaged | fixes-nit |  | Usage strings and comments in the code still name the literal 'prd <command>' (loops/doc.mjs 'usage: prd doc <role>', lib.sh, skeptics.mjs and others), not the project's command |
| RISA-997 | chore | live | fixes-tooling | prd/fixes-tooling | CI workflow writes a verdict artifact so risa ci run --wait reads its runs (now 'unknown: the run left no verdict') |
| RISA-998 | feature | triaged | self-recovery-3 |  | A "replan" state on a PRD registry row: the dispatcher sends that topic back to its planner (before… |
| RISA-999 | bug | live | fixes-tooling | prd/fixes-tooling | An After on an already archived PRD topic passes doctor but the dispatcher never counts it done (dispatch reads only prd list), so the dependent topic waits forever |
| RISA-1000 | bug | live | fixes-tooling | prd/fixes-tooling | Under load (5-min avg 20-35) the tooling unit suite times out in 5-19 files (20s test, 10s hook limits); the same files pass alone |
| RISA-1002 | feature | triaged | usage-aware-drain |  | Backup Claude account: when the current account reaches 99% usage on this machine, or on the user's word, Risa pauses work, swaps every session to the other account (work or personal) and resumes there |
| RISA-1003 | bug | live | fixes-tooling | prd/fixes-tooling | rotate's standing-close simulated pick omits facts.landed, so a landed-but-planned row can make a standing topic close and then be restarted by the dispatcher (worktree, stack, test db torn down and rebuilt) |
| RISA-1004 | bug | live | fixes-tooling | prd/fixes-tooling | With RISA_USAGE_WATCH=off, a dead session with an outstanding stall mark is still held out of pick()'s reopen, and resume waits for its recorded reset, so disabling the watch doesn't release it |
| RISA-1005 | chore | live | fixes-tooling | prd/fixes-tooling | Slice check runs only the slice's named check: a project config key for a one-test-file command (the runner differs per project), risa check --quick on a slice branch runs the plan's Check field through it, the full check stays at the wave's landing; the orchestrator splits a slice that comes back over budget (second half of RISA-881) |
| RISA-1006 | chore | live | fixes-tooling | prd/fixes-tooling | A release tag leaves package.json's version behind: v0.1.7 still says 0.1.2; cutting a tag should bump it (or a check should catch the mismatch) |
| RISA-1007 | plan | triaged | risa-next-2 |  | Multi-machine: Risa runs and coordinates across several machines (sessions, repos, releases, agent discovery); risa-next designs for it, building the cross-machine parts can follow |
| RISA-1009 | feature | live | fixes-tooling | prd/fixes-tooling | A command a backlog agent can run to restart the dispatcher on the current release (stop, then start it in its own tab or detached), so a new pin or install doesn't need the user at the terminal |
| RISA-1010 | bug | live | fixes-tooling | prd/fixes-tooling | machinery.md ends with a stub '## The context watch' after '## Worktrees and leases' (2b02eab, RISA-880), so a project's additions, which continue the generic doc's last section, merge under the stub: Caretook's worktree lines drop out of risa doc machinery 'Worktrees and leases' and its own 'The context watch' heading appears twice |
| RISA-1011 | chore | live | fixes-tooling | prd/fixes-tooling | The planner prompt (loops/prompts/plan.sh) and the plan skeptic's SLICE_SIZE_RULE (loops/skeptics.mjs) still say 'about 8 files'; bring them to slice 19's budget (about 4 files, one Check: test file), updating prompt.test, skeptics.test and sample-project/prompt-golden.txt |
| RISA-1012 | bug | live | fixes-tooling | prd/fixes-tooling | risa dispatch --restart stops the dispatcher and starts none when no tab can open (iTerm2 unavailable, headless): open-session.sh falls back to printing the command and exits 0, so the restart waits out its timeout with dispatching stopped; check a tab can open before stopping, or fall back to a detached process |
| RISA-1013 | bug | live | fixes-tooling | prd/fixes-tooling | risa status's 'last tick' reads the stuck watch's stuck.lastTickAt, which isn't written while usage-limited, paused or with RISA_STUCK_WATCH=off, so a healthy dispatcher looks stalled; record a heartbeat on every tick and show that |
| RISA-1014 | change | live | fixes-tooling | prd/fixes-tooling | risa land skips the Codex re-review when the commits after Codex's approval change only docs or plan files, as the test gate does |
| RISA-1015 | bug | live | fixes-tooling | prd/fixes-tooling | risa slice cuts a slice branch from the committed prd/ tip even when the plan's section for that slice is uncommitted: the slice worktree's plan lacks it, so the narrow slice check (Check: field) silently falls back to the full suite; refuse (or warn) when the slice's heading isn't in the committed plan |
| RISA-1016 | change | live | fixes-tooling | prd/fixes-tooling | risa review and risa ready (review.sh, lib.sh pr_verdict) read a PR whose commits after Codex's approval are docs only as stale; pass codex-review.mjs --docs as land does since RISA-1014 |
| RISA-1017 | plan | triaged | risa-next-5 |  | Risa: usable by others: install without a Risa checkout, docs for outsiders, versioning (risaVersion enforced), hosts other than macOS and iTerm2 (cut from RISA-797 by the risa-next-4 planner) |
| RISA-1018 | bug | live | fixes-tooling | prd/fixes-tooling | check-run.test.mjs 'waits while busy, starts when the load drops' flakes on CI: the load-drop line reads '-' instead of the stubbed 1 (run 46123266140, fixes-tooling wave 6 tip 04b1309; no wave-6 file touches check-run) |
| RISA-1019 | chore | triaged | fixes-nit |  | session-names.mjs personaOf repeats flavor.mjs sessionPersona's backlog rule (one word of letters, not 'backlog', the pool's rank); call sessionPersona instead |
| RISA-1020 | bug | live | fixes-tooling | prd/fixes-tooling | loops/anchors.mjs ignores planBudget's errors, so prd anchors doesn't show a bad Model field |
| RISA-1021 | chore | live | fixes-tooling | prd/fixes-tooling | In Risa's own repo the slice check runs the Check file twice (unit step via commands.testFile, then the narrowed tooling step) |
| RISA-1022 | bug | live | fixes-tooling | prd/fixes-tooling | The load gate reads an unreadable load mid-wait as dropped: load_gate_wait (loops/lib.sh) ends its busy loop on 'unread' and starts the check with 'The load dropped to -' |
| RISA-1023 | bug | ready | fixes-bug | prd/fixes-bug | Under a release install, risa status-trim crashes: loops/status-trim.mjs imports prettier (a dev dependency), and the release folder has no node_modules, so it fails with ERR_MODULE_NOT_FOUND. Resolve prettier from the project's checkout, or skip formatting when it's missing |
| RISA-1024 | bug | ready | fixes-bug | prd/fixes-bug | A backlog --brief written before slice 4 (## Directives heading) gets a header naming only _From the user_ lines as the user's word, so its directives read as context: name the detected heading, or normalise it |
| RISA-1025 | change | live | self-recovery-2 | prd/self-recovery-2 | dispatch.mjs loads finish.mjs lazily (createRequire, skipped when missing) because dispatch.test.mjs and its siblings copy a fixed script list; add finish.mjs to those lists and import it statically |
| RISA-1026 | bug | live | fixes-tooling | prd/fixes-tooling | lease.test.mjs 'returns once the worktree's check lease is released' flakes under load: the wait line printed is 'Waiting (up to 0m30s)…' before the holder line |
| RISA-1027 | bug | live | self-recovery-2 | prd/self-recovery-2 | risa finish <topic> (the CLI) files a fresh report on every run for an unchanged code tail or other report-only reason: it gathers with no reported keys and never persists d.key |
| RISA-1028 | bug | live | self-recovery-2 | prd/self-recovery-2 | cost.mjs topicFolders counts a topic named plan-<x>'s orchestrator transcripts (.loops/plan-<x>, branch prd/plan-<x>) as topic <x>'s planning tokens |
| RISA-1029 | bug | live | self-recovery-2 | prd/self-recovery-2 | dispatch.mjs finishStep prefilters candidates with landedTopics/landedWithCode on the configured trunk, ignoring env.TRUNK (gatherFinish and tidy honor it): a topic landed only into an overridden trunk is never auto-finished |
| RISA-1030 | bug | live | fixes-bug-urgent | prd/fixes-bug-urgent | The dispatcher can die silently and nothing notices: Caretook's (v0.1.8, pid 22040) was gone hours after a normal tick with no error in .loops/.dispatch.log and .dispatch.json still naming its pid. Log why it exits, have risa status flag a dead dispatcher pid, and keep it alive (launchd or a watchdog that restarts it and files a report) |
| RISA-1031 | bug | triaged | fixes-perf |  | risa status hung over 2 minutes in Caretook's main checkout on v0.1.8 at load 2, the morning its dispatcher had died; cause not confirmed |
| RISA-1032 | change | triaged | fixes-bug-urgent |  | Two fixes topics may run at once when their hot files don't overlap: dispatch-pick.mjs's startBlock refuses any standing topic while another runs ('another fixes topic … is running'), so in a repo where one fixes topic (Risa's fixes-tooling) keeps refilling, fixes-bug, fixes-perf and fixes-nit rarely or never get a lane. The hot-file check already guards overlap; keep the lane cap |
| RISA-1033 | bug | live | fixes-bug-urgent | prd/fixes-bug-urgent | A session that receives a task notification and never takes another turn isn't counted as stalled: Caretook's prd-fixes-bug sat 3h40m after its CI notification with its processes alive. The quiet-orchestrator watch should flag (and nudge) a session whose last transcript entry is an unanswered notification |
| RISA-1034 | bug | live | fixes-bug-urgent | prd/fixes-bug-urgent | An orchestrator can end its turn waiting on a check that has no background wait to wake it: Caretook's prd-sync-safety-3 ended its turn at 09:38Z on a browser check that had printed nothing and later wasn't running, so nothing ever woke it. The orchestrator prompt and the check wrapper should keep a background wait (or a result file the watch reads) for every check it waits on |
| RISA-1035 | change | dropped | fixes-bug |  | Backlog and orchestrator prompts: keep queues moving the best way you know; contact the user about flow actions only when the action risks major work, data, or another critical problem |
| RISA-1036 | plan | triaged | asks-relay |  | A queue-tender role: a session whose only job is keeping the lanes moving (nudging stalled orchestrators, closing idle topics, restarting the dispatcher, reordering by the user's priorities), acting on its own and asking the user only when an action risks major work, data or something critical; today the backlog session does this between other work |
| RISA-1037 | bug | live | fixes-bug-urgent | prd/fixes-bug-urgent | The dispatcher logs why it exits: every exit path (signal, uncaught error, lost lock, clean stop) writes one line to .loops/.dispatch.log and marks .dispatch.json stopped, so a dead pid with no stop mark reads as a crash |
| RISA-1038 | bug | live | fixes-bug-urgent | prd/fixes-bug-urgent | The inbox session finds the wrong project: run from its own directory (~/.risa/inbox, outside any repo), session.sh's find_repo falls back to the release worktree's repo (Risa's checkout), not the project prd.sh inbox ran for, so it misses that project's claudeConfigDir (starts on Claude Code's default account) and writes its session record under Risa's .loops/.sessions (the project's risa status shows it ended while it's live) |
| RISA-1039 | change | ready | fixes-bug | prd/fixes-bug | Session display names lead with the Starfleet name and abbreviate its rank: 'Adm Morrow · backlog (caretook)', not 'backlog (caretook) · Admiral Morrow' |
| RISA-1040 | feature | triaged | self-recovery-3 |  | An orchestrator that lands and stops without rotating is caught: rotate runs go into .run-log.jsonl, and the dispatcher nudges (then closes) a standing topic whose session sits idle after a land-end with nothing runnable, instead of leaving its lane held |
| RISA-1041 | change | triaged | fixes-nit |  | Persona line: a status report reads as the role's log entry (captain's log), and the user's title (Fleet Admiral) is used only when speaking to the user directly (a question, an answer to them), not in narration of the session's own work |
| RISA-1042 | bug | live | fixes-bug-urgent | prd/fixes-bug-urgent | risa wait browser misses an active suite's earlier results: a waiter started (or restarted after exit 75) mid-suite reads the run log only from its own start offset, so an early failing browser check followed by a passing one prints only the pass and exits 0. Take the results since the suite's lease was taken, not since the wait began |
| RISA-1043 | change | triaged | fixes-bug-later |  | backlog set takes --note TEXT (as add does), so triage is one command and one commit; the standalone backlog note command stays for a note alone |
| RISA-1044 | feature | triaged | flavor-packs |  | Flavor pack: Battlestar Galactica. User addressed as Admiral; names are callsigns. backlog = Commanders (Adama, Cain, Fisk, Garner), prd = Captains (Starbuck, Apollo), slice = Viper pilot Lieutenants (Helo, Athena, Kat, Racetrack, Hotdog, Narcho), inbox = comms (Dualla, Gaeta), hotfix = deck crew (Chief Tyrol, Cally, Seelix), plan = Colonel (Tigh), recovery = Doctors (Cottle, Salik) |
| RISA-1045 | feature | triaged | flavor-packs |  | Flavor packs: Star Wars, four of them: rebel (user = General; Admirals Ackbar, Holdo, Raddus; X-wing pilots; mechanics; protocol droids; medical droids), jedi (user = Grand Master; Masters, Knights, Padawans, healers), empire (user = Grand Moff; Admirals Thrawn, Piett; Captains; TIE pilots; technicians) and a mixed one drawing each role from the side that fits it best (Jedi planners, Rebel pilots, droid inbox) |
| RISA-1046 | feature | triaged | flavor-packs |  | Flavor pack: Dune. A Great House: the user as the Padishah Emperor or a Duke, backlog = Dukes or House heads, prd = Swordmasters or Warmasters, slice = ornithopter pilots, inbox = Fremen messengers, hotfix = water engineers or Fremen craftsmen, plan = Mentats, recovery = Suk doctors |
| RISA-1047 | feature | triaged | flavor-packs |  | Flavor pack: Lord of the Rings. The user as a Wizard of the White Council, backlog = Wizards and Elf-lords, prd = kings and stewards, slice = Rangers and Riders, inbox = hobbits and messengers, hotfix = dwarf smiths, plan = Ents and loremasters, recovery = Elvish healers |
| RISA-1048 | bug | triaged | fixes-test |  | pnpm test:tooling runs no tests and exits 0 (a false green) from a project's node_modules: loops/tooling-tests.mjs's main guard compares import.meta.url with file://argv[1], and under pnpm argv[1] is the symlink while import.meta.url is the real .pnpm path; compare realpaths (as session-names.mjs's isMain does) here and in the other entry points with the same guard |
| RISA-1049 | change | ready | fixes-bug | prd/fixes-bug | A project's role additions can target a named section of the generic doc (a '## <Heading>' in the additions merges into that section; the rest appends at the end), and a check fails a change to a generic doc's section headings or last section that no changelog line names |
| RISA-1050 | change | triaged | fixes-bug |  | Warn when a project's pinned risa differs from the running release: risa status, and the dispatcher on start or re-exec, name both versions (a refusal is RISA-1017's versioning) |
| RISA-1051 | bug | triaged | fixes-nit |  | The machinery doc has no 'The dispatcher' section (nor 'Recorded sessions', 'The load gate'), though orchestrator.md and inbox.md send readers to risa doc machinery "The dispatcher", which prints 'no section'; the dispatcher's stop mark and the stuck watch's notified kind have no doc home, and machinery.md's 727 B budget leaves no room to add one |
| RISA-1052 | bug | triaged | fixes-bug-urgent |  | session.sh resolves its own directory (bin=$(cd "$(dirname "$0")" && pwd)) before sourcing lib.sh, whose unset CDPATH now comes too late: with CDPATH set and a relative $0, cd prints the matched path and bin gets it twice, so source "$bin/lib.sh" fails. Unset CDPATH first |
| RISA-1053 | feature | triaged | ship |  | A generic ship command, risa ship <version>: one shared scaffold of pre-checks, ship steps, a smoke test and a notification, each a hook a project overrides for how it ships (Risa: bump package.json, tag, push the tag, smoke-test the tagged install, notify pinned projects; Caretook: its staging/production promotion) |
| RISA-1054 | bug | triaged | fixes-tooling |  | CI's docs:headings check passes vacuously: actions/checkout is shallow and fetches no tags, so loops/docs-headings.mjs finds no v* tag; fetch tags (fetch-depth: 0 or a tag fetch) in .github/workflows/ci.yml so a generic doc's heading change without a CHANGELOG line fails in CI |
| RISA-1055 | feature | triaged | cross-machine-messages |  | Cross-machine messages through the private inbox repo: a session's message or notice to another machine's project (e.g. a ship notice to Caretook) is written to the inbox repo, that machine's dispatcher hands it to its own backlog session, and peers are found from the home-machine records, not Remote Control, which reaches only sessions on the same claude.ai account |

## Items

### RISA-367 · chore · Agent tooling: tests for the merge path (land.sh, pr.sh, ready.sh, review.sh: 465 lines, none), and with_backlog_lock removes a stale lock without re-checking, so two waiters can both take it

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: bb7b20d

- 2026-11-21 (Robert Bo Davis): Code review 2026-11-21, from a reviewer's reading, not re-verified by the backlog session. scripts/loops/lib.sh:329. Also: lease.sh still carries the old .loops/.browser path; 22 of 34 CARETOOK_* knobs are undocumented. Goes with B-239 to B-242.
- 2026-11-21 (plan/code-health): Planned 2026-11-21: plans/code-health-plan.md (B-366 slice 1, B-365 slice 2, B-367 slices 3 and 4, B-361 slices 5 and 6). B-365 leaves isUserRoleName and isGroupRoleName for B-363 (simple-mode is editing that file).
- 2026-11-26 (Robert Bo Davis): Risa tooling: held with fixes-tooling for the work account (the user, 2026-11-26)
- 2026-11-27 (the Risa move, B-543): Was B-367 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-404 · feature · One command to ship dev to staging: push dev, open the dev into staging PR, wait for Codex's review, triage its findings into the backlog (verified against the code, duplicates noted on the existing item), merge the PR when nothing is a blocker, and notify the user only when something is

- status: triaged
- prd: staging-ship
- owner:
- commit:

- 2026-11-21 (Robert Bo Davis): Asked for 2026-11-21 after doing it by hand on PR #25. Proposed for orchestration-3 (the dispatcher): same unattended tooling, and it can raise a blocker through orchestration-2's asks queue (pnpm prd ask). To settle in the PRD: what counts as a blocker (today's rule: critical and breaking only, the rest are follow-ups); staging changes only by PR and is deployed by deploy.yml; Codex signals no findings with a thumbs-up reaction and no review, so the wait reads its summary comment's state; a timeout when Codex never answers.
- 2026-11-21 (plan/orchestration-3): Moved out of orchestration-3 by its planner (2026-11-21) to keep that PRD at six slices: orchestration-3 is the dispatcher core (B-392, B-426, B-427, B-428, B-439). The grouping and the row order of the four follow-on topics are the planner's; plans/orchestration-3-prd.md, Follow-on topics.
- 2026-11-24 (plan/staging-ship): plan/staging-ship (2026-11-24): planned in plans/staging-ship-plan.md (7 slices, held until the user lifts it, a160). B-584 and B-241 moved in from fixes-tooling: B-584 is this feature's trigger and stays open after slice 7 until a real push reaches the phone (B-586); B-241 could make a release PR read as clean.
- 2026-11-27 (the Risa move, B-543): Was B-404 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-429 · change · Asks queue hygiene: reports that go stale are re-checked or expire, answered asks are archived, and an ask whose session has died still reaches the user

- status: triaged
- prd: asks-relay
- owner:
- commit:

- 2026-11-21 (Robert Bo Davis): Filed from the backlog session 2026-11-21 after a gap review of the upcoming orchestration runs; the user chose to file it. Report a3 still says the fixes topics are on hold though the registry disagrees; asks.mjs has --done but no expiry or archive; a push needs a live session (a push service was out of scope for orchestration-2).
- 2026-11-21 (plan/orchestration-3): Moved out of orchestration-3 by its planner (2026-11-21) to keep that PRD at six slices: orchestration-3 is the dispatcher core (B-392, B-426, B-427, B-428, B-439). The grouping and the row order of the four follow-on topics are the planner's; plans/orchestration-3-prd.md, Follow-on topics.
- 2026-11-21 (plan/inbox-agent): Moved out of inbox-agent by its planner (2026-11-21) to keep that PRD at six slices; the new topic asks-relay sits in the row after it. Planner's sketch for the next planner, none of it decided: (1) pnpm prd ask gains how blocking the question is (blocked now, blocked soon, not blocking), stated by the asker; (2) a pure ranking of open asks from the session records, worktrees and registry (is the asker live and waiting, does it hold a slot, is a topic queued behind it), shown by pnpm prd asks; (3) each ask records when it was relayed and when the phone was pushed, and the backlog session marks itself live and the user active, so a push goes out only for a blocked-now question the user hasn't seen; (4) the fallback with no go-between live: after some minutes the waiting command tells its asker to push for itself, and the dispatcher's helper pushes for an asker that has died; (5) every prompt but the backlog and inbox sessions files and waits instead of asking in its tab; (6) hygiene: reports expire after a few days and the go-between re-checks an old one against pnpm prd status before showing it, answered and dismissed asks move to an archive folder after a day with ids never reused and still found by id (the dispatcher reads answers by id), a reopened session lists its topic's answered asks. The two questions B-467's note names for its planner (the fallback, and a question already settled by preferences) are still open: both look cheap to change, so the handbook's list says decide them.
- 2026-11-27 (the Risa move, B-543): Was B-429 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-430 · feature · Codex findings on a PRD pull request become backlog items by tool: verified against the code, duplicates noted on the existing item, as B-404 does for the staging PR

- status: triaged
- prd: staging-ship
- owner:
- commit:

- 2026-11-21 (Robert Bo Davis): Filed from the backlog session 2026-11-21 after a gap review of the upcoming orchestration runs; the user chose to file it. Today orchestrator.md step 4 has the orchestrator file them by hand. Could share code with B-404.
- 2026-11-21 (plan/orchestration-3): Moved out of orchestration-3 by its planner (2026-11-21) to keep that PRD at six slices: orchestration-3 is the dispatcher core (B-392, B-426, B-427, B-428, B-439). The grouping and the row order of the four follow-on topics are the planner's; plans/orchestration-3-prd.md, Follow-on topics.
- 2026-11-24 (plan/staging-ship): plan/staging-ship (2026-11-24): planned in plans/staging-ship-plan.md (7 slices, held until the user lifts it, a160). B-584 and B-241 moved in from fixes-tooling: B-584 is this feature's trigger and stays open after slice 7 until a real push reaches the phone (B-586); B-241 could make a release PR read as clean.
- 2026-11-27 (the Risa move, B-543): Was B-430 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-436 · feature · A to-test report for a staging ship, like the landing reports of B-410

- status: triaged
- prd: staging-ship
- owner:
- commit:

- 2026-11-21 (Robert Bo Davis): Filed from the backlog session 2026-11-21 after a gap review of the upcoming orchestration runs; the user chose to file it. B-410 left it undecided as a follow-up; belongs with B-404 (ship dev to staging).
- 2026-11-21 (plan/orchestration-3): Moved out of orchestration-3 by its planner (2026-11-21) to keep that PRD at six slices: orchestration-3 is the dispatcher core (B-392, B-426, B-427, B-428, B-439). The grouping and the row order of the four follow-on topics are the planner's; plans/orchestration-3-prd.md, Follow-on topics.
- 2026-11-24 (plan/staging-ship): plan/staging-ship (2026-11-24): planned in plans/staging-ship-plan.md (7 slices, held until the user lifts it, a160). B-584 and B-241 moved in from fixes-tooling: B-584 is this feature's trigger and stays open after slice 7 until a real push reaches the phone (B-586); B-241 could make a release PR read as clean.
- 2026-11-27 (the Risa move, B-543): Was B-436 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-438 · plan · Headless orchestrator sessions: runs that need no terminal tab, so a helper cannot outlive or die with its window

- status: triaged
- prd: self-recovery-4
- owner:
- commit:

- 2026-11-21 (Robert Bo Davis): Filed from the backlog session 2026-11-21 after a gap review of the upcoming orchestration runs; the user chose to file it. Deferred in the orchestration-2 PRD with no item; a large idea, may deserve its own topic.
- 2026-11-21 (plan/orchestration-3): Moved out of orchestration-3 by its planner (2026-11-21) to keep that PRD at six slices: orchestration-3 is the dispatcher core (B-392, B-426, B-427, B-428, B-439). The grouping and the row order of the four follow-on topics are the planner's; plans/orchestration-3-prd.md, Follow-on topics.
- 2026-11-22 (plan/self-recovery): Moved to self-recovery-2 by the self-recovery planner to keep that PRD at six slices. A headless session has no status line, so it needs another source for the usage reading.
- 2026-11-27 (the Risa move, B-543): Was B-438 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).
- 2026-11-27 (plan/self-recovery-2): Moved to self-recovery-3 by the self-recovery-2 planner (2026-11-27) to keep that PRD at six slices; spike Claude Code's background sessions first (plans/self-recovery-2-prd.md, Notes).
- 2026-11-28 (Robert Bo Davis): Moved to self-recovery-4 on the user's word (2026-11-28): self-recovery-3 covers RISA-998, RISA-1040 and a spike of Claude Code background sessions; this topic is planned from the spike's findings.

### RISA-459 · chore · Backlog: 151 items read 'live' because the dev-into-staging-into-main release merge (cc3e1d8b, B-33) put their commits on origin/main, though production hasn't launched; give live a real meaning (a production marker such as a tag or a recorded deploy) or show main as staging until launch

- status: triaged
- prd: —
- owner:
- commit:

- 2026-11-21 (slice/fixes-nit/3): From B-380 (fixes-nit slice 3), 2026-11-21: status is derived (scripts/backlog/format.mjs derive: containing origin/main means live) and recomputed on every write, so a hand or bulk set of live items back to staging would be undone, and archived items can't be set at all. Not changed here. Option: derive live from a production tag or deploy record instead of origin/main; the status words in docs/agents/backlog.md follow.
- 2026-11-23 (Robert Bo Davis): fixes-tooling wave order (the user, 2026-11-23: keep one topic, organize waves by kind of work; replaces the plan Status list of wave 3 candidates). Order: 3 context, dispatcher, sessions; 4 known flakes by cause; 5 re-measure test flakes; 6 check flow; 7 landing, Codex, cleanup; 8 planning and prompts. This item: wave 7 (landing, Codex, cleanup). After agent-autonomy, which holds the landing scripts.
- 2026-11-27 (the Risa move, B-543): Was B-459 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).
- 2026-11-27 (prd/fixes-tooling): The user, 2026-11-27 (overriding a6, relayed by risa-c9): move to Caretook's backlog; not fixed in fixes-tooling. Caretook's repo isn't on this machine, so it was taken out of fixes-tooling here, to be filed in Caretook's backlog.

### RISA-467 · feature · The backlog session is the go-between for every agent's questions: agents file to the asks queue and wait, the backlog session ranks them by how soon an answer blocks real work, asks the user itself and decides which ones ping the phone

- status: triaged
- prd: asks-relay
- owner:
- commit:

- 2026-11-21 (Robert Bo Davis): User, 2026-11-21 (backlog session): the user keeps a backlog session (fable) and an inbox session (opus) running while available, and handles their context and restarts. Agreed shape: the asks queue is the transport, not a broadcast message (a broadcast misses agents started later and is lost over a restart). Prompts change so no agent pushes or asks in its own tab, by-hand 'asks first' sessions included: all file with pnpm prd ask and wait. The asker states how blocking the ask is (blocked now, blocked soon, not blocking); the backlog session checks that against pnpm prd status (is the session waiting, does it hold a slot, is a planner or topic queued behind it). On startup it reads the open questions, ranks them and asks whether the user is free to answer; it watches the queue after that. Phone push only for blocked-now asks when the user hasn't been active in the backlog session; the rest are batched into the next poll, reports as a digest with no push. It relays the question and options verbatim, records the answer with pnpm prd answer and never answers for the user. Planner to ask the user: (1) the fallback when no backlog session is live or a blocking ask goes unanswered (proposed: the ask pushes itself as today, after some minutes); (2) a question already settled by docs/agents/preferences.md or an earlier answer: one-tap confirm (proposed) or answered outright. Sits with B-425 (the inbox agent) and B-429 (asks queue hygiene). Triage: tooling feature on the asks queue and the backlog prompt, the inbox-agent topic's hot files.
- 2026-11-21 (plan/inbox-agent): Moved out of inbox-agent by its planner (2026-11-21) to keep that PRD at six slices; the new topic asks-relay sits in the row after it. Planner's sketch for the next planner, none of it decided: (1) pnpm prd ask gains how blocking the question is (blocked now, blocked soon, not blocking), stated by the asker; (2) a pure ranking of open asks from the session records, worktrees and registry (is the asker live and waiting, does it hold a slot, is a topic queued behind it), shown by pnpm prd asks; (3) each ask records when it was relayed and when the phone was pushed, and the backlog session marks itself live and the user active, so a push goes out only for a blocked-now question the user hasn't seen; (4) the fallback with no go-between live: after some minutes the waiting command tells its asker to push for itself, and the dispatcher's helper pushes for an asker that has died; (5) every prompt but the backlog and inbox sessions files and waits instead of asking in its tab; (6) hygiene: reports expire after a few days and the go-between re-checks an old one against pnpm prd status before showing it, answered and dismissed asks move to an archive folder after a day with ids never reused and still found by id (the dispatcher reads answers by id), a reopened session lists its topic's answered asks. The two questions B-467's note names for its planner (the fallback, and a question already settled by preferences) are still open: both look cheap to change, so the handbook's list says decide them.
- 2026-11-27 (the Risa move, B-543): Was B-467 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-477 · change · PRD registry: a hold carries its reason

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: bb7b20d

- 2026-11-21 (Robert Bo Davis): User, 2026-11-21 (backlog session): "we probably need a 'hold reason' field for some of these holds to make them easier to manage in another session that doesn't have this context." Backlog session's sketch, not the user's words: pnpm backlog prd set <topic> flags=hold takes a reason (and a date), prd list, prd status and dispatch --dry-run print it beside 'on hold', and clearing the hold clears it; dispatch --pause already takes a <why>. Reasons for the holds set in this session, to fill in when the field exists: planner-3 (a note can carry a todo) is held because its landed plan must be revised to the user's design first, see the note on B-245; contract-migrations, asks-relay, sync-safety-2, ui-kit-3, code-health-2 and code-health-3 are held only to stop planning from burning model usage (user's pick, 2026-11-21), not for any problem with the topics: release them when the user wants planning to resume.
- 2026-11-23 (Robert Bo Davis): fixes-tooling wave order (the user, 2026-11-23: keep one topic, organize waves by kind of work; replaces the plan Status list of wave 3 candidates). Order: 3 context, dispatcher, sessions; 4 known flakes by cause; 5 re-measure test flakes; 6 check flow; 7 landing, Codex, cleanup; 8 planning and prompts. This item: wave 3 (context, dispatcher, sessions). B-600 goes first. Avoids agent-autonomy's hot files.
- 2026-11-27 (the Risa move, B-543): Was B-477 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-560 · feature · A cost record: tokens by model per PRD and slice, from session and subagent transcripts, in pnpm prd cost

- status: live
- prd: self-recovery-2
- owner: prd/self-recovery-2
- commit: 3c6214c

- 2026-11-22 (plan/self-recovery): Split from B-433 by the self-recovery planner. Needs a SubagentStop hook for per-slice totals, no double counting across --continue, and reconciling at rm because a session end can be missed. Unattended runs never spend extra usage, so tokens remain the measure.
- 2026-11-27 (the Risa move, B-543): Was B-560 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-584 · chore · Backlog prompt: "deploy staging" trigger that promotes dev and notifies my phone

- status: triaged
- prd: staging-ship
- owner:
- commit:

- 2026-11-22 (Robert Bo Davis): From the user, 2026-11-22. Add a "deploy staging" trigger to the backlog session prompt (scripts/loops/prompt.sh). Workflow: find or open the dev to staging PR; wait for Codex and triage its findings (verified non-blockers become backlog follow-ups); check what changed since the reviewed commit; if no blockers, merge pinned to the checked head with a Conventional subject; watch deploy.yml in the background; when it ends, success or failure, call the PushNotification tool so the result reaches the phone. A blocker stops the merge and is pushed as well. Triaged to fixes-tooling: prompt tooling.
- 2026-11-22 (Robert Bo Davis): The phone step depends on B-586 (pushes from the backlog session do not arrive): fix or replace that route first.
- 2026-11-23 (Robert Bo Davis): fixes-tooling wave order (the user, 2026-11-23: keep one topic, organize waves by kind of work; replaces the plan Status list of wave 3 candidates). Order: 3 context, dispatcher, sessions; 4 known flakes by cause; 5 re-measure test flakes; 6 check flow; 7 landing, Codex, cleanup; 8 planning and prompts. This item: wave 8 (planning and prompts). After agent-autonomy, which holds prompt.sh.
- 2026-11-24 (plan/staging-ship): plan/staging-ship (2026-11-24): planned in plans/staging-ship-plan.md (7 slices, held until the user lifts it, a160). B-584 and B-241 moved in from fixes-tooling: B-584 is this feature's trigger and stays open after slice 7 until a real push reaches the phone (B-586); B-241 could make a release PR read as clean.
- 2026-11-27 (the Risa move, B-543): Was B-584 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-681 · bug · Promotion prints a passing flake's tests but doesn't file them in the backlog

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 00269bb

- 2026-11-23 (prd/test-gates-2): From slice 4's hand-off: pnpm prd ci promote merges on a passing flake and only prints the flaky tests, while the PRD says browser flakes are filed. The plan assigned the filing to no slice. Proposed for a later wave of test-gates-2; the user reviews.
- 2026-11-23 (prd/test-gates-2): Moved from test-gates-2 when its last wave landed (2026-11-23); that topic is closing.
- 2026-11-24 (prd/fixes-tooling): Proposed by the fixes-tooling orchestrator 2026-11-24. This item: wave 7 (landing, Codex, cleanup).
- 2026-11-27 (the Risa move, B-543): Was B-681 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-721 · bug · Second-zone filing opens a new item when a zone item was landed or dropped but staging still lacks the fix

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: bb7b20d

- 2026-11-23 (prd/test-gates-2): From test-gates-2 slice 6: zone-file matches open items only, so the next release run refiles that file.
- 2026-11-24 (prd/fixes-tooling): Proposed by the fixes-tooling orchestrator 2026-11-24. This item: wave 7 (landing, Codex, cleanup).
- 2026-11-27 (the Risa move, B-543): Was B-721 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-722 · bug · A release run after a recorded override replaces the override's release-gate status, so a failing run blocks main again

- status: triaged
- prd: —
- owner:
- commit:

- 2026-11-23 (prd/test-gates-2): From test-gates-2 slice 6: decide whether a run should keep an OVERRIDE on the same commit.
- 2026-11-24 (prd/fixes-tooling): Proposed by the fixes-tooling orchestrator 2026-11-24. This item: wave 7 (landing, Codex, cleanup).
- 2026-11-27 (the Risa move, B-543): Was B-722 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).
- 2026-11-27 (prd/fixes-tooling): The user, 2026-11-27 (overriding a6, relayed by risa-c9): move to Caretook's backlog; not fixed in fixes-tooling. Caretook's repo isn't on this machine, so it was taken out of fixes-tooling here, to be filed in Caretook's backlog.

### RISA-780 · change · CI warns when a branch's quarantine or brake list trails dev's (follow-up of B-771 sync brings dev's CI lists)

- status: triaged
- prd: —
- owner:
- commit:

- 2026-11-24 (Robert Bo Davis): Left out of hotfix sync-shared (PR #162) on the user's word; filed at landing 2026-11-24
- 2026-11-27 (the Risa move, B-543): Was B-780 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).
- 2026-11-27 (prd/fixes-tooling): The user, 2026-11-27 (overriding a6, relayed by risa-c9): move to Caretook's backlog; not fixed in fixes-tooling. Caretook's repo isn't on this machine, so it was taken out of fixes-tooling here, to be filed in Caretook's backlog.

### RISA-789 · change · A landing journal (even one whose pid is dead) holds a session's resume after a usage limit with only a waits line each tick; file one report so the user runs pnpm prd land --resume

- status: live
- prd: self-recovery-2
- owner: prd/self-recovery-2
- commit: 115919f

- 2026-11-24 (prd/self-recovery): From self-recovery slice 6 hand-off (resume.mjs waits on any landing journal for the branch).
- 2026-11-27 (the Risa move, B-543): Was B-789 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-794 · plan · Risa: a central agent that gathers from several repos and prioritises across them

- status: triaged
- prd: risa-next-3
- owner:
- commit:

- 2026-11-24 (plan/orchestration-split): Filed 2026-11-24 from the orchestration-split planning: after the move (plans/orchestration-split-move.md). How Risa reads each configured repo's backlog and registry and orders work across projects; where tool state lives (today each repo's .loops/).
- 2026-11-25 (Robert Bo Davis): Decided by the user 2026-11-25: each project's plans stay in its own repo; Risa keeps its own plans plus the lighter cross-project prioritization plans in Risa's repo.
- 2026-11-27 (the Risa move, B-543): Was B-794 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-796 · chore · Risa: split the project config into a folder and tidy the test rules and gates

- status: triaged
- prd: risa-next-4
- owner:
- commit:

- 2026-11-24 (plan/orchestration-split): Filed 2026-11-24 from the orchestration-split planning: after the move (plans/orchestration-split-move.md). The user: the config may become a folder of files; the test rules and gates (tiers, brake list, quarantine, check plan) move cleanly after the split.
- 2026-11-27 (the Risa move, B-543): Was B-796 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).
- 2026-11-28 (plan/risa-next-4): Planned in risa-next-4 (2026-11-28): the .risa/ folder form (additive; risa.json keeps working), the four test-rule files by default name, risa config migrate.

### RISA-797 · plan · Risa: prove it on a second repo with tests, then make it usable by others

- status: triaged
- prd: risa-next-4
- owner:
- commit:

- 2026-11-24 (plan/orchestration-split): Filed 2026-11-24 from the orchestration-split planning: after the move (plans/orchestration-split-move.md). Second project first (Stencil is a poor fit); then release: install, docs, versioning, other hosts than macOS and iTerm2.
- 2026-11-27 (the Risa move, B-543): Was B-797 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).
- 2026-11-28 (plan/risa-next-4): Planned in risa-next-4 (2026-11-28): its proof (init, migrate, an end-to-end test on a fictional second repo); the release half is RISA-1017 in risa-next-5.

### RISA-811 · change · Automatic cleanup finishes a landed PRD left half-done: worktree and slot still held, registry not done, an idle orchestrator session with nothing to do, a branch with only post-landing docs commits

- status: live
- prd: self-recovery-2
- owner: prd/self-recovery-2
- commit: 3c6214c

- 2026-11-25 (Robert Bo Davis): From the planner-3 incident 2026-11-25 (B-431). Detect it in tidy or the watchdog and, unattended: land or fold the docs-only tail, rm the worktree, set done, end its sessions, report. Planner-3's sessions said 'removing worktree and ending' several times without doing it; find out why from their transcripts.
- 2026-11-25 (Robert Bo Davis): Causes so far: B-431 (a post-landing docs commit stops rm from setting done), the new rm-deletes-own-cwd bug, B-810 (end kills a stale pid). Cleanup should also spot several sessions of one topic (planner-3-35, -88 and others were live at once).
- 2026-11-27 (the Risa move, B-543): Was B-811 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-813 · feature · Per-task usage override: a topic the user names may start or plan between the drain line (95%) and the 98% stop, e.g. pnpm prd dispatch --allow <topic>; everything still ends at the stop

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 1573463

- 2026-11-25 (Robert Bo Davis): User 2026-11-25: drain default raised 85→95 on dev; wants an override for chosen tasks in the 95–98% window. Today only CARETOOK_USAGE_WATCH=off passes the drain, and it turns the whole watch off. Read per tick like .loops/.prd-cap, so no restart (see B-809).
- 2026-11-27 (the Risa move, B-543): Was B-813 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-814 · feature · Orchestrator picks the usage drain line from the current Claude plan (e.g. ultra vs smaller plans) instead of one fixed percent

- status: triaged
- prd: usage-aware-drain
- owner:
- commit:

- 2026-11-25 (Robert Bo Davis): User 2026-11-25: on hold; for a future iteration after the orchestrator split (Risa). Today's line is a fixed 95% (CARETOOK_USAGE_DRAIN) whatever the plan.
- 2026-11-27 (the Risa move, B-543): Was B-814 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-820 · feature · Risa: cross-repo topics: a Risa topic can change a configured subproject's code (Caretook), each side passing its own repo's checks

- status: triaged
- prd: risa-next-3
- owner:
- commit:

- 2026-11-25 (Robert Bo Davis): User, 2026-11-25 (backlog session): a Risa topic opens a worktree in Risa and in each subproject it touches; each runs its own risa.json checks, and the topic lands only when all pass. Risa lands and releases first, then the subproject lands with its expected Risa version bumped. One direction only: a subproject topic that needs a Risa change files a Risa item. Stage 1 keeps the door open (per-repo worktree and lease names) and adds no slices.
- 2026-11-25 (Robert Bo Davis): Orchestrator check (2026-11-25): stage 1 doesn't block this; its slice 3 puts repo and .loops lookup in one lib.sh function. Still for this item's design: (1) leases sit in each repo's .loops/, so two repos each allow 2 checks and 2 browsers, and only the load gate is machine-wide; (2) topic and session names are unique per repo, not across repos.
- 2026-11-27 (the Risa move, B-543): Was B-820 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-841 · change · Risa: one inbox session for every configured project, lines kept in a private inbox repo

- status: in-progress
- prd: risa-next-2
- owner: prd/risa-next-2
- commit:

- 2026-11-25 (Robert Bo Davis): Decided 2026-11-25 (user): after the split, not inside it. One always-on inbox session routes each line to the named or inferred project, asking when unclear (not one session per project). Lines live in one small private GitHub repo with a file per project, not plans/inbox.md on each trunk (no inbox commits on dev; the public repo exposes inbox lines today) and not a secret gist (readable by link; the API has no compare-and-swap). Write through a git clone so a racing push is refused; ingest removes a line only after the backlog commit lands. Per-project inbox path/repo is a risa.json value. Pairs with B-794 (the central agent reads the same repo).
- 2026-11-27 (the Risa move, B-543): Was B-841 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).
- 2026-11-27 (Robert Bo Davis): Folded in RISA-983 (inbox 2026-11-27, inbox per project, not per machine): wider than the inbox: move planning (backlog, PRDs, plans) to gists, GitHub issues or another store so one project can be worked on from several machines safely, avoiding the git sync problems we keep hitting. The PRD should weigh that against the private-repo design above.

### RISA-880 · chore · Planners get the context watch: add plan sessions to the context hook (data-rights peaked 256k, onboarding-2 214k)

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: bb7b20d

- 2026-11-26 (Robert Bo Davis): 2026-11-26: from the token-use skeptic (s57), filed on the user's word. machinery.md: hooks only for prd, backlog, inbox.
- 2026-11-27 (the Risa move, B-543): Was B-880 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-881 · chore · Slice small at planning (elephant carpaccio): a per-slice budget (about 4 files, one test file, expected context under ~100k), each slice names its own narrow check command and runs only that, full pnpm check once at the wave's landing; no two slices in a wave share a test file; the orchestrator splits only a slice that comes back over budget

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 4b888b6

- 2026-11-26 (Robert Bo Davis): 2026-11-26: from the token-use skeptic (s57), filed on the user's word.
- 2026-11-26 (Robert Bo Davis): 2026-11-26: the user's word: narrowed to splitting; the mid-slice hand-off half moved to B-912 (slices as headless sessions, self-recovery-2).
- 2026-11-27 (the Risa move, B-543): Was B-881 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).
- 2026-11-27 (Robert Bo Davis): 2026-11-27, the user's word: widened from 'split a 200k+ slice' to a planner slicing rule. The planner owns the breakdown; the orchestrator's split is the fallback. The budget figures are a starting point, judged with RISA-883 (cost by price). Needs hermetic tests first (after-split slice 1); pairs with RISA-882 (Sonnet for tightly specified slices). The floor: a slice's fixed cost (worktree, session start, prompt, check, review, merge) must stay a small share of it.
- 2026-11-27 (Robert Bo Davis): 2026-11-27: projects get the rule from Risa's generic planner and orchestrator docs once they move to the release that has it. What each project supplies: a command that runs one test file, set in its risa.json (the narrow check differs per runner, so the rule has to name a config key, not hard-code vitest), and its own role-doc additions checked so they don't contradict the rule.
- 2026-11-27 (Robert Bo Davis): 2026-11-27, the user's word: stays in fixes-tooling, though it's a feature rather than a fix.

### RISA-882 · chore · Model per role: Sonnet for slices whose plan spells out each edit, Haiku for reading check output (every slice runs on Opus now)

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: a99f7d2

- 2026-11-26 (Robert Bo Davis): 2026-11-26: from the token-use skeptic (s57), filed on the user's word. orchestrator.md _Models_ already allows Sonnet slices. Plan skeptics stay on Opus, both rounds (user's word).
- 2026-11-27 (the Risa move, B-543): Was B-882 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-883 · chore · Token use measured by price: a price-weighted before/after (cache writes ~3% of tokens but ~30% of cost) to judge B-873, B-875, B-876

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 1573463

- 2026-11-26 (Robert Bo Davis): 2026-11-26: from the token-use skeptic (s57), filed on the user's word. Scripts in .loops/token-analysis/.
- 2026-11-27 (the Risa move, B-543): Was B-883 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).
- 2026-11-27 (Robert Bo Davis): 2026-11-27, the user's word: stays in fixes-tooling, though it's a feature rather than a fix.

### RISA-886 · change · Backlog agent shouldn't ask the handoff question; sending a summary or not is the agent's call

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 6645281

- 2026-11-26 (Robert Bo Davis): Triage: backlog-session hand-off behaviour (guide and rotate --brief); B-889 may outgrow a fix wave, for the user's review.
- 2026-11-27 (the Risa move, B-543): Was B-886 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).
- 2026-11-27 (Robert Bo Davis): 2026-11-27, the user's word: stays in fixes-tooling, though it's a feature rather than a fix.

### RISA-889 · feature · Backlog agent can hand off with instructions the next agent actually follows, continuing the work…

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 6645281

- 2026-11-26 (Robert Bo Davis): From the inbox: Backlog agent can hand off with instructions the next agent actually follows, continuing the work without asking its first question, when the user asked for a handoff that way
- 2026-11-26 (Robert Bo Davis): Triage: backlog-session hand-off behaviour (guide and rotate --brief); B-889 may outgrow a fix wave, for the user's review.
- 2026-11-27 (the Risa move, B-543): Was B-889 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).
- 2026-11-27 (Robert Bo Davis): 2026-11-27, the user's word: stays in fixes-tooling, though it's a feature rather than a fix.

### RISA-911 · chore · pnpm prd wait check's default timeout outlasts the harness's ~170 s foreground limit, so a foreground wait is itself moved to the background; default it under 170 s (or say so in the loop doc)

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: bb7b20d

- 2026-11-26 (prd/fixes-tooling): Found in fixes-tooling slice 86 (B-903, 2026-11-26): a foreground wait --timeout 590 went to the background at 180 s; --timeout 160 rerun on each 75 worked.
- 2026-11-27 (the Risa move, B-543): Was B-911 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-912 · plan · Slices as their own headless sessions: started by a prd command, hand-offs to a file the orchestrator watches, so a slice survives an orchestrator rotation and can rotate or resume mid-slice itself

- status: triaged
- prd: self-recovery-4
- owner:
- commit:

- 2026-11-26 (Robert Bo Davis): 2026-11-26: the user's word. Builds on B-438 headless sessions. Cause it addresses: B-877 (subagent slices died with a mid-wave orchestrator rotation; fbcf69b2 only refuses that rotation). Also lets a slice start its own helpers (B-882 model per role). Covers the hand-off half of B-881. Touches session/open-session/dispatch: after orchestration-split-3.
- 2026-11-27 (the Risa move, B-543): Was B-912 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).
- 2026-11-27 (plan/self-recovery-2): Moved to self-recovery-3 by the self-recovery-2 planner (2026-11-27) to keep that PRD at six slices; spike Claude Code's background sessions first (plans/self-recovery-2-prd.md, Notes).
- 2026-11-28 (Robert Bo Davis): Moved to self-recovery-4 on the user's word (2026-11-28): self-recovery-3 covers RISA-998, RISA-1040 and a spike of Claude Code background sessions; this topic is planned from the spike's findings.

### RISA-913 · plan · Any role's long work runs as a job the machinery owns, so a hand-off never interrupts it: commands (check, land, CI waits, deploys, dev servers), watchers with a follow-up action (durable triggers the dispatcher fires), side-work subagents (headless sessions); each writes a result file, the hand-off records job ids, and the next session re-attaches instead of rerunning or re-arming

- status: triaged
- prd: self-recovery-4
- owner:
- commit:

- 2026-11-26 (Robert Bo Davis): 2026-11-26: the user's word. Every role: orchestrator, slice, backlog, inbox, hotfix, watchers, side work at the user's request. Companion to B-912 (slices as headless sessions) and B-438. Seen: prd sessions own their pnpm prd check/land/watch commands, so a mid-run rotation cuts them off; the backlog session's staging-deploy watch survives only by the brief re-arming it. Builds on the check leases. Risa work for the work account.
- 2026-11-27 (the Risa move, B-543): Was B-913 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).
- 2026-11-27 (plan/self-recovery-2): Moved to self-recovery-3 by the self-recovery-2 planner (2026-11-27) to keep that PRD at six slices; spike Claude Code's background sessions first (plans/self-recovery-2-prd.md, Notes).
- 2026-11-28 (Robert Bo Davis): Moved to self-recovery-4 on the user's word (2026-11-28): self-recovery-3 covers RISA-998, RISA-1040 and a spike of Claude Code background sessions; this topic is planned from the spike's findings.

### RISA-926 · bug · The dispatcher's keep-alive and session requests ignore the machine config's work switch: a repo with work off still gets its backlog and inbox sessions opened

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: b65e587

- 2026-11-26 (prd/orchestration-split-3): Carried from orchestration-split-3 wave 3 (slice 8): the switch gates start, plan and queue only; keep-alive.mjs and session-requests.mjs don't read it
- 2026-11-27 (the Risa move, B-543): Was B-926 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-927 · bug · The drain reads usage only from its own environment's Claude account, so sessions on another CLAUDE_CONFIG_DIR are drained on the wrong account's numbers

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: b7bb152

- 2026-11-26 (prd/orchestration-split-3): Carried from orchestration-split-3 wave 3 (slice 7): usage and context follow each session's folder, the drain doesn't yet
- 2026-11-27 (the Risa move, B-543): Was B-927 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-933 · chore · test:tooling runs tooling-lint.mjs before the project-data check, so broken tier data prints an uncaught TierDataError stack trace before the check's one line

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 9ed410c

- 2026-11-26 (prd/orchestration-split-4): Found in orchestration-split-4 slice 2: run project-check before tooling-lint in package.json's test:tooling, or have the lint catch TierDataError
- 2026-11-27 (the Risa move, B-543): Was B-933 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-934 · chore · Archive finished rows out of the PRD registry table (75 done rows clutter it)

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 00269bb

- 2026-11-26 (Robert Bo Davis): Filed from the backlog session 2026-11-26 on the user's word: a registry archive (e.g. backlog prd archive) moving done rows out of the PRD table, like backlog archive does for items.
- 2026-11-27 (the Risa move, B-543): Was B-934 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-935 · bug · prd tidy lists lease .waiting files as safe to remove, then refuses them as not a lease

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 182c26b

- 2026-11-26 (Robert Bo Davis): Seen 2026-11-26: tidy listed .loops/.lease/browser/.waiting and check/.waiting (pid ? is gone); --yes failed with 'isn't a lease (<root>/<kind>/<N>)' and exit 1. The preview and the remover disagree.
- 2026-11-27 (the Risa move, B-543): Was B-935 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).

### RISA-952 · chore · Standing PRD with only blocked items (held, waiting on another topic) holds a lane idle: after a landing with nothing runnable it should close itself (prd rm) so the dispatcher starts the next topic

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: b7bb152

- 2026-11-27 (Robert Bo Davis): User 2026-11-27: fixes-ui idled about 4 h after wave 19 (01:56) with only B-325, which waits for Capacitor, left; it blocked fixes-nit, fixes-bug and fixes-perf at cap 1 (dispatcher: no free slot)
- 2026-11-27 (the Risa move, B-543): Was B-952 in Caretook; moved here with its notes. Its B- ids and scripts/ paths are Caretook's (scripts/loops/ is loops/ here).
- 2026-11-27 (Robert Bo Davis): Folded in RISA-982 (inbox 2026-11-27, fixes orchestrators keep waiting for new work when they run out): they need to clean themselves up so they stop taking a queue spot.
- 2026-11-27 (Robert Bo Davis): User 2026-11-27: wants it as soon as possible. Asked the fixes-tooling orchestrator to plan it first in its next wave, right after wave 2.

### RISA-968 · feature · Time gates read their limits and fallbacks from the project's config (Risa's side of Caretook's B-837 and B-859; Caretook keeps its limit values, tiers and quick-check target as config)

- status: triaged
- prd:
- owner:
- commit:

- 2026-11-27 (Robert Bo Davis): 2026-11-27, the user's word: out of fixes-tooling (a feature, not a fix), unassigned until it's better understood.

### RISA-969 · chore · CI workflow on GitHub: lint, prettier and the tests on push and on PRs to main

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 00269bb

- 2026-11-27 (prd/fixes-tooling): The user, 2026-11-27 (ask a5): yes, add the workflow in a later fixes-tooling wave (pnpm check on push and PRs to main, node and pnpm pinned exactly; AGENTS.md's 'no CI yet' updated).

### RISA-981 · bug · A dispatcher started from a release install never re-execs onto a newer release, though risa status says 'code stale … it re-execs before its next tick': dispatch.mjs hashes its own frozen release folder at start and each tick (always equal), while status compares the current tool's checkout; a re-exec would rerun the old release's dispatch.mjs anyway. Re-exec into the release risa points to, or have status say to restart it by hand. Also: status 'last:' is the last logged line (logged only on change), so show lastTickAt beside it

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 2d34ce6

- 2026-11-27 (Robert Bo Davis): Seen 2026-11-27 in Caretook after installing v0.1.3: the v0.1.2 dispatcher (pid 16950, started by risa recover) stayed on v0.1.2, started fixes-ui at 18:37:20Z with v0.1.2's session.sh, and was SIGTERMed by hand at 18:39:19Z. Sibling of RISA-980 (both release-install). fixes-bug: wrong behaviour
- 2026-11-27 (Robert Bo Davis): 2026-11-28, seen on two machines after the v0.1.7 install: here pid 36372 still runs v0.1.6's dispatch.mjs (status says stale, re-execs before its next tick, an hour on); Caretook's machine (Decker): pid 8460 still runs v0.1.5's dispatch.mjs 10 min after the link moved, and launched prd-fixes-perf with v0.1.5's session.sh after the switch.
- 2026-11-27 (Robert Bo Davis): User 2026-11-28: high priority; moved from fixes-bug to fixes-tooling to land in its next wave within a couple of hours. Pairs with RISA-1009 (restart command).

### RISA-986 · change · PRD registry: prd status (loops/ls.sh) and dispatch --dry-run print a hold's reason (follow-up of RISA-477, which records it and prints it in prd list)

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 1573463

- 2026-11-27 (prd/fixes-tooling): From fixes-tooling slice 4 (2026-11-27): left out because loops/ls.sh and loops/dispatch* are after-split's hot files.

### RISA-987 · bug · tooling-lint.mjs defaults TRUNK to dev, but a repo's trunk comes from its config (Risa's is main)

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 00269bb

- 2026-11-27 (prd/fixes-tooling): From fixes-tooling slice 2 (2026-11-27).

### RISA-989 · bug · backlog/backlog.mjs's own stale-lock takeover (rmSync near line 230) removes a stale lock without a guard, the race RISA-367 fixed in lib.sh's with_backlog_lock

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 7451bdd

- 2026-11-27 (prd/fixes-tooling): From fixes-tooling slice 3 (2026-11-27).

### RISA-993 · bug · config.test 'starts Node once' fails on main too: ENOENT on its temp 'starts' file

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 7451bdd

- 2026-11-27 (Robert Bo Davis): 2026-11-27: seen while checking the RISA-988 hotfix (load 8–46, so some may be timing). Triage: fixes-tooling (tests). RISA-994 may share after-split slice 1's cause (session state leaking into the tests); check after it lands.
- 2026-11-27 (slice/fixes-tooling/13): Cause: the test wasn't hermetic. test-setup.mjs's ??= keeps a shell's RISA_MACHINE_CONFIG/RISA_CONFIG, so 'starts Node once' also counted find_repo's machine.mjs start (2 lines), and backlogIds/toolCommands defaults read the checkout's risa.json. Fixed in config.test.mjs (pins both). The ENOENT itself didn't reproduce at load 56.

### RISA-994 · bug · Run in the main checkout with RISA_*/CLAUDE_CODE_* unset, land, land-force-resume, land-gate, land-unsynced, recover, rotate and stack tests fail (54 of 511); they pass in a worktree

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 6973aab

- 2026-11-27 (Robert Bo Davis): 2026-11-27: seen while checking the RISA-988 hotfix (load 8–46, so some may be timing). Triage: fixes-tooling (tests). RISA-994 may share after-split slice 1's cause (session state leaking into the tests); check after it lands.
- 2026-11-27 (prd/fixes-tooling): 2026-11-27 (fixes-tooling wave 2 gate): after after-split's RISA-975 hermetic env, loops/land-unsynced.test.mjs still times out (5 tests, 20 s) on main's tip at load ~30, RISA_* unset; ask, stack, recover, rotate, sessions, dispatch, land-gate, land-force-resume failed at load 75 but ask and stack passed on a rerun at load 31.
- 2026-11-27 (prd/fixes-tooling): 2026-11-27 (fixes-tooling slice 17, RISA-1000 scales vitest limits with load): at load ~30 still failing: land-unsynced (2, vitest timeout at 38.6 s), and in-test/script waits that vitest limits don't cover: ask (3, RISA_ASK_NOTIFY timed out), rotate (helper 'timed out waiting'), sessions ('prd-t isn't running'), bye (hand-off line). Scope for wave 4: scale those inner timers too.
- 2026-11-28 (prd/fixes-tooling): Slice 31 (b432f93): scaledWait in loops/test-limits.mjs; land-unsynced and rotate use it. Second half is slice 32.
- 2026-11-28 (slice/fixes-tooling/32): Slice 32 (97707c4, 6865b59): ask, sessions, bye waits use scaledWait; bye's failures were a cross-test race (stub record had no dir, so another prd-w session.sh on the machine blocked prd end), fixed; sessions kills each started stub's process group after its test.

### RISA-995 · chore · Usage strings and comments in the code still name the literal 'prd <command>' (loops/doc.mjs 'usage: prd doc <role>', lib.sh, skeptics.mjs and others), not the project's command

- status: triaged
- prd: fixes-nit
- owner:
- commit:

- 2026-11-27 (prd/after-split): Seen by after-split slice 6 (2026-11-27), which changed only the generic docs

### RISA-997 · chore · CI workflow writes a verdict artifact so risa ci run --wait reads its runs (now 'unknown: the run left no verdict')

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: b7bb152

- 2026-11-27 (prd/fixes-tooling): From fixes-tooling slice 8 (RISA-969): .github/workflows/ci.yml runs pnpm check but uploads no verdict.json, so ci run --wait can't judge its runs.

### RISA-998 · feature · A "replan" state on a PRD registry row: the dispatcher sends that topic back to its planner (before…

- status: triaged
- prd: self-recovery-3
- owner:
- commit:

- 2026-11-27 (Robert Bo Davis): From the inbox: A "replan" state on a PRD registry row: the dispatcher sends that topic back to its planner (before it runs or between waves) to replan the whole PRD
- 2026-11-27 (Robert Bo Davis): Triage: risa-next, the bin for new dispatcher and registry features; the user chose a whole-PRD replan (a registry state), not an item status. Could join self-recovery-3 instead (both touch loops/dispatch).
- 2026-11-28 (Robert Bo Davis): When this ships, tell Caretook's backlog session which version or commit has it (asked 2026-11-28; Caretook's pin was v0.1.8 then).

### RISA-999 · bug · An After on an already archived PRD topic passes doctor but the dispatcher never counts it done (dispatch reads only prd list), so the dependent topic waits forever

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: b7bb152

- 2026-11-27 (prd/fixes-tooling): Codex on PR #7 (thread PRRT_kwDOV9ctaM689rK9, backlog/registry.mjs:421), from RISA-934's prd archive: archiveDone strips After references only to the rows it moves now; a later prd add/set after=<archived> keeps one. Fix: drop or refuse an archived After on write, or have dispatch read the archive.

### RISA-1000 · bug · Under load (5-min avg 20-35) the tooling unit suite times out in 5-19 files (20s test, 10s hook limits); the same files pass alone

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: b7bb152

- 2026-11-27 (prd/after-split-2): Seen 2026-11-27 by after-split-2: two slice checks and the wave-1 full check failed only on timeouts (ask, bye, tidy-cli, land-unsynced, land-gate, recover, rotate, stack, load-gate, dispatch, sessions…); all pass run alone at load ~7. Fix candidates: scale vitest testTimeout/hookTimeout with load as check-budget does, or lower parallelism under load.
- 2026-11-27 (Robert Bo Davis): Check log (risa check --times, 2026-11-27): tests failed in 31 of 33 logged runs (full 9/10, slice 22/23; median 6.3 min). The log doesn't record the failing step or test files ('Test failures by step: (not recorded)'), so it can't confirm these were all timeouts.

### RISA-1002 · feature · Backup Claude account: when the current account reaches 99% usage on this machine, or on the user's word, Risa pauses work, swaps every session to the other account (work or personal) and resumes there

- status: triaged
- prd: usage-aware-drain
- owner:
- commit:

- 2026-11-27 (Robert Bo Davis): 2026-11-27, the user's word: filed into risa-next. Builds on what exists: a Claude config folder per project or role (host.mjs claudeConfigDir, RISA_CLAUDE_CONFIG_DIR, machine config; Caretook B-543 slice 7), per-account usage readings, and RISA-927 (the drain reads each session's own account, fixes-tooling wave 3 slice 18). New: the machine config names two accounts (config folders) and which is current; a trigger at 99% (5-hour or weekly) on the current one, or a user command (e.g. risa account swap, from the phone too); pause the dispatcher, drain or rotate running sessions at a safe point, reopen them on the other account's folder, resume. Related: usage-aware-drain (RISA-814 drain line per plan), self-recovery (sessions reopening cleanly).
- 2026-11-27 (Robert Bo Davis): 2026-11-27, the user's word: the backup account's config folder shares, by symlink to the main one, everything that must persist between them: memory (projects/<repo>/memory), settings (settings.json, keybindings.json), CLAUDE.md, skills, agents, commands, plugins and hooks scripts, and the session transcripts (projects/) so a swapped session can resume its conversation. Account-specific, never linked: the sign-in (.claude.json's account and the keychain entry), usage and rate-limit caches. A risa command sets the links up and checks them (machine check), and says which entries it found that it doesn't know.
- 2026-11-27 (Robert Bo Davis): 2026-11-27, from Caretook's backlog (Garrett), read from that machine's disk: ~/.claude is personal, ~/.claude-work the other. A local-only Caretook script (.local/account-switch/switch-account.sh, git-excluded) does 'setup DIR': symlinks CLAUDE.md, settings.json, skills, plugins to ~/.claude and each projects/<slug>/memory (re-run for new memory; skips linked and real files). Kept per account: login, transcripts (so no --resume across accounts), .claude.json (trust, onboarding), history.jsonl, file-history, session-env, sessions, shell-snapshots, backups, cache, Remote Control pairing, claude.ai connectors, artifacts. Sign-in: CLAUDE_CONFIG_DIR=~/.claude-work claude, /login, trust the repo, /exit. 'use work' sets machine.json repos[<path>].claudeConfigDir and runs machine check; 'use personal' removes it; 'status' prints host.mjs claudeChoiceFor per role; warns when RISA_CLAUDE_CONFIG_DIR is set (it overrides). Switch steps: hand off, pause dispatcher, use work, close sessions, resume (keep-alive reopens). Gotchas: a plain claude stays personal (hand-started work sessions need CLAUDE_CONFIG_DIR=… claude --remote-control <name>); running sessions keep their account until restart; keep all sessions on one account at a time (drain readings, B-927/RISA-927); the phone app stays personal, the work account is reached by browser; ~/.claude/skills is itself a symlink (two hops). Open for planning: the user's earlier note wants transcripts shared so a swapped session resumes; this setup keeps them per account. The plan moves this script into Risa (a risa account command).
- 2026-11-27 (Robert Bo Davis): 2026-11-27, the user's word: transcripts stay per account, as on the other machine; a swap is a hand-off: each session reopens fresh on the other account from its brief. This replaces the earlier note's 'share the transcripts'.
- 2026-11-27 (Robert Bo Davis): 2026-11-27, the user's word: separate transcripts is for now; once agents depend less on their context (hand-offs and jobs that survive them, e.g. RISA-913), resuming across accounts matters less. Revisit then.
- 2026-11-28 (Robert Bo Davis): 2026-11-28, the user's word: usage-aware-drain runs after cross-machine-messages (RISA-1055), so a swap never cuts machines off from each other (Remote Control reaches only one account's sessions). Goal: this machine on business with personal as backup, the other machine the reverse.

### RISA-1003 · bug · rotate's standing-close simulated pick omits facts.landed, so a landed-but-planned row can make a standing topic close and then be restarted by the dispatcher (worktree, stack, test db torn down and rebuilt)

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: cf9c3a4

- 2026-11-27 (prd/fixes-tooling): Codex P2 on PR #10 (thread PRRT_kwDOV9ctaM68-zC2, loops/rotate.mjs:139), from RISA-952: pass the gathered landed-topic facts into standingClose's simulated pick, as dispatch-pick's landedWhy() uses them.

### RISA-1004 · bug · With RISA_USAGE_WATCH=off, a dead session with an outstanding stall mark is still held out of pick()'s reopen, and resume waits for its recorded reset, so disabling the watch doesn't release it

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 0de37c9

- 2026-11-27 (prd/fixes-tooling): Codex P2 on PR #10 (thread PRRT_kwDOV9ctaM68-5-h, loops/dispatch.mjs:1622), from RISA-927 fix 2: apply drainSettings' watch-off override to the stalled-session lookup too.
- 2026-11-27 (prd/fixes-tooling): 2026-11-27 (slice 22 hand-off): with the watch off the resume (resumePrep) still keeps its stall marks, so once a mark's reset passes it may end the reopened live session and resume it again; outside slice 22's scope, a follow-up if it shows.

### RISA-1005 · chore · Slice check runs only the slice's named check: a project config key for a one-test-file command (the runner differs per project), risa check --quick on a slice branch runs the plan's Check field through it, the full check stays at the wave's landing; the orchestrator splits a slice that comes back over budget (second half of RISA-881)

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 3626f71

- 2026-11-27 (prd/fixes-tooling): 2026-11-27 (fixes-tooling wave 4): split out of RISA-881 at planning: RISA-881 keeps the planner rule and the plan lint (budget, one test file, no shared test file in a wave); this one makes the slice check use it.

### RISA-1006 · chore · A release tag leaves package.json's version behind: v0.1.7 still says 0.1.2; cutting a tag should bump it (or a check should catch the mismatch)

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 1573463

- 2026-11-27 (Robert Bo Davis): Found by Caretook's backlog (Decker) on installing v0.1.7: package.json says 0.1.2 at v0.1.2 through v0.1.7. Triaged fixes-tooling: release scripts and checks.

### RISA-1007 · plan · Multi-machine: Risa runs and coordinates across several machines (sessions, repos, releases, agent discovery); risa-next designs for it, building the cross-machine parts can follow

- status: triaged
- prd: risa-next-2
- owner:
- commit:

- 2026-11-27 (Robert Bo Davis): User 2026-11-28: a design constraint for risa-next (its planner designs RISA-794, 841, 799, 984, 796, 820, 797 with several machines in mind); building the cross-machine parts can be a follow-up topic. Prompted by Caretook's backlog running on another machine (reached only over Remote Control) and the v0.1.7 install mix-up.

### RISA-1009 · feature · A command a backlog agent can run to restart the dispatcher on the current release (stop, then start it in its own tab or detached), so a new pin or install doesn't need the user at the terminal

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 8c34b95

- 2026-11-27 (Robert Bo Davis): Asked by the Caretook user via Caretook's backlog (Decker), 2026-11-28. Today risa dispatch --stop exists but starting again is risa dispatch in a tab by hand. Pairs with RISA-981 (a running dispatcher never re-execs onto a new release); together they decide how a release reaches a running dispatcher. Triaged fixes-tooling (scripts).

### RISA-1010 · bug · machinery.md ends with a stub '## The context watch' after '## Worktrees and leases' (2b02eab, RISA-880), so a project's additions, which continue the generic doc's last section, merge under the stub: Caretook's worktree lines drop out of risa doc machinery 'Worktrees and leases' and its own 'The context watch' heading appears twice

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 04f2e0f

- 2026-11-27 (Robert Bo Davis): Found by Caretook's backlog (Decker), 2026-11-28; it broke Caretook's scripts/project/project-data.test.mjs at the v0.1.7 repin and Caretook went back to v0.1.2 (dev b978e0d7d). Fix: keep 'Worktrees and leases' last, or fold the stub line into a context watch section placed earlier. Also worth a check: a doc test that a generic doc's last section doesn't move between releases (projects extend it). Wanted in v0.1.8.
- 2026-11-27 (Robert Bo Davis): User 2026-11-28: into fixes-tooling with RISA-981; v0.1.8 is cut when both land, then Caretook (Decker) is told to repin.

### RISA-1011 · chore · The planner prompt (loops/prompts/plan.sh) and the plan skeptic's SLICE_SIZE_RULE (loops/skeptics.mjs) still say 'about 8 files'; bring them to slice 19's budget (about 4 files, one Check: test file), updating prompt.test, skeptics.test and sample-project/prompt-golden.txt

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 5bff9fa

- 2026-11-27 (prd/fixes-tooling): 2026-11-27: from fixes-tooling slice 19's hand-off (RISA-881); pairs with RISA-882.

### RISA-1012 · bug · risa dispatch --restart stops the dispatcher and starts none when no tab can open (iTerm2 unavailable, headless): open-session.sh falls back to printing the command and exits 0, so the restart waits out its timeout with dispatching stopped; check a tab can open before stopping, or fall back to a detached process

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 1573463

- 2026-11-27 (prd/fixes-tooling): 2026-11-27: Codex P2 on PR #11 (thread PRRT_kwDOV9ctaM68_idm, loops/dispatch.mjs:2196), from RISA-1009 (slice 25).

### RISA-1013 · bug · risa status's 'last tick' reads the stuck watch's stuck.lastTickAt, which isn't written while usage-limited, paused or with RISA_STUCK_WATCH=off, so a healthy dispatcher looks stalled; record a heartbeat on every tick and show that

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 1573463

- 2026-11-27 (prd/fixes-tooling): 2026-11-27: Codex P2 on PR #11 (thread PRRT_kwDOV9ctaM68_ido, loops/status-extra.mjs:122), from RISA-981 (slice 24).

### RISA-1014 · change · risa land skips the Codex re-review when the commits after Codex's approval change only docs or plan files, as the test gate does

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 1573463

- 2026-11-27 (Robert Bo Davis): User, 2026-11-28: told fixes-tooling to skip Codex on wave 4, where only Status commits followed the approved commit; the Codex requirement should follow the test gate's rule.

### RISA-1015 · bug · risa slice cuts a slice branch from the committed prd/ tip even when the plan's section for that slice is uncommitted: the slice worktree's plan lacks it, so the narrow slice check (Check: field) silently falls back to the full suite; refuse (or warn) when the slice's heading isn't in the committed plan

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 04b1309

- 2026-11-27 (prd/fixes-tooling): 2026-11-27, fixes-tooling wave 5: ten slices made before the plan commit; all ran the full suite at once (load 107). slice-fields.mjs warned 'no Slice 34 heading' to /dev/null in check-hook.sh's slice_check.
- 2026-11-27 (prd/fixes-tooling): Also (slice 38's hand-off): even with Check: read, the slice check adds the whole tooling suite for any diff under loops/ ('the tooling tests join'), so in this repo the narrow check saves nothing; the tooling join should run only the Check file on a slice branch. And (slice 28): check-plan --plan doesn't report an unknown Model: value.
- 2026-11-28 (prd/fixes-tooling): Wave 6 follow-ups: loops/anchors.mjs calls planBudget but ignores its new errors (prd anchors doesn't show a bad Model, slice 41); in this repo the Check file runs twice, once in the unit step via commands.testFile and again in the narrowed tooling step (slice 40).

### RISA-1016 · change · risa review and risa ready (review.sh, lib.sh pr_verdict) read a PR whose commits after Codex's approval are docs only as stale; pass codex-review.mjs --docs as land does since RISA-1014

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 04b1309

- 2026-11-27 (prd/fixes-tooling): From fixes-tooling slice 36's hand-off (2026-11-27).

### RISA-1017 · plan · Risa: usable by others: install without a Risa checkout, docs for outsiders, versioning (risaVersion enforced), hosts other than macOS and iTerm2 (cut from RISA-797 by the risa-next-4 planner)

- status: triaged
- prd: risa-next-5
- owner:
- commit:

- 2026-11-28 (plan/risa-next-4): Cut from RISA-797 by plan/risa-next-4 (2026-11-28): risa-next-4 proves Risa on a second repo; this is the release half.

### RISA-1018 · bug · check-run.test.mjs 'waits while busy, starts when the load drops' flakes on CI: the load-drop line reads '-' instead of the stubbed 1 (run 46123266140, fixes-tooling wave 6 tip 04b1309; no wave-6 file touches check-run)

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 92d9344

- 2026-11-28 (prd/fixes-tooling): Seen on GitHub Actions run 46123266140: 'The load dropped to - (threshold 4) after 2s'; the stub's load sequence ran out or was read mid-write.

### RISA-1019 · chore · session-names.mjs personaOf repeats flavor.mjs sessionPersona's backlog rule (one word of letters, not 'backlog', the pool's rank); call sessionPersona instead

- status: triaged
- prd: fixes-nit
- owner:
- commit:

- 2026-11-28 (prd/risa-next): Found merging risa-next slices 2 and 3 (both wrote the rule in parallel); no behaviour difference today

### RISA-1020 · bug · loops/anchors.mjs ignores planBudget's errors, so prd anchors doesn't show a bad Model field

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: b7fd72e

- 2026-11-28 (prd/fixes-tooling): Follow-up noted on RISA-1015 (fixes-tooling wave 6): check-plan reports a bad Model, anchors doesn't.

### RISA-1021 · chore · In Risa's own repo the slice check runs the Check file twice (unit step via commands.testFile, then the narrowed tooling step)

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: b7fd72e

- 2026-11-28 (prd/fixes-tooling): Follow-up noted on RISA-1015 (fixes-tooling wave 6).

### RISA-1022 · bug · The load gate reads an unreadable load mid-wait as dropped: load_gate_wait (loops/lib.sh) ends its busy loop on 'unread' and starts the check with 'The load dropped to -'

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: b7fd72e

- 2026-11-28 (prd/fixes-tooling): Found by slice 44 (RISA-1018): keep polling on unread once it has said busy.

### RISA-1023 · bug · Under a release install, risa status-trim crashes: loops/status-trim.mjs imports prettier (a dev dependency), and the release folder has no node_modules, so it fails with ERR_MODULE_NOT_FOUND. Resolve prettier from the project's checkout, or skip formatting when it's missing

- status: ready
- prd: fixes-bug
- owner: prd/fixes-bug
- commit: cf93d26

- 2026-11-28 (Robert Bo Davis): Seen 2026-11-28 by Caretook's fixes-bug orchestrator on v0.1.8 (pin f5ce80a58), reported by Caretook's backlog session; it trimmed its Status by hand. Same family as RISA-980 (paths resolved against the release). fixes-bug: wrong behaviour in a released install; also breaks AGENTS.md's no-runtime-dependencies rule.

### RISA-1024 · bug · A backlog --brief written before slice 4 (## Directives heading) gets a header naming only _From the user_ lines as the user's word, so its directives read as context: name the detected heading, or normalise it

- status: ready
- prd: fixes-bug
- owner: prd/fixes-bug
- commit: cf93d26

- 2026-11-28 (prd/risa-next): Codex P2 on PR #16 (loops/prompts/backlog.sh:15, thread PRRT_kwDOV9ctaM69B8DS): directives=1 for a legacy heading, but the standing line names only _From the user_. Only the first rotation after risa-next wave 3 lands can carry a legacy brief.

### RISA-1025 · change · dispatch.mjs loads finish.mjs lazily (createRequire, skipped when missing) because dispatch.test.mjs and its siblings copy a fixed script list; add finish.mjs to those lists and import it statically

- status: live
- prd: self-recovery-2
- owner: prd/self-recovery-2
- commit: fe26f6c

- 2026-11-28 (prd/self-recovery-2): From self-recovery-2 slice 3 (1f9606b): the plan barred editing loops/dispatch.test.mjs while after-split owned it. A missing finish.mjs silently skips the finish step; dispatch-context and dispatch-restart tests skip it too.
- 2026-11-28 (Robert Bo Davis): Moved from fixes-tooling to self-recovery-2 2026-11-28: the same dispatch.mjs and finish.mjs lines as RISA-1027 and RISA-1029, already triaged there; one topic makes the one change.

### RISA-1026 · bug · lease.test.mjs 'returns once the worktree's check lease is released' flakes under load: the wait line printed is 'Waiting (up to 0m30s)…' before the holder line

- status: live
- prd: fixes-tooling
- owner: prd/fixes-tooling
- commit: 46bbadb

- 2026-11-28 (prd/self-recovery-2): Seen in self-recovery-2's full check on a362002 (2026-11-28, load ~13); passes 26/26 alone.

### RISA-1027 · bug · risa finish <topic> (the CLI) files a fresh report on every run for an unchanged code tail or other report-only reason: it gathers with no reported keys and never persists d.key

- status: live
- prd: self-recovery-2
- owner: prd/self-recovery-2
- commit: fe26f6c

- 2026-11-28 (prd/self-recovery-2): Codex P2 on PR #20 (loops/finish.mjs:467). The dispatcher's finishStep (slice 3) keeps finish.reported; the CLI should read and write the same keys.

### RISA-1028 · bug · cost.mjs topicFolders counts a topic named plan-<x>'s orchestrator transcripts (.loops/plan-<x>, branch prd/plan-<x>) as topic <x>'s planning tokens

- status: live
- prd: self-recovery-2
- owner: prd/self-recovery-2
- commit: fe26f6c

- 2026-11-28 (prd/self-recovery-2): Codex P2 on PR #20 (loops/cost.mjs:292), reproduced by Codex. A planning folder should require a plan/<topic> branch (or none), not any non-slice branch.

### RISA-1029 · bug · dispatch.mjs finishStep prefilters candidates with landedTopics/landedWithCode on the configured trunk, ignoring env.TRUNK (gatherFinish and tidy honor it): a topic landed only into an overridden trunk is never auto-finished

- status: live
- prd: self-recovery-2
- owner: prd/self-recovery-2
- commit: fe26f6c

- 2026-11-28 (prd/self-recovery-2): Codex on PR #21 (loops/dispatch.mjs:1709): pass env.TRUNK || kinds.trunk to both landing checks, as collectTidyFacts does

### RISA-1030 · bug · The dispatcher can die silently and nothing notices: Caretook's (v0.1.8, pid 22040) was gone hours after a normal tick with no error in .loops/.dispatch.log and .dispatch.json still naming its pid. Log why it exits, have risa status flag a dead dispatcher pid, and keep it alive (launchd or a watchdog that restarts it and files a report)

- status: live
- prd: fixes-bug-urgent
- owner: prd/fixes-bug-urgent
- commit: 1f81567

- 2026-11-28 (Robert Bo Davis): Seen 2026-11-28 by Caretook's backlog session: started by risa dispatch --restart at 03:36Z, last tick 09:13:53Z, gone by 11:34Z; restarted by hand. self-recovery-3: the machinery keeping its own long-running work alive (beside RISA-913), more than a small fix.
- 2026-11-28 (Robert Bo Davis): Moved to fixes-bug-urgent 2026-11-28 on the user's word: log why the dispatcher exits and have risa status flag a dead pid now; the keep-alive (launchd or a watchdog) may stay for self-recovery-3 if it grows past a fix.
- 2026-11-28 (Robert Bo Davis): More from Caretook's backlog session 2026-11-28: in the same minutes (09:13-09:18Z) both running orchestrators stalled too. prd-fixes-bug got its CI task notification at 09:18:23Z and never took another turn (3h40m idle, processes alive). prd-sync-safety-3 ended its turn at 09:38Z waiting on a browser check that printed nothing, with no Playwright left running. Likely one machine or network event. With the dispatcher dead, worker-watch's 30-minute quiet-orchestrator check never ran, so nobody noticed for ~3h.
- 2026-11-28 (Robert Bo Davis): Caretook 2026-11-28: no Sleep/Wake/DarkWake in pmset -g log 08:00-12:59Z (a MaintenanceWake assertion at 09:02Z; Claude.app's NoIdleSleepAssertion held throughout), so not sleep. System log (OOM, network) not checked yet.

### RISA-1031 · bug · risa status hung over 2 minutes in Caretook's main checkout on v0.1.8 at load 2, the morning its dispatcher had died; cause not confirmed

- status: triaged
- prd: fixes-perf
- owner:
- commit:

- 2026-11-28 (Robert Bo Davis): Seen 2026-11-28 by Caretook's backlog session; may be related to the dead dispatcher (see the item filed beside it). fixes-perf: speed, not wrong output, until a cause shows otherwise.

### RISA-1032 · change · Two fixes topics may run at once when their hot files don't overlap: dispatch-pick.mjs's startBlock refuses any standing topic while another runs ('another fixes topic … is running'), so in a repo where one fixes topic (Risa's fixes-tooling) keeps refilling, fixes-bug, fixes-perf and fixes-nit rarely or never get a lane. The hot-file check already guards overlap; keep the lane cap

- status: triaged
- prd: fixes-bug-urgent
- owner:
- commit:

- 2026-11-28 (Robert Bo Davis): The user's choice 2026-11-28, over adding rows only or folding everything into fixes-tooling. fixes-nit and fixes-perf still have no registry row, so they need rows to run at all. fixes-tooling: the dispatcher's scripts; one rule in loops/dispatch-pick.mjs plus its test.
- 2026-11-28 (Robert Bo Davis): Moved from fixes-tooling to fixes-bug 2026-11-28: fixes-tooling is retiring in Risa's repo; normal urgency.
- 2026-11-28 (Robert Bo Davis): Moved to fixes-bug-urgent on the user's word (2026-11-28): with it the second lane can run another fixes topic; for the next wave beside RISA-1037 and RISA-1038.

### RISA-1033 · bug · A session that receives a task notification and never takes another turn isn't counted as stalled: Caretook's prd-fixes-bug sat 3h40m after its CI notification with its processes alive. The quiet-orchestrator watch should flag (and nudge) a session whose last transcript entry is an unanswered notification

- status: live
- prd: fixes-bug-urgent
- owner: prd/fixes-bug-urgent
- commit: 1f81567

- 2026-11-28 (Robert Bo Davis): From Caretook's backlog session 2026-11-28, beside RISA-1030 (same event). fixes-bug-urgent: lanes stall unseen overnight.
- 2026-11-28 (Robert Bo Davis): Caretook 2026-11-28: prd-fixes-bug was alive and took a turn at 11:59:35Z right after a SendMessage nudge, so its 09:18Z task notification simply never triggered a turn. Separate from the dispatcher dying (RISA-1030).

### RISA-1034 · bug · An orchestrator can end its turn waiting on a check that has no background wait to wake it: Caretook's prd-sync-safety-3 ended its turn at 09:38Z on a browser check that had printed nothing and later wasn't running, so nothing ever woke it. The orchestrator prompt and the check wrapper should keep a background wait (or a result file the watch reads) for every check it waits on

- status: live
- prd: fixes-bug-urgent
- owner: prd/fixes-bug-urgent
- commit: 1f81567

- 2026-11-28 (Robert Bo Davis): From Caretook's backlog session 2026-11-28, beside RISA-1030. Overlaps RISA-913's machinery-owned jobs (self-recovery-3) for the long-term shape; this is the small guard now.
- 2026-11-28 (Robert Bo Davis): Caretook 2026-11-28: prd-sync-safety-3 was alive and took a turn at 11:59:35Z right after a nudge; its background wait on the browser check had ended with nothing to wake it. Separate from RISA-1030.

### RISA-1035 · change · Backlog and orchestrator prompts: keep queues moving the best way you know; contact the user about flow actions only when the action risks major work, data, or another critical problem

- status: dropped
- prd: fixes-bug
- owner:
- commit:

- 2026-11-28 (prd/fixes-tooling): From the user, 2026-11-28 (in the fixes-tooling session): 'a general rule: keep queues moving the best way you know how. Only contact me about actions that keep work moving if you see any real risk of major work, any data, or any other critical problems arising from your recommended action. This should probably be part of backlog prompts'
- 2026-11-28 (prd/fixes-tooling): The user added: '(or a new "queue-tender" agent)': the rule could live in the backlog prompts, or in a new queue-tender role whose job is keeping the lanes moving.
- 2026-11-28 (Robert Bo Davis): Triaged 2026-11-28 into fixes-bug (normal urgency): a wording rule in loops/prompts/backlog.sh, orchestrator.sh and their docs, one slice. The 'queue-tender' role the user floated is a bigger design; asks-relay (the backlog session as go-between for every agent) is the natural place for its planner to weigh it.
- 2026-11-28 (Robert Bo Davis): Dropped 2026-11-28: the user sent this rule to the fixes-tooling session by mistake and asked for it undone; the rule was meant for the backlog session, which now follows it.

### RISA-1036 · plan · A queue-tender role: a session whose only job is keeping the lanes moving (nudging stalled orchestrators, closing idle topics, restarting the dispatcher, reordering by the user's priorities), acting on its own and asking the user only when an action risks major work, data or something critical; today the backlog session does this between other work

- status: triaged
- prd: asks-relay
- owner:
- commit:

- 2026-11-28 (Robert Bo Davis): The user, 2026-11-28, beside the keep-queues-moving rule now held by the backlog session. asks-relay already plans the backlog session as go-between for every agent's questions; its planner weighs a separate queue-tender against folding this into the backlog role, alongside RISA-1033 and RISA-1034's stall detection.

### RISA-1037 · bug · The dispatcher logs why it exits: every exit path (signal, uncaught error, lost lock, clean stop) writes one line to .loops/.dispatch.log and marks .dispatch.json stopped, so a dead pid with no stop mark reads as a crash

- status: live
- prd: fixes-bug-urgent
- owner: prd/fixes-bug-urgent
- commit: 7db3bce

- 2026-11-28 (prd/fixes-bug-urgent): Split from RISA-1030 2026-11-28 by the fixes-bug-urgent orchestrator: needs loops/dispatch.mjs, a running self-recovery-2 hot file, so it waits for a later wave; RISA-1030 keeps the risa status flag (loops/status-extra.mjs) now. The keep-alive stays with self-recovery-3.

### RISA-1038 · bug · The inbox session finds the wrong project: run from its own directory (~/.risa/inbox, outside any repo), session.sh's find_repo falls back to the release worktree's repo (Risa's checkout), not the project prd.sh inbox ran for, so it misses that project's claudeConfigDir (starts on Claude Code's default account) and writes its session record under Risa's .loops/.sessions (the project's risa status shows it ended while it's live)

- status: live
- prd: fixes-bug-urgent
- owner: prd/fixes-bug-urgent
- commit: 3fa8ed4

- 2026-11-28 (Robert Bo Davis): Seen 2026-11-28 12:53Z on Caretook's machine under v0.2.0 (from Caretook's backlog session): keep-alive opened 'inbox (caretook)', pid 45166, with no CLAUDE_CONFIG_DIR; machine.json gives caretook.com claudeConfigDir=/Users/bo/.claude-work (a plain string) and its prd/recover sessions carry it. Cause read from the code, not yet reproduced: session.sh sources lib.sh, find_repo from $PWD=~/.risa/inbox gets no machine entry, so main comes from git -C $loops_lib_dir, the release worktree, i.e. ~/git/risa; host.mjs claude-session then reads Risa's entry (no claudeConfigDir) and leaves the env as it is. Likely fix: prd.sh inbox passes the project's main (RISA_MAIN) through, and session.sh prefers it when $PWD is outside a repo. The session record path likely makes the keep-alive reopen a live inbox. fixes-bug-urgent: it spends on the wrong account on every inbox open.

### RISA-1039 · change · Session display names lead with the Starfleet name and abbreviate its rank: 'Adm Morrow · backlog (caretook)', not 'backlog (caretook) · Admiral Morrow'

- status: ready
- prd: fixes-bug
- owner: prd/fixes-bug
- commit: 9f14e04

- 2026-11-28 (Robert Bo Davis): The user's word (2026-11-28): the Starfleet name goes before the role. loops/session-names.mjs displayName builds the order; its already-qualified check (the ' (<project>) · ' match) and any reader that parses the name (ask.mjs labels, rotate, sessions, tab titles) must take the new order and still read names set the old way. Same file as RISA-1019; fixes-bug since every session shows it.
- 2026-11-28 (Robert Bo Davis): The user's word (2026-11-28): 'use abbreviations for ranks in agent names to the fix for swapping role/agent info.' Each rank's short form comes from the flavor pack beside its rank (e.g. Starfleet ADM, CAPT, CMDR, LCDR, LT, ENS), so another color setting brings its own. Only the agent's name is shortened: the persona line and replies keep the full rank. Reading an old name back must still work.

### RISA-1040 · feature · An orchestrator that lands and stops without rotating is caught: rotate runs go into .run-log.jsonl, and the dispatcher nudges (then closes) a standing topic whose session sits idle after a land-end with nothing runnable, instead of leaving its lane held

- status: triaged
- prd: self-recovery-3
- owner:
- commit:

- 2026-11-28 (Robert Bo Davis): Seen on Caretook 2026-11-28: fixes-bug landed wave 27 (PR #323), pushed Status, reported and stopped; it skipped orchestrator step 7 (fold, drain, rotate), so RISA-952's standing-close never ran and the lane stayed held under cap 2. Reported by Caretook's backlog session. Backstop for a skipped step, not a rotate bug; related to RISA-1036's queue tender.
- 2026-11-28 (Robert Bo Davis): Again on Risa 2026-11-28: self-recovery-2 landed its last wave (PR #23, 13:43Z) and ended with its registry row still 'planned' (all 7 items live), so it read as waiting and filled the lookahead; the backlog session set flags+=done by hand.

### RISA-1041 · change · Persona line: a status report reads as the role's log entry (captain's log), and the user's title (Fleet Admiral) is used only when speaking to the user directly (a question, an answer to them), not in narration of the session's own work

- status: triaged
- prd: fixes-nit
- owner:
- commit:

- 2026-11-28 (Robert Bo Davis): The user's word (2026-11-28): 'When captains are just talking about what they are doing, they should be writing to their captains log so the fleet admiral can review later. Only address fleet admiral when interacting directly with me.' The line is built in loops/flavor.mjs (~182); flavor.test.mjs checks its text.
- 2026-11-28 (Robert Bo Davis): The user's word (2026-11-28): 'That needs to be configurable when switching color settings.' So the log's name and when to use the title come from the flavor pack, beside pack.address (e.g. a pack.log field: captain's log for the Starfleet pack, its own wording or none for other flavors), never hard-coded in flavorLine; the default flavor and any pack without the field keep a plain report voice.

### RISA-1042 · bug · risa wait browser misses an active suite's earlier results: a waiter started (or restarted after exit 75) mid-suite reads the run log only from its own start offset, so an early failing browser check followed by a passing one prints only the pass and exits 0. Take the results since the suite's lease was taken, not since the wait began

- status: live
- prd: fixes-bug-urgent
- owner: prd/fixes-bug-urgent
- commit: 42321be

- 2026-11-28 (prd/fixes-bug-urgent): Codex finding on PR #25 (loops/lease.sh lease_wait/lease_results, RISA-1034's slice 2), verified 2026-11-28: browser.sh holds one lease for the whole suite and logs each check separately. Check waits are unaffected (one line per run, at its end). Not a regression: before RISA-1034 wait printed no result at all.

### RISA-1043 · change · backlog set takes --note TEXT (as add does), so triage is one command and one commit; the standalone backlog note command stays for a note alone

- status: triaged
- prd: fixes-bug-later
- owner:
- commit:

- 2026-11-28 (Robert Bo Davis): Reported by Caretook's backlog session 2026-11-28 (v0.2.0): 'risa backlog set B-1015 prd=fixes-ui status=triaged note=…' printed: can't set "note" (use status, type, title, prd, owner or commit). Text in loops/prompts/backlog.sh (also orchestrator.sh, sample-project/prompt-golden.txt). Workaround: a separate risa backlog note.
- 2026-11-28 (Robert Bo Davis): The user's pick (2026-11-28): set gets --note, and the separate note command stays as well. The guide's triage line then reads right as written.

### RISA-1044 · feature · Flavor pack: Battlestar Galactica. User addressed as Admiral; names are callsigns. backlog = Commanders (Adama, Cain, Fisk, Garner), prd = Captains (Starbuck, Apollo), slice = Viper pilot Lieutenants (Helo, Athena, Kat, Racetrack, Hotdog, Narcho), inbox = comms (Dualla, Gaeta), hotfix = deck crew (Chief Tyrol, Cally, Seelix), plan = Colonel (Tigh), recovery = Doctors (Cottle, Salik)

- status: triaged
- prd: flavor-packs
- owner:
- commit:

- 2026-11-28 (Robert Bo Davis): Very low priority, the user's word (2026-11-28). Data only: a PACKS entry in loops/flavor.mjs (address, a rank and name pool per role: backlog, prd, slice, inbox, hotfix, plan, recovery), with rank short forms (RISA-1039) and a log name (RISA-1041) once those land. The user picked 'Admiral, callsigns'.

### RISA-1045 · feature · Flavor packs: Star Wars, four of them: rebel (user = General; Admirals Ackbar, Holdo, Raddus; X-wing pilots; mechanics; protocol droids; medical droids), jedi (user = Grand Master; Masters, Knights, Padawans, healers), empire (user = Grand Moff; Admirals Thrawn, Piett; Captains; TIE pilots; technicians) and a mixed one drawing each role from the side that fits it best (Jedi planners, Rebel pilots, droid inbox)

- status: triaged
- prd: flavor-packs
- owner:
- commit:

- 2026-11-28 (Robert Bo Davis): Very low priority, the user's word (2026-11-28). Data only: a PACKS entry in loops/flavor.mjs (address, a rank and name pool per role: backlog, prd, slice, inbox, hotfix, plan, recovery), with rank short forms (RISA-1039) and a log name (RISA-1041) once those land. The user: 'These are cheap to build, right? build out all of them.' The planner settles each pool's names.

### RISA-1046 · feature · Flavor pack: Dune. A Great House: the user as the Padishah Emperor or a Duke, backlog = Dukes or House heads, prd = Swordmasters or Warmasters, slice = ornithopter pilots, inbox = Fremen messengers, hotfix = water engineers or Fremen craftsmen, plan = Mentats, recovery = Suk doctors

- status: triaged
- prd: flavor-packs
- owner:
- commit:

- 2026-11-28 (Robert Bo Davis): Very low priority, the user's word (2026-11-28). Data only: a PACKS entry in loops/flavor.mjs (address, a rank and name pool per role: backlog, prd, slice, inbox, hotfix, plan, recovery), with rank short forms (RISA-1039) and a log name (RISA-1041) once those land. The user picked Dune from the suggested packs; the address and the names still need the user's word at planning.

### RISA-1047 · feature · Flavor pack: Lord of the Rings. The user as a Wizard of the White Council, backlog = Wizards and Elf-lords, prd = kings and stewards, slice = Rangers and Riders, inbox = hobbits and messengers, hotfix = dwarf smiths, plan = Ents and loremasters, recovery = Elvish healers

- status: triaged
- prd: flavor-packs
- owner:
- commit:

- 2026-11-28 (Robert Bo Davis): Very low priority, the user's word (2026-11-28). Data only: a PACKS entry in loops/flavor.mjs (address, a rank and name pool per role: backlog, prd, slice, inbox, hotfix, plan, recovery), with rank short forms (RISA-1039) and a log name (RISA-1041) once those land. The user picked Lord of the Rings from the suggested packs; the address and the names still need the user's word at planning.

### RISA-1048 · bug · pnpm test:tooling runs no tests and exits 0 (a false green) from a project's node_modules: loops/tooling-tests.mjs's main guard compares import.meta.url with file://argv[1], and under pnpm argv[1] is the symlink while import.meta.url is the real .pnpm path; compare realpaths (as session-names.mjs's isMain does) here and in the other entry points with the same guard

- status: triaged
- prd: fixes-test
- owner:
- commit:

- 2026-11-28 (Robert Bo Davis): Reported by Caretook's backlog session 2026-11-28, in v0.1.8 and v0.2.0; by its realpath it runs 35 files, 602 passed. Same guard in loops/check-budget, check-plan, check-tooling, check-times, dev-brought, metrics, run-log, token-price (.mjs). A shared isMain helper and a test that runs one entry point through a symlink would keep it from coming back.
- 2026-11-28 (Robert Bo Davis): Scope (2026-11-28): through the risa command the check gate is fine (bin/risa resolves its path with readlink -f, so check-hook.sh and check-tooling.mjs get real paths). Only a direct 'node node_modules/risa/loops/<x>.mjs' is a silent no-op: pnpm test:tooling, and any CI or script step that calls one that way. The guard dates from v0.1.0.
- 2026-11-28 (Robert Bo Davis): When this ships, tell Caretook's backlog session which version or commit has it (asked 2026-11-28; Caretook pins v0.2.0 since dev 956c63a7c).

### RISA-1049 · change · A project's role additions can target a named section of the generic doc (a '## <Heading>' in the additions merges into that section; the rest appends at the end), and a check fails a change to a generic doc's section headings or last section that no changelog line names

- status: ready
- prd: fixes-bug
- owner: prd/fixes-bug
- commit: c0751bb

- 2026-11-28 (Robert Bo Davis): Asked by Caretook's backlog session 2026-11-28: additions print after the generic doc, so they can only continue its last section; v0.2.0 dropped backlog.md's closing 'Standing priorities:' lead-in, and v0.1.7 moved machinery's Worktrees section (Caretook B-996/B-997): two breaks in two days. loops/doc.mjs builds the doc.
- 2026-11-28 (Robert Bo Davis): When this ships, tell Caretook's backlog session which version or commit has it (asked 2026-11-28; Caretook pins v0.2.0 since dev 956c63a7c).

### RISA-1050 · change · Warn when a project's pinned risa differs from the running release: risa status, and the dispatcher on start or re-exec, name both versions (a refusal is RISA-1017's versioning)

- status: triaged
- prd: fixes-bug
- owner:
- commit:

- 2026-11-28 (Robert Bo Davis): Asked by Caretook's backlog session 2026-11-28: this machine ran v0.2.0 while Caretook's package.json still pinned v0.1.8 (730639ee), which its tests check against; nothing warned.
- 2026-11-28 (Robert Bo Davis): When this ships, tell Caretook's backlog session which version or commit has it (asked 2026-11-28; Caretook pins v0.2.0 since dev 956c63a7c).

### RISA-1051 · bug · The machinery doc has no 'The dispatcher' section (nor 'Recorded sessions', 'The load gate'), though orchestrator.md and inbox.md send readers to risa doc machinery "The dispatcher", which prints 'no section'; the dispatcher's stop mark and the stuck watch's notified kind have no doc home, and machinery.md's 727 B budget leaves no room to add one

- status: triaged
- prd: fixes-nit
- owner:
- commit:

- 2026-11-28 (prd/fixes-bug-urgent): Found by fixes-bug-urgent at wave 2's docs fold (2026-11-28): the fold went into prd.sh's help instead.

### RISA-1052 · bug · session.sh resolves its own directory (bin=$(cd "$(dirname "$0")" && pwd)) before sourcing lib.sh, whose unset CDPATH now comes too late: with CDPATH set and a relative $0, cd prints the matched path and bin gets it twice, so source "$bin/lib.sh" fails. Unset CDPATH first

- status: triaged
- prd: fixes-bug-urgent
- owner:
- commit:

- 2026-11-28 (prd/fixes-bug-urgent): Codex P2 on PR #26 (loops/session.sh:23), from RISA-1038's slice 6, verified 2026-11-28: lib.sh:9 unsets CDPATH, but session.sh now cd's before sourcing it. prd.sh inbox execs the wrapper by absolute path, so the usual path is unaffected. One line; wave 3 beside RISA-1032.

### RISA-1053 · feature · A generic ship command, risa ship <version>: one shared scaffold of pre-checks, ship steps, a smoke test and a notification, each a hook a project overrides for how it ships (Risa: bump package.json, tag, push the tag, smoke-test the tagged install, notify pinned projects; Caretook: its staging/production promotion)

- status: triaged
- prd: ship
- owner:
- commit:

- 2026-11-28 (Robert Bo Davis): From the user 2026-11-28: "Let's add some generic \"ship\" finding that caretook and risa can override for their own usage so we have a shared scaffolding. We DO ship pinned versions right now, so we need a \"ship (version)\" command that standardizes pre checks, steps, smoke test, and notification". Reshapes staging-ship: its Caretook staging flow (RISA-404, 430, 436, 584) becomes Caretook's override of this scaffold; the topic needs a replan around it.
- 2026-11-28 (Robert Bo Davis): Own topic ship on the user's word 2026-11-28 (not staging-ship, which stays held as Caretook's staging flow).

### RISA-1054 · bug · CI's docs:headings check passes vacuously: actions/checkout is shallow and fetches no tags, so loops/docs-headings.mjs finds no v* tag; fetch tags (fetch-depth: 0 or a tag fetch) in .github/workflows/ci.yml so a generic doc's heading change without a CHANGELOG line fails in CI

- status: triaged
- prd: fixes-tooling
- owner:
- commit:

- 2026-11-28 (prd/fixes-bug): Found by fixes-bug slice 9 (RISA-1049), 2026-11-28: the check bites only in a local pnpm check today.

### RISA-1055 · feature · Cross-machine messages through the private inbox repo: a session's message or notice to another machine's project (e.g. a ship notice to Caretook) is written to the inbox repo, that machine's dispatcher hands it to its own backlog session, and peers are found from the home-machine records, not Remote Control, which reaches only sessions on the same claude.ai account

- status: triaged
- prd: cross-machine-messages
- owner:
- commit:

- 2026-11-28 (Robert Bo Davis): From the user 2026-11-28: "The eventual goal is that this machine runs on my business claude account with the personal as backup and the other runs on my personal with the business as backup. In the current flow, this will break inter-machine communication. How are we going to get there?" Chose: a new topic after risa-next-2 (it builds the inbox repo and home claims), with usage-aware-drain (RISA-1002 account swap) after it.
