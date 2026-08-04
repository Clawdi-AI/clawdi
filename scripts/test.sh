#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"

compose_project_name="${CLAWDI_TEST_COMPOSE_PROJECT_NAME:-clawdi-test-$$}"
remove_test_runner_image=false
if [[ -z "${TEST_RUNNER_IMAGE:-}" ]]; then
	export TEST_RUNNER_IMAGE="clawdi-test-runner:${compose_project_name}"
	remove_test_runner_image=true
fi

usage() {
	echo "Usage: scripts/test.sh [all|ci|js|cli|shared|sidecar|web|backend] [suite args...]"
}

compose() {
	docker compose -p "$compose_project_name" -f "$repo_root/docker-compose.test.yml" "$@"
}

validate_suite() {
	case "$1" in
		all|backend|ci|js|cli|shared|sidecar|web)
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
		all|backend|ci)
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

	cleanup() {
		compose down --remove-orphans --volumes >/dev/null
		if [[ "$remove_test_runner_image" == true ]]; then
			docker image rm "$TEST_RUNNER_IMAGE" >/dev/null 2>&1 || true
		fi
	}
	trap cleanup EXIT

	if [[ "${CLAWDI_TEST_RUNNER_SKIP_BUILD:-0}" != "1" ]]; then
		compose build test-runner
	fi

	local run_args=(run --rm)
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
}

cli_typecheck() {
	bun run --cwd packages/cli typecheck
}

cli_tests() {
	bun run --cwd packages/cli test:internal "$@"
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
