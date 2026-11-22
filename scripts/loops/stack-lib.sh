#!/usr/bin/env bash
# Stacks and test databases for .loops worktrees, shared by new.sh, stack.sh,
# rm.sh, ls.sh, gc.sh and test-db.sh. Source it; don't run it. (It sources
# lib.sh.)
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# The shared test Postgres (docker-compose.shared-test.yml, test-db.sh).
shared_test_port=${CARETOOK_SHARED_TEST_PORT:-5436}
shared_test_project=${CARETOOK_SHARED_TEST_PROJECT:-caretook-shared-test}

# test_db_name NAME → the worktree's database on the shared test Postgres:
# caretook_test_<name>, anything but a-z0-9 as _, at most 63 characters.
test_db_name() {
  local n
  n=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '_')
  printf 'caretook_test_%s\n' "$n" | cut -c1-63
}

# write_test_env DIR NAME → packages/data/.env.test.local pointing the
# integration tests at NAME's own database on the shared test Postgres. The
# globalSetup creates it on first use and clears and migrates only it.
write_test_env() {
  mkdir -p "$1/packages/data"
  cat > "$1/packages/data/.env.test.local" <<ENV
# Integration tests: this worktree's own database on the shared test Postgres
# (scripts/loops/test-db.sh). Created on first use; dropped by pnpm prd rm.
DATABASE_URL="postgresql://caretook:password@localhost:$shared_test_port/$(test_db_name "$2")"
PG_TEST_PORT=$shared_test_port
SHARED_TEST_DB=1
ENV
}

# lease_free_slot NAME [SLOT] → lease SLOT (or the lowest free one) for NAME and
# set $slot; dies when none is free.
lease_free_slot() {
  local want=${2:-} i
  slot=""
  if [[ -n $want ]]; then
    [[ $want =~ ^[0-9]+$ ]] && ((want >= 1 && want <= 19)) || die "slot must be 1-19"
    slot_busy "$want" && die "slot $want is taken (pnpm prd status)"
    lease_slot "$want" "$1" || die "slot $want was just taken"
    slot=$want
  else
    for i in $(seq 1 19); do
      slot_busy "$i" && continue
      lease_slot "$i" "$1" && { slot=$i; break; }
    done
    [[ -n $slot ]] || die "all 19 slots are taken"
  fi
}

# require_main_env → the main checkout's env files a stack copies secrets from.
require_main_env() {
  local f
  for f in packages/data/.env apps/web/.env; do
    [[ -f $main/$f ]] || die "missing $main/$f (copy its .env.example)"
  done
}

# write_stack_env DIR SLOT BASE → the env files of a stacked worktree: the root
# .env (Compose's project and ports), packages/data/.env, apps/web/.env and
# .env.loop. Secrets come from the main checkout's copies.
write_stack_env() {
  local dir=$1 base=$3
  slot_ports "$2"
  cat > "$dir/.env" <<ENV
CARETOOK_STACK=caretook-loop$2
PG_PORT=$pg
PG_TEST_PORT=$pgt
POWERSYNC_PORT=$ps
POWERSYNC_URL=http://localhost:$ps
PS_JWKS_URL=http://host.docker.internal:$web/api/auth/jwks
ENV
  mkdir -p "$dir/packages/data" "$dir/apps/web"
  sed -E "s#^DATABASE_URL=.*#DATABASE_URL=\"postgresql://caretook:password@localhost:$pg/caretook\"#" \
    "$main/packages/data/.env" > "$dir/packages/data/.env"
  sed -E \
    -e "s#^BETTER_AUTH_URL=.*#BETTER_AUTH_URL=\"http://localhost:$web\"#" \
    -e "s#^AUTH_TRUSTED_ORIGINS=.*#AUTH_TRUSTED_ORIGINS=\"http://localhost:$web\"#" \
    -e "s#^POWERSYNC_URL=.*#POWERSYNC_URL=\"http://localhost:$ps\"#" \
    -e "s#^VITE_POWERSYNC_URL=.*#VITE_POWERSYNC_URL=\"http://localhost:$ps\"#" \
    -e "/^WEB_PORT=/d" \
    -e "/^APP_URL=/d" \
    "$main/apps/web/.env" > "$dir/apps/web/.env"
  # Emailed links point at this worktree's dev server. The mail secrets
  # (CRON_SECRET, INVITE_LINK_KEY, …) come over with the rest of the file.
  printf 'WEB_PORT=%s\nAPP_URL="http://localhost:%s"\n' "$web" "$web" >> "$dir/apps/web/.env"
  # A main checkout without a CRON_SECRET still gives the worktree one (random,
  # local), so /api/cron/outbox can be called there.
  if ! grep -Eq '^CRON_SECRET="?[^"]' "$dir/apps/web/.env"; then
    sed -i.bak '/^CRON_SECRET=/d' "$dir/apps/web/.env" && rm -f "$dir/apps/web/.env.bak"
    printf 'CRON_SECRET="%s"\n' "$(openssl rand -hex 32)" >> "$dir/apps/web/.env"
  fi
  # Contact messages from the marketing site go to SUPPORT_EMAIL (the dev
  # mailbox outside production); the main checkout's value comes over above.
  if ! grep -Eq '^SUPPORT_EMAIL="?[^"]' "$dir/apps/web/.env"; then
    sed -i.bak '/^SUPPORT_EMAIL=/d' "$dir/apps/web/.env" && rm -f "$dir/apps/web/.env.bak"
    printf 'SUPPORT_EMAIL="support@example.com"\n' >> "$dir/apps/web/.env"
  fi
  # For browser checks: `set -a; source .env.loop; set +a`.
  cat > "$dir/.env.loop" <<ENV
SLOT=$2
BASE_BRANCH=$base
BASE=http://localhost:$web
CDP_PORT_OFFSET=$off
PG_CONTAINER=caretook-loop$2-postgres-1
ENV
  grep '^SEED_USER_PASSWORD=' "$dir/packages/data/.env" >> "$dir/.env.loop" || true
}

