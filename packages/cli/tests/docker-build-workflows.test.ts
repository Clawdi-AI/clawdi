import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

interface WorkflowDocument {
	env?: Record<string, unknown>;
	jobs?: Record<string, { steps?: Array<{ uses?: string }> }>;
}

const workflowsDirectory = resolve(import.meta.dir, "../../../.github/workflows");

describe("Docker build workflow contract", () => {
	test("disables build record artifact uploads for every build-push action", () => {
		const buildWorkflows = readdirSync(workflowsDirectory)
			.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
			.map((name) => ({
				name,
				workflow: parse(
					readFileSync(resolve(workflowsDirectory, name), "utf8"),
				) as WorkflowDocument,
			}))
			.filter(({ workflow }) =>
				Object.values(workflow.jobs ?? {}).some((job) =>
					job.steps?.some((step) => step.uses?.startsWith("docker/build-push-action@")),
				),
			);

		expect(buildWorkflows.length).toBeGreaterThan(0);
		for (const { name, workflow } of buildWorkflows) {
			expect(workflow.env?.DOCKER_BUILD_RECORD_UPLOAD, name).toBe("false");
		}
	});
});
