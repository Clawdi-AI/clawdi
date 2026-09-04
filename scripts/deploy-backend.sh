#!/usr/bin/env bash
set -euo pipefail

readonly service="clawdi"
readonly desired_pool="10:10:5"
readonly legacy_pool="20:20:45"
readonly minimum_available_connections=20
readonly backend_image="ghcr.io/clawdi-ai/clawdi-backend:${DEPLOY_IMAGE_VERSION:?}"

[[ "${DEPLOY_IMAGE_VERSION}" =~ ^[0-9a-f]{40}$ ]] || {
	echo "DEPLOY_IMAGE_VERSION must be a full Git SHA" >&2
	exit 1
}

remote_value() {
	local output value
	output="$(kamal server exec "$1")"
	value="$(printf '%s\n' "${output}" | sed -n 's/^.*CLAWDI_VALUE=//p' | tail -n 1)"
	[[ -n "${value}" ]] || { echo "Remote inspection returned no value" >&2; exit 1; }
	printf '%s\n' "${value}"
}

role_state() {
	local role="$1"
	remote_value "
		set -- \$(docker ps -q --no-trunc --filter 'label=service=${service}' --filter 'label=role=${role}')
		if [ \"\$#\" -eq 0 ]; then printf 'CLAWDI_VALUE=missing\\n'; exit 0; fi
		test \"\$#\" -eq 1
		container=\$1
		environment=\$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \"\$container\")
		pool_size=\$(printf '%s\\n' \"\$environment\" | sed -n 's/^DB_POOL_SIZE=//p')
		max_overflow=\$(printf '%s\\n' \"\$environment\" | sed -n 's/^DB_MAX_OVERFLOW=//p')
		pool_timeout=\$(printf '%s\\n' \"\$environment\" | sed -n 's/^DB_POOL_TIMEOUT=//p')
		image=\$(docker inspect --format '{{.Config.Image}}' \"\$container\")
		printf 'CLAWDI_VALUE=%s|%s|%s:%s:%s\\n' \"\$container\" \"\$image\" \"\$pool_size\" \"\$max_overflow\" \"\$pool_timeout\"
	"
}

validate_role_state() {
	local role="$1" state="$2" container image pool
	[[ "${state}" == missing ]] && return
	IFS='|' read -r container image pool <<<"${state}"
	[[ "${container}" =~ ^[0-9a-f]{64}$ && -n "${image}" ]] || {
		echo "Invalid ${role} container state" >&2
		exit 1
	}
	case "${pool}" in
		"${legacy_pool}"|"${desired_pool}") ;;
		*) echo "Refusing unknown ${role} database pool: ${pool}" >&2; exit 1 ;;
	esac
}

require_database_headroom() {
	local available output
	output="$(kamal accessory exec postgres --reuse \
		"psql -U clawdi -d clawdi -Atqc \"SELECT 'CLAWDI_VALUE=' || (current_setting('max_connections')::int - current_setting('superuser_reserved_connections')::int - current_setting('reserved_connections')::int - count(*) FILTER (WHERE backend_type = 'client backend')) FROM pg_stat_activity\"")"
	available="$(printf '%s\n' "${output}" | sed -n 's/^.*CLAWDI_VALUE=//p' | tail -n 1)"
	[[ "${available}" =~ ^[0-9]+$ ]] || { echo "Invalid PostgreSQL capacity result" >&2; exit 1; }
	(( available >= minimum_available_connections )) || {
		echo "PostgreSQL has ${available} available connections; ${minimum_available_connections} required" >&2
		exit 1
	}
}

assert_deployed_role() {
	local role="$1" state container image pool
	state="$(role_state "${role}")"
	validate_role_state "${role}" "${state}"
	[[ "${state}" != missing ]] || { echo "${role} is not running after deployment" >&2; exit 1; }
	IFS='|' read -r container image pool <<<"${state}"
	[[ "${image}" == "${backend_image}" && "${pool}" == "${desired_pool}" ]] || {
		echo "${role} did not converge to the requested image and database pool" >&2
		exit 1
	}
}

web_state="$(role_state web)"
channels_state="$(role_state channels-worker)"
validate_role_state web "${web_state}"
validate_role_state channels-worker "${channels_state}"

require_database_headroom
kamal app exec --primary --roles web --raw \
	--version "${DEPLOY_IMAGE_VERSION}" alembic upgrade head

if [[ "${channels_state}" == *"|${legacy_pool}" ]]; then
	kamal app stop --roles channels-worker
fi

require_database_headroom
kamal deploy -P --roles channels-worker --version "${DEPLOY_IMAGE_VERSION}"
assert_deployed_role channels-worker

require_database_headroom
kamal deploy -P --roles web --version "${DEPLOY_IMAGE_VERSION}"
assert_deployed_role web
