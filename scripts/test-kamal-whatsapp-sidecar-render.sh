#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
render_root="$(mktemp -d)"
rendered_config="${render_root}/rendered.yml"
expected_version="0123456789abcdef0123456789abcdef01234567"

cleanup() {
	rm -rf -- "${render_root}"
}
trap cleanup EXIT

test "$(kamal version)" = "2.12.0"
mkdir -p "${render_root}/config" "${render_root}/.kamal"
cp "${repo_root}/config/deploy.yml" "${render_root}/config/deploy.yml"

secret_keys=(
	KAMAL_REGISTRY_USERNAME
	KAMAL_REGISTRY_PASSWORD
	CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN
	POSTGRES_PASSWORD
	PGBACKREST_REPO1_PATH
	PGBACKREST_REPO1_S3_BUCKET
	PGBACKREST_REPO1_S3_ENDPOINT
	PGBACKREST_REPO1_S3_KEY
	PGBACKREST_REPO1_S3_KEY_SECRET
	PGBACKREST_REPO1_CIPHER_PASS
	ADMIN_API_KEY
	CLERK_JWT_ISSUER
	SENTRY_DSN
	CLERK_SECRET_KEY
	CLERK_WEBHOOK_SIGNING_SECRET
	COMPOSIO_API_KEY
	DATABASE_URL
	ENCRYPTION_KEY
	FILE_STORE_S3_ACCESS_KEY_ID
	FILE_STORE_S3_ENDPOINT_URL
	FILE_STORE_S3_SECRET_ACCESS_KEY
	LLM_API_KEY
	MEMORY_EMBEDDING_API_KEY
	MEMORY_EMBEDDING_BASE_URL
	VAULT_ENCRYPTION_KEY
)
for key in "${secret_keys[@]}"; do
	printf '%s=fake-render-value\n' "${key}" >> "${render_root}/.kamal/secrets"
done
chmod 600 "${render_root}/.kamal/secrets"

(
	cd "${render_root}"
	DEPLOY_HOST=192.0.2.10 \
		DEPLOY_IMAGE_VERSION="${expected_version}" \
		kamal config --version "${expected_version}" > "${rendered_config}"
)

test "$(grep -Ec '^  whatsapp-baileys:$' "${rendered_config}")" -eq 1
grep -Fq 'service: clawdi-whatsapp-baileys' "${rendered_config}"
grep -Fq "image: ghcr.io/clawdi-ai/clawdi-whatsapp-baileys-sidecar:${expected_version}" \
	"${rendered_config}"
grep -Fq 'local: "/home/phala/clawdi-whatsapp/state"' "${rendered_config}"
grep -Fq 'remote: "/data"' "${rendered_config}"
grep -Fq 'local: "/home/phala/clawdi-whatsapp/run"' "${rendered_config}"
grep -Fq 'remote: "/run/clawdi-whatsapp"' "${rendered_config}"
grep -Fq 'CLAWDI_WA_SIDECAR_STATE_ROOT: "/data"' "${rendered_config}"
grep -Fq 'CLAWDI_WA_SIDECAR_SOCKET_PATH: "/run/clawdi-whatsapp/sidecar.sock"' \
	"${rendered_config}"
