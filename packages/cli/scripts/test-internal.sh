#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
package_root="$(cd -- "$script_dir/.." && pwd)"
cd "$package_root"

test_args=(--isolate --max-concurrency=1 --timeout=30000)

if [[ $# -gt 0 ]]; then
	exec bun test "${test_args[@]}" "$@"
fi

# Bun 1.4.0 can leave an otherwise completed multi-file suite idle after a
# test launches child work, including through production helpers. Use each test
# file as the process boundary. The clean-runner contract has its own CI gate.
started_at=$SECONDS
test_count=0

while IFS= read -r test_file; do
	test_count=$((test_count + 1))
	printf '\n--> %s\n' "$test_file"
	bun test "${test_args[@]}" "$test_file" </dev/null
done < <(
	find src tests -type f \
		\( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' \) \
		! -path 'tests/clean-test-runner.test.ts' \
		-print | LC_ALL=C sort
)

if (( test_count == 0 )); then
	echo "CLI test suite has no files" >&2
	exit 2
fi

printf '\n<== CLI tests: %d files, %ds\n' "$test_count" "$((SECONDS - started_at))"
