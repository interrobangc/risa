# Inbox

Add anything here: one line per item, under the heading that fits. Indent extra lines under it for details. Save; that's all.

Agents file each new line into the tracker ([backlog.md](backlog.md)) and add its id, like `(RISA-12)`. To change something already filed, add a new line saying so.

## Bugs/Nits

- Fixes orchestrators keep waiting for new work when they run out (RISA-982)
  They need to clean themselves up so they stop taking a queue spot.

## Change requests

- Inbox per project, not per machine (RISA-983)
  Probably move planning (backlog, PRDs, plans, etc.) to gists, GitHub issues or some other mechanism so the same project can be worked on across machines safely, avoiding the git sync problems we keep hitting.
- Tell backlog agents they can communicate with each other (RISA-984)
  Example: caretook's backlog agent can file issues with risa's, and risa's can ask caretook's backlog to update risa after a fix is deployed.

## Features

- A "replan" state on a PRD registry row: the dispatcher sends that topic back to its planner (before it runs or between waves) to replan the whole PRD
