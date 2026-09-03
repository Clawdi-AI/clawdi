#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
package_root="$(cd -- "$script_dir/.." && pwd)"
cd "$package_root"

test_args=(--isolate --max-concurrency=1 --timeout=30000)

if [[ $# -gt 0 ]]; then
	exec bun test "${test_args[@]}" "$@"
fi

run_suite() {
	local name="$1"
	shift
	if [[ $# -eq 0 ]]; then
		echo "CLI test suite '$name' has no files" >&2
		return 2
	fi
	local started_at=$SECONDS
	printf '\n==> CLI tests: %s\n' "$name"
	for test_file in "$@"; do
		printf '\n--> %s\n' "$test_file"
		bun test "${test_args[@]}" "$test_file"
	done
	printf '<== CLI tests: %s (%d files, %ds)\n' "$name" "$#" "$((SECONDS - started_at))"
}

# Bun 1.4.0 can leave an otherwise completed multi-file suite idle after a
# test launches child work, including through production helpers. Use each test
# file as the process boundary while retaining mutually exclusive serial shards.
runtime_tests=()
source_tests=()
command_tests=()
integration_tests=()

while IFS= read -r test_file; do
	test_file="${test_file#./}"
	case "$test_file" in
		src/runtime/*) runtime_tests+=("$test_file") ;;
		src/*) source_tests+=("$test_file") ;;
		tests/commands/*) command_tests+=("$test_file") ;;
		tests/*) integration_tests+=("$test_file") ;;
		*)
			echo "Unclassified CLI test file: $test_file" >&2
			exit 2
			;;
	esac
done < <(
	find src tests -type f \
		\( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' \) \
		-print | LC_ALL=C sort
)

run_suite "runtime" "${runtime_tests[@]}"
run_suite "source" "${source_tests[@]}"
run_suite "commands" "${command_tests[@]}"
run_suite "integration" "${integration_tests[@]}"
