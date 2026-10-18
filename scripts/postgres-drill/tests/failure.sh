#!/usr/bin/env bash
set -euo pipefail
find /scratch -mindepth 1 -delete
export PGBACKREST_STANZA=drill-test PGBACKREST_REPO1_TYPE=posix PGBACKREST_REPO1_PATH=/fixture/repo
bash /repo/scripts/postgres-drill/fetch.sh "$(cat /fixture/target)" "$(cat /fixture/backup)" 67108864
find /scratch/wal -type f -delete
printf 'SELECT true;\n' > /scratch/sanity.sql
if gosu postgres bash /repo/scripts/postgres-drill/check.sh postgres "$(cat /fixture/target)" 3600; then
    echo 'Missing WAL unexpectedly passed' >&2
    exit 1
fi
