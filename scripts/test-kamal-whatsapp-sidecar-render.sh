#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
render_root="$(mktemp -d)"
rendered_config="${render_root}/rendered.yml"
rendered_egress_config="${render_root}/rendered-egress.yml"
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
	TS_AUTHKEY
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
	WHATSAPP_TAILSCALE_EGRESS_ENABLED=true \
		WHATSAPP_TAILSCALE_EXIT_NODE=exit-node.example.ts.net \
		WHATSAPP_TAILSCALE_CONFIG_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
		DEPLOY_HOST=192.0.2.10 \
		DEPLOY_IMAGE_VERSION="${expected_version}" \
		kamal config --version "${expected_version}" > "${rendered_egress_config}"
	WHATSAPP_TAILSCALE_EGRESS_ENABLED=true \
		WHATSAPP_TAILSCALE_EXIT_NODE=exit-node.example.ts.net \
		WHATSAPP_TAILSCALE_CONFIG_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
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
commands = config.accessories.to_h do |accessory|
  [accessory.name, Kamal::Commands::Accessory.new(config, name: accessory.name).run]
end

def option?(command, flag, value)
  command.each_cons(2).any? { |pair| pair[0] == flag && pair[1].delete('"') == value }
end

raise "infra did not own the Kamal bridge namespace" unless option?(commands.fetch("whatsapp-netns"), "--network", "kamal")
tailscale = commands.fetch("whatsapp-tailscale")
raise "Tailscale did not join infra" unless option?(tailscale, "--network", "container:clawdi-whatsapp-netns")
raise "Tailscale lost state-directory access" unless option?(tailscale, "--cap-add", "DAC_OVERRIDE")
raise "Tailscale lost NET_ADMIN" unless option?(tailscale, "--cap-add", "NET_ADMIN")
raise "Tailscale lost NET_RAW" unless option?(tailscale, "--cap-add", "NET_RAW")
raise "Tailscale lost tun" unless option?(tailscale, "--device", "/dev/net/tun:/dev/net/tun")
raise "Tailscale lost its writable runtime directory" unless option?(
  tailscale, "--tmpfs", "/run:rw,noexec,nosuid,nodev,size=8m"
)
guard = commands.fetch("whatsapp-egress-guard")
raise "guard did not join infra" unless option?(guard, "--network", "container:clawdi-whatsapp-netns")
raise "guard entrypoint drifted" unless option?(guard, "--entrypoint", "/bin/sh")
raise "guard lost marker-directory access" unless option?(guard, "--cap-add", "DAC_OVERRIDE")
raise "guard lost its writable runtime directory" unless option?(
  guard, "--tmpfs", "/run:rw,noexec,nosuid,nodev,size=4m"
)
guard_cmd = config.accessory("whatsapp-egress-guard").cmd
unless guard_cmd.start_with?("-ceu '") && guard_cmd.end_with?("'") && guard_cmd.count("'") == 2
  raise "guard command quoting drifted"
end
guard_script = guard_cmd.delete_prefix("-ceu '").delete_suffix("'")
raise "guard command is not valid sh" unless system("/bin/sh", "-n", "-c", guard_script)
guard_directory = config.accessory("whatsapp-egress-guard").directories.fetch(
  "/home/phala/clawdi-whatsapp/egress-guard"
)
raise "guard directory mode drifted" unless guard_directory[:mode] == "700"
sidecar = commands.fetch("whatsapp-baileys")
raise "sidecar did not join infra" unless option?(sidecar, "--network", "container:clawdi-whatsapp-netns")
raise "sidecar lost UDS bind" unless option?(sidecar, "--volume", "/home/phala/clawdi-whatsapp/run:/run/clawdi-whatsapp")
raise "sidecar lost read-only resolver bind" unless option?(sidecar, "--volume", "/home/phala/clawdi-whatsapp/tailscale-resolv.conf:/etc/resolv.conf:ro")
raise "sidecar lost guard marker bind" unless option?(sidecar, "--volume", "/home/phala/clawdi-whatsapp/egress-guard:/run/clawdi-egress-guard:ro")
raise "sidecar lost guard marker env" unless sidecar.include?(
  'CLAWDI_WA_NETWORK_NAMESPACE_MARKER="/run/clawdi-egress-guard/network-namespace.ready"'
)
RUBY
)

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

web = config.role("web")
expected_web_env = {
  "WEB_CONCURRENCY" => 1,
  "DB_POOL_SIZE" => 10,
  "DB_MAX_OVERFLOW" => 10,
  "DB_POOL_TIMEOUT" => 5,
  "PROMETHEUS_MULTIPROC_DIR" => "/tmp/clawdi-prometheus-multiproc",
}
unless web.specialized_env.clear == expected_web_env
  raise "web role worker contract drifted"
end
raise "web role memory drifted" unless config.raw_config.servers.dig("web", "options", "memory") == "6g"
web_env = web.env(web.primary_host).clear
unless web_env.values_at("DB_POOL_SIZE", "DB_MAX_OVERFLOW", "DB_POOL_TIMEOUT") == [ 10, 10, 5 ]
  raise "web role database pool drifted"
end
channels_worker = config.role("channels-worker")
expected_channels_worker_env = {
  "CLAWDI_PROCESS_ROLE" => "channels-worker",
  "DB_POOL_SIZE" => 10,
  "DB_MAX_OVERFLOW" => 10,
  "DB_POOL_TIMEOUT" => 5,
}
worker_role = channels_worker.specialized_env.clear == expected_channels_worker_env
unless worker_role && !channels_worker.running_proxy?
  raise "channels-worker role contract drifted"
