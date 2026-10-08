#!/usr/bin/env bash
# Service hooks for the official EAS Maestro job; EAS owns the device and build.
set -euo pipefail

fail() { echo "mobile-e2e-eas: $*" >&2; exit 1; }
[[ ${EAS_BUILD_RUNNER:-} == eas-build ]] || fail "Run only on an EAS cloud worker"
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
output=$repo_root/test-results/mobile-e2e-eas
runtime=$output/runtime
platform=${2:-android}
case $platform in
	android) fixture_host=10.0.2.2 ;;
	ios) fixture_host=127.0.0.1 ;;
	*) fail "Unsupported platform: $platform" ;;
esac

stop_services() {
	local pid attempt alive
	local -a pids
	[[ -f $runtime/pids ]] || return 0
	pids=()
	while IFS= read -r pid; do pids+=("$pid"); done < "$runtime/pids"
	# Bash 3.2 treats an empty array as unset under nounset.
	if (( ${#pids[@]} == 0 )); then
		rm -rf "$runtime"
		return 0
	fi
	for pid in "${pids[@]}"; do
		[[ $pid =~ ^[0-9]+$ && $pid -gt 1 ]] || fail "Invalid owned service PID"
		kill -TERM -- "-$pid" 2>/dev/null || true
	done
	for (( attempt=0; attempt<10; attempt++ )); do
		alive=0
		for pid in "${pids[@]}"; do
			if kill -0 -- "-$pid" 2>/dev/null; then alive=1; fi
		done
		(( alive )) || break
		sleep 1
	done
	for pid in "${pids[@]}"; do
		kill -KILL -- "-$pid" 2>/dev/null || true
	done
	if [[ -f $runtime/metro-reverse ]]; then
		timeout -k 5s 15s adb -e reverse --remove tcp:8096 || true
	fi
	rm -rf "$runtime"
}

case ${1:-} in
	stop) stop_services; exit 0 ;;
	start) ;;
	*) fail "Usage: scripts/mobile-e2e-eas.sh <start|stop> [android|ios]" ;;
esac

tools=(bun node curl python3)
if [[ $platform == android ]]; then
	tools+=(timeout setsid adb)
else
	[[ $(uname -s) == Darwin ]] || fail "iOS services require an EAS macOS worker"
fi
for tool in "${tools[@]}"; do
	command -v "$tool" >/dev/null || fail "Missing worker tool: $tool"
done
[[ $(bun --version) == 1.4.2 ]] || fail "Use the repository's Bun 1.4.2"
[[ -d $repo_root/node_modules ]] || fail "Install frozen workspace dependencies first"
# Android uses its host alias; the iOS Simulator shares the worker's loopback.
# Refuse occupied ports; never connect to another job's API or Metro server.
python3 - <<'PY'
import socket
for port in (8796, 8096):
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", port))
PY
mkdir -p "$output/logs"
mkdir "$runtime" || fail "Services already started; stop the owned run first"
: > "$runtime/pids"
mkdir "$runtime/tmp"
export TMPDIR=$runtime/tmp
trap '
	if (( $? != 0 )); then
		# A failed before hook skips after hooks, including artifact uploads.
		for log in fixture metro; do
			if [[ -f $output/logs/$log.log ]]; then
				printf "\n--- %s.log (last 80 lines) ---\n" "$log" >&2
				tail -n 80 "$output/logs/$log.log" >&2 || true
			fi
		done
		stop_services || true
	fi
' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start_service() {
	local log=$1; shift
	# Separate process groups survive the hook shell; timeout bounds cancellation
	# residue even if EAS cannot reach the after hook. Logs never inherit its pipe.
	if [[ $platform == android ]]; then
		setsid timeout -k 15s 1200s "$@" > "$output/logs/$log" 2>&1 < /dev/null &
	else
		# Stock macOS has neither setsid nor GNU timeout. Python provides the
		# same owned process group and 20-minute limit without installing tools.
		python3 - "$@" > "$output/logs/$log" 2>&1 <<'PY' &
import os
import signal
import subprocess
import sys
import time

os.setsid()

def stop_services(signum=None, frame=None):
    if signum == signal.SIGALRM:
        print("Service exceeded its 20-minute lifetime", file=sys.stderr, flush=True)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    os.killpg(os.getpid(), signal.SIGTERM)
    time.sleep(15)
    os.killpg(os.getpid(), signal.SIGKILL)

for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM):
    signal.signal(sig, stop_services)
