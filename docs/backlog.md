# Risa's backlog additions

Read after the generic backlog doc (`risa doc backlog`).

## Fix topics

This repo is all tooling, so it files fixes by urgency, not by kind (the user, 2026-11-28). These rules replace the generic `fixes-<cat>` list:

- **`fixes-test`:** a flake, the test harness, a test timing out under load. Ranked apart from other fixes.
- **`fixes-bug-urgent`:** a fix that should run before other work: a broken release or install, a dead or stuck dispatcher, lost or wrong backlog data.
- **`fixes-bug`:** any other fix to wrong behaviour, scripts or checks, at normal urgency.
- **`fixes-bug-later`:** a real fix that can wait: rare, with a workaround, or only in an unusual setup.
- **`fixes-perf`** (speed and load) and **`fixes-nit`** (a small tidy users won't notice) stay as they are.

Never file into `fixes-tooling` here: it is retiring. Caretook keeps its own. When unsure between two urgencies, take the lower one; the user moves items up.
