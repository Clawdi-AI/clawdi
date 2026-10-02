#!/usr/bin/env bash
set -euo pipefail

mkdir -p "$HOME" /work
if [[ "$PROBE_PROFILE" == verify-source ]]; then
	for script in /probe/*.mjs; do node --check "$script"; done
	bash -n /probe/run.sh /probe/container.sh
	cp /repo-biome.json /work/biome.json
	cp /probe/*.mjs /work/
	cp -R /probe/fixture /work/fixture
	bun x @biomejs/biome@2.5.14 check --config-path=/work/biome.json --vcs-enabled=false \
		/work/*.mjs /work/fixture/*.json /work/fixture/*.ts /work/fixture/app/*.tsx \
		/work/fixture/*.cjs /work/fixture/global.css 2>&1 | tee /output/verification.log
	exit
fi
cp -R /probe/fixture/. /work/
cd /work
printf 'Node %s; Bun %s; profile %s\n' "$(node --version)" "$(bun --version)" "$PROBE_PROFILE"
node /probe/registry.mjs /work/package.json /output/registry.json

if [[ "$PROBE_PROFILE" == supported-diagnostic ]]; then
	node /probe/supported.mjs /work/package.json /output/diagnostic-overrides.json
fi

if [[ -f "/probe/evidence/$PROBE_PROFILE.bun.lock" ]]; then
	cp "/probe/evidence/$PROBE_PROFILE.bun.lock" /work/bun.lock
fi

run_check() {
	local name="$1"
	shift
	local status=0
	timeout --signal=TERM --kill-after=15s 7m "$@" >"/output/$name.log" 2>&1 || status=$?
	printf '%s\t%s\n' "$name" "$status" >> /output/status.tsv
	printf '\n=== %s (exit %s) ===\n' "$name" "$status"
	tail -n 28 "/output/$name.log"
	return "$status"
}

: > /output/status.tsv
if [[ -f /work/bun.lock ]]; then
	run_check install bun install --frozen-lockfile --ignore-scripts
else
	run_check install bun install --ignore-scripts
fi
cp bun.lock "/output/$PROBE_PROFILE.bun.lock"
run_check frozen-reinstall bun install --frozen-lockfile --ignore-scripts
node /probe/audit.mjs /output/audit.json
run_check expo-dependencies node node_modules/expo/bin/cli install --check || true
run_check expo-polyfills node -e 'const config = require("./metro.config.cjs"); console.log(config.serializer.getPolyfills({ platform: "ios" }))' || true
run_check generate-uniwind-types node -e 'require("./metro.config.cjs")' || true
run_check typecheck node node_modules/typescript/bin/tsc --noEmit || true
run_check typecheck-official-wrapper node node_modules/typescript/bin/tsc --project tsconfig.contracts.json --noEmit || true
run_check metro-ios node node_modules/expo/bin/cli export --platform ios --max-workers 2 --output-dir dist/ios || true
run_check metro-android node node_modules/expo/bin/cli export --platform android --max-workers 2 --output-dir dist/android || true
node /probe/summarize.mjs /output "$PROBE_PROFILE"