signal.alarm(1200)
try:
    process = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL)
    result = process.wait()
    print(f"Service exited with status {result}", file=sys.stderr, flush=True)
except OSError as error:
    print(f"Could not start service: {error}", file=sys.stderr)
finally:
    stop_services()
PY
	fi
	started_pid=$!
	printf '%s\n' "$started_pid" >> "$runtime/pids"
}
wait_http() {
	local url=$1 pid=$2 deadline=$((SECONDS + $3))
	while (( SECONDS < deadline )); do
		kill -0 "$pid" 2>/dev/null || fail "Service exited before readiness; see worker logs"
		if curl --fail --silent --max-time 2 "$url" >/dev/null; then return; fi
		sleep 2
	done
	fail "Service readiness timed out: $url"
}

cd "$repo_root"
start_service fixture.log bun scripts/ui-parity/fixture-api.ts --port 8796 --host 127.0.0.1
wait_http http://127.0.0.1:8796/health "$started_pid" 30
cd "$repo_root/apps/mobile"
# Match the local smoke: development-only identity, isolated Expo state and no
# external auth, billing or observability. Metro supplies config and JS to the app.
# These Expo isolation knobs are implemented in SDK 57 (see mobile-e2e.sh).
start_service metro.log env CI=1 EXPO_OFFLINE=1 EXPO_NO_DOTENV=1 EXPO_NO_TELEMETRY=1 EXPO_UNSTABLE_HEADLESS=1 \
	__UNSAFE_EXPO_HOME_DIRECTORY="$runtime/expo-home" EXPO_TOKEN= \
	EXPO_PUBLIC_CLAWDI_ENV=development EXPO_PUBLIC_DEV_AUTH_BYPASS=1 \
	EXPO_PUBLIC_DEV_AUTH_NAME='Avery Chen' EXPO_PUBLIC_DEV_AUTH_EMAIL=avery@clawdi.dev \
	EXPO_PUBLIC_DEV_AUTH_TOKEN=dev-bypass \
	EXPO_PUBLIC_CLAWDI_API_URL="http://$fixture_host:8796" \
	EXPO_PUBLIC_CLAWDI_COMPUTE_API_URL="http://$fixture_host:8796" \
	EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY= EXPO_PUBLIC_SENTRY_DSN= \
	EXPO_PUBLIC_REVENUECAT_APPLE_KEY= EXPO_PUBLIC_REVENUECAT_GOOGLE_KEY= \
	EXPO_PUBLIC_CLAWDI_LINK_HOSTS= EAS_PROJECT_ID= \
	./node_modules/.bin/expo start --dev-client --localhost --port 8096 --max-workers 1
wait_http http://127.0.0.1:8096/status "$started_pid" 120
echo "SKIP: live Clerk AuthView requires a registered real instance." > "$output/logs/signin-screen.skip.txt"

if [[ $platform == ios ]]; then
	# The same localhost dev-client URL reaches Metro directly on the Simulator.
	# Maestro's openLink launches the EAS-installed app; no adb rule is needed.
	echo "Fixture and Metro ready; EAS can run .maestro/smoke.yaml"
	exit 0
fi

# before_maestro_tests runs after EAS boots its emulator and installs the APK.
# Only select that single emulator; do not start or stop adb/the emulator here.
timeout -k 5s 15s adb -e reverse tcp:8096 tcp:8096
: > "$runtime/metro-reverse"
component=$(timeout -k 5s 15s adb -e shell cmd package resolve-activity --brief \
	-a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ai.clawdi.app | tr -d '\r' | tail -n 1)
[[ $component =~ ^ai\.clawdi\.app/[A-Za-z0-9._]+$ ]] || fail "Development APK has no launchable activity"
timeout -k 5s 15s adb -e shell pm clear ai.clawdi.app > "$output/logs/app-clear.log"
timeout -k 5s 30s adb -e shell am start -W -n "$component" > "$output/logs/app-start.log"
deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
	state=$(timeout -k 5s 10s adb -e shell dumpsys activity activities)
	if grep -E 'mResumedActivity|topResumedActivity' <<< "$state" | grep -F 'expo.modules.devlauncher.launcher.DevLauncherActivity' >/dev/null; then
		printf '%s\n' "$state" > "$output/logs/dev-launcher-ready.log"
		echo "Fixture and Metro ready; EAS can run .maestro/smoke.yaml"
		exit 0
	fi
	sleep 2
done
fail "Development launcher readiness exceeded 120s"
