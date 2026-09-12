#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"

compose_project_name="${CLAWDI_TEST_COMPOSE_PROJECT_NAME:-clawdi-test-$$}"
remove_test_runner_image=false
provider_baseline_dir=""
if [[ -z "${TEST_RUNNER_IMAGE:-}" ]]; then
	export TEST_RUNNER_IMAGE="clawdi-test-runner:${compose_project_name}"
	remove_test_runner_image=true
fi

usage() {
	echo "Usage: scripts/test.sh [all|ci|js|cli|desktop|shared|sidecar|web|backend|runtime-vaults|runtime-systemd|provider-recovery-fixture] [suite args...]"
}

compose() {
	docker compose -p "$compose_project_name" -f "$repo_root/docker-compose.test.yml" "$@"
}

validate_suite() {
	case "$1" in
		all|backend|ci|js|cli|desktop|shared|sidecar|web|runtime-vaults|runtime-systemd|provider-recovery-fixture)
			;;
		*)
			echo "Unknown test suite: $1" >&2
			usage >&2
			return 2
			;;
	esac
}

needs_postgres() {
	case "$1" in
		all|backend|ci|runtime-vaults)
			return 0
			;;
		*)
			return 1
			;;
	esac
}

run_on_host() {
	local suite="${1:-all}"
	if [[ $# -gt 0 ]]; then
		shift
	fi
	validate_suite "$suite"
	python3 "$repo_root/scripts/check_postgres_image_parity.py"
	if [[ "$suite" == runtime-systemd ]]; then
		if [[ $# -gt 0 ]]; then
			echo "Suite 'runtime-systemd' does not accept extra arguments" >&2
			return 2
		fi
		bash "$script_dir/test-systemd-command.sh"
		return
	fi
	local provider_output=""
	if [[ "$suite" == provider-recovery-fixture ]]; then
		provider_output="$(realpath "${1:?Provide an existing output directory inside this checkout}")"
		case "$provider_output/" in "$repo_root/"*) ;; *) echo "Fixture output must be inside this checkout" >&2; return 2;; esac
		local baseline_revision="${2:?Provide the full pre-fix commit SHA}"
		[[ "$baseline_revision" =~ ^[0-9a-f]{40}$ ]] || return 2
		provider_baseline_dir="$(mktemp -d "$repo_root/.provider-recovery-baseline.XXXXXX")"
	fi

	cleanup() {
		compose down --remove-orphans --volumes >/dev/null
		if [[ "$remove_test_runner_image" == true ]]; then
			docker image rm "$TEST_RUNNER_IMAGE" >/dev/null 2>&1 || true
		fi
		if [[ -n "$provider_baseline_dir" ]]; then rm -rf "$provider_baseline_dir"; fi
	}
	trap cleanup EXIT
	if [[ -n "$provider_baseline_dir" ]]; then
		git -C "$repo_root" show "$baseline_revision:packages/cli/src/runtime/connection-provider-config.ts" > "$provider_baseline_dir/connection-provider-config.ts"
	fi

	if [[ "${CLAWDI_TEST_RUNNER_SKIP_BUILD:-0}" != "1" ]]; then
		compose build test-runner
	fi

	local run_args=(run --rm)
	if [[ -n "$provider_baseline_dir" ]]; then
		run_args+=(--volume "$provider_baseline_dir:/provider-baseline:ro" --volume "$provider_output:/provider-artifacts")
	fi
	if ! needs_postgres "$suite"; then
		run_args+=(--no-deps)
	fi
	compose "${run_args[@]}" test-runner bash /repo/scripts/test.sh --in-container "$suite" "$@"
}

source_dir="${CLAWDI_REPO_SOURCE:-/repo}"
work_dir="${CLAWDI_TEST_WORKDIR:-/work/clawdi}"

copy_repo() {
	rm -rf "$work_dir"
	mkdir -p "$work_dir" "$HOME" "$BUN_INSTALL_CACHE_DIR" "$BUN_TMPDIR" "$UV_CACHE_DIR" "$TMPDIR"
	rsync -a --delete \
		--no-owner \
		--no-group \
		--exclude '.git' \
		--exclude '.paseo/' \
		--exclude '.turbo/' \
		--exclude 'node_modules/' \
		--exclude '**/node_modules/' \
		--exclude 'backend/.venv/' \
		--exclude '**/__pycache__/' \
		--exclude '**/.pytest_cache/' \
		--exclude '**/.ruff_cache/' \
		--include '.env.example' \
		--include '**/.env.example' \
		--include '.env.*.example' \
		--include '**/.env.*.example' \
		--exclude '.envrc' \
		--exclude '**/.env' \
		--exclude '**/.env.*' \
		"$source_dir"/ "$work_dir"/
	cd "$work_dir"
}

install_js() {
	bun install --frozen-lockfile --ignore-scripts
}

install_backend() {
	(
		cd backend
		uv sync --frozen
	)
}

workspace_typecheck() {
	bun run typecheck
}

web_typecheck() {
	bun run --cwd apps/web typecheck
}

web_tests() {
	bun run --cwd apps/web test:internal "$@"
}

web_build() {
	bun run --cwd apps/web build:oss
	bun run --cwd apps/web test:ssr:internal
}

cli_typecheck() {
	bun run --cwd packages/cli typecheck
}

cli_tests() {
	bun run --cwd packages/cli test:internal "$@"
}

desktop_typecheck() {
	bun run --cwd apps/desktop typecheck
}

desktop_tests() {
	bun run --cwd apps/desktop test:internal
}

shared_typecheck() {
	bun run --cwd packages/shared typecheck
}

shared_tests() {
	bun run --cwd packages/shared test:internal
}

sidecar_typecheck() {
	bun run --cwd packages/whatsapp-baileys-sidecar typecheck
}

sidecar_tests() {
	bun run --cwd packages/whatsapp-baileys-sidecar test:internal
}

runner_contract_tests() {
	bun run --cwd packages/cli test:internal tests/clean-test-runner.test.ts
}

backend_tests() {
	(
		cd backend
		: "${DATABASE_URL:?DATABASE_URL must be set for backend tests}"
		deadline=$((SECONDS + ${CLAWDI_TEST_DB_WAIT_SECONDS:-60}))
		until pg_isready -d "${DATABASE_URL/+asyncpg/}" >/dev/null 2>&1; do
			if (( SECONDS >= deadline )); then
				echo "Timed out waiting for test Postgres to become ready" >&2
				return 1
			fi
			sleep 1
		done
		uv run python scripts/check_postgres_runtime.py
		uv run alembic upgrade head
		uv run pytest -q "$@"
	)
}

run_js() {
	install_js
	workspace_typecheck
	desktop_tests
	web_tests
	shared_tests
	sidecar_tests
	cli_tests
}

run_cli() {
	install_js
	cli_typecheck
	cli_tests "$@"
}

run_desktop() {
	install_js
	desktop_typecheck
	desktop_tests
}

run_shared() {
	install_js
	shared_typecheck
	shared_tests
}

run_sidecar() {
	install_js
	sidecar_typecheck
	sidecar_tests
}

run_web() {
	install_js
	web_typecheck
	web_tests "$@"
	web_build
}

run_runtime_vaults() {
	install_js
	cli_typecheck
	cli_tests src/runtime/vault-files.test.ts src/runtime/hosted-bundled-skill.test.ts src/serve/sse-client.test.ts src/serve/vault-sync.test.ts src/lib/environment-registration.test.ts tests/commands/setup.test.ts
	install_backend
	backend_tests -s tests/test_runtime_vaults.py tests/test_vault_requests.py tests/test_vault.py "$@"
}

run_backend() {
	install_backend
	backend_tests "$@"
}

run_ci() {
	if [[ $# -gt 0 ]]; then
		echo "Suite 'ci' does not accept extra arguments" >&2
		exit 2
	fi

	install_js
	workspace_typecheck
	runner_contract_tests
	desktop_tests
	web_tests src/hosted/oss-clean.test.ts
	web_build
	shared_tests
	sidecar_tests
	cli_tests tests/smoke.test.ts
	install_backend
	backend_tests tests/test_smoke.py
}

run_in_container() {
	shift
	local suite="${1:-all}"
	if [[ $# -gt 0 ]]; then
		shift
	fi
	validate_suite "$suite"
	copy_repo

	case "$suite" in
		runtime-systemd)
			echo "Run runtime-systemd from the host entrypoint to create its isolated systemd container" >&2
			exit 2
			;;
		all)
			run_js
			run_backend "$@"
			;;
		js)
			if [[ $# -gt 0 ]]; then
				echo "Suite 'js' does not accept extra arguments" >&2
				exit 2
			fi
			run_js
			;;
		cli)
			run_cli "$@"
			;;
		provider-recovery-fixture)
			install_js
			cli_typecheck
			cli_tests tests/clean-test-runner.test.ts
			bun build packages/cli/tests/fixtures/provider-recovery-runtime.ts --target=node --outfile=/provider-artifacts/current.mjs
			cp packages/cli/src/runtime/connection-provider-config.ts /provider-artifacts/current-source.ts
			cp /provider-baseline/connection-provider-config.ts packages/cli/src/runtime/connection-provider-config.ts
			bun build packages/cli/tests/fixtures/provider-recovery-runtime.ts --target=node --outfile=/provider-artifacts/before.mjs
			sha256sum /provider-artifacts/current-source.ts /provider-baseline/connection-provider-config.ts
			(cd packages/cli && bun -e 'import {z} from "zod"; import {providerOwnershipJournalSchema} from "./src/runtime/provider-ownership"; console.log(JSON.stringify(z.toJSONSchema(providerOwnershipJournalSchema), null, 2))') > /provider-artifacts/provider-ownership.schema.json
			install_backend
			(cd backend && uv run python -m scripts.export_provider_environment_contract) > /provider-artifacts/provider-environment.json
			(cd backend && uv run python -c 'import json; from app.main import app; print(json.dumps(app.openapi()))') > /provider-artifacts/cloud-openapi.json
			;;
		desktop)
			if [[ $# -gt 0 ]]; then
				echo "Suite 'desktop' does not accept extra arguments" >&2
				exit 2
			fi
			run_desktop
			;;
		shared)
			if [[ $# -gt 0 ]]; then
				echo "Suite 'shared' does not accept extra arguments" >&2
				exit 2
			fi
			run_shared
			;;
		sidecar)
			if [[ $# -gt 0 ]]; then
				echo "Suite 'sidecar' does not accept extra arguments" >&2
				exit 2
			fi
			run_sidecar
			;;
		web)
			run_web "$@"
			;;
		runtime-vaults)
			run_runtime_vaults "$@"
			;;
		backend)
			run_backend "$@"
			;;
		ci)
			run_ci "$@"
			;;
	esac
}

if [[ "${1:-}" == "--in-container" ]]; then
	run_in_container "$@"
else
	run_on_host "$@"
fi
