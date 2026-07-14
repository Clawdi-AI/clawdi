#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"

spec_source="${1:-${DEPLOY_OPENAPI_SOURCE:-http://localhost:50021/openapi.json}}"
output_path="${2:-$repo_root/packages/shared/src/api/deploy.generated.ts}"

read_spec() {
	case "$spec_source" in
		http://*|https://*)
			curl --fail --silent --show-error --location "$spec_source"
			;;
		*)
			cat "$spec_source"
			;;
	esac
}

read_spec \
	| python3 "$script_dir/filter-deploy-openapi.py" \
	| "$script_dir/openapi-typescript.sh" /dev/stdin -o "$output_path"
