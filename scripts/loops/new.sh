#!/usr/bin/env bash
# Create an isolated loop: a git worktree in .loops/<name> on branch loop/<name>,
# with its own Docker stack (dev Postgres, test Postgres, PowerSync), dev server
# port and browser-check ports, all derived from a slot number (1-9).
#
#   scripts/loops/new.sh <slot> <name> [base-branch]   e.g. new.sh 2 slice-2
#
# Ports for slot N: web 6N73, Postgres 6N34, test Postgres 6N35, PowerSync 6N80,
# CDP/proxy ports shifted by N*1000. Secrets are copied from the main checkout's
# env files. Tear down with scripts/loops/rm.sh <name>.
set -euo pipefail

slot=${1:?slot 1-9}; name=${2:?name}; base=${3:-data-layer}
[[ $slot =~ ^[1-9]$ ]] || { echo "slot must be 1-9" >&2; exit 1; }
[[ $name =~ ^[a-z0-9-]+$ ]] || { echo "name: lowercase, digits, dashes" >&2; exit 1; }

main=$(git -C "$(dirname "$0")" worktree list --porcelain | awk 'NR==1{print $2}')
dir=$main/.loops/$name
branch=loop/$name
web=6${slot}73 pg=6${slot}34 pgt=6${slot}35 ps=6${slot}80 off=$((slot * 1000))

for f in packages/data/.env apps/web/.env; do
  [[ -f $main/$f ]] || { echo "missing $main/$f (copy its .env.example)" >&2; exit 1; }
done
for p in $web $pg $pgt $ps; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $p is in use (slot $slot taken?)" >&2; exit 1; fi
done
[[ -e $dir ]] && { echo "$dir already exists" >&2; exit 1; }

git -C "$main" worktree add -b "$branch" "$dir" "$base"
cd "$dir"

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
  "$main/apps/web/.env" > apps/web/.env
echo "WEB_PORT=$web" >> apps/web/.env

# For browser checks: `set -a; source .env.loop; set +a`.
cat > .env.loop <<ENV
BASE=http://localhost:$web
CDP_PORT_OFFSET=$off
ENV
grep '^SEED_USER_PASSWORD=' packages/data/.env >> .env.loop || true

export NVM_DIR=${NVM_DIR:-$HOME/.nvm}
# shellcheck disable=SC1091
source "$NVM_DIR/nvm.sh" >/dev/null && nvm use >/dev/null
pnpm install --frozen-lockfile
pnpm datastore:start
pnpm datastore:start:test

cat <<MSG

Loop "$name" ready (slot $slot) at $dir on $branch
  dev server   pnpm dev            → http://localhost:$web
  Postgres     :$pg   test :$pgt   PowerSync :$ps (project caretook-loop$slot)
  browser      set -a; source .env.loop; set +a; node scripts/browser-checks/<check>.mjs
MSG
