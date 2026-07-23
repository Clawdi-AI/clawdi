#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"

spec_source="${DEPLOY_OPENAPI_SOURCE:-https://api.clawdi.ai/openapi.json}"
fetch_mode="${DEPLOY_CONTRACT_FETCH_MODE:-warn}"
committed_path="$repo_root/packages/shared/src/api/deploy.generated.ts"

case "$fetch_mode" in
	warn|strict) ;;
	*)
		echo "Unsupported DEPLOY_CONTRACT_FETCH_MODE: $fetch_mode" >&2
		exit 2
		;;
esac

warn() {
	local message="$1"
	if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
		printf '::warning title=Hosted deploy contract check skipped::%s\n' "$message"
	fi
	echo "$message" >&2
}

tempdir="$(mktemp -d "${TMPDIR:-/tmp}/clawdi-deploy-openapi.XXXXXX")"
trap "rm -rf -- '$tempdir'" EXIT

raw_spec="$tempdir/openapi.json"
expected_path="$tempdir/deploy.generated.ts"

case "$spec_source" in
	http://*|https://*)
		if ! curl \
			--fail \
			--silent \
			--show-error \
			--location \
			--connect-timeout "${DEPLOY_OPENAPI_CONNECT_TIMEOUT:-5}" \
			--max-time "${DEPLOY_OPENAPI_MAX_TIME:-20}" \
			--retry "${DEPLOY_OPENAPI_RETRY:-2}" \
			--retry-delay "${DEPLOY_OPENAPI_RETRY_DELAY:-1}" \
			--retry-all-errors \
			"$spec_source" \
			>"$raw_spec"; then
			message="Unable to fetch hosted OpenAPI from $spec_source."
			if [[ "$fetch_mode" == "warn" ]]; then
				warn "$message Skipping drift check for this run."
				exit 0
			fi
			echo "$message" >&2
			exit 1
		fi
		;;
	*)
		cat "$spec_source" >"$raw_spec"
		;;
esac

if ! bun -e '
	const path = process.argv[1];
	try {
		const document = await Bun.file(path).json();
		if (typeof document?.openapi !== "string") process.exit(1);
	} catch {
		process.exit(1);
	}
' "$raw_spec"; then
	message="Hosted OpenAPI from $spec_source was not a valid OpenAPI document."
	if [[ "$fetch_mode" == "warn" ]]; then
		warn "$message Skipping drift check for this run."
		exit 0
	fi
	echo "$message" >&2
	exit 1
fi

if ! "$script_dir/generate-deploy-api.sh" "$raw_spec" "$expected_path"; then
	message="Unable to generate the deploy client from hosted OpenAPI at $spec_source."
	if [[ "$fetch_mode" == "warn" ]]; then
		warn "$message Skipping drift check for this run."
		exit 0
	fi
	echo "$message" >&2
	exit 1
fi

if cmp -s "$committed_path" "$expected_path"; then
	exit 0
fi

diff -u "$committed_path" "$expected_path" || true
echo \
	"packages/shared/src/api/deploy.generated.ts is stale. Regenerate with \`DEPLOY_OPENAPI_SOURCE=$spec_source bun --cwd apps/web run generate-deploy-api\` and commit the result." \
	>&2
exit 1
