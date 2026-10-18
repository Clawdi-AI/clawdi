#!/usr/bin/env bash
# Credential-free container, --network none, no production mounts.
set -euo pipefail
database=$1
target=$2
max_lag=$3
export PGDATA=/scratch/data PGHOST=/tmp PGUSER=postgres PGDATABASE="$database"
# Reserved exit codes carry only the failed step to run.py, never diagnostics.
failure_code=71
finish() {
    result=$?
    pg_ctl -D "$PGDATA" -m immediate -w stop >/dev/null 2>&1 || true
    if (( result != 0 )); then exit "$failure_code"; fi
}
trap finish EXIT
pg_ctl -D "$PGDATA" -l /scratch/postgres.log -w -t 600 start >/dev/null
failure_code=72
# Startup can report ready before promotion finishes. Bound the wait and insist
# on promotion, rather than accepting a hot-standby snapshot.
promoted=f
for ((attempt=0; attempt<600; attempt++)); do
    promoted=$(psql -XAtq -v ON_ERROR_STOP=1 -c 'SELECT NOT pg_is_in_recovery()')
    if [[ $promoted = t ]]; then break; fi
    sleep 1
done
test "$promoted" = t
failure_code=73
# SQL arrives over stdin after this script, via a file copied by the runner.
# Only a boolean leaves the sanity query; never emit application rows/counts.
test "$(psql -XAtq -v ON_ERROR_STOP=1 -v target="$target" -v max_lag="$max_lag" \
    -f /scratch/sanity.sql)" = t
failure_code=74
replayed=$(psql -XAtq -v ON_ERROR_STOP=1 -v target="$target" -v max_lag="$max_lag" <<'SQL'
SELECT extract(epoch FROM pg_last_xact_replay_timestamp())::bigint
WHERE NOT pg_is_in_recovery()
  AND pg_last_xact_replay_timestamp() <= :'target'::timestamptz
  AND pg_last_xact_replay_timestamp() >= :'target'::timestamptz - make_interval(secs => :max_lag);
SQL
)
[[ $replayed =~ ^[0-9]+$ ]]
failure_code=75
pg_amcheck --database="$database" --install-missing --heapallindexed --parent-check --jobs=2 >/dev/null 2>&1
failure_code=76
pg_ctl -D "$PGDATA" -m fast -w stop >/dev/null
pg_checksums --check -D "$PGDATA" >/dev/null 2>&1
trap - EXIT
printf '%s\n' "$replayed"
