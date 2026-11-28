# PRD: risa-next-4

Items RISA-796 (the project config as a folder; the test rules and gates tidied into it) and RISA-797's first half (prove Risa on a second repo, with tests). Topic `risa-next-4`. Plan: [`plans/risa-next-4-plan.md`](risa-next-4-plan.md).

RISA-797's second half (usable by others: install, outsider docs, versioning, hosts other than macOS and iTerm2) is cut into the follow-on topic `risa-next-5` (RISA-1017), so this PRD stays at six slices that each land something usable.

## Decisions

| Decision                                                                                                                                                                                                                                                                                                                                                                                                                                       | Why                                                                                                                                                         | Source                                  | Cost to change later                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------- |
| The second repo is a fictional one the tests build: `risa init` scaffolds a config into any repo, and an end-to-end test runs init through landing on a fresh non-Node repo, offline. A real repo of the user's is onboarded with `risa init` outside this topic                                                                                                                                                                               | the item says "with tests"; AGENTS.md: all test data is fictional; which real repo is the user's call                                                       | asked (a25): see _Notes_ for the answer | low: a follow-on onboards a real repo with the same command                         |
| The folder form is **additive**: a repo's config is `.risa/config.json` when that folder has one, else `risa.json` as today; both present is an error. No project has to move, and no key is renamed or removed                                                                                                                                                                                                                                | Caretook runs Risa from release installs and names its data files by `paths.*` keys; a forced move would be a release every project must take at once       | assumed                                 | medium: dropping `risa.json` later is a breaking release (`!`), a decision for then |
| Nothing moves in this topic: Risa's own repo and Caretook keep `risa.json` until someone runs `risa config migrate` there, after a release that reads the folder is installed on every machine that runs that project                                                                                                                                                                                                                          | fixes-tooling's lesson: "a change to Risa's own risa.json needs the release that reads it installed first"; moving a project's files is that project's call | assumed                                 | low: one command, one commit, per project                                           |
| The test rules and gates move by default name, not by key: in the folder form, an unset `paths.tierData`, `paths.checkPlanRules`, `paths.brakeList` or `paths.quarantine` is `.risa/tiers.json`, `.risa/check-plan.json`, `.risa/brake-list.txt` or `.risa/quarantine.txt` when that file exists. A set key still wins. The loader fills them in, so every reader (CI, the check plan, the backlog's quarantine commit, `lib.sh`) is unchanged | one place knows the names; a project's own CI that reads the files by path keeps working                                                                    | assumed                                 | low: four names in one module                                                       |
| `risa config migrate` moves the config and those four files into the folder (`git mv`, staged, never committed), drops the four keys it replaced, and turns a `risa.json` entry in `paths.tooling` into `.risa`; it refuses with the files dirty or the folder present, and `--dry-run` prints the moves                                                                                                                                       | a project moves in one reviewed commit of its own; nothing is committed for it (AGENTS.md: commit only on the user's word)                                  | assumed                                 | low                                                                                 |
| `risa init` writes `.risa/config.json` (from `--name`, `--trunk`, `--check`; Risa's defaults for the rest), an empty backlog with its PRDs heading, inbox, archive and plans folder; refuses when a config exists; then prints the next steps (the machine config line, the commit). It runs without a config, so it is routed before anything loads one                                                                                       | the smallest onboarding a second repo needs; flags, not prompts, so a test and an agent can run it                                                          | assumed                                 | low                                                                                 |
| `init` and `config` are two new top-level commands; no existing command or output changes                                                                                                                                                                                                                                                                                                                                                      | a project's scripts read nothing new                                                                                                                        | assumed                                 | low                                                                                 |
| The folder is `.risa/` at the repo's root, its config file `config.json`                                                                                                                                                                                                                                                                                                                                                                       | beside `.github/`-style folders; one name in `config.mjs`                                                                                                   | assumed                                 | low: one constant                                                                   |
| RISA-797's release half becomes its own item in `risa-next-5`, after this topic                                                                                                                                                                                                                                                                                                                                                                | a PRD stays small (preferences)                                                                                                                             | preference                              | low: a row                                                                          |

**What the skeptic changed:** the first (s17) sent the plan back: `fixes-bug` is running and holds `bin/risa`, `loops/rm.sh` and `loops/lib.sh`, which the plan had missed, so the callers slice spanned two running topics. The callers are now two slices (Node's, bash's), `migrate` and `init` share one slice to stay at six, and _How to run this plan_ names both holds. The second (s18, go) fixed slice 6's landing step to the land seam's real stopping point with a stub `gh` that knows other trunks and prefixes, had `init` list `.risa` in `paths.tooling`, and asked for the cut half's item and row to be filed at planning, not later (done: see _Notes_). Declined: nothing. Both noted that `risa doc orchestrator "Rules across PRDs"` has no such section, a doc gap outside this topic.

**Asked:** one question (a25, which repo is the second one), filed after a fresh skeptic said it is the user's. Nothing else: no key is renamed or removed, no existing file changes meaning, no data moves, no dependency.

## Problem

A project tells Risa about itself in one `risa.json` at its root, and its test rules and gates (the CI tier data, the check plan's rules, the brake list, the quarantine) are files scattered wherever each project put them, named by keys. Starting a new project means copying another project's config by hand and guessing which keys are required, and nothing shows Risa works start to finish on a repo that isn't Risa or Caretook: the sample project's tests check pieces, never the whole path from a new repo to a landing.

## Solution

A project may keep everything Risa reads in one folder, `.risa/`: its config and its test rules and gates under fixed names, so a project's Risa files sit together and need no path keys. `risa.json` keeps working. One command moves an existing project into the folder when it chooses; another starts a new project with a working config. An end-to-end test proves the whole path on a fresh fictional repo built on a different toolchain.

## User stories

1. As a project's maintainer, I want my Risa config and test rules in one folder, so that they are found and reviewed together (RISA-796).
2. As a project's maintainer, I want my existing `risa.json` to keep working, so that a new release never forces a move on me (RISA-796).
3. As a project's maintainer, I want the tier data, check-plan rules, brake list and quarantine found in the folder by name, so that I set no path key for them (RISA-796).
4. As a project's maintainer, I want one command that moves my config and test rules into the folder, so that the move is one reviewed commit (RISA-796).
5. As someone starting a new project, I want `risa init` to write a config that passes Risa's checks, so that I start from something that works (RISA-797).
6. As the user, I want a test that runs a fresh, non-Node repo from init through a landing, so that I know Risa works beyond its first two repos (RISA-797).
7. As an agent in a worktree, I want the worktree's own config found in either form, so that a branch's config change shows there as it does today (RISA-796).

## Implementation decisions

### The config's place

- The loader module stays the only code that knows where the config lives. It gains one function, "the config file in this checkout": `.risa/config.json` when present, else `risa.json`, else none; both present is a load error naming both. A CLI verb prints it for bash (`where [dir]`).
- `RISA_CONFIG` may name the file (as now) or the `.risa` folder. The loaded result's `root` is the repo's root in both forms (the folder's parent for the folder form), so every reader joining paths to `root` is unchanged.
- Every place that builds `<checkout>/risa.json` today asks that function instead: the machine config's checkout choice (worktree's own, else the main checkout's), the backlog route in `bin/risa`, `rm.sh`'s re-point to the main checkout, the skeptic's rules reader, the project-data check's default path, and the sample project's repo builder (which gains a folder-form option).

### The test rules and gates

- After validation, a folder-form load fills each unset key of the four from its default name when the file exists under `.risa/`. Filled values are ordinary `paths.*` values in the loaded config and in `dump`, so CI, the check plan, the backlog's quarantine commit and `lib.sh`'s CI lists read them with no change. The `risa.json` form gets no defaults.

### Migrate

- A new module with a CLI (`risa config migrate [--dry-run]`), run in the main checkout: refuses outside a repo, with the folder present, with no `risa.json`, or with any file it moves dirty. It `git mv`s `risa.json` to `.risa/config.json` and each of the four data files named by a key (when the file exists) to its default name, removes those keys, replaces a `risa.json` entry in `paths.tooling` with `.risa`, writes the JSON with two-space indent and a final newline, and stages it. It prints one line per move and the commit to make. The result loads and passes `config check`.

### Init

- A new module with a CLI (`risa init --name <slug> [--trunk <branch>] [--check <command>]`), routed in `bin/risa` before any config is loaded. It writes a folder-form config that passes the loader (Risa's own defaults for tool names, paths under `plans/`, branch prefixes, id prefix from the name, no-op commands where a project has none), the backlog file with the PRDs heading and an empty table, the inbox, the archive and the plans folder (and `.risa` in `paths.tooling`, as migrate gives), skipping none silently (an existing file stops it). It refuses when either config form exists. It prints the machine config line to add and the commit to make; it commits nothing.

### The proof

- One end-to-end test builds a fresh fictional repo with `make` as its toolchain, another trunk name and other prefixes, runs `risa init` with flags, then `config check`, the project-data check, `risa backlog add`, `risa backlog prd add`, a slice worktree, `risa check` with the project's own check, and a landing through the land fixture's throwaway seam (stub `gh` and claude, no network). A second case migrates an old-form copy of the same repo and runs the same check.

## Testing decisions

- **The loader, unit:** both forms, both present, neither, `RISA_CONFIG` as file and as folder, `root` in each form, the `where` verb; the four defaults filled only in the folder form, only when the file exists, never over a set key (prior art: `loops/config.test.mjs`).
- **The callers, integration in temp repos:** a folder-form sample repo (the sample project's builder) where the machine config, `bin/risa backlog`, `rm.sh`'s re-point and the project-data check find the folder's config, from the main checkout and a worktree.
- **Migrate and init, integration in temp repos:** the moves, the keys dropped, refusals, `--dry-run` changing nothing, the result passing `config check`.
- **The proof:** one test file on the land fixture's prior art (`loops/land-fixture.mjs`: a bare origin, stubbed `gh`, the throwaway seam).
- No browser, no stack, no network; never this checkout's own config.

## Out of scope

- Moving Risa's own repo or Caretook to the folder (each runs `risa config migrate` after the release; see _Notes_).
- Removing `risa.json` support, or renaming any key.
- Splitting the config itself into several files.
- The release for others (`risa-next-5`): installing without a Risa checkout, outsider docs, enforcing `risaVersion`, hosts other than macOS and iTerm2.
- RISA-968 (time gates' limits from the config): unassigned on the user's word until better understood.

## Notes

- After this topic lands and a release is cut, the backlog session can offer `risa config migrate` to each project (Risa first), once every machine running it has that release.
- RISA-797 stays with this topic for its proof; its release half is RISA-1017, in the new row `risa-next-5` (after this topic).
- The answer to a25 is recorded in the _Decisions_ table's first row when it comes.
