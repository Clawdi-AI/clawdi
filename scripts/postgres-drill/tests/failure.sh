#!/usr/bin/env bash
set -euo pipefail
export PGBACKREST_STANZA=drill-test PGBACKREST_REPO1_TYPE=posix PGBACKREST_REPO1_PATH=/fixture/repo
target=$(cat /fixture/target)
backup=$(cat /fixture/backup)
restore() {
    find /scratch -mindepth 1 -delete
    bash /repo/scripts/postgres-drill/fetch.sh "$target" "$backup" 67108864
    cp /repo/config/postgres-drill/sanity.sql /scratch/sanity.sql
}
# Reproduce the old minimal-config failure. The same backup must subsequently
# recover successfully with the control-file settings supplied by fetch.sh.
restore
printf '\nmax_connections = 100\n' >> /scratch/data/postgresql.conf
result=0
pg_ctl -D /scratch/data -l /scratch/postgres.log -w -t 5 start \
    >/scratch/check.stdout 2>/scratch/check.stderr || result=$?
pg_ctl -D /scratch/data -m immediate -w stop >/dev/null 2>&1 || true
test "$result" != 0
# The real product query must accept old application timestamps when recent WAL
# reaches the target. Keep this distinct from the post-target exclusion check.
restore
replayed=$(bash /repo/scripts/postgres-drill/check.sh postgres "$target" 3600)
[[ $replayed =~ ^[0-9]+$ ]]

# Fault injection wraps just the failing tool; every other call still exercises
# the real PostgreSQL restore/check path. No failure knobs enter production code.
wrappers=$(mktemp -d)
trap 'rm -r -- "$wrappers"' EXIT
for tool in pg_ctl psql pg_amcheck pg_checksums pg_controldata sleep; do
    real=$(command -v "$tool")
    cat > "$wrappers/$tool" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
tool=${0##*/}
case "$DRILL_FAIL_STEP:$tool" in
    invalid_control:pg_controldata)
        printf 'max_connections setting: invalid\n'
        exit 0 ;;
    missing_control:pg_controldata) exit 0 ;;
    checks_start:pg_ctl) [[ " $* " != *' start '* ]] || exit 1 ;;
    checks_promote:psql)
        if [[ " $* " = *'SELECT NOT pg_is_in_recovery()'* ]]; then
            printf 'f\n'
            exit 0
        fi ;;
    checks_promote:sleep) exit 0 ;;
    checks_sanity:psql) [[ " $* " != *' -f '* ]] || exit 1 ;;
    checks_replay:psql)
        if [[ " $* " != *' -c '* && " $* " != *' -f '* ]]; then exit 1; fi ;;
    checks_amcheck:pg_amcheck|checks_checksums:pg_checksums) exit 1 ;;
esac
SH
    printf 'exec %q "$@"\n' "$real" >> "$wrappers/$tool"
    chmod +x "$wrappers/$tool"
done
# Control-file fields must be present and integer-only before recovery config
# is accepted. All repository reads/restores here still use the real tools.
for phase in invalid_control missing_control; do
    find /scratch -mindepth 1 -delete
    result=0
    DRILL_FAIL_STEP=$phase PATH="$wrappers:$PATH" \
        bash /repo/scripts/postgres-drill/fetch.sh "$target" "$backup" 67108864 \
        >/scratch/check.stdout 2>/scratch/check.stderr || result=$?
    test "$result" != 0
done
code=71
for phase in checks_start checks_promote checks_sanity checks_replay checks_amcheck checks_checksums; do
    restore
    result=0
    DRILL_FAIL_STEP=$phase PATH="$wrappers:$PATH" \
        bash /repo/scripts/postgres-drill/check.sh postgres "$target" 3600 \
        >/scratch/check.stdout 2>/scratch/check.stderr || result=$?
    test "$result" = "$code"
    test ! -s /scratch/check.stdout
    code=$((code + 1))
done

restore
find /scratch/wal -type f -delete
printf 'SELECT true;\n' > /scratch/sanity.sql
if bash /repo/scripts/postgres-drill/check.sh postgres "$target" 3600; then
    echo 'Missing WAL unexpectedly passed' >&2
    exit 1
fi
