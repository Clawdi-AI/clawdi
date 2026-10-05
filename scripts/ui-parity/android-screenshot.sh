#!/usr/bin/env bash
# Open a Clawdi deep link on an already-running Android emulator and capture a
# screenshot for UI parity comparison. This script never starts/stops
# emulators or builds/installs the APK.
#
# Usage:
#   scripts/ui-parity/android-screenshot.sh <name> <path> [options]
#
#   name     Output file stem: <out-dir>/<name>.png
#   path     App route, e.g. "/", "/agents", "/sessions/<id>". Opened as
#            clawdi://<path> (the scheme declared in apps/mobile/app.config.js).
#
# Options:
#   --package <id>    Android package (default: com.clawdi.preview, or
#                     $CLAWDI_ANDROID_PACKAGE)
#   --out <dir>       Output directory (default: /tmp/clawdi-ui-parity/android)
#   --settle <secs>   Wait after opening the link (default: 3)
#   --serial <id>     adb device serial when more than one device is attached
#
# Environment:
#   ANDROID_SDK_ROOT  SDK root (default: ~/.cache/clawdi/android-preview/sdk)
set -euo pipefail

usage() {
	sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
	exit "${1:-0}"
}

[[ $# -ge 1 && ( $1 == "-h" || $1 == "--help" ) ]] && usage 0
[[ $# -lt 2 ]] && usage 1

name=$1
route=$2
shift 2

package=${CLAWDI_ANDROID_PACKAGE:-com.clawdi.preview}
out_dir=/tmp/clawdi-ui-parity/android
settle=3
serial=${ANDROID_SERIAL:-}

while [[ $# -gt 0 ]]; do
	case $1 in
	--package) package=$2; shift 2 ;;
	--out) out_dir=$2; shift 2 ;;
	--settle) settle=$2; shift 2 ;;
	--serial) serial=$2; shift 2 ;;
	-h | --help) usage 0 ;;
	*) echo "Unknown option: $1" >&2; usage 1 ;;
	esac
done

if [[ ! $name =~ ^[A-Za-z0-9._-]+$ ]]; then
	echo "Invalid name '$name': use letters, digits, '.', '_' or '-'." >&2
	exit 1
fi
if [[ $route != /* ]]; then
	echo "Route must start with '/': got '$route'." >&2
	exit 1
fi
if [[ ! $settle =~ ^[0-9]+([.][0-9]+)?$ ]]; then
	echo "Invalid --settle value '$settle'." >&2
	exit 1
fi

sdk_root=${ANDROID_SDK_ROOT:-$HOME/.cache/clawdi/android-preview/sdk}
adb_bin=$sdk_root/platform-tools/adb
if [[ ! -x $adb_bin ]]; then
	echo "adb not found at $adb_bin (set ANDROID_SDK_ROOT)." >&2
	exit 1
fi

adb_args=()
if [[ -n $serial ]]; then
	adb_args=(-s "$serial")
else
	mapfile -t devices < <("$adb_bin" devices | awk 'NR > 1 && $2 == "device" { print $1 }')
	if [[ ${#devices[@]} -eq 0 ]]; then
		echo "No running emulator/device found ('adb devices' lists none in 'device' state)." >&2
		echo "Start the emulator first; this script does not launch one." >&2
		exit 1
	fi
	if [[ ${#devices[@]} -gt 1 ]]; then
		echo "Multiple devices attached (${devices[*]}); pass --serial <id>." >&2
		exit 1
	fi
	adb_args=(-s "${devices[0]}")
fi

adb() { "$adb_bin" "${adb_args[@]}" "$@"; }

if ! adb shell pm path "$package" >/dev/null 2>&1; then
	echo "Package '$package' is not installed on the device." >&2
	exit 1
fi

# Expo Router resolves clawdi://agents/x the same way Linking.createURL does.
url="clawdi://${route#/}"
echo "Opening $url in $package"
adb shell am start -W -a android.intent.action.VIEW -d "'$url'" "$package" >/dev/null

sleep "$settle"

mkdir -p "$out_dir"
file=$out_dir/$name.png
tmp=$(mktemp "$out_dir/.${name}.XXXXXX")
trap 'rm -f "$tmp"' EXIT
adb exec-out screencap -p >"$tmp"
if [[ ! -s $tmp ]]; then
	echo "screencap returned no data." >&2
	exit 1
fi
mv "$tmp" "$file"
trap - EXIT
echo "$name $route -> $file"
