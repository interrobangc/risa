# Ship

`{{prd}} ship <version>` runs a project's four phases in order, each a hook: the tool owns the order, the record and the report, the project the steps.

- **Only the user's word starts a ship:** not the dispatcher, an orchestrator or a loop.
- **Phases:** `check` (`hooks.shipCheck`), `ship` (`hooks.ship`, required), `smoke` (`hooks.shipSmoke`), `notify` (`hooks.shipNotify`); a missing optional one is `skipped`.
- **Hooks** get the version as argument and `RISA_SHIP_VERSION`; exit 0 passes; `key=value` output lines are facts.
- **The record:** `.loops/.ships/<version>.json` in the main checkout, written per phase; one ship of a project at a time. A rerun resumes at the first phase not passed; `--from <phase>` reruns it and the later ones (the earlier passed), on a finished ship too.
- **`--dry-run`** runs `check` alone: no record or report.
- **The report**, in the asks (topic `ship`) when it ships or fails: facts, skips, a failure's last lines, how to resume.
- Exit 0 shipped, 1 failed, 2 refused.
