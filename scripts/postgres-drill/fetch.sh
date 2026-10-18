#!/usr/bin/env bash
# Runs only in a disposable repository-reader container. No server is started.
set -euo pipefail
target=$1
backup=$2
wal_limit=$3
install -d -o postgres -g postgres -m 700 /scratch /scratch/data /scratch/wal
if [[ -n $(ls -A /scratch/data) ]]; then exit 1; fi
export PGBACKREST_PG1_PATH=/scratch/data
export PGBACKREST_LOCK_PATH=/tmp/pgbackrest
export PGBACKREST_LOG_PATH=/tmp/pgbackrest
gosu postgres pgbackrest --repo=1 --set="$backup" --type=time --target="$target" \
    --target-action=promote --target-timeline=current --archive-mode=off \
    --no-link-all --tablespace-map-all=/scratch/data/tablespaces \
    --log-level-console=off restore
# Use PostgreSQL's recorded starting WAL/timeline. Fetch the selected timeline
# through the repository's current end; PostgreSQL itself enforces the time
# target (and fails if archived WAL cannot reach it).
start=$(sed -n 's/^START WAL LOCATION:.*(file \([0-9A-F]*\)).*/\1/p' /scratch/data/backup_label)
[[ $start =~ ^[0-9A-F]{24}$ ]]
gosu postgres pgbackrest --repo=1 --log-level-console=off repo-ls \
    "archive/$PGBACKREST_STANZA" --recurse > /tmp/archive-list
awk -F/ -v start="$start" '
    { name=substr($NF,1,24) }
    length(name)==24 && name ~ /^[0-9A-F]+$/ &&
    substr(name,1,8)==substr(start,1,8) && name>=start { print name }
' /tmp/archive-list | sort -u > /tmp/wal-list
test -s /tmp/wal-list
while read -r wal; do
    gosu postgres pgbackrest --repo=1 --log-level-console=off \
        archive-get "$wal" "/scratch/wal/$wal"
    # Check during prefetch, not after filling the host disk.
    used=$(du -sb /scratch/wal | cut -f1)
    if (( used > wal_limit )); then exit 1; fi
done < /tmp/wal-list
# Never execute restored configuration, preload libraries, archive commands,
# or connection settings. No repository credential reaches recovery.
cat > /scratch/data/postgresql.conf <<'EOF'
listen_addresses = ''
unix_socket_directories = '/tmp'
archive_mode = off
archive_command = ''
shared_preload_libraries = ''
restore_command = 'cp /scratch/wal/%f %p'
recovery_target_action = 'promote'
recovery_target_timeline = 'current'
EOF
printf "recovery_target_time = '%s'\n" "$target" >> /scratch/data/postgresql.conf
: > /scratch/data/postgresql.auto.conf
printf 'local all all trust\n' > /scratch/data/pg_hba.conf
: > /scratch/data/pg_ident.conf
chown postgres:postgres /scratch/data/{postgresql.conf,postgresql.auto.conf,pg_hba.conf,pg_ident.conf}
