#!/usr/bin/env bash
# Create an isolated worktree in .loops/:
#
#   new.sh prd <topic>          .loops/<topic>        prd/<topic>        from dev            stack
#   new.sh slice <topic> <n>    .loops/<topic>-<n>    slice/<topic>/<n>  from prd/<topic>    stack
#   new.sh plan <topic>         .loops/plan-<topic>   plan/<topic>       from dev            no stack
#
# Options (before the kind): --slot N (pin a slot), --stack / --no-stack
# (override the default), --base B (branch from B instead).
#
# A stacked worktree leases the lowest free slot (1-19), which fixes its ports
# (slot_ports in lib.sh) and Compose projects (caretook-loopN, -test). Secrets
# are copied from the main checkout's env files. If the branch already exists,
# it's checked out instead (to resume after rm.sh). At most CARETOOK_MAX_PRDS
# (default 3) PRD worktrees exist at once. Tear down with rm.sh <name>.
# (pnpm prd start|slice|plan wrap this.)
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

slot="" stack="" base=""
while [[ ${1:-} == --* ]]; do
  case $1 in
    --slot) slot=${2:?--slot N}; shift 2 ;;
    --stack) stack=1; shift ;;
    --no-stack) stack=0; shift ;;
    --base) base=${2:?--base B}; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done
kind=${1:?kind: prd, slice or plan}; topic=${2:?topic}
[[ $topic =~ ^[a-z0-9-]+$ ]] || { echo "topic: lowercase, digits, dashes" >&2; exit 1; }
case $kind in
  prd) name=$topic branch=prd/$topic base=${base:-$trunk} stack=${stack:-1}
    if [[ ! -e $loops/$name ]] && (($(prd_count) >= max_prds)); then
      echo "already $(prd_count) PRD worktrees (cap $max_prds; raise CARETOOK_MAX_PRDS to override)" >&2; exit 1
    fi ;;
  slice) n=${3:?slice number}; [[ $n =~ ^[0-9]+$ ]] || { echo "slice number: digits" >&2; exit 1; }
    name=$topic-$n branch=slice/$topic/$n base=${base:-prd/$topic} stack=${stack:-1} ;;
  plan) name=plan-$topic branch=plan/$topic base=${base:-$trunk} stack=${stack:-0} ;;
  *) echo "kind must be prd, slice or plan" >&2; exit 1 ;;
esac
dir=$loops/$name
[[ -e $dir ]] && { echo "$dir already exists" >&2; exit 1; }
git -C "$main" rev-parse --verify --quiet "$base" >/dev/null || { echo "no branch $base" >&2; exit 1; }

if ((stack)); then
  for f in packages/data/.env apps/web/.env; do
    [[ -f $main/$f ]] || { echo "missing $main/$f (copy its .env.example)" >&2; exit 1; }
  done
  if [[ -n $slot ]]; then
    [[ $slot =~ ^[0-9]+$ ]] && ((slot >= 1 && slot <= 19)) || { echo "slot must be 1-19" >&2; exit 1; }
    slot_busy "$slot" && { echo "slot $slot is taken (scripts/loops/ls.sh)" >&2; exit 1; }
    lease_slot "$slot" "$name" || { echo "slot $slot was just taken" >&2; exit 1; }
  else
    for i in $(seq 1 19); do
      slot_busy "$i" && continue
      lease_slot "$i" "$name" && { slot=$i; break; }
    done
    [[ -n $slot ]] || { echo "all 19 slots are taken" >&2; exit 1; }
  fi
  # Give the slot back if anything fails before the worktree exists.
  trap '[[ -d $dir ]] || release_slot "$name"' ERR
  slot_ports "$slot"
fi

if git -C "$main" show-ref --verify --quiet "refs/heads/$branch"; then
  echo "branch $branch exists: checking it out (base $base ignored)"
  git -C "$main" worktree add "$dir" "$branch"
else
  git -C "$main" worktree add -b "$branch" "$dir" "$base"
fi
cd "$dir"
# The protection hooks (.githooks/); core.hooksPath is shared by every worktree.
git config core.hooksPath .githooks

if ((stack)); then
  # Compose reads the root .env: project name and host ports.
  cat > .env <<ENV
