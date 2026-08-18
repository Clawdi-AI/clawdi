import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

interface WorkflowDocument {
	env?: Record<string, unknown>;
	jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

interface WorkflowStep {
	name?: string;
	uses?: string;
	with?: Record<string, unknown>;
}

const workflowsDirectory = resolve(import.meta.dir, "../../../.github/workflows");
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
		const buildWorkflows = readdirSync(workflowsDirectory)
			.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
			.map((name) => ({
				name,
				workflow: parse(
					readFileSync(resolve(workflowsDirectory, name), "utf8"),
				) as WorkflowDocument,
			}))
			.filter(({ workflow }) =>
				Object.values(workflow.jobs ?? {}).some((job) => job.steps?.some(isDockerBuildAction)),
			);

		expect(buildWorkflows.length).toBeGreaterThan(0);
		for (const { name, workflow } of buildWorkflows) {
			expect(workflow.env?.DOCKER_BUILD_RECORD_UPLOAD, name).toBe("false");
		}
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