# write_stackless_env DIR BASE → .env.loop for a worktree without a stack.
write_stackless_env() { printf 'SLOT=\nBASE_BRANCH=%s\n' "$2" > "$1/.env.loop"; }

# stack_project DIR → the worktree's Compose project (caretook-loopN), or nothing.
stack_project() { env_get "$1/.env" CARETOOK_STACK; }

# stack_teardown DIR → stop the worktree's dev server and its Compose projects
# (the stack and, for worktrees made before the shared test Postgres, its own
# test database), and delete their data. Only this worktree's projects.
stack_teardown() {
  local dir=$1 proj
  proj=$(stack_project "$dir")
  # Never fall back to Compose's default project: that's the main checkout's.
  [[ $proj == caretook-loop* ]] || return 0
  stop_server "$dir"
  rm -f "$dir/.dev.log"
  docker compose -p "$proj" down --remove-orphans
  if [[ -n $(docker ps -aq --filter "label=com.docker.compose.project=$proj-test" 2>/dev/null) ]]; then
    docker compose -p "$proj-test" down --remove-orphans
  fi
  # Postgres writes its data as the container user; remove it through a container.
  if [[ -d $dir/.postgres ]]; then
    docker run --rm --network none -v "$dir:/w" postgres:18.7-alpine rm -rf /w/.postgres
  fi
}

# slice_merged DIR → true when the worktree is on slice/<topic>/<n> and its tip
# was merged into prd/<topic> (it's a merge's second parent there), so the
# slice is done. A new slice whose tip is still its base doesn't count.
slice_merged() {
  local branch tip parent
  branch=$(git -C "$1" branch --show-current 2>/dev/null) || return 1
  [[ $branch == slice/*/* ]] || return 1
  parent=$(parent_of "$branch")
  tip=$(git -C "$1" rev-parse HEAD 2>/dev/null) || return 1
  git -C "$1" rev-parse --verify --quiet "$parent" >/dev/null || return 1
  git -C "$1" merge-base --is-ancestor "$tip" "$parent" || return 1
  git -C "$1" log --merges --format='%P' -n 2000 "$parent" | awk '{for (i = 2; i <= NF; i++) print $i}' | grep -qx "$tip"
}

# iso_epoch ISO → epoch seconds of an RFC 3339 time (Docker's FinishedAt).
iso_epoch() {
  local s=${1%%.*}; s=${s%Z}
  date -j -u -f '%Y-%m-%dT%H:%M:%S' "$s" +%s 2>/dev/null || date -u -d "${s}Z" +%s 2>/dev/null
}

# stack_stopped_secs DIR → how long ago the worktree's stack stopped, in
# seconds; nothing when it has no stack or any of its containers runs. With no
# containers left at all, the root .env's age stands in.
stack_stopped_secs() {
  local proj ids line newest=0 t now
  proj=$(stack_project "$1"); [[ -n $proj ]] || return 0
  now=$(date +%s)
  ids=$(docker ps -aq --filter "label=com.docker.compose.project=$proj" 2>/dev/null || true)
  if [[ -z $ids ]]; then
    t=$(file_mtime "$1/.env" || echo "$now")
    echo $((now - t)); return 0
  fi
  # shellcheck disable=SC2086
  while read -r line; do
    [[ $line == true* ]] && return 0
    t=$(iso_epoch "${line#* }") || continue
    ((t > newest)) && newest=$t
  done < <(docker inspect -f '{{.State.Running}} {{.State.FinishedAt}}' $ids 2>/dev/null)
  ((newest > 0)) && echo $((now - newest))
  return 0
}

# gc_stopped_after → how long a stack may sit stopped before status flags it
# and gc offers to take it down (seconds; CARETOOK_GC_STOPPED_HOURS, 24).
gc_stopped_after() { echo $((${CARETOOK_GC_STOPPED_HOURS:-24} * 3600)); }

# fmt_age SECS → 3d, 5h or 12m.
fmt_age() {
  local s=$1
  if ((s >= 86400)); then echo "$((s / 86400))d"; elif ((s >= 3600)); then echo "$((s / 3600))h"; else echo "$((s / 60))m"; fi
}
