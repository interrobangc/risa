#!/usr/bin/env bash
# The backlog's config, shared by bin/risa (`risa backlog …`) and lib.sh's
# backlog_run, so a loop script's backlog call reads the file `risa backlog` would.
# Source it; don't run it.
#
# backlog_config ROOT → exports RISA_CONFIG as the main checkout's risa.json, never
# a worktree's (the backlog is the main checkout's), when the machine config lists
# the repo the current directory is in, and RISA_CONFIG is unset or the found mark
# (RISA_CONFIG_FOUND, lib.sh's find_repo); any other RISA_CONFIG is a pin and stays.
# ROOT is the tool's folder (machine.mjs is under its loops/). Unlisted, or no
# machine config: RISA_CONFIG is left as it is. Returns 2 on a machine config that
# doesn't load (machine.mjs prints why).
backlog_config() {
  local machine=${RISA_MACHINE_CONFIG-$HOME/.risa/machine.json} listed rc=0
  if [[ -z ${RISA_CONFIG:-} || ${RISA_CONFIG} == "${RISA_CONFIG_FOUND:-}" ]] && [[ -n $machine && -f $machine ]]; then
    listed=$(node "$1/loops/machine.mjs" repo --cwd "$PWD") || rc=$?
    case $rc in
      0) RISA_CONFIG=$(sed -n 1p <<< "$listed")/risa.json && export RISA_CONFIG ;;
      1) ;;
      *) return 2 ;;
    esac
  fi
}
