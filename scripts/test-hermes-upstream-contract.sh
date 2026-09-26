#!/usr/bin/env bash
# Upstream Hermes adapter contract.
#
# Installs the latest Hermes from the official, unpinned installer exactly as a
# new Hosted Agent does, as the non-root runtime user, inside a disposable
# container, then runs the CLI adapter contract against that install.
#
# Usage: scripts/test-hermes-upstream-contract.sh [bun test args...]
#
# The Markdown report is appended to $GITHUB_STEP_SUMMARY when set and printed
# otherwise.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
fixture_dir="$repo_root/packages/cli/tests/fixtures/hermes-upstream-contract"
contract_test="tests/e2e/hermes-upstream-contract.e2e.test.ts"
report_dir="/tmp/hermes-upstream-contract"
# Arguments Hosted passes to the official installer for every new Hermes Agent.
hermes_install_args=(--skip-setup --skip-browser --non-interactive)
# The CLI hands official installers the system trust store (manifest-install.ts).
system_ca_bundle="/etc/ssl/certs/ca-certificates.crt"

in_container() {
	local work_dir="/work/clawdi"
	mkdir -p "$report_dir" "$work_dir"
	: >"$report_dir/summary.md"

	tar -C /repo \
		--exclude=./.git \
		--exclude=./.paseo \
		--exclude=node_modules \
		--exclude=.turbo \
		-cf - . | tar -C "$work_dir" -xf -
	cd "$work_dir"
	bun install --frozen-lockfile --ignore-scripts >"$report_dir/bun-install.log" 2>&1 || {
		tail -40 "$report_dir/bun-install.log" >&2
		report_failure "Workspace dependency install failed" "$report_dir/bun-install.log"
		return 1
	}

	local installer_url
	installer_url="$(cd packages/cli && bun --eval \
		'import { OFFICIAL_INSTALL_URLS } from "./src/runtime/manifest-contract"; console.log(OFFICIAL_INSTALL_URLS.hermes)')"
	printf 'installer=%s %s\n' "$installer_url" "${hermes_install_args[*]}" >"$report_dir/identity"

	local installer="$report_dir/install.sh"
	local started=$SECONDS
	echo "Installing upstream Hermes from $installer_url"
	if ! curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$installer" "$installer_url" \
		>"$report_dir/install.log" 2>&1 \
		|| ! (cd "$HOME" && env \
			PATH="$HOME/.local/bin:$PATH" \
			SSL_CERT_FILE="$system_ca_bundle" \
			NODE_EXTRA_CA_CERTS="$system_ca_bundle" \
			REQUESTS_CA_BUNDLE="$system_ca_bundle" \
			CURL_CA_BUNDLE="$system_ca_bundle" \
			GIT_SSL_CAINFO="$system_ca_bundle" \
			NPM_CONFIG_CAFILE="$system_ca_bundle" \
			bash "$installer" "${hermes_install_args[@]}") >>"$report_dir/install.log" 2>&1; then
		record_identity
		grep -v '%  ' "$report_dir/install.log" | tail -60 >&2
		report_failure "Official Hermes installer failed" "$report_dir/install.log"
		return 1
	fi
	echo "Installed upstream Hermes in $((SECONDS - started))s"
	record_identity

	local status=0
	(
		cd packages/cli
		CLAWDI_TEST_HERMES_UPSTREAM_CONTRACT=1 bun test --timeout 120000 "$@" "$contract_test"
	) 2>&1 | tee "$report_dir/contract.log" || status=$?
	if [[ "$status" -ne 0 ]]; then
		report_failure "Adapter contract failed" "$report_dir/contract.log"
		return "$status"
	fi
	report_success
}

