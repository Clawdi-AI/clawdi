#!/usr/bin/env bash
# Bounded, disposable Python 3.14.7 / PostgreSQL 18.4 measurement environment.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
export CLAWDI_TEST_POSTGRES_CPUS=0.5 CLAWDI_TEST_POSTGRES_MEMORY_LIMIT=512m
project="clawdi-fanout-$$"
compose() { docker compose -p "$project" -f docker-compose.test.yml "$@"; }
cleanup() {
	docker rm -f "$project-runner" >/dev/null 2>&1 || true
	compose down --volumes >/dev/null
}
trap cleanup EXIT
trap "exit 130" INT
trap "exit 143" TERM
compose up -d --wait --wait-timeout 60 postgres
if [[ $# == 0 ]]; then
	set -- tests/test_channel_fanout_load.py
fi
timeout --signal=TERM --kill-after=15s 600s docker run --rm \
	--name "$project-runner" --cpus 2 --memory 3g --memory-swap 3g --pids-limit 512 \
	--network "${project}_default" --mount type=bind,src="$PWD",dst=/repo,readonly \
	-e DATABASE_URL=postgresql+asyncpg://clawdi:clawdi_test@postgres:5432/clawdi_test \
	-e UV_PROJECT_ENVIRONMENT=/work/venv -e UV_CACHE_DIR=/work/cache -e UV_PYTHON_DOWNLOADS=never \
	-e PYTHONDONTWRITEBYTECODE=1 -e CLAWDI_FANOUT_LOAD=1 \
	python:3.14.7-slim-bookworm bash -c '
set -euo pipefail
python -m pip -q install --no-cache-dir --root-user-action=ignore uv==0.12.5
cd /repo/backend
uv sync --frozen --quiet
uv run --no-sync python -c "import sys; assert sys.version_info[:3] == (3,14,7)"
uv run --no-sync python scripts/check_postgres_runtime.py
uv run --no-sync alembic upgrade head >/dev/null 2>&1
uv run --no-sync pytest -q -s -p no:cacheprovider --tb=short --show-capture=no "$@"
' -- "$@"
