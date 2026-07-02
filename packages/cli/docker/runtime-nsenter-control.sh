#!/usr/bin/env bash
set -euo pipefail

state_dir=""
marker=""
workdir="/"

usage() {
	cat >&2 <<'EOF'
Usage:
  clawdi-runtime-nsenter --state-dir <path> --marker <path> [--workdir <path>] -- <command> [args...]

Finds a same-Pod runtime container by its mounted state directory and marker
file, enters that container's namespaces/root, and executes the command there.
Requires a shared PID namespace and sufficient nsenter capabilities.
EOF
	exit 64
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--state-dir)
			[ "$#" -ge 2 ] || usage
			state_dir="$2"
			shift 2
			;;
		--marker)
			[ "$#" -ge 2 ] || usage
			marker="$2"
			shift 2
			;;
		--workdir)
			[ "$#" -ge 2 ] || usage
			workdir="$2"
			shift 2
			;;
		--)
			shift
			break
			;;
		*)
			usage
			;;
	esac
done

[ -n "$state_dir" ] || usage
[ -n "$marker" ] || usage
[ "$#" -gt 0 ] || usage

case "$state_dir" in
	/*) ;;
	*) echo "state-dir must be absolute: $state_dir" >&2; exit 64 ;;
esac

case "$marker" in
	/*) ;;
	*) echo "marker must be absolute: $marker" >&2; exit 64 ;;
esac

command -v nsenter >/dev/null 2>&1 || {
	echo "nsenter is required for runtime control" >&2
	exit 127
}

target_pid=""
for proc in /proc/[0-9]*; do
	[ -d "$proc/root$state_dir" ] || continue
	[ -e "$proc/root$marker" ] || continue
	target_pid="${proc#/proc/}"
	break
done

if [ -z "$target_pid" ]; then
	echo "could not find runtime process with state_dir=$state_dir marker=$marker" >&2
	exit 69
fi

target_uid="$(awk '/^Uid:/ { print $2; exit }' "/proc/$target_pid/status")"
target_gid="$(awk '/^Gid:/ { print $2; exit }' "/proc/$target_pid/status")"
[ -n "$target_uid" ] || target_uid=0
[ -n "$target_gid" ] || target_gid=0

exec nsenter \
	--target "$target_pid" \
	--mount \
	--uts \
	--ipc \
	--net \
	--pid \
	--root="/proc/$target_pid/root" \
	--wdns="$workdir" \
	--setgid="$target_gid" \
	--setuid="$target_uid" \
	-- "$@"
