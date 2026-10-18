#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
export POSTGRES_DRILL_IMAGE
POSTGRES_DRILL_IMAGE=$(cat "$root/config/postgres-image.txt")
project="pg-drill-test-$$"
compose=(docker compose -p "$project" -f "$root/scripts/postgres-drill/tests/compose.yml")
trap '"${compose[@]}" down --volumes >/dev/null 2>&1' EXIT
"${compose[@]}" run --rm -T shellcheck
"${compose[@]}" run --rm -T lint
"${compose[@]}" run --rm -T unit
"${compose[@]}" run --rm -T fixture
"${compose[@]}" run --rm -T checks
# Rebuild a fresh restore and then remove WAL. A time target beyond the base
# backup must fail, never silently pass checks at the backup's end.
"${compose[@]}" run --rm -T --user root --entrypoint bash checks /repo/scripts/postgres-drill/tests/failure.sh
echo 'PITR, post-target exclusion, checksums, amcheck and missing-WAL detection passed'
