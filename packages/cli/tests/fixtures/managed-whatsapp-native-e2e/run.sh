#!/usr/bin/env bash
set -euo pipefail

readonly FIXTURE_ROOT="/workspace/packages/cli/tests/fixtures/managed-whatsapp-native-e2e"
readonly RUN_ROOT="/tmp/clawdi-whatsapp-native-e2e"
readonly E2E_HOME="/opt/stock/${E2E_RUNTIME:-invalid}-home"
readonly E2E_OUTPUT="${RUN_ROOT}/output"
readonly E2E_SCENARIO="${RUN_ROOT}/scenario.json"
readonly EGRESS_HOME="${RUN_ROOT}/egress-home"
readonly EGRESS_CA_DIR="${EGRESS_HOME}/.mitmproxy"
readonly EGRESS_PORT="18080"
readonly NFT_TABLE="clawdi_e2e_egress"
readonly SERVER_LOG="${E2E_OUTPUT}/server.log"
readonly EGRESS_LOG="${E2E_OUTPUT}/egress.log"

wait_for_http() {
	local url="$1"
	local label="$2"
	for _ in $(seq 1 200); do
		if curl --fail --silent --show-error "${url}" >/dev/null 2>&1; then return 0; fi
		sleep 0.05
	done
	echo "${label} did not become ready" >&2
	return 1
}

wait_for_file() {
	local path="$1"
	local label="$2"
	for _ in $(seq 1 200); do
		if [[ -s "${path}" ]]; then return 0; fi
		sleep 0.05
	done
	echo "${label} did not become ready" >&2
	return 1
}

if [[ "${E2E_RUNTIME:-}" != "openclaw" && "${E2E_RUNTIME:-}" != "hermes" ]]; then
	echo "E2E_RUNTIME must be openclaw or hermes" >&2
	exit 2
fi

server_pid=""
egress_pid=""
cleanup() {
	local status="$?"
	set +e
	if [[ "${status}" -ne 0 ]]; then
		for log in "${SERVER_LOG}" "${EGRESS_LOG}"; do
			if [[ -f "${log}" ]]; then
				echo "--- ${log} ---" >&2
				tail -n 200 "${log}" >&2
			fi
		done
	fi
	if [[ -n "${egress_pid}" ]]; then kill "${egress_pid}" 2>/dev/null; fi
	if [[ -n "${server_pid}" ]]; then kill "${server_pid}" 2>/dev/null; fi
	if nft list table inet "${NFT_TABLE}" >/dev/null 2>&1; then
		bun --cwd /workspace --eval \
			'import { cleanupTransparentEgressNftRules } from "./packages/cli/src/runtime/transparent-egress.ts"; cleanupTransparentEgressNftRules(process.env.CLAWDI_EGRESS_NFT_TABLE);' \
			>/dev/null 2>&1
	fi
}
trap cleanup EXIT INT TERM

mkdir -p "${E2E_OUTPUT}" "${EGRESS_CA_DIR}"
chown -R egress:egress "${EGRESS_HOME}"

/workspace/backend/.venv/bin/python "${FIXTURE_ROOT}/server.py" init "${E2E_SCENARIO}"

export E2E_HOME E2E_OUTPUT E2E_SCENARIO
bun test "${FIXTURE_ROOT}/project.e2e.ts"
chown -R clawdi:clawdi "${E2E_OUTPUT}"

export CLAWDI_EGRESS_PROFILE_BUNDLE="${E2E_OUTPUT}/egress-profiles.json"
export CLAWDI_EGRESS_SECRET_FILE="${E2E_OUTPUT}/egress-secrets.json"
export CLAWDI_EGRESS_TRANSPARENT_PORT="${EGRESS_PORT}"
export CLAWDI_EGRESS_NFT_TABLE="${NFT_TABLE}"
export CLAWDI_EGRESS_CA_DIR="${EGRESS_CA_DIR}"
export CLAWDI_EGRESS_CA_CERT="${EGRESS_CA_DIR}/mitmproxy-ca-cert.pem"
export CLAWDI_EGRESS_SYSTEM_CA_BUNDLE="${EGRESS_CA_DIR}/mitmproxy-ca-cert.pem"
export CLAWDI_EGRESS_TRANSPORT_VERSION="clawdi-transparent-egress-v1"
export CLAWDI_EGRESS_ENGINE_TYPE="mitmproxy"
export CLAWDI_EGRESS_ENGINE_VERSION="${E2E_MITMPROXY_VERSION}"
export CLAWDI_EGRESS_ENGINE_URL="https://downloads.mitmproxy.org/${E2E_MITMPROXY_VERSION}/mitmproxy-${E2E_MITMPROXY_VERSION}-linux-x86_64.tar.gz"
export CLAWDI_EGRESS_ENGINE_SHA256="2e95286b618fa6fd33e5e62a78c2e5112571d85f42ec2bac29b97ee242bdb5c5"
export CLAWDI_EGRESS_ENGINE_BINARY_PATH="/opt/mitmproxy/mitmdump"
export CLAWDI_EGRESS_ADDON_PATH="/workspace/packages/cli/egress-addon/clawdi_egress_addon.py"
export CLAWDI_EGRESS_ADDON_SHA256
CLAWDI_EGRESS_ADDON_SHA256="$(sha256sum "${CLAWDI_EGRESS_ADDON_PATH}" | cut -d ' ' -f 1)"

