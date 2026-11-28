#!/usr/bin/env bash
# The backlog's config, shared by bin/risa (`risa backlog …`) and lib.sh's
# backlog_run, so a loop script's backlog call reads the file `risa backlog` would.
# Source it; don't run it.
#
# backlog_config ROOT → exports RISA_CONFIG as the main checkout's config (config.mjs
# where: .risa/config.json or risa.json), never a worktree's (the backlog is the main
# checkout's), when the machine config lists the repo the current directory is in,
# and RISA_CONFIG is unset or the found mark
# (RISA_CONFIG_FOUND, lib.sh's find_repo); any other RISA_CONFIG is a pin and stays.
# ROOT is the tool's folder (machine.mjs is under its loops/). Unlisted, or no
# machine config: RISA_CONFIG is left as it is. Returns 2 on a machine config that
# doesn't load (machine.mjs prints why), or a main checkout with no config or both
# forms (config.mjs where's exit 1 or 2).
backlog_config() {
  local machine=${RISA_MACHINE_CONFIG-$HOME/.risa/machine.json} listed found rc=0
  if [[ -z ${RISA_CONFIG:-} || ${RISA_CONFIG} == "${RISA_CONFIG_FOUND:-}" ]] && [[ -n $machine && -f $machine ]]; then
    listed=$(node "$1/loops/machine.mjs" repo --cwd "$PWD") || rc=$?
    case $rc in
      0)
        found=$(node "$1/loops/config.mjs" where "$(sed -n 1p <<< "$listed")") || rc=$?
        # 2: both forms (config.mjs printed the line); 1: none.
        ((rc != 1)) || echo "risa: no project config in $(sed -n 1p <<< "$listed")" >&2
        ((rc == 0)) || return 2
        export RISA_CONFIG=$found
        ;;
      1) ;;
      *) return 2 ;;
    esac
  fi
}
