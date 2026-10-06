import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

interface WorkflowDocument {
	env?: Record<string, unknown>;
	jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

interface WorkflowStep {
	id?: string;
	name?: string;
	uses?: string;
	with?: Record<string, unknown>;
	env?: Record<string, unknown>;
	run?: string;
}

const workflowsDirectory = resolve(import.meta.dir, "../../../.github/workflows");
const workflows = readdirSync(workflowsDirectory)
	.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
	.map((name) => ({
		name,
		workflow: parse(readFileSync(resolve(workflowsDirectory, name), "utf8")) as WorkflowDocument,
	}));
const clientWorkflow = parse(
	readFileSync(resolve(workflowsDirectory, "client-ci.yml"), "utf8"),
) as WorkflowDocument;
const backendWorkflow = parse(
	readFileSync(resolve(workflowsDirectory, "backend-ci.yml"), "utf8"),
) as WorkflowDocument;
const nativeE2eBake = readFileSync(
	resolve(import.meta.dir, "fixtures/managed-whatsapp-native-e2e/docker-bake.hcl"),
	"utf8",
);
const nativeE2eScript = readFileSync(
	resolve(import.meta.dir, "../../../scripts/test-managed-whatsapp-native-e2e.sh"),
	"utf8",
);
const mirrorAction = parse(
	readFileSync(
		resolve(import.meta.dir, "../../../.github/actions/setup-docker-hub-mirror/action.yml"),
		"utf8",
	),
) as { runs: { steps: WorkflowStep[] } };

function isDockerBuildAction(step: WorkflowStep): boolean {
	return (
		step.uses?.startsWith("docker/build-push-action@") === true ||
		step.uses?.startsWith("docker/bake-action@") === true
	);
}

describe("Docker build workflow contract", () => {
	test("disables build record artifact uploads for every Docker build action", () => {
		const buildWorkflows = workflows.filter(({ workflow }) =>
			Object.values(workflow.jobs ?? {}).some((job) => job.steps?.some(isDockerBuildAction)),
		);

		expect(buildWorkflows.length).toBeGreaterThan(0);
		for (const { name, workflow } of buildWorkflows) {
			expect(workflow.env?.DOCKER_BUILD_RECORD_UPLOAD, name).toBe("false");
		}
	});

	test("creates one pinned mirrored builder and selects it for plain Docker builds", () => {
		const steps = mirrorAction.runs.steps;
		const builders = steps.filter((step) => step.uses?.startsWith("docker/setup-buildx-action@"));
		expect(builders).toHaveLength(1);
		expect(builders[0]?.uses).toMatch(/^docker\/setup-buildx-action@[a-f0-9]{40}$/);
		expect(builders[0]?.with?.use).toBe(true);
		expect(builders[0]?.with?.["buildkitd-config-inline"]).toMatch(
			/\[registry\."docker\.io"\]\s+mirrors\s*=\s*\["mirror\.gcr\.io"\]/,
		);
		const selection = steps.find((step) => step.run?.includes("BUILDX_BUILDER="));
		expect(selection?.env?.MIRROR_BUILDER).toBe(`\${{ steps.${builders[0]?.id}.outputs.name }}`);
		expect(selection?.run).toContain("DOCKER_BUILD_LOAD=1");
	});

	test("initializes the shared builder before every Docker build action without replacing it", () => {
		for (const { name, workflow } of workflows) {
			for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
				const steps = job.steps ?? [];
				const context = `${name}:${jobName}`;
				expect(
					steps.some((step) => step.uses?.startsWith("docker/setup-buildx-action@")),
					context,
				).toBe(false);
				for (const [index, step] of steps.entries()) {
					if (!isDockerBuildAction(step)) continue;
					const mirror = steps.findIndex(
						(candidate) => candidate.uses === "./.github/actions/setup-docker-hub-mirror",
					);
					expect(mirror, context).toBeGreaterThanOrEqual(0);
					expect(mirror, context).toBeLessThan(index);
				}
			}
		}
	});

	test.each([
		["backend-ci.yml", "sidecar", "Kamal 2.12 render contract"],
		["clean-test-runner-ci.yml", "docker-runner", "Clean runner CI profile"],
		["client-ci.yml", "whatsapp-native-e2e", "Test stock OpenClaw and Hermes WhatsApp plugins"],
		["cli-systemd-e2e.yml", "privileged-systemd-e2e", "Test systemd command failure boundaries"],
		[
			"hermes-upstream-contract.yml",
			"contract",
			"Run adapter contract against the latest official Hermes install",
		],
	])(
		"configures the mirrored builder before container scripts in %s:%s",
		(name, jobName, containerStep) => {
			const workflow = workflows.find((entry) => entry.name === name)?.workflow;
			const steps = workflow?.jobs?.[jobName]?.steps ?? [];
			const mirror = steps.findIndex(
				(step) => step.uses === "./.github/actions/setup-docker-hub-mirror",
			);
			expect(mirror).toBeGreaterThanOrEqual(0);
			expect(mirror).toBeLessThan(steps.findIndex((step) => step.name === containerStep));
		},
	);

	test("prefetches the BuildKit runtime before bootstrapping builders", () => {
		const prefetch = mirrorAction.runs.steps.findIndex((step) => step.id === "prefetch");
		const builder = mirrorAction.runs.steps.findIndex((step) =>
			step.uses?.startsWith("docker/setup-buildx-action@"),
		);
		expect(prefetch).toBeGreaterThanOrEqual(0);
		expect(prefetch).toBeLessThan(builder);
		for (const { workflow } of workflows) {
			for (const job of Object.values(workflow.jobs ?? {})) {
				for (const step of job.steps ?? []) {
					if (step.uses !== "./.github/actions/setup-docker-hub-mirror") continue;
					expect(String(step.with?.["prefetch-images"]).split(/\s+/)).toContain(
						"moby/buildkit:buildx-stable-1",
					);
				}
			}
		}
	});

	test("loads script-built runtime images only when CI requests it", () => {
		for (const script of [
			"test-systemd-command.sh",
			"test-runtime-official-installer-systemd.sh",
			"test-hermes-upstream-contract.sh",
		]) {
			const source = readFileSync(resolve(import.meta.dir, "../../../scripts", script), "utf8");
			expect(source, script).toMatch(/if \[\[ "\$\{DOCKER_BUILD_LOAD:-0\}" == "1" \]\]/);
			expect(source, script).toContain("load_args+=(--load)");
			expect(source, script).toMatch(/docker build[^\n]*"\$\{load_args\[@\]\}"/);
			expect(source.indexOf("docker build"), script).toBeLessThan(source.indexOf("docker run --"));
		}
		const runner = readFileSync(resolve(import.meta.dir, "../../../scripts/test.sh"), "utf8");
		expect(runner).toMatch(
			/if \[\[ "\$\{DOCKER_BUILD_LOAD:-0\}" == "1" \]\]; then[\s\S]*?docker buildx bake[^\n]*--load test-runner[\s\S]*?else\s+compose build test-runner/,
		);
	});

	test("builds and loads the production sidecar through cached Buildx", () => {
		const steps = backendWorkflow.jobs?.sidecar?.steps ?? [];
		const buildStep = steps.find((step) => step.name === "Build production sidecar image");

		expect(buildStep?.uses).toBe("docker/build-push-action@v7");
		expect(buildStep?.with).toMatchObject({
			context: ".",
			file: "packages/whatsapp-baileys-sidecar/Dockerfile",
			tags: "clawdi-whatsapp-baileys-sidecar:ci",
			load: true,
			"cache-from": "type=gha,scope=clawdi-whatsapp-sidecar-ci",
			"cache-to": "type=gha,mode=max,scope=clawdi-whatsapp-sidecar-ci",
		});
	});

	test("builds both native WhatsApp E2E targets in one loaded Bake graph", () => {
		const steps = clientWorkflow.jobs?.["whatsapp-native-e2e"]?.steps ?? [];
		const bakeSteps = steps.filter((step) => step.uses?.startsWith("docker/bake-action@"));

		expect(bakeSteps).toHaveLength(1);
		expect(bakeSteps[0]?.with).toMatchObject({
			source: ".",
			files: "packages/cli/tests/fixtures/managed-whatsapp-native-e2e/docker-bake.hcl",
			load: true,
			targets: "openclaw,hermes",
		});
		const settings = String(bakeSteps[0]?.with?.set);
		for (const runtime of ["openclaw", "hermes"]) {
			expect(settings).toContain(
				`${runtime}.cache-from=type=gha,scope=managed-whatsapp-native-e2e-${runtime}`,
			);
			expect(settings).toContain(
				`${runtime}.cache-to=type=gha,mode=max,scope=managed-whatsapp-native-e2e-${runtime}`,
			);
			expect(nativeE2eBake).toContain(`target "${runtime}" {`);
			expect(nativeE2eBake).toContain(`tags     = ["\${E2E_IMAGE_PREFIX}:${runtime}-local"]`);
		}
		expect(nativeE2eBake).toContain('group "default" {\n  targets = ["openclaw", "hermes"]');
		expect(nativeE2eBake).toContain('target "_common" {');
		expect(nativeE2eScript).toContain(
			`docker buildx bake --file "\${FIXTURE_ROOT}/docker-bake.hcl" --load`,
		);
		expect(nativeE2eScript).not.toContain("docker buildx build");
	});
});
