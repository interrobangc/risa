# Standing preferences

What the user has decided about how work runs here, carried over from Caretook with B-543 (2026-11-27). A skeptic briefs from the never list below.

## Planning and slices

- **A PRD stays small** (about six slices): cut a bigger one into follow-on topics rather than ask. (orchestration-2, 2026-11-21)
- **Small fixes land by category**, never mixed; the order between categories is the user's and isn't set yet. (orchestration-2, 2026-11-21)
- **A question must reach the user's phone** (a PushNotification from the asking session); a desktop notification isn't enough. (orchestration-2, 2026-11-21)
- **Only questions are pushed, and only through the ask system:** the one PushNotification a session sends is the line `risa ask --question` prints. Reports (planned, landed, tidy), progress and failures are filed as asks and never pushed. (the user, 2026-11-21)
- **Default on silence:** a recommended question, a planner's included, takes its recommendation after 30 minutes unless answered (`--defaults`). Never (`--waits`): money (a paid service too), data loss or a change to existing data, a live deploy (staging or production), a destructive step (deleting unmerged work, a forced push), a new dependency (the user's approval), compliance; and when unsure. (agent-autonomy, 2026-11-22)
- **A skeptic's go is enough for a risky landing:** `land --force` and `--no-review` go ahead on a fresh Fable skeptic's go without asking; its verdict is in the landing report for a veto after. It never decides the never list. (agent-autonomy-3, 2026-11-22)
- **Unattended runs never spend extra usage:** they stop at the plan's 5-hour or weekly limit and wait for the reset. (self-recovery, 2026-11-22)
- **Unattended runs:** a dispatcher starts everything in the PRD table's row order, and a green wave lands in `main` before the user tries it. (orchestration-2, 2026-11-21)
- **No hold after planning:** a topic the dispatcher planned may start at once, before the user reads its assumed decisions; `hold` and row order are the brakes. (orchestration-3, 2026-11-21)
