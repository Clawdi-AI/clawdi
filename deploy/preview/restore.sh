#!/bin/sh
# deploy/preview/restore.sh — one-shot init that loads the snapshot into
# the per-preview Postgres + file store. Idempotent: subsequent runs detect
# the marker table and exit immediately, so dev edits inside the api/web
# containers and whatever the preview has done since boot are preserved.
#
# Run inside the `restore` Compose service, which mounts:
#   /snapshots         (ro)   the host's /var/clawdi-snapshots dir
#   /data/files        (rw)   the api container's bind-mounted file store
#   PG access via DATABASE_URL env (reach the postgres service by name)
#
# Required env: DATABASE_URL, SNAPSHOT_PATH (default /snapshots/latest.tar.gz)

set -eu

SNAPSHOT_PATH="${SNAPSHOT_PATH:-/snapshots/latest.tar.gz}"
MARKER_TABLE="_clawdi_snapshot_loaded"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "restore: DATABASE_URL is required" >&2
  exit 1
fi

if [ ! -f "$SNAPSHOT_PATH" ]; then
  echo "restore: snapshot not found at $SNAPSHOT_PATH" >&2
  echo "restore: operator must scp clawdi-snapshot-*.tar.gz into /var/clawdi-snapshots/ on the host" >&2
  exit 1
fi

echo "[restore] checking for marker table '$MARKER_TABLE' ..."
already_loaded="$(psql "$DATABASE_URL" -At -c "SELECT to_regclass('public.${MARKER_TABLE}') IS NOT NULL")"
if [ "$already_loaded" = "t" ]; then
  echo "[restore] snapshot already loaded — skipping (delete the volume to force re-restore)"
  exit 0
fi

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

echo "[restore] extracting snapshot ..."
tar -xzf "$SNAPSHOT_PATH" -C "$workdir"

if [ ! -f "$workdir/snapshot.pg_dump" ]; then
  echo "restore: snapshot.pg_dump missing from $SNAPSHOT_PATH" >&2
  exit 1
fi

echo "[restore] running pg_restore ..."
pg_restore --clean --if-exists --no-owner --no-privileges \
           --dbname="$DATABASE_URL" \
           "$workdir/snapshot.pg_dump"

if [ -d "$workdir/files" ]; then
  echo "[restore] copying file store into /data/files ..."
  # cp -a preserves perms; trailing /. copies contents not the dir itself.
  cp -a "$workdir/files/." /data/files/
fi

echo "[restore] writing marker ..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "CREATE TABLE ${MARKER_TABLE} (loaded_at timestamptz DEFAULT now(), source text); \
   INSERT INTO ${MARKER_TABLE} (source) VALUES ('${SNAPSHOT_PATH}');"

echo "[restore] done."
