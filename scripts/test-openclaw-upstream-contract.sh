#!/usr/bin/env bash
# Upstream OpenClaw adapter contract.
#
# Installs the latest OpenClaw from the official, unpinned installer exactly as
# a new Hosted Agent does, as the non-root runtime user, inside a disposable
# container, then runs the CLI adapter contract against that install.
#
# Usage: scripts/test-openclaw-upstream-contract.sh [bun test args...]
#
# Set CLAWDI_QUALIFICATION_OPENCLAW_VERSION to qualify a specific published
# version (for example 2026.10.6). Scheduled and pull-request runs leave this
# unset so they always test the installer's current release.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
fixture_dir="$repo_root/packages/cli/tests/fixtures/openclaw-upstream-contract"
contract_test="tests/e2e/openclaw-upstream-contract.e2e.test.ts"
report_dir="/tmp/openclaw-upstream-contract"
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

	local installer_url openclaw_install_args=()
	installer_url="$(cd packages/cli && bun --eval \
		'import { OFFICIAL_INSTALL_URLS } from "./src/runtime/manifest-contract"; console.log(OFFICIAL_INSTALL_URLS.openclaw)')"
	(cd packages/cli && bun --eval \
		'import { officialInstallArgs } from "./src/runtime/manifest-contract"; for (const arg of officialInstallArgs("openclaw", process.env.HOME ?? "")) process.stdout.write(`${arg}\0`);') \
		>"$report_dir/install-args"
	mapfile -d '' openclaw_install_args <"$report_dir/install-args"
	if [[ -z "$installer_url" || "${#openclaw_install_args[@]}" -eq 0 ]]; then
		report_failure "CLI source did not provide the official OpenClaw installer" /dev/null
		return 1
	fi
	printf 'installer=%s %s\n' "$installer_url" "${openclaw_install_args[*]}" >"$report_dir/identity"

	if [[ -n "${CLAWDI_QUALIFICATION_OPENCLAW_VERSION:-}" ]]; then
		export OPENCLAW_VERSION="$CLAWDI_QUALIFICATION_OPENCLAW_VERSION"
	fi
	printf 'requested_version=%s\n' "${OPENCLAW_VERSION:-latest}" >>"$report_dir/identity"

	local installer="$report_dir/install.sh"
	local started=$SECONDS
	echo "Installing upstream OpenClaw from $installer_url (${OPENCLAW_VERSION:-latest})"
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
			bash "$installer" "${openclaw_install_args[@]}") >>"$report_dir/install.log" 2>&1; then
		record_identity
		grep -v '%  ' "$report_dir/install.log" | tail -60 >&2
		report_failure "Official OpenClaw installer failed" "$report_dir/install.log"
		return 1
	fi
	echo "Installed upstream OpenClaw in $((SECONDS - started))s"
	record_identity

	local status=0
	(
		cd packages/cli
		CLAWDI_TEST_OPENCLAW_UPSTREAM_CONTRACT=1 bun test --timeout 180000 "$@" "$contract_test"
	) 2>&1 | tee "$report_dir/contract.log" || status=$?
	if [[ "$status" -ne 0 ]]; then
		report_failure "Adapter contract failed" "$report_dir/contract.log"
		return "$status"
	fi
	report_success
}