end
channels_worker_env = channels_worker.env(channels_worker.primary_host).clear
unless channels_worker_env.values_at("DB_POOL_SIZE", "DB_MAX_OVERFLOW", "DB_POOL_TIMEOUT") == [ 10, 10, 5 ]
  raise "channels-worker database pool drifted"
end
if channels_worker_env.key?("PROMETHEUS_MULTIPROC_DIR")
  raise "channels-worker unexpectedly enabled multiprocess metrics"
end
web_connections = web_env.fetch("WEB_CONCURRENCY") *
  (web_env.fetch("DB_POOL_SIZE") + web_env.fetch("DB_MAX_OVERFLOW"))
worker_connections = channels_worker_env.fetch("DB_POOL_SIZE") +
  channels_worker_env.fetch("DB_MAX_OVERFLOW")
steady_connections = web_connections + worker_connections
rolling_connections = 2 * (web_connections + worker_connections)
raise "steady database connection budget drifted" unless steady_connections == 40
raise "rolling database connection budget drifted" unless rolling_connections == 80

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

whatsapp_command = Kamal::Commands::Accessory.new(config, name: "whatsapp-baileys").run
app_socket_volume = "/home/phala/clawdi-whatsapp/run:/run/clawdi-whatsapp:ro"
unless config.raw_config.volumes.include?(app_socket_volume)
  raise "backend roles lost the read-only WhatsApp Unix socket directory"
end
unless whatsapp_command.each_cons(2).include?([ "--network", "bridge" ])
  raise "disabled WhatsApp sidecar did not preserve bridge networking"
end
unless whatsapp_command.each_cons(2).include?(
  [ "--volume", "/home/phala/clawdi-whatsapp/run:/run/clawdi-whatsapp" ]
)
  raise "WhatsApp sidecar lost its read-write Unix socket directory"
end
unless whatsapp_command.include?(
  'CLAWDI_WA_SIDECAR_SOCKET_PATH="/run/clawdi-whatsapp/sidecar.sock"'
)
  raise "WhatsApp sidecar socket path drifted"
end

proxy_args = config.proxy_run(config.primary_host).docker_options_args
expected_proxy_logging_args = [ "--log-driver", '"none"' ]
unless proxy_args.each_cons(2).include?(expected_proxy_logging_args)
  raise "kamal-proxy request logs were not disabled"
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
grep -Fq 'network: bridge' "${rendered_config}"
grep -Fq '/home/phala/clawdi-whatsapp/run:/run/clawdi-whatsapp:ro' "${rendered_config}"
test "$(grep -Ec '^  whatsapp-tailscale:$' "${rendered_config}")" -eq 0
test "$(grep -Ec '^  whatsapp-netns:$' "${rendered_config}")" -eq 0
test "$(grep -Ec '^  whatsapp-egress-guard:$' "${rendered_config}")" -eq 0

test "$(grep -Ec '^  whatsapp-tailscale:$' "${rendered_egress_config}")" -eq 1
test "$(grep -Ec '^  whatsapp-netns:$' "${rendered_egress_config}")" -eq 1
test "$(grep -Ec '^  whatsapp-egress-guard:$' "${rendered_egress_config}")" -eq 1
grep -Fq 'image: registry.k8s.io/pause:3.10.2@sha256:f548e0e8e3dc1896ca956272154dde3314e8cc4fde0a57577ee9fa1c63f5baf4' \
	"${rendered_egress_config}"
grep -Fq 'service: clawdi-whatsapp-tailscale' "${rendered_egress_config}"
grep -Fq 'image: tailscale/tailscale:v1.102.2@sha256:321ce041508c19079b57a28b6666c8d81ab0b08accc0a2585b3ab663d557ac24' \
	"${rendered_egress_config}"
test "$(grep -Fc 'network: container:clawdi-whatsapp-netns' "${rendered_egress_config}")" -eq 3
grep -Fq "TS_USERSPACE: 'false'" "${rendered_egress_config}"
grep -Fq "TS_ACCEPT_DNS: 'true'" "${rendered_egress_config}"
grep -Fq '      - NET_ADMIN' "${rendered_egress_config}"
grep -Fq '      - NET_RAW' "${rendered_egress_config}"
! grep -Fq 'CLAWDI_WA_SIDECAR_PROXY_URL' "${rendered_egress_config}"
! grep -Fq 'TS_OUTBOUND_HTTP_PROXY_LISTEN' "${rendered_egress_config}"
test "$(grep -Fc 'cap-drop: ALL' "${rendered_egress_config}")" -ge 4
grep -Fq "TS_AUTH_ONCE: 'true'" "${rendered_egress_config}"
grep -Fq 'io.clawdi.whatsapp-egress.config-revision: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
	"${rendered_egress_config}"
grep -Fq 'TS_EXTRA_ARGS: "--exit-node=exit-node.example.ts.net --exit-node-allow-lan-access=false"' \
	"${rendered_egress_config}"
grep -Fq 'local: "/home/phala/clawdi-whatsapp/tailscale-state"' "${rendered_egress_config}"
grep -Fq 'local: "/home/phala/clawdi-whatsapp/run"' "${rendered_egress_config}"
grep -Fq 'CLAWDI_WA_SIDECAR_SOCKET_PATH: "/run/clawdi-whatsapp/sidecar.sock"' \
	"${rendered_egress_config}"