record_identity() {
	local app_root="$HOME/.hermes/hermes-agent"
	local commit display_version layout
	commit="$(git -C "$app_root" rev-parse HEAD 2>/dev/null || echo unknown)"
	display_version="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("displayVersion") or "unknown")' \
		"$app_root/install-stamp.json" 2>/dev/null || echo unknown)"
	if [[ -x "$app_root/venv/bin/python" ]]; then
		layout="in-tree venv"
	elif [[ -d "$HOME/.hermes/installs" ]]; then
		layout="package manager (committed environments)"
	else
		layout="unknown"
	fi
	{
		printf 'commit=%s\n' "$commit"
		printf 'displayVersion=%s\n' "$display_version"
		printf 'layout=%s\n' "$layout"
	} >>"$report_dir/identity"
}

identity_value() {
	sed -n "s/^$1=//p" "$report_dir/identity" 2>/dev/null | tail -1
}

report_header() {
	local verdict="$1"
	local commit
	commit="$(identity_value commit)"
	{
		printf '### Hermes upstream adapter contract: %s\n\n' "$verdict"
		printf '| | |\n| --- | --- |\n'
		printf '| Installer | `%s` |\n' "$(identity_value installer)"
		if [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then
			printf '| Upstream commit | [`%s`](https://github.com/NousResearch/hermes-agent/commit/%s) |\n' \
				"$commit" "$commit"
		else
			printf '| Upstream commit | `%s` |\n' "${commit:-unknown}"
		fi
		printf '| displayVersion | `%s` |\n' "$(identity_value displayVersion)"
		printf '| Layout | %s |\n\n' "$(identity_value layout)"
	} >"$report_dir/summary.md"
}

report_results() {
	local log="$1"
	grep -E '^\((pass|fail|skip)\) ' "$log" 2>/dev/null \
		| sed -E 's/^\((pass|fail|skip)\) upstream Hermes adapter contract > /- \1: /' \
		>>"$report_dir/summary.md" || true
}

report_success() {
	report_header "PASS"
	report_results "$report_dir/contract.log"
}

report_failure() {
	local stage="$1" log="$2"
	report_header "FAIL"
	printf '**%s.**\n\n' "$stage" >>"$report_dir/summary.md"
	report_results "$log"
	{
		printf '\n<details><summary>Log tail</summary>\n\n````text\n'
		grep -v '%  ' "$log" | tail -120
		printf '````\n\n</details>\n'
	} >>"$report_dir/summary.md"
}

if [[ "${1:-}" == "--in-container" ]]; then
	shift
	in_container "$@"
	exit
fi

image="clawdi-hermes-upstream-contract:local-$$"
container="clawdi-hermes-upstream-contract-$$"
output_dir="$(mktemp -d)"

cleanup() {
	docker rm -f "$container" >/dev/null 2>&1 || true
	docker image rm "$image" >/dev/null 2>&1 || true
	rm -rf "$output_dir"
}
trap cleanup EXIT

docker build --quiet --file "$fixture_dir/Dockerfile" --tag "$image" "$fixture_dir" >/dev/null

status=0
docker run --name "$container" \
	--volume "$repo_root:/repo:ro" \
	"$image" \
	bash /repo/scripts/test-hermes-upstream-contract.sh --in-container "$@" || status=$?

if docker cp "$container:$report_dir/." "$output_dir" >/dev/null 2>&1 \
	&& [[ -s "$output_dir/summary.md" ]]; then
	if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
		cat "$output_dir/summary.md" >>"$GITHUB_STEP_SUMMARY"
	else
		printf '\n'
		cat "$output_dir/summary.md"
	fi
fi

if [[ "$status" -ne 0 && -n "${GITHUB_ACTIONS:-}" ]]; then
	commit="$(sed -n 's/^commit=//p' "$output_dir/identity" 2>/dev/null | tail -1)"
	version="$(sed -n 's/^displayVersion=//p' "$output_dir/identity" 2>/dev/null | tail -1)"
	echo "::error title=Hermes upstream adapter contract failed::Latest official Hermes install (commit ${commit:-unknown}, displayVersion ${version:-unknown}) breaks the Clawdi CLI adapter. See the job summary."
fi
exit "$status"
