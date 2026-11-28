# Changelog

Each release's changes a project may need to act on. A change to a generic role doc's `##` headings or its last section (`loops/docs/*.md`; a project's additions name them) gets a line here naming the doc and the heading, or `pnpm check` fails (`loops/docs-headings.mjs`).

## Unreleased

- New `##` sections others already pointed at: `machinery.md` gains _The dispatcher_, _The load gate_ and _Recorded sessions_; `orchestrator.md` gains _Rules across PRDs_ and _The check gate_ (RISA-1051).
- Role additions can target a section: an additions `## <Heading>` that names one of the generic doc's `##` headings ends that section instead of following the doc; the rest still follow it (`project-config.md`, RISA-1049).
