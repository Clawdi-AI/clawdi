#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
export POSTGRES_DRILL_IMAGE
POSTGRES_DRILL_IMAGE=$(cat "$root/config/postgres-image.txt")
project="pg-drill-test-$$"
compose=(docker compose -p "$project" -f "$root/scripts/postgres-drill/tests/compose.yml")
export DRILL_TEST_PROJECT="$project"
temporary=$(mktemp -d "$root/.postgres-drill-test.XXXXXX")
export DRILL_TEST_ENV="$temporary/repo.env"
cleanup() {
    docker rm --force --volumes "$project-reader" >/dev/null 2>&1 || true
    "${compose[@]}" down --volumes >/dev/null 2>&1
    if [[ -f "$DRILL_TEST_ENV" ]]; then rm -- "$DRILL_TEST_ENV"; fi
    rmdir -- "$temporary"
}
trap cleanup EXIT
cat > "$DRILL_TEST_ENV" <<'EOF'
PGBACKREST_STANZA=drill-test
PGBACKREST_REPO1_TYPE=posix
PGBACKREST_REPO1_PATH=/fixture/repo
PGBACKREST_LOG_LEVEL_CONSOLE=off
EOF
"${compose[@]}" run --rm -T shellcheck
"${compose[@]}" run --rm -T lint
"${compose[@]}" run --rm -T unit
"${compose[@]}" run --rm -T fixture
# Generate argv inside isolated Python, then execute those actual production
# Docker commands on the test host. No socket mount or test-only user override.
"${compose[@]}" run --rm -T commands | bash -euo pipefail
"${compose[@]}" run --rm -T checks
echo 'PITR, recovery parameters, scratch headroom, quiet-application sanity, all six failure phases, integrity and missing-WAL detection passed'
