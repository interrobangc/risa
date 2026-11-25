#!/usr/bin/env bash
# Free disk: list what can go, with sizes, then free it after a yes.
# (pnpm prd reclaim)
#
#   reclaim.sh            list, ask, then free
#   reclaim.sh --list     list only
#   reclaim.sh --yes      free without asking
#
# What it frees:
#   - merged slice worktrees (gc's: the branch is merged into its PRD branch),
#     removed with rm.sh (worktree, stack, test database, branch);
#   - dangling Docker volumes: anonymous ones, and those of a caretook-loopN
#     project no worktree names any more;
#   - dangling Docker images;
#   - check builds (apps/web/build) and Vite caches (node_modules/.vite, also
#     under apps/* and packages/*) in .loops worktrees.
#
# What it never touches: the main checkout; a volume of the main checkout's
# project, the shared test Postgres or any project a worktree's .env names; any
# other Compose project's volumes; a worktree with uncommitted changes (kept,
# not removed); the caches of a worktree whose server is running. Sizes come
# from du and `docker system df -v` (Docker's are decimal units).
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

# docker_kb SIZE → Docker's size (21.03kB, 1.127MB, 2GB, 0B) in KB.
docker_kb() {
  awk -v s="$1" 'BEGIN {
    n = s + 0; u = s; sub(/^[0-9.]+/, "", u); u = toupper(u)
    m = (u == "KB") ? 1 : (u == "MB") ? 1000 : (u == "GB") ? 1000000 : (u == "TB") ? 1000000000 : 0.001
    printf "%d\n", n * m
  }'
}

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

# Worktrees: merged ones go whole; the rest give up their caches.
# A failed stack or test-db hook would leave a project out of used_projects and
# its volumes looking unused, so either stops reclaim (stack-lib.sh's values
# tolerate one; here it must be loud). No stack is project= empty, exit 0.
[[ -n $shared_test_project ]] ||
  die "reclaim: the test-db hook gave no project (testDb facts failed?), so the volumes in use can't be told; nothing changed"
used_projects=" $shared_test_project caretook "
for dir in "$loops"/*/; do
  [[ -d $dir ]] || continue
  dir=${dir%/}; name=$(basename "$dir")
  [[ $dir != "$main" ]] || continue
  status=$(stack_hook stackStatus "$dir") ||
    die "reclaim: the stack status hook failed for $name, so its volumes can't be told from unused ones; nothing changed"
  proj=$(fact project "$status")
  [[ -z $proj ]] || used_projects+="$proj $proj-test "
  branch=$(git -C "$dir" branch --show-current 2>/dev/null || true)
  dirty=$([[ -n $(git -C "$dir" status --porcelain 2>/dev/null) ]] && echo 1 || true)
  if slice_merged "$dir"; then
    if [[ -n $dirty ]]; then
      keep "$name: merged, but has uncommitted changes (commit or discard them, then pnpm prd reclaim)"
    elif held=$(slice_held "$dir"); then
      keep "$name: merged, but $held"
    else
      add worktree "$name" "$(du_kb "$dir")" "$branch is merged into $(parent_of "$branch")"
      continue
    fi
  fi
  port=$(web_port "$dir")
  if [[ -n $port && -n $(server_pids "$port") ]]; then
    for p in apps/web/build node_modules/.vite; do
      if [[ -d $dir/$p ]]; then keep "$name: its server is running, so its caches stay (pnpm prd serve $name --stop)"; break; fi
    done
    continue
  fi
  if [[ -d $dir/apps/web/build && -z $(git -C "$dir" ls-files apps/web/build 2>/dev/null | head -1) ]]; then
    add build "$dir/apps/web/build" "$(du_kb "$dir/apps/web/build")" "$name's check build"
  fi
  for p in "$dir"/node_modules/.vite "$dir"/apps/*/node_modules/.vite "$dir"/packages/*/node_modules/.vite; do
    if [[ -d $p ]]; then add vite "$p" "$(du_kb "$p")" "$name's Vite cache"; fi
  done
done

# Docker: dangling volumes (no container links them) and images.
if docker info >/dev/null 2>&1; then
  others=0
  while read -r vname vsize links labels; do
    [[ -n $vname && $links == 0 ]] || continue
    vproj=$(tr ',' '\n' <<<"${labels:-}" | sed -n 's/^com\.docker\.compose\.project=//p' | head -1)
    if [[ -z $vproj ]]; then
      if [[ ${labels:-} == *com.docker.volume.anonymous* ]]; then
        add volume "$vname" "$(docker_kb "$vsize")" "dangling, anonymous"
      else
        others=$((others + 1))
      fi
    elif [[ $used_projects == *" $vproj "* ]]; then
      keep "volume $vname: $vproj is still in use (the main checkout, the shared test Postgres or a worktree's stack)"
    elif [[ $vproj =~ ^caretook-loop[0-9]+(-test)?$ ]]; then
      add volume "$vname" "$(docker_kb "$vsize")" "dangling; no worktree uses $vproj"
    else
      others=$((others + 1))
    fi
  done < <(docker system df -v --format '{{range .Volumes}}{{.Name}} {{.Size}} {{.Links}} {{.Labels}}{{println}}{{end}}' 2>/dev/null || true)
  ((others == 0)) || keep "$others dangling volume(s) of other Compose projects, or named outside Compose: not caretook's, left alone"
  while read -r id isize; do
    if [[ -n $id ]]; then add image "$id" "$(docker_kb "$isize")" "dangling (untagged)"; fi
  done < <(docker images --filter dangling=true --format '{{.ID}} {{.Size}}' 2>/dev/null || true)
else
  keep "Docker isn't running: volumes and images not checked"
fi

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
    volume) docker volume rm "$t" >/dev/null || ok="" ;;
    image) docker image rm "$t" >/dev/null || ok="" ;;
    build) rm -rf "$t" && rm -f "${t%/apps/web/build}/.serve-built" || ok="" ;;
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
