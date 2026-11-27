#!/usr/bin/env bash
# The sample project's check-areas hook, for the core's tests: `resolve --root R
# --areas DIR …`, the changed files on stdin, "<file><TAB><checks>" for each. The
# rules are DIR/rules, "<glob> <checks…>" a line, the first match wins; a file
# no rule matches gets "UNMAPPED specpass".
set -uo pipefail
[[ ${1:-} == resolve ]] || { echo "check-areas.sh: resolve" >&2; exit 2; }
shift
areas=""
while (($#)); do
  case $1 in
    --areas) areas=$2; shift 2 ;;
    --root | --base | --head) shift 2 ;;
    *) shift ;;
  esac
done
while IFS= read -r f; do
  [[ -n $f ]] || continue
  answer="UNMAPPED specpass"
  while read -r glob checks; do
    [[ -z $glob || $glob == "#"* ]] && continue
    # shellcheck disable=SC2053
    [[ $f == $glob ]] && { answer=$checks; break; }
  done < "$areas/rules"
  printf '%s\t%s\n' "$f" "$answer"
done
