#!/usr/bin/env bash
# Stop everything before a planned restart, and record what was running so
# `pnpm prd recover` brings back exactly that. (pnpm prd down)
#
#   down.sh   1. write the down record (.loops/.down.json: the stacks and dev
#                servers that are up, whether the shared test Postgres is, and
#                whether the dispatcher runs), first, so a down cut off halfway
#                still recovers
#             2. stop the dispatcher (dispatch.mjs --stop), so it opens nothing
#                while the rest goes down; recover reopens it in a tab
#             3. stop every dev server (the serve hook: serve N --stop)
#             4. stop each stack (the stackStop hook: its data stays)
#             5. stop the shared test database (the testDb hook: down; the
#                integration tests' setup brings it back)
#
# A record already there is merged, not replaced, so running down twice never
# forgets what the first one stopped. recover deletes the record once used.
#
#   down.sh --stay [<why>]   the same, after first writing the stay-down mark
#                (.loops/.stay-down.json: when, why), so nothing brings the
#                machine back by itself: the watchdog and recover --unattended
#                leave it down, through reboots, until a recover by hand (which
#                deletes the mark)
set -euo pipefail
# shellcheck source=stack-lib.sh
source "$(dirname "$0")/stack-lib.sh"
bin=$(dirname "$0")

stay=0 why=""
while (($#)); do
  case $1 in
    --stay) stay=1; [[ ${2:-} == "" || ${2:-} == -* ]] || { why=$2; shift; } ;;
    -h | --help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "down: unknown option $1 (--stay [<why>])" ;;
  esac
  shift
done

record=$loops/.down.json
mkdir -p "$loops"
if ((stay)); then
  node -e 'const [f, why] = process.argv.slice(1); const fs = require("node:fs");
    fs.writeFileSync(f + ".tmp", JSON.stringify({ at: new Date().toISOString(), why: why || "pnpm prd down --stay" }, null, 2) + "\n");
    fs.renameSync(f + ".tmp", f);' "$loops/.stay-down.json" "$why"
  echo "Stay-down: nothing comes back by itself (the watchdog leaves it) until pnpm prd recover by hand."
fi
inv=$(node "$bin/inventory-facts.mjs" --main "$main" --json)
up=$(node "$bin/recover-lib.mjs" record "$record" <<<"$inv")
echo "Recorded what's up in $record (pnpm prd recover brings it back)."

servers=() stacks=() testdb=0 dispatcher=""
while IFS=$'\t' read -r kind name; do
  case $kind in
    server) servers+=("$name") ;;
    stack) stacks+=("$name") ;;
    test-db) testdb=1 ;;
    dispatcher) dispatcher=${name:-?} ;;
  esac
done <<<"$up"

failed=0
if [[ -n $dispatcher ]]; then
  if out=$(node "$bin/dispatch.mjs" --stop </dev/null 2>&1) && [[ $out == Stopped* || $out == "No dispatcher"* ]]; then
    echo "  stopped the dispatcher (pid $dispatcher)"
  else echo "  couldn't stop the dispatcher (pid $dispatcher): $out" >&2; failed=1; fi
fi
for n in ${servers[@]+"${servers[@]}"}; do
  if stack_hook serve "$n" --stop </dev/null >/dev/null; then echo "  stopped dev server $n"
  else echo "  couldn't stop dev server $n" >&2; failed=1; fi
done
for n in ${stacks[@]+"${stacks[@]}"}; do
  # The hook stops only the worktree's own stack: no facts means it has none.
  if facts=$(stack_hook stackStop "$loops/$n" </dev/null 2>/dev/null); then
    proj=$(fact project "$facts")
    if [[ -n $proj ]]; then echo "  stopped stack $n ($proj, data kept)"
    else echo "  $n: no stack project, skipped" >&2; fi
  else echo "  couldn't stop stack $n" >&2; failed=1; fi
done
if ((testdb)); then
  if stack_hook testDb down </dev/null >/dev/null 2>&1; then echo "  stopped the shared test Postgres"
  else echo "  couldn't stop the shared test Postgres" >&2; failed=1; fi
fi
((${#servers[@]} + ${#stacks[@]} + testdb)) || [[ -n $dispatcher ]] || echo "  nothing was running"
((failed == 0)) || die "down: some things didn't stop (above); the record still lists them"
if ((stay)); then echo "Down, and staying down. To bring it back: pnpm prd recover"
else echo "Down. After the restart: pnpm prd recover"; fi
