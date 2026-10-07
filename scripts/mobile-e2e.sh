#!/usr/bin/env bash
# Fixture-only Android smoke. Requires Linux, an existing AVD, SDK, Java 17+
# and a development APK with expo-dev-client (not an EAS preview/store build).
set -euo pipefail

usage() {
	cat <<'USAGE'
Usage: scripts/mobile-e2e.sh --apk <development.apk> [--avd <name>] [--output <new-directory>] [--maestro-archive <maestro.zip>]

Uses emulator-5564, fixture API 8796 and Metro 8096. Installs Maestro 2.11.0
in a disposable task directory; no global install or shell profile changes.
--maestro-archive reuses an official ZIP, with the same pinned checksum check.
ANDROID_SDK_ROOT, ANDROID_AVD_HOME and JAVA_HOME may point to existing tools.
The default SDK/AVD location is ~/.cache/clawdi/android-preview/{sdk,avd}.
Logs, JUnit results and screenshots remain in a unique test-results directory.
Clerk AuthView is skipped: rendering it requires a live Clerk instance.
USAGE
}

fail() { echo "mobile-e2e: $*" >&2; exit 1; }
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
apk=
avd=clawdi-preview
output=
maestro_archive=
while (( $# )); do
	case $1 in
		--apk|--avd|--output|--maestro-archive)
			(( $# >= 2 )) || fail "$1 requires a value"
			case $1 in
				--apk) apk=$2 ;;
				--avd) avd=$2 ;;
				--output) output=$2 ;;
				--maestro-archive) maestro_archive=$2 ;;
			esac
			shift 2 ;;
		-h|--help) usage; exit 0 ;;
		*) fail "Unknown option: $1" ;;
	esac
done
[[ -f $apk ]] || fail "Pass --apk with an existing development APK containing expo-dev-client"
[[ $avd =~ ^[A-Za-z0-9._-]+$ ]] || fail "Invalid AVD name"
apk=$(realpath "$apk")
[[ -z $maestro_archive || -f $maestro_archive ]] || fail "Maestro archive not found"
if [[ -n $maestro_archive ]]; then maestro_archive=$(realpath "$maestro_archive"); fi
if [[ -n ${JAVA_HOME:-} ]]; then export PATH=$JAVA_HOME/bin:$PATH; fi
for tool in bun node java curl unzip sha256sum python3 timeout setsid; do
	command -v "$tool" >/dev/null || fail "Missing tool: $tool (for Java, set PATH to JAVA_HOME/bin)"
done
[[ $(bun --version) == 1.4.2 ]] || fail "Use the repository's Bun 1.4.2"
[[ -d $repo_root/node_modules ]] || fail "Run bun install --frozen-lockfile first"
export ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT:-$HOME/.cache/clawdi/android-preview/sdk}
export ANDROID_HOME=$ANDROID_SDK_ROOT
export ANDROID_AVD_HOME=${ANDROID_AVD_HOME:-$HOME/.cache/clawdi/android-preview/avd}
adb_bin=$ANDROID_SDK_ROOT/platform-tools/adb
emulator_bin=$ANDROID_SDK_ROOT/emulator/emulator
[[ -x $adb_bin && -x $emulator_bin ]] || fail "SDK must contain adb and emulator"
[[ -f $ANDROID_AVD_HOME/$avd.ini ]] || fail "Existing AVD not found: $avd"
mapfile -t aapt_bins < <(printf '%s\n' "$ANDROID_SDK_ROOT"/build-tools/*/aapt2 | sort -V)
aapt_bin=${aapt_bins[-1]}
[[ -x $aapt_bin ]] || fail "SDK must contain aapt2"
badging=$(timeout -k 5s 15s "$aapt_bin" dump badging "$apk")
app_id=$(sed -n "s/^package: name='\([^']*\)'.*/\1/p" <<<"$badging")
[[ $app_id == ai.clawdi.app || $app_id == com.clawdi.preview ]] || fail "APK is not a Clawdi development build"
[[ $badging == *application-debuggable* ]] || fail "Fixture bypass requires a debuggable development build"
manifest=$(timeout -k 5s 15s "$aapt_bin" dump xmltree "$apk" --file AndroidManifest.xml)
[[ $manifest == *expo.modules.devlauncher* ]] || fail "APK lacks expo-dev-client; rebuild locally with the development profile's native modules"
[[ $manifest == *exp+clawdi* ]] || fail "APK lacks Expo's generated exp+clawdi development-client scheme"

# Refuse occupied ports rather than reusing/killing somebody else's services.
python3 - <<'PY'
import socket
for port in (5564, 5565, 8796, 8096):
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("0.0.0.0", port))
        except OSError:
            raise SystemExit(f"mobile-e2e: port {port} is occupied; leave its owner untouched")
