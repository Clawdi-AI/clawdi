#!/usr/bin/env bash
set -euo pipefail

readonly FIXTURE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "${FIXTURE_ROOT}/versions.env"

if [[ "$#" -ne 1 || -z "$1" ]]; then
	echo "usage: $0 ARTIFACT_DIRECTORY" >&2
	exit 2
fi

readonly ARTIFACT_ROOT="$1"
mkdir -p "${ARTIFACT_ROOT}"

sha256_digest() {
	openssl dgst -sha256 "$1" | awk '{print $NF}'
}

sha512_integrity() {
	printf 'sha512-%s\n' "$(openssl dgst -sha512 -binary "$1" | openssl base64 -A)"
}

has_sha256() {
	[[ -f "$1" && "$(sha256_digest "$1")" == "$2" ]]
}

has_sha512_integrity() {
	[[ -f "$1" && "$(sha512_integrity "$1")" == "$2" ]]
}

download() {
	local url="$1"
	local destination="$2"
	shift 2
	local temporary
	temporary="$(mktemp "${ARTIFACT_ROOT}/.download.XXXXXX")"
	trap 'rm -f "${temporary}"' RETURN
	curl \
		--fail \
		--silent \
		--show-error \
		--location \
		--connect-timeout 20 \
		--max-time 300 \
		--retry 4 \
		--retry-all-errors \
		--retry-delay 2 \
		--user-agent "clawdi-managed-whatsapp-native-e2e" \
		"$@" \
		"${url}" \
		--output "${temporary}"
	mv "${temporary}" "${destination}"
	trap - RETURN
}

readonly OPENCLAW_TARBALL="${ARTIFACT_ROOT}/openclaw.tgz"
if ! has_sha512_integrity "${OPENCLAW_TARBALL}" "${OPENCLAW_INTEGRITY}"; then
	download \
		"https://registry.npmjs.org/openclaw/-/openclaw-${OPENCLAW_VERSION}.tgz" \
		"${OPENCLAW_TARBALL}"
fi
has_sha512_integrity "${OPENCLAW_TARBALL}" "${OPENCLAW_INTEGRITY}" || {
	echo "OpenClaw artifact integrity mismatch" >&2
	exit 1
}

readonly HERMES_ARCHIVE="${ARTIFACT_ROOT}/hermes-agent.tar.gz"
if ! has_sha256 "${HERMES_ARCHIVE}" "${HERMES_ARCHIVE_SHA256}"; then
	hermes_headers=()
	if [[ -n "${GITHUB_TOKEN:-}" ]]; then
		hermes_headers+=(--header "Authorization: Bearer ${GITHUB_TOKEN}")
	fi
	download \
		"https://api.github.com/repos/NousResearch/hermes-agent/tarball/${HERMES_COMMIT}" \
		"${HERMES_ARCHIVE}" \
		--header "Accept: application/vnd.github+json" \
		--header "X-GitHub-Api-Version: 2022-11-28" \
		"${hermes_headers[@]}"
fi
has_sha256 "${HERMES_ARCHIVE}" "${HERMES_ARCHIVE_SHA256}" || {
	echo "Hermes artifact integrity mismatch" >&2
	exit 1
}

readonly MITMPROXY_ARCHIVE="${ARTIFACT_ROOT}/mitmproxy.tar.gz"
if ! has_sha256 "${MITMPROXY_ARCHIVE}" "${MITMPROXY_SHA256}"; then
	download \
		"https://downloads.mitmproxy.org/${MITMPROXY_VERSION}/mitmproxy-${MITMPROXY_VERSION}-linux-x86_64.tar.gz" \
		"${MITMPROXY_ARCHIVE}"
fi
has_sha256 "${MITMPROXY_ARCHIVE}" "${MITMPROXY_SHA256}" || {
	echo "mitmproxy artifact integrity mismatch" >&2
	exit 1
}

printf 'Pinned WhatsApp native E2E artifacts are ready in %s\n' "${ARTIFACT_ROOT}"
