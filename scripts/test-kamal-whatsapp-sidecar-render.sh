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
	DEPLOY_HOST=192.0.2.10 \
		DEPLOY_IMAGE_VERSION="${expected_version}" \
		ruby - "${render_root}/config/deploy.yml" "${expected_version}" <<'RUBY'
require "kamal"
require "pathname"

config_path, expected_version = ARGV
config = Kamal::Configuration.create_from(
  config_file: Pathname.new(config_path),
  version: expected_version
)
expected_logging_args = [ "--log-driver", '"journald"' ]

raise "top-level logging did not render journald" unless config.logging_args == expected_logging_args
config.roles.each do |role|
  raise "#{role.name} logging drifted" unless role.logging_args == expected_logging_args
end
config.accessories.each do |accessory|
  command = Kamal::Commands::Accessory.new(config, name: accessory.name).run
  unless command.each_cons(2).include?([ "--restart", "unless-stopped" ])
    raise "#{accessory.name} does not survive an ordinary host restart"
  end
  unless command.each_cons(2).include?(expected_logging_args)
    raise "#{accessory.name} logging did not render journald"
  end
  raise "#{accessory.name} retained a json-file log option" if command.include?("--log-opt")
end

proxy_args = config.proxy_run(config.primary_host).docker_options_args
unless proxy_args.each_cons(2).include?(expected_logging_args)
  raise "kamal-proxy logging did not render journald"
end
raise "kamal-proxy retained a json-file log option" if proxy_args.include?("--log-opt")
RUBY
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
