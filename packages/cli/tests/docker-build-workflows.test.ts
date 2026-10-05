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

	test("passes the shared mirror configuration to every Buildx builder before builds", () => {
		for (const { name, workflow } of workflows) {
			for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
				const steps = job.steps ?? [];
				for (const [index, step] of steps.entries()) {
					if (!step.uses?.startsWith("docker/setup-buildx-action@")) continue;
					const mirror = steps.findIndex(
						(candidate) => candidate.uses === "./.github/actions/setup-docker-hub-mirror",
					);
					const context = `${name}:${jobName}`;
					expect(mirror, context).toBeGreaterThanOrEqual(0);
					expect(mirror, context).toBeLessThan(index);
					expect(step.with?.["buildkitd-config-inline"], context).toBe(
						`\${{ steps.${steps[mirror]?.id}.outputs.buildkitd-config-inline }}`,
					);
					const build = steps.findIndex(isDockerBuildAction);
					if (build >= 0) expect(index, context).toBeLessThan(build);
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
	])("configures the daemon before container scripts in %s:%s", (name, jobName, containerStep) => {
		const workflow = workflows.find((entry) => entry.name === name)?.workflow;
		const steps = workflow?.jobs?.[jobName]?.steps ?? [];
		const mirror = steps.findIndex(
			(step) => step.uses === "./.github/actions/setup-docker-hub-mirror",
		);
		expect(mirror).toBeGreaterThanOrEqual(0);
		expect(mirror).toBeLessThan(steps.findIndex((step) => step.name === containerStep));
	});

	test("builds and loads the production sidecar through cached Buildx", () => {
		const steps = backendWorkflow.jobs?.sidecar?.steps ?? [];
		const buildStep = steps.find((step) => step.name === "Build production sidecar image");

		expect(steps.some((step) => step.uses === "docker/setup-buildx-action@v4")).toBe(true);
		expect(buildStep?.uses).toBe("docker/build-push-action@v7");
		expect(buildStep?.with).toEqual({
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
