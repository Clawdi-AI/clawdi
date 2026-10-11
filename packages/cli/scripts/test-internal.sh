#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
package_root="$(cd -- "$script_dir/.." && pwd)"
cd "$package_root"

test_args=(--isolate --max-concurrency=1 --timeout=30000)
test_jobs="${CLAWDI_CLI_TEST_JOBS:-1}"
if [[ ! "$test_jobs" =~ ^[1-8]$ ]]; then
	echo "CLAWDI_CLI_TEST_JOBS must be an integer from 1 to 8" >&2
	exit 2
fi

hermes_fixture_needed=false
if [[ $# -eq 0 ]]; then hermes_fixture_needed=true; fi
for test_arg in "$@"; do
	case "$test_arg" in
		src|src/|src/runtime|src/runtime/|tests|tests/|tests/runtime-*.test.ts|*hosted-hermes-skill*|*hosted-skill-observation*|*manifest-reconciliation*|*hermes-managed-env*|--test-name-pattern*|-t)
			hermes_fixture_needed=true
			;;
	esac
done
if [[ "$hermes_fixture_needed" == true && -z "${CLAWDI_TEST_HERMES_VENV:-}" ]]; then
	source "$script_dir/prepare-hermes-native-fixture.sh"
fi

if [[ $# -gt 0 ]]; then
	bun test "${test_args[@]}" "$@"
	exit $?
fi

# Bun 1.4.0 can leave an otherwise completed multi-file suite idle after a
# test launches child work, including through production helpers. Use each test
# file as the process boundary. The clean-runner contract has its own CI gate.
started_at=$SECONDS
test_output="$(mktemp -d "${TMPDIR:-/tmp}/clawdi-cli-tests.XXXXXX")"
trap 'rm -rf "$test_output"; if [[ -n "${hermes_fixture_root:-}" ]]; then rm -rf "$hermes_fixture_root"; fi' EXIT
test_files=()
while IFS= read -r test_file; do test_files+=("$test_file"); done < <(
	find src tests -type f \
		\( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' \) \
		! -path 'tests/clean-test-runner.test.ts' \
		-print | LC_ALL=C sort
)

if (( ${#test_files[@]} == 0 )); then
	echo "CLI test suite has no files" >&2
	exit 2
fi

# Process isolation preserves file-local env/global mocks; tests within a file
# remain serial. Buffer each file's output so parallel logs remain readable.
printf '\n==> CLI tests: %d files, %d workers\n' "${#test_files[@]}" "$test_jobs"
test_status=0
printf '%s\0' "${test_files[@]}" | xargs -0 -n 1 -P "$test_jobs" bash -c '
	output_root=$1
	shift
	test_file=${!#}
	log="$output_root/$test_file.log"
	mkdir -p -- "$(dirname -- "$log")"
	status=0
	bun test "$@" </dev/null > "$log" 2>&1 || status=$?
	if (( status != 0 )); then printf "\nFAILED: %s (exit %d)\n" "$test_file" "$status" >&2; fi
	exit "$status"
' cli-test "$test_output" "${test_args[@]}" || test_status=$?

for test_file in "${test_files[@]}"; do
	printf '\n--> %s\n' "$test_file"
	cat "$test_output/$test_file.log"
done
printf '\n<== CLI tests: %d files, %d workers, %ds\n' "${#test_files[@]}" "$test_jobs" "$((SECONDS - started_at))"
exit "$test_status"
