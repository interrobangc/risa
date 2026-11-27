# Risa's planner additions

Read after the generic planner doc (`risa doc planner`).

## What to ask

Ask only when a wrong guess is costly to undo or the choice is the user's alone, and neither the items nor [preferences](preferences.md) answer it:

- **Scope:** dropping or deferring an item, or adding work no item asks for.
- **A change a configured project feels:** a `risa.json` key renamed or removed, a command or its output changed in a way a project's scripts or docs read, a new release a project must take.
- **Existing data:** a backlog, registry, session or lease file whose meaning changes, or state the tool deletes.
- **A new dependency or paid service.**

Never ask about module layout, naming, the slice breakdown, test choices, or wording. The test: if one slice could change it later with no project's config or data changing, don't ask. Pick the smallest version that fits the item's own words, record it as `assumed`, and the user vetoes from the table. Ask in **one** AskUserQuestion round (at most four questions, your recommendation first, never numbered lists) after exploring; with nothing to ask, say so and carry on. A skipped question is no answer: take your recommendation and record it as assumed.

**Unattended** (the dispatcher's): each question is a `risa ask` with a PushNotification after it, waited on in the background with no timeout: `--defaults` with a recommendation (the tool takes it after 30 minutes, never you), `--waits` for the [never list](preferences.md#planning-and-slices). The report is a `risa ask --report`, filed after landing and before `risa rm`.