CARETOOK_STACK=caretook-loop$slot
PG_PORT=$pg
PG_TEST_PORT=$pgt
POWERSYNC_PORT=$ps
POWERSYNC_URL=http://localhost:$ps
PS_JWKS_URL=http://host.docker.internal:$web/api/auth/jwks
ENV

  sed -E "s#^DATABASE_URL=.*#DATABASE_URL=\"postgresql://caretook:password@localhost:$pg/caretook\"#" \
    "$main/packages/data/.env" > packages/data/.env
  cat > packages/data/.env.test.local <<ENV
DATABASE_URL="postgresql://caretook:password@localhost:$pgt/caretook"
PG_TEST_PORT=$pgt
ENV
  sed -E \
    -e "s#^BETTER_AUTH_URL=.*#BETTER_AUTH_URL=\"http://localhost:$web\"#" \
    -e "s#^AUTH_TRUSTED_ORIGINS=.*#AUTH_TRUSTED_ORIGINS=\"http://localhost:$web\"#" \
    -e "s#^POWERSYNC_URL=.*#POWERSYNC_URL=\"http://localhost:$ps\"#" \
    -e "s#^VITE_POWERSYNC_URL=.*#VITE_POWERSYNC_URL=\"http://localhost:$ps\"#" \
    -e "/^WEB_PORT=/d" \
    -e "/^APP_URL=/d" \
    "$main/apps/web/.env" > apps/web/.env
  # Emailed links point at this worktree's dev server. The mail secrets
  # (CRON_SECRET, INVITE_LINK_KEY, …) come over with the rest of the file.
  printf 'WEB_PORT=%s\nAPP_URL="http://localhost:%s"\n' "$web" "$web" >> apps/web/.env
  # A main checkout without a CRON_SECRET still gives the worktree one (random,
  # local), so /api/cron/outbox can be called there.
  if ! grep -Eq '^CRON_SECRET="?[^"]' apps/web/.env; then
    sed -i.bak '/^CRON_SECRET=/d' apps/web/.env && rm -f apps/web/.env.bak
    printf 'CRON_SECRET="%s"\n' "$(openssl rand -hex 32)" >> apps/web/.env
  fi
  # Contact messages from the marketing site go to SUPPORT_EMAIL (the dev
  # mailbox outside production); the main checkout's value comes over above.
  if ! grep -Eq '^SUPPORT_EMAIL="?[^"]' apps/web/.env; then
    sed -i.bak '/^SUPPORT_EMAIL=/d' apps/web/.env && rm -f apps/web/.env.bak
    printf 'SUPPORT_EMAIL="support@example.com"\n' >> apps/web/.env
  fi

  # For browser checks: `set -a; source .env.loop; set +a`.
  cat > .env.loop <<ENV
SLOT=$slot
BASE_BRANCH=$base
BASE=http://localhost:$web
CDP_PORT_OFFSET=$off
PG_CONTAINER=caretook-loop$slot-postgres-1
ENV
  grep '^SEED_USER_PASSWORD=' packages/data/.env >> .env.loop || true
else
  # No stack: point the integration tests at a closed port, so they fail fast
  # instead of falling back to the main checkout's test database on :5435.
  cat > packages/data/.env.test.local <<ENV
# No stack in this worktree: run test:unit, not test:integration.
DATABASE_URL="postgresql://caretook:password@localhost:1/caretook"
PG_TEST_PORT=1
ENV
  printf 'SLOT=\nBASE_BRANCH=%s\n' "$base" > .env.loop
fi

export NVM_DIR=${NVM_DIR:-$HOME/.nvm}
# shellcheck disable=SC1091
source "$NVM_DIR/nvm.sh" >/dev/null && nvm use >/dev/null
pnpm install --frozen-lockfile

if ((stack)); then
  pnpm datastore:start
  pnpm datastore:start:test
  echo
  echo "Worktree $name ready (slot $slot) at $dir on $branch (from $base)"
  echo "  dev server   pnpm prd serve      → http://localhost:$web"
  echo "  Postgres     :$pg   test :$pgt   PowerSync :$ps (project caretook-loop$slot)"
  echo "  browser      pnpm prd browser --changed   (or one check: pnpm prd browser <check>)"
else
  echo
  echo "Worktree $name ready (no stack) at $dir on $branch (from $base)"
  echo "  checks       pnpm typecheck && pnpm lint && pnpm format:check && pnpm test:unit"
fi
if [[ $kind == prd ]]; then
  echo
  echo "Start its orchestrator in a new terminal:"
  echo "  cd $dir && claude --remote-control prd-$topic \"\$(scripts/loops/prompt.sh orchestrator $topic)\""
fi
