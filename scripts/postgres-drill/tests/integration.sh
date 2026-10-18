#!/usr/bin/env bash
# Hermetic fixture: an actual tiny checksummed database, local pgBackRest repo,
# commits on either side of the PITR target, and a missing-WAL failure.
set -euo pipefail
work=/fixture
mkdir -p "$work"/socket "$work"/repo /scratch
chown -R postgres:postgres "$work" /scratch
export PGDATA=$work/source PGHOST=$work/socket PGUSER=postgres PGDATABASE=postgres
export PGBACKREST_STANZA=drill-test
export PGBACKREST_PG1_PATH=$PGDATA PGBACKREST_PG1_SOCKET_PATH=$PGHOST
export PGBACKREST_REPO1_TYPE=posix PGBACKREST_REPO1_PATH=$work/repo
export PGBACKREST_REPO1_RETENTION_FULL=4 PGBACKREST_LOG_LEVEL_CONSOLE=off
gosu postgres initdb --data-checksums --auth=trust >/dev/null
cat >> "$PGDATA/postgresql.conf" <<EOF
listen_addresses = ''
unix_socket_directories = '$PGHOST'
archive_mode = on
archive_command = 'pgbackrest archive-push %p'
EOF
gosu postgres pg_ctl -D "$PGDATA" -l "$work/source.log" -w start >/dev/null
cleanup() { gosu postgres pg_ctl -D "$PGDATA" -m immediate -w stop >/dev/null 2>&1 || true; }
trap cleanup EXIT
gosu postgres psql -Xq -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE drill_rows (id int PRIMARY KEY, updated_at timestamptz NOT NULL);
INSERT INTO drill_rows VALUES (1, clock_timestamp());
SQL
gosu postgres pgbackrest stanza-create
gosu postgres pgbackrest --type=full backup
# A post-backup transaction must be replayed; a transaction after target must
# not be replayed. This proves PITR rather than just latest-backup recovery.
gosu postgres psql -Xq -v ON_ERROR_STOP=1 -c 'INSERT INTO drill_rows VALUES (2, clock_timestamp())'
sleep 1
target=$(date -u +%Y-%m-%dT%H:%M:%S+00:00)
sleep 1
gosu postgres psql -Xq -v ON_ERROR_STOP=1 -c 'INSERT INTO drill_rows VALUES (3, clock_timestamp())'
gosu postgres pgbackrest check
backup=$(gosu postgres pgbackrest repo-ls backup/drill-test | sed -n '/^[0-9].*F$/p' | tail -1)
test -n "$backup"
printf '%s\n' "$target" > "$work/target"
printf '%s\n' "$backup" > "$work/backup"
bash /repo/scripts/postgres-drill/fetch.sh "$target" "$backup" 67108864
cat > /scratch/sanity.sql <<'SQL'
SELECT count(*) = 2 AND max(id) = 2 FROM drill_rows;
SQL
gosu postgres pg_ctl -D "$PGDATA" -m fast -w stop >/dev/null
trap - EXIT
# The fixture driver starts check.sh in a DIFFERENT network-none container,
# with /fixture mounted read-only and no PGBACKREST_* variables.
