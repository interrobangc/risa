# Rules for every fix slice

For Risa's fix topics (`fixes-tooling`, `fixes-bug`). Each fix slice's `Reads` field names this file. Carried over from Caretook's with B-543 (2026-11-27), without its screen and browser-check rules.

## Shape

- **One slice and one backlog item per fix.** The orchestrator appends a slice per waiting item at a wave boundary (the next number: `risa status-trim <topic> --next`, which counts the plan and its history), and claims the item before it runs.
- **Split a big item.** A fix likely to touch more than 12 files becomes two or more slices, each its own item.
- **Hot files.** A fix that would touch a running topic's hot files (`risa backlog prd list`) waits for a later wave. Once a wave's slices are written, the orchestrator sets its row's hot files to the path prefixes they will touch (`risa backlog prd set fixes-tooling hot=<prefixes>`); removing the topic's worktree clears them.
- **Fields line** under each slice heading: `Stack: no · Reads: <docs> · Tests: unit`. Risa has no stack; `Reads` names this file and the role docs the fix touches. No `Model:` field until the installed release reads it (v0.1.8 calls it unknown and drops Reads and Check); the plan's _Status_ table carries each slice's model.

## Tests

- A fix gets a test beside the module it changes (`*.test.mjs`), on the sample or fixture project or a throwaway git repo in the OS temp dir, never this checkout's own config or files.
- Acceptance criteria name the tests ("unit test: …").

## Checks

- **Before hand-off:** `risa check --quick "slice hand-off"`. Never the browser harness unless the fix touches the browser gate (`pnpm test:browser-harness`).
- **At landing:** `pnpm check` once on the merged tip. No checks between merges; never rerun a check that passed.
