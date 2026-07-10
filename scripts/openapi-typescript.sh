#!/usr/bin/env bash
set -euo pipefail

tool_dir="${OPENAPI_TYPESCRIPT_TOOL_DIR:-}"
cleanup_tool_dir=false
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
manifest_dir="${OPENAPI_TYPESCRIPT_MANIFEST_DIR:-$script_dir/../tools/openapi-typescript}"

if [[ $# -eq 0 ]]; then
	echo "Usage: scripts/openapi-typescript.sh <schema> [openapi-typescript args...]" >&2
	exit 2
fi

if [[ -z "$tool_dir" ]]; then
	tool_dir="$(mktemp -d "${TMPDIR:-/tmp}/clawdi-openapi-typescript.XXXXXX")"
	cleanup_tool_dir=true
fi

cleanup() {
	if [[ "$cleanup_tool_dir" == true ]]; then
		rm -rf "$tool_dir"
	fi
}
trap cleanup EXIT

export HOME="${OPENAPI_TYPESCRIPT_HOME:-$tool_dir/home}"
export BUN_INSTALL_CACHE_DIR="${BUN_INSTALL_CACHE_DIR:-$tool_dir/.bun-cache}"
export BUN_TMPDIR="${BUN_TMPDIR:-$tool_dir/.bun-tmp}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$tool_dir/.cache}"
mkdir -p "$tool_dir" "$HOME" "$BUN_INSTALL_CACHE_DIR" "$BUN_TMPDIR" "$XDG_CACHE_HOME"

args=("$@")
if [[ "${args[0]:-}" == "/dev/stdin" || "${args[0]:-}" == "-" ]]; then
	stdin_schema="$tool_dir/stdin-openapi.json"
	cat >"$stdin_schema"
	args[0]="$stdin_schema"
fi

if [[ ! -x "$tool_dir/node_modules/.bin/openapi-typescript" ]]; then
	cp "$manifest_dir/package.json" "$tool_dir/package.json"
	cp "$manifest_dir/bun.lock" "$tool_dir/bun.lock"
	(
		cd "$tool_dir"
		bun install --frozen-lockfile --silent --ignore-scripts </dev/null
	)
fi

"$tool_dir/node_modules/.bin/openapi-typescript" "${args[@]}"
