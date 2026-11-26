#!/usr/bin/env bash
# Free disk: list what can go, with sizes, then free it after a yes.
# (prd reclaim)
#
#   reclaim.sh            list, ask, then free
#   reclaim.sh --list     list only
#   reclaim.sh --yes      free without asking
#
# What it frees:
#   - merged slice worktrees (gc's: the branch is merged into its PRD branch),
#     removed with rm.sh (worktree, stack, test database, branch);
#   - the stack's leftovers (the stackLeftovers hook, --all: here dangling Docker
#     volumes, anonymous ones and those of a stack no worktree has any more, and
#     dangling images), removed through the hook's `leftovers remove`;
#   - check builds (the config's stack.checkBuild) and Vite caches (node_modules/.vite,
#     also two folders down: a workspace package's) in .loops worktrees.
#
# What it never touches: the main checkout; the data of any stack a worktree's
# stack status names (the hook keeps the main checkout's and the shared test
# database's too); a worktree with uncommitted changes (kept, not removed); the
# caches of a worktree whose server is running. Sizes come from du and the
# hook's KB.
set -euo pipefail
# shellcheck source=stack-lib.sh
source "$(dirname "$0")/stack-lib.sh"
bin=$(dirname "$0")

mode=ask
for a in "$@"; do
  case $a in
    --list | -n | --dry-run) mode=list ;;
    --yes | -y) mode=yes ;;
    -h | --help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "reclaim: unknown option $a (--list, --yes)" ;;
  esac
done

# du_kb PATH → its size in KB.
du_kb() { du -sk "$1" 2>/dev/null | awk 'NR == 1 { print $1 + 0 }'; }

# human KB → 340 KB, 12.5 MB, 1.2 GB.
human() {
  awk -v k="$1" 'BEGIN {
    if (k >= 1048576) printf "%.1f GB\n", k / 1048576
    else if (k >= 1024) printf "%.1f MB\n", k / 1024
    else printf "%d KB\n", k
  }'
}

# Each item: kind, target, KB, why. Kept things go in $kept.
kinds=() targets=() sizes=() whys=() kept=""
add() { kinds+=("$1") targets+=("$2") sizes+=("$3") whys+=("$4"); }
keep() { kept+="  $1"$'\n'; }
# A worktree's check build (stack.checkBuild), or none.
check_build=$(config_get stack.checkBuild 2>/dev/null) || check_build=""

# Worktrees: merged ones go whole; the rest give up their caches.
# A failed stack status hook would leave a project out of the ones in use and
# its data looking unused, so it stops reclaim. No stack is project= empty, exit 0.
used_projects=()
for dir in "$loops"/*/; do
  [[ -d $dir ]] || continue
  dir=${dir%/}; name=$(basename "$dir")
  [[ $dir != "$main" ]] || continue
  status=$(stack_hook stackStatus "$dir") ||
    die "reclaim: the stack status hook failed for $name, so its volumes can't be told from unused ones; nothing changed"
  proj=$(fact project "$status")
  [[ -z $proj ]] || used_projects+=("$proj")
  branch=$(git -C "$dir" branch --show-current 2>/dev/null || true)
  dirty=$([[ -n $(git -C "$dir" status --porcelain 2>/dev/null) ]] && echo 1 || true)
  if slice_merged "$dir"; then
    if [[ -n $dirty ]]; then
      keep "$name: merged, but has uncommitted changes (commit or discard them, then ${prd_cmd} reclaim)"
    elif held=$(slice_held "$dir"); then
      keep "$name: merged, but $held"
    else
      add worktree "$name" "$(du_kb "$dir")" "$branch is merged into $(parent_of "$branch")"
      continue
    fi
  fi
  port=$(web_port "$dir")
  if [[ -n $port && -n $(server_pids "$port") ]]; then
    for p in ${check_build:+"$check_build"} node_modules/.vite; do
      if [[ -d $dir/$p ]]; then keep "$name: its server is running, so its caches stay (${prd_cmd} serve $name --stop)"; break; fi
    done
    continue
  fi
  if [[ -n $check_build && -d $dir/$check_build && -z $(git -C "$dir" ls-files "$check_build" 2>/dev/null | head -1) ]]; then
    add build "$dir/$check_build" "$(du_kb "$dir/$check_build")" "$name's check build"
  fi
  for p in "$dir"/node_modules/.vite "$dir"/*/*/node_modules/.vite; do
    if [[ -d $p ]]; then add vite "$p" "$(du_kb "$p")" "$name's Vite cache"; fi
  done
done

# The stack's leftovers: what no stack in use holds (the hook's volume= and
# image= lines: ID KB why), and what it keeps (kept= lines).
left=$(stack_hook stackLeftovers --all ${used_projects[@]+"${used_projects[@]}"}) ||
  die "reclaim: the stack leftovers hook failed, so what's unused can't be told; nothing changed"
while IFS= read -r line; do
  case $line in
    volume=* | image=*)
      rest=${line#*=} id=${rest%% *} rest=${rest#* } kb=${rest%% *}
      add "${line%%=*}" "$id" "$kb" "${rest#* }" ;;
    kept=*) keep "${line#kept=}" ;;
  esac
done <<<"$left"

disk_line
echo
total=0
if ((${#kinds[@]} == 0)); then
  echo "Nothing to reclaim."
else
  echo "Can be freed:"
  for i in "${!kinds[@]}"; do
    t=${targets[$i]}; t=${t#"$loops/"}
    printf '  %-9s %-10s %s (%s)\n' "${kinds[$i]}" "$(human "${sizes[$i]}")" "$t" "${whys[$i]}"
    total=$((total + sizes[i]))
  done
  echo "  total     $(human "$total") in ${#kinds[@]} item(s)"
fi
[[ -z $kept ]] || printf '\nKept:\n%s' "$kept"
((${#kinds[@]})) || exit 0
[[ $mode == list ]] && exit 0
if [[ $mode == ask ]]; then
  echo
  read -r -p "Free these ${#kinds[@]}? [y/N] " answer || answer=""
  [[ $answer =~ ^[Yy] ]] || { echo "Nothing changed."; exit 0; }
fi

freed=0 failed=0
for i in "${!kinds[@]}"; do
  t=${targets[$i]} ok=1
  case ${kinds[$i]} in
    worktree) "$bin/rm.sh" "$t" || ok="" ;;
    volume | image) stack_hook stackLeftovers remove "${kinds[$i]}" "$t" >/dev/null || ok="" ;;
    build) rm -rf "$t" && rm -f "${t%/"$check_build"}/.serve-built" || ok="" ;;
    vite) rm -rf "$t" || ok="" ;;
  esac
  if [[ -n $ok ]]; then
    freed=$((freed + sizes[i]))
  else
    echo "couldn't free ${kinds[$i]} ${t#"$loops/"} (see above)" >&2; failed=$((failed + 1))
  fi
done
echo
echo "Freed $(human "$freed")$( ((failed)) && echo "; $failed item(s) not freed")."
disk_line
((failed == 0))
