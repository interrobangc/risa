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
#             3. stop every dev server (serve.sh --stop)
#             4. stop each stack (docker compose stop: its data stays)
#             5. stop the shared test Postgres (test-db.sh down; its data is a
#                tmpfs, and the integration globalSetup recreates it)
#
# A record already there is merged, not replaced, so running down twice never
# forgets what the first one stopped. recover deletes the record once used.
set -euo pipefail
# shellcheck source=stack-lib.sh
source "$(dirname "$0")/stack-lib.sh"
bin=$(dirname "$0")

for a in "$@"; do
  case $a in
    -h | --help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "down: unknown option $a (it takes none)" ;;
  esac
done

record=$loops/.down.json
mkdir -p "$loops"
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
  if "$bin/serve.sh" "$n" --stop </dev/null >/dev/null; then echo "  stopped dev server $n"
  else echo "  couldn't stop dev server $n" >&2; failed=1; fi
done
for n in ${stacks[@]+"${stacks[@]}"}; do
  dir=$loops/$n proj=$(stack_project "$loops/$n")
  # Never fall back to Compose's default project: that's the main checkout's.
  [[ $proj == caretook-loop* ]] || { echo "  $n: no stack project, skipped" >&2; continue; }
  if (cd "$dir" && docker compose stop) </dev/null >/dev/null 2>&1; then echo "  stopped stack $n ($proj, data kept)"
  else echo "  couldn't stop stack $n ($proj)" >&2; failed=1; fi
done
if ((testdb)); then
  if "$bin/test-db.sh" down </dev/null >/dev/null 2>&1; then echo "  stopped the shared test Postgres"
  else echo "  couldn't stop the shared test Postgres" >&2; failed=1; fi
fi
((${#servers[@]} + ${#stacks[@]} + testdb)) || [[ -n $dispatcher ]] || echo "  nothing was running"
((failed == 0)) || die "down: some things didn't stop (above); the record still lists them"
echo "Down. After the restart: pnpm prd recover"
