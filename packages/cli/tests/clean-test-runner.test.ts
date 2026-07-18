import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const readRepoFile = (path: string): string => readFileSync(resolve(repoRoot, path), "utf8");
const clientWorkflow = readRepoFile(".github/workflows/client-ci.yml");
const cleanRunnerWorkflow = readRepoFile(".github/workflows/clean-test-runner-ci.yml");
const outerRunner = readRepoFile("scripts/test.sh");
const innerRunner = readRepoFile("docker/test-runner.sh");
const compose = readRepoFile("docker-compose.test.yml");
const turboConfig = readRepoFile("turbo.json");

function section(source: string, start: string, end: string): string {
	const startIndex = source.indexOf(start);
	if (startIndex === -1) throw new Error(`Missing section start: ${start}`);
	const endIndex = source.indexOf(end, startIndex + start.length);
	if (endIndex === -1) throw new Error(`Missing section end: ${end}`);
	return source.slice(startIndex, endIndex);
}

function occurrences(source: string, value: string): number {
	return source.split(value).length - 1;
}

describe("client workflow contract", () => {
	test("keeps build and typecheck as independent required gates", () => {
		const typecheckJob = section(clientWorkflow, "  typecheck:\n", "  cli-test:\n");
		const buildJob = section(clientWorkflow, "  build:\n", "  deploy-contract-drift:\n");

		expect(typecheckJob).toContain("needs: changes");
		expect(buildJob).toContain("needs: changes");
		expect(buildJob).not.toMatch(/needs:.*typecheck/);
		for (const job of [typecheckJob, buildJob]) {
			expect(job).toContain("uses: actions/checkout@v6");
			expect(job).not.toContain("actions/upload-artifact");
			expect(job).not.toContain("actions/download-artifact");
		}
		const typecheckTask = section(turboConfig, '\t\t"typecheck": {\n', '\t\t"lint": {\n');
		expect(typecheckTask).toContain('"outputs": []');

		expect(typecheckJob).toContain(`bunx turbo typecheck --filter=\${{ matrix.filter }}`);
		expect(typecheckJob).toContain("target: web");
		expect(typecheckJob).toContain("target: cli");
		expect(typecheckJob).toContain("target: shared");
		expect(buildJob).toContain("bunx turbo build --filter=web");
	});

	test("retains the existing client build and test commands", () => {
		for (const command of [
			"bun run check",
			"bun run --cwd packages/cli build",
			"bun run --cwd packages/cli build:binary",
			"packages/cli/dist-bin/clawdi --version",
			"bun run --cwd packages/cli check:publish-manifest",
			"bun test --isolate --max-concurrency=1 packages/cli",
		]) {
			expect(clientWorkflow).toContain(command);
		}
	});
});

describe("clean runner suite contract", () => {
	test("keeps every public suite entrypoint routed", () => {
		expect(outerRunner).toContain("all|backend|ci|js|cli|web)");
		expect(outerRunner).toContain("all|backend|ci)\n");
		expect(outerRunner).toContain("js|cli|web)\n");

		const dispatch = section(innerRunner, 'case "$suite" in\n', "esac\n");
		for (const suite of ["all", "js", "cli", "web", "backend", "ci"]) {
			expect(dispatch).toContain(`\t${suite})\n`);
		}
		expect(dispatch).toContain('run_js\n\t\trun_backend "$@"');
		expect(dispatch).toContain('run_ci "$@"');
	});

	test("leaves normal all and JS suites comprehensive", () => {
		const runJs = section(innerRunner, "run_js() {\n", "run_cli() {\n");
		for (const command of [
			"bun run typecheck",
			"bun run --cwd apps/web test",
			"bun test packages/shared/src",
			"bun run --cwd packages/whatsapp-baileys-sidecar test",
			"bun run --cwd packages/cli test",
		]) {
			expect(runJs).toContain(command);
		}
	});

	test("runs the focused CI profile once without duplicate product suites", () => {
		const runCi = section(innerRunner, "run_ci() {\n", "copy_repo\n");
		for (const command of [
			"bun run typecheck",
			"bun test packages/cli/tests/clean-test-runner.test.ts",
			"bun run --cwd apps/web test src/hosted/oss-clean.test.ts",
			"bun run --cwd apps/web build:oss",
			"bun test packages/shared/src",
			"bun run --cwd packages/whatsapp-baileys-sidecar test",
			"bun run --cwd packages/cli test tests/smoke.test.ts",
			"run_backend tests/test_smoke.py",
		]) {
			expect(runCi).toContain(command);
		}

		expect(cleanRunnerWorkflow).toContain("run: scripts/test.sh ci");
		expect(occurrences(cleanRunnerWorkflow, "run: scripts/test.sh")).toBe(1);
		expect(cleanRunnerWorkflow).not.toContain("scripts/test.sh all");
		expect(cleanRunnerWorkflow).not.toContain("scripts/test.sh web");
		expect(cleanRunnerWorkflow).not.toContain("scripts/test.sh cli");
	});
});

