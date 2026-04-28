#!/usr/bin/env bash
# deploy/snapshot/dump.sh — produce a filtered snapshot of prod.
#
# Runs on the prod VM. Produces a single tarball:
#   snapshot.pg_dump  — Postgres custom-format dump of the pruned data
#   files/            — file_keys referenced by surviving sessions/skills
#
# Usage:
#   dump.sh [--email-domain @example.com] [--out <path>]
#
# Env overrides:
#   PROD_DB     prod postgres DB name      (default clawdi_cloud_prod)
#   PROD_FILES  prod file store path       (default /opt/clawdi-cloud/data/files)
#   TEMP_DB     intermediate DB name       (default clawdi_snapshot_temp)
#   PG_OWNER    role that owns prod DB     (default clawdi_cloud_prod)

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: dump.sh [--email-domain @example.com] [--out <path>]
EOF
}

main() {
  local email_domain="@example.com"
  local out=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --email-domain) email_domain="$2"; shift 2 ;;
      --out) out="$2"; shift 2 ;;
      -h|--help) usage; return 0 ;;
      *) echo "dump.sh: unknown option: $1" >&2; usage; return 2 ;;
    esac
  done

  if ! [[ "$email_domain" =~ ^@[a-z0-9.-]+$ ]]; then
    echo "dump.sh: --email-domain must match ^@[a-z0-9.-]+$ (got '$email_domain')" >&2
    return 1
  fi
  local email_like="%${email_domain}"

  if [ -z "$out" ]; then
    out="/tmp/clawdi-snapshot-$(date -u +%Y-%m-%d).tar.gz"
  fi

  local prod_db="${PROD_DB:-clawdi_cloud_prod}"
  local prod_files="${PROD_FILES:-/opt/clawdi-cloud/data/files}"
  local temp_db="${TEMP_DB:-clawdi_snapshot_temp}"
  local pg_owner="${PG_OWNER:-clawdi_cloud_prod}"

  local script_dir
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
  local prune_template="${script_dir}/prune.sql.tmpl"
  if [ ! -f "$prune_template" ]; then
    echo "dump.sh: prune template not found at $prune_template" >&2
    return 1
  fi

  if [ ! -d "$prod_files" ]; then
    echo "dump.sh: prod file store not found at $prod_files (set PROD_FILES to override)" >&2
    return 1
  fi

  local workdir=""
  # Trap evaluates in global scope; use ${var-} default-if-unset to survive set -u.
  trap 'if [ -n "${workdir-}" ]; then rm -rf "$workdir"; fi; sudo -nu postgres dropdb --if-exists "'"$temp_db"'" >/dev/null 2>&1 || true' EXIT
  workdir="$(mktemp -d)"
  mkdir -p "$workdir/files"

  echo "[dump] (re)creating temp DB '$temp_db' ..."
  sudo -nu postgres dropdb --if-exists "$temp_db"
  sudo -nu postgres createdb -O "$pg_owner" "$temp_db"

  echo "[dump] copying prod -> temp (this is the slow step) ..."
  sudo -nu postgres bash -c "pg_dump -Fc -d '$prod_db' | pg_restore --no-owner --no-privileges -d '$temp_db'"

  echo "[dump] pruning to allowlist '$email_like' ..."
  EMAIL_LIKE="$email_like" envsubst < "$prune_template" \
    | sudo -nu postgres psql -d "$temp_db" -v ON_ERROR_STOP=1 >/dev/null

  echo "[dump] collecting surviving file_keys ..."
  local keys_file="$workdir/keys.txt"
  sudo -nu postgres psql -d "$temp_db" -At -c "
    SELECT file_key FROM sessions WHERE file_key IS NOT NULL
    UNION ALL
    SELECT file_key FROM skills   WHERE file_key IS NOT NULL
  " > "$keys_file"

  local key_count
  key_count="$(wc -l < "$keys_file" | tr -d ' ')"
  echo "[dump] rsyncing $key_count file_keys ..."
  if [ "$key_count" -gt 0 ]; then
    rsync -a --files-from="$keys_file" "$prod_files/" "$workdir/files/"
  fi

  echo "[dump] dumping pruned DB ..."
  sudo -nu postgres pg_dump -Fc -d "$temp_db" > "$workdir/snapshot.pg_dump"

  echo "[dump] tarballing -> $out ..."
  tar -czf "$out" -C "$workdir" snapshot.pg_dump files

  echo "[dump] dropping temp DB ..."
  sudo -nu postgres dropdb "$temp_db"
  trap - EXIT
  rm -rf "$workdir"

  local size
  size="$(du -h "$out" | cut -f1)"
  echo "[dump] done: $out ($size, $key_count file_keys)"
}

main "$@"
