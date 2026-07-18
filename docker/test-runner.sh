#!/usr/bin/env bash
set -euo pipefail

suite="${1:-all}"
if [[ $# -gt 0 ]]; then
	shift
fi

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
	bun run --cwd apps/web test "$@"
}

web_build() {
	bun run --cwd apps/web build:oss
}

cli_typecheck() {
	bun run --cwd packages/cli typecheck
}

cli_tests() {
	bun run --cwd packages/cli test "$@"
}

shared_tests() {
	bun test packages/shared/src
}

sidecar_tests() {
	bun run --cwd packages/whatsapp-baileys-sidecar test
}

runner_contract_tests() {
	bun test packages/cli/tests/clean-test-runner.test.ts
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
	web)
		run_web "$@"
		;;
	backend)
		run_backend "$@"
		;;
	ci)
		run_ci "$@"
		;;
	*)
		echo "Unknown test suite: $suite" >&2
		echo "Usage: scripts/test.sh [all|ci|js|cli|web|backend] [suite args...]" >&2
		exit 2
		;;
esac
