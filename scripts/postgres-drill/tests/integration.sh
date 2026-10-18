#!/usr/bin/env bash
# Hermetic fixture: an actual tiny checksummed database, local pgBackRest repo,
# commits on either side of the PITR target, and a missing-WAL failure.
set -euo pipefail
# Keep the pinned image's default user, just like the production entrypoint.
test "$(id -u)" = 0
work=/fixture
mkdir -p "$work"/socket "$work"/repo /scratch
chown -R postgres:postgres "$work"
# Docker's empty volume starts root-owned. The runner must prepare its parent
# so the credential-free postgres user can write its private recovery log.
test "$(stat -c %u /scratch)" = 0
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
-- Both products' core tables are nonempty, with no recent application activity.
CREATE TABLE users (id int PRIMARY KEY);
CREATE TABLE subscriptions (id int PRIMARY KEY);
CREATE TABLE v2_hosted_deployments (id int PRIMARY KEY, updated_at timestamptz NOT NULL);
CREATE TABLE agent_environments (id int PRIMARY KEY);
CREATE TABLE sessions (id int PRIMARY KEY, updated_at timestamptz NOT NULL);
INSERT INTO users VALUES (1);
INSERT INTO subscriptions VALUES (1);
INSERT INTO agent_environments VALUES (1);
INSERT INTO v2_hosted_deployments VALUES (1, '2000-01-01T00:00:00Z');
INSERT INTO sessions VALUES (1, '2000-01-01T00:00:00Z');
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
# Reproduce the production failure: no user override means pgBackRest exit 31.
if pgbackrest info; then
    echo 'pgBackRest unexpectedly accepted the image default root user' >&2
    exit 1
else
    test "$?" = 31
fi
gosu postgres pg_ctl -D "$PGDATA" -m fast -w stop >/dev/null
trap - EXIT
# The driver now executes Runner's actual Docker argv for metadata, ownership,
# restore/prefetch and checks. Only the fixture setup uses gosu.
