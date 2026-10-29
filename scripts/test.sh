#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"

if [[ "${1:-}" = postgres-drill ]]; then
	exec timeout --signal=TERM --kill-after=30s 15m bash "$repo_root/scripts/postgres-drill/tests/run.sh"
fi

compose_project_name="${CLAWDI_TEST_COMPOSE_PROJECT_NAME:-clawdi-test-$$}"
remove_test_runner_image=false
provider_baseline_dir=""
memory_output=""
if [[ -z "${TEST_RUNNER_IMAGE:-}" ]]; then
	export TEST_RUNNER_IMAGE="clawdi-test-runner:${compose_project_name}"
	remove_test_runner_image=true
fi

usage() {
	echo "Usage: scripts/test.sh [all|ci|js|mobile|cli|cli-lint|cli-native|preinstallation-artifact|desktop|shared|sidecar|web|backend|backend-lint|runtime-vaults|runtime-systemd|provider-recovery-fixture|hermes-upstream-contract|hermes-sync-memory|session-sync-memory] [suite args...]"
}

compose() {
	docker compose -p "$compose_project_name" -f "$repo_root/docker-compose.test.yml" "$@"
}

validate_suite() {
	case "$1" in
		all|backend|backend-lint|ci|js|mobile|cli|cli-lint|cli-native|preinstallation-artifact|desktop|shared|sidecar|web|runtime-vaults|runtime-systemd|provider-recovery-fixture|hermes-upstream-contract|hermes-sync-memory|session-sync-memory)
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
	if [[ "$suite" == hermes-upstream-contract ]]; then
		bash "$script_dir/test-hermes-upstream-contract.sh" "$@"
		return
	fi
	local prewarm_output=""
	if [[ "$suite" == preinstallation-artifact ]]; then
		prewarm_output="$(realpath "${1:?Provide an existing empty output directory inside this checkout}")"
		case "$prewarm_output/" in "$repo_root/"*) ;; *) echo "Artifact output must be inside this checkout" >&2; return 2;; esac
		if [[ -n "$(ls -A "$prewarm_output")" ]]; then echo "Artifact output must be empty" >&2; return 2; fi
	fi
	local provider_output=""
	if [[ "$suite" == provider-recovery-fixture ]]; then
		provider_output="$(realpath "${1:?Provide an existing output directory inside this checkout}")"
		case "$provider_output/" in "$repo_root/"*) ;; *) echo "Fixture output must be inside this checkout" >&2; return 2;; esac
		local baseline_revision="${2:?Provide the full pre-fix commit SHA}"
		[[ "$baseline_revision" =~ ^[0-9a-f]{40}$ ]] || return 2
		provider_baseline_dir="$(mktemp -d "$repo_root/.provider-recovery-baseline.XXXXXX")"
	fi
	if [[ "$suite" == hermes-sync-memory || "$suite" == session-sync-memory ]]; then
		memory_output="$(realpath "${1:?Provide an existing empty output directory inside this checkout}")"
		case "$memory_output/" in "$repo_root/"*) ;; *) echo "Fixture output must be inside this checkout" >&2; return 2;; esac
		if [[ -n "$(ls -A "$memory_output")" ]]; then echo "Memory fixture output must be empty" >&2; return 2; fi
		local memory_baseline="${2:-9fb3842f53024821c53899c60b604d7dd103ecf8}"
		[[ "$memory_baseline" =~ ^[0-9a-f]{40}$ ]] || return 2
		provider_baseline_dir="$(mktemp -d "$repo_root/.session-memory-baseline.XXXXXX")"
	fi

	cleanup() {
		compose down --remove-orphans --volumes >/dev/null
		if [[ "$remove_test_runner_image" == true ]]; then
			docker image rm "$TEST_RUNNER_IMAGE" >/dev/null 2>&1 || true
		fi
		if [[ -n "$provider_baseline_dir" ]]; then rm -rf "$provider_baseline_dir"; fi
		if [[ -n "$memory_output" ]]; then
			rm -rf "$memory_output/current" "$memory_output/before" "$memory_output/home" "$memory_output/hermes" "$memory_output/opencode.db"
			rm -f "$memory_output/scenario.mjs" "$memory_output/memory-probe.mjs"
		fi
	}
	trap cleanup EXIT
	if [[ "$suite" == provider-recovery-fixture ]]; then
		git -C "$repo_root" show "$baseline_revision:packages/cli/src/runtime/connection-provider-config.ts" > "$provider_baseline_dir/connection-provider-config.ts"
	fi
	if [[ "$suite" == hermes-sync-memory || "$suite" == session-sync-memory ]]; then
		git -C "$repo_root" archive "$memory_baseline" packages/cli/src packages/cli/bin packages/cli/package.json | tar -x -C "$provider_baseline_dir"
		printf 'baseline_commit=%s\n' "$memory_baseline"
	fi

	# Match the supported Node runtime used by the daemon. Older Node 24.19
	# leaks Blob.stream() backing stores (nodejs/node#63577), obscuring CLI gains.
	local build_args=() bake_args=()
	if [[ "$suite" == hermes-sync-memory || "$suite" == session-sync-memory ]]; then
		build_args+=(--build-arg NODE_VERSION=24.21.0)
		bake_args+=(--set test-runner.args.NODE_VERSION=24.21.0)
	fi
	if [[ "${CLAWDI_TEST_RUNNER_SKIP_BUILD:-0}" != "1" ]]; then
		if [[ "${DOCKER_BUILD_LOAD:-0}" == "1" ]]; then
			# Bake accepts the Compose graph and explicitly exports to the daemon.
			(
				cd "$repo_root"
				docker buildx bake --file docker-compose.test.yml --load "${bake_args[@]}" test-runner
			)
		else
			compose build "${build_args[@]}" test-runner
		fi
	fi

	local run_args=(run --rm)
	if [[ "$suite" == preinstallation-artifact ]]; then run_args+=(--volume "$prewarm_output:/prewarm-artifacts"); fi
	if [[ "$suite" == provider-recovery-fixture ]]; then
		run_args+=(--volume "$provider_baseline_dir:/provider-baseline:ro" --volume "$provider_output:/provider-artifacts")
	fi
	if [[ "$suite" == hermes-sync-memory || "$suite" == session-sync-memory ]]; then
		run_args+=(--volume "$provider_baseline_dir:/memory-baseline:ro" --volume "$memory_output:/memory-artifacts")
	fi
	if ! needs_postgres "$suite"; then
		run_args+=(--no-deps)
	fi
	compose "${run_args[@]}" test-runner bash /repo/scripts/test.sh --in-container "$suite" "$@"
	if [[ "$suite" == hermes-sync-memory || "$suite" == session-sync-memory ]]; then
		local memory_args=(--rm --network none --cpus 2 --memory 4g --memory-swap 4g --pids-limit 128 --user 1000:1000 --volume "$memory_output:/memory-artifacts" --env CLAWDI_MEMORY_FIXTURE_ROOT=/memory-artifacts)
		local adapter build
		for adapter in hermes openclaw; do
			docker run "${memory_args[@]}" "$TEST_RUNNER_IMAGE" node /memory-artifacts/scenario.mjs --many-medium --idle --seed "--adapter=$adapter"
			for build in before current; do
				docker run "${memory_args[@]}" "$TEST_RUNNER_IMAGE" node /memory-artifacts/scenario.mjs --many-medium --idle "--adapter=$adapter" "--build=$build" > "$memory_output/$adapter-$build-idle.log" 2>&1
				cat "$memory_output/$adapter-$build-idle.log"
			done
			docker run "${memory_args[@]}" "$TEST_RUNNER_IMAGE" node /memory-artifacts/scenario.mjs --many-medium --seed "--adapter=$adapter"
			for build in before current; do
				docker run "${memory_args[@]}" "$TEST_RUNNER_IMAGE" node /memory-artifacts/scenario.mjs --many-medium "--adapter=$adapter" "--build=$build" > "$memory_output/$adapter-$build.log" 2>&1
				cat "$memory_output/$adapter-$build.log"
			done
			local policy
			for policy in --max-old-space-size=256 --max-semi-space-size=16; do
				local policy_name=old256
				if [[ "$policy" == --max-semi-space-size=16 ]]; then policy_name=semi16; fi
				docker run "${memory_args[@]}" --env "NODE_OPTIONS=$policy" "$TEST_RUNNER_IMAGE" node /memory-artifacts/scenario.mjs --many-medium "--adapter=$adapter" --build=current > "$memory_output/$adapter-current-$policy_name.log" 2>&1
				cat "$memory_output/$adapter-current-$policy_name.log"
			done
		done
	fi
	if [[ "$suite" == session-sync-memory ]]; then
		# Preserve the existing tighter ceiling for single large-history regressions.
		local session_memory_args=(--rm --network none --cpus 2 --memory 512m --memory-swap 512m --pids-limit 128 --user 1000:1000 --volume "$memory_output:/memory-artifacts" --env CLAWDI_MEMORY_FIXTURE_ROOT=/memory-artifacts)
		local adapter
		for adapter in hermes codex claude_code pi opencode openclaw; do
			rm -rf "$memory_output/home" "$memory_output/hermes" "$memory_output/opencode.db"
			docker run "${session_memory_args[@]}" "$TEST_RUNNER_IMAGE" node /memory-artifacts/scenario.mjs --seed "--adapter=$adapter"
			docker run "${session_memory_args[@]}" "$TEST_RUNNER_IMAGE" node /memory-artifacts/scenario.mjs "--adapter=$adapter" > "$memory_output/$adapter-large.log" 2>&1
			cat "$memory_output/$adapter-large.log"
		done
	fi
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
		--exclude 'test-results/' \
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
	bun install --frozen-lockfile --ignore-scripts --network-concurrency=16
	# The disposable container disk holds Bun's cache: the mobile dependency
	# graph exceeds the former 2 GiB tmpfs. Release the cache after installation;
	# node_modules remains available and no cache persists between runs.
	find "${BUN_INSTALL_CACHE_DIR:?}" -mindepth 1 -delete
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