describe("clean runner workflow inputs", () => {
	test("tracks runner, dependency, configuration, and focused fixture inputs", () => {
		const requiredPaths = [
			"docker/**",
			".dockerignore",
			"docker-compose.test.yml",
			"scripts/test.sh",
			"package.json",
			"bun.lock",
			"turbo.json",
			"tsconfig.base.json",
			"apps/web/package.json",
			"apps/web/bunfig.toml",
			"apps/web/tsconfig.json",
			"apps/web/tsr.config.json",
			"apps/web/vite.config.ts",
			"apps/web/src/hosted/oss-clean.test.ts",
			"packages/cli/package.json",
			"packages/cli/tsconfig.json",
			"packages/cli/tests/clean-test-runner.test.ts",
			"packages/cli/tests/smoke.test.ts",
			"packages/shared/package.json",
			"packages/shared/tsconfig.json",
			"packages/whatsapp-baileys-sidecar/package.json",
			"packages/whatsapp-baileys-sidecar/tsconfig.json",
			"backend/alembic.ini",
			"backend/alembic/**",
			"backend/pyproject.toml",
			"backend/uv.lock",
			"backend/tests/conftest.py",
			"backend/tests/test_smoke.py",
			".github/workflows/clean-test-runner-ci.yml",
		];

		for (const path of requiredPaths) {
			expect(occurrences(cleanRunnerWorkflow, `- "${path}"`)).toBe(2);
		}
	});

	test("does not broaden triggers to ordinary product test trees", () => {
		for (const path of [
			"apps/web/**",
			"packages/cli/**",
			"packages/shared/**",
			"packages/whatsapp-baileys-sidecar/**",
			"backend/**",
			"backend/tests/**",
		]) {
			expect(cleanRunnerWorkflow).not.toContain(`- "${path}"`);
		}
	});
});

describe("clean runner resource contract", () => {
	test("keeps measured defaults configurable and disables swap", () => {
		for (const setting of [
			`cpus: \${CLAWDI_TEST_RUNNER_CPUS:-8}`,
			`pids_limit: \${CLAWDI_TEST_RUNNER_PIDS_LIMIT:-512}`,
			`cpus: \${CLAWDI_TEST_POSTGRES_CPUS:-2}`,
			`pids_limit: \${CLAWDI_TEST_POSTGRES_PIDS_LIMIT:-256}`,
		]) {
			expect(compose).toContain(setting);
		}
		expect(occurrences(compose, `\${CLAWDI_TEST_RUNNER_MEMORY_LIMIT:-4g}`)).toBe(2);
		expect(occurrences(compose, `\${CLAWDI_TEST_POSTGRES_MEMORY_LIMIT:-1g}`)).toBe(2);
		expect(occurrences(compose, "mem_swappiness: 0")).toBe(2);
		expect(cleanRunnerWorkflow).toContain(
			"run: docker compose -f docker-compose.test.yml config >/dev/null",
		);
	});
});
