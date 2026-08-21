import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

interface WorkflowStep {
	uses?: string;
	with?: Record<string, unknown>;
}

interface WorkflowDocument {
	permissions?: Record<string, string>;
	jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

const repoRoot = resolve(import.meta.dir, "../../..");
const repoPath = (path: string): string => resolve(repoRoot, path);
const readRepoFile = (path: string): string => readFileSync(repoPath(path), "utf8");
const readPackageScripts = (path: string): Record<string, string> =>
	JSON.parse(readRepoFile(path)).scripts;

const clientWorkflow = readRepoFile(".github/workflows/client-ci.yml");
const clientWorkflowDocument = parse(clientWorkflow) as WorkflowDocument;
const cleanRunnerWorkflow = readRepoFile(".github/workflows/clean-test-runner-ci.yml");
const setupBunAction = readRepoFile(".github/actions/setup-bun-ci/action.yml");
const runner = readRepoFile("scripts/test.sh");
const runnerDockerfile = readRepoFile("docker/test-runner.Dockerfile");
const compose = readRepoFile("docker-compose.test.yml");
const backendProject = readRepoFile("backend/pyproject.toml");
const turboConfig = readRepoFile("turbo.json");
const rootScripts = readPackageScripts("package.json");
const webScripts = readPackageScripts("apps/web/package.json");
const cliScripts = readPackageScripts("packages/cli/package.json");
const sharedScripts = readPackageScripts("packages/shared/package.json");
const sidecarScripts = readPackageScripts("packages/whatsapp-baileys-sidecar/package.json");

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
	test("uses truthful change routing and verifies every client package in one job", () => {
		const changesJob = section(clientWorkflow, "  changes:\n", "  # Lint");
		const verifyJob = section(clientWorkflow, "  verify:\n", "  deploy-contract-drift:\n");
		const webE2eFilter = section(
			changesJob,
			"            web_e2e:\n",
			"            deploy_contract:\n",
		);
		const webE2eJob = section(clientWorkflow, "  web-e2e:\n", "  whatsapp-native-e2e:\n");

		expect(changesJob).toContain(`client: \${{ steps.filter.outputs.client }}`);
		expect(changesJob).toContain(`web_e2e: \${{ steps.filter.outputs.web_e2e }}`);
		expect(changesJob).toContain(`deploy_contract: \${{ steps.filter.outputs.deploy_contract }}`);
		for (const path of [
			"apps/web/**",
			"packages/shared/**",
			"packages/cli/**",
			"packages/whatsapp-baileys-sidecar/**",
		]) {
			expect(changesJob).toContain(`- "${path}"`);
		}
		for (const staleOutput of ["web", "cli", "shared", "sidecar", "infra"]) {
			expect(changesJob).not.toContain(
				`${staleOutput}: \${{ steps.filter.outputs.${staleOutput} }}`,
			);
		}
		expect(verifyJob).toContain("needs.changes.outputs.client == 'true'");
		expect(webE2eJob).toContain("needs.changes.outputs.web_e2e == 'true'");
		for (const path of ["apps/web/**", "packages/shared/**", "package.json", "bun.lock"]) {
			expect(webE2eFilter).toContain(`- "${path}"`);
		}
		for (const path of ["packages/cli/**", "packages/whatsapp-baileys-sidecar/**"]) {
			expect(webE2eFilter).not.toContain(`- "${path}"`);
		}
		expect(verifyJob).not.toContain("matrix:");
		expect(clientWorkflow).not.toContain("actions/upload-artifact");
		expect(clientWorkflow).not.toContain("actions/download-artifact");
		expect(clientWorkflow).toContain(
			`cancel-in-progress: \${{ github.event_name == 'pull_request' }}`,
		);
		const changeSteps = clientWorkflowDocument.jobs?.changes?.steps ?? [];
		expect(clientWorkflowDocument.permissions).toEqual({ contents: "read" });
		expect(changeSteps.find((step) => step.uses === "actions/checkout@v7")?.with).toEqual({
			"fetch-depth": 1,
		});
		expect(changeSteps.find((step) => step.uses === "dorny/paths-filter@v4")?.with).toMatchObject({
			token: "",
			base: `\${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.before }}`,
			ref: `\${{ github.event_name == 'push' && github.sha || '' }}`,
		});

		const typecheckTask = section(turboConfig, '\t\t"typecheck": {\n', '\t\t"lint": {\n');
		expect(typecheckTask).toContain('"outputs": []');
		for (const command of [
			"bun run check",
			"bunx turbo typecheck build",
			"bun run --cwd packages/cli test:native-linux-lifecycle:internal",
			"bun run --cwd packages/cli check:publish-manifest",
			"bun run --cwd apps/web test:internal",
			"bun run --cwd packages/shared test:internal",
			"bun run --cwd packages/whatsapp-baileys-sidecar test:internal",
			"bun run --cwd packages/cli test:internal",
		]) {
			expect(verifyJob).toContain(command);
		}
		for (const filter of [
			"--filter=web",
			"--filter=clawdi",
			"--filter=@clawdi/shared",
			"--filter=@clawdi/whatsapp-baileys-sidecar",
		]) {
			expect(verifyJob).toContain(filter);
		}
	});

