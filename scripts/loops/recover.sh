#!/usr/bin/env bash
# Bring the PRD machinery back after a restart, a crash or a usage limit.
# (pnpm prd recover)
#
#   recover.sh --dry-run          the inventory (every .loops worktree's class and
#                                 why, stale and live locks, Docker, the shared
#                                 test Postgres, disk, the down record) and the
#                                 actions recovery would take, in order; changes
#                                 nothing
#   recover.sh --dry-run --json   the same as JSON (for the recovery agent)
#
# inventory.mjs decides the classes and actions; inventory-facts.mjs collects
# the facts (read-only: git, docker info|ps|inspect, lsof, df).
#
# Running the actions (no --dry-run) isn't built yet: it comes with the next
# slice of the loop-recovery plan, which adds its steps to run_actions below.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
bin=$(dirname "$0")

dry=0 format=--text
for a in "$@"; do
  case $a in
    --dry-run | -n) dry=1 ;;
    --json) format=--json ;;
    --facts) format=--facts ;;
    *) die "recover: unknown option $a (--dry-run, --json)" ;;
  esac
done

inventory() { node "$bin/inventory-facts.mjs" --main "$main" "$@"; }

# run_actions → carry out the inventory's actions in order (not built yet).
run_actions() {
  die "recover: only --dry-run works so far (pnpm prd recover --dry-run); running the actions comes next"
}

if ((dry)); then
  inventory "$format"
  [[ $format == --text ]] && printf '\nDry run: nothing was changed.\n'
  exit 0
fi
run_actions
