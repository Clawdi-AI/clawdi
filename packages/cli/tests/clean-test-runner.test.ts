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

const compositionFunctions = new Set([
	"install_js",
	"install_backend",
	"workspace_typecheck",
	"web_typecheck",
	"web_tests",
	"web_build",
	"cli_typecheck",
	"cli_tests",
	"shared_tests",
	"sidecar_tests",
	"runner_contract_tests",
	"backend_tests",
]);

function calledCompositionFunctions(shellFunction: string): string[] {
	return shellFunction
		.split("\n")
		.map((line) => line.trim().split(/[ (]/, 1)[0])
		.filter((name) => compositionFunctions.has(name));
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

	test("composes public and focused suites from single command primitives", () => {
		const primitives = [
			{
				name: "workspace_typecheck",
				next: "web_typecheck",
				commands: ["bun run typecheck"],
			},
			{
				name: "web_typecheck",
				next: "web_tests",
				commands: ["bun run --cwd apps/web typecheck"],
			},
			{
				name: "web_tests",
				next: "web_build",
				commands: ['bun run --cwd apps/web test "$@"'],
			},
			{
				name: "web_build",
				next: "cli_typecheck",
				commands: ["bun run --cwd apps/web build:oss"],
			},
			{
				name: "cli_typecheck",
				next: "cli_tests",
				commands: ["bun run --cwd packages/cli typecheck"],
			},
			{
				name: "cli_tests",
				next: "shared_tests",
				commands: ['bun run --cwd packages/cli test "$@"'],
			},
			{
				name: "shared_tests",
				next: "sidecar_tests",
				commands: ["bun test packages/shared/src"],
			},
			{
				name: "sidecar_tests",
				next: "runner_contract_tests",
				commands: ["bun run --cwd packages/whatsapp-baileys-sidecar test"],
			},
			{
				name: "runner_contract_tests",
				next: "backend_tests",
				commands: ["bun test packages/cli/tests/clean-test-runner.test.ts"],
			},
			{
				name: "backend_tests",
				next: "run_js",
				commands: ["uv run alembic upgrade head", 'uv run pytest -q "$@"'],
			},
		];

		for (const primitive of primitives) {
			const body = section(innerRunner, `${primitive.name}() {\n`, `${primitive.next}() {\n`);
			for (const command of primitive.commands) {
				expect(body).toContain(command);
				expect(occurrences(innerRunner, command)).toBe(1);
			}
		}

		const wrappers = [
			{
				body: section(innerRunner, "run_js() {\n", "run_cli() {\n"),
				calls: [
					"install_js",
					"workspace_typecheck",
					"web_tests",
					"shared_tests",
					"sidecar_tests",
					"cli_tests",
				],
			},
			{
				body: section(innerRunner, "run_cli() {\n", "run_web() {\n"),
				calls: ["install_js", "cli_typecheck", "cli_tests"],
			},
			{
				body: section(innerRunner, "run_web() {\n", "run_backend() {\n"),
				calls: ["install_js", "web_typecheck", "web_tests", "web_build"],
			},
			{
				body: section(innerRunner, "run_backend() {\n", "run_ci() {\n"),
				calls: ["install_backend", "backend_tests"],
			},
			{
				body: section(innerRunner, "run_ci() {\n", "copy_repo\n"),
				calls: [
					"install_js",
					"workspace_typecheck",
					"runner_contract_tests",
					"web_tests",
					"web_build",
					"shared_tests",
					"sidecar_tests",
					"cli_tests",
					"install_backend",
					"backend_tests",
				],
			},
		];

		for (const wrapper of wrappers) {
			expect(calledCompositionFunctions(wrapper.body)).toEqual(wrapper.calls);
			expect(wrapper.body).not.toMatch(/^\s*(?:bun|uv)\b/m);
		}

		for (const [primitive, useCount] of [
			["workspace_typecheck", 3],
			["web_tests", 4],
			["web_build", 3],
			["cli_tests", 4],
			["shared_tests", 3],
			["sidecar_tests", 3],
			["backend_tests", 3],
		] as const) {
			expect(occurrences(innerRunner, primitive)).toBe(useCount);
		}
	});

	test("runs focused CI routinely and exposes full all as a manual gate", () => {
		expect(cleanRunnerWorkflow).toContain('description: "Clean runner suite to execute"');
		expect(cleanRunnerWorkflow).toContain("default: ci");
		expect(cleanRunnerWorkflow).toContain("          - ci\n          - all");

		const focusedStep = section(
			cleanRunnerWorkflow,
			"      - name: Clean runner CI profile\n",
			"      - name: Full clean runner suite\n",
		);
		const fullStep = cleanRunnerWorkflow.slice(
			cleanRunnerWorkflow.indexOf("      - name: Full clean runner suite\n"),
		);
		expect(focusedStep).toContain(
			"if: github.event_name != 'workflow_dispatch' || inputs.suite == 'ci'",
		);
		expect(focusedStep).toContain("run: scripts/test.sh ci");
		expect(fullStep).toContain(
			"if: github.event_name == 'workflow_dispatch' && inputs.suite == 'all'",
		);
		expect(fullStep).toContain("run: scripts/test.sh all");
		expect(occurrences(cleanRunnerWorkflow, "run: scripts/test.sh")).toBe(2);
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