	test("does not cache the Bun install directory", () => {
		expect(setupBunAction).not.toContain("actions/cache");
		expect(setupBunAction).toContain("bun install --frozen-lockfile");
	});
});

describe("clean runner suite contract", () => {
	test("uses one self-reentrant runner for every public suite", () => {
		expect(existsSync(repoPath("docker/test-runner.sh"))).toBe(false);
		expect(runner).toContain(`if [[ "\${1:-}" == "--in-container" ]]`);
		expect(runner).toContain('test-runner bash /repo/scripts/test.sh --in-container "$suite" "$@"');
		expect(runner).toContain("all|backend|ci|js|cli|shared|sidecar|web)");
		expect(runnerDockerfile).not.toContain("docker/test-runner.sh");
		expect(runnerDockerfile).not.toContain("ENTRYPOINT");

		const postgresSelection = section(runner, "needs_postgres() {\n", "run_on_host() {\n");
		expect(postgresSelection).toContain("all|backend|ci)");
		expect(runner).toContain('if ! needs_postgres "$suite"; then');
		expect(runner).toContain("run_args+=(--no-deps)");
	});

	test("separates safe public entrypoints from internal and local suites", () => {
		expect(rootScripts.test).toBe("scripts/test.sh");
		expect(rootScripts["test:local"]).toBe("turbo test:internal");
		expect(turboConfig).toContain('"test:internal": {');
		expect(turboConfig).not.toContain('"test": {');

		expect(webScripts).toMatchObject({
			test: "../../scripts/test.sh web",
			"test:internal": "bun test",
		});
		expect(cliScripts).toMatchObject({
			test: "../../scripts/test.sh cli",
			"test:internal": "bun test --isolate --max-concurrency=1 --timeout=30000",
			"test:e2e": "../../scripts/test.sh cli tests/e2e",
			"test:watch:local": "bun test --watch",
		});
		expect(sharedScripts).toMatchObject({
			test: "../../scripts/test.sh shared",
			"test:internal": "bun test src",
		});
		expect(sidecarScripts).toMatchObject({
			test: "../../scripts/test.sh sidecar",
			"test:internal": "vitest run",
		});
		expect(cliScripts["test:native-linux-lifecycle:internal"]).toContain(
			"native-installer.e2e.test.ts",
		);
		expect(cliScripts["test:native-linux-lifecycle"]).toBeUndefined();
		expect(cliScripts["test:watch"]).toBeUndefined();
		expect(backendProject).toContain('test = { shell = "../scripts/test.sh backend" }');
	});

	test("preserves suite behavior and container isolation invariants", () => {
		for (const command of [
			"bun run typecheck",
			'bun run --cwd apps/web test:internal "$@"',
			"bun run --cwd apps/web build:oss",
			'bun run --cwd packages/cli test:internal "$@"',
			"bun run --cwd packages/shared test:internal",
			"bun run --cwd packages/whatsapp-baileys-sidecar test:internal",
			"uv run alembic upgrade head",
			'uv run pytest -q "$@"',
			"web_tests src/hosted/oss-clean.test.ts",
			"cli_tests tests/smoke.test.ts",
			"backend_tests tests/test_smoke.py",
		]) {
			expect(runner).toContain(command);
		}
		expect(runner).toContain('run_backend "$@"');
		expect(runner).toContain('run_cli "$@"');
		expect(runner).toContain('run_web "$@"');
		for (const suite of ["ci", "js", "shared", "sidecar"]) {
			expect(runner).toContain(`Suite '${suite}' does not accept extra arguments`);
		}
		expect(runner).toContain(`source_dir="\${CLAWDI_REPO_SOURCE:-/repo}"`);
		expect(runner).toContain(`work_dir="\${CLAWDI_TEST_WORKDIR:-/work/clawdi}"`);
		expect(runner).toContain("rsync -a --delete");
		expect(compose).toContain("- .:/repo:ro");
		expect(compose).toContain("HOME: /tmp/clawdi-home");
		expect(runnerDockerfile).toContain("PDM_IGNORE_SAVED_PYTHON=1");
		for (const publicInvocation of [
			'bun run --cwd apps/web test "$@"',
			'bun run --cwd packages/cli test "$@"',
			"bun run --cwd packages/shared test\n",
			"bun run --cwd packages/whatsapp-baileys-sidecar test\n",
		]) {
			expect(runner).not.toContain(publicInvocation);
		}
	});

	test("runs focused CI routinely and exposes full all as a manual gate", () => {
		expect(cleanRunnerWorkflow).toContain(
			`cancel-in-progress: \${{ github.event_name == 'pull_request' }}`,
		);
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
	});
});

describe("clean runner workflow inputs", () => {
	test("tracks harness inputs without broad product test triggers", () => {
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
		expect(compose).toContain('user: "1000:1000"');
		expect(runnerDockerfile).toContain("groupadd --gid 1000 clawdi-test");
		expect(runnerDockerfile).toContain("useradd --uid 1000 --gid 1000");
	});
});
