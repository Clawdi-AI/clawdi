#!/usr/bin/env bash
set -euo pipefail

command="${1:-serve}"

ensure_dirs() {
	install -d -m 0755 \
		"${CLAWDI_HOST_POLICY_PATH%/*}" \
		"${CLAWDI_RUNTIME_SOURCE_PATH%/*}" \
		"${CLAWDI_SERVICE_STATE_DIR}" \
		"${CLAWDI_RUN_DIR}" \
		"${CLAWDI_SHARE_DIR}" \
		"${HOME}" \
		"${HOME}/clawdi"

	if [ "$(id -u)" = "0" ]; then
		chown -R "${CLAWDI_RUNTIME_USER}:${CLAWDI_RUNTIME_USER}" "${HOME}"
	fi
}

write_host_policy() {
	if [ -f "${CLAWDI_HOST_POLICY_PATH}" ]; then
		return
	fi

	node <<'NODE'
const fs = require("node:fs");

const policyPath = process.env.CLAWDI_HOST_POLICY_PATH;
const serviceState = process.env.CLAWDI_SERVICE_STATE_DIR;
const runDir = process.env.CLAWDI_RUN_DIR;
const home = process.env.HOME;

const policy = {
  schemaVersion: "clawdi.hostPolicy.v1",
  mode: "hosted",
  cliUpdateMode: "managed",
  immutableShim: true,
  deniedCommands: [
    { command: "setup", reason: "hosted runtime uses controller-supplied desired state" },
    { command: "teardown", reason: "hosted runtime lifecycle is controller-owned" },
    { command: "update", reason: "runtime CLI updates are manifest-controlled" },
    { command: "config set", reason: "hosted runtime config is manifest-controlled" },
    { command: "config unset", reason: "hosted runtime config is manifest-controlled" }
  ],
  managedState: ["/etc/clawdi", serviceState, runDir],
  writableState: [home, serviceState, runDir, "/tmp"],
  systemWritableState: ["/etc/clawdi", serviceState, runDir],
  userWritableState: [home, "/tmp"],
  ordinaryUserDeniedState: ["/etc/clawdi", serviceState, runDir]
};

fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o644 });
NODE
}

write_runtime_source() {
	if [ -f "${CLAWDI_RUNTIME_SOURCE_PATH}" ] || [ -z "${CLAWDI_RUNTIME_MANIFEST_URL:-}" ]; then
		return
	fi

	node <<'NODE'
const fs = require("node:fs");

const sourcePath = process.env.CLAWDI_RUNTIME_SOURCE_PATH;
const url = process.env.CLAWDI_RUNTIME_MANIFEST_URL;
const authEnv = process.env.CLAWDI_RUNTIME_AUTH_ENV || "CLAWDI_AUTH_TOKEN";

const source = {
  schemaVersion: "clawdi.runtimeSource.v1",
  type: "http",
  url,
  auth: { type: "bearer-env", env: authEnv }
};

fs.writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`, { mode: 0o644 });
NODE
}

load_auth_token_file() {
	local auth_env="${CLAWDI_RUNTIME_AUTH_ENV:-CLAWDI_AUTH_TOKEN}"
	local file_env="${auth_env}_FILE"
	local token_value="${!auth_env-}"
	local token_file="${!file_env-}"

	if [ -z "${token_value}" ] && [ -n "${token_file}" ]; then
		if [ ! -r "${token_file}" ]; then
			echo "auth token file is not readable: ${token_file}" >&2
			exit 20
		fi
		token_value="$(tr -d '\r\n' < "${token_file}")"
		export "${auth_env}=${token_value}"
	fi
}

case "${command}" in
	serve)
		ensure_dirs
		write_host_policy
		write_runtime_source
		load_auth_token_file
		clawdi runtime init --non-interactive --json
		exec supervisord -c "${CLAWDI_RUN_DIR}/supervisor/supervisord.conf"
		;;
	*)
		exec "$@"
		;;
esac
