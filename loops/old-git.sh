#!/bin/sh
# An old git (git-init.mjs's withOldGit puts it first on PATH, as `git`): records
# each call's arguments in $RISA_OLD_GIT_LOG, rejects `init -b` as git 2.24 does
# (exit 129), and succeeds at anything else.
printf '%s\n' "$*" >>"$RISA_OLD_GIT_LOG"
if [ "$1" = init ]; then
  for a in "$@"; do
    if [ "$a" = -b ]; then
      echo "error: unknown switch \`b'" >&2
      exit 129
    fi
  done
fi
exit 0