PY
serial=emulator-5564
devices=$(timeout -k 5s 15s "$adb_bin" devices)
if awk -v serial="$serial" '$1 == serial {found=1} END {exit !found}' <<<"$devices"; then
	fail "$serial is already registered; leave it untouched"
fi

mkdir -p "$repo_root/test-results"
if [[ -n $output ]]; then
	[[ ! -e $output ]] || fail "Output directory already exists; choose a new one"
	mkdir -p "$output"
else
	output=$(mktemp -d "$repo_root/test-results/mobile-e2e.XXXXXX")
fi
output=$(realpath "$output")
task_dir=$(mktemp -d "$repo_root/test-results/.mobile-e2e-runtime.XXXXXX")
owned_pids=()
emulator_pid=
cleanup() {
	local status=$? pid
	trap - EXIT INT TERM
	for pid in "${owned_pids[@]}"; do
		if [[ $pid == "$emulator_pid" ]]; then
			# Let the emulator shut down its SDK helpers; never signal netsimd.
			kill -TERM "$pid" 2>/dev/null || true
		else
			kill -TERM -- "-$pid" 2>/dev/null || true
		fi
	done
	for (( attempt=0; attempt<10; attempt++ )); do
		local alive=0
		for pid in "${owned_pids[@]}"; do
			if kill -0 -- "-$pid" 2>/dev/null; then alive=1; fi
		done
		(( alive )) || break
		sleep 1
	done
	for pid in "${owned_pids[@]}"; do
		if [[ $pid == "$emulator_pid" ]]; then
			kill -KILL "$pid" 2>/dev/null || true
		else
			kill -KILL -- "-$pid" 2>/dev/null || true
		fi
		wait "$pid" 2>/dev/null || true
	done
	rm -rf "$task_dir"
	echo "Artifacts: $output"
	exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Keep emulator/Java/CLI runtime state local. Never alter the AVD, adb server,
# netsimd, global Maestro installation, shell profiles or other emulators.
mkdir -p "$task_dir"/{tmp,android-home,java-home}
export TMPDIR=$task_dir/tmp
export ANDROID_USER_HOME=$task_dir/android-home
export ANDROID_EMULATOR_HOME=$task_dir/android-home
export MAESTRO_CLI_NO_ANALYTICS=true
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
export PATH=$ANDROID_SDK_ROOT/platform-tools:$PATH

start_process() {
	local log=$1; shift
	setsid "$@" >"$output/$log" 2>&1 &
	started_pid=$!
	owned_pids+=("$started_pid")
}
run_process() {
	local log=$1 status=0
	start_process "$@"
	wait "$started_pid" || status=$?
	cat "$output/$log"
	return "$status"
}

echo "Preparing task-local Maestro 2.11.0"
if [[ -n $maestro_archive ]]; then
	cp "$maestro_archive" "$task_dir/maestro.zip"
else
	run_process maestro-download.log curl --fail --silent --show-error --location --max-time 180 \
		https://github.com/mobile-dev-inc/Maestro/releases/download/cli-2.11.0/maestro.zip \
		-o "$task_dir/maestro.zip"
fi
printf '%s  %s\n' 5384593cb4e7a106489e75a821d157dd43f4e438df6bc308b72e82c685e1283a "$task_dir/maestro.zip" | sha256sum --check --status || fail "Maestro checksum mismatch"
run_process maestro-install.log timeout -k 5s 30s unzip -q "$task_dir/maestro.zip" -d "$task_dir"
export JAVA_OPTS="-Xmx512m -XX:ActiveProcessorCount=2 -Duser.home=\"$task_dir/java-home\""
maestro=$task_dir/maestro/bin/maestro

adb() { timeout -k 5s 15s "$adb_bin" -s "$serial" "$@"; }
wait_http() {
	local url=$1 pid=$2 limit=$3 deadline=$((SECONDS + $3))
	while (( SECONDS < deadline )); do
		kill -0 "$pid" 2>/dev/null || fail "Service exited before becoming ready: $url (see logs)"
		if curl --fail --silent --max-time 2 "$url" >/dev/null; then return; fi
		sleep 2
	done
	fail "Service readiness exceeded ${limit}s: $url"
}

echo "Starting read-only $avd on $serial"
start_process emulator.log "$emulator_bin" -avd "$avd" -port 5564 \
	-read-only -feature -WiFiPacketStream -no-window -no-audio -no-snapshot \
	-no-boot-anim -no-metrics -memory 2560 -gpu swiftshader
emulator_pid=$started_pid
boot_deadline=$((SECONDS + 180))
until [[ $(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r') == 1 ]]; do
	kill -0 "$emulator_pid" 2>/dev/null || fail "Emulator exited (see emulator.log)"
	(( SECONDS < boot_deadline )) || fail "Emulator boot exceeded 180s"
	sleep 2
done
adb shell wm dismiss-keyguard
run_process apk-install.log timeout -k 10s 120s "$adb_bin" -s "$serial" install -r "$apk"

cd "$repo_root"
start_process fixture.log bun scripts/ui-parity/fixture-api.ts --port 8796 --host 127.0.0.1
wait_http http://127.0.0.1:8796/health "$started_pid" 30
cd "$repo_root/apps/mobile"
start_process metro.log env CI=1 EXPO_OFFLINE=1 EXPO_NO_DOTENV=1 EXPO_NO_TELEMETRY=1 EXPO_UNSTABLE_HEADLESS=1 \
	__UNSAFE_EXPO_HOME_DIRECTORY="$task_dir/expo-home" EXPO_TOKEN= \
	EXPO_PUBLIC_CLAWDI_ENV=development EXPO_PUBLIC_DEV_AUTH_BYPASS=1 \
	EXPO_PUBLIC_DEV_AUTH_NAME='Avery Chen' EXPO_PUBLIC_DEV_AUTH_EMAIL=avery@clawdi.dev \
	EXPO_PUBLIC_DEV_AUTH_TOKEN=dev-bypass \
	EXPO_PUBLIC_CLAWDI_API_URL=http://10.0.2.2:8796 \
	EXPO_PUBLIC_CLAWDI_COMPUTE_API_URL=http://10.0.2.2:8796 \
	EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY= EXPO_PUBLIC_SENTRY_DSN= \
	EXPO_PUBLIC_REVENUECAT_APPLE_KEY= EXPO_PUBLIC_REVENUECAT_GOOGLE_KEY= \
	EXPO_PUBLIC_CLAWDI_LINK_HOSTS= EAS_PROJECT_ID= \
	./node_modules/.bin/expo start --dev-client --localhost --port 8096 --max-workers 1
wait_http http://127.0.0.1:8096/status "$started_pid" 120
adb reverse tcp:8096 tcp:8096

# SDK 57's official dev-client URL loads both JS and Constants.expoConfig
# from this Metro instance, so the fixture origin is not baked into the APK.
dev_client_url='exp+clawdi://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8096&disableOnboarding=1&disableAutoLaunch=1&disableFab=1'
echo "SKIP signin-screen: Clerk native AuthView needs a live Clerk instance; no accounts used." | tee "$output/signin-screen.skip.txt"
echo "Running Maestro smoke (maximum 10 minutes)"
start_process maestro.log timeout -k 20s 600s "$maestro" --device "$serial" test \
	--format junit --output "$output/junit.xml" --test-output-dir "$output/maestro" --debug-output "$output/maestro-debug" \
	-e APP_ID="$app_id" -e DEV_CLIENT_URL="$dev_client_url" \
	"$repo_root/apps/mobile/.maestro/smoke.yaml"
maestro_pid=$started_pid
if wait "$maestro_pid"; then
	cat "$output/maestro.log"
	echo "PASS: fixture launch, all tabs, details and settings"
else
	status=$?
	cat "$output/maestro.log"
	adb exec-out screencap -p >"$output/failure.png" || true
	exit "$status"
fi