chown egress:egress "${CLAWDI_EGRESS_PROFILE_BUNDLE}" "${CLAWDI_EGRESS_SECRET_FILE}"
chmod 0600 "${CLAWDI_EGRESS_PROFILE_BUNDLE}" "${CLAWDI_EGRESS_SECRET_FILE}"

/workspace/backend/.venv/bin/python "${FIXTURE_ROOT}/server.py" serve "${E2E_SCENARIO}" \
	>"${SERVER_LOG}" 2>&1 &
server_pid="$!"
wait_for_http "http://127.0.0.1:9000/control/status" "backend Noise harness"

runuser -u egress -- env \
	HOME="${EGRESS_HOME}" \
	CLAWDI_EGRESS_PROFILE_BUNDLE="${CLAWDI_EGRESS_PROFILE_BUNDLE}" \
	CLAWDI_EGRESS_SECRET_FILE="${CLAWDI_EGRESS_SECRET_FILE}" \
	/opt/mitmproxy/mitmdump \
		--mode transparent \
		--listen-host 127.0.0.1 \
		--listen-port "${EGRESS_PORT}" \
		--set "confdir=${EGRESS_CA_DIR}" \
		--set connection_strategy=lazy \
		--set termlog_verbosity=info \
		--scripts "${CLAWDI_EGRESS_ADDON_PATH}" \
	>"${EGRESS_LOG}" 2>&1 &
egress_pid="$!"
wait_for_file "${CLAWDI_EGRESS_CA_CERT}" "mitmproxy CA"
kill -0 "${egress_pid}"

bun --cwd /workspace --eval \
	'import { applyTransparentEgressNftRulesFromEnv } from "./packages/cli/src/runtime/transparent-egress.ts"; applyTransparentEgressNftRulesFromEnv();'

if [[ "${E2E_RUNTIME}" == "openclaw" ]]; then
	runuser -u clawdi -- env \
		HOME="${E2E_HOME}" \
		E2E_HOME="${E2E_HOME}" \
		E2E_OUTPUT="${E2E_OUTPUT}" \
		E2E_RUNTIME="${E2E_RUNTIME}" \
		OPENCLAW_STATE_DIR="${E2E_HOME}/.openclaw" \
		OPENCLAW_CONFIG_PATH="${E2E_HOME}/.openclaw/openclaw.json" \
		NODE_EXTRA_CA_CERTS="${CLAWDI_EGRESS_CA_CERT}" \
		PATH="${E2E_HOME}/.local/bin:${E2E_HOME}/.openclaw/bin:${PATH}" \
		node "${FIXTURE_ROOT}/consumer.mjs"
else
	runuser -u clawdi -- env \
		HOME="${E2E_HOME}" \
		E2E_HOME="${E2E_HOME}" \
		E2E_OUTPUT="${E2E_OUTPUT}" \
		E2E_RUNTIME="${E2E_RUNTIME}" \
		NODE_EXTRA_CA_CERTS="${CLAWDI_EGRESS_CA_CERT}" \
		PATH="${E2E_HOME}/.local/bin:${E2E_HOME}/.openclaw/bin:${PATH}" \
		PYTHONPATH="${E2E_HOME}/.hermes/hermes-agent" \
		/opt/hermes-venv/bin/python "${FIXTURE_ROOT}/hermes_consumer.py"
fi

readonly FINAL_STATUS_PATH="${E2E_OUTPUT}/final-status.json"
curl --fail --silent --show-error \
	--output "${FINAL_STATUS_PATH}" \
	http://127.0.0.1:9000/control/status
export FINAL_STATUS_PATH
node --input-type=module --eval \
	'import { readFileSync } from "node:fs"; const value = JSON.parse(readFileSync(process.env.FINAL_STATUS_PATH, "utf8")); if (value.markerLeaks !== 0 || value.identityRejections !== 0) throw new Error(`invalid final harness status: ${JSON.stringify(value)}`); console.log(JSON.stringify({ runtime: process.env.E2E_RUNTIME, connections: value.connections, inboundPushes: value.inboundPushes.length, outboundMessages: value.outboundMessages.length, outboundNodes: value.outboundNodes.length }));'

echo "managed WhatsApp ${E2E_RUNTIME} native plugin E2E passed"
