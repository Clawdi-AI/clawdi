#!/usr/bin/env bash
set -euo pipefail

readonly service="clawdi"
readonly web_pool="5:5:5"
readonly channels_pool="10:10:5"
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
		set -eu
		set -- \$(docker ps -q --no-trunc --filter 'label=service=${service}' --filter 'label=role=${role}')
		if [ \"\$#\" -eq 0 ]; then printf 'CLAWDI_VALUE=missing\\n'; exit 0; fi
		test \"\$#\" -eq 1
		container=\$1
		environment=\$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \"\$container\")
		pool_size=\$(printf '%s\\n' \"\$environment\" | sed -n 's/^DB_POOL_SIZE=//p')
		max_overflow=\$(printf '%s\\n' \"\$environment\" | sed -n 's/^DB_MAX_OVERFLOW=//p')
		pool_timeout=\$(printf '%s\\n' \"\$environment\" | sed -n 's/^DB_POOL_TIMEOUT=//p')
		web_concurrency=\$(printf '%s\\n' \"\$environment\" | sed -n 's/^WEB_CONCURRENCY=//p')
		image=\$(docker inspect --format '{{.Config.Image}}' \"\$container\")
		printf 'CLAWDI_VALUE=%s|%s|%s:%s:%s|%s\\n' \"\$container\" \"\$image\" \"\$pool_size\" \"\$max_overflow\" \"\$pool_timeout\" \"\$web_concurrency\"
	"
}

validate_container_state() {
	local role="$1" state="$2" container image pool workers
	[[ "${state}" == missing ]] && return
	IFS='|' read -r container image pool workers <<<"${state}"
	[[ "${container}" =~ ^[0-9a-f]{64}$ && -n "${image}" ]] || {
		echo "Invalid ${role} container state" >&2
		exit 1
	}
}

validate_database_role_state() {
	local role="$1" state="$2" container image pool workers
	validate_container_state "${role}" "${state}"
	[[ "${state}" == missing ]] && return
	IFS='|' read -r container image pool workers <<<"${state}"
	case "${role}:${pool}" in
		"web:${legacy_pool}"|"web:${channels_pool}"|"web:${web_pool}"|\
			"channels-worker:${legacy_pool}"|"channels-worker:${channels_pool}") ;;
		*) echo "Refusing unknown ${role} database pool: ${pool}" >&2; exit 1 ;;
	esac
	case "${role}:${workers}" in
		"web:"|"web:1"|"web:2"|"channels-worker:") ;;
		*) echo "Refusing unknown ${role} worker count: ${workers}" >&2; exit 1 ;;
	esac
}

validate_embedding_state() {
	local state="$1" container image pool workers
	validate_container_state embedding-worker "${state}"
	[[ "${state}" == missing ]] && return
	IFS='|' read -r container image pool workers <<<"${state}"
	[[ "${pool}" == "::" && -z "${workers}" ]] || {
		echo "Refusing embedding-worker with database pool or web worker settings" >&2
		exit 1
	}
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

assert_database_role() {
	local role="$1" expected_pool="$2" state container image pool workers
	state="$(role_state "${role}")"
	validate_database_role_state "${role}" "${state}"
	[[ "${state}" != missing ]] || { echo "${role} is not running after deployment" >&2; exit 1; }
	IFS='|' read -r container image pool workers <<<"${state}"
	[[ "${image}" == "${backend_image}" && "${pool}" == "${expected_pool}" ]] || {
		echo "${role} did not converge to the requested image and database pool" >&2
		exit 1
	}
	[[ "${role}" != web || "${workers}" == 2 ]] || {
		echo "web did not converge to two workers" >&2
		exit 1
	}
}

assert_embedding_role() {
	local state container image pool workers
	state="$(role_state embedding-worker)"
	validate_embedding_state "${state}"
	[[ "${state}" != missing ]] || { echo "embedding-worker is not running after deployment" >&2; exit 1; }
	IFS='|' read -r container image pool workers <<<"${state}"
	[[ "${image}" == "${backend_image}" ]] || {
		echo "embedding-worker did not converge to the requested image" >&2
		exit 1
	}
}

web_state="$(role_state web)"
channels_state="$(role_state channels-worker)"
embedding_state="$(role_state embedding-worker)"
validate_database_role_state web "${web_state}"
validate_database_role_state channels-worker "${channels_state}"
validate_embedding_state "${embedding_state}"

require_database_headroom
kamal app exec --primary --roles web --raw \
	--version "${DEPLOY_IMAGE_VERSION}" alembic upgrade head

kamal deploy -P --roles embedding-worker --version "${DEPLOY_IMAGE_VERSION}"
assert_embedding_role
kamal app exec --primary --roles embedding-worker --reuse --raw \
	--version "${DEPLOY_IMAGE_VERSION}" \
	python -m app.workers.embedding healthcheck

if [[ "${channels_state}" == *"|${legacy_pool}"* ]]; then
	kamal app stop --roles channels-worker
fi

require_database_headroom
kamal deploy -P --roles channels-worker --version "${DEPLOY_IMAGE_VERSION}"
assert_database_role channels-worker "${channels_pool}"

require_database_headroom
kamal deploy -P --roles web --version "${DEPLOY_IMAGE_VERSION}"
assert_database_role web "${web_pool}"
kamal app exec --primary --roles web --reuse --raw \
	--version "${DEPLOY_IMAGE_VERSION}" \
	curl --fail --silent --show-error --max-time 10 \
	--retry 3 --retry-all-errors --retry-max-time 30 \
	http://127.0.0.1:8000/ready