record_identity() {
	local node_root="$HOME/.local/tools/node"
	local build_info="$node_root/lib/node_modules/openclaw/dist/build-info.json"
	local version commit node_version
	version="$("$HOME/.local/bin/openclaw" --version 2>/dev/null | head -1 || echo unknown)"
	commit="$("$node_root/bin/node" -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).commit || "unknown")' \
		"$build_info" 2>/dev/null || echo unknown)"
	node_version="$("$node_root/bin/node" --version 2>/dev/null || echo unknown)"
	{
		printf 'displayVersion=%s\n' "$version"
		printf 'commit=%s\n' "$commit"
		printf 'nodeVersion=%s\n' "$node_version"
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
		printf '### OpenClaw upstream adapter contract: %s\n\n' "$verdict"
		printf '| | |\n| --- | --- |\n'
		printf '| Installer | `%s` |\n' "$(identity_value installer)"
		if [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then
			printf '| Upstream commit | [`%s`](https://github.com/openclaw/openclaw/commit/%s) |\n' \
				"$commit" "$commit"
		else
			printf '| Upstream commit | `%s` |\n' "${commit:-unknown}"
		fi
		printf '| displayVersion | `%s` |\n' "$(identity_value displayVersion)"
		printf '| Bundled Node | `%s` |\n' "$(identity_value nodeVersion)"
		printf '| Requested version | `%s` |\n\n' "$(identity_value requested_version)"
	} >"$report_dir/summary.md"
}

report_results() {
	local log="$1"
	grep -E '^\((pass|fail|skip)\) ' "$log" 2>/dev/null \
		| sed -E 's/^\((pass|fail|skip)\) upstream OpenClaw adapter contract > /- \1: /' \
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
	if [[ -f "$log" ]]; then report_results "$log"; fi
	if [[ -f "$log" ]]; then
		{
			printf '\n<details><summary>Log tail</summary>\n\n````text\n'
			grep -v '%  ' "$log" | tail -120
			printf '````\n\n</details>\n'
		} >>"$report_dir/summary.md"
	fi
}

if [[ "${1:-}" == "--in-container" ]]; then
	shift
	in_container "$@"
	exit
fi

image="clawdi-openclaw-upstream-contract:local-$$"
container="clawdi-openclaw-upstream-contract-$$"
output_dir="$(mktemp -d)"

cleanup() {
	docker rm -f "$container" >/dev/null 2>&1 || true
	docker image rm "$image" >/dev/null 2>&1 || true
	find "$output_dir" -depth -delete
}
trap cleanup EXIT

load_args=()
if [[ "${DOCKER_BUILD_LOAD:-0}" == "1" ]]; then load_args+=(--load); fi
docker build --quiet "${load_args[@]}" --file "$fixture_dir/Dockerfile" --tag "$image" "$fixture_dir" >/dev/null

status=0
docker run --name "$container" \
	--cpus "${CLAWDI_TEST_RUNNER_CPUS:-2}" \
	--memory "${CLAWDI_TEST_RUNNER_MEMORY_LIMIT:-4g}" \
	--memory-swap "${CLAWDI_TEST_RUNNER_MEMORY_LIMIT:-4g}" \
	--volume "$repo_root:/repo:ro" \
	-e "CLAWDI_QUALIFICATION_OPENCLAW_VERSION=${CLAWDI_QUALIFICATION_OPENCLAW_VERSION:-}" \
	"$image" \
	bash /repo/scripts/test-openclaw-upstream-contract.sh --in-container "$@" || status=$?

if docker cp "$container:$report_dir/." "$output_dir" >/dev/null 2>&1 \
	&& [[ -s "$output_dir/summary.md" ]]; then
	if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
		cat "$output_dir/summary.md" >>"$GITHUB_STEP_SUMMARY"
	else
		printf '\n'
		cat "$output_dir/summary.md"
	fi
fi

commit="$(sed -n 's/^commit=//p' "$output_dir/identity" 2>/dev/null | tail -1)"
version="$(sed -n 's/^displayVersion=//p' "$output_dir/identity" 2>/dev/null | tail -1)"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
	{
		printf 'commit=%s\n' "${commit:-unknown}"
		printf 'display_version=%s\n' "${version:-unknown}"
	} >>"$GITHUB_OUTPUT"
fi
if [[ "$status" -ne 0 && -n "${GITHUB_ACTIONS:-}" ]]; then
	echo "::error title=OpenClaw upstream adapter contract failed::Latest official OpenClaw install (commit ${commit:-unknown}, displayVersion ${version:-unknown}) breaks the Clawdi CLI adapter. See the job summary."
fi
exit "$status"