mobile_tests() {
	bun run --cwd apps/mobile test:internal "$@"
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
	mobile_tests
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

run_mobile() {
	install_js
	bun run --cwd apps/mobile typecheck
	mobile_tests "$@"
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
	local test_file
	for test_file in src/runtime/vault-files.test.ts src/runtime/hosted-bundled-skill.test.ts \
		src/serve/sse-client.test.ts src/serve/vault-sync.test.ts \
		src/lib/environment-registration.test.ts tests/commands/setup.test.ts; do
		cli_tests "$test_file" </dev/null
	done
	install_backend
	backend_tests -s tests/test_runtime_vaults.py tests/test_vault_requests.py tests/test_vault.py "$@"
}

run_backend() {
	install_backend
	backend_tests "$@"
}

run_backend_lint() {
	install_backend
	(
		cd backend
		uv run ruff check .
		uv run ruff format --check "${@:-.}"
		uv run --extra mem0 python scripts/type_governance.py owned
	)
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
	mobile_tests
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
		mobile)
			run_mobile "$@"
			;;
		cli)
			run_cli "$@"
			;;
		cli-lint)
			install_js
			BIOME_THREADS=2 bunx --no-install biome check "${@:-packages/cli/src}"
			;;
		preinstallation-artifact)
			install_js
			# The same minified build as the published package.
			bun run --cwd packages/cli build
			(cd packages/cli && bun pm pack --destination /prewarm-artifacts)
			;;
		cli-native)
			install_js
			cli_typecheck
			bun run --cwd packages/cli build:native
			CLAWDI_NATIVE_BINARY="$work_dir/packages/cli/dist-native/linux-x64/clawdi" cli_tests tests/e2e/native-installer.e2e.test.ts tests/e2e/native-daemon.e2e.test.ts
			;;
		hermes-sync-memory|session-sync-memory)
			install_js
			cli_typecheck
			bun build packages/cli/tests/fixtures/hermes-sync-memory/scenario.ts --target=node --outfile=/memory-artifacts/scenario.mjs
			cp packages/cli/tests/fixtures/hermes-sync-memory/memory-probe.mjs /memory-artifacts/
			bun run --cwd packages/cli build
			mkdir -p /memory-artifacts/current
			cp -R packages/cli/dist packages/cli/bin packages/cli/package.json /memory-artifacts/current/
			# Replace the complete CLI source snapshot in the disposable runner,
			# including upload/engine changes, rather than only the Hermes adapter.
			rm -rf packages/cli/src
			cp -R /memory-baseline/packages/cli/src packages/cli/src
			cp /memory-baseline/packages/cli/package.json packages/cli/package.json
			bun run --cwd packages/cli build
			mkdir -p /memory-artifacts/before
			cp -R packages/cli/dist /memory-baseline/packages/cli/bin packages/cli/package.json /memory-artifacts/before/
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
		backend-lint)
			run_backend_lint "$@"
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
